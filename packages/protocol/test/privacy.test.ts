import { describe, expect, it } from "vitest";
import { clampConfidence, containsForbiddenKey, sanitizeInput, sanitizePayload, type AgentEventInput } from "../src";

describe("sanitizePayload", () => {
  it("drops prompts, file contents and unknown keys", () => {
    const r = sanitizePayload("file.write", {
      path: "/repo/src/a.ts",
      toolName: "Edit",
      new_string: "SECRET CODE",
      old_string: "OLD",
      content: "file body",
      tool_response: "output",
      weird: 1,
    });
    expect(r.payload).toEqual({ path: "/repo/src/a.ts", toolName: "Edit" });
    expect(r.dropped.sort()).toEqual(["content", "new_string", "old_string", "tool_response", "weird"]);
    expect(containsForbiddenKey(r.payload)).toBe(false);
  });

  it("redacts command lines and flags the event", () => {
    const r = sanitizePayload("command.started", {
      commandId: "c1",
      argvDisplay: "curl -H 'Authorization: Bearer abcdef1234567890' http://x",
    });
    expect(r.redacted).toBe(true);
    expect(String(r.payload.argvDisplay)).toContain("[REDACTED]");
    expect(String(r.payload.argvDisplay)).not.toContain("abcdef1234567890");
  });

  it("caps long strings and rejects wrong types", () => {
    const r = sanitizePayload("log", { message: "x".repeat(1000), level: "nope" });
    expect(String(r.payload.message).length).toBeLessThanOrEqual(300);
    expect(r.payload.level).toBeUndefined();
  });

  it("never lets a prompt through any kind", () => {
    for (const kind of ["log", "status.changed", "tool.started", "session.started"] as const) {
      const r = sanitizePayload(kind, { prompt: "hi", user_prompt: "hi", last_assistant_message: "hi" });
      expect(r.payload).toEqual({});
    }
  });
});

describe("confidence ceiling", () => {
  it("does not let filesystem or pty claim more than low", () => {
    expect(clampConfidence("filesystem", "high")).toBe("low");
    expect(clampConfidence("pty", "medium")).toBe("low");
    expect(clampConfidence("process", "high")).toBe("medium");
    expect(clampConfidence("claude-hook", "high")).toBe("high");
  });
  it("applies in sanitizeInput", () => {
    const input: AgentEventInput = {
      provider: "generic",
      providerSessionId: "s",
      kind: "file.write",
      source: "filesystem",
      confidence: "high",
      payload: { path: "/a" },
    };
    expect(sanitizeInput(input).event.confidence).toBe("low");
  });
});
