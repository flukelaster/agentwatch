import type { AgentEventInput } from "@agentwatch/protocol";
import {
  asRecord,
  makeEvent,
  num,
  str,
  type AdapterCapabilities,
  type AdapterContext,
  type HookAdapter,
} from "@agentwatch/adapter-sdk";
import { diffStat, summarizePatch } from "./patch";

/**
 * Codex adapters. STATUS: built from documentation read by a research pass (hooks page, app-server
 * Rust protocol sources, exec_events.rs). Nothing here has been run against a live Codex install.
 * Fixtures in fixtures/codex are the contract; verify field names against real traffic before relying
 * on this adapter.
 *
 * Three entry points:
 *  - mapCodexHook: plain `codex` sessions with hooks configured (observation path).
 *  - CodexAppServerMapper: JSON-RPC messages when AgentWatch owns the Codex launch (richest path).
 *  - mapCodexExecLine: `codex exec --json` JSONL (tests and automation).
 * Prompts, assistant text, reasoning, tool output and patch bodies are never mapped.
 */

export const codexHookCapabilities: AdapterCapabilities = {
  provider: "codex",
  sessionLifecycle: "high",
  toolCalls: "high",
  fileReads: "none",
  fileWrites: "high",
  commands: "high",
  subagents: "partial",
  approvals: "high",
  tokenUsage: "none",
};

export const codexAppServerCapabilities: AdapterCapabilities = {
  ...codexHookCapabilities,
  subagents: "high",
  tokenUsage: "high",
};

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "Interrupt",
] as const;

// ---------------------------------------------------------------- hooks

export function mapCodexHook(raw: unknown, ctx: AdapterContext = {}): AgentEventInput[] {
  const h = asRecord(raw);
  const name = str(h.hook_event_name);
  const providerSessionId = str(h.session_id);
  if (!name || !providerSessionId) return [];
  const providerAgentId = str(h.agent_id);
  const cwd = str(h.cwd);
  const toolName = str(h.tool_name);
  const toolUseId = str(h.tool_use_id);
  const input = asRecord(h.tool_input);
  const command = str(input.command);

  const base = { provider: "codex" as const, providerSessionId, providerAgentId, cwd, source: "codex-hook" as const };
  const ev = (kind: AgentEventInput["kind"], payload: Record<string, unknown>) =>
    makeEvent({ ...base, kind, payload, correlationId: toolUseId }, ctx);

  switch (name) {
    case "SessionStart":
      return [ev("session.started", { cwd, model: str(h.model), startSource: str(h.source) })];
    case "SessionEnd":
      return [ev("session.ended", { reason: str(h.reason) })];
    case "PreToolUse": {
      if (!toolName) return [];
      if (toolName === "apply_patch") {
        const files = summarizePatch(command);
        return [ev("tool.started", { toolName, toolUseId, target: files[0]?.path })];
      }
      const out = [ev("tool.started", { toolName, toolUseId })];
      if (toolName === "Bash" && command) out.push(ev("command.started", { commandId: toolUseId ?? `cmd-${Date.now()}`, argvDisplay: command, toolUseId }));
      return out;
    }
    case "PostToolUse": {
      if (!toolName) return [];
      const out = [ev("tool.completed", { toolName, toolUseId })];
      if (toolName === "Bash") {
        const resp = asRecord(h.tool_response);
        out.push(ev("command.completed", { commandId: toolUseId ?? "cmd", exitCode: num(resp.exit_code) ?? num(resp.exitCode) ?? 0 }));
      } else if (toolName === "apply_patch") {
        for (const f of summarizePatch(command)) {
          out.push(ev(f.op === "delete" ? "file.delete" : "file.write", { path: f.path, toolName, toolUseId, additions: f.additions, deletions: f.deletions }));
        }
      }
      return out;
    }
    case "PermissionRequest": {
      if (!toolName) return [];
      const files = toolName === "apply_patch" ? summarizePatch(command) : [];
      const kind = toolName === "Bash" ? "command" : toolName === "apply_patch" ? "file_change" : "permission";
      const summary = toolName === "Bash" ? command ?? "run a command" : files.length ? files.map((f) => f.path).join(", ") : `use ${toolName}`;
      return [ev("approval.requested", { requestId: toolUseId ?? `perm-${Date.now()}`, kind, summary, toolName })];
    }
    case "SubagentStart":
      return providerAgentId ? [ev("agent.started", { agentType: str(h.agent_type), displayName: str(h.agent_type) })] : [];
    case "SubagentStop":
      return providerAgentId ? [ev("agent.ended", { agentType: str(h.agent_type), outcome: "done" })] : [];
    case "Stop":
      return [ev("status.changed", { status: "idle", label: "turn finished" })];
    case "Interrupt":
      return [ev("status.changed", { status: "idle", label: "interrupted" })];
    default:
      return []; // UserPromptSubmit, Pre/PostCompact, anything new
  }
}

