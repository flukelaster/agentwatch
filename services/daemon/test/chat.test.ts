import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventInput } from "@agentwatch/protocol";
import { Diagnostics } from "../src/diagnostics";
import { Store } from "../src/db/store";
import { ContextTracker, autoWindow, interruptionOf, parseContextReport, parseTokenCount, startTranscriptObserver, parseTranscriptLine, totalUsage, usageOfLine } from "../src/observers/transcript";
import { SessionManager } from "../src/session-manager";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "awc-"));
  dirs.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(25);
};

const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => line({ type: "user", uuid, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content }, ...extra });
const assistant = (uuid: string, blocks: unknown[], extra: Record<string, unknown> = {}) => line({ type: "assistant", uuid, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: blocks }, ...extra });

describe("parseTranscriptLine", () => {
  it("keeps what a person typed and what the assistant said, and nothing else", () => {
    expect(parseTranscriptLine(user("u1", "Fix the login bug"))).toMatchObject({ kind: "message", role: "user", body: "Fix the login bug", uuid: "u1" });
    expect(parseTranscriptLine(assistant("a1", [{ type: "thinking", thinking: "secret chain" }, { type: "text", text: "Done." }, { type: "tool_use", name: "Bash", input: { command: "ls" } }]))).toMatchObject({ role: "assistant", body: "Done." });
    // tool results, tool calls and thinking are not chat
    expect(parseTranscriptLine(user("u2", [{ type: "tool_result", content: "file list" }]))).toBeUndefined();
    expect(parseTranscriptLine(assistant("a2", [{ type: "tool_use", name: "Bash", input: {} }, { type: "thinking", thinking: "x" }]))).toBeUndefined();
    // subagent chatter, injected context and meta lines are skipped
    expect(parseTranscriptLine(user("u3", "from a subagent", { isSidechain: true }))).toBeUndefined();
    expect(parseTranscriptLine(user("u4", "meta", { isMeta: true }))).toBeUndefined();
    expect(parseTranscriptLine("not json")).toBeUndefined();
    expect(parseTranscriptLine(line({ type: "attachment" }))).toBeUndefined();
  });

  it("strips the instructions Claude Code wraps around a prompt", () => {
    const p = parseTranscriptLine(user("u5", [{ type: "text", text: "<system-reminder>be careful, CLAUDE.md says…</system-reminder>" }, { type: "text", text: "Add a retry\n<command-name>/foo</command-name>" }]));
    expect(p).toMatchObject({ role: "user", body: "Add a retry" });
    expect(parseTranscriptLine(user("u6", "<system-reminder>only context</system-reminder>"))).toBeUndefined();
  });

  it("reads the conversation title", () => {
    expect(parseTranscriptLine(line({ type: "ai-title", aiTitle: "  Fix login redirect " }))).toEqual({ kind: "title", title: "Fix login redirect" });
  });
});

