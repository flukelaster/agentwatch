import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const CWD = fileURLToPath(new URL("..", import.meta.url));

function run(args: string[], env: Record<string, string>, entry = MAIN) {
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], { cwd: CWD, env: { ...process.env, ...env }, encoding: "utf8" });
}

describe("agentwatch setup / install-cli (throwaway HOME)", () => {
  it("reports status, applies and reverts without touching anything outside HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "awh-"));
    try {
      mkdirSync(join(home, ".claude"));
      const env = { HOME: home, AGENTWATCH_HOME: join(home, "data"), AGENTWATCH_CLI_SCRIPT: MAIN };
      const before = JSON.parse(run(["setup", "status", "--json"], env).stdout);
      expect(before.claude).toMatchObject({ detected: true, hooks: { state: "missing" } });
      expect(before.autostart.state).toBe("unavailable"); // no app executable given

      const applied = run(["setup", "apply", "claude", "cli", "--json"], env);
      expect(applied.status).toBe(0);
      const out = JSON.parse(applied.stdout);
      expect(out.map((r: { item: string; ok: boolean }) => [r.item, r.ok])).toEqual([["claude", true], ["cli", true]]);
      expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toContain("hook.sh");
      expect(existsSync(join(home, ".local", "bin", "agentwatch"))).toBe(true);
      expect(JSON.parse(run(["setup", "status", "--json"], env).stdout).claude.hooks.state).toBe("installed");

      expect(run(["setup", "revert", "claude", "cli"], env).status).toBe(0);
      expect(existsSync(join(home, ".local", "bin", "agentwatch"))).toBe(false);
      expect(JSON.parse(run(["setup", "status", "--json"], env).stdout).claude.hooks.state).toBe("missing");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it("the launcher it installs actually runs the CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "awh-"));
    try {
      // a stand-in CLI script: proves the launcher passes arguments through and uses the named runtime
      const script = join(home, "fake-cli.mjs");
      writeFileSync(script, 'console.log("args:" + process.argv.slice(2).join(","));\n');
      const env = { HOME: home, AGENTWATCH_HOME: join(home, "data"), AGENTWATCH_CLI_SCRIPT: script, AGENTWATCH_NODE: process.execPath };
      expect(run(["setup", "apply", "cli"], env).status).toBe(0);
      const r = spawnSync(join(home, ".local", "bin", "agentwatch"), ["status", "--x"], { encoding: "utf8" });
      expect(r.stdout.trim()).toBe("args:status,--x");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it("still prints output when started under another name (regression: it used to exit silently)", () => {
    const dir = mkdtempSync(join(tmpdir(), "awl-"));
    try {
      const link = join(dir, "agentwatch");
      symlinkSync(MAIN, link);
      const out = execFileSync(process.execPath, ["--import", "tsx", link, "help"], { cwd: CWD, encoding: "utf8" });
      expect(out).toContain("local-only monitor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
