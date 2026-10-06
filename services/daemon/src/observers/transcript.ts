import { closeSync, openSync, readSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import type { SessionView } from "@agentwatch/protocol";
import type { Diagnostics } from "../diagnostics";
import { CodexContextTracker, isCodexRollout } from "./codex-rollout";
import type { SessionManager } from "../session-manager";

/**
 * Reads Claude Code's own conversation file so the chat can be shown. This is the only place AgentWatch reads
 * message text, and it only runs while the person has turned on "Store prompt text" or "Store assistant
 * responses" in Settings. The manager independently refuses any message of a kind that is switched off.
 */

export type ParsedLine = { kind: "message"; role: "user" | "assistant"; body: string; uuid?: string; at?: string } | { kind: "title"; title: string };

// Text Claude Code injects around what a person actually typed (instructions, command echoes, hook output).
const WRAPPERS = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|user-prompt-submit-hook|ide_opened_file|ide_selection)\b[^>]*>[\s\S]*?<\/\1>/g;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n\n");
};

const lineObject = (line: string): Record<string, unknown> | undefined => {
  try {
    const o = JSON.parse(line) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** A prompt, a reply or a title from one line. Returns nothing for everything that is not one of those. */
export function parseTranscriptObject(o: Record<string, unknown>): ParsedLine | undefined {
  if (o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) return { kind: "title", title: o.aiTitle.trim() };
  if (o.type !== "user" && o.type !== "assistant") return undefined;
  if (o.isSidechain === true || o.isMeta === true || o.isCompactSummary === true || o.isApiErrorMessage === true) return undefined;
  const m = o.message as { content?: unknown } | undefined;
  const body = textOf(m?.content).replace(WRAPPERS, "").trim();
  if (!body) return undefined;
  const out: ParsedLine = { kind: "message", role: o.type, body };
  if (typeof o.uuid === "string") out.uuid = o.uuid;
  if (typeof o.timestamp === "string") out.at = o.timestamp;
  return out;
}

const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/;
const REJECTED = /^The user doesn't want to proceed with this tool use/;

/**
 * The person pressed Esc, or said no, at a permission prompt (or interrupted the turn). Claude Code runs no hook for any
 * of these, so the conversation file is the only place that says so: a fixed phrase, never anyone's text.
 * Returns when it happened. Lines from subagents are theirs, not the main prompt's.
 */
export function interruptionOf(o: Record<string, unknown>): string | undefined {
  if (o.type !== "user" || o.isSidechain === true || typeof o.timestamp !== "string") return undefined;
  const content = (o.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const b of content as Array<Record<string, unknown>>) {
    if (b.type === "text" && typeof b.text === "string" && INTERRUPTED.test(b.text.trim())) return o.timestamp;
    if (b.type === "tool_result" && b.is_error === true && typeof b.content === "string" && REJECTED.test(b.content)) return o.timestamp;
  }
  return undefined;
}

export function parseTranscriptLine(line: string): ParsedLine | undefined {
  const o = lineObject(line);
  return o ? parseTranscriptObject(o) : undefined;
}

/** Token counts of one assistant reply. Counts only: nothing of the text is read. */
export interface UsageLine {
  id: string;
  /** Tokens sent fresh to the model (not read from the cache). */
  input: number;
  output: number;
  /** Tokens served from the prompt cache. */
  cacheRead: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function usageOfObject(o: Record<string, unknown>): UsageLine | undefined {
  if (o.type !== "assistant") return undefined;
  const m = o.message as { id?: unknown; usage?: Record<string, unknown>; model?: unknown } | undefined;
  const u = m?.usage;
  if (!u || typeof u !== "object" || typeof m?.id !== "string" || m.model === "<synthetic>") return undefined;
  return { id: m.id, input: num(u.input_tokens) + num(u.cache_creation_input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens) };
}

export function usageOfLine(line: string): UsageLine | undefined {
  const o = lineObject(line);
  return o ? usageOfObject(o) : undefined;
}

/**
 * Totals over a conversation. A reply is written as several lines that carry the same usage, so each reply counts
 * once: the last line for its id wins.
 */
export function totalUsage(byReply: ReadonlyMap<string, UsageLine>): { inputTokens: number; outputTokens: number; cachedInputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  for (const u of byReply.values()) {
    inputTokens += u.input;
    outputTokens += u.output;
    cachedInputTokens += u.cacheRead;
  }
  return { inputTokens, outputTokens, cachedInputTokens };
}

const STANDARD_WINDOWS = [200_000, 1_000_000, 2_000_000];

/** "839.4k" -> 839400, "1m" -> 1000000, "729" -> 729. */
export function parseTokenCount(text: string): number | undefined {
  const m = /^\s*([\d.]+)\s*([kmb])?\s*$/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * ({ k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[(m[2] ?? "").toLowerCase()]! || n);
}

export interface ContextReport {
  used: number;
  window: number;
  categories: Array<{ name: string; tokens: number }>;
}

/**
 * Claude Code's own `/context` output, as saved in the conversation file. Only the numbers are read. Returns
 * nothing for any text that is not a context report.
 */
export function parseContextReport(text: string): ContextReport | undefined {
  if (!text.includes("Context Usage")) return undefined;
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "");
  const total = /([\d.]+\s*[kmb]?)\s*\/\s*([\d.]+\s*[kmb]?)\s*(?:tokens\s*)?\(\d+%\)/i.exec(clean);
  if (!total) return undefined;
  const used = parseTokenCount(total[1]!);
  const window = parseTokenCount(total[2]!);
  if (used === undefined || window === undefined || window <= 0) return undefined;
  const cats: Array<{ name: string; tokens: number }> = [];
  // the table the assistant is shown has every category; the terminal view has the loaded ones
  for (const row of clean.matchAll(/^\|\s*([A-Za-z][^|]*?)\s*\|\s*([\d.]+\s*[kmb]?)\s*\|\s*[\d.]+%\s*\|\s*$/gim)) {
    const tokens = parseTokenCount(row[2]!);
    if (tokens !== undefined && row[1] !== "Category") cats.push({ name: row[1]!, tokens });
  }
  if (!cats.length) {
    for (const row of clean.matchAll(/([A-Z][A-Za-z ]*[A-Za-z]):\s*([\d.]+\s*[kmb]?)\s*(?:tokens\s*)?\([\d.]+%\)/g)) {
      const tokens = parseTokenCount(row[2]!);
      if (tokens !== undefined) cats.push({ name: row[1]!, tokens });
    }
  }
  return cats.length ? { used, window, categories: cats } : undefined;
}

/** Models whose window is known to be larger than the smallest usual one. The conversation file names the model but never the window. */
const MODEL_WINDOWS: ReadonlyArray<readonly [prefix: string, window: number]> = [["claude-sonnet-5-5", 1_000_000]];

/**
 * A context this close to a window's size cannot really be in that window: Claude Code compacts at about 84%
 * of it, so a session sitting at 100% of "200k" is in a bigger window than that.
 */
const FILL_LIMIT = 0.9;

/**
 * The window to assume when nothing tells us: at least what the model is known to have, otherwise the smallest
 * usual window the context fits in with room to spare. The provider never says how big the window is.
 */
/** The smallest usual window that holds `tokens`. */
export const windowHolding = (tokens: number): number => STANDARD_WINDOWS.find((w) => tokens <= w) ?? Math.ceil(tokens / 1_000_000) * 1_000_000;

export function autoWindow(seen: number, model?: string): number {
  const floor = (model && MODEL_WINDOWS.find(([prefix]) => model.startsWith(prefix))?.[1]) || 0;
  return STANDARD_WINDOWS.find((w) => w >= floor && seen <= w * FILL_LIMIT) ?? Math.ceil(seen / (1_000_000 * FILL_LIMIT)) * 1_000_000;
}

export interface ContextSnapshot {
  used: number;
  window: number;
  windowAuto: boolean;
  setup: number;
  conversation: number;
  tools: number;
  /** Present when `/context` has been run in this session (since the last compaction). */
  reported?: { categories: Array<{ name: string; tokens: number }>; buffer?: number };
}

const isFree = (name: string) => /^free space$/i.test(name);
const isBuffer = (name: string) => /autocompact buffer/i.test(name);
const isDeferred = (name: string) => /\(deferred\)/i.test(name);

const len = (v: unknown): number => (typeof v === "string" ? v.length : Array.isArray(v) ? v.reduce<number>((n, b) => n + len((b as { text?: unknown })?.text), 0) : 0);

/**
 * How full a session's context window is, from the conversation file.
 *
 * The total is the provider's own count: the last request's prompt plus its reply. What it is made of is an
 * ESTIMATE: the session's first request (its system prompt, tools and memory) is the "setup", and everything added
 * since is split between conversation and tool traffic in proportion to how much text each added. A compaction
 * starts the count again from the summary. Only the lengths of text are used; no text is kept.
 */
export class ContextTracker {
  private chars = { conversation: 0, tools: 0 };
  private baseline: number | undefined;
  private lastPrompt = 0;
  private lastOutput = 0;
  private maxPrompt = 0;
  private model: string | undefined;
  /** Set when Claude Code compacted on its own: it does that just below the window, so the size it did it at gives the window. */
  private compactWindow: number | undefined;
  private seen = false;
  private report: (ContextReport & { usedThen: number }) | undefined;

  /** Returns true when the numbers changed. */
  feed(o: Record<string, unknown>): boolean {
    if (o.type === "system" && o.subtype === "compact_boundary") {
      const meta = o.compactMetadata as { trigger?: unknown; preTokens?: unknown } | undefined;
      // only an automatic compaction says anything: a person can compact at any size
      if (meta?.trigger === "auto" && typeof meta.preTokens === "number" && meta.preTokens > 0) this.compactWindow = windowHolding(meta.preTokens);
      this.baseline = undefined;
      this.chars = { conversation: 0, tools: 0 };
      this.report = undefined; // a report from before the compaction describes a window that no longer exists
      return false;
    }
    // the person ran /context: Claude Code's own breakdown is better than any estimate. It is saved as a "local command".
    if (o.type === "system" && o.subtype === "local_command" && typeof o.content === "string" && o.content.includes("Context Usage")) {
      const r = parseContextReport(o.content);
      if (r) {
        this.report = { ...r, usedThen: this.seen ? this.lastPrompt + this.lastOutput : r.used };
        return true;
      }
    }
    if (o.isSidechain === true) return false; // a subagent has its own window
    const content = (o.message as { content?: unknown } | undefined)?.content;
    let changed = false;
    if (o.type === "assistant") {
      const m = o.message as { usage?: Record<string, unknown>; model?: unknown } | undefined;
      const u = m?.usage;
      if (u && typeof u === "object" && m?.model !== "<synthetic>") {
        const prompt = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
        if (this.baseline === undefined) {
          this.baseline = prompt; // everything before this reply is in the prompt already
          this.chars = { conversation: 0, tools: 0 };
        }
        this.lastPrompt = prompt;
        this.lastOutput = num(u.output_tokens);
        this.maxPrompt = Math.max(this.maxPrompt, prompt);
        if (typeof m?.model === "string") this.model = m.model;
        this.seen = true;
        changed = true;
      }
      if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === "text") this.chars.conversation += len(b.text);
          else if (b.type === "tool_use") this.chars.tools += JSON.stringify(b.input ?? {}).length;
        }
      }
    } else if (o.type === "user" && o.isMeta !== true) {
      // the person ran /context: Claude Code's own breakdown is better than any estimate
      const raw = typeof content === "string" ? content : Array.isArray(content) ? (content as Array<{ text?: unknown }>).map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
      if (raw.includes("Context Usage")) {
        const r = parseContextReport(raw);
        if (r) {
          this.report = { ...r, usedThen: this.seen ? this.lastPrompt + this.lastOutput : r.used };
          return true;
        }
      }
      if (typeof content === "string") this.chars.conversation += content.length;
      else if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type === "text") this.chars.conversation += len(b.text);
          else if (b.type === "tool_result") this.chars.tools += len(b.content);
        }
      }
    }
    return changed;
  }

  snapshot(pinnedWindow: number): ContextSnapshot | undefined {
    if (this.report) {
      const r = this.report;
      const grown = this.seen ? Math.max(0, this.lastPrompt + this.lastOutput - r.usedThen) : 0; // what was added since /context ran
      const buffer = r.categories.find((c) => isBuffer(c.name))?.tokens;
      const cats = r.categories.filter((c) => !isFree(c.name) && !isBuffer(c.name) && !isDeferred(c.name)).map((c) => ({ ...c }));
      const messages = cats.find((c) => /^messages$/i.test(c.name));
      if (messages) messages.tokens += grown;
      else if (grown) cats.push({ name: "Messages", tokens: grown });
      const msg = cats.find((c) => /^messages$/i.test(c.name))?.tokens ?? 0;
      const used = r.used + grown;
      return {
        used,
        window: r.window,
        windowAuto: false,
        setup: Math.max(0, used - msg),
        conversation: msg,
        tools: 0,
        reported: { categories: cats, ...(buffer !== undefined ? { buffer } : {}) },
      };
    }
    if (!this.seen || this.baseline === undefined) return undefined;
    const used = this.lastPrompt + this.lastOutput;
    const setup = Math.min(this.baseline, used);
    const rest = used - setup;
    const text = this.chars.conversation + this.chars.tools;
    const conversation = text === 0 ? rest : Math.round((rest * this.chars.conversation) / text);
    return {
      used,
      window: pinnedWindow > 0 ? pinnedWindow : this.compactWindow !== undefined ? Math.max(this.compactWindow, windowHolding(used)) : autoWindow(Math.max(this.maxPrompt, used), this.model),
      windowAuto: pinnedWindow <= 0,
      setup,
      conversation,
      tools: rest - conversation,
    };
  }
}

