import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CLI_NAME = "agentwatch";
const MARKER = "# agentwatch-managed launcher";

export function launcherPath(home = homedir()): string {
  return join(home, ".local", "bin", CLI_NAME);
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A tiny shell script instead of a symlink: it survives the app being moved only if rewritten, and it names the runtime explicitly. */
export function launcherScript(node: string, script: string): string {
  return `#!/bin/sh\n${MARKER}\nexec ${sq(node)} ${sq(script)} "$@"\n`;
}

export type LauncherState = "installed" | "outdated" | "missing" | "conflict";

export function launcherState(path: string, node: string, script: string): LauncherState {
  if (!existsSync(path)) return "missing";
  const text = readFileSync(path, "utf8");
  if (!text.includes(MARKER)) return "conflict";
  return text === launcherScript(node, script) ? "installed" : "outdated";
}

export interface ApplyResult {
  changed: boolean;
  message: string;
}

/** Never overwrites a file that is not ours. */
export function applyLauncher(path: string, node: string, script: string): ApplyResult {
  if (!existsSync(script)) throw new Error(`launcher target not found: ${script}`);
  const state = launcherState(path, node, script);
  if (state === "conflict") throw new Error(`${path} already exists and is not an AgentWatch launcher; leaving it alone.`);
  if (state === "installed") return { changed: false, message: `${path} is already set up.` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, launcherScript(node, script));
  chmodSync(path, 0o755);
  return { changed: true, message: `Wrote ${path}` };
}

export function removeLauncher(path: string): ApplyResult {
  if (!existsSync(path)) return { changed: false, message: "Nothing to remove." };
  if (!readFileSync(path, "utf8").includes(MARKER)) throw new Error(`${path} is not an AgentWatch launcher; leaving it alone.`);
  rmSync(path);
  return { changed: true, message: `Removed ${path}` };
}

export function onPath(dir: string, envPath = process.env.PATH ?? ""): boolean {
  return envPath.split(":").includes(dir);
}
