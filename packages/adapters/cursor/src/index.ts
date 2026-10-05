import { createHash } from "node:crypto";
import type { AgentEventInput } from "@agentwatch/protocol";
import { asRecord, countLines, makeEvent, pathOf, str, type AdapterCapabilities, type AdapterContext, type HookAdapter } from "@agentwatch/adapter-sdk";

/**
 * Cursor hook adapter. Field names follow Cursor's hooks documentation (cursor.com/docs/agent/hooks);
 * nothing here has been confirmed against a live Cursor payload yet, so unknown shapes map to nothing.
 *
 * Only events that report something that already happened are subscribed. Cursor's "before" hooks
 * (beforeSubmitPrompt, preToolUse, beforeShellExecution, ...) read the hook's output as an allow/deny
 * decision; an observer must never sit in that path, and those events also carry prompts and file contents.
 *
 * Subagents are not mapped: subagentStop carries no id to pair with subagentStart. Cursor has no
 * permission-request event. Capabilities for those are "none".
 */

export const cursorCapabilities: AdapterCapabilities = {
  provider: "cursor",
  sessionLifecycle: "partial",
  toolCalls: "high",
  fileReads: "none",
  fileWrites: "high",
  commands: "high",
  subagents: "none",
  approvals: "none",
  tokenUsage: "none",
};

/** Hook events AgentWatch subscribes to: completed work and lifecycle only. */
export const CURSOR_HOOK_EVENTS = ["sessionStart", "sessionEnd", "postToolUse", "postToolUseFailure", "afterShellExecution", "afterFileEdit", "stop"] as const;

function oneLine(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const line = v.trim().split(/\r?\n/)[0]?.trim();
  return line ? line.slice(0, max) : undefined;
}

function editDelta(edits: unknown): { additions?: number; deletions?: number } {
  if (!Array.isArray(edits)) return {};
  let add = 0;
  let del = 0;
  for (const e of edits) {
    const r = asRecord(e);
    add += countLines(r.new_string);
    del += countLines(r.old_string);
  }
  return { additions: add, deletions: del };
}

export function mapCursorHook(raw: unknown, ctx: AdapterContext = {}): AgentEventInput[] {
  const h = asRecord(raw);
  const name = str(h.hook_event_name);
  // tool events carry conversation_id; the session events carry session_id
  const providerSessionId = str(h.conversation_id) ?? str(h.session_id);
  if (!name || !providerSessionId) return [];

  const roots = Array.isArray(h.workspace_roots) ? h.workspace_roots : [];
  const cwd = str(h.cwd) ?? str(roots[0]);
  const toolName = str(h.tool_name);
  const toolUseId = str(h.tool_use_id);
  const input = asRecord(h.tool_input);
  const base = { provider: "cursor" as const, providerSessionId, cwd, source: "cursor-hook" as const };
  const ev = (kind: AgentEventInput["kind"], payload: Record<string, unknown>, extra: Partial<AgentEventInput> = {}) => makeEvent({ ...base, kind, payload, ...extra }, ctx);

  switch (name) {
    case "sessionStart":
      return [ev("session.started", { cwd })];

    case "sessionEnd":
      return [ev("session.ended", { reason: str(h.reason) })];

    case "postToolUse":
      return toolName ? [ev("tool.completed", { toolName, toolUseId, target: pathOf(input) }, { correlationId: toolUseId })] : [];

    case "postToolUseFailure":
      return toolName ? [ev("tool.failed", { toolName, toolUseId, error: oneLine(h.error_message, 160), isInterrupt: h.is_interrupt === true ? true : undefined }, { correlationId: toolUseId })] : [];

    case "afterShellExecution": {
      const command = str(h.command);
      if (!command) return [];
      // the hook reports a finished command: no exit code is documented, so none is claimed
      const id = `c-${createHash("sha1").update(providerSessionId).update("\0").update(command).update(String(Date.now())).digest("hex").slice(0, 16)}`;
      return [ev("command.started", { commandId: id, argvDisplay: command }), ev("command.completed", { commandId: id })];
    }

    case "afterFileEdit": {
      const path = str(h.file_path);
      return path ? [ev("file.write", { path, ...editDelta(h.edits) })] : [];
    }

    case "stop":
      return [ev("status.changed", { status: "idle", label: "turn finished" })];

    default:
      return [];
  }
}

export const cursorAdapter: HookAdapter = { provider: "cursor", capabilities: cursorCapabilities, mapHook: mapCursorHook };

/** The hooks block AgentWatch adds to ~/.cursor/hooks.json (Cursor's flat entry shape, with `version: 1` on the file). */
export function cursorHooksConfig(command: string): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const event of CURSOR_HOOK_EVENTS) hooks[event] = [{ command }];
  return { hooks };
}
