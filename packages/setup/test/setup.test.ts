import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isOurs, mergeHooks, removeHooks } from "../src/hooks";
import { ITEMS, appLocationProblem, hookCommand, hooksPath, setupApply, setupRepair, setupRevert, setupStatus, type SetupContext } from "../src/setup";
import { contextFromEnv } from "../src/env";
import { buildPlist } from "../src/launchagent";
import { launcherScript } from "../src/launcher";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function ctx(over: Partial<SetupContext> = {}): SetupContext & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "aws-"));
  dirs.push(dir);
  const script = join(dir, "agentwatch.mjs");
  writeFileSync(script, "// cli\n");
  return { home: dir, agentwatchHome: join(dir, "Library", "Application Support", "AgentWatch"), cli: { node: "/opt/aw/node", script }, appExe: "/Applications/AgentWatch.app/Contents/MacOS/agentwatch-desktop", dir, ...over };
}

describe("hook ownership", () => {
  it("recognises both forwarder generations, and nothing that merely looks similar", () => {
    const e = (command: string) => ({ hooks: [{ type: "command", command }] });
    expect(isOurs(e(`node "/x/dist/agentwatch.mjs" hook claude`), "claude")).toBe(true);
    expect(isOurs(e(`sh "/Users/x/Library/Application Support/AgentWatch/hook.sh" claude`), "claude")).toBe(true);
    expect(isOurs(e(`sh "/Users/x/Library/Application Support/AgentWatch/hook.sh" codex`), "claude")).toBe(false);
    expect(isOurs(e(`./their-guard.sh hook claude`), "claude")).toBe(false);
    expect(isOurs(e(`sh "/opt/other/hook.sh" claude`), "claude")).toBe(false);
  });

  it("an upgrade replaces the old Node entry instead of doubling events", () => {
    const old = mergeHooks({}, "claude", `node "/x/dist/agentwatch.mjs" hook claude`);
    const next = mergeHooks(old, "claude", `sh "/h/AgentWatch/hook.sh" claude`);
    for (const entries of Object.values(next.hooks as Record<string, unknown[]>)) expect(entries).toHaveLength(1);
    expect(JSON.stringify(next)).not.toContain("agentwatch.mjs");
    expect(removeHooks(next, "claude")).toEqual({});
  });
});

describe("setupStatus on a fresh machine", () => {
  it("reports everything missing and what it detected", () => {
    const c = ctx();
    mkdirSync(join(c.home, ".claude"));
    const s = setupStatus(c);
    expect(s.claude).toMatchObject({ detected: true, hooks: { state: "missing" } });
    expect(s.codex).toMatchObject({ detected: false, hooks: { state: "missing" } });
    expect(s.cli.state).toBe("missing");
    expect(s.autostart.state).toBe("missing");
    expect(s.managed).toBe(true);
  });

  it("marks cli and autostart unavailable when this build cannot offer them", () => {
    const s = setupStatus(ctx({ cli: undefined, appExe: undefined }));
    expect(s.cli.state).toBe("unavailable");
    expect(s.autostart.state).toBe("unavailable");
    expect(s.managed).toBe(false);
  });
});

