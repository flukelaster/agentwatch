import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Diagnostics } from "../src/diagnostics";
import { Store } from "../src/db/store";
import { isSafeRoot, startObservers } from "../src/observers";
import { SessionManager } from "../src/session-manager";
import type { AgentEvent } from "@agentwatch/protocol";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const waitFor = async (cond: () => boolean, ms = 6000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("observer safety", () => {
  it("refuses roots that are too broad", () => {
    expect(isSafeRoot("/")).toBe(false);
    expect(isSafeRoot(homedir())).toBe(false);
    expect(isSafeRoot("/Users")).toBe(false);
    expect(isSafeRoot(join(homedir(), "work", "proj"))).toBe(true);
  });
});

describe("filesystem + git observers", () => {
  it("reports observed changes as low-confidence, baselines dirty state, and summarizes the diff", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "awobs-")));
    dirs.push(repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "one\n");
    writeFileSync(join(repo, "dirty.txt"), "pre-existing\n");
    git("add", "src/a.ts");
    git("commit", "-q", "-m", "init"); // dirty.txt stays untracked: already dirty before the session starts

    const store = new Store(":memory:");
    const manager = new SessionManager(store);
    const events: AgentEvent[] = [];
    manager.on("event", (e: AgentEvent) => events.push(e));
    const obs = startObservers({ manager, diagnostics: new Diagnostics(50, null), gitDebounceMs: 150 });
    try {
      manager.ingest({ provider: "generic", providerSessionId: "w1", wrapperSessionId: "w1", kind: "session.started", source: "pty", confidence: "low", cwd: repo, payload: { cwd: repo } });
      await waitFor(() => events.some((e) => e.kind === "git.changed" && e.payload.baseline === true));
      const base = events.find((e) => e.kind === "git.changed" && e.payload.baseline === true)!;
      expect(base.payload.dirtyAtStart).toBe(1); // dirty.txt, not credited to anyone
      expect(base.confidence).toBe("low");

      appendFileSync(join(repo, "src", "a.ts"), "two\nthree\n");
      await waitFor(() => events.some((e) => e.kind === "file.write" && e.source === "filesystem"));
      const w = events.find((e) => e.kind === "file.write" && e.source === "filesystem")!;
      expect(w.confidence).toBe("low");
      expect(String(w.payload.path)).toContain("src/a.ts");

      await waitFor(() => events.some((e) => e.kind === "git.changed" && e.payload.baseline !== true));
      const g = events.filter((e) => e.kind === "git.changed" && e.payload.baseline !== true).pop()!;
      expect(g.payload).toMatchObject({ changedFiles: 1, additions: 2, deletions: 0 });
      expect(g.source).toBe("git");

      // the file watcher result stays unattributed in the file view
      const files = store.queryFiles({ sessionId: "w1" });
      const row = files.find((f) => f.path.endsWith("src/a.ts"))!;
      expect(row.confidence).toBe("low");
      expect(row.agentName).toBeUndefined();
    } finally {
      await obs.stop();
    }
  }, 20000);
});
