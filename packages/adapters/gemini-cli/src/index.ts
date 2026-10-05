import { createHash } from "node:crypto";
import type { AgentEventInput } from "@agentwatch/protocol";
import { asRecord, countLines, makeEvent, pathOf, str, type AdapterCapabilities, type AdapterContext, type HookAdapter } from "@agentwatch/adapter-sdk";

/**
 * Gemini CLI hook adapter. Field names come from the installed Gemini CLI (0.49): every hook gets
 * `session_id`, `cwd`, `hook_event_name`, `transcript_path`, `timestamp`; BeforeTool/AfterTool add
 * `tool_name` and `tool_input` (AfterTool also `tool_response: {llmContent, returnDisplay, error}`).
 *
 * Privacy: BeforeAgent's `prompt` and AfterAgent's `prompt`/`prompt_response` are never read, and tool
 * inputs/responses are reduced to paths, tool names and line counts here.
 *
 * Gemini has no tool-call id, no subagent events and no permission-request event, so those capabilities
 * are "none": AgentWatch says nothing rather than guess.
 */

export const geminiCapabilities: AdapterCapabilities = {
  provider: "gemini-cli",
  sessionLifecycle: "high",
  toolCalls: "high",
  fileReads: "high",
  fileWrites: "high",
  commands: "high",
  subagents: "none",
  approvals: "none",
  tokenUsage: "none",
};

/** Hook events AgentWatch subscribes to. */
export const GEMINI_HOOK_EVENTS = ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool", "Notification"] as const;

const READ_TOOLS = new Set(["read_file"]);
const WRITE_TOOLS = new Set(["write_file", "replace"]);
const SHELL_TOOL = "run_shell_command";

function oneLine(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const line = v.trim().split(/\r?\n/)[0]?.trim();
  return line ? line.slice(0, max) : undefined;
}

/** Gemini sends no tool-call id; the same tool and input is the best pairing key for Before/After of one call. */
function callId(toolName: string, input: Record<string, unknown>): string {
  return `g-${createHash("sha1").update(toolName).update("\0").update(JSON.stringify(input)).digest("hex").slice(0, 16)}`;
}

function lineDelta(toolName: string, input: Record<string, unknown>): { additions?: number; deletions?: number } {
  if (toolName === "replace") return { additions: countLines(input.new_string), deletions: countLines(input.old_string) };
  if (toolName === "write_file") return { additions: countLines(input.content) };
  return {};
}

export function mapGeminiHook(raw: unknown, ctx: AdapterContext = {}): AgentEventInput[] {
  const h = asRecord(raw);
  const name = str(h.hook_event_name);
  const providerSessionId = str(h.session_id);
  if (!name || !providerSessionId) return [];

  const cwd = str(h.cwd);
  const toolName = str(h.tool_name);
  const input = asRecord(h.tool_input);
  const base = { provider: "gemini-cli" as const, providerSessionId, cwd, source: "gemini-hook" as const };
  const ev = (kind: AgentEventInput["kind"], payload: Record<string, unknown>, extra: Partial<AgentEventInput> = {}) => makeEvent({ ...base, kind, payload, ...extra }, ctx);

  switch (name) {
    case "SessionStart":
      return [ev("session.started", { cwd, startSource: str(h.source) })];

    case "SessionEnd":
      return [ev("session.ended", { reason: str(h.reason) })];

    case "BeforeAgent":
      // the turn began; the prompt itself is not read
      return [ev("status.changed", { status: "running", label: "turn started" })];

    case "AfterAgent":
      return [ev("status.changed", { status: "idle", label: "turn finished" })];

    case "BeforeTool": {
      if (!toolName) return [];
      const id = callId(toolName, input);
      const out = [ev("tool.started", { toolName, target: pathOf(input) }, { correlationId: id })];
      if (toolName === SHELL_TOOL) out.push(ev("command.started", { commandId: id, argvDisplay: str(input.command) ?? "(command)" }, { correlationId: id }));
      return out;
    }

    case "AfterTool": {
      if (!toolName) return [];
      const id = callId(toolName, input);
      const failed = asRecord(h.tool_response).error != null;
      if (failed) {
        const err = asRecord(asRecord(h.tool_response).error);
        const out = [ev("tool.failed", { toolName, error: oneLine(err.message, 160) }, { correlationId: id })];
        if (toolName === SHELL_TOOL) out.push(ev("command.completed", { commandId: id, exitCode: 1 }, { correlationId: id }));
        return out;
      }
      const out = [ev("tool.completed", { toolName, target: pathOf(input) }, { correlationId: id })];
      const path = pathOf(input);
      if (toolName === SHELL_TOOL) out.push(ev("command.completed", { commandId: id, exitCode: 0 }, { correlationId: id }));
      else if (path && READ_TOOLS.has(toolName)) out.push(ev("file.read", { path, toolName }, { correlationId: id }));
      else if (path && WRITE_TOOLS.has(toolName)) out.push(ev("file.write", { path, toolName, ...lineDelta(toolName, input) }, { correlationId: id }));
      return out;
    }

    case "Notification":
      return [ev("log", { message: oneLine(h.message, 160) ?? "notification", level: "info" })];

    default:
      return [];
  }
}

export const geminiAdapter: HookAdapter = { provider: "gemini-cli", capabilities: geminiCapabilities, mapHook: mapGeminiHook };

/** The hooks block AgentWatch adds to ~/.gemini/settings.json. Observer only: always exits 0, never blocks. */
export function geminiHooksConfig(command: string): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const event of GEMINI_HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: "command", command }] }];
  return { hooks };
}