export const codexHookAdapter: HookAdapter = {
  provider: "codex",
  capabilities: codexHookCapabilities,
  mapHook: mapCodexHook,
};

/** hooks.json block for ~/.codex/hooks.json. Observer only: exits 0, no output. */
export function codexHooksConfig(command: string): { hooks: Record<string, unknown[]> } {
  const hooks: Record<string, unknown[]> = {};
  for (const event of CODEX_HOOK_EVENTS) {
    hooks[event] = [{ matcher: ".*", hooks: [{ type: "command", command, timeout: 3 }] }];
  }
  return { hooks };
}

// ---------------------------------------------------------------- app server

interface Msg {
  method?: string;
  params?: unknown;
  id?: string | number;
}

/**
 * Stateful because a subagent is its own thread: child threads are learned from collab tool calls and
 * their events are attributed to the root session with the child thread as the agent.
 */
export class CodexAppServerMapper {
  private readonly parentOf = new Map<string, string>();
  constructor(private readonly ctx: AdapterContext = {}) {}

  private place(threadId: string): { providerSessionId: string; providerAgentId?: string; parentProviderAgentId?: string } {
    let root = threadId;
    const parent = this.parentOf.get(threadId);
    if (!parent) return { providerSessionId: root };
    root = parent;
    while (this.parentOf.has(root)) root = this.parentOf.get(root)!;
    const out: { providerSessionId: string; providerAgentId?: string; parentProviderAgentId?: string } = { providerSessionId: root, providerAgentId: threadId };
    if (parent !== root) out.parentProviderAgentId = parent;
    return out;
  }

