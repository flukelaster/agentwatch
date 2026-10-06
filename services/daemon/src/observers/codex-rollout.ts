import { basename, sep } from "node:path";
import type { ContextSnapshot } from "./transcript";

/**
 * Reads Codex's own session file (`rollout-*.jsonl`) for how full the context window is. Counts only: no text is kept.
 *
 * Codex writes a `token_count` event after every model request. It carries the window size Codex itself uses
 * (`model_context_window`), the tokens of that request (`last_token_usage`) and the running totals of the session
 * (`total_token_usage`), so unlike Claude Code nothing has to be guessed. What the window is made of is still an
 * ESTIMATE, worked out the same way as for Claude Code: the first request is the "setup" (instructions, tools,
 * AGENTS.md), and what was added since is split between conversation and tool traffic by how much text each wrote.
 *
 * These files get big (tens of MB, single lines of several MB for a screenshot), so a line is parsed only when it is a
 * `token_count`; every other line is classified from its first few hundred characters and counted by length.
 */

/** A rollout is `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`. CODEX_HOME is wherever the launcher put it (Orca uses one per account). */
export function isCodexRollout(realPath: string): boolean {
  return /^rollout-.+\.jsonl$/.test(basename(realPath)) && realPath.includes(`${sep}sessions${sep}`);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** One line's share of the text counts is capped: a pasted screenshot is a few thousand tokens, not millions of characters. */
const MAX_CHARS_PER_LINE = 100_000;

const TOOL_ITEMS = new Set(["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "local_shell_call", "local_shell_call_output", "web_search_call", "tool_search_call", "tool_search_output"]);
const HEAD = /"type":"([a-z_]+)","payload":\{(?:"type":"([a-z_]+)")?/;

export class CodexContextTracker {
  private baseline: number | undefined;
  private lastPrompt = 0;
  private lastOutput = 0;
  private window = 0;
  private seen = false;
  private chars = { conversation: 0, tools: 0 };
  private total = { input: 0, cached: 0, output: 0 };

  /** One line of the file. Returns true when the numbers changed. */
  feedLine(line: string): boolean {
    const m = HEAD.exec(line.length > 400 ? line.slice(0, 400) : line);
    if (!m) return false;
    const outer = m[1];
    const inner = m[2];
    if (outer === "compacted" || (outer === "event_msg" && inner === "context_compacted")) {
      // the history was replaced by a summary: the next request starts the count again
      this.baseline = undefined;
      this.chars = { conversation: 0, tools: 0 };
      return false;
    }
    if (outer === "response_item") {
      const n = Math.min(line.length, MAX_CHARS_PER_LINE);
      if (inner && TOOL_ITEMS.has(inner)) this.chars.tools += n;
      else if (inner === "message" || inner === "reasoning") this.chars.conversation += n;
      return false;
    }
    if (outer !== "event_msg" || inner !== "token_count") return false;
    let info: Record<string, unknown> | undefined;
    try {
      const o = JSON.parse(line) as { payload?: { info?: unknown } };
      info = o.payload?.info && typeof o.payload.info === "object" ? (o.payload.info as Record<string, unknown>) : undefined;
    } catch {
      return false;
    }
    const last = info?.last_token_usage as Record<string, unknown> | undefined;
    if (!info || !last || typeof last !== "object") return false; // a rate-limit update carries no usage
    const prompt = num(last.input_tokens);
    if (this.baseline === undefined) {
      this.baseline = prompt; // everything written before this reply is in the prompt already
      this.chars = { conversation: 0, tools: 0 };
    }
    this.lastPrompt = prompt;
    this.lastOutput = num(last.output_tokens);
    const w = num(info.model_context_window);
    if (w > 0) this.window = w;
    const t = info.total_token_usage as Record<string, unknown> | undefined;
    if (t && typeof t === "object") this.total = { input: num(t.input_tokens), cached: num(t.cached_input_tokens), output: num(t.output_tokens) };
    this.seen = true;
    return true;
  }

  /** Session totals, in the same terms as Claude Code's: fresh input apart from what was served from the cache. */
  totals(): { inputTokens: number; outputTokens: number; cachedInputTokens: number } {
    return { inputTokens: Math.max(0, this.total.input - this.total.cached), outputTokens: this.total.output, cachedInputTokens: this.total.cached };
  }

  snapshot(): ContextSnapshot | undefined {
    if (!this.seen || this.baseline === undefined) return undefined;
    const used = this.lastPrompt + this.lastOutput;
    const setup = Math.min(this.baseline, used);
    const rest = used - setup;
    const text = this.chars.conversation + this.chars.tools;
    const conversation = text === 0 ? rest : Math.round((rest * this.chars.conversation) / text);
    return {
      used,
      // Codex states its window; only a file that never did leaves it to be worked out from the size
      window: this.window > 0 ? this.window : Math.max(100_000, Math.ceil(used / 100_000) * 100_000),
      windowAuto: this.window <= 0,
      setup,
      conversation,
      tools: rest - conversation,
    };
  }
}
