import { mapAntigravityHook } from "@agentwatch/adapter-antigravity";
import { mapClaudeHook } from "@agentwatch/adapter-claude-code";
import { mapCodexHook } from "@agentwatch/adapter-codex";
import { mapCursorHook } from "@agentwatch/adapter-cursor";
import { mapGeminiHook } from "@agentwatch/adapter-gemini-cli";
import { sanitizeInput, type AgentEventInput } from "@agentwatch/protocol";
import { sendEvents } from "./ipc";
import { socketPath } from "./home";

export type HookProvider = "claude" | "codex" | "gemini" | "antigravity" | "cursor";
const MAPPERS = { claude: mapClaudeHook, codex: mapCodexHook, gemini: mapGeminiHook, antigravity: mapAntigravityHook, cursor: mapCursorHook } as const;

const MAX_STDIN = 2 * 1024 * 1024;

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  let data = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    data += chunk as string;
    if (data.length > MAX_STDIN) break;
  }
  return data;
}

/** Map one hook payload to sanitized events. Pure: the privacy boundary is crossed here, before any IO. */
export function eventsForHook(provider: HookProvider, raw: string, env: NodeJS.ProcessEnv = process.env): AgentEventInput[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const ctx = env.AGENTWATCH_SESSION_ID ? { wrapperSessionId: env.AGENTWATCH_SESSION_ID } : {};
  const mapped = MAPPERS[provider](payload, ctx);
  return mapped.map((e) => sanitizeInput(e).event);
}

/**
 * Observer hook: reads the payload, forwards normalized events, prints nothing, and always exits 0 so
 * it can never block or slow the agent. If the daemon is not running the event is dropped.
 */
export async function runHook(provider: HookProvider, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const raw = await readStdin();
    const events = eventsForHook(provider, raw, env);
    if (events.length) await sendEvents(events, { socket: socketPath(env), timeoutMs: 900 });
  } catch {
    /* an observer must never disturb the agent */
  }
}
