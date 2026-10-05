import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containsForbiddenKey, sanitizeInput } from "@agentwatch/protocol";
import { claudeHooksConfig, mapClaudeHook, CLAUDE_HOOK_EVENTS } from "../src";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../fixtures/claude/session-with-subagents.json", import.meta.url)), "utf8"),
) as unknown[];

const all = fixture.flatMap((raw) => mapClaudeHook(raw, { now: () => new Date("2026-01-01T00:00:00Z") }));
const sanitized = all.map((e) => sanitizeInput(e));

describe("claude adapter", () => {
  it("maps the lifecycle, tools, commands and subagents", () => {
    const kinds = all.map((e) => e.kind);
    expect(kinds).toContain("session.started");
    expect(kinds).toContain("session.ended");
    expect(kinds).toContain("agent.started");
    expect(kinds).toContain("agent.ended");
    expect(kinds).toContain("command.started");
    expect(kinds).toContain("command.completed");
    expect(kinds).toContain("approval.requested");
    expect(kinds).toContain("tool.failed");
  });

  it("attributes subagent events with agent ids", () => {
    const worker = all.filter((e) => e.providerAgentId === "agent_worker");
    expect(worker.length).toBeGreaterThan(2);
    const main = all.filter((e) => !e.providerAgentId);
    expect(main.some((e) => e.kind === "file.write")).toBe(true);
  });

  it("turns edits into line counts and keeps no contents", () => {
    const write = all.find((e) => e.kind === "file.write");
    expect(write?.payload).toMatchObject({ path: "/Users/dev/work/auth-service/src/auth/session.ts", toolName: "Edit", additions: 4, deletions: 2 });
  });

  it("extracts the exit code of a failed Bash call", () => {
    const done = all.filter((e) => e.kind === "command.completed");
    expect(done.some((e) => e.payload.exitCode === 1)).toBe(true);
  });

  it("never maps UserPromptSubmit", () => {
    expect(mapClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "SENTINEL_PROMPT" })).toEqual([]);
    expect(CLAUDE_HOOK_EVENTS as readonly string[]).not.toContain("UserPromptSubmit");
  });

  it("leaks no sentinel content and redacts credentials after sanitizing", () => {
    const json = JSON.stringify(sanitized.map((s) => s.event));
    expect(json).not.toContain("SENTINEL");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("abcdef1234567890xyz");
    expect(json).toContain("[REDACTED]");
    for (const s of sanitized) expect(containsForbiddenKey(s.event.payload)).toBe(false);
  });

  it("ignores payloads it does not understand", () => {
    expect(mapClaudeHook(null)).toEqual([]);
    expect(mapClaudeHook({ hook_event_name: "SomethingNew", session_id: "s" })).toEqual([]);
    expect(mapClaudeHook({ hook_event_name: "PreToolUse" })).toEqual([]);
  });

  it("builds an observer-only hooks config", () => {
    const cfg = claudeHooksConfig("agentwatch hook claude");
    expect(Object.keys(cfg.hooks)).toEqual([...CLAUDE_HOOK_EVENTS]);
    expect(cfg.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: "agentwatch hook claude", timeout: 5 }] }]);
  });

  it("takes the short label of a subagent task as its name and never reads the task prompt", () => {
    const raw = {
      hook_event_name: "PreToolUse",
      session_id: "s",
      tool_name: "Task",
      tool_use_id: "toolu_t1",
      tool_input: { description: "Repair account-switch claims\nsecond line is dropped", prompt: "SENTINEL-TASK-PROMPT-BODY please do the whole thing", subagent_type: "web-dev" },
    };
    const [started] = mapClaudeHook(raw);
    expect(started!.kind).toBe("tool.started");
    expect(started!.payload).toMatchObject({ taskLabel: "Repair account-switch claims", subagentType: "web-dev" });
    const stored = sanitizeInput(started!);
    expect(JSON.stringify(stored)).not.toContain("SENTINEL-TASK-PROMPT-BODY");
    expect(stored.event.payload.taskLabel).toBe("Repair account-switch claims");
    // an ordinary tool gets no label
    expect(mapClaudeHook({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Read", tool_input: { file_path: "/a", description: "not a task" } })[0]!.payload.taskLabel).toBeUndefined();
  });
});
