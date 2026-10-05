import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DAEMON_LABEL = "dev.agentwatch.daemon";
export const APP_LABEL = "dev.agentwatch.app";

export function launchAgentPath(label: string, home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface PlistOptions {
  label: string;
  program: string[];
  logPath?: string;
  env?: Record<string, string>;
  /** true: restart only after a crash, never after a clean exit. */
  keepAliveOnCrash?: boolean;
}

/** A per-user LaunchAgent (never a root LaunchDaemon). It starts at login and nothing else. */
export function buildPlist(o: PlistOptions): string {
  const args = o.program.map((a) => `    <string>${esc(a)}</string>`).join("\n");
  const env = o.env && Object.keys(o.env).length
    ? `\n  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(o.env).map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`).join("\n")}\n  </dict>`
    : "";
  const keep = o.keepAliveOnCrash ? "\n  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>" : "";
  const log = o.logPath ? `\n  <key>StandardOutPath</key>\n  <string>${esc(o.logPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${esc(o.logPath)}</string>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>${keep}
  <key>ProcessType</key>
  <string>Background</string>${log}${env}
</dict>
</plist>
`;
}

export function writePlist(path: string, xml: string, now = new Date()): string | undefined {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === xml) return undefined;
    backup = `${path}.agentwatch-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, xml);
  return backup;
}

export function removePlist(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

export type PlistState = "installed" | "outdated" | "missing";

export function plistState(path: string, expectedXml: string): PlistState {
  if (!existsSync(path)) return "missing";
  return readFileSync(path, "utf8") === expectedXml ? "installed" : "outdated";
}