describe("setupApply / setupRevert", () => {
  it("installs everything, reports each item, and is idempotent (no extra backups)", () => {
    const c = ctx();
    const first = setupApply(c, ITEMS);
    expect(first.every((r) => r.ok)).toBe(true);
    expect(first.every((r) => r.changed)).toBe(true);
    const s = setupStatus(c);
    expect(s.claude.hooks.state).toBe("installed");
    expect(s.codex.hooks.state).toBe("installed");
    expect(s.cli.state).toBe("installed");
    expect(s.autostart.state).toBe("installed");
    expect(readFileSync(s.cli.path, "utf8")).toBe(launcherScript(c.cli!.node, c.cli!.script));
    expect(statSync(s.cli.path).mode & 0o111).not.toBe(0);
    expect(readFileSync(s.autostart.path, "utf8")).toBe(buildPlist({ label: "dev.agentwatch.app", program: [c.appExe!, "--hidden"] }));

    const backupsBefore = readdirSync(join(c.home, ".claude")).length;
    const second = setupApply(c, ITEMS);
    expect(second.every((r) => r.ok && !r.changed)).toBe(true);
    expect(readdirSync(join(c.home, ".claude")).length).toBe(backupsBefore);
  });

  it("keeps the user's own settings and hooks, and backs up the file it edits", () => {
    const c = ctx();
    const path = hooksPath(c, "claude");
    mkdirSync(join(c.home, ".claude"));
    const theirs = { model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }] } };
    writeFileSync(path, JSON.stringify(theirs));
    const [r] = setupApply(c, ["claude"]);
    expect(r!.backup && existsSync(r!.backup)).toBe(true);
    expect(JSON.parse(readFileSync(r!.backup!, "utf8"))).toEqual(theirs);
    const merged = JSON.parse(readFileSync(path, "utf8"));
    expect(merged.model).toBe("x");
    expect(merged.hooks.PreToolUse[0]).toEqual(theirs.hooks.PreToolUse[0]);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(Object.keys(merged.hooks)).not.toContain("UserPromptSubmit");
    // and revert restores exactly the user's content
    const [rv] = setupRevert(c, ["claude"]);
    expect(rv!.changed).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(theirs);
  });

  it("adds Gemini hooks beside the ones another tool put there, and revert gives the file back as it was", () => {
    const c = ctx();
    const path = hooksPath(c, "gemini");
    mkdirSync(join(c.home, ".gemini"));
    const theirs = { general: { sessionRetention: { enabled: true } }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/Users/x/.superset/hooks/gemini-hook.sh" }] }], AfterTool: [{ hooks: [{ type: "command", command: "/Users/x/.superset/hooks/gemini-hook.sh" }] }] } };
    writeFileSync(path, JSON.stringify(theirs));
    expect(setupStatus(c).gemini).toMatchObject({ detected: true, hooks: { state: "missing" } });
    const [r] = setupApply(c, ["gemini"]);
    expect(r).toMatchObject({ ok: true, changed: true });
    const merged = JSON.parse(readFileSync(path, "utf8"));
    expect(merged.general).toEqual(theirs.general);
    expect(merged.hooks.SessionStart).toHaveLength(2);
    expect(merged.hooks.SessionStart[0]).toEqual(theirs.hooks.SessionStart[0]);
    expect(merged.hooks.SessionStart[1]).toEqual({ hooks: [{ type: "command", command: hookCommand(c, "gemini") }] });
    expect(Object.keys(merged.hooks).sort()).toEqual(["AfterAgent", "AfterTool", "BeforeAgent", "BeforeTool", "Notification", "SessionEnd", "SessionStart"]);
    expect(setupStatus(c).gemini.hooks.state).toBe("installed");
    expect(setupApply(c, ["gemini"])[0]!.changed).toBe(false);
    expect(setupRevert(c, ["gemini"])[0]!.changed).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(theirs);
  });

  it("adds Cursor hooks in Cursor's flat shape with version 1, keeps the other tool's entries, and reverts cleanly", () => {
    const c = ctx();
    const path = hooksPath(c, "cursor");
    mkdirSync(join(c.home, ".cursor"));
    const theirs = { version: 1, hooks: { stop: [{ command: "/bin/sh '/Users/x/.orca/agent-hooks/cursor-hook.sh'", timeout: 10 }], preToolUse: [{ command: "/bin/sh '/Users/x/.orca/agent-hooks/cursor-hook.sh'", timeout: 10 }] } };
    writeFileSync(path, JSON.stringify(theirs));
    setupApply(c, ["cursor"]);
    const merged = JSON.parse(readFileSync(path, "utf8"));
    expect(merged.version).toBe(1);
    expect(merged.hooks.stop).toEqual([theirs.hooks.stop[0], { command: hookCommand(c, "cursor") }]);
    expect(merged.hooks.preToolUse).toEqual(theirs.hooks.preToolUse); // the blocking-style events are never touched
    expect(merged.hooks.postToolUse).toEqual([{ command: hookCommand(c, "cursor") }]);
    expect(setupStatus(c).cursor.hooks.state).toBe("installed");
    expect(setupRevert(c, ["cursor"])[0]!.changed).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(theirs);
  });

  it("adds Antigravity hooks as its own named group, leaves another tool's group alone, and reverts exactly", () => {
    const c = ctx();
    const path = hooksPath(c, "antigravity");
    expect(path).toBe(join(c.home, ".gemini", "config", "hooks.json"));
    mkdirSync(join(c.home, ".gemini", "antigravity-cli"), { recursive: true });
    mkdirSync(join(c.home, ".gemini", "config"), { recursive: true });
    const theirs = { "orca-status": { PreInvocation: [{ type: "command", command: "/bin/sh /Users/x/.orca/agent-hooks/antigravity-hook.sh", timeout: 10 }], PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/bin/sh /Users/x/.orca/agent-hooks/antigravity-hook.sh" }] }] } };
    writeFileSync(path, JSON.stringify(theirs));
    expect(setupStatus(c).antigravity).toMatchObject({ detected: true, hooks: { state: "missing" } });
    expect(setupApply(c, ["antigravity"])[0]).toMatchObject({ ok: true, changed: true });
    const merged = JSON.parse(readFileSync(path, "utf8"));
    expect(merged["orca-status"]).toEqual(theirs["orca-status"]);
    const cmd = hookCommand(c, "antigravity");
    expect(merged.agentwatch).toEqual({
      PreInvocation: [{ type: "command", command: cmd, timeout: 5 }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmd, timeout: 5 }] }],
      Stop: [{ type: "command", command: cmd, timeout: 5 }],
    });
    expect(merged).not.toHaveProperty("hooks");
    expect(setupStatus(c).antigravity.hooks.state).toBe("installed");
    expect(setupApply(c, ["antigravity"])[0]!.changed).toBe(false);
    expect(setupRevert(c, ["antigravity"])[0]!.changed).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(theirs);
  });

  it("keeps the group's own enabled flag, and is not 'detected' by a Gemini CLI folder alone", () => {
    const c = ctx();
    mkdirSync(join(c.home, ".gemini", "config"), { recursive: true });
    writeFileSync(hooksPath(c, "antigravity"), JSON.stringify({ agentwatch: { enabled: false } }));
    expect(setupStatus(c).antigravity.detected).toBe(false);
    expect(setupStatus(c).gemini.detected).toBe(true);
    setupApply(c, ["antigravity"]);
    expect(JSON.parse(readFileSync(hooksPath(c, "antigravity"), "utf8")).agentwatch.enabled).toBe(false);
  });

  it("creates a Cursor hooks file that Cursor will read (version 1) when there was none", () => {
    const c = ctx();
    setupApply(c, ["cursor"]);
    expect(JSON.parse(readFileSync(hooksPath(c, "cursor"), "utf8")).version).toBe(1);
  });

  it("does not take another provider's entry for its own", () => {
    const e = (command: string) => ({ command });
    expect(isOurs(e(`sh "/Users/x/Library/Application Support/AgentWatch/agentwatch-hook.sh" cursor`), "cursor")).toBe(true);
    expect(isOurs(e(`sh "/Users/x/Library/Application Support/AgentWatch/agentwatch-hook.sh" cursor`), "gemini")).toBe(false);
    expect(isOurs(e(`/Users/x/.superset/hooks/gemini-hook.sh`), "gemini")).toBe(false);
  });

  it("migrates an old Node-style install and reports it as outdated first", () => {
    const c = ctx();
    mkdirSync(join(c.home, ".claude"));
    const old = mergeHooks({}, "claude", `node "/x/dist/agentwatch.mjs" hook claude`);
    writeFileSync(hooksPath(c, "claude"), JSON.stringify(old));
    expect(setupStatus(c).claude.hooks.state).toBe("outdated");
    setupApply(c, ["claude"]);
    const s = setupStatus(c);
    expect(s.claude.hooks.state).toBe("installed");
    expect(readFileSync(hooksPath(c, "claude"), "utf8")).not.toContain("agentwatch.mjs");
    expect(readFileSync(hooksPath(c, "claude"), "utf8")).toContain(hookCommand(c, "claude").replace(/"/g, '\\"'));
  });

  it("one failing item never blocks the others, and never overwrites someone else's file", () => {
    const c = ctx();
    mkdirSync(join(c.home, ".local", "bin"), { recursive: true });
    writeFileSync(join(c.home, ".local", "bin", "agentwatch"), "#!/bin/sh\necho mine\n");
    mkdirSync(join(c.home, ".claude"));
    writeFileSync(hooksPath(c, "claude"), "{ not json");
    const out = setupApply(c, ["claude", "cli", "codex", "autostart"]);
    const by = Object.fromEntries(out.map((r) => [r.item, r]));
    expect(by.claude!.ok).toBe(false);
    expect(by.cli!.error).toMatch(/leaving it alone/);
    expect(by.codex!.ok).toBe(true);
    expect(by.autostart!.ok).toBe(true);
    expect(readFileSync(join(c.home, ".local", "bin", "agentwatch"), "utf8")).toContain("echo mine");
    expect(readFileSync(hooksPath(c, "claude"), "utf8")).toBe("{ not json"); // untouched
    expect(setupStatus(c).cli.state).toBe("conflict");
  });

  it("refuses the app-only items when not running from the app, and touches nothing", () => {
    const c = ctx({ appExe: undefined, cli: undefined });
    const out = setupApply(c, ["cli", "autostart"]);
    expect(out.every((r) => !r.ok)).toBe(true);
    expect(existsSync(join(c.home, "Library"))).toBe(false);
    expect(existsSync(join(c.home, ".local"))).toBe(false);
  });

  it("revert removes cli and autostart and tolerates repeats", () => {
    const c = ctx();
    setupApply(c, ITEMS);
    const out = setupRevert(c, ITEMS);
    expect(out.every((r) => r.ok && r.changed)).toBe(true);
    expect(setupRevert(c, ITEMS).every((r) => r.ok && !r.changed)).toBe(true);
    const s = setupStatus(c);
    expect([s.claude.hooks.state, s.codex.hooks.state, s.cli.state, s.autostart.state]).toEqual(["missing", "missing", "missing", "missing"]);
  });
});

