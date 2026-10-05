import { describe, expect, it } from "vitest";
import { countLines, makeEvent, pathOf } from "../src";

describe("sdk helpers", () => {
  it("counts lines without keeping text", () => {
    expect(countLines("a\nb\nc")).toBe(3);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("")).toBe(0);
    expect(countLines(undefined)).toBe(0);
  });
  it("finds a path field", () => {
    expect(pathOf({ file_path: "/a" })).toBe("/a");
    expect(pathOf({ notebook_path: "/n.ipynb" })).toBe("/n.ipynb");
    expect(pathOf({})).toBeUndefined();
  });
  it("makeEvent clamps confidence to what the source supports", () => {
    const e = makeEvent(
      { provider: "generic", providerSessionId: "s", kind: "file.write", source: "filesystem", confidence: "high", payload: { path: "/a" } },
      { now: () => new Date("2026-01-01T00:00:00Z"), wrapperSessionId: "w1" },
    );
    expect(e.confidence).toBe("low");
    expect(e.wrapperSessionId).toBe("w1");
    expect(e.occurredAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
