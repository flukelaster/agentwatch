import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateHooks, hooksStatus, mergeHooks, readJsonFile, removeHooks, writeJsonWithBackup, type HooksStatus, type Target } from "./hooks";
import { APP_LABEL, buildPlist, launchAgentPath, plistState, removePlist, writePlist, type PlistState } from "./launchagent";
import { applyLauncher, launcherPath, launcherState, onPath, removeLauncher, type LauncherState } from "./launcher";

export type Item = "claude" | "codex" | "gemini" | "antigravity" | "cursor" | "cli" | "autostart";
export const ITEMS: readonly Item[] = ["claude", "codex", "gemini", "antigravity", "cursor", "cli", "autostart"];

/** The agents connected through a hooks file: where it lives (under home), the folder that shows the agent is installed, and what to tell the person after. */
const HOOK_AGENTS: Record<Target, { dir: string; file: string; /** Folder that shows the agent is installed, when it is not the one holding the file. */ detect?: string; after: string }> = {
  claude: { dir: ".claude", file: "settings.json", after: "Start a new Claude Code session to use them." },
  codex: { dir: ".codex", file: "hooks.json", after: "Codex only runs hooks you have reviewed: open Codex, run /hooks, and trust the AgentWatch ones, then start a new session." },
  gemini: { dir: ".gemini", file: "settings.json", after: "Start a new Gemini CLI session to use them." },
  antigravity: { dir: ".gemini/config", file: "hooks.json", detect: ".gemini/antigravity-cli", after: "Start a new Antigravity CLI session (agy) to use them." },
  cursor: { dir: ".cursor", file: "hooks.json", after: "Restart Cursor (or its agent) so it reads the new hooks." },
};
export const HOOK_TARGETS = Object.keys(HOOK_AGENTS) as Target[];


export interface SetupContext {
  /** The user's home directory. */
  home: string;
  /** AgentWatch's data directory; the forwarder script lives here. */
  agentwatchHome: string;
  /** Node + CLI script for the `agentwatch` command. Absent when this build has no CLI to offer. */
  cli?: { node: string; script: string };
  /** The app executable, for the start-at-login item. Absent when not running from the app. */
  appExe?: string;
  /** Environment for the login item. */
  appEnv?: Record<string, string>;
  /** Why this copy of the app must not install paths into itself (it runs from a disk image or a quarantine sandbox). */
  appProblem?: string;
}

/**
 * A launcher or login item that points inside the app is only as stable as the app's location.
 * macOS runs a quarantined download from a random read-only copy (AppTranslocation) and a disk image
 * from /Volumes; both disappear, so nothing may be installed that points there.
 */
export function appLocationProblem(exe: string): string | undefined {
  if (exe.includes("/AppTranslocation/") || exe.startsWith("/Volumes/")) {
    return "AgentWatch is running from a temporary location (a disk image or a fresh download). Move AgentWatch to your Applications folder, open it from there, then set this up.";
  }
  return undefined;
}

export const hookCommand = (ctx: SetupContext, target: Target): string => `sh "${join(ctx.agentwatchHome, "agentwatch-hook.sh")}" ${target}`;
export const hooksPath = (ctx: SetupContext, target: Target): string => join(ctx.home, HOOK_AGENTS[target].dir, HOOK_AGENTS[target].file);

export interface SetupStatus {
  claude: { detected: boolean; hooks: HooksStatus };
  codex: { detected: boolean; hooks: HooksStatus };
  gemini: { detected: boolean; hooks: HooksStatus };
  antigravity: { detected: boolean; hooks: HooksStatus };
  cursor: { detected: boolean; hooks: HooksStatus };
  cli: { state: LauncherState | "unavailable"; path: string; dirOnPath: boolean; note?: string };
  autostart: { state: PlistState | "unavailable"; path: string; note?: string };
  /** True when running from the packaged app (so cli/autostart can be offered). */
  managed: boolean;
}

function autostartXml(ctx: SetupContext): string | undefined {
  if (!ctx.appExe) return undefined;
  return buildPlist({ label: APP_LABEL, program: [ctx.appExe, "--hidden"], env: ctx.appEnv });
}

