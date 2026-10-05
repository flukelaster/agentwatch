import { spawn } from "node:child_process";
import { fstatSync, readdirSync } from "node:fs";
import { countPorcelain, parseNumstat } from "@agentwatch/adapter-generic-cli";

let reportError: (message: string) => void = () => undefined;
/** Where a failed git spawn is reported (the daemon passes its diagnostics log). */
export function onGitError(fn: (message: string) => void): void {
  reportError = fn;
}

// Many open sessions must not mean many simultaneous child processes (each one costs several file descriptors).
const MAX_GIT = 4;
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_GIT) await new Promise<void>((r) => waiting.push(r));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

/** Runs git with an argument array: paths and refs are data, never shell text. It never throws. */
function git(cwd: string, args: string[], timeoutMs = 4000): Promise<string> {
  return slot(() => runGit(cwd, args, timeoutMs));
}

// Some environments (observed: the daemon started from the packaged app) refuse one stdio layout with EBADF while
// another works. Try the layouts in turn and keep the first that starts; report what was seen if none does.
const LAYOUTS: Array<["ignore" | "pipe", "pipe", "ignore" | "pipe"]> = [["ignore", "pipe", "ignore"], ["ignore", "pipe", "pipe"], ["pipe", "pipe", "pipe"]];
let layout = 0;

function describeFds(): string {
  const types: string[] = [];
  for (const fd of [0, 1, 2]) {
    try {
      const st = fstatSync(fd);
      types.push(`${fd}:${st.isFile() ? "file" : st.isCharacterDevice() ? "chr" : st.isFIFO() ? "pipe" : st.isSocket() ? "sock" : "other"}`);
    } catch (e) {
      types.push(`${fd}:${(e as NodeJS.ErrnoException).code}`);
    }
  }
  let open = "?";
  try {
    open = String(readdirSync("/dev/fd").length);
  } catch {
    /* not available */
  }
  return `stdio ${types.join(" ")}, ${open} open fds`;
}

function startGit(cwd: string, args: string[]): ReturnType<typeof spawn> | undefined {
  let last: unknown;
  for (let i = 0; i < LAYOUTS.length; i++) {
    const idx = (layout + i) % LAYOUTS.length;
    try {
      const child = spawn("git", ["-C", cwd, ...args], { stdio: LAYOUTS[idx]! });
      if (idx !== layout) {
        reportError(`git starts with stdio layout ${idx} (layout ${layout} was refused)`);
        layout = idx;
      }
      return child;
    } catch (err) {
      last = err;
    }
  }
  const e = last as NodeJS.ErrnoException;
  reportError(`git ${args[0] ?? ""} could not start with any stdio layout: ${e.code ?? e.message}; ${describeFds()}`);
  return undefined;
}

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = startGit(cwd, args);
    if (!child) {
      resolve("");
      return;
    }
    child.stdin?.end();
    child.stderr?.resume();
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (out.length < 1_000_000) out += d;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

export async function gitRepoRoot(cwd: string): Promise<string | undefined> {
  const out = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  return out || undefined;
}

export async function gitBranch(cwd: string): Promise<string | undefined> {
  const out = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return out && out !== "HEAD" ? out : undefined;
}

export async function gitDirtyCount(cwd: string): Promise<number> {
  return countPorcelain(await git(cwd, ["status", "--porcelain"]));
}

/** Totals for tracked changes only. Metadata, never the patch itself. */
export async function gitDiffStat(cwd: string): Promise<{ files: number; additions: number; deletions: number }> {
  return parseNumstat(await git(cwd, ["diff", "--numstat", "HEAD"]));
}
