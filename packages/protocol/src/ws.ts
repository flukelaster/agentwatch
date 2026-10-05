import { z } from "zod";
import type { AgentEvent, AgentProvider } from "./events";

export const PROTOCOL_VERSION = 1 as const;

// ---- read models streamed to the UI ----

export type SessionStatus = "running" | "waiting" | "idle" | "finished" | "failed";
export type AgentStatus = "running" | "waiting" | "idle" | "done" | "failed";

export interface UsageView {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  scope: string;
  providerReported: boolean;
  /** How full the context window is. The split is an estimate; the total is the provider's own count. */
  context?: ContextView;
}

export interface ContextView {
  /** Tokens in the window now: the last request's prompt plus its reply. */
  used: number;
  window: number;
  /** True when the window size was worked out from the largest context seen rather than chosen in Settings. */
  windowAuto: boolean;
  /** System prompt, tools and memory: what the session started with. */
  setup: number;
  /** What was said since: your prompts and the assistant's replies. */
  conversation: number;
  /** Tool calls and what they returned. */
  tools: number;
  /**
   * Claude Code's own breakdown, from the last `/context` run in the session (grown by what was added since).
   * Absent until `/context` has been run; then `window` is the real size too.
   */
  categories?: ContextCategory[];
  reported?: boolean;
  /** Tokens Claude Code keeps free for auto-compaction (only known from `/context`). */
  buffer?: number;
}

export interface ContextCategory {
  name: string;
  tokens: number;
}

export interface SessionView {
  id: string;
  /** The conversation title the provider gave this session. Only known while message storage is on; never persisted. */
  title?: string;
  provider: AgentProvider;
  providerSessionId?: string;
  executable?: string;
  model?: string;
  cwd?: string;
  repoRoot?: string;
  branch?: string;
  status: SessionStatus;
  /** Short human text for the current action, e.g. "editing src/auth/session.ts". */
  activity?: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  lastEventAt: string;
  counts: { tools: number; files: number; commands: number; failedCommands: number; events: number };
  diff: { additions: number; deletions: number };
  usage?: UsageView;
  /** Sources that have contributed evidence for this session (claude-hook, process, ...). */
  sources: string[];
}

export interface AgentView {
  id: string;
  sessionId: string;
  parentAgentId?: string;
  providerAgentId?: string;
  role?: string;
  displayName?: string;
  model?: string;
  status: AgentStatus;
  startedAt: string;
  endedAt?: string;
  toolCount: number;
  lastAction?: string;
  lastEventAt: string;
  failureNote?: string;
}

export interface RequestView {
  id: string;
  sessionId: string;
  agentId?: string;
  providerRequestId?: string;
  kind: string;
  status: "pending" | "resolved";
  /** The tool the request is for (Claude's PermissionRequest hook carries no tool-use id, so this is how the result finds it). */
  toolName?: string;
  summary?: string;
  createdAt: string;
  resolvedAt?: string;
  source: string;
}

export interface FileActivityRow {
  id: string;
  sessionId: string;
  agentId?: string;
  path: string;
  operation: string;
  occurredAt: string;
  additions?: number;
  deletions?: number;
  source: string;
  confidence: string;
}

export interface CommandRow {
  id: string;
  sessionId: string;
  agentId?: string;
  argvDisplay: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string;
  source: string;
  confidence: string;
  redacted: boolean;
}

export interface Settings {
  retentionDays: number; // 0 = session only
  /** Off by default. When on, the prompts you type are read from the provider's conversation file and kept locally. */
  storePromptText: boolean;
  /** Off by default. When on, the assistant's replies are read from the conversation file and kept locally. */
  storeAssistantText: boolean;
  /** On by default. Reads only the token counts from the provider's conversation file; no text is read into storage. */
  trackTokenUsage: boolean;
  /** Context window size in tokens, or 0 to work it out from the largest context seen. */
  contextWindow: number;
  keepRawTranscript: false;
  keepFullPatches: false;
  redactCredentials: true;
  startAtLogin: boolean;
  claudeIntegration: boolean;
  codexIntegration: boolean;
  geminiIntegration: boolean;
  antigravityIntegration: boolean;
  cursorIntegration: boolean;
  cliInstalled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  retentionDays: 14,
  storePromptText: false,
  storeAssistantText: false,
  trackTokenUsage: true,
  contextWindow: 0,
  keepRawTranscript: false,
  keepFullPatches: false,
  redactCredentials: true,
  startAtLogin: false,
  claudeIntegration: false,
  codexIntegration: false,
  geminiIntegration: false,
  antigravityIntegration: false,
  cursorIntegration: false,
  cliInstalled: false,
};

// ---- client -> daemon ----

export const QUERY_NAMES = ["sessions", "agents", "events", "files", "commands", "logs", "settings", "status", "setupStatus"] as const;
export type QueryName = (typeof QUERY_NAMES)[number];

export const COMMAND_NAMES = ["deleteSession", "deleteAllHistory", "setSettings", "setupApply", "setupRevert"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export const ClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocol: z.literal(PROTOCOL_VERSION), token: z.string().min(8).max(200) }),
  z.object({
    type: z.literal("subscribe"),
    sessionIds: z.array(z.string().max(200)).max(200),
    /** Replay events with sequence greater than this before going live. */
    afterSequence: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("unsubscribe") }),
  z.object({
    type: z.literal("query"),
    id: z.string().max(80),
    name: z.enum(QUERY_NAMES),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("command"),
    id: z.string().max(80),
    name: z.enum(COMMAND_NAMES),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// ---- daemon -> client ----

export interface SnapshotFrame {
  type: "snapshot";
  sessions: SessionView[];
  agents: AgentView[];
  pendingRequests: RequestView[];
  lastSequence: number;
}

export type ServerFrame =
  | { type: "ready"; protocol: typeof PROTOCOL_VERSION; serverTime: string; version: string }
  | { type: "error"; code: string; message: string; id?: string }
  | SnapshotFrame
  | { type: "event"; event: AgentEvent }
  | { type: "session"; session: SessionView }
  | { type: "agent"; agent: AgentView }
  | { type: "request"; request: RequestView }
  | { type: "removed"; sessionId: string }
  | { type: "wiped" }
  | { type: "result"; id: string; data: unknown }
  | { type: "pong" };

// ---- local ingestion channel (Unix domain socket, newline-delimited JSON) ----

export const IngestFrameSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("event"), event: z.unknown() }),
  z.object({ op: z.literal("mint") }),
  z.object({ op: z.literal("status") }),
  /** Keep the connection open and receive a summary line whenever the counts change (the tray uses this). */
  z.object({ op: z.literal("watch") }),
]);

export interface TraySummary {
  running: number;
  waiting: number;
  failed: number;
}
export type IngestFrame = z.infer<typeof IngestFrameSchema>;

export interface MintResponse {
  token: string;
  expiresAt: string;
  port: number;
  host: "127.0.0.1";
}
