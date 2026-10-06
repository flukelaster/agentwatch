import type { AgentEvent, AgentView, Confidence, SessionView } from "@agentwatch/protocol";

export const confLabel: Record<Confidence, string> = { high: "High", medium: "Med", low: "Low" };
export const confBars: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

export function dayClock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now.getTime() - 86_400_000);
  const label = sameDay ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${label} ${clock(iso).slice(0, 5)}`;
}

/**
 * How long a session has been going. It counts only while there is something to count: running or waiting
 * sessions use the clock, an idle one stops at its last activity, and an ended one at its end.
 */
export function sessionElapsedMs(s: Pick<SessionView, "status" | "startedAt" | "endedAt" | "lastEventAt">, now: number): number {
  const start = Date.parse(s.startedAt);
  if (s.endedAt) return Date.parse(s.endedAt) - start;
  if (s.status === "idle") return Math.max(0, Date.parse(s.lastEventAt) - start);
  return now - start;
}

/** True while time is passing for this session (so a once-a-second clock is worth running). */
export const isTicking = (s: Pick<SessionView, "status" | "endedAt">): boolean => !s.endedAt && (s.status === "running" || s.status === "waiting");

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

export function sessionLength(s: SessionView, now = Date.now()): string {
  return duration((s.endedAt ? Date.parse(s.endedAt) : now) - Date.parse(s.startedAt));
}

export function repoName(s: Pick<SessionView, "cwd" | "repoRoot" | "executable" | "id">): string {
  const path = s.repoRoot ?? s.cwd;
  const last = path?.split("/").filter(Boolean).pop();
  return last ?? s.executable?.split("/").pop() ?? s.id.slice(0, 8);
}

/** A worktree or branch name is made for a file system, not for reading: "ENG-142 · checkout flow spec ..." instead. */
export function prettyName(raw: string): string {
  const m = /^([a-z]{2,8}-\d{1,6})[-_ ](.+)$/i.exec(raw);
  if (m) return `${m[1]!.toUpperCase()} · ${m[2]!.replace(/[-_]+/g, " ")}`;
  if (raw.length > 24 && /[-_]/.test(raw)) return raw.replace(/[-_]+/g, " ");
  return raw;
}

/** The name a person sees for a session. The raw directory name stays available as a tooltip. */
export const sessionTitle = (s: Pick<SessionView, "cwd" | "repoRoot" | "executable" | "id"> & { title?: string }): string => s.title || prettyName(repoName(s));

/** Hashes and UUIDs are identifiers, not names. */
export const isOpaqueId = (s: string | undefined): boolean => !!s && (/^[0-9a-f]{12,}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s));

/**
 * A subagent's name: the label of its task, else its type, else "subagent N" (N = start order among its siblings).
 * Never a hash.
 */
export function agentName(a: Pick<AgentView, "displayName" | "role" | "providerAgentId" | "id">, ordinal?: number): string {
  if (a.displayName && !isOpaqueId(a.displayName)) return a.displayName;
  if (a.role) return a.role;
  if (a.providerAgentId && !isOpaqueId(a.providerAgentId)) return a.providerAgentId;
  return ordinal ? `subagent ${ordinal}` : "subagent";
}

/** Tools whose context window AgentWatch can read: Claude Code from its conversation file, Codex from its session file. */
export const readsContext = (provider: string): boolean => provider === "claude-code" || provider === "codex";

export const providerLabel: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", "gemini-cli": "Gemini CLI", antigravity: "Antigravity CLI", cursor: "Cursor", generic: "Generic CLI" };

export function tokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 100_000_000_000 ? 0 : 1)}B`;
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : 1)}M`; // 999,999 reads 1.0M, not 1000k
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

export function usageSummary(s: SessionView, tracking?: boolean): string {
  const u = s.usage;
  if (!u || !u.providerReported) {
    if (s.provider === "generic") return "unavailable";
    return s.provider === "claude-code" && tracking === false ? "tracking off" : "not reported";
  }
  const total = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
  return `${tokens(total)} reported`;
}

/** "input 3.5M · output 1.1M · cache 289M": the numbers behind the total, for a tooltip or a second line. */
export function usageDetail(s: Pick<SessionView, "usage">): string | undefined {
  const u = s.usage;
  if (!u) return undefined;
  const parts = [u.inputTokens !== undefined && `input ${tokens(u.inputTokens)}`, u.outputTokens !== undefined && `output ${tokens(u.outputTokens)}`, u.cachedInputTokens !== undefined && u.cachedInputTokens > 0 && `cache ${tokens(u.cachedInputTokens)}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

