import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodexAppServerMapper, mapCodexExecLine } from "@agentwatch/adapter-codex";
import { sanitizeInput } from "@agentwatch/protocol";
import { socketPath } from "./home";
import { runHook, readStdin } from "./hook";
import {
  ITEMS, DAEMON_LABEL, applyLauncher, buildPlist, contextFromEnv, generateHooks, hookCommand, hooksPath, launchAgentPath, launcherPath, mergeHooks, onPath,
  readJsonFile, removeHooks, removeLauncher, removePlist, setupApply, setupRevert, setupStatus, writeJsonWithBackup, writePlist, type Item, type Target,
} from "@agentwatch/setup";
import { sendFrames, sendEvents } from "./ipc";
import { playDemo } from "./demo";
import { runWrapped } from "./run";

const HELP = `agentwatch: local-only monitor for AI coding agents

Usage:
  agentwatch run -- <agent> [args]       run any CLI agent under monitoring (PTY wrapper)
  agentwatch claude [args]               run Claude Code under monitoring
  agentwatch codex [args]                run Codex under monitoring
  agentwatch status                      ask the daemon how it is doing
  agentwatch gemini [args]               run Gemini CLI under monitoring
  agentwatch agy [args]                  run Antigravity CLI under monitoring
  agentwatch hook <claude|codex|gemini|antigravity|cursor>  hook forwarder (reads one hook payload on stdin)
  agentwatch install-claude-hooks  [--print|--apply] [--settings <file>] [--command <cmd>]
  agentwatch install-codex-hooks   [--print|--apply] [--settings <file>] [--command <cmd>]
  agentwatch uninstall-claude-hooks [--settings <file>]
  agentwatch uninstall-codex-hooks  [--settings <file>]
  agentwatch ingest codex-exec           read 'codex exec --json' JSONL on stdin
  agentwatch ingest codex-app-server     read app-server JSON-RPC lines on stdin
  agentwatch install-cli [--apply|--remove]   put agentwatch on your PATH (launcher script in ~/.local/bin)
  agentwatch setup status [--json]       what is installed: Claude/Codex hooks, command, start at login
  agentwatch setup apply|revert <claude|codex|gemini|antigravity|cursor|cli|autostart ...>   what the app's Finish button does
  agentwatch launchagent [--print|--apply|--remove] [--daemon <file>] [--node <file>]
                                         headless only: start the daemon (no app) at login
  agentwatch mint                        print a short-lived UI capability (dev helper)
  agentwatch demo [--seconds N] [--speed X] [--loops N]   replay a synthetic scenario into the daemon

Hook installation only prints by default. --apply edits the settings file after backing it up.
AgentWatch never sends data off this Mac.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Absolute command the agents should call. Prefers the built bundle so hooks start fast. */
function defaultHookCommand(target: Target): string {
  const ctx = contextFromEnv(process.env);
  if (existsSync(join(ctx.agentwatchHome, "agentwatch-hook.sh"))) return hookCommand(ctx, target);
  const here = fileURLToPath(import.meta.url);
  const dist = resolve(here, "..", "..", "dist", "agentwatch.mjs");
  const bundled = existsSync(dist) ? dist : here.endsWith("agentwatch.mjs") ? here : undefined;
  if (!bundled) {
    throw new Error("no built CLI found. Run `pnpm --filter @agentwatch/cli build`, or pass --command '<command that runs agentwatch>'.");
  }
  return `node ${JSON.stringify(bundled)} hook ${target}`;
}

function settingsPath(target: Target, args: string[]): string {
  const given = flag(args, "--settings");
  if (given) return resolve(given);
  return hooksPath(contextFromEnv(process.env), target);
}

async function install(target: Target, args: string[]): Promise<number> {
  const command = flag(args, "--command") ?? defaultHookCommand(target);
  const path = settingsPath(target, args);
  if (!args.includes("--apply")) {
    process.stdout.write(`# Add this to ${path}\n${JSON.stringify(generateHooks(target, command), null, 2)}\n`);
    process.stdout.write("\n# Nothing was changed. Re-run with --apply to merge it (a backup is made first).\n");
    return 0;
  }
  const merged = mergeHooks(readJsonFile(path), target, command);
  const backup = writeJsonWithBackup(path, merged);
  process.stdout.write(`Updated ${path}${backup ? `\nBackup: ${backup}` : ""}\nUserPromptSubmit is not subscribed, so prompts are never forwarded.\n`);
  return 0;
}