  /** Handles notifications and server->client requests (approvals). Returns normalized events. */
  map(message: unknown): AgentEventInput[] {
    const m = asRecord(message) as Msg;
    const method = str(m.method);
    if (!method) return [];
    const p = asRecord(m.params);
    const threadId = str(p.threadId) ?? str(asRecord(p.thread).id);
    if (!threadId) return [];
    const at = this.place(threadId);
    const ev = (kind: AgentEventInput["kind"], payload: Record<string, unknown>, correlationId?: string) =>
      makeEvent({ provider: "codex", source: "codex-app-server", ...at, kind, payload, correlationId }, this.ctx);

    switch (method) {
      case "thread/started": {
        const t = asRecord(p.thread);
        return [ev("session.started", { cwd: str(t.cwd), model: str(t.model) })];
      }
      case "thread/closed":
      case "thread/archived":
        return [ev("session.ended", { reason: method })];
      case "thread/status/changed": {
        const status = p.status;
        const kind = typeof status === "string" ? status : str(asRecord(status).type);
        const flags = Array.isArray(asRecord(status).activeFlags) ? (asRecord(status).activeFlags as unknown[]) : [];
        if (kind === "idle" || kind === "notLoaded") return [ev("status.changed", { status: "idle", label: "idle" })];
        if (kind === "active" && flags.some((f) => f === "waitingOnApproval" || f === "waitingOnUserInput")) {
          return [ev("status.changed", { status: "waiting", label: "waiting on you" })];
        }
        if (kind === "active") return [ev("status.changed", { status: "running" })];
        if (kind === "systemError") return [ev("log", { message: "codex reported a system error", level: "error" })];
        return [];
      }
      case "turn/started":
        return [ev("status.changed", { status: "running", label: "turn started" })];
      case "turn/completed": {
        const status = str(asRecord(p.turn).status);
        const out = [ev("status.changed", { status: "idle", label: status === "failed" ? "turn failed" : "turn finished" })];
        if (status === "failed") out.push(ev("log", { message: "turn failed", level: "error" }));
        return out;
      }
      case "thread/tokenUsage/updated": {
        const total = asRecord(asRecord(p.tokenUsage).total);
        return [
          ev("usage.updated", {
            inputTokens: num(total.inputTokens),
            outputTokens: num(total.outputTokens),
            cachedInputTokens: num(total.cachedInputTokens),
            reasoningTokens: num(total.reasoningOutputTokens),
            providerReported: true,
            scope: "thread",
          }),
        ];
      }
      case "item/started":
      case "item/completed":
        return this.mapItem(method === "item/started", asRecord(p.item), ev, threadId);
      case "item/commandExecution/requestApproval": {
        const id = str(p.approvalId) ?? str(p.itemId) ?? `appr-${m.id ?? Date.now()}`;
        return [ev("approval.requested", { requestId: id, kind: "command", summary: str(p.command) ?? "run a command", toolName: "commandExecution" }, id)];
      }
      case "item/fileChange/requestApproval": {
        const id = str(p.itemId) ?? `appr-${m.id ?? Date.now()}`;
        return [ev("approval.requested", { requestId: id, kind: "file_change", summary: str(p.reason) ?? "change files", toolName: "fileChange" }, id)];
      }
      case "serverRequest/resolved": {
        const id = str(p.requestId) ?? str(p.approvalId) ?? str(p.itemId);
        return id ? [ev("approval.resolved", { requestId: id, decision: "unknown" }, id)] : [];
      }
      default:
        return []; // deltas, reasoning, agent messages, plans, diffs: not mapped on purpose
    }
  }