describe("message policy in the manager", () => {
  const msg = (role: string, body: string): AgentEventInput => ({ provider: "claude-code", providerSessionId: "p", kind: "message", source: "transcript", confidence: "high", payload: { role, body } });
  const start = (m: SessionManager) => m.apply({ provider: "claude-code", providerSessionId: "p", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });

  it("refuses every message while both settings are off (the default)", () => {
    const m = new SessionManager(new Store(":memory:"));
    start(m);
    expect(m.apply(msg("user", "hello"))).toBeNull();
    expect(m.apply(msg("assistant", "hi"))).toBeNull();
    expect(m.contentPolicy()).toEqual({ prompts: false, responses: false, tokens: false, window: 0 });
  });

  it("accepts only the kinds that are switched on, redacts credentials and keeps line breaks", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    start(m);
    m.setContentPolicy({ prompts: false, responses: true });
    expect(m.apply(msg("user", "my prompt"))).toBeNull();
    const e = m.apply(msg("assistant", "Line one\n\n```ts\nconst key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'\n```\nLine three"))!;
    expect(e).not.toBeNull();
    const body = String(e.payload.body);
    expect(body.split("\n").length).toBeGreaterThan(3); // not flattened to one line
    expect(body).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(e.redacted).toBe(true);
  });

  it("caps the length of one message", () => {
    const m = new SessionManager(new Store(":memory:"));
    start(m);
    m.setContentPolicy({ prompts: true, responses: true });
    expect(String(m.apply(msg("user", "x".repeat(20_000)))!.payload.body).length).toBeLessThanOrEqual(6000);
  });

  it("does not make an old session look freshly active", () => {
    const m = new SessionManager(new Store(":memory:"));
    start(m);
    m.setContentPolicy({ prompts: true, responses: true });
    const s = [...m.sessions.values()][0]!;
    const before = s.lastEventAt;
    const eventsBefore = s.counts.events;
    m.apply({ ...msg("user", "old message"), occurredAt: "2020-01-01T00:00:00Z" });
    expect(s.lastEventAt).toBe(before);
    expect(s.counts.events).toBe(eventsBefore);
  });

  it("deletes stored messages of one kind when that setting is turned off", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    start(m);
    m.setContentPolicy({ prompts: true, responses: true });
    m.apply(msg("user", "p1"));
    m.apply(msg("assistant", "a1"));
    m.flush();
    expect(store.deleteMessages("user")).toBe(1);
    expect(store.deleteMessages("user")).toBe(0);
    expect(store.deleteMessages("assistant")).toBe(1);
  });

  it("settings round-trip: both default to off and only a boolean turns them on", () => {
    const store = new Store(":memory:");
    expect(store.getSettings()).toMatchObject({ storePromptText: false, storeAssistantText: false });
    store.setSettings({ storePromptText: "yes", storeAssistantText: 1 });
    expect(store.getSettings()).toMatchObject({ storePromptText: false, storeAssistantText: false });
    store.setSettings({ storePromptText: true });
    expect(store.getSettings()).toMatchObject({ storePromptText: true, storeAssistantText: false });
  });
});

