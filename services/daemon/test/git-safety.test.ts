import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: () => {
    throw Object.assign(new Error("spawn EBADF"), { code: "EBADF", syscall: "spawn" });
  },
}));

describe("git observer when spawn itself throws", () => {
  it("returns nothing, reports the cause, and never throws into the daemon", async () => {
    const { gitBranch, gitDirtyCount, onGitError } = await import("../src/observers/git");
    const seen: string[] = [];
    onGitError((m) => seen.push(m));
    await expect(gitBranch("/tmp")).resolves.toBeUndefined();
    await expect(gitDirtyCount("/tmp")).resolves.toBeDefined();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatch(/EBADF/);
  });
});
