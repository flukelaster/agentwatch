import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const HOOK_SCRIPT = "agentwatch-hook.sh";
export const HOOK_HEADERS = "hook-headers";

/** The shared secret that lets the hook script (and nothing in a browser) post events. Stable across restarts. */
export function loadOrCreateSecret(path: string): string {
  if (existsSync(path)) {
    const s = readFileSync(path, "utf8").trim();
    if (s.length >= 32) return s;
  }
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}

function atomicWrite(path: string, text: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * The forwarder the agents' hooks run. It uses the `curl` that ships with macOS, so no Node process is
 * started per tool call. It always exits 0 and prints nothing, so it can never block or disturb an agent.
 * The port changes per daemon start, so this file is rewritten on every start; the settings.json entry
 * only ever points at this stable path. The secret lives in a 0600 header file, never in settings.json.
 */
export function hookScript(port: number): string {
  return `#!/bin/sh
# agentwatch-managed forwarder. Rewritten every time the daemon starts.
H=$(cd "$(dirname "$0")" && pwd)
/usr/bin/curl -s --connect-timeout 1 -m 3 -o /dev/null -X POST \\
  -H "@$H/${HOOK_HEADERS}" \\
  \${AGENTWATCH_SESSION_ID:+-H "X-AgentWatch-Session: $AGENTWATCH_SESSION_ID"} \\
  --data-binary @- "http://127.0.0.1:${port}/hook/$1" >/dev/null 2>&1
# Antigravity reads a hook's stdout as its answer and wants a JSON object; {} changes nothing for the events AgentWatch uses
[ "$1" = antigravity ] && printf '{}\\n'
exit 0
`;
}

export function writeHookAssets(home: string, port: number, secret: string): { script: string; headers: string } {
  const headers = join(home, HOOK_HEADERS);
  const script = join(home, HOOK_SCRIPT);
  atomicWrite(headers, `Authorization: Bearer ${secret}\nContent-Type: application/json\n`, 0o600);
  atomicWrite(script, hookScript(port), 0o700);
  return { script, headers };
}
