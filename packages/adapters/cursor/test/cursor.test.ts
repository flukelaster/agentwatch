import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containsForbiddenKey, sanitizeInput } from "@agentwatch/protocol";
import { CURSOR_HOOK_EVENTS, cursorHooksConfig, mapCursorHook } from "../src";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../fixtures/cursor/hooks-session.json", import.meta.url)), "utf8")) as unknown[];
const all = fixture.flatMap((raw) => mapCursorHook(raw, { now: () => new Date("2026-01-01T00:00:00Z") }));

describe("cursor adapter", () => {
  it("maps lifecycle, completed tools, shell commands and file edits into one session", () => {
    const kinds = all.map((e) => e.kind);
    for (const k of ["session.started", "session.ended", "tool.completed", "tool.failed", "command.started", "command.completed", "file.write", "status.changed"]) expect(kinds).toContain(k);
    expect(all.every((e) => e.provider === "cursor" && e.source === "cursor-hook" && e.providerSessionId === "c-conv-1")).toBe(true);
    expect(all[0]?.cwd).toBe("/Users/dev/work/web");
  });

  it("counts edited lines and claims no exit code it was not given", () => {
    expect(all.find((e) => e.kind === "file.write")?.payload).toMatchObject({ path: "/Users/dev/work/web/src/App.tsx", additions: 3, deletions: 1 });
    const done = all.find((e) => e.kind === "command.completed");
    expect(done?.payload).not.toHaveProperty("exitCode");
    expect(done?.payload.commandId).toBe(all.find((e) => e.kind === "command.started")?.payload.commandId);
  });

  it("does not map the events that carry prompts, replies or file contents", () => {
    const text = JSON.stringify(all.map((e) => sanitizeInput(e)));
    expect(text).not.toMatch(/SECRET/);
    for (const e of all) expect(containsForbiddenKey(e.payload)).toBe(false);
  });

  it("subscribes only to events that report finished work, never to the allow/deny ones", () => {
    const cfg = cursorHooksConfig("sh /x/agentwatch-hook.sh cursor");
    expect(Object.keys(cfg.hooks).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());
    for (const blocking of ["beforeSubmitPrompt", "preToolUse", "beforeShellExecution", "beforeReadFile", "beforeMCPExecution"]) expect(cfg.hooks).not.toHaveProperty(blocking);
    expect(cfg.hooks.postToolUse).toEqual([{ command: "sh /x/agentwatch-hook.sh cursor" }]);
  });

  it("ignores payloads it cannot place", () => {
    expect(mapCursorHook({ hook_event_name: "postToolUse", tool_name: "Read" })).toEqual([]);
    expect(mapCursorHook({ conversation_id: "x" })).toEqual([]);
    expect(mapCursorHook(undefined)).toEqual([]);
  });
});