describe("transcript observer", () => {
  function setup() {
    const root = tmp();
    const proj = join(root, "proj");
    mkdirSync(proj);
    const file = join(proj, "s.jsonl");
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    m.apply({ provider: "claude-code", providerSessionId: "sess", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });
    const id = [...m.sessions.keys()][0]!;
    return { root, proj, file, store, m, id };
  }
  const messages = (store: Store, id: string) => store.messageIds(id).size;

  it("reads nothing while both settings are off, then streams new messages once they are on", async () => {
    const { root, file, m, id, store } = setup();
    writeFileSync(file, user("u1", "first question") + assistant("a1", [{ type: "text", text: "first answer" }]));
    m.noteTranscript("claude-code", "sess", file);
    const obs = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30 });
    await sleep(150);
    expect(messages(store, id)).toBe(0); // off by default: not even read

    m.setContentPolicy({ prompts: true, responses: true });
    obs.refresh();
    await until(() => messages(store, id) === 2);
    expect(messages(store, id)).toBe(2);

    appendFileSync(file, assistant("a2", [{ type: "text", text: "a later reply" }]));
    await until(() => messages(store, id) === 3);
    expect(messages(store, id)).toBe(3);
    obs.refresh(); // re-reading the whole file must not duplicate anything
    await sleep(200);
    expect(messages(store, id)).toBe(3);
    obs.stop();
  });

  it("shows a new prompt almost at once, even for an idle session and a slow poll, because the file wakes the reader", async () => {
    const { root, file, m, id, store } = setup();
    writeFileSync(file, user("u1", "earlier"));
    m.noteTranscript("claude-code", "sess", file);
    m.setContentPolicy({ prompts: true, responses: true });
    const s = m.sessions.get(id)!;
    s.status = "idle"; // nothing is running: the case that used to wait for a slow poll
    const obs = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 5000 });
    obs.refresh();
    await until(() => messages(store, id) === 1);
    await sleep(300); // a real prompt never lands within a few milliseconds of the reader starting
    const t0 = Date.now();
    appendFileSync(file, user("u2", "a brand new prompt"));
    await until(() => messages(store, id) === 2, 3000);
    obs.stop();
    expect(messages(store, id)).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1500); // the poll alone would have taken 4 s or more
  });

  it("only stores the kinds that are on", async () => {
    const { root, file, m, id, store } = setup();
    writeFileSync(file, user("u1", "a prompt") + assistant("a1", [{ type: "text", text: "a reply" }]));
    m.noteTranscript("claude-code", "sess", file);
    m.setContentPolicy({ prompts: false, responses: true });
    const obs = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30 });
    await until(() => messages(store, id) >= 1);
    await sleep(150);
    obs.stop();
    expect(messages(store, id)).toBe(1);
  });

  it("never reads a file outside the Claude projects directory, even if a hook names one", async () => {
    const { root, file, m, id, store } = setup();
    const outside = join(tmp(), "secret.jsonl");
    writeFileSync(outside, user("u1", "outside the allowed folder"));
    m.noteTranscript("claude-code", "sess", outside);
    m.setContentPolicy({ prompts: true, responses: true });
    const obs = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30 });
    await sleep(250);
    expect(messages(store, id)).toBe(0);
    // a symlink inside the folder that points outside is refused too
    const link = join(root, "proj", "link.jsonl");
    symlinkSync(outside, link);
    m.noteTranscript("claude-code", "sess", link);
    obs.refresh();
    await sleep(250);
    expect(messages(store, id)).toBe(0);
    // a path that is not a .jsonl is refused
    writeFileSync(join(root, "proj", "notes.txt"), "x");
    m.noteTranscript("claude-code", "sess", join(root, "proj", "notes.txt"));
    obs.refresh();
    await sleep(150);
    void file;
    expect(messages(store, id)).toBe(0);
    obs.stop();
  });

  it("picks up the conversation title", async () => {
    const { root, file, m, id } = setup();
    writeFileSync(file, line({ type: "ai-title", aiTitle: "Fix login redirect" }) + user("u1", "hi"));
    m.noteTranscript("claude-code", "sess", file);
    m.setContentPolicy({ prompts: true, responses: true });
    const obs = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30 });
    await until(() => m.sessions.get(id)!.title !== undefined);
    obs.stop();
    expect(m.sessions.get(id)!.title).toBe("Fix login redirect");
  });

  it("waits for a half-written last line instead of dropping it", async () => {
    const { root, file, m, id, store } = setup();
    const full = assistant("a1", [{ type: "text", text: "complete reply" }]);
    writeFileSync(file, user("u1", "q"));
    m.noteTranscript("claude-code", "sess", file);
    m.setContentPolicy({ prompts: true, responses: true });
    const obs = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30 });
    await until(() => messages(store, id) === 1);
    appendFileSync(file, full.slice(0, 40)); // writer is mid-line
    await sleep(200);
    expect(messages(store, id)).toBe(1);
    appendFileSync(file, full.slice(40));
    await until(() => messages(store, id) === 2);
    obs.stop();
    expect(messages(store, id)).toBe(2);
  });
});

