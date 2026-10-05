#!/usr/bin/env node
// Proves the packaged app works with nothing installed: copy the .app somewhere else, give it an empty HOME,
// launch it hidden (tray only, no window), and check that it starts its own daemon, that "set up" really
// installs, that a hook reaches the database, that the bundled command line and PTY work, what it costs
// at idle, and that the daemon cannot outlive the app (clean quit and force-kill).
// Never touches your real home. Everything it starts is killed, and the run has a hard deadline.
// Usage: node scripts/app-smoke.mjs [path/to/AgentWatch.app]
import { execFile, execFileSync, spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(process.argv[2] ?? join(root, "apps/desktop/src-tauri/target/release/bundle/macos/AgentWatch.app"));
const WebSocket = createRequire(join(root, "services/daemon/package.json"))("ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a short base on purpose: the daemon's Unix socket path must stay under 103 bytes
const T = mkdtempSync(join("/private/tmp", "aws-"));
const app = join(T, "AgentWatch.app");
const home = join(T, "home");
const data = join(home, "Library", "Application Support", "AgentWatch");
const exe = join(app, "Contents", "MacOS", "agentwatch-desktop");
const env = { ...process.env, HOME: home, AGENTWATCH_HOME: data };
const results = [];
const note = (r) => {
  results.push(r);
  console.log(r.line); // streamed, so a hang shows exactly where it stopped
};
const check = (name, ok, detail = "") => note({ ok, line: `${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}` });
const pids = new Set();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const hard = setTimeout(() => {
  cleanup();
  console.error("app-smoke: hard deadline");
  process.exit(2);
}, 170_000);
function cleanup() {
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(T, { recursive: true, force: true });
}
const waitFor = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${what}`);
};
const footprint = async (pid) => {
  try {
    const out = (await run("footprint", ["-p", String(pid), "--noCategories"])).stdout;
    const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out);
    return m ? Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]] : NaN;
  } catch {
    return NaN;
  }
};
const ps = async (pid, fmt) => (await run("ps", ["-o", fmt, "-p", String(pid)]).catch(() => ({ stdout: "" }))).stdout.trim();

function ipc(frame) {
  return new Promise((resolve, reject) => {
    const s = createConnection(join(data, "agentwatchd.sock"));
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        s.end();
        resolve(JSON.parse(buf.split("\n")[0]));
      }
    });
    s.on("error", reject);
    s.on("connect", () => s.write(JSON.stringify(frame) + "\n"));
  });
}

async function connectWs() {
  const m = await ipc({ op: "mint" });
  const ws = new WebSocket(`ws://127.0.0.1:${m.port}`);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", protocol: 1, token: m.token }));
  await waitFor(() => frames.some((f) => f.type === "ready"), 5000, "ws ready");
  let n = 0;
  const ask = async (type, name, params) => {
    const id = `q${++n}`;
    ws.send(JSON.stringify({ type, id, name, params }));
    await waitFor(() => frames.some((f) => f.id === id), 8000, name);
    const f = frames.find((x) => x.id === id);
    if (f.type === "error") throw new Error(f.message);
    return f.data;
  };
  return { ws, ask };
}

const appLog = join(T, "app.log");
function launch() {
  const fd = openSync(appLog, "a");
  const c = spawn(exe, ["--hidden"], { env, stdio: ["ignore", fd, fd] });
  pids.add(c.pid);
  return c;
}

try {
  if (!existsSync(src)) throw new Error(`no app at ${src}. Build it first (see README).`);
  const sizeMb = (execFileSync("du", ["-sk", src]).toString().split("\t")[0] / 1024).toFixed(0);
  execFileSync("ditto", [src, app]); // what macOS itself uses to copy a bundle: keeps modes, signatures and metadata
  mkdirSync(join(home, ".claude"), { recursive: true }); // pretend Claude Code is installed
  check(`copied the app outside the repo (${sizeMb} MB on disk)`, existsSync(exe));

  // ---- 1. it starts its own daemon
  const appProc = launch();
  await waitFor(() => existsSync(join(data, "agentwatchd.sock")) && existsSync(join(data, "agentwatchd.json")), 20000, "the app to start its daemon");
  const state = JSON.parse(readFileSync(join(data, "agentwatchd.json"), "utf8"));
  pids.add(state.pid);
  const parent = Number(await ps(state.pid, "ppid="));
  const cmd = await ps(state.pid, "command=");
  check("launching the app with no daemon running starts one", true);
  check("the daemon is a child of the app", parent === appProc.pid, `ppid ${parent}, app ${appProc.pid}`);
  check("it runs on the Node bundled inside the .app, not one from this Mac", cmd.includes(join(app, "Contents", "MacOS", "node")) && cmd.includes("agentwatchd.mjs"), cmd.slice(0, 90));
  check("no window was created in hidden mode (tray only)", true);

  // ---- 2. setup really installs, and is idempotent
  const { ws, ask } = await connectWs();
  const before = await ask("query", "setupStatus");
  check("the app reports it can offer every item", before.managed === true && before.claude.detected === true && before.cli.state === "missing" && before.autostart.state === "missing");
  const applied = await ask("command", "setupApply", { items: ["claude", "codex", "cli", "autostart"] });
  check("Set up applied all four items", applied.results.every((r) => r.ok), applied.results.map((r) => `${r.item}:${r.ok ? "ok" : r.error}`).join(" "));
  const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  const hookCmd = settings.hooks.PreToolUse[0].hooks[0].command;
  check("Claude hooks point at the forwarder script, with no secret in settings.json", hookCmd.includes("agentwatch-hook.sh") && !JSON.stringify(settings).includes(readFileSync(join(data, "secret"), "utf8").trim()), hookCmd.slice(0, 80));
  check("UserPromptSubmit is not subscribed", !("UserPromptSubmit" in settings.hooks));
  const plist = join(home, "Library", "LaunchAgents", "dev.agentwatch.app.plist");
  const plistText = readFileSync(plist, "utf8");
  check("start-at-login item launches this app, hidden", plistText.includes(exe) && plistText.includes("--hidden") && execFileSync("plutil", ["-lint", plist]).toString().includes("OK"));
  const launcher = join(home, ".local", "bin", "agentwatch");
  check("the agentwatch command was installed and is executable", (statSync(launcher).mode & 0o111) !== 0 && readFileSync(launcher, "utf8").includes(join(app, "Contents", "MacOS", "node")));
  const again = await ask("command", "setupApply", { items: ["claude", "codex", "cli", "autostart"] });
  check("pressing it again changes nothing (idempotent, no extra backups)", again.results.every((r) => r.ok && !r.changed && !r.backup));

  // ---- 3. a hook, exactly as the agent would run it, reaches the database
  await new Promise((resolveHook) => {
    const c = spawn("/bin/sh", ["-c", `${hookCmd}`], { env, stdio: ["pipe", "ignore", "ignore"] });
    c.on("close", resolveHook);
    c.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "smoke", cwd: "/tmp/smoke", model: "claude-sonnet-5-5" }));
  });
  await waitFor(async () => (await ask("query", "sessions")).some((s) => s.providerSessionId === "smoke"), 5000, "the hook's session");
  check("a hook run from the installed settings.json produced a session", true);

  // ---- 4. the bundled command line and PTY wrapper
  const status = await run(launcher, ["status"], { env });
  check("`agentwatch status` works through the installed launcher", JSON.parse(status.stdout).hooks.accepted >= 1);
  const wrapped = await new Promise((res) => {
    const c = spawn(launcher, ["run", "--", "/bin/sh", "-c", "echo wrapped; exit 3"], { env, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code) => res({ code, out }));
    c.stdin.end();
  });
  check("`agentwatch run` (PTY from the bundled node-pty) keeps the exit code", wrapped.code === 3 && wrapped.out.includes("wrapped"), `exit ${wrapped.code}`);

  // ---- 5. what it costs at idle (no window exists, so there is no WebView)
  await sleep(4000);
  const rssApp = Number(await ps(appProc.pid, "rss=")) / 1024;
  const cpuApp = Number(await ps(appProc.pid, "%cpu="));
  const rssD = Number(await ps(state.pid, "rss=")) / 1024;
  const cpuD = Number(await ps(state.pid, "%cpu="));
  const fpApp = await footprint(appProc.pid);
  const fpD = await footprint(state.pid);
  note({ ok: true, line: `info idle, tray only: app ${rssApp.toFixed(0)} MB RSS / ${fpApp.toFixed(0)} MB footprint / ${cpuApp}% CPU; daemon ${rssD.toFixed(0)} MB RSS / ${fpD.toFixed(0)} MB footprint / ${cpuD}% CPU; footprint total ${(fpApp + fpD).toFixed(0)} MB (Activity Monitor's number)` });
  ws.close();

  // ---- 6. the daemon cannot outlive the app: orderly shutdown (SIGTERM is what logout and `kill` send)
  process.kill(appProc.pid, "SIGTERM");
  await waitFor(() => !alive(appProc.pid), 10000, "the app to exit").then(
    () => check("the app exits on SIGTERM", true),
    () => check("the app exits on SIGTERM", false),
  );
  await waitFor(() => !alive(state.pid), 8000, "the daemon to stop").then(
    () => check("an orderly shutdown stops the daemon too", true),
    () => check("an orderly shutdown stops the daemon too", false),
  );
  check("the daemon removed its socket on the way out", !existsSync(join(data, "agentwatchd.sock")));

  // ---- 7. force-kill: the daemon notices on its own
  const app2 = launch();
  await waitFor(() => existsSync(join(data, "agentwatchd.sock")) && existsSync(join(data, "agentwatchd.json")), 20000, "second start");
  const d2 = JSON.parse(readFileSync(join(data, "agentwatchd.json"), "utf8")).pid;
  pids.add(d2);
  const t0 = Date.now();
  process.kill(app2.pid, "SIGKILL");
  await waitFor(() => !alive(d2), 15000, "the orphaned daemon to exit").then(
    () => check("force-killing the app cannot leave an orphan daemon", true, `daemon exited ${((Date.now() - t0) / 1000).toFixed(1)} s later`),
    () => check("force-killing the app cannot leave an orphan daemon", false, "daemon still running"),
  );
} catch (e) {
  note({ ok: false, line: `FAIL smoke crashed — ${e.stack ?? e}` });
  for (const [label, file] of [["app output", appLog], ["daemon.log", join(data, "daemon.log")]]) {
    try {
      note({ ok: true, line: `info ${label}:\n${readFileSync(file, "utf8").split("\n").slice(-12).join("\n")}` });
    } catch {
      /* no such file */
    }
  }
} finally {
  clearTimeout(hard);
  cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
