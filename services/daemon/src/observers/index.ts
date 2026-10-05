import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";
import {
  descendantsOf,
  fileObserved,
  gitSnapshot,
  parsePs,
  processGone,
  processStarted,
} from "@agentwatch/adapter-generic-cli";
import type { SessionView } from "@agentwatch/protocol";
import type { Diagnostics } from "../diagnostics";
import type { SessionManager } from "../session-manager";
import { gitBranch, gitDiffStat, gitDirtyCount, gitRepoRoot, onGitError } from "./git";
import { watchTree, type TreeWatcher } from "./watch";

export const IGNORED = [
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])(dist|build|\.next|\.turbo|\.cache|target|coverage|\.venv|__pycache__)([/\\]|$)/,
  /(^|[/\\])\.DS_Store$/,
  /\.(log|tmp|swp)$/,
  /(^|[/\\])\.data([/\\]|$)/,
  /AgentWatch([/\\]|$)/,
];

/** Never watch the home directory or the filesystem root, and never above a project directory. */
export function isSafeRoot(cwd: string): boolean {
  const home = homedir();
  if (!cwd || cwd === "/" || cwd === home) return false;
  return cwd.split(sep).filter(Boolean).length >= 3;
}

interface Root {
  cwd: string;
  watcher: TreeWatcher;
  sessions: Set<string>;
  gitTimer?: NodeJS.Timeout;
}

export interface ObserverOptions {
  manager: SessionManager;
  diagnostics: Diagnostics;
  psIntervalMs?: number;
  gitDebounceMs?: number;
  maxRoots?: number;
}

/**
 * Supplementary evidence, never ground truth. Watchers cover only the working directories of active
 * sessions. Observed changes are LOW confidence and unattributed; process samples are MEDIUM.
 */
