import type { AgentEventInput, EventKind } from "./events";
import { clampConfidence } from "./events";
import { redactText } from "./redact";

/**
 * Privacy model, enforced in code:
 *  - Every payload is reduced to a per-kind allow-list. Unknown keys are dropped, not stored.
 *  - A set of keys that can carry prompts, assistant text, file contents, patches, transcripts or
 *    environment variables is dropped even if some adapter adds it to an allow-listed kind.
 *  - Free-text fields are length-capped and run through credential redaction.
 */

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "user_prompt",
  "userPrompt",
  "message_text",
  "last_assistant_message",
  "assistant_message",
  "response",
  "tool_response",
  "toolResponse",
  "tool_input",
  "toolInput",
  "content",
  "contents",
  "new_string",
  "old_string",
  "newString",
  "oldString",
  "patch",
  "diff",
  "unified_diff",
  "transcript",
  "transcript_path",
  "env",
  "environment",
  "stdout",
  "stderr",
  "output",
  "text",
  "file_text",
]);

type FieldKind = "string" | "path" | "text" | "block" | "number" | "boolean" | "enum";
interface FieldSpec {
  type: FieldKind;
  max?: number;
  values?: readonly string[];
}

const S = (max = 200): FieldSpec => ({ type: "string", max });
const P: FieldSpec = { type: "path", max: 1024 };
const T = (max = 500): FieldSpec => ({ type: "text", max });
/** Multi-line text (chat messages): credentials are redacted and the length is capped, line breaks are kept. */
const X = (max = 6000): FieldSpec => ({ type: "block", max });
const N: FieldSpec = { type: "number" };
const B: FieldSpec = { type: "boolean" };
const E = (...values: string[]): FieldSpec => ({ type: "enum", values });

const FILE_FIELDS = { path: P, toolName: S(80), toolUseId: S(120), additions: N, deletions: N };
const TOOL_FIELDS = {
  toolName: S(80),
  toolUseId: S(120),
  target: P,
  durationMs: N,
  error: T(300),
  isInterrupt: B,
  /** The short label the model gave a subagent task ("Repair account-switch claims"), never the task's prompt. */
  taskLabel: T(80),
  subagentType: S(60),
};

export const PAYLOAD_ALLOW_LIST: Record<EventKind, Record<string, FieldSpec>> = {
  "session.started": {
    cwd: P,
    model: S(120),
    executable: P,
    repoRoot: P,
    branch: S(200),
    startSource: S(60),
    pid: N,
  },
  "session.ended": { reason: S(80), exitCode: N },
  "agent.started": { agentType: S(80), displayName: S(120), model: S(120) },
  "agent.ended": { agentType: S(80), outcome: E("done", "failed") },
  "status.changed": { status: S(60), label: S(160), model: S(120) },
  "tool.started": TOOL_FIELDS,
  "tool.completed": TOOL_FIELDS,
  "tool.failed": TOOL_FIELDS,
  "file.read": FILE_FIELDS,
  "file.write": FILE_FIELDS,
  "file.delete": FILE_FIELDS,
  "command.started": {
    commandId: S(120),
    executable: P,
    argvDisplay: T(500),
    pid: N,
    ppid: N,
    toolUseId: S(120),
  },
  "command.output": { commandId: S(120), bytes: N },
  "command.completed": { commandId: S(120), exitCode: N, signal: S(40), durationMs: N },
  "approval.requested": {
    requestId: S(120),
    kind: E("command", "file_change", "permission", "other"),
    summary: T(300),
    toolName: S(80),
  },
  "approval.resolved": { requestId: S(120), decision: E("allow", "deny", "unknown") },
  "usage.updated": {
    model: S(120),
    inputTokens: N,
    outputTokens: N,
    cachedInputTokens: N,
    reasoningTokens: N,
    providerReported: B,
    scope: E("turn", "thread", "session", "account"),
    contextUsed: N,
    contextWindow: N,
    contextAuto: B,
    contextSetup: N,
    contextConversation: N,
    contextTools: N,
    /** JSON: [{name, tokens}, ...] from `/context`. */
    contextCategories: S(2400),
    contextReported: B,
    contextBuffer: N,
  },
  "message": { role: E("user", "assistant"), body: X(6000) },
  "git.changed": { dirtyAtStart: N, changedFiles: N, additions: N, deletions: N, baseline: B },
  log: { message: T(300), level: E("info", "warn", "error") },
};

export interface SanitizeResult {
  payload: Record<string, unknown>;
  redacted: boolean;
  dropped: string[];
}

function cap(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function sanitizePayload(kind: EventKind, input: Record<string, unknown>): SanitizeResult {
  const spec = PAYLOAD_ALLOW_LIST[kind];
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  let redacted = false;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (FORBIDDEN_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    const field = spec[key];
    if (!field) {
      dropped.push(key);
      continue;
    }
    switch (field.type) {
      case "number":
        if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
        else dropped.push(key);
        break;
      case "boolean":
        if (typeof value === "boolean") out[key] = value;
        else dropped.push(key);
        break;
      case "enum":
        if (typeof value === "string" && field.values?.includes(value)) out[key] = value;
        else dropped.push(key);
        break;
      case "path":
      case "string": {
        if (typeof value !== "string") {
          dropped.push(key);
          break;
        }
        const r = redactText(value);
        if (r.redacted) redacted = true;
        out[key] = cap(r.text, field.max ?? 200);
        break;
      }
      case "block": {
        if (typeof value !== "string") {
          dropped.push(key);
          break;
        }
        const r = redactText(value);
        if (r.redacted) redacted = true;
        out[key] = cap(r.text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim(), field.max ?? 6000);
        break;
      }
      case "text": {
        if (typeof value !== "string") {
          dropped.push(key);
          break;
        }
        const r = redactText(value);
        if (r.redacted) redacted = true;
        out[key] = cap(r.text.replace(/\s+/g, " ").trim(), field.max ?? 500);
        break;
      }
    }
  }
  return { payload: out, redacted, dropped };
}

/** Sanitizes a whole input event: payload allow-list, confidence ceiling by source. */
export function sanitizeInput(input: AgentEventInput): { event: AgentEventInput; redacted: boolean } {
  const { payload, redacted } = sanitizePayload(input.kind, input.payload);
  return {
    event: {
      ...input,
      confidence: clampConfidence(input.source, input.confidence),
      payload,
    },
    redacted,
  };
}

/** Test/guard helper: true when no forbidden key appears anywhere in a JSON-like value. */
export function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k) || containsForbiddenKey(v)) return true;
    }
  }
  return false;
}
