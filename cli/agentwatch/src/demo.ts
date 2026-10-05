import { CodexAppServerMapper } from "@agentwatch/adapter-codex";
import { mapClaudeHook } from "@agentwatch/adapter-claude-code";
import { fileObserved, gitSnapshot, processGone, processStarted, wrapperEnded, wrapperStarted, wrapperStatus } from "@agentwatch/adapter-generic-cli";
import { sanitizeInput, type AgentEventInput } from "@agentwatch/protocol";
import { sendEvents } from "./ipc";

export interface Step {
  /** Seconds from the start of the loop. */
  at: number;
  events: AgentEventInput[];
}

type Raw = Record<string, unknown>;

/**
 * A scripted, synthetic scenario that exercises every state the UI draws: a Claude session with three
 * subagents and a failing worker, a Codex session waiting for approval with token usage, and a quiet
 * generic CLI session. Entirely made up; nothing here comes from a real project.
 */
export function buildScenario(tag: string): Step[] {
  const steps: Step[] = [];
  const add = (at: number, events: AgentEventInput[]) => steps.push({ at, events });

  // ---- Claude Code: auth-service ----
  const C = `demo-claude-${tag}`;
  const cwd = "/Users/demo/work/auth-service";
  const ch = (at: number, extra: Raw) => add(at, mapClaudeHook({ session_id: C, cwd, ...extra }));
  ch(0.2, { hook_event_name: "SessionStart", model: "claude-sonnet-5-5", source: "startup" });
  ch(1.2, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: `${cwd}/src/auth/session.ts` } });
  ch(1.6, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "t1", tool_input: { file_path: `${cwd}/src/auth/session.ts` } });
  ch(2.6, { hook_event_name: "SubagentStart", agent_id: "explorer", agent_type: "explore" });
  ch(3.0, { hook_event_name: "SubagentStart", agent_id: "worker", agent_type: "worker" });
  ch(3.4, { hook_event_name: "SubagentStart", agent_id: "researcher", agent_type: "research" });
  ch(4.0, { hook_event_name: "PostToolUse", agent_id: "explorer", agent_type: "explore", tool_name: "Read", tool_use_id: "e1", tool_input: { file_path: `${cwd}/src/db/schema.ts` } });
  ch(5.0, { hook_event_name: "PostToolUse", agent_id: "explorer", agent_type: "explore", tool_name: "Grep", tool_use_id: "e2", tool_input: { path: `${cwd}/src` } });
  ch(5.6, { hook_event_name: "SubagentStop", agent_id: "explorer", agent_type: "explore" });
  ch(6.2, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "t2", tool_input: { file_path: `${cwd}/src/auth/session.ts` } });
  ch(6.8, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "t2", tool_input: { file_path: `${cwd}/src/auth/session.ts`, old_string: "a\nb\nc\nd", new_string: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu" } });
  ch(7.6, { hook_event_name: "PreToolUse", agent_id: "worker", agent_type: "worker", tool_name: "Bash", tool_use_id: "w1", tool_input: { command: "pnpm test" } });
  ch(8.8, { hook_event_name: "PostToolUse", agent_id: "researcher", agent_type: "research", tool_name: "Read", tool_use_id: "r1", tool_input: { file_path: `${cwd}/docs/migrations.md` } });
  ch(9.6, { hook_event_name: "PostToolUseFailure", agent_id: "worker", agent_type: "worker", tool_name: "Bash", tool_use_id: "w1", tool_input: { command: "pnpm test" }, error: "Command failed. Exit code 1" });
  ch(10.4, { hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "t3", tool_input: { file_path: `${cwd}/src/auth/session.ts` } });
  ch(11.0, { hook_event_name: "PostToolUse", tool_name: "Edit", tool_use_id: "t3", tool_input: { file_path: `${cwd}/src/auth/session.ts`, old_string: "x\ny", new_string: "x\ny\nz\nw\nv\nu\nt\ns\nr\nq" } });
  ch(12.0, { hook_event_name: "SubagentStop", agent_id: "researcher", agent_type: "research" });
  ch(12.6, { hook_event_name: "Stop" });

  // ---- Codex: billing-web (app-server shaped, approval pending) ----
  const X = `demo-codex-${tag}`;
  const m = new CodexAppServerMapper();
  const cx = (at: number, msg: unknown) => add(at, m.map(msg));
  const T = X;
  cx(1.0, { method: "thread/started", params: { thread: { id: T, cwd: "/Users/demo/work/billing-web", model: "gpt-5-codex" } } });
  cx(1.8, { method: "turn/started", params: { threadId: T, turn: { id: "t1" } } });
  cx(3.6, { method: "item/completed", params: { threadId: T, item: { id: "f1", type: "fileChange", status: "completed", changes: [{ path: "src/invoice/totals.ts", kind: "update", diff: "-a\n-b\n+c\n+d\n+e\n" }] } } });
  cx(5.4, { method: "item/started", params: { threadId: T, item: { id: "k1", type: "collabAgentToolCall", tool: "spawn_agent", senderThreadId: T, receiverThreadIds: [`${T}-reviewer`] } } });
  cx(6.4, { method: "item/started", params: { threadId: T, item: { id: "c1", type: "commandExecution", command: "pnpm test invoice" } } });
  cx(8.2, { method: "item/completed", params: { threadId: T, item: { id: "c1", type: "commandExecution", command: "pnpm test invoice", status: "completed", exitCode: 0, durationMs: 6100 } } });
  cx(8.8, { method: "item/completed", params: { threadId: `${T}-reviewer`, item: { id: "m1", type: "mcpToolCall", server: "fs", tool: "read", status: "completed", durationMs: 12 } } });
  cx(9.6, { method: "thread/tokenUsage/updated", params: { threadId: T, tokenUsage: { total: { inputTokens: 48200, cachedInputTokens: 31000, outputTokens: 13200, reasoningOutputTokens: 4100 } } } });
  cx(11.0, { method: "item/commandExecution/requestApproval", id: 1, params: { threadId: T, itemId: "c2", approvalId: "appr-1", command: "rm -rf dist && pnpm build" } });

  // ---- Generic CLI: notes-cli (wrapper, observed only) ----
  const G = `demo-generic-${tag}`;
  const ref = { sessionId: G };
  add(0.5, [wrapperStarted(ref, { executable: "custom-agent", cwd: "/Users/demo/work/notes-cli" })]);
  add(4.5, [fileObserved(ref, "write", "/Users/demo/work/notes-cli/src/index.ts")]);
  add(4.7, [processStarted(ref, { pid: 90001, ppid: 90000, argv: "git status" })]);
  add(5.0, [processGone(ref, 90001)]);
  add(5.2, [gitSnapshot(ref, { changedFiles: 1, additions: 3, deletions: 1 })]);
  add(13.0, [wrapperStatus(ref, "idle", "no output")]);
  void wrapperEnded;

  return steps.sort((a, b) => a.at - b.at);
}

export interface DemoOptions {
  socket: string;
  speed?: number;
  loops?: number;
  /** Hard stop in seconds so a forgotten demo can never run forever. */
  maxSeconds?: number;
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function playDemo(opts: DemoOptions): Promise<{ sent: number; loops: number }> {
  const speed = opts.speed ?? 1;
  const deadline = Date.now() + (opts.maxSeconds ?? 120) * 1000;
  let sent = 0;
  let loop = 0;
  for (; loop < (opts.loops ?? 1); loop++) {
    const steps = buildScenario(`${Date.now().toString(36)}${loop}`);
    const t0 = Date.now();
    for (const step of steps) {
      const wait = step.at * 1000 / speed - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
      if (Date.now() > deadline) return { sent, loops: loop };
      // Events were built up front, so their timestamps would all be "now". Drop them and let the
      // daemon stamp each event on arrival, which is what a live agent looks like.
      const live = step.events.map((e) => {
        const { occurredAt: _drop, ...rest } = sanitizeInput(e).event;
        void _drop;
        return rest;
      });
      const n = await sendEvents(live, { socket: opts.socket, timeoutMs: 1500 });
      sent += n;
      opts.log?.(`+${step.at.toFixed(1)}s  ${step.events.map((e) => e.kind).join(", ")}`);
    }
  }
  return { sent, loops: loop };
}
