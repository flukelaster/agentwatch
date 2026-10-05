import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containsForbiddenKey } from "@agentwatch/protocol";
import { loadConfig } from "../../../services/daemon/src/config";
import { startDaemon, type RunningDaemon } from "../../../services/daemon/src/daemon";
import { eventsForHook } from "../src/hook";
import { generateHooks, isOurs, mergeHooks, readJsonFile, removeHooks, writeJsonWithBackup } from "@agentwatch/setup";

const run = promisify(execFile);
const claudeFixture = readFileSync(fileURLToPath(new URL("../../../fixtures/claude/session-with-subagents.json", import.meta.url)), "utf8");
const payloads = JSON.parse(claudeFixture) as unknown[];
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

describe("hook forwarder (pure)", () => {
  it("emits sanitized events only", () => {
    const events = payloads.flatMap((p) => eventsForHook("claude", JSON.stringify(p), {}));
    expect(events.length).toBeGreaterThan(10);
    const json = JSON.stringify(events);
    expect(json).not.toContain("SENTINEL");
    expect(json).not.toContain("hunter2");
    for (const e of events) expect(containsForbiddenKey(e.payload)).toBe(false);
  });
  it("joins a wrapper session when AGENTWATCH_SESSION_ID is set", () => {
    const [e] = eventsForHook("claude", JSON.stringify(payloads[0]), { AGENTWATCH_SESSION_ID: "wrap-1" });
    expect(e?.wrapperSessionId).toBe("wrap-1");
  });
  it("ignores garbage", () => {
    expect(eventsForHook("claude", "not json", {})).toEqual([]);
    expect(eventsForHook("codex", "{}", {})).toEqual([]);
  });
});

describe("hook installation", () => {
  const cmd = "node /x/agentwatch.mjs hook claude";
  const theirs = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./their-guard.sh" }] }] }, model: "x" };

  it("merges without touching other hooks, and is idempotent", () => {
    const once = mergeHooks(theirs, "claude", cmd);
    const twice = mergeHooks(once, "claude", cmd);
    expect(twice).toEqual(once);
    const pre = (once.hooks as Record<string, unknown[]>).PreToolUse!;
    expect(pre).toHaveLength(2);
    expect(pre[0]).toEqual(theirs.hooks.PreToolUse[0]);
    expect(isOurs(pre[1], "claude")).toBe(true);
    expect(once.model).toBe("x");
    expect(Object.keys(once.hooks as object)).not.toContain("UserPromptSubmit");
  });
  it("removes only our entries", () => {
    const back = removeHooks(mergeHooks(theirs, "claude", cmd), "claude");
    expect(back).toEqual(theirs);
    expect(removeHooks(mergeHooks({}, "claude", cmd), "claude")).toEqual({});
  });
  it("does not mistake a lookalike for ours", () => {
    expect(isOurs({ hooks: [{ command: "./their-guard.sh hook claude" }] }, "claude")).toBe(false);
  });
  it("backs up and writes atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "awi-"));
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, JSON.stringify(theirs));
      const backup = writeJsonWithBackup(path, mergeHooks(readJsonFile(path), "claude", cmd));
      expect(backup && existsSync(backup)).toBe(true);
      expect(JSON.parse(readFileSync(backup!, "utf8"))).toEqual(theirs);
      expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).hooks)).toContain("SessionStart");
      expect(readdirSync(dir).filter((f) => f.includes("tmp"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("generates the documented structure", () => {
    expect(generateHooks("codex", "agentwatch hook codex").hooks.SessionStart).toEqual([{ matcher: ".*", hooks: [{ type: "command", command: "agentwatch hook codex", timeout: 3 }] }]);
  });
});

describe("end to end through real processes", () => {
  let dir: string;
  let daemon: RunningDaemon;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "awe-"));
    daemon = await startDaemon(loadConfig({ AGENTWATCH_HOME: dir }), { quiet: true, observers: false });
  });
  afterEach(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, AGENTWATCH_HOME: dir });

  it("pipes a hook payload through the CLI into SQLite and exits 0", async () => {
    for (const p of payloads) {
      const child = spawn(process.execPath, ["--import", "tsx", MAIN, "hook", "claude"], { env: env(), stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stdin.end(JSON.stringify(p));
      const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
      expect(code).toBe(0);
      expect(out).toBe(""); // observer prints nothing
    }
    expect(daemon.manager.sessions.size).toBe(1);
    const s = [...daemon.manager.sessions.values()][0]!;
    expect(s.status).toBe("finished");
    expect(s.counts.failedCommands).toBe(1);
    const dump = JSON.stringify(daemon.store.queryEvents({ limit: 5000 }));
    expect(dump).not.toContain("SENTINEL");
  }, 60000);

  it("exits 0 and stays silent when the daemon is down", async () => {
    await daemon.stop();
    const child = spawn(process.execPath, ["--import", "tsx", MAIN, "hook", "claude"], { env: env(), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(JSON.stringify(payloads[0]));
    const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
    expect(code).toBe(0);
    daemon = await startDaemon(loadConfig({ AGENTWATCH_HOME: dir }), { quiet: true, observers: false }); // for afterEach
  }, 30000);

  it("wraps a process in a PTY, preserves the exit code and records the session", async () => {
    const { stdout } = await run(process.execPath, ["--import", "tsx", MAIN, "status"], { env: env() });
    expect(JSON.parse(stdout).version).toBe("0.1.0");

    const child = spawn(process.execPath, ["--import", "tsx", MAIN, "run", "--", "/bin/sh", "-c", "echo wrapped-output; exit 3"], { env: env(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stdin.end();
    const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
    expect(code).toBe(3);
    expect(out).toContain("wrapped-output"); // the terminal output reaches the user unchanged
    await new Promise((r) => setTimeout(r, 200));
    const s = [...daemon.manager.sessions.values()].find((x) => x.provider === "generic")!;
    expect(s.executable).toBe("/bin/sh");
    expect(s.status).toBe("failed");
    expect(s.exitCode).toBe(3);
    // the output text itself is never stored
    expect(JSON.stringify(daemon.store.queryEvents({ limit: 5000 }))).not.toContain("wrapped-output");
  }, 60000);
});
