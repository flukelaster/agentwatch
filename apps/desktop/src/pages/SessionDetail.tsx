import { useEffect, useState } from "react";
import { ProviderIcon } from "../components/icons";
import type { AgentEvent, RequestView, SessionView } from "@agentwatch/protocol";
import { Conf, DiffStat, Empty, EmptyState, Panel } from "../components/ui";
import { useLive, useQuery } from "../lib/context";
import { agentLabel, clock, diffText, duration, providerLabel, sessionTitle, tokens } from "../lib/format";
import { href } from "../lib/router";
import { pendingRequests, type LiveState } from "../lib/store";
import type { CommandRowView, FileRowView } from "../lib/types";
import { PROVIDER_COLOR, STATUS_TONE } from "./Sessions";
import "../styles/sessions.css";

const NOT_CREDITED = "not credited to any agent";

const OP_LABEL: Record<string, string> = { write: "Edit", read: "Read", delete: "Delete", dirty: "Dirty" };

function statusHeadline(s: SessionView): string {
  switch (s.status) {
    case "running":
      return "Running";
    case "waiting":
      return "! Waiting for approval";
    case "idle":
      return "Idle";
    case "finished":
      return "Finished";
    case "failed":
      return s.exitCode !== undefined && s.exitCode !== null ? `✕ Failed · exit ${s.exitCode}` : "✕ Failed";
  }
}

/** Name of the agent that did something, only when the evidence is good enough to say so. */
function credit(row: { confidence: string; agentName?: string; agentId?: string }, live: LiveState): { text: string; credited: boolean } {
  if (row.confidence === "low") return { text: NOT_CREDITED, credited: false };
  const byId = row.agentId ? live.agents.get(row.agentId) : undefined;
  const name = row.agentName ?? (byId ? agentLabel(byId, row.agentId!.endsWith(":main")) : undefined);
  return name ? { text: name, credited: true } : { text: "agent not identified", credited: false };
}

