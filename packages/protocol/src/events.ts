import { z } from "zod";

/** Frozen contract: AgentEvent v1. Additive changes only; anything else bumps SCHEMA_VERSION. */
export const SCHEMA_VERSION = 1 as const;

export const PROVIDERS = ["claude-code", "codex", "gemini-cli", "antigravity", "cursor", "generic"] as const;
export type AgentProvider = (typeof PROVIDERS)[number];

export const EVENT_SOURCES = [
  "claude-hook",
  "codex-hook",
  "codex-app-server",
  "gemini-hook",
  "antigravity-hook",
  "cursor-hook",
  "pty",
  "filesystem",
  "git",
  "process",
  /** The provider's own conversation file, read only while the person has turned message storage on. */
  "transcript",
] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const EVENT_KINDS = [
  "session.started",
  "session.ended",
  "agent.started",
  "agent.ended",
  "status.changed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "file.read",
  "file.write",
  "file.delete",
  "command.started",
  "command.output",
  "command.completed",
  "approval.requested",
  "approval.resolved",
  "usage.updated",
  "git.changed",
  "log",
  /** One chat message (prompt or response). Only exists while the matching setting is on. */
  "message",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * Evidence ranking from the plan: provider hook / API is HIGH, process tree is MEDIUM,
 * filesystem / Git / terminal text is LOW. Adapters must not claim more than their source supports.
 */
export const MAX_CONFIDENCE_BY_SOURCE: Record<EventSource, Confidence> = {
  "claude-hook": "high",
  "codex-hook": "high",
  "codex-app-server": "high",
  "gemini-hook": "high",
  "antigravity-hook": "high",
  "cursor-hook": "high",
  process: "medium",
  pty: "low",
  filesystem: "low",
  git: "low",
  transcript: "high",
};

/** Sources that are an agent's own report of what it is doing (as opposed to something AgentWatch observed from outside). */
export const PROVIDER_SOURCES: ReadonlySet<string> = new Set(["claude-hook", "codex-hook", "codex-app-server", "gemini-hook", "antigravity-hook", "cursor-hook"]);
export const isProviderSource = (source: string): boolean => PROVIDER_SOURCES.has(source);

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function clampConfidence(source: EventSource, wanted: Confidence): Confidence {
  const cap = MAX_CONFIDENCE_BY_SOURCE[source];
  return RANK[wanted] > RANK[cap] ? cap : wanted;
}

/** Event as produced by an adapter or observer, before the daemon assigns identity. */
export interface AgentEventInput<TPayload = Record<string, unknown>> {
  provider: AgentProvider;
  /** The provider's own session id (Claude `session_id`, Codex thread id, wrapper id for generic). */
  providerSessionId: string;
  /** Present for subagent events; absent means the main agent. */
  providerAgentId?: string;
  parentProviderAgentId?: string;
  /** Set when the process runs under `agentwatch run`; attaches the provider session to the wrapper session. */
  wrapperSessionId?: string;
  kind: EventKind;
  occurredAt?: string;
  cwd?: string;
  correlationId?: string;
  source: EventSource;
  confidence: Confidence;
  payload: TPayload;
}

/** The persisted and streamed event. */
export interface AgentEvent<TPayload = Record<string, unknown>> {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  /** Daemon-wide monotonic order. The canonical replay order. */
  sequence: number;
  sessionId: string;
  agentId: string;
  parentAgentId?: string;
  provider: AgentProvider;
  kind: EventKind;
  occurredAt: string;
  receivedAt: string;
  cwd?: string;
  correlationId?: string;
  source: EventSource;
  confidence: Confidence;
  redacted: boolean;
  payload: TPayload;
}

// ---- payloads (documentation + typing; runtime shape is enforced by privacy.ts allow-lists) ----

export interface SessionStartedPayload {
  cwd?: string;
  model?: string;
  executable?: string;
  repoRoot?: string;
  branch?: string;
  startSource?: string;
}
export interface SessionEndedPayload {
  reason?: string;
  exitCode?: number | null;
}
export interface AgentStartedPayload {
  agentType?: string;
  displayName?: string;
  model?: string;
}
export interface AgentEndedPayload {
  agentType?: string;
  outcome?: "done" | "failed";
}
export interface StatusChangedPayload {
  status: string;
  label?: string;
  model?: string;
}
export interface ToolPayload {
  toolName: string;
  toolUseId?: string;
  /** A path or a short descriptor. Never file contents, never a prompt. */
  target?: string;
  durationMs?: number;
  error?: string;
  isInterrupt?: boolean;
}
export interface FilePayload {
  path: string;
  toolName?: string;
  toolUseId?: string;
  additions?: number;
  deletions?: number;
}
export interface CommandStartedPayload {
  commandId: string;
  executable?: string;
  argvDisplay: string;
  pid?: number;
  ppid?: number;
  toolUseId?: string;
}
export interface CommandCompletedPayload {
  commandId: string;
  exitCode: number | null;
  signal?: string;
  durationMs?: number;
}
export interface ApprovalRequestedPayload {
  requestId: string;
  kind: "command" | "file_change" | "permission" | "other";
  summary: string;
  toolName?: string;
}
export interface ApprovalResolvedPayload {
  requestId: string;
  decision?: "allow" | "deny" | "unknown";
}
export interface UsagePayload {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  providerReported: boolean;
  scope: "turn" | "thread" | "session" | "account";
}
export interface GitChangedPayload {
  dirtyAtStart?: number;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  baseline?: boolean;
}
export interface LogPayload {
  message: string;
  level?: "info" | "warn" | "error";
}

// ---- runtime validation of what adapters hand the daemon ----

export const AgentEventInputSchema = z.object({
  provider: z.enum(PROVIDERS),
  providerSessionId: z.string().min(1).max(200),
  providerAgentId: z.string().min(1).max(200).optional(),
  parentProviderAgentId: z.string().min(1).max(200).optional(),
  wrapperSessionId: z.string().min(1).max(200).optional(),
  kind: z.enum(EVENT_KINDS),
  occurredAt: z.string().max(40).optional(),
  cwd: z.string().max(1024).optional(),
  correlationId: z.string().max(200).optional(),
  source: z.enum(EVENT_SOURCES),
  confidence: z.enum(CONFIDENCES),
  payload: z.record(z.string(), z.unknown()),
});

export function parseEventInput(value: unknown): AgentEventInput {
  return AgentEventInputSchema.parse(value) as AgentEventInput;
}
