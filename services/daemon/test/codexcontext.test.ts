import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Diagnostics } from "../src/diagnostics";
import { Store } from "../src/db/store";
import { CodexContextTracker, isCodexRollout } from "../src/observers/codex-rollout";
import { startTranscriptObserver } from "../src/observers/transcript";
import { SessionManager } from "../src/session-manager";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "awcx-"));
  dirs.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(25);
};

// Lines shaped like the ones Codex writes: the timestamp and ordinal come first, then the type and its payload.
let ordinal = 0;
const row = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-10-06T09:54:23.808Z", ordinal: ++ordinal, type, payload }) + "\n";
const tokenCount = (input: number, output: number, window = 258400, total = { input: input * 2, cached: input, output: output * 2 }) =>
  row("event_msg", {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: total.input, cached_input_tokens: total.cached, output_tokens: total.output, reasoning_output_tokens: 0, total_tokens: total.input + total.output },
      last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
      model_context_window: window,
    },
    rate_limits: { primary: { used_percent: 8 } },
  });
const message = (n: number) => row("response_item", { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "x".repeat(n) }] });
const toolCall = (n: number) => row("response_item", { type: "custom_tool_call", call_id: "c", name: "shell", input: "y".repeat(n) });
const toolOut = (n: number) => row("response_item", { type: "custom_tool_call_output", call_id: "c", output: "z".repeat(n) });

describe("CodexContextTracker", () => {
  it("takes the window Codex states, and the last request as how full it is", () => {
    const t = new CodexContextTracker();
    expect(t.snapshot()).toBeUndefined();
    expect(t.feedLine(tokenCount(20_000, 100))).toBe(true);
    expect(t.feedLine(tokenCount(47_235, 50))).toBe(true);
    const c = t.snapshot()!;
    expect(c.used).toBe(47_285);
    expect(c.window).toBe(258_400);
    expect(c.windowAuto).toBe(false); // nothing is guessed
    expect(c.setup).toBe(20_000); // the first request
  });

  it("splits what came after the first request by how much text conversation and tool traffic wrote", () => {
    const t = new CodexContextTracker();
    t.feedLine(tokenCount(20_000, 100)); // first request: instructions, tools, AGENTS.md
    t.feedLine(message(1000));
    t.feedLine(toolCall(1000));
    t.feedLine(toolOut(2000));
    t.feedLine(tokenCount(60_000, 200));
    const c = t.snapshot()!;
    expect(c.setup).toBe(20_000);
    expect(c.conversation + c.tools).toBe(40_200);
    expect(c.conversation / (c.conversation + c.tools)).toBeGreaterThan(0.2); // 1 of ~4 parts, plus the JSON around each line
    expect(c.conversation / (c.conversation + c.tools)).toBeLessThan(0.3);
  });

  it("does not count a screenshot's megabytes as conversation", () => {
    const t = new CodexContextTracker();
    t.feedLine(tokenCount(20_000, 0));
    t.feedLine(toolOut(3_000_000));
    t.feedLine(message(60_000));
    t.feedLine(tokenCount(60_000, 0));
    const c = t.snapshot()!;
    expect(c.conversation).toBeGreaterThan(c.tools * 0.4); // capped at 100k, so the 60k of talk still matters
  });

  it("starts again after a compaction, and reports session totals with the cache apart", () => {
    const t = new CodexContextTracker();
    t.feedLine(tokenCount(20_000, 10, 258_400, { input: 481_375, cached: 432_128, output: 1_015 }));
    t.feedLine(tokenCount(200_000, 10));
    t.feedLine(row("compacted", { message: "summary" }));
    t.feedLine(tokenCount(15_000, 5, 258_400, { input: 500_000, cached: 450_000, output: 1_100 }));
    const c = t.snapshot()!;
    expect(c.used).toBe(15_005);
    expect(c.setup).toBe(15_000);
    expect(t.totals()).toEqual({ inputTokens: 50_000, outputTokens: 1_100, cachedInputTokens: 450_000 });
  });

  it("ignores a rate-limit update without usage, other event types and lines that are not JSON", () => {
    const t = new CodexContextTracker();
    expect(t.feedLine(row("event_msg", { type: "token_count", info: null, rate_limits: {} }))).toBe(false);
    expect(t.feedLine(row("event_msg", { type: "task_started" }))).toBe(false);
    expect(t.feedLine(row("turn_context", { model: "gpt-6-luna" }))).toBe(false);
    expect(t.feedLine('{"type":"event_msg","payload":{"type":"token_count",')).toBe(false);
    expect(t.feedLine("")).toBe(false);
    expect(t.snapshot()).toBeUndefined();
  });
});