interface Tail {
  path: string;
  offset: number;
  rest: string;
  seen: Set<string>;
  first: boolean;
  /** The first read began in the middle of the file, so its first line is a fragment. */
  midFile: boolean;
  /** Reading the file from its start (to total the tokens) and not caught up with its end yet. */
  scanning: boolean;
  /** The last messages found while scanning, shown once the scan reaches the end. */
  backlog: Array<Extract<ParsedLine, { kind: "message" }>>;
  usage: Map<string, UsageLine>;
  ctx: ContextTracker;
  /** A Codex session file is read for tokens and context only, by this instead of `ctx`. */
  codex?: CodexContextTracker;
  usageDirty: boolean;
  usageSentAt: number;
  nextAt: number;
  watcher?: FSWatcher;
}

export interface TranscriptOptions {
  manager: SessionManager;
  diagnostics: Diagnostics;
  /** Only files under here are ever read. */
  root?: string;
  tickMs?: number;
  /** How far back to read when a session is first seen, in bytes and in messages. */
  backlogBytes?: number;
  backlogMessages?: number;
}

const MAX_READ = 4_000_000;
/** A Codex file is read whole to find its first request, and is mostly lines that are only measured: read it in bigger bites. */
const MAX_READ_CODEX = 16_000_000;
const USAGE_EVERY_MS = 3000;