function cmdTime(c: CommandRowView): string {
  if (!c.endedAt) return "—";
  const ms = Date.parse(c.endedAt) - Date.parse(c.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : duration(ms);
}

function approvalEvent(r: RequestView, events: readonly AgentEvent[]): AgentEvent | undefined {
  return [...events].reverse().find((e) => e.kind === "approval.requested" && r.providerRequestId !== undefined && e.payload.requestId === r.providerRequestId);
}

function kindLabel(kind: string): string {
  return kind === "command" ? "command execution" : kind === "file" || kind === "fileChange" ? "file change" : kind;
}

export function SessionDetail({ id }: { id: string }) {
  const live = useLive();
  const files = useQuery<FileRowView[]>("files", { sessionId: id });
  const commands = useQuery<CommandRowView[]>("commands", { sessionId: id });
  const session = live.sessions.get(id);
  const [now, setNow] = useState(() => Date.now());
  const ticking = !!session && !session.endedAt;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  if (!session) {
    if (live.status !== "connected") {
      return (
        <Panel title="Session" label="Session">
          <Empty>{live.status === "connecting" ? "Connecting to AgentWatch..." : "AgentWatch is not reachable, so this session cannot be shown."}</Empty>
        </Panel>
      );
    }
    return (
      <Panel title="Session" label="Session not found">
        <div className="callout">
          <h2>Session not found</h2>
          <p>It may have been deleted. Sessions are listed on the Sessions page while AgentWatch has them.</p>
          <a className="btn" href={href("/sessions")}>
            Back to Sessions
          </a>
        </div>
      </Panel>
    );
  }

  const repo = sessionTitle(session);
  const events = live.events.get(id) ?? [];
  const pending = pendingRequests(live).filter((r) => r.sessionId === id);
  const provider = providerLabel[session.provider] ?? session.provider;
  const elapsed = duration((session.endedAt ? Date.parse(session.endedAt) : now) - Date.parse(session.startedAt));
  const meta = [session.model, session.cwd, session.branch].filter(Boolean).join("  ·  ");
  const statusClass = STATUS_TONE[session.status] ?? "";

  const baseline = [...events].reverse().find((e) => e.kind === "git.changed" && e.payload.baseline === true);
  const dirtyAtStart = typeof baseline?.payload.dirtyAtStart === "number" ? baseline.payload.dirtyAtStart : undefined;
  const lastGit = [...events].reverse().find((e) => e.kind === "git.changed" && e.payload.baseline !== true);
  const changedFiles = typeof lastGit?.payload.changedFiles === "number" ? lastGit.payload.changedFiles : undefined;
  const diffLine = session.diff.additions || session.diff.deletions ? `${changedFiles !== undefined ? `${changedFiles} ${changedFiles === 1 ? "file" : "files"} · ` : ""}${diffText(session)}` : "none recorded";
  const root = session.repoRoot ?? session.cwd;
  const others = root ? [...live.sessions.values()].filter((o) => o.id !== id && !o.endedAt && (o.repoRoot ?? o.cwd) === root) : undefined;

  const u = session.usage && session.usage.providerReported ? session.usage : undefined;
  const total = u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0;
  const usageRows: Array<{ label: string; value: number | undefined; sub: boolean }> = u
    ? [
        { label: "input", value: u.inputTokens, sub: false },
        { label: "cached", value: u.cachedInputTokens, sub: true },
        { label: "output", value: u.outputTokens, sub: false },
        { label: "reasoning", value: u.reasoningTokens, sub: true },
      ].filter((r) => r.value !== undefined)
    : [];

  const filesRows = files.data ?? [];
  const cmdRows = commands.data ?? [];
  const filesPending = files.data === undefined;
  const cmdsPending = commands.data === undefined;

  return (
    <>
      <section className="sd-head" aria-label="Session header">
        <div className="sd-crumb">
          <a href={href("/sessions")}>Sessions</a>
          {"  /  "}
          {repo}
        </div>
        <div className="sd-top">
          <div className="sd-id">
            <div className="sd-chiprow">
              <span className="sd-chip" style={{ color: PROVIDER_COLOR[session.provider] }}>
                <ProviderIcon provider={session.provider} size={14} />
                {provider}
              </span>
              {meta && <span className="sd-meta">{meta}</span>}
            </div>
            <h1>{repo}</h1>
          </div>
          <div className="sd-stats">
            <div className="sd-stat">
              <span className="label">Status</span>
              <b className={statusClass}>{statusHeadline(session)}</b>
            </div>
            <div className="sd-stat">
              <span className="label">Elapsed</span>
              <b>{elapsed}</b>
            </div>
            <div className="sd-stat">
              <span className="label">Diff</span>
              <b><DiffStat diff={session.diff} /></b>
            </div>
          </div>
        </div>
      </section>

      {pending.map((r) => {
        const agent = r.agentId ? live.agents.get(r.agentId) : undefined;
        const asker = r.agentId ? agentLabel(agent, r.agentId.endsWith(":main")) : undefined;
        const ev = approvalEvent(r, events);
        return (
          <section key={r.id} className="sd-approval" aria-label="Approval request">
            <div className="sd-approval__main">
              <span className="ss-label tone-ask">Approval requested · {kindLabel(r.kind)}</span>
              <code className="sd-approval__cmd">{r.summary ?? "No description was provided by the agent."}</code>
              <span className="sd-approval__who">
                {asker ? `Asked by ${asker} at ` : "Asked at "}
                {clock(r.createdAt)} · waiting {duration(now - Date.parse(r.createdAt))} · answer it in the {provider} terminal
              </span>
            </div>
            <div className="sd-approval__src">
              {ev && <Conf level={ev.confidence} />}
              <span className="mono">{r.source}</span>
            </div>
          </section>
        );
      })}

      <div className="sd-grid2">
        <Panel title="File activity" right={<span className="sd-count">{filesPending ? "" : filesRows.length}</span>} foot="A Git change that was already there when the session started is listed but not credited to any agent. Observed changes are never attributed.">
          <div className="tablewrap">
            <div className="table" style={{ ["--cols" as string]: "minmax(0,1fr) 72px 84px 132px", ["--min" as string]: "560px" }}>
              <div className="tr tr--head">
                <span>Path</span>
                <span>Op</span>
                <span>+ / −</span>
                <span>Evidence</span>
              </div>
              {filesPending && <Empty>{files.error ? `Could not load file activity: ${files.error}` : "Loading..."}</Empty>}
              {!filesPending && filesRows.length === 0 && <EmptyState icon="folder-open" title="No file activity recorded" hint="This session has not read or edited a file that AgentWatch could see." compact />}
              {filesRows.map((f, i) => {
                const who = credit(f as FileRowView & { agentId?: string }, live);
                const delta = f.operation === "dirty" ? "at start" : f.additions || f.deletions ? `+${f.additions} −${f.deletions}` : "—";
                return (
                  <div key={`${f.path}:${f.operation}:${i}`} className="tr tr--tall">
                    <span className="ss-two">
                      <span className="sd-path" title={f.path}>
                        {f.path}
                      </span>
                      <span className={`sd-sub${who.credited ? "" : " sd-sub--none"}`}>{who.text}</span>
                    </span>
                    <span className="sd-op">{OP_LABEL[f.operation] ?? f.operation}</span>
                    <span className="ss-num">{delta}</span>
                    <span className="sd-ev">
                      <Conf level={f.confidence} />
                      <small>{f.operation === "dirty" && f.source === "git" ? "git baseline" : f.source}</small>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>

        <Panel title="Command activity" right={<span className="sd-count">{cmdsPending ? "" : cmdRows.length}</span>} foot="Command lines are redacted before they are stored. Environment variables are never captured.">
          <div className="tablewrap">
            <div className="table" style={{ ["--cols" as string]: "minmax(0,1fr) 128px 64px 96px 132px", ["--min" as string]: "640px" }}>
              <div className="tr tr--head">
                <span>Command</span>
                <span>Agent</span>
                <span>Time</span>
                <span>Exit</span>
                <span>Evidence</span>
              </div>
              {cmdsPending && <Empty>{commands.error ? `Could not load command activity: ${commands.error}` : "Loading..."}</Empty>}
              {!cmdsPending && cmdRows.length === 0 && <EmptyState icon="terminal" title="No commands recorded" hint="This session has not run a shell command." compact />}
              {cmdRows.map((c) => {
                const who = credit(c as CommandRowView & { agentId?: string }, live);
                const awaiting = !c.endedAt && pending.some((r) => r.summary !== undefined && r.summary === c.argvDisplay);
                let exit: string;
                let exitClass = "sd-exit";
                if (awaiting) {
                  exit = "awaiting you";
                  exitClass = "sd-exit sd-exit--ask";
                } else if (typeof c.exitCode === "number") {
                  exit = String(c.exitCode);
                  if (c.exitCode !== 0) exitClass = "sd-exit sd-exit--fail";
                } else if (c.signal) {
                  exit = c.signal;
                  exitClass = "sd-exit sd-exit--fail";
                } else {
                  exit = !c.endedAt && !session.endedAt ? "running" : "—";
                }
                return (
                  <div key={c.id} className="tr tr--tall">
                    <span className="sd-path" title={c.argvDisplay}>
                      {c.argvDisplay}
                    </span>
                    <span className={who.credited ? "ss-num" : "sd-sub sd-sub--none"} style={who.credited ? { color: "var(--g-c8)" } : undefined}>
                      {who.text}
                    </span>
                    <span className="cell-mono muted">{cmdTime(c)}</span>
                    <span className={exitClass}>{exit}</span>
                    <span className="sd-ev">
                      <Conf level={c.confidence} />
                      <small>{c.source}</small>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </Panel>
      </div>

      <div className="sd-grid3">
        <Panel title="Token usage" right={u ? <span className="sd-count">{u.scope} · provider-reported</span> : undefined}>
          {u ? (
            <div className="sd-usage">
              <div className="sd-usage__total">
                <b>{tokens(u.inputTokens === undefined && u.outputTokens === undefined ? undefined : total)}</b>
                <span>input + output</span>
              </div>
              <div className="sd-usage__rows">
                {usageRows.map((r) => (
                  <div key={r.label} className="sd-usage__row">
                    <span>{r.label}</span>
                    <span className={`sd-bar${r.sub ? " sd-bar--sub" : ""}`} aria-hidden="true">
                      <i style={{ width: `${total > 0 ? Math.min(100, ((r.value ?? 0) / total) * 100).toFixed(1) : 0}%` }} />
                    </span>
                    <span>{tokens(r.value)}</span>
                  </div>
                ))}
              </div>
              <span className="muted" style={{ font: "400 12px/1.5 var(--sans)", color: "var(--faint)" }}>
                Cached is part of input; reasoning is part of output. AgentWatch shows only what {provider} reports and never estimates tokens.
              </span>
            </div>
          ) : (
            <div className="sd-unreported">
              <b>{session.provider === "generic" ? "Unavailable for a generic CLI" : "Not reported by this provider"}</b>
              <p>
                {session.provider === "generic"
                  ? "A generic command-line agent does not expose token usage, and AgentWatch does not estimate it."
                  : `${provider} has not reported token usage for this session, and AgentWatch does not estimate it.`}
              </p>
            </div>
          )}
        </Panel>

        <Panel title="Git" label="Git" right={<span className="sd-count">metadata only</span>} foot="AgentWatch keeps change counts, never the patch itself.">
          <dl className="sd-kv">
            {dirtyAtStart !== undefined && (
              <div>
                <dt>dirty at start</dt>
                <dd>{`${dirtyAtStart} ${dirtyAtStart === 1 ? "file" : "files"}`}</dd>
              </div>
            )}
            <div>
              <dt>changed since</dt>
              <dd>{diffLine}</dd>
            </div>
            {others && (
              <div>
                <dt>other sessions here</dt>
                <dd>{others.length === 0 ? "none" : others.map((o) => `${sessionTitle(o)} (${providerLabel[o.provider] ?? o.provider})`).join(", ")}</dd>
              </div>
            )}
            <div>
              <dt>full patch</dt>
              <dd className="muted">not stored</dd>
            </div>
          </dl>
        </Panel>
      </div>
    </>
  );
}