async function ingestLines(kind: "codex-exec" | "codex-app-server"): Promise<number> {
  const text = await readStdin();
  const state: { threadId?: string } = {};
  const mapper = new CodexAppServerMapper();
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(...(kind === "codex-exec" ? mapCodexExecLine(json, {}, state) : mapper.map(json)));
  }
  const n = await sendEvents(events.map((e) => sanitizeInput(e).event), { socket: socketPath(), timeoutMs: 3000 });
  process.stdout.write(`sent ${n} of ${events.length} events\n`);
  return n === events.length ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP + "\n");
      return 0;
    case "hook": {
      const p = rest[0];
      if (p !== "claude" && p !== "codex" && p !== "gemini" && p !== "antigravity" && p !== "cursor") return 0; // a hook must never fail loudly
      await runHook(p);
      return 0;
    }
    case "run": {
      const i = rest.indexOf("--");
      return runWrapped({ argv: i >= 0 ? rest.slice(i + 1) : rest, provider: "generic" });
    }
    case "claude":
      return runWrapped({ argv: ["claude", ...rest], provider: "claude-code" });
    case "codex":
      return runWrapped({ argv: ["codex", ...rest], provider: "codex" });
    case "gemini":
      return runWrapped({ argv: ["gemini", ...rest], provider: "gemini-cli" });
    case "agy":
      return runWrapped({ argv: ["agy", ...rest], provider: "antigravity" });
    case "status": {
      const r = await sendFrames([{ op: "status" }], { socket: socketPath(), timeoutMs: 1500 });
      if (!r[0]) {
        process.stdout.write("agentwatchd is not running\n");
        return 1;
      }
      process.stdout.write(JSON.stringify(r[0].status, null, 2) + "\n");
      return 0;
    }
    case "mint": {
      const r = await sendFrames([{ op: "mint" }], { socket: socketPath(), timeoutMs: 1500 });
      if (!r[0]?.ok) {
        process.stderr.write("agentwatchd is not running\n");
        return 1;
      }
      process.stdout.write(JSON.stringify(r[0]) + "\n");
      return 0;
    }
    case "install-cli": {
      const ctx = contextFromEnv(process.env, resolve(fileURLToPath(import.meta.url), "..", "..", "bin", "agentwatch.mjs"));
      const path = launcherPath(ctx.home);
      if (rest.includes("--remove")) {
        process.stdout.write(removeLauncher(path).message + "\n");
        return 0;
      }
      if (!rest.includes("--apply")) {
        process.stdout.write(`Would write ${path} to run ${ctx.cli!.script} with ${ctx.cli!.node}\nNothing was changed. Re-run with --apply.\n`);
        return 0;
      }
      process.stdout.write(applyLauncher(path, ctx.cli!.node, ctx.cli!.script).message + "\n");
      if (!onPath(dirname(path))) process.stdout.write(`${dirname(path)} is not on your PATH yet. Add this to ~/.zshrc:\n  export PATH="$HOME/.local/bin:$PATH"\n`);
      return 0;
    }
    case "setup": {
      const ctx = contextFromEnv(process.env, resolve(fileURLToPath(import.meta.url), "..", "..", "bin", "agentwatch.mjs"));
      const [sub, ...names] = rest.filter((a) => a !== "--json");
      const json = rest.includes("--json");
      if (sub === "status") {
        const st = setupStatus(ctx);
        process.stdout.write(json ? JSON.stringify(st, null, 2) + "\n" : `claude hooks: ${st.claude.hooks.state}\ncodex hooks:  ${st.codex.hooks.state}\ngemini hooks: ${st.gemini.hooks.state}\nantigravity hooks: ${st.antigravity.hooks.state}\ncursor hooks: ${st.cursor.hooks.state}\ncommand:      ${st.cli.state}\nstart login:  ${st.autostart.state}\n`);
        return 0;
      }
      if (sub === "apply" || sub === "revert") {
        const items = (names.length ? names : [...ITEMS]).filter((n): n is Item => (ITEMS as readonly string[]).includes(n));
        const out = sub === "apply" ? setupApply(ctx, items) : setupRevert(ctx, items);
        process.stdout.write(json ? JSON.stringify(out, null, 2) + "\n" : out.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.item}: ${r.error ?? r.message}${r.backup ? `  (backup: ${r.backup})` : ""}`).join("\n") + "\n");
        return out.every((r) => r.ok) ? 0 : 1;
      }
      process.stderr.write("usage: agentwatch setup <status|apply|revert> [items] [--json]\n");
      return 2;
    }
    case "launchagent": {
      const path = launchAgentPath(DAEMON_LABEL);
      if (rest.includes("--remove")) {
        process.stdout.write(removePlist(path) ? `Removed ${path}\nStop it now with: launchctl bootout gui/$(id -u)/${DAEMON_LABEL}\n` : "No AgentWatch LaunchAgent is installed.\n");
        return 0;
      }
      const here = fileURLToPath(import.meta.url);
      const daemon = flag(rest, "--daemon") ?? resolve(here, "..", "..", "..", "..", "services", "daemon", "dist", "agentwatchd.mjs");
      if (!existsSync(daemon)) throw new Error(`daemon bundle not found at ${daemon}. Run \`pnpm --filter @agentwatch/daemon build\` or pass --daemon <file>.`);
      const xml = buildPlist({ label: DAEMON_LABEL, program: [flag(rest, "--node") ?? process.execPath, daemon], logPath: join(homedir(), "Library", "Logs", "AgentWatch-daemon.log"), env: process.env.AGENTWATCH_HOME ? { AGENTWATCH_HOME: process.env.AGENTWATCH_HOME } : undefined, keepAliveOnCrash: true });
      if (!rest.includes("--apply")) {
        process.stdout.write(`# ${path}\n${xml}\n# Nothing was written. Re-run with --apply to install it.\n`);
        return 0;
      }
      const backup = writePlist(path, xml);
      process.stdout.write(`Wrote ${path}${backup ? `\nBackup: ${backup}` : ""}\nLoad it now with: launchctl bootstrap gui/$(id -u) ${path}\n`);
      return 0;
    }
    case "demo": {
      const num = (name: string, d: number) => {
        const v = Number(flag(rest, name));
        return Number.isFinite(v) && v > 0 ? v : d;
      };
      const r = await playDemo({ socket: socketPath(), speed: num("--speed", 1), loops: num("--loops", 1), maxSeconds: num("--seconds", 120), log: (l) => process.stdout.write(l + "\n") });
      process.stdout.write(`demo done: ${r.sent} events over ${r.loops} loop(s)\n`);
      return 0;
    }
    case "install-claude-hooks":
      return install("claude", rest);
    case "install-codex-hooks":
      return install("codex", rest);
    case "uninstall-claude-hooks":
    case "uninstall-codex-hooks": {
      const target: Target = cmd.includes("claude") ? "claude" : "codex";
      const path = settingsPath(target, rest);
      const backup = writeJsonWithBackup(path, removeHooks(readJsonFile(path), target));
      process.stdout.write(`Removed AgentWatch hooks from ${path}${backup ? `\nBackup: ${backup}` : ""}\n`);
      return 0;
    }
    case "ingest": {
      const kind = rest[0];
      if (kind === "codex-exec" || kind === "codex-app-server") return ingestLines(kind);
      process.stderr.write("usage: agentwatch ingest <codex-exec|codex-app-server>\n");
      return 2;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}\n`);
      return 2;
  }
}

// Run when executed directly (not when imported by tests).
// Resolve symlinks: `agentwatch` on PATH is a symlink, so argv[1] is not named after the real file.
let entry = "";
try {
  entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
} catch {
  entry = process.argv[1] ?? "";
}
if (entry && (entry.endsWith("main.ts") || entry.endsWith("agentwatch.mjs") || entry.endsWith("agentwatch.js"))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      process.stderr.write(`agentwatch: ${err.message}\n`);
      process.exit(1);
    },
  );
}

void readFileSync;