describe("which files are a Codex session file", () => {
  it("is a rollout under a sessions folder, wherever CODEX_HOME is", () => {
    expect(isCodexRollout("/Users/a/Library/Application Support/orca/codex-accounts/x/home/sessions/2026/10/06/rollout-2026-10-06T16-54-09-01a1.jsonl")).toBe(true);
    expect(isCodexRollout("/Users/a/.codex/sessions/2026/09/07/rollout-x.jsonl")).toBe(true);
    expect(isCodexRollout("/Users/a/.codex/sessions/2026/09/07/notes.jsonl")).toBe(false);
    expect(isCodexRollout("/Users/a/.codex/auth.json")).toBe(false);
    expect(isCodexRollout("/etc/rollout-x.jsonl")).toBe(false);
  });
});

describe("the observer reading a Codex session", () => {
  function setup() {
    const home = tmp();
    const day = join(home, "sessions", "2026", "10", "06");
    mkdirSync(day, { recursive: true });
    const file = join(day, "rollout-2026-10-06T16-54-09-01a110a2.jsonl");
    const m = new SessionManager(new Store(":memory:"));
    // the hook's session id is not the file's: the hook says where the file is
    m.apply({ provider: "codex", providerSessionId: "84074f9f", kind: "session.started", source: "codex-hook", confidence: "high", payload: { cwd: "/work/jolly", model: "gpt-6-luna" } });
    const id = [...m.sessions.keys()][0]!;
    return { home, file, m, id };
  }
  const obs = (m: SessionManager, d = new Diagnostics(20, null)) => startTranscriptObserver({ manager: m, diagnostics: d, root: tmp(), tickMs: 30 });

  it("shows the context of a Codex session from the file its hook named, wherever that is", async () => {
    const { file, m, id } = setup();
    m.setContentPolicy({ prompts: false, responses: false, tokens: true });
    writeFileSync(file, row("session_meta", { id: "01a110a2" }) + tokenCount(20_000, 100) + toolCall(500) + tokenCount(39_268, 100));
    m.noteTranscript("codex", "84074f9f", file);
    const o = obs(m);
    await until(() => m.sessions.get(id)?.usage?.context !== undefined);
    const u = m.sessions.get(id)!.usage!;
    expect(u.context).toMatchObject({ used: 39_368, window: 258_400, windowAuto: false, setup: 20_000 });
    expect(u.inputTokens).toBeGreaterThan(0);

    appendFileSync(file, tokenCount(52_000, 40));
    await until(() => m.sessions.get(id)!.usage!.context!.used === 52_040, 8000);
    expect(m.sessions.get(id)!.usage!.context!.used).toBe(52_040);
    o.stop();
  });

  it("reads nothing while token tracking is off", async () => {
    const { file, m, id } = setup();
    writeFileSync(file, tokenCount(20_000, 100));
    m.noteTranscript("codex", "84074f9f", file);
    const o = obs(m);
    await sleep(200);
    expect(m.sessions.get(id)!.usage?.context).toBeUndefined();
    o.stop();
  });

  it("refuses a path that is not a Codex session file, or a link to one outside", async () => {
    const { home, m, id } = setup();
    m.setContentPolicy({ prompts: false, responses: false, tokens: true });
    const other = join(home, "sessions", "auth.jsonl");
    writeFileSync(other, tokenCount(20_000, 100));
    m.noteTranscript("codex", "84074f9f", other);
    const o = obs(m);
    await sleep(200);
    expect(m.sessions.get(id)!.usage?.context).toBeUndefined();
    o.stop();

    const secret = join(home, "secret.jsonl");
    writeFileSync(secret, tokenCount(20_000, 100));
    const link = join(home, "sessions", "rollout-link.jsonl");
    symlinkSync(secret, link);
    m.noteTranscript("codex", "84074f9f", link);
    const o2 = obs(m);
    await sleep(200);
    expect(m.sessions.get(id)!.usage?.context).toBeUndefined();
    o2.stop();
  });
});
