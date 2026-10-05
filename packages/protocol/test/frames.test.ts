import { describe, expect, it } from "vitest";
import { ClientFrameSchema, parseEventInput } from "../src";

describe("ClientFrameSchema", () => {
  it("accepts hello and rejects short tokens", () => {
    expect(ClientFrameSchema.safeParse({ type: "hello", protocol: 1, token: "abcdefgh12" }).success).toBe(true);
    expect(ClientFrameSchema.safeParse({ type: "hello", protocol: 1, token: "x" }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ type: "hello", protocol: 2, token: "abcdefgh12" }).success).toBe(false);
  });
  it("rejects unknown query names", () => {
    expect(ClientFrameSchema.safeParse({ type: "query", id: "1", name: "drop-tables" }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ type: "query", id: "1", name: "sessions" }).success).toBe(true);
  });
});

describe("parseEventInput", () => {
  it("validates adapter output", () => {
    const e = parseEventInput({
      provider: "claude-code",
      providerSessionId: "s1",
      kind: "tool.started",
      source: "claude-hook",
      confidence: "high",
      payload: { toolName: "Bash" },
    });
    expect(e.kind).toBe("tool.started");
    expect(() => parseEventInput({ provider: "x" })).toThrow();
  });
});