describe("token usage from the conversation file", () => {
  const reply = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
    line({ type: "assistant", uuid: `${id}-${Math.random()}`, message: { id, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "SECRET REPLY TEXT" }], usage }, ...extra });

  it("counts a reply once even though it is written as several lines, takes cache creation as fresh input, and skips synthetic messages", () => {
    const rows = [
      usageOfLine(reply("msg_1", { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }))!,
      usageOfLine(reply("msg_1", { input_tokens: 2, output_tokens: 253, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }))!,
      usageOfLine(reply("msg_2", { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 }))!,
    ];
    expect(rows[0]).toEqual({ id: "msg_1", input: 52, output: 10, cacheRead: 1000 });
    expect(totalUsage(new Map(rows.map((r) => [r.id, r])))).toEqual({ inputTokens: 53, outputTokens: 258, cachedInputTokens: 3000 });
    expect(usageOfLine(line({ type: "assistant", message: { id: "x", model: "<synthetic>", usage: { input_tokens: 1, output_tokens: 1 } } }))).toBeUndefined();
    expect(usageOfLine(user("u1", "a prompt"))).toBeUndefined();
    expect(usageOfLine("not json")).toBeUndefined();
  });

  function setup(bytesOfPadding = 0) {
    const root = tmp();
    mkdirSync(join(root, "proj"));
    const file = join(root, "proj", "s.jsonl");
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    m.apply({ provider: "claude-code", providerSessionId: "sess", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });
    const id = [...m.sessions.keys()][0]!;
    writeFileSync(file, bytesOfPadding ? line({ type: "attachment", pad: "x".repeat(bytesOfPadding) }) : "");
    m.noteTranscript("claude-code", "sess", file);
    return { root, file, store, m, id, s: m.sessions.get(id)! };
  }
  const obs = (m: SessionManager, root: string) => startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30, backlogBytes: 2000 });
  const messages = (store: Store, id: string) => store.messageIds(id).size;

  it("records the totals without keeping a word of the conversation, and reads the whole file even when it is long", async () => {
    const { root, file, m, id, s, store } = setup(50_000); // far more than the chat's recent window
    appendFileSync(file, user("u1", "SECRET PROMPT TEXT") + reply("msg_1", { input_tokens: 3, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 40 }) + reply("msg_2", { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 }));
    m.setContentPolicy({ prompts: false, responses: false, tokens: true }); // only the numbers
    const o = obs(m, root);
    await until(() => s.usage?.providerReported === true);
    o.stop();
    expect(s.usage).toMatchObject({ scope: "session", providerReported: true, inputTokens: 44, outputTokens: 150, cachedInputTokens: 11000 });
    expect(messages(store, id)).toBe(0);
    const stored = (store as any).db.prepare("SELECT payload_json FROM events WHERE session_id = ?").all(id).map((r: any) => r.payload_json).join("\n");
    expect(stored).not.toContain("SECRET");
  });

  it("follows new replies, updating the total", async () => {
    const { root, file, m, s } = setup();
    appendFileSync(file, reply("msg_1", { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }));
    m.setContentPolicy({ prompts: false, responses: false, tokens: true });
    const o = obs(m, root);
    await until(() => s.usage?.outputTokens === 10);
    await sleep(300);
    appendFileSync(file, reply("msg_2", { input_tokens: 1, output_tokens: 15, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }));
    await until(() => s.usage?.outputTokens === 25, 6000);
    o.stop();
    expect(s.usage?.outputTokens).toBe(25);
  });

  it("does nothing while token tracking is off, and its records never make a session look recently active", async () => {
    const { root, file, m, s } = setup();
    appendFileSync(file, reply("msg_1", { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }));
    m.setContentPolicy({ prompts: false, responses: false, tokens: false });
    const o = obs(m, root);
    await sleep(300);
    expect(s.usage).toBeUndefined();
    const before = s.lastEventAt;
    const eventsBefore = s.counts.events;
    m.setContentPolicy({ prompts: false, responses: false, tokens: true });
    o.refresh();
    await until(() => s.usage !== undefined);
    o.stop();
    expect(s.usage?.outputTokens).toBe(10);
    expect(s.lastEventAt).toBe(before);
    expect(s.counts.events).toBe(eventsBefore);
  });

  it("token tracking is on by default and can be switched off", () => {
    const store = new Store(":memory:");
    expect(store.getSettings().trackTokenUsage).toBe(true);
    store.setSettings({ trackTokenUsage: false });
    expect(store.getSettings().trackTokenUsage).toBe(false);
    store.setSettings({ trackTokenUsage: "no" });
    expect(store.getSettings().trackTokenUsage).toBe(false);
  });
});

