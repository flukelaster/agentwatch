import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containsForbiddenKey, sanitizeInput } from "@agentwatch/protocol";
import { GEMINI_HOOK_EVENTS, geminiHooksConfig, mapGeminiHook } from "../src";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../fixtures/gemini/hooks-session.json", import.meta.url)), "utf8")) as unknown[];
const all = fixture.flatMap((raw) => mapGeminiHook(raw, { now: () => new Date("2026-01-01T00:00:00Z") }));

describe("gemini adapter", () => {
  it("maps the lifecycle, turns, tools, commands and edits", () => {
    const kinds = all.map((e) => e.kind);
    for (const k of ["session.started", "session.ended", "status.changed", "tool.started", "tool.completed", "tool.failed", "command.started", "command.completed", "file.read", "file.write", "log"]) expect(kinds).toContain(k);
    expect(all.every((e) => e.provider === "gemini-cli" && e.source === "gemini-hook" && e.providerSessionId === "g-sess-1")).toBe(true);
  });

  it("marks a turn running at BeforeAgent and idle at AfterAgent", () => {
    const status = all.filter((e) => e.kind === "status.changed").map((e) => e.payload.status);
    expect(status).toEqual(["running", "idle"]);
  });

  it("counts edited lines and keeps no contents", () => {
    expect(all.find((e) => e.kind === "file.write")?.payload).toMatchObject({ path: "/Users/dev/work/api/src/session.ts", toolName: "replace", additions: 3, deletions: 2 });
    expect(all.find((e) => e.kind === "file.read")?.payload).toMatchObject({ path: "/Users/dev/work/api/src/session.ts" });
  });

  it("pairs a call's start and end through the same id, and reports a tool error as a failed command", () => {
    const started = all.find((e) => e.kind === "command.started");
    const done = all.find((e) => e.kind === "command.completed");
    expect(started?.payload).toMatchObject({ argvDisplay: "pnpm test" });
    expect(done?.payload).toMatchObject({ exitCode: 1 });
    expect(done?.payload.commandId).toBe(started?.payload.commandId);
    expect(all.find((e) => e.kind === "tool.failed")?.payload.error).toBe("Command failed with exit code 1");
  });

  it("never carries prompts, replies, file bodies or stderr", () => {
    const text = JSON.stringify(all.map((e) => sanitizeInput(e)));
    expect(text).not.toMatch(/SECRET/);
    for (const e of all) expect(containsForbiddenKey(e.payload)).toBe(false);
  });

  it("ignores events it does not know and payloads without a session", () => {
    expect(mapGeminiHook({ hook_event_name: "PreCompress", session_id: "x" })).toEqual([]);
    expect(mapGeminiHook({ hook_event_name: "BeforeTool", tool_name: "read_file" })).toEqual([]);
    expect(mapGeminiHook(null)).toEqual([]);
  });

  it("writes the nested entry shape Gemini reads, and nothing that can block", () => {
    const cfg = geminiHooksConfig("sh /x/agentwatch-hook.sh gemini");
    expect(Object.keys(cfg.hooks).sort()).toEqual([...GEMINI_HOOK_EVENTS].sort());
    expect(cfg.hooks.BeforeTool).toEqual([{ hooks: [{ type: "command", command: "sh /x/agentwatch-hook.sh gemini" }] }]);
  });
});