  private mapItem(
    started: boolean,
    item: Record<string, unknown>,
    ev: (kind: AgentEventInput["kind"], payload: Record<string, unknown>, correlationId?: string) => AgentEventInput,
    threadId: string,
  ): AgentEventInput[] {
    const id = str(item.id);
    const type = str(item.type);
    if (!id || !type) return [];
    switch (type) {
      case "commandExecution": {
        if (started) return [ev("tool.started", { toolName: "commandExecution", toolUseId: id }, id), ev("command.started", { commandId: id, argvDisplay: str(item.command) ?? "(command)", toolUseId: id }, id)];
        const failed = item.status === "failed";
        const out = [ev("command.completed", { commandId: id, exitCode: num(item.exitCode) ?? (failed ? 1 : 0), durationMs: num(item.durationMs) }, id)];
        out.push(ev(failed ? "tool.failed" : "tool.completed", { toolName: "commandExecution", toolUseId: id }, id));
        return out;
      }
      case "fileChange": {
        if (started) return [ev("tool.started", { toolName: "fileChange", toolUseId: id }, id)];
        if (item.status === "failed" || item.status === "declined") return [ev("tool.failed", { toolName: "fileChange", toolUseId: id, error: String(item.status) }, id)];
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const out = [ev("tool.completed", { toolName: "fileChange", toolUseId: id }, id)];
        for (const c of changes) {
          const r = asRecord(c);
          const path = str(r.path);
          if (!path) continue;
          const kind = str(r.kind) ?? str(asRecord(r.kind).type);
          const stat = diffStat(r.diff);
          out.push(ev(kind === "delete" ? "file.delete" : "file.write", { path, toolName: "fileChange", toolUseId: id, additions: stat.additions, deletions: stat.deletions }, id));
        }
        return out;
      }
      case "mcpToolCall": {
        const toolName = `${str(item.server) ?? "mcp"}.${str(item.tool) ?? "tool"}`;
        if (started) return [ev("tool.started", { toolName, toolUseId: id }, id)];
        return [ev(item.status === "failed" ? "tool.failed" : "tool.completed", { toolName, toolUseId: id, durationMs: num(item.durationMs) }, id)];
      }
      case "collabAgentToolCall": {
        const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((x): x is string => typeof x === "string") : [];
        const sender = str(item.senderThreadId) ?? threadId;
        const out: AgentEventInput[] = [];
        if (started) out.push(ev("tool.started", { toolName: str(item.tool) ?? "collab", toolUseId: id }, id));
        for (const r of receivers) {
          if (!this.parentOf.has(r)) {
            this.parentOf.set(r, sender);
            out.push(makeEvent({ provider: "codex", source: "codex-app-server", ...this.place(r), kind: "agent.started", payload: { agentType: "subagent", model: str(item.model) } }, this.ctx));
          }
        }
        return out;
      }
      case "subAgentActivity": {
        const child = str(item.agentThreadId);
        if (!child || this.parentOf.has(child)) return [];
        this.parentOf.set(child, threadId);
        return [makeEvent({ provider: "codex", source: "codex-app-server", ...this.place(child), kind: "agent.started", payload: { agentType: str(item.kind) ?? "subagent" } }, this.ctx)];
      }
      default:
        return []; // userMessage, agentMessage, reasoning, plan, ...: content, never mapped
    }
  }
}

// ---------------------------------------------------------------- codex exec --json

export function mapCodexExecLine(line: unknown, ctx: AdapterContext = {}, state: { threadId?: string } = {}): AgentEventInput[] {
  const l = asRecord(line);
  const type = str(l.type);
  if (!type) return [];
  if (type === "thread.started") state.threadId = str(l.thread_id);
  const threadId = state.threadId;
  if (!threadId) return [];
  const ev = (kind: AgentEventInput["kind"], payload: Record<string, unknown>, correlationId?: string) =>
    makeEvent({ provider: "codex", source: "codex-app-server", providerSessionId: threadId, kind, payload, correlationId }, ctx);

  switch (type) {
    case "thread.started":
      return [ev("session.started", {})];
    case "turn.started":
      return [ev("status.changed", { status: "running", label: "turn started" })];
    case "turn.completed": {
      const u = asRecord(l.usage);
      return [
        ev("usage.updated", { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cachedInputTokens: num(u.cached_input_tokens), reasoningTokens: num(u.reasoning_output_tokens), providerReported: true, scope: "turn" }),
        ev("status.changed", { status: "idle", label: "turn finished" }),
      ];
    }
    case "turn.failed":
    case "error":
      return [ev("log", { message: "codex reported an error", level: "error" })];
    case "item.started":
    case "item.completed": {
      const item = asRecord(l.item);
      const id = str(item.id);
      const itype = str(item.type);
      if (!id || !itype) return [];
      const started = type === "item.started";
      if (itype === "command_execution") {
        if (started) return [ev("command.started", { commandId: id, argvDisplay: str(item.command) ?? "(command)" }, id)];
        return [ev("command.completed", { commandId: id, exitCode: num(item.exit_code) ?? (item.status === "failed" ? 1 : 0) }, id)];
      }
      if (itype === "file_change" && !started) {
        const out: AgentEventInput[] = [];
        for (const c of Array.isArray(item.changes) ? item.changes : []) {
          const r = asRecord(c);
          const path = str(r.path);
          if (path) out.push(ev(r.kind === "delete" ? "file.delete" : "file.write", { path, toolName: "file_change", toolUseId: id }, id));
        }
        return out;
      }
      return [];
    }
    default:
      return [];
  }
}