describe("how full the context window is", () => {
  const reply = (prompt: number, output: number, blocks: unknown[] = [], extra: Record<string, unknown> = {}) => ({
    type: "assistant",
    message: { id: `m${Math.random()}`, model: "claude-test-model", content: blocks, usage: { input_tokens: 1, cache_read_input_tokens: prompt - 1, cache_creation_input_tokens: 0, output_tokens: output } },
    ...extra,
  });
  const text = (n: number) => ({ type: "text", text: "x".repeat(n) });
  const toolUse = (n: number) => ({ type: "tool_use", name: "Bash", input: { c: "y".repeat(n - 8) } }); // JSON length n
  const toolResult = (n: number) => ({ type: "tool_result", content: "z".repeat(n) });

  it("takes the first request as the setup and splits what came after by how much text each part added", () => {
    const t = new ContextTracker();
    expect(t.snapshot(0)).toBeUndefined(); // nothing read yet
    t.feed(reply(20_000, 100)); // the session's first request: system prompt, tools, memory
    t.feed({ type: "user", message: { content: "a".repeat(1000) } });
    t.feed(reply(30_000, 50, [text(1000), toolUse(2000)]));
    t.feed({ type: "user", message: { content: [toolResult(4000)] } });
    t.feed(reply(60_000, 200)); // the latest request
    const c = t.snapshot(0)!;
    expect(c.used).toBe(60_200); // the last prompt plus its reply
    expect(c.setup).toBe(20_000);
    expect(c.conversation + c.tools).toBe(40_200); // the rest, all accounted for
    expect(c.conversation).toBe(Math.round(40_200 * 0.25)); // 2000 characters of talk ...
    expect(c.tools).toBe(40_200 - c.conversation); // ... against 6000 of tool calls and results
  });

  it("starts again from the summary after a compaction, and ignores what a subagent says", () => {
    const t = new ContextTracker();
    t.feed(reply(20_000, 10));
    t.feed(reply(150_000, 10));
    t.feed({ type: "system", subtype: "compact_boundary" });
    t.feed(reply(9_999_999, 1, [], { isSidechain: true })); // another window
    t.feed(reply(15_000, 5));
    const c = t.snapshot(0)!;
    expect(c.used).toBe(15_005);
    expect(c.setup).toBe(15_000);
    expect(c.conversation + c.tools).toBe(5);
    expect(t.feed({ type: "assistant", message: { id: "x", model: "<synthetic>", usage: { input_tokens: 5 } } })).toBe(false);
  });

  it("knows Sonnet 5.5 has a 1M window, so a session at 200k is not shown as full", () => {
    expect(autoWindow(10_000, "claude-sonnet-5-5")).toBe(1_000_000);
    expect(autoWindow(200_000, "claude-sonnet-5-5")).toBe(1_000_000);
    expect(autoWindow(200_000, "claude-opus-5")).toBe(1_000_000); // unknown model: still not stuck at 100% of 200k
    expect(autoWindow(100_000, "claude-opus-5")).toBe(200_000);
    const t = new ContextTracker();
    t.feed({ type: "assistant", message: { id: "a", model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 1, cache_read_input_tokens: 199_999, cache_creation_input_tokens: 0, output_tokens: 0 } } });
    expect(t.snapshot(0)).toMatchObject({ used: 200_000, window: 1_000_000, windowAuto: true });
    expect(t.snapshot(200_000)).toMatchObject({ window: 200_000, windowAuto: false }); // a pinned size still wins
  });

  it("takes the window from the size Claude Code compacted itself at, so one oversized reply cannot inflate it", () => {
    const t = new ContextTracker();
    t.feed(reply(782_000, 10));
    t.feed(reply(1_526_417, 10)); // a reply whose usage counts the same prefix twice
    expect(t.snapshot(0)!.window).toBe(2_000_000); // before any compaction that is all there is to go on
    t.feed({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 966_898, postTokens: 18_792 } });
    t.feed(reply(300_000, 10));
    expect(t.snapshot(0)).toMatchObject({ used: 300_010, window: 1_000_000, windowAuto: true });
    expect(t.snapshot(200_000)).toMatchObject({ window: 200_000, windowAuto: false });
  });

  it("learns nothing from a compaction the person asked for, and a 200k session compacts near 167k", () => {
    const a = new ContextTracker();
    a.feed(reply(40_000, 10));
    a.feed({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 40_000 } });
    a.feed(reply(10_000, 10));
    expect(a.snapshot(0)!.window).toBe(200_000);
    const b = new ContextTracker();
    b.feed(reply(166_000, 10));
    b.feed({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 167_000 } });
    b.feed(reply(20_000, 10));
    expect(b.snapshot(0)!.window).toBe(200_000);
  });

  it("works out the window from what has been seen unless it is pinned", () => {
    // a context never sits at the very edge of its window (Claude Code compacts at about 84%), so the edge means a bigger one
    expect([1, 180_000, 180_001, 200_000, 900_000, 900_001, 1_526_417, 1_800_000].map((n) => autoWindow(n))).toEqual([200_000, 200_000, 1_000_000, 1_000_000, 1_000_000, 2_000_000, 2_000_000, 2_000_000]);
    expect(autoWindow(2_100_000)).toBe(3_000_000);
    const t = new ContextTracker();
    t.feed(reply(150_000, 10));
    expect(t.snapshot(0)).toMatchObject({ window: 200_000, windowAuto: true });
    expect(t.snapshot(1_000_000)).toMatchObject({ window: 1_000_000, windowAuto: false });
    t.feed(reply(600_000, 10));
    expect(t.snapshot(0)).toMatchObject({ window: 1_000_000 }); // outgrew 200k
  });

  it("is recorded on the session by the reader, and follows the pinned size from Settings", async () => {
    const root = tmp();
    mkdirSync(join(root, "proj"));
    const file = join(root, "proj", "s.jsonl");
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    m.apply({ provider: "claude-code", providerSessionId: "sess", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });
    const s = [...m.sessions.values()][0]!;
    writeFileSync(file, [reply(20_000, 100, [text(10)], { uuid: "a1" }), { type: "user", uuid: "u1", message: { content: "hello" } }, reply(90_000, 300, [text(10)], { uuid: "a2" })].map((o) => JSON.stringify(o)).join("\n") + "\n");
    m.noteTranscript("claude-code", "sess", file);
    m.setContentPolicy({ prompts: false, responses: false, tokens: true, window: 0 });
    const o = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30 });
    await until(() => s.usage?.context !== undefined);
    expect(s.usage!.context).toMatchObject({ used: 90_300, window: 200_000, windowAuto: true, setup: 20_000 });
    m.setContentPolicy({ prompts: false, responses: false, tokens: true, window: 1_000_000 });
    o.refresh();
    await until(() => s.usage?.context?.window === 1_000_000);
    o.stop();
    expect(s.usage!.context).toMatchObject({ window: 1_000_000, windowAuto: false });
  });

  it("the window size is a setting: 0 for automatic, or one of the usual sizes", () => {
    const store = new Store(":memory:");
    expect(store.getSettings().contextWindow).toBe(0);
    store.setSettings({ contextWindow: 1_000_000 });
    expect(store.getSettings().contextWindow).toBe(1_000_000);
    store.setSettings({ contextWindow: 123 });
    expect(store.getSettings().contextWindow).toBe(1_000_000); // not a usual size: ignored
    store.setSettings({ contextWindow: 0 });
    expect(store.getSettings().contextWindow).toBe(0);
  });
});

