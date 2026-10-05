import type { AgentEventInput, AgentProvider } from "@agentwatch/protocol";
import { makeEvent, type AdapterCapabilities, type AdapterContext } from "@agentwatch/adapter-sdk";

/**
 * Generic CLI adapter: what AgentWatch can honestly say about an agent it only wraps and observes.
 * Everything here is LOW or MEDIUM evidence by construction (see MAX_CONFIDENCE_BY_SOURCE); there is
 * no subagent, tool-call or token data to report, so none is invented.
 */
export const genericCapabilities: AdapterCapabilities = {
  provider: "generic",
  sessionLifecycle: "high", // only because the wrapper owns the process
  toolCalls: "low",
  fileReads: "none",
  fileWrites: "low",
  commands: "partial",
  subagents: "none",
  approvals: "none",
  tokenUsage: "none",
};

interface SessionRef {
  /** The wrapper's session id; also the provider session id until a provider hook says otherwise. */
  sessionId: string;
  provider?: AgentProvider;
}

const base = (ref: SessionRef) => ({
  provider: ref.provider ?? ("generic" as const),
  providerSessionId: ref.sessionId,
  wrapperSessionId: ref.sessionId,
});

export function wrapperStarted(ref: SessionRef, info: { executable: string; cwd: string; pid?: number; branch?: string; repoRoot?: string }, ctx: AdapterContext = {}): AgentEventInput {
  return makeEvent(
    { ...base(ref), kind: "session.started", source: "pty", confidence: "low", cwd: info.cwd, payload: { executable: info.executable, cwd: info.cwd, pid: info.pid, branch: info.branch, repoRoot: info.repoRoot } },
    ctx,
  );
}

export function wrapperEnded(ref: SessionRef, exitCode: number | null, reason: string, ctx: AdapterContext = {}): AgentEventInput {
  return makeEvent({ ...base(ref), kind: "session.ended", source: "pty", confidence: "low", payload: { exitCode, reason } }, ctx);
}

/** Terminal went quiet or became active again. Derived from PTY traffic only: LOW. */
export function wrapperStatus(ref: SessionRef, status: "idle" | "running", label: string, ctx: AdapterContext = {}): AgentEventInput {
  return makeEvent({ ...base(ref), kind: "status.changed", source: "pty", confidence: "low", payload: { status, label } }, ctx);
}

/** A change seen on disk. Proves the file changed; says nothing about who changed it. */
export function fileObserved(ref: SessionRef, op: "write" | "delete", path: string, ctx: AdapterContext = {}): AgentEventInput {
  return makeEvent({ ...base(ref), kind: op === "write" ? "file.write" : "file.delete", source: "filesystem", confidence: "low", payload: { path } }, ctx);
}

export function processStarted(ref: SessionRef, p: { pid: number; ppid: number; argv: string }, ctx: AdapterContext = {}): AgentEventInput {
  return makeEvent(
    { ...base(ref), kind: "command.started", source: "process", confidence: "medium", payload: { commandId: `pid-${p.pid}`, argvDisplay: p.argv, pid: p.pid, ppid: p.ppid } },
    ctx,
  );
}

/** A sampled process disappeared. The exit status is unknown to a poller, so it is not reported. */
export function processGone(ref: SessionRef, pid: number, ctx: AdapterContext = {}): AgentEventInput {
  return makeEvent({ ...base(ref), kind: "command.completed", source: "process", confidence: "medium", payload: { commandId: `pid-${pid}`, exitCode: null } }, ctx);
}

export function gitSnapshot(
  ref: SessionRef,
  s: { baseline?: boolean; dirtyAtStart?: number; changedFiles?: number; additions?: number; deletions?: number },
  ctx: AdapterContext = {},
): AgentEventInput {
  return makeEvent({ ...base(ref), kind: "git.changed", source: "git", confidence: "low", payload: { ...s } }, ctx);
}

// ---------------------------------------------------------------- pure parsers (no IO)

export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Parses `ps -Ao pid=,ppid=,command=` output. */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! });
  }
  return rows;
}

/** All descendants of `root` (not including root), by walking ppid links. */
export function descendantsOf(root: number, rows: ProcRow[]): ProcRow[] {
  const kids = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = kids.get(r.ppid) ?? [];
    list.push(r);
    kids.set(r.ppid, list);
  }
  const out: ProcRow[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const k of kids.get(cur) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push(k);
      queue.push(k.pid);
    }
  }
  return out;
}

/** `git diff --numstat` lines -> totals. Binary files show "-" and count as 0. */
export function parseNumstat(text: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    files += 1;
    if (m[1] !== "-") additions += Number(m[1]);
    if (m[2] !== "-") deletions += Number(m[2]);
  }
  return { files, additions, deletions };
}

/** Number of changed paths in `git status --porcelain` output. */
export function countPorcelain(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}
