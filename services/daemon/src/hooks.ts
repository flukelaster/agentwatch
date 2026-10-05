import { mapAntigravityHook } from "@agentwatch/adapter-antigravity";
import { mapClaudeHook } from "@agentwatch/adapter-claude-code";
import { mapCodexHook } from "@agentwatch/adapter-codex";
import { mapCursorHook } from "@agentwatch/adapter-cursor";
import { mapGeminiHook } from "@agentwatch/adapter-gemini-cli";
import type { AgentProvider } from "@agentwatch/protocol";
import type { SessionManager } from "./session-manager";

/**
 * Raw hook payloads arrive here. They can contain prompts and file contents, so they live only in this
 * function's scope: the adapter reduces them to metadata, then apply() runs the allow-list and redaction
 * before anything is stored or streamed. Nothing here logs or retains the payload.
 */
/** The name in /hook/<name> (and in the hooks files) → the provider's id and its payload mapper. */
export const HOOK_PROVIDERS = {
  claude: { provider: "claude-code", map: mapClaudeHook },
  codex: { provider: "codex", map: mapCodexHook },
  gemini: { provider: "gemini-cli", map: mapGeminiHook },
  antigravity: { provider: "antigravity", map: mapAntigravityHook },
  cursor: { provider: "cursor", map: mapCursorHook },
} as const satisfies Record<string, { provider: AgentProvider; map: typeof mapClaudeHook }>;
export type HookProviderName = keyof typeof HOOK_PROVIDERS;
export const isHookProvider = (name: string): name is HookProviderName => Object.hasOwn(HOOK_PROVIDERS, name);

export function ingestHook(manager: SessionManager, provider: HookProviderName, payload: unknown, wrapperSessionId?: string): number {
  const ctx = wrapperSessionId ? { wrapperSessionId } : {};
  const events = HOOK_PROVIDERS[provider].map(payload, ctx);
  let n = 0;
  try {
    for (const e of events) {
      if (manager.apply(e)) n += 1;
    }
  } finally {
    // Only the location of the conversation file is kept (memory only), so it can be read if the person turns chat on.
    // Even when one event could not be stored, the chat of that session must still find its file.
    const raw = payload as { session_id?: unknown; transcript_path?: unknown } | null;
    if (raw && typeof raw.session_id === "string" && typeof raw.transcript_path === "string") {
      manager.noteTranscript(HOOK_PROVIDERS[provider].provider, raw.session_id, raw.transcript_path);
    }
  }
  return n;
}