describe("Claude Code's own /context report", () => {
  const ESC = String.fromCharCode(27);
  // the terminal view, as saved in the conversation file (colour codes included)
  const stdout = [
    `${ESC}[1mContext Usage${ESC}[22m`,
    `${ESC}[37m⛀ ⛁ ⛁ ${ESC}[39m  Sonnet 5.5`,
    `${ESC}[37m839.4k/1m tokens (84%)${ESC}[39m`,
    `${ESC}[37m⛁${ESC}[39m System prompt: ${ESC}[37m2.4k tokens (0.2%)${ESC}[39m`,
    `${ESC}[37m⛁${ESC}[39m System tools: ${ESC}[37m14.6k tokens (1.5%)${ESC}[39m`,
    `${ESC}[96m⛁${ESC}[39m MCP tools: ${ESC}[37m1.8k tokens (0.2%)${ESC}[39m`,
    `${ESC}[91m⛁${ESC}[39m Memory files: ${ESC}[37m830 tokens (0.1%)${ESC}[39m`,
    `${ESC}[95m⛁${ESC}[39m Messages: ${ESC}[37m805.8k tokens (80.6%)${ESC}[39m`,
    `${ESC}[37m⛶${ESC}[39m Free space: ${ESC}[37m127.6k (12.8%)${ESC}[39m`,
    `${ESC}[37m⛝ Autocompact buffer: 33k tokens (3.3%)${ESC}[39m`,
  ].join("\n");
  // the table the assistant is shown
  const table = "## Context Usage\n**Tokens:** 839.4k / 1m (84%)\n| Category | Tokens | Percentage |\n|---|---|---|\n| System prompt | 2.4k | 0.2% |\n| MCP tools (deferred) | 285.5k | 28.5% |\n| Messages | 805.8k | 80.6% |\n| Free space | 127.6k | 12.8% |\n| Autocompact buffer | 33k | 3.3% |";

  it("reads counts like 839.4k and 1m", () => {
    expect(["839.4k", "1m", "729", "127.6k", "2M", "1.5b", "x", ""].map((t) => parseTokenCount(t))).toEqual([839_400, 1_000_000, 729, 127_600, 2_000_000, 1_500_000_000, undefined, undefined]);
  });

  it("reads the terminal view: the window, the used total and each category", () => {
    const r = parseContextReport(stdout)!;
    expect(r.used).toBe(839_400);
    expect(r.window).toBe(1_000_000);
    expect(r.categories.map((c) => [c.name, c.tokens])).toEqual([["System prompt", 2400], ["System tools", 14_600], ["MCP tools", 1800], ["Memory files", 830], ["Messages", 805_800], ["Free space", 127_600], ["Autocompact buffer", 33_000]]);
  });

  it("reads the table too, and ignores text that is not a report", () => {
    const r = parseContextReport(table)!;
    expect(r.window).toBe(1_000_000);
    expect(r.categories.map((c) => c.name)).toEqual(["System prompt", "MCP tools (deferred)", "Messages", "Free space", "Autocompact buffer"]);
    expect(parseContextReport("hello Context Usage but no numbers")).toBeUndefined();
    expect(parseContextReport("839.4k/1m tokens (84%)")).toBeUndefined(); // not headed as a report
  });

  const reply = (prompt: number, output: number) => ({ type: "assistant", message: { id: `m${prompt}`, model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 1, cache_read_input_tokens: prompt - 1, cache_creation_input_tokens: 0, output_tokens: output } } });
  const ran = (text: string) => ({ type: "system", subtype: "local_command", content: text, commandRun: { command: "context", args: "" } });

  it("uses the report in place of the estimate: the real window and categories, grown by what was added since", () => {
    const t = new ContextTracker();
    t.feed(reply(100_000, 10));
    t.feed(reply(800_000, 5_800)); // 805.8k in the window when /context runs
    expect(t.snapshot(0)!.reported).toBeUndefined(); // before the report: an estimate
    t.feed(ran(stdout));
    let c = t.snapshot(0)!;
    expect(c).toMatchObject({ window: 1_000_000, windowAuto: false });
    expect(c.reported!.buffer).toBe(33_000);
    expect(c.reported!.categories.map((x) => x.name)).toEqual(["System prompt", "System tools", "MCP tools", "Memory files", "Messages"]); // free space and the buffer are not "used"
    expect(c.reported!.categories.find((x) => x.name === "Messages")!.tokens).toBe(805_800);
    t.feed(reply(830_000, 4_000)); // 34.2k more in the window since
    c = t.snapshot(0)!;
    expect(c.used).toBe(839_400 + 28_200); // reported total + growth (834,000 now vs 805,800 then)
    expect(c.reported!.categories.find((x) => x.name === "Messages")!.tokens).toBe(805_800 + 28_200);
    expect(c.setup).toBe(c.used - c.conversation);
    expect(c.windowAuto).toBe(false);
  });

  it("drops a report that a compaction made out of date, and the pinned size does not override a real one", () => {
    const t = new ContextTracker();
    t.feed(reply(800_000, 5_800));
    t.feed(ran(stdout));
    expect(t.snapshot(200_000)!.window).toBe(1_000_000); // Claude Code said 1m: that wins over a pinned guess
    t.feed({ type: "system", subtype: "compact_boundary" });
    t.feed(reply(40_000, 100));
    expect(t.snapshot(0)!.reported).toBeUndefined();
    expect(t.snapshot(0)!.used).toBe(40_100);
  });

  it("is recorded on the session with its categories", async () => {
    const root = tmp();
    mkdirSync(join(root, "proj"));
    const file = join(root, "proj", "s.jsonl");
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    m.apply({ provider: "claude-code", providerSessionId: "sess", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });
    const s = [...m.sessions.values()][0]!;
    writeFileSync(file, [reply(800_000, 5_800), ran(stdout)].map((o) => JSON.stringify(o)).join("\n") + "\n");
    m.noteTranscript("claude-code", "sess", file);
    m.setContentPolicy({ prompts: false, responses: false, tokens: true, window: 0 });
    const o = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30 });
    await until(() => s.usage?.context?.reported === true);
    o.stop();
    const c = s.usage!.context!;
    expect(c).toMatchObject({ window: 1_000_000, windowAuto: false, reported: true, buffer: 33_000 });
    expect(c.categories!.map((x) => x.name)).toContain("Skills".slice(0, 0) + "Messages");
    expect(c.categories!.find((x) => x.name === "System tools")!.tokens).toBe(14_600);
  });
});