describe("an app that runs from a temporary location", () => {
  const translocated = "/private/var/folders/xx/T/AppTranslocation/ABC-123/d/AgentWatch.app/Contents/MacOS/agentwatch-desktop";

  it("recognises quarantine copies and disk images, and nothing else", () => {
    expect(appLocationProblem(translocated)).toMatch(/Applications folder/);
    expect(appLocationProblem("/Volumes/AgentWatch/AgentWatch.app/Contents/MacOS/agentwatch-desktop")).toBeTruthy();
    expect(appLocationProblem("/Applications/AgentWatch.app/Contents/MacOS/agentwatch-desktop")).toBeUndefined();
    expect(appLocationProblem("/Users/me/Applications/AgentWatch.app/Contents/MacOS/agentwatch-desktop")).toBeUndefined();
  });

  it("offers neither the command nor start-at-login, says why, and writes nothing for them", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-"));
    dirs.push(dir);
    const c = contextFromEnv({ HOME: dir, AGENTWATCH_HOME: join(dir, "data"), AGENTWATCH_APP_EXE: translocated, AGENTWATCH_CLI_SCRIPT: join(dir, "x.mjs") });
    const s = setupStatus(c);
    expect(s.cli.state).toBe("unavailable");
    expect(s.autostart.state).toBe("unavailable");
    expect(s.cli.note).toMatch(/temporary location/);
    expect(s.managed).toBe(true);
    const r = setupApply(c, ["cli", "autostart", "claude"]);
    expect(r.map((x) => [x.item, x.ok])).toEqual([["cli", false], ["autostart", false], ["claude", true]]);
    expect(r[0]!.error).toMatch(/Applications folder/);
    expect(existsSync(join(dir, ".local"))).toBe(false);
    expect(existsSync(join(dir, "Library", "LaunchAgents"))).toBe(false);
    expect(setupRepair(c)).toEqual([]);
  });
});

