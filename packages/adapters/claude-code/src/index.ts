import type { AgentEventInput } from "@agentwatch/protocol";
import {
  asRecord,
  countLines,
  makeEvent,
  num,
  pathOf,
  str,
  type AdapterCapabilities,
  type AdapterContext,
  type HookAdapter,
} from "@agentwatch/adapter-sdk";

/**
 * Claude Code hook adapter. Hooks are the authoritative source: they carry session, tool, subagent,
 * permission and model events with ids. Transcript files are NOT parsed.
 *
 * Privacy: UserPromptSubmit is never mapped. Tool inputs/responses are reduced to metadata here
 * (paths, tool names, line counts) so file contents and prompts never leave this function.
 *
 * Field names follow the Claude Code hooks documentation as reported by a research pass; fixtures in
 * fixtures/claude are the contract. Anything not recognised is ignored rather than guessed.
 */

const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const FILE_READ_TOOLS = new Set(["Read", "NotebookRead"]);

export const claudeCapabilities: AdapterCapabilities = {
  provider: "claude-code",
  sessionLifecycle: "high",
  toolCalls: "high",
  fileReads: "high",
  fileWrites: "high",
  commands: "high",
  subagents: "high",
  approvals: "high",
  tokenUsage: "partial",
};

/** Hook events AgentWatch subscribes to. UserPromptSubmit is deliberately absent. */
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "FileChanged",
  "PostModelSwitch",
] as const;

/** Tool errors can embed stderr or file text. Keep only the first line, capped; the rest is dropped. */
function firstLine(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const line = value.split("\n", 1)[0]?.trim();
  return line ? line.slice(0, 160) : undefined;
}

function oneLine(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const line = v.trim().split(/\r?\n/)[0]?.trim();
  return line ? line.slice(0, max) : undefined;
}

function exitCodeFrom(error: unknown): number {
  const m = typeof error === "string" ? /exit(?:ed with)? code[:\s]+(-?\d+)/i.exec(error) : null;
  return m ? Number(m[1]) : 1;
}

function lineDelta(toolName: string, input: Record<string, unknown>): { additions?: number; deletions?: number } {
  if (toolName === "Edit") {
    return { additions: countLines(input.new_string), deletions: countLines(input.old_string) };
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    let add = 0;
    let del = 0;
    for (const e of input.edits) {
      const r = asRecord(e);
      add += countLines(r.new_string);
      del += countLines(r.old_string);
    }
    return { additions: add, deletions: del };
  }
  if (toolName === "Write") {
    const body = input.content ?? input.contents;
    return { additions: countLines(body) };
  }
  return {};
}

export function mapClaudeHook(raw: unknown, ctx: AdapterContext = {}): AgentEventInput[] {
  const h = asRecord(raw);
  const name = str(h.hook_event_name);
  const providerSessionId = str(h.session_id);
  if (!name || !providerSessionId) return [];

  const providerAgentId = str(h.agent_id);
  const cwd = str(h.cwd);
  const toolName = str(h.tool_name);
  const toolUseId = str(h.tool_use_id);
  const input = asRecord(h.tool_input);

  const base = { provider: "claude-code" as const, providerSessionId, providerAgentId, cwd, source: "claude-hook" as const };
  const ev = (kind: AgentEventInput["kind"], payload: Record<string, unknown>, extra: Partial<AgentEventInput> = {}) =>
    makeEvent({ ...base, kind, payload, correlationId: toolUseId, ...extra }, ctx);

  switch (name) {
    case "SessionStart":
      return [ev("session.started", { cwd, model: str(h.model), startSource: str(h.source) })];

    case "SessionEnd":
      return [ev("session.ended", { reason: str(h.reason) })];

    case "PreToolUse": {
      if (!toolName) return [];
      const isTask = toolName === "Task" || toolName === "Agent";
      // Only the short description the model gave the task becomes the subagent's name. The task prompt is never read.
      const taskLabel = isTask ? oneLine(input.description, 80) : undefined;
      const out = [ev("tool.started", { toolName, toolUseId, target: pathOf(input), taskLabel, subagentType: isTask ? str(input.subagent_type) : undefined })];
      if (toolName === "Bash") {
        out.push(ev("command.started", { commandId: toolUseId ?? `bash-${Date.now()}`, argvDisplay: str(input.command) ?? "(command)", toolUseId }));
      }
      return out;
    }

    case "PostToolUse": {
      if (!toolName) return [];
      const out = [ev("tool.completed", { toolName, toolUseId, target: pathOf(input) })];
      const path = pathOf(input);
      if (toolName === "Bash") {
        out.push(ev("command.completed", { commandId: toolUseId ?? "bash", exitCode: 0 }));
      } else if (path && FILE_READ_TOOLS.has(toolName)) {
        out.push(ev("file.read", { path, toolName, toolUseId }));
      } else if (path && FILE_WRITE_TOOLS.has(toolName)) {
        out.push(ev("file.write", { path, toolName, toolUseId, ...lineDelta(toolName, input) }));
      }
      return out;
    }

    case "PostToolUseFailure": {
      if (!toolName) return [];
      const error = str(h.error);
      const out = [ev("tool.failed", { toolName, toolUseId, error: firstLine(error), isInterrupt: h.is_interrupt === true ? true : undefined })];
      if (toolName === "Bash") {
        out.push(ev("command.completed", { commandId: toolUseId ?? "bash", exitCode: exitCodeFrom(error) }));
      }
      return out;
    }

    case "PermissionRequest": {
      if (!toolName) return [];
      const kind = toolName === "Bash" ? "command" : FILE_WRITE_TOOLS.has(toolName) ? "file_change" : "permission";
      const summary = toolName === "Bash" ? str(input.command) ?? "run a command" : pathOf(input) ?? `use ${toolName}`;
      return [ev("approval.requested", { requestId: toolUseId ?? `perm-${toolName}-${Date.now()}`, kind, summary, toolName })];
    }

    case "Notification":
      return [ev("log", { message: str(h.message) ?? "notification", level: "info" })];

    case "SubagentStart":
      return providerAgentId ? [ev("agent.started", { agentType: str(h.agent_type), displayName: str(h.agent_type) })] : [];

    case "SubagentStop":
      return providerAgentId ? [ev("agent.ended", { agentType: str(h.agent_type), outcome: "done" })] : [];

    case "Stop":
      return [ev("status.changed", { status: "idle", label: "turn finished" })];

    case "FileChanged": {
      const path = str(h.file_path) ?? pathOf(input);
      return path ? [ev("file.write", { path }, { confidence: "medium" })] : [];
    }

    case "PostModelSwitch":
      return [ev("status.changed", { status: "running", model: str(h.model) ?? str(h.new_model) })];

    default:
      // UserPromptSubmit and every event we have not mapped: ignored on purpose.
      return [];
  }
}

export const claudeAdapter: HookAdapter = {
  provider: "claude-code",
  capabilities: claudeCapabilities,
  mapHook: mapClaudeHook,
};

/** The hooks block AgentWatch asks the user to add. Observer only: always exits 0, never blocks. */
export function claudeHooksConfig(command: string): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    hooks[event] = [{ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] }];
  }
  return { hooks };
}

export { num };