describe("a question the person turned down (no hook says so)", () => {
  const rejection = (at: string) => ({ type: "user", timestamp: at, message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)." }] } });
  const esc = (at: string) => ({ type: "user", timestamp: at, message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });

  it("recognises Esc and a refusal by their fixed phrases, and nothing else a person could type", () => {
    expect(interruptionOf(esc("2026-10-05T09:40:59.435Z"))).toBe("2026-10-05T09:40:59.435Z");
    expect(interruptionOf({ ...esc("t1"), message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } })).toBe("t1");
    expect(interruptionOf(rejection("t2"))).toBe("t2");
    expect(interruptionOf({ ...esc("t3"), message: { content: [{ type: "text", text: "please [Request interrupted by user for tool use] thanks" }] } })).toBeUndefined();
    expect(interruptionOf({ ...esc("t4"), message: { content: "[Request interrupted by user]" } })).toBeUndefined(); // a typed string, not the block Claude Code writes
    expect(interruptionOf({ ...esc("t5"), isSidechain: true })).toBeUndefined(); // a subagent's own prompt
    expect(interruptionOf({ ...rejection("t6"), message: { content: [{ type: "tool_result", is_error: false, content: "The user doesn't want to proceed with this tool use" }] } })).toBeUndefined();
  });

  const setup = (lines: unknown[], pendingAt: string) => {
    const root = tmp();
    mkdirSync(join(root, "proj"));
    const file = join(root, "proj", "s.jsonl");
    const m = new SessionManager(new Store(":memory:"));
    const base = { provider: "claude-code" as const, providerSessionId: "esc", source: "claude-hook" as const, confidence: "high" as const };
    m.apply({ ...base, kind: "session.started", payload: {} });
    m.apply({ ...base, kind: "approval.requested", occurredAt: pendingAt, payload: { requestId: "r1", kind: "permission", summary: "use ExitPlanMode", toolName: "ExitPlanMode" } });
    const s = [...m.sessions.values()][0]!;
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
    m.noteTranscript("claude-code", "esc", file);
    m.setContentPolicy({ prompts: false, responses: false, tokens: true, window: 0 });
    const o = startTranscriptObserver({ manager: m, diagnostics: new Diagnostics(10, null), root, tickMs: 30 });
    return { m, s, o };
  };

  it("clears the yellow and ends the turn when the person presses Esc at the prompt", async () => {
    const { m, s, o } = setup([esc("2026-10-05T09:40:59.435Z")], "2026-10-05T09:40:32.389Z");
    expect(s.status).toBe("waiting");
    await until(() => s.status !== "waiting");
    o.stop();
    expect(s.status).toBe("idle");
    expect(s.activity).toBe("interrupted");
    expect([...m.requests.values()].every((r) => r.status === "resolved")).toBe(true);
  });

  it("does the same when they answer no", async () => {
    const { s, o } = setup([rejection("2026-10-05T09:40:59.433Z")], "2026-10-05T09:40:32.389Z");
    await until(() => s.status !== "waiting");
    o.stop();
    expect(s.status).toBe("idle");
  });

  it("does not let an older Esc clear a question that was asked after it", async () => {
    const { s, o } = setup([esc("2026-10-05T09:00:00.000Z")], "2026-10-05T09:40:32.389Z");
    await sleep(400);
    o.stop();
    expect(s.status).toBe("waiting");
  });

  it("also acts when it learns of the Esc later (the service started after it happened)", async () => {
    const { s, o } = setup([{ type: "user", timestamp: "2026-10-05T09:39:00.000Z", message: { content: "hi" } }, esc("2026-10-05T09:41:00.000Z"), { type: "system", subtype: "turn_duration", timestamp: "2026-10-05T09:41:00.003Z" }], "2026-10-05T09:40:32.389Z");
    await until(() => s.status !== "waiting");
    o.stop();
    expect(s.status).toBe("idle");
  });
});