describe("setupRepair after the app was moved", () => {
  it("rewrites the launcher and the login item that point at the old place", () => {
    const old = ctx();
    setupApply(old, ["cli", "autostart"]);
    const script = join(old.dir, "moved", "agentwatch.mjs");
    mkdirSync(join(old.dir, "moved"));
    writeFileSync(script, "// cli\n");
    const moved: SetupContext = { ...old, cli: { node: "/opt/moved/node", script }, appExe: "/Users/me/Applications/AgentWatch.app/Contents/MacOS/agentwatch-desktop" };
    expect(setupStatus(moved).cli.state).toBe("outdated");
    expect(setupStatus(moved).autostart.state).toBe("outdated");
    const r = setupRepair(moved);
    expect(r.map((x) => [x.item, x.ok, x.changed])).toEqual([["cli", true, true], ["autostart", true, true]]);
    expect(setupStatus(moved).cli.state).toBe("installed");
    expect(setupStatus(moved).autostart.state).toBe("installed");
    expect(setupRepair(moved)).toEqual([]);
  });

  it("never installs anything the user does not have, and never edits an agent's settings", () => {
    const c = ctx();
    mkdirSync(join(c.home, ".claude"));
    expect(setupRepair(c)).toEqual([]);
    expect(existsSync(join(c.home, ".local"))).toBe(false);
    expect(existsSync(hooksPath(c, "claude"))).toBe(false);
  });

  it("leaves a file that is not ours alone", () => {
    const c = ctx();
    const lp = join(c.home, ".local", "bin", "agentwatch");
    mkdirSync(join(c.home, ".local", "bin"), { recursive: true });
    writeFileSync(lp, "#!/bin/sh\necho mine\n");
    expect(setupRepair(c)).toEqual([]);
    expect(readFileSync(lp, "utf8")).toContain("echo mine");
  });
});
