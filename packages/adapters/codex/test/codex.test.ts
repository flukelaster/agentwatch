import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containsForbiddenKey, sanitizeInput, type AgentEventInput } from "@agentwatch/protocol";
import { CodexAppServerMapper, codexHooksConfig, mapCodexExecLine, mapCodexHook } from "../src";
import { diffStat, summarizePatch } from "../src/patch";

const fx = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../fixtures/codex/${name}`, import.meta.url)), "utf8");
const hooks = JSON.parse(fx("hooks-session.json")) as unknown[];
const lines = (name: string) => fx(name).trim().split("\n").map((l) => JSON.parse(l) as unknown);

const noLeak = (events: AgentEventInput[]) => {
  const s = events.map((e) => sanitizeInput(e));
  const json = JSON.stringify(s.map((x) => x.event));
  expect(json).not.toContain("SENTINEL");
  expect(json).not.toContain("abc123secret");
  for (const x of s) expect(containsForbiddenKey(x.event.payload)).toBe(false);
};

describe("patch summaries", () => {
  it("returns per-file metadata only", () => {
    const f = summarizePatch(hooks.map((h) => (h as { tool_input?: { command?: string } }).tool_input?.command).find((c) => c?.includes("Update File")));
    expect(f).toEqual([
      { path: "src/invoice/totals.ts", op: "update", additions: 2, deletions: 1 },
      { path: "src/invoice/new.ts", op: "add", additions: 1, deletions: 0 },
    ]);
    expect(diffStat("--- a\n+++ b\n-x\n+y\n+z\n")).toEqual({ additions: 2, deletions: 1 });
    expect(summarizePatch(undefined)).toEqual([]);
  });
});

describe("codex hooks", () => {
  const all = hooks.flatMap((h) => mapCodexHook(h));
  it("maps lifecycle, patches, commands, approvals and subagents", () => {
    const kinds = all.map((e) => e.kind);
    for (const k of ["session.started", "session.ended", "file.write", "command.started", "command.completed", "approval.requested", "agent.started", "agent.ended"] as const) {
      expect(kinds).toContain(k);
    }
    const writes = all.filter((e) => e.kind === "file.write").map((e) => e.payload);
    expect(writes).toContainEqual(expect.objectContaining({ path: "src/invoice/totals.ts", additions: 2, deletions: 1 }));
    expect(all.every((e) => e.source === "codex-hook")).toBe(true);
  });
  it("never maps prompts and leaks no content", () => {
    expect(mapCodexHook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "SENTINEL" })).toEqual([]);
    noLeak(all);
  });
  it("builds an observer-only hooks config", () => {
    const c = codexHooksConfig("agentwatch hook codex");
    expect(c.hooks.PreToolUse).toEqual([{ matcher: ".*", hooks: [{ type: "command", command: "agentwatch hook codex", timeout: 3 }] }]);
  });
});

describe("codex app server mapper", () => {
  const mapper = new CodexAppServerMapper();
  const all = lines("app-server.jsonl").flatMap((m) => mapper.map(m));
  it("maps commands, file changes, usage and approvals", () => {
    const kinds = all.map((e) => e.kind);
    for (const k of ["session.started", "command.started", "command.completed", "file.write", "file.delete", "approval.requested", "approval.resolved", "usage.updated"] as const) {
      expect(kinds).toContain(k);
    }
    const usage = all.find((e) => e.kind === "usage.updated")!;
    expect(usage.payload).toMatchObject({ inputTokens: 48200, outputTokens: 13200, cachedInputTokens: 31000, reasoningTokens: 4100, scope: "thread", providerReported: true });
    const done = all.find((e) => e.kind === "command.completed")!;
    expect(done.payload).toMatchObject({ exitCode: 0, durationMs: 6100 });
  });
  it("treats a child thread as a subagent of the root session", () => {
    const started = all.find((e) => e.kind === "agent.started");
    expect(started?.providerSessionId).toBe("thr_main");
    expect(started?.providerAgentId).toBe("thr_child");
    const childTool = all.find((e) => e.providerAgentId === "thr_child" && e.kind === "tool.completed");
    expect(childTool?.providerSessionId).toBe("thr_main");
  });
  it("flags a waiting status from activeFlags", () => {
    const w = all.find((e) => e.kind === "status.changed" && e.payload.status === "waiting");
    expect(w).toBeDefined();
  });
  it("leaks no content (prompts, output deltas, messages, patches)", () => noLeak(all));
});

describe("codex exec --json", () => {
  const state: { threadId?: string } = {};
  const all = lines("exec-json.jsonl").flatMap((l) => mapCodexExecLine(l, {}, state));
  it("maps the stream and ignores agent messages", () => {
    expect(all.map((e) => e.kind)).toEqual(["session.started", "status.changed", "command.started", "command.completed", "file.write", "usage.updated", "status.changed"]);
    noLeak(all);
  });
});