export function setupStatus(ctx: SetupContext): SetupStatus {
  const agent = (t: Target) => ({ detected: existsSync(join(ctx.home, HOOK_AGENTS[t].detect ?? HOOK_AGENTS[t].dir)), hooks: hooksStatus(hooksPath(ctx, t), t, hookCommand(ctx, t)) });
  const lp = launcherPath(ctx.home);
  const xml = autostartXml(ctx);
  const ap = launchAgentPath(APP_LABEL, ctx.home);
  return {
    claude: agent("claude"),
    codex: agent("codex"),
    gemini: agent("gemini"),
    antigravity: agent("antigravity"),
    cursor: agent("cursor"),
    cli: { state: ctx.cli ? launcherState(lp, ctx.cli.node, ctx.cli.script) : "unavailable", path: lp, dirOnPath: onPath(dirname(lp)), ...(ctx.appProblem ? { note: ctx.appProblem } : {}) },
    autostart: { state: xml ? plistState(ap, xml) : "unavailable", path: ap, ...(ctx.appProblem ? { note: ctx.appProblem } : {}) },
    managed: !!ctx.appExe || !!ctx.appProblem,
  };
}

export interface ItemResult {
  item: Item;
  ok: boolean;
  changed: boolean;
  message: string;
  backup?: string;
  error?: string;
}

function hooksApply(ctx: SetupContext, target: Target): ItemResult {
  const path = hooksPath(ctx, target);
  const existing = readJsonFile(path);
  const merged = mergeHooks(existing, target, hookCommand(ctx, target));
  if (JSON.stringify(existing) === JSON.stringify(merged)) return { item: target, ok: true, changed: false, message: `${path} already has the AgentWatch hooks.` };
  const backup = writeJsonWithBackup(path, merged);
  return { item: target, ok: true, changed: true, message: `Added AgentWatch hooks to ${path}. ${HOOK_AGENTS[target].after}`, backup };
}

function hooksRevert(ctx: SetupContext, target: Target): ItemResult {
  const path = hooksPath(ctx, target);
  const existing = readJsonFile(path);
  const next = removeHooks(existing, target);
  if (JSON.stringify(existing) === JSON.stringify(next)) return { item: target, ok: true, changed: false, message: "No AgentWatch hooks to remove." };
  const backup = writeJsonWithBackup(path, next);
  return { item: target, ok: true, changed: true, message: `Removed AgentWatch hooks from ${path}.`, backup };
}

/** Apply items independently: one failing item never blocks the others. Nothing is written for items not asked for. */
export function setupApply(ctx: SetupContext, items: readonly Item[]): ItemResult[] {
  return items.map((item): ItemResult => {
    try {
      switch (item) {
        case "claude":
        case "codex":
        case "gemini":
        case "antigravity":
        case "cursor":
          return hooksApply(ctx, item);
        case "cli": {
          if (!ctx.cli) throw new Error(ctx.appProblem ?? "this build has no command-line tool to install");
          const r = applyLauncher(launcherPath(ctx.home), ctx.cli.node, ctx.cli.script);
          return { item, ok: true, changed: r.changed, message: r.message };
        }
        case "autostart": {
          const xml = autostartXml(ctx);
          if (!xml) throw new Error(ctx.appProblem ?? "start at login needs the AgentWatch app");
          const path = launchAgentPath(APP_LABEL, ctx.home);
          const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
          const backup = writePlist(path, xml);
          return { item, ok: true, changed: before !== xml, message: `AgentWatch will start at your next login (${path}).`, backup };
        }
      }
    } catch (e) {
      return { item, ok: false, changed: false, message: "", error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/**
 * Files AgentWatch wrote that now point at the wrong place (the app was moved or updated) are rewritten.
 * Only items the user already has are touched: this never installs anything new, and never edits the
 * agents' own settings (those point at a stable path in the data directory, not into the app).
 */
export function setupRepair(ctx: SetupContext): ItemResult[] {
  if (ctx.appProblem) return [];
  const s = setupStatus(ctx);
  const stale: Item[] = [];
  if (s.cli.state === "outdated") stale.push("cli");
  if (s.autostart.state === "outdated") stale.push("autostart");
  return setupApply(ctx, stale);
}

export function setupRevert(ctx: SetupContext, items: readonly Item[]): ItemResult[] {
  return items.map((item): ItemResult => {
    try {
      switch (item) {
        case "claude":
        case "codex":
        case "gemini":
        case "antigravity":
        case "cursor":
          return hooksRevert(ctx, item);
        case "cli": {
          const r = removeLauncher(launcherPath(ctx.home));
          return { item, ok: true, changed: r.changed, message: r.message };
        }
        case "autostart": {
          const removed = removePlist(launchAgentPath(APP_LABEL, ctx.home));
          return { item, ok: true, changed: removed, message: removed ? "AgentWatch will no longer start at login." : "Start at login was not set up." };
        }
      }
    } catch (e) {
      return { item, ok: false, changed: false, message: "", error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export { generateHooks };
