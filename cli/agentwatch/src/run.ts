import { randomUUID } from "node:crypto";
import { wrapperEnded, wrapperStarted, wrapperStatus } from "@agentwatch/adapter-generic-cli";
import { sanitizeInput, type AgentEventInput, type AgentProvider } from "@agentwatch/protocol";
import { socketPath } from "./home";
import { sendEvents } from "./ipc";
import { ensureSpawnHelperExecutable } from "./ptyfix";

export interface RunOptions {
  argv: string[];
  provider: AgentProvider;
  env?: NodeJS.ProcessEnv;
}

const IDLE_AFTER_MS = 20_000;

/**
 * Transparent terminal host: stdin/stdout/resize/signals pass straight through a PTY and the child's
 * exit code is preserved. Output bytes are only used to tell "active" from "quiet"; they are never
 * stored. The wrapper owns the process, which is the only reason lifecycle is HIGH-quality here.
 */
export async function runWrapped(opts: RunOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const [file, ...args] = opts.argv;
  if (!file) {
    process.stderr.write("agentwatch run: no command given. Usage: agentwatch run -- <agent> [args]\n");
    return 2;
  }

  ensureSpawnHelperExecutable();
  let pty: typeof import("node-pty");
  try {
    pty = await import("node-pty");
  } catch (err) {
    process.stderr.write(`agentwatch run: node-pty is not available (${(err as Error).message}).\n`);
    return 1;
  }

  const sessionId = randomUUID();
  const ref = { sessionId, provider: opts.provider };
  const socket = socketPath(env);
  const post = (e: AgentEventInput) => void sendEvents([sanitizeInput(e).event], { socket, timeoutMs: 400 });

  const stdout = process.stdout;
  const child = pty.spawn(file, args, {
    name: env.TERM || "xterm-256color",
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    cwd: process.cwd(),
    env: { ...(env as Record<string, string>), AGENTWATCH_SESSION_ID: sessionId },
  });
  post(wrapperStarted(ref, { executable: file, cwd: process.cwd(), pid: child.pid }));

  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  const onStdin = (d: Buffer) => child.write(d.toString("utf8"));
  stdin.on("data", onStdin);
  const onResize = () => child.resize(Math.max(stdout.columns || 80, 2), Math.max(stdout.rows || 24, 2));
  stdout.on("resize", onResize);

  let lastOutput = Date.now();
  let quiet = false;
  child.onData((d) => {
    stdout.write(d);
    lastOutput = Date.now();
    if (quiet) {
      quiet = false;
      post(wrapperStatus(ref, "running", "active"));
    }
  });
  const idleTimer = setInterval(() => {
    if (!quiet && Date.now() - lastOutput > IDLE_AFTER_MS) {
      quiet = true;
      post(wrapperStatus(ref, "idle", "no output"));
    }
  }, 2000);
  idleTimer.unref();

  const forward = (sig: NodeJS.Signals) => () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  const sigs: Array<[NodeJS.Signals, () => void]> = (["SIGTERM", "SIGHUP"] as NodeJS.Signals[]).map((s) => [s, forward(s)]);
  for (const [s, h] of sigs) process.on(s, h);

  const code = await new Promise<number>((resolve) => {
    child.onExit(({ exitCode, signal }) => resolve(signal ? 128 + signal : exitCode));
  });

  clearInterval(idleTimer);
  for (const [s, h] of sigs) process.off(s, h);
  stdin.off("data", onStdin);
  stdout.off("resize", onResize);
  if (stdin.isTTY) stdin.setRawMode(wasRaw);
  stdin.pause();

  await sendEvents([sanitizeInput(wrapperEnded(ref, code, "exited")).event], { socket, timeoutMs: 600 });
  return code;
}
