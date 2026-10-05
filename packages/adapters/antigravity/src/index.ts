import type { AgentEventInput } from "@agentwatch/protocol";
import { asRecord, countLines, makeEvent, str, type AdapterCapabilities, type AdapterContext, type HookAdapter } from "@agentwatch/adapter-sdk";

/**
 * Antigravity CLI (`agy`) hook adapter. Field names come from the hooks guide bundled inside the installed
 * agy 1.2.17: camelCase JSON on stdin with `conversationId`, `workspacePaths`, `transcriptPath`, `modelName`
 * on every event, plus per event:
 *   PreInvocation   invocationNum, initialNumSteps        (the model is about to be called)
 *   PostToolUse     stepIdx, error?, toolCall? {name, args}
 *   Stop            executionNum, terminationReason, error, fullyIdle
 *
 * The payload does not name its own event, so the three events AgentWatch subscribes to are told apart by
 * the field only they carry. PreToolUse and PostInvocation are never subscribed: their output is read as
 * a decision (allow/deny, force_continue), and an observer must not sit in that path.
 *
 * Privacy: the prompt and the model's text are not in these events. Tool arguments are reduced to the
 * command line and the file path; file contents (CodeContent, ReplacementContent) are never read.
 */

export const antigravityCapabilities: AdapterCapabilities = {
  provider: "antigravity",
  sessionLifecycle: "partial",
  toolCalls: "high",
  fileReads: "none",
  fileWrites: "partial",
  commands: "high",
  subagents: "none",
  approvals: "none",
  tokenUsage: "none",
};

/** Hook events AgentWatch subscribes to. */
export const ANTIGRAVITY_HOOK_EVENTS = ["PreInvocation", "PostToolUse", "Stop"] as const;

const SHELL_TOOL = "run_command";
const WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);

function oneLine(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const line = v.trim().split(/\r?\n/)[0]?.trim();
  return line ? line.slice(0, max) : undefined;
}

function exitCodeFrom(error: string | undefined): number {
  const m = error ? /exit status (-?\d+)/i.exec(error) : null;
  return m ? Number(m[1]) : 1;
}

export function mapAntigravityHook(raw: unknown, ctx: AdapterContext = {}): AgentEventInput[] {
  const h = asRecord(raw);
  const providerSessionId = str(h.conversationId);
  if (!providerSessionId) return [];

  const roots = Array.isArray(h.workspacePaths) ? h.workspacePaths : [];
  const cwd = str(roots[0]);
  const base = { provider: "antigravity" as const, providerSessionId, cwd, source: "antigravity-hook" as const };
  const ev = (kind: AgentEventInput["kind"], payload: Record<string, unknown>) => makeEvent({ ...base, kind, payload }, ctx);

  // Stop
  if (h.executionNum !== undefined || h.terminationReason !== undefined) {
    return [ev("status.changed", { status: "idle", label: "turn finished" })];
  }

  // PostToolUse
  if (h.stepIdx !== undefined) {
    const call = asRecord(h.toolCall);
    const toolName = str(call.name) ?? "tool";
    const args = asRecord(call.args);
    const error = str(h.error);
    const target = str(args.TargetFile);
    const out = error ? [ev("tool.failed", { toolName, error: oneLine(error, 160) })] : [ev("tool.completed", { toolName, target })];
    if (toolName === SHELL_TOOL) {
      // the hook reports a finished command; its start was never seen, so both are written together
      const id = `a-${providerSessionId.slice(0, 8)}-${String(h.stepIdx)}`;
      out.unshift(ev("command.started", { commandId: id, argvDisplay: str(args.CommandLine) ?? "(command)" }));
      out.push(ev("command.completed", { commandId: id, exitCode: error ? exitCodeFrom(error) : 0 }));
    } else if (!error && target && WRITE_TOOLS.has(toolName)) {
      out.push(ev("file.write", { path: target, toolName, additions: countLines(args.CodeContent) || undefined }));
    }
    return out;
  }

  // PreInvocation: the model is about to be called, so a turn is under way
  if (h.invocationNum !== undefined) return [ev("status.changed", { status: "running", label: "model called" })];

  return [];
}

export const antigravityAdapter: HookAdapter = { provider: "antigravity", capabilities: antigravityCapabilities, mapHook: mapAntigravityHook };

/**
 * The hook group AgentWatch owns in ~/.gemini/config/hooks.json (a file whose top-level keys are hook names).
 * Tool events are grouped under a matcher; the invocation and Stop events are a flat list of handlers.
 */
export function antigravityHooksConfig(command: string): { hooks: Record<string, unknown[]> } {
  const handler = { type: "command", command, timeout: 5 };
  return {
    hooks: {
      PreInvocation: [handler],
      PostToolUse: [{ matcher: "*", hooks: [handler] }],
      Stop: [handler],
    },
  };
}
