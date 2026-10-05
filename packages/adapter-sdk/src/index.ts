import type {
  AgentEventInput,
  AgentProvider,
  Confidence,
  EventKind,
  EventSource,
} from "@agentwatch/protocol";
import { clampConfidence } from "@agentwatch/protocol";

/** How much an adapter can know for a given signal. "none" means: say nothing rather than guess. */
export type CapabilityLevel = "high" | "partial" | "low" | "none";

export interface AdapterCapabilities {
  provider: AgentProvider;
  sessionLifecycle: CapabilityLevel;
  toolCalls: CapabilityLevel;
  fileReads: CapabilityLevel;
  fileWrites: CapabilityLevel;
  commands: CapabilityLevel;
  subagents: CapabilityLevel;
  approvals: CapabilityLevel;
  tokenUsage: CapabilityLevel;
}

export interface AdapterContext {
  /** Set when running under `agentwatch run`, so provider events join the wrapper's session. */
  wrapperSessionId?: string;
  now?: () => Date;
}

/** A stateless mapper from one provider hook payload to zero or more normalized events. */
export interface HookAdapter {
  readonly provider: AgentProvider;
  readonly capabilities: AdapterCapabilities;
  mapHook(raw: unknown, ctx?: AdapterContext): AgentEventInput[];
}

export interface EventDraft {
  provider: AgentProvider;
  providerSessionId: string;
  providerAgentId?: string;
  parentProviderAgentId?: string;
  wrapperSessionId?: string;
  kind: EventKind;
  source: EventSource;
  confidence?: Confidence;
  cwd?: string;
  correlationId?: string;
  payload: Record<string, unknown>;
}

export function makeEvent(draft: EventDraft, ctx: AdapterContext = {}): AgentEventInput {
  const now = ctx.now ? ctx.now() : new Date();
  const event: AgentEventInput = {
    provider: draft.provider,
    providerSessionId: draft.providerSessionId,
    kind: draft.kind,
    source: draft.source,
    confidence: clampConfidence(draft.source, draft.confidence ?? "high"),
    occurredAt: now.toISOString(),
    payload: draft.payload,
  };
  if (draft.providerAgentId) event.providerAgentId = draft.providerAgentId;
  if (draft.parentProviderAgentId) event.parentProviderAgentId = draft.parentProviderAgentId;
  const wrapper = draft.wrapperSessionId ?? ctx.wrapperSessionId;
  if (wrapper) event.wrapperSessionId = wrapper;
  if (draft.cwd) event.cwd = draft.cwd;
  if (draft.correlationId) event.correlationId = draft.correlationId;
  return event;
}

// ---- small helpers shared by adapters; they only ever return metadata, never contents ----

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Number of lines in a block of text. Used to turn edit contents into +/- counts without keeping them. */
export function countLines(text: unknown): number {
  if (typeof text !== "string" || text.length === 0) return 0;
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed.length === 0 ? 1 : trimmed.split("\n").length;
}

/** First path-like field of a tool input, by the names providers use. */
export function pathOf(input: Record<string, unknown>): string | undefined {
  return str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? str(input.filePath);
}