export function startTranscriptObserver(opts: TranscriptOptions): { stop: () => void; refresh: () => void } {
  const { manager, diagnostics } = opts;
  const root = opts.root ?? join(homedir(), ".claude", "projects");
  const backlogBytes = opts.backlogBytes ?? 400_000;
  const backlogMessages = opts.backlogMessages ?? 30;
  const tails = new Map<string, Tail>();
  /** Codex sessions already reported as having no session file, so that is said once. */
  const noPath = new Set<string>();
  const MAX_WATCHED = 16;
  let wake: ReturnType<typeof setTimeout> | undefined;
  const closeTail = (id: string) => {
    tails.get(id)?.watcher?.close();
    tails.delete(id);
  };
  let realRoot: string | undefined;

  const allowed = (path: string): string | undefined => {
    if (!path.endsWith(".jsonl")) return undefined;
    if (!realRoot) {
      try {
        realRoot = realpathSync(root); // resolved when first needed: Claude Code may create the folder later
      } catch {
        return undefined; // no Claude Code conversations on this Mac (yet)
      }
    }
    try {
      const real = realpathSync(path);
      return real.startsWith(realRoot + sep) ? real : undefined;
    } catch {
      return undefined;
    }
  };

  /** A Codex session file lives under whatever CODEX_HOME the launcher chose, so it is recognised by its shape, not its place. */
  const allowedCodex = (path: string): string | undefined => {
    try {
      const real = realpathSync(path);
      return isCodexRollout(real) ? real : undefined;
    } catch {
      return undefined;
    }
  };

  /** New complete lines since the last read, and whether that reached the end of the file. */
  const readNew = (t: Tail, full: boolean): { text: string; atEnd: boolean } | undefined => {
    let size: number;
    try {
      size = statSync(t.path).size;
    } catch {
      return undefined;
    }
    if (t.first) {
      t.first = false;
      // Totalling tokens needs the whole file; showing chat needs only its recent end.
      t.offset = full ? 0 : Math.max(0, size - backlogBytes);
      t.midFile = t.offset > 0;
    } else if (size < t.offset) {
      t.offset = 0; // the file was replaced
      t.rest = "";
    }
    if (size === t.offset) return { text: "", atEnd: true };
    const len = Math.min(size - t.offset, t.codex ? MAX_READ_CODEX : MAX_READ);
    const buf = Buffer.alloc(len);
    const fd = openSync(t.path, "r");
    try {
      readSync(fd, buf, 0, len, t.offset);
    } finally {
      closeSync(fd);
    }
    // never split a multi-byte character: stop at the last newline, keep the tail for the next read
    const cut = buf.lastIndexOf(0x0a);
    const used = cut < 0 ? 0 : cut + 1;
    t.offset += used;
    return { text: t.rest + buf.subarray(0, used).toString("utf8"), atEnd: t.offset >= size || used === 0 };
  };

  const emitMessage = (s: SessionView, m: Extract<ParsedLine, { kind: "message" }>, t: Tail) => {
    if (m.uuid) t.seen.add(m.uuid);
    manager.apply({
      provider: s.provider,
      providerSessionId: s.providerSessionId!,
      kind: "message",
      source: "transcript",
      confidence: "high",
      ...(m.at ? { occurredAt: m.at } : {}),
      ...(m.uuid ? { correlationId: m.uuid } : {}),
      payload: { role: m.role, body: m.body },
    });
  };

  /** Totals change with every reply; the record is updated at most every few seconds. */
  const flushUsage = (s: SessionView, t: Tail, now: number) => {
    if (!t.usageDirty || t.scanning || now - t.usageSentAt < USAGE_EVERY_MS) return;
    t.usageDirty = false;
    t.usageSentAt = now;
    // Codex states its window itself, so the pin in Settings (for Claude Code, which never does) does not apply to it
    const c = t.codex ? t.codex.snapshot() : t.ctx.snapshot(manager.contentPolicy().window);
    manager.apply({
      provider: s.provider,
      providerSessionId: s.providerSessionId!,
      kind: "usage.updated",
      source: "transcript",
      confidence: "high",
      payload: {
        scope: "session",
        providerReported: true,
        ...(t.codex ? t.codex.totals() : totalUsage(t.usage)),
        ...(c
          ? {
              contextUsed: c.used,
              contextWindow: c.window,
              contextAuto: c.windowAuto,
              contextSetup: c.setup,
              contextConversation: c.conversation,
              contextTools: c.tools,
              ...(c.reported ? { contextReported: true, contextCategories: JSON.stringify(c.reported.categories.slice(0, 16)), ...(c.reported.buffer !== undefined ? { contextBuffer: c.reported.buffer } : {}) } : {}),
            }
          : {}),
      },
    });
  };

  const tick = () => {
    const policy = manager.contentPolicy();
    const wantsText = policy.prompts || policy.responses;
    if (!wantsText && !policy.tokens) {
      for (const id of [...tails.keys()]) closeTail(id);
      return;
    }
    const now = Date.now();
    for (const s of manager.sessions.values()) {
      if ((s.provider !== "claude-code" && s.provider !== "codex") || s.endedAt || !s.providerSessionId) continue;
      const isCodex = s.provider === "codex";
      if (isCodex && !policy.tokens) {
        closeTail(s.id); // Codex is read for token counts only: with tracking off there is nothing to read
        continue;
      }
      const wanted = manager.transcriptFor(s.id);
      if (!wanted) {
        // the hook says where the session file is; if it never does, this line is how to tell
        if (isCodex && s.status !== "idle" && !noPath.has(s.id) && now - Date.parse(s.startedAt) > 30_000) {
          noPath.add(s.id);
          diagnostics.info("observer.context", "a codex session has not reported where its session file is, so its context cannot be read");
        }
        continue;
      }
      let t = tails.get(s.id);
      if (!t) {
        const path = isCodex ? allowedCodex(wanted) : allowed(wanted);
        if (!path) continue;
        t = { path, offset: 0, rest: "", seen: manager.messageIds(s.id), first: true, midFile: false, scanning: true, backlog: [], usage: new Map(), ctx: new ContextTracker(), ...(isCodex ? { codex: new CodexContextTracker() } : {}), usageDirty: false, usageSentAt: 0, nextAt: 0 };
        if (isCodex) diagnostics.info("observer.context", `reading the context of a codex session from ${basename(path)}`);
        // A change to the file wakes the reader at once, so a prompt or reply shows up as it is written instead of at the next poll.
        if (tails.size < MAX_WATCHED) {
          try {
            const mine = t;
            t.watcher = watch(path, { persistent: false }, () => {
              mine.nextAt = 0;
              if (wake) return;
              wake = setTimeout(() => {
                wake = undefined;
                tick();
              }, 40);
              wake.unref();
            });
            t.watcher.on("error", () => t?.watcher?.close());
          } catch {
            /* polling still covers it */
          }
        }
        tails.set(s.id, t);
      }
      flushUsage(s, t, now);
      if (now < t.nextAt) continue;
      t.nextAt = now + (s.status === "running" || s.status === "waiting" ? 0 : t.watcher ? 4000 : 1500); // watched files wake themselves; the poll is the safety net
      let got: { text: string; atEnd: boolean } | undefined;
      try {
        got = readNew(t, policy.tokens);
      } catch (err) {
        diagnostics.warn("observer.chat", `could not read a conversation file: ${(err as Error).message}`);
        t.nextAt = now + 30_000;
        continue;
      }
      if (!got) continue;
      if (got.text) {
        const lines = got.text.split("\n");
        t.rest = lines.pop() ?? ""; // an unfinished last line waits for the next read
        if (t.midFile && lines.length) {
          lines.shift(); // we started in the middle of a line
        }
        t.midFile = false;
        let interruptedAt: string | undefined;
        for (const line of lines) {
          if (t.codex) {
            // a Codex line is classified by its first characters and parsed only when it is a token count
            if (t.codex.feedLine(line)) t.usageDirty = true;
            continue;
          }
          const o = lineObject(line);
          if (!o) continue;
          const stopped = interruptionOf(o);
          if (stopped && (!interruptedAt || stopped > interruptedAt)) interruptedAt = stopped;
          if (policy.tokens) {
            const u = usageOfObject(o);
            if (u) {
              t.usage.set(u.id, u);
              t.usageDirty = true;
            }
            if (t.ctx.feed(o)) t.usageDirty = true;
          }
          if (!wantsText) continue;
          const p = parseTranscriptObject(o);
          if (!p) continue;
          if (p.kind === "title") manager.setSessionTitle(s.id, p.title);
          else if (!p.uuid || !t.seen.has(p.uuid)) {
            if (t.scanning) {
              t.backlog.push(p);
              if (t.backlog.length > backlogMessages) t.backlog.shift();
            } else if ((p.role === "user" && policy.prompts) || (p.role === "assistant" && policy.responses)) emitMessage(s, p, t);
          }
        }
        // No hook says a question was turned down. If the person did, and nothing newer is open, the turn is over.
        if (interruptedAt && manager.hasPendingBefore(s.id, interruptedAt)) {
          manager.apply({ provider: s.provider, providerSessionId: s.providerSessionId!, kind: "status.changed", source: "transcript", confidence: "high", occurredAt: interruptedAt, payload: { status: "idle", label: "interrupted" } });
        }
      }
      if (t.scanning && got.atEnd) {
        t.scanning = false;
        for (const m of t.backlog) if ((m.role === "user" && policy.prompts) || (m.role === "assistant" && policy.responses)) emitMessage(s, m, t);
        t.backlog = [];
      }
      flushUsage(s, t, Date.now());
    }
    for (const id of [...tails.keys()]) if (!manager.sessions.has(id) || manager.sessions.get(id)?.endedAt) closeTail(id);
  };

  const timer = setInterval(tick, opts.tickMs ?? 1000);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      if (wake) clearTimeout(wake);
      for (const id of [...tails.keys()]) closeTail(id);
    },
    refresh: () => {
      for (const id of [...tails.keys()]) closeTail(id);
      tick();
    },
  };
}
