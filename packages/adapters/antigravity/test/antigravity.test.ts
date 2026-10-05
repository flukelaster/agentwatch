import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { containsForbiddenKey, sanitizeInput } from "@agentwatch/protocol";
import { ANTIGRAVITY_HOOK_EVENTS, antigravityHooksConfig, mapAntigravityHook } from "../src";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../fixtures/antigravity/hooks-session.json", import.meta.url)), "utf8")) as unknown[];
const all = fixture.flatMap((raw) => mapAntigravityHook(raw, { now: () => new Date("2026-01-01T00:00:00Z") }));
const CONV = "ec33ebf9-0cba-4100-8142-c61503f6c587";

describe("antigravity adapter", () => {
  it("tells the three subscribed events apart by the field only each carries", () => {
    expect(all.filter((e) => e.kind === "status.changed").map((e) => e.payload.status)).toEqual(["running", "idle"]);
    expect(all.every((e) => e.provider === "antigravity" && e.source === "antigravity-hook" && e.providerSessionId === CONV)).toBe(true);
    expect(all[0]?.cwd).toBe("/Users/dev/work/site");
  });

  it("maps finished tools, commands and file writes", () => {
    const kinds = all.map((e) => e.kind);
    for (const k of ["tool.completed", "tool.failed", "command.started", "command.completed", "file.write"]) expect(kinds).toContain(k);
    expect(all.find((e) => e.kind === "file.write")?.payload).toMatchObject({ path: "/Users/dev/work/site/app.js", toolName: "write_to_file", additions: 3 });
  });

  it("writes a command's start and end together and reads the exit code from the error", () => {
    const starts = all.filter((e) => e.kind === "command.started");
    const ends = all.filter((e) => e.kind === "command.completed");
    expect(starts.map((e) => e.payload.argvDisplay)).toEqual(["npm test", "npm run build"]);
    expect(ends.map((e) => e.payload.exitCode)).toEqual([0, 2]);
    expect(ends.map((e) => e.payload.commandId)).toEqual(starts.map((e) => e.payload.commandId));
    expect(new Set(starts.map((e) => e.payload.commandId)).size).toBe(2);
  });

  it("never carries file contents or the model's text", () => {
    const text = JSON.stringify(all.map((e) => sanitizeInput(e)));
    expect(text).not.toContain("SECRET-CODE");
    for (const e of all) expect(containsForbiddenKey(e.payload)).toBe(false);
  });

  it("ignores payloads it cannot place", () => {
    expect(mapAntigravityHook({ stepIdx: 1 })).toEqual([]);
    expect(mapAntigravityHook({ conversationId: "x", something: 1 })).toEqual([]);
    expect(mapAntigravityHook(null)).toEqual([]);
  });

  it("subscribes only to events whose answer is not a decision, in the shapes agy reads", () => {
    const cfg = antigravityHooksConfig("sh /x/agentwatch-hook.sh antigravity");
    expect(Object.keys(cfg.hooks).sort()).toEqual([...ANTIGRAVITY_HOOK_EVENTS].sort());
    expect(cfg.hooks).not.toHaveProperty("PreToolUse");
    expect(cfg.hooks).not.toHaveProperty("PostInvocation");
    const h = { type: "command", command: "sh /x/agentwatch-hook.sh antigravity", timeout: 5 };
    expect(cfg.hooks.PreInvocation).toEqual([h]); // flat
    expect(cfg.hooks.Stop).toEqual([h]); // flat
    expect(cfg.hooks.PostToolUse).toEqual([{ matcher: "*", hooks: [h] }]); // grouped
  });
});