export function diffText(s: Pick<SessionView, "diff">): string {
  return s.diff.additions || s.diff.deletions ? `+${s.diff.additions} −${s.diff.deletions}` : "—";
}

export type RowTone = "plain" | "fail" | "ask";
export interface LogRow {
  id: string;
  seq: number;
  time: string;
  agent: string;
  kind: string;
  text: string;
  tone: RowTone;
  conf: Confidence;
  source: string;
  unattributed: boolean;
}

const NOISE = new Set(["tool.started", "tool.completed", "command.output", "status.changed", "message"]); // chat text has its own panel, not a log row

export function agentLabel(a: AgentView | undefined, isMain: boolean, all?: ReadonlyMap<string, AgentView>): string {
  if (!a) return "main";
  if (isMain) return "main";
  let ordinal: number | undefined;
  if (all) {
    const sibs = [...all.values()].filter((x) => x.sessionId === a.sessionId && x.parentAgentId === a.parentAgentId).sort((x, y) => x.startedAt.localeCompare(y.startedAt));
    ordinal = sibs.findIndex((x) => x.id === a.id) + 1 || undefined;
  }
  return agentName(a, ordinal);
}

/** One readable log row per meaningful event. Returns null for events that are only noise. */
export function describeEvent(e: AgentEvent, agents: ReadonlyMap<string, AgentView>): LogRow | null {
  const p = e.payload;
  const a = agents.get(e.agentId);
  const isMain = e.agentId.endsWith(":main");
  const observed = e.confidence === "low" && (e.source === "filesystem" || e.source === "pty" || e.source === "git");
  const base = { id: e.id, seq: e.sequence, time: clock(e.occurredAt), conf: e.confidence, source: e.source, agent: observed ? "unknown" : agentLabel(a, isMain, agents), unattributed: observed };
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const num = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : undefined);
  const delta = () => (num("additions") !== undefined || num("deletions") !== undefined ? `  +${num("additions") ?? 0} −${num("deletions") ?? 0}` : "");
  const row = (kind: string, text: string, tone: RowTone = "plain"): LogRow => ({ ...base, kind, text, tone });

  switch (e.kind) {
    case "session.started":
      return row("Start", str("executable") ?? str("cwd") ?? "session started");
    case "session.ended":
      return row("End", `session ended${num("exitCode") !== undefined ? ` · exit ${num("exitCode")}` : ""}`);
    case "agent.started":
      return row("Spawn", `${str("agentType") ?? "subagent"} started`);
    case "agent.ended":
      return row("Done", `${str("agentType") ?? "subagent"} finished`);
    case "file.read":
      return row("Read", str("path") ?? "");
    case "file.write":
      return observed ? row("File", `${str("path") ?? ""} changed`) : row("Edit", `${str("path") ?? ""}${delta()}`);
    case "file.delete":
      return row("Delete", str("path") ?? "");
    case "command.started":
      return row("Run", str("argvDisplay") ?? "command");
    case "command.completed": {
      const code = num("exitCode");
      if (code === undefined) return null;
      if (code === 0 && !num("durationMs")) return null;
      return code === 0 ? row("Done", `exit 0${num("durationMs") ? ` · ${(num("durationMs")! / 1000).toFixed(1)}s` : ""}`) : row("Fail", `exit ${code}`, "fail");
    }
    case "tool.failed":
      return row("Fail", `${str("toolName") ?? "tool"}${str("error") ? ` · ${str("error")}` : ""}`, "fail");
    case "approval.requested":
      return row("Ask", str("summary") ?? "approval requested", "ask");
    case "approval.resolved":
      return row("Resolved", `approval ${str("decision") ?? "answered"}`);
    case "usage.updated":
      return row("Usage", `in ${tokens(num("inputTokens"))} · out ${tokens(num("outputTokens"))}`);
    case "git.changed":
      return p.baseline === true ? row("Git", `${num("dirtyAtStart") ?? 0} files already changed at start`) : row("Git", `${num("changedFiles") ?? 0} files · +${num("additions") ?? 0} −${num("deletions") ?? 0}`);
    case "log":
      return row("Log", str("message") ?? "");
    default:
      return NOISE.has(e.kind) ? null : row(e.kind, "");
  }
}

export function describeEvents(events: readonly AgentEvent[], agents: ReadonlyMap<string, AgentView>): LogRow[] {
  const out: LogRow[] = [];
  for (const e of events) {
    const r = describeEvent(e, agents);
    if (r) out.push(r);
  }
  return out;
}
