import { describe, expect, it } from "vitest";
import { sanitizeInput } from "@agentwatch/protocol";
import { countPorcelain, descendantsOf, fileObserved, gitSnapshot, parseNumstat, parsePs, processStarted, wrapperStarted } from "../src";

describe("generic adapter evidence", () => {
  const ref = { sessionId: "w1" };
  it("never claims more than the source supports", () => {
    expect(fileObserved(ref, "write", "/a").confidence).toBe("low");
    expect(gitSnapshot(ref, { changedFiles: 1 }).confidence).toBe("low");
    expect(processStarted(ref, { pid: 5, ppid: 1, argv: "git status" }).confidence).toBe("medium");
    expect(wrapperStarted(ref, { executable: "/bin/x", cwd: "/r" }).confidence).toBe("low");
  });
  it("attaches to the wrapper session", () => {
    const e = fileObserved({ sessionId: "w1", provider: "claude-code" }, "write", "/a");
    expect(e.wrapperSessionId).toBe("w1");
    expect(e.provider).toBe("claude-code");
  });
  it("survives sanitizing with the allow-listed fields intact", () => {
    const e = sanitizeInput(processStarted(ref, { pid: 5, ppid: 1, argv: "curl --token abc123 http://x" })).event;
    expect(e.payload.argvDisplay).toBe("curl --token [REDACTED] http://x");
    expect(e.payload.pid).toBe(5);
  });
});

describe("parsers", () => {
  it("parses ps output and finds descendants", () => {
    const rows = parsePs(" 10 1 /bin/zsh\n 20 10 node agent.js --x\n 30 20 pnpm test\n 40 1 launchd\n 50 30 vitest run\n");
    expect(rows).toHaveLength(5);
    expect(descendantsOf(10, rows).map((r) => r.pid)).toEqual([20, 30, 50]);
    expect(descendantsOf(40, rows)).toEqual([]);
  });
  it("sums numstat and tolerates binary files", () => {
    expect(parseNumstat("3\t1\ta.ts\n-\t-\timg.png\n10\t0\tb.ts\n")).toEqual({ files: 3, additions: 13, deletions: 1 });
    expect(parseNumstat("")).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
  it("counts porcelain lines", () => {
    expect(countPorcelain(" M a.ts\n?? b.ts\n")).toBe(2);
    expect(countPorcelain("")).toBe(0);
  });
});