export function startObservers(opts: ObserverOptions): { stop: () => Promise<void> } {
  const { manager, diagnostics } = opts;
  let gitErrors = 0;
  onGitError((m) => {
    if (gitErrors++ < 5) diagnostics.info("observer.git", m);
  });
  const roots = new Map<string, Root>();
  const maxRoots = opts.maxRoots ?? 8;
  const gitDebounceMs = opts.gitDebounceMs ?? 1200;
  const procSeen = new Map<string, Map<number, string>>(); // sessionId -> pid -> argv
  const watched = new Map<string, string>(); // sessionId -> cwd
  const wrapperPid = new Map<string, number>();

  const ref = (id: string) => {
    const s = manager.sessions.get(id);
    return { sessionId: id, provider: s?.provider };
  };

  const scheduleGit = (root: Root) => {
    if (root.gitTimer) clearTimeout(root.gitTimer);
    root.gitTimer = setTimeout(async () => {
      const stat = await gitDiffStat(root.cwd);
      for (const id of root.sessions) {
        if (manager.sessions.get(id)?.endedAt) continue;
        manager.apply(gitSnapshot(ref(id), { changedFiles: stat.files, additions: stat.additions, deletions: stat.deletions }));
      }
    }, gitDebounceMs);
    root.gitTimer.unref();
  };

  const attach = async (s: SessionView) => {
    const cwd = s.cwd;
    if (!cwd || watched.has(s.id) || s.endedAt) return;
    if (!isSafeRoot(cwd)) return;
    watched.set(s.id, cwd);
    let root = roots.get(cwd);
    if (!root) {
      if (roots.size >= maxRoots) {
        watched.delete(s.id);
        diagnostics.warn("observer.fs", `watcher limit reached; not watching ${cwd}`);
        return;
      }
      const sessionIds = new Set<string>();
      const r: Root = { cwd, watcher: { close: () => undefined }, sessions: sessionIds };
      const emit = (op: "write" | "delete", path: string) => {
        for (const id of r.sessions) {
          if (manager.sessions.get(id)?.endedAt) continue;
          manager.apply(fileObserved(ref(id), op, path));
        }
        scheduleGit(r);
      };
      r.watcher = watchTree(cwd, IGNORED, emit, (err) => diagnostics.warn("observer.fs", `watch error: ${err.message}`));
      root = r;
      roots.set(cwd, root);
      diagnostics.info("observer.fs", `watching ${cwd} (ignoring .git, node_modules, build outputs)`);
    }
    root.sessions.add(s.id);
    // baseline: what was already dirty must never be credited to the agent
    const dirty = await gitDirtyCount(cwd);
    manager.apply(gitSnapshot(ref(s.id), { baseline: true, dirtyAtStart: dirty }));
    const [repoRoot, branch] = await Promise.all([gitRepoRoot(cwd), gitBranch(cwd)]);
    const live = manager.sessions.get(s.id);
    if (live && (repoRoot || branch)) {
      if (repoRoot) live.repoRoot = repoRoot;
      if (branch) live.branch = branch;
      manager.emit("session", live);
    }
  };

  const detach = async (id: string) => {
    const cwd = watched.get(id);
    watched.delete(id);
    procSeen.delete(id);
    wrapperPid.delete(id);
    if (!cwd) return;
    const root = roots.get(cwd);
    if (!root) return;
    root.sessions.delete(id);
    if (root.sessions.size === 0) {
      if (root.gitTimer) clearTimeout(root.gitTimer);
      roots.delete(cwd);
      root.watcher.close();
    }
  };

  const onSession = (s: SessionView) => {
    if (s.endedAt) void detach(s.id);
    else void attach(s);
  };
  manager.on("session", onSession);
  for (const s of manager.sessions.values()) if (!s.endedAt && s.status !== "idle") void attach(s);

  // ---- process tree sampler (sessions that registered a wrapper pid) ----
  const sample = () =>
    new Promise<void>((resolve) => {
      if (wrapperPid.size === 0) return resolve();
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("ps", ["-Ao", "pid=,ppid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
      } catch (err) {
        diagnostics.info("observer.ps", `could not start ps: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
        return resolve();
      }
      let out = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => (out += d));
      child.on("error", () => resolve());
      child.on("close", () => {
        const rows = parsePs(out);
        for (const [id, pid] of wrapperPid) {
          const seen = procSeen.get(id) ?? new Map<number, string>();
          const live = descendantsOf(pid, rows);
          const liveIds = new Set(live.map((r) => r.pid));
          for (const r of live) {
            if (!seen.has(r.pid) && !/\bps -Ao\b/.test(r.command)) {
              seen.set(r.pid, r.command);
              manager.apply(processStarted(ref(id), { pid: r.pid, ppid: r.ppid, argv: r.command }));
            }
          }
          for (const [p] of seen) {
            if (!liveIds.has(p)) {
              seen.delete(p);
              manager.apply(processGone(ref(id), p));
            }
          }
          procSeen.set(id, seen);
        }
        resolve();
      });
    });
  // Poll quickly only while a wrapped session has been active recently; otherwise barely at all.
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const nextDelay = (): number => {
    if (opts.psIntervalMs) return opts.psIntervalMs;
    const now = Date.now();
    for (const id of wrapperPid.keys()) {
      const s = manager.sessions.get(id);
      if (s && !s.endedAt && now - Date.parse(s.lastEventAt) < 120_000) return 2000;
    }
    return 10_000;
  };
  const loop = () => {
    if (stopped) return;
    void sample().finally(() => {
      if (stopped) return;
      timer = setTimeout(loop, nextDelay());
      timer.unref();
    });
  };
  timer = setTimeout(loop, nextDelay());
  timer.unref();

  // The wrapper tells us its pid in session.started; that is what makes its children sample-able.
  const onEvent = (e: { kind: string; sessionId: string; source: string; payload: Record<string, unknown> }) => {
    if (e.kind === "session.started" && e.source === "pty" && typeof e.payload.pid === "number") {
      wrapperPid.set(e.sessionId, e.payload.pid);
    }
  };
  manager.on("event", onEvent);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      manager.off("session", onSession);
      manager.off("event", onEvent);
      for (const id of [...watched.keys()]) await detach(id);
    },
  };
}
