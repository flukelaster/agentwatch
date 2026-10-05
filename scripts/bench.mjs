#!/usr/bin/env node
// Measures what AgentWatch costs while running, using the SAME runtime and flags the app ships with:
//  1. hook latency: the curl forwarder vs the old Node forwarder (what every tool call pays)
//  2. daemon: RSS and CPU idle, then under a steady event load, then after a burst
// Everything it starts is killed when it finishes; the whole run has a hard deadline.
// Usage: node scripts/bench.mjs [--idle 15] [--load 15] [--rate 40]
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rt = join(root, "apps", "desktop", "src-tauri");
const node = join(rt, "binaries", "node-aarch64-apple-darwin");
const daemonJs = join(rt, "runtime", "agentwatchd.mjs");
const cliJs = join(rt, "runtime", "agentwatch.mjs");
const arg = (n, d) => Number(process.argv[process.argv.indexOf(n) + 1]) || d;
const flagsArg = process.argv.indexOf("--flags") >= 0 ? process.argv[process.argv.indexOf("--flags") + 1] : "--max-old-space-size=128";
const QUICK = process.argv.includes("--quick");
const IDLE = arg("--idle", 15);
const LOAD = arg("--load", 15);
const RATE = arg("--rate", 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(node) || !existsSync(daemonJs)) {
  console.error("run `node scripts/prepare-runtime.mjs` first");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "aw-bench-"));
const data = join(home, "data");
const env = { ...process.env, HOME: home, AGENTWATCH_HOME: data };
let daemon;
const hard = setTimeout(() => {
  daemon?.kill("SIGKILL");
  console.error("bench: hard deadline");
  process.exit(2);
}, 240_000);

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mb = (kb) => (kb / 1024).toFixed(1);

async function footprintMb(pid) {
  try {
    const out = (await run("footprint", ["-p", String(pid), "--noCategories"])).stdout;
    const m = /Footprint:\s+([\d.]+)\s+(KB|MB|GB)/.exec(out);
    return m ? (Number(m[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[m[2]]).toFixed(1) : "?";
  } catch {
    return "?";
  }
}

async function sample(pid) {
  const { stdout } = await run("ps", ["-o", "rss=,%cpu=", "-p", String(pid)]);
  const [rss, cpu] = stdout.trim().split(/\s+/).map(Number);
  return { rss, cpu };
}

async function window(pid, seconds) {
  const rss = [];
  const cpu = [];
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const s = await sample(pid);
    rss.push(s.rss);
    cpu.push(s.cpu);
    await sleep(1000);
  }
  return { rssAvg: mb(rss.reduce((a, b) => a + b, 0) / rss.length), rssMax: mb(Math.max(...rss)), cpuAvg: (cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1), cpuMax: Math.max(...cpu).toFixed(1) };
}

async function hookLatency(label, argv, payload, opts = {}) {
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await new Promise((res) => {
      const c = spawn(argv[0], argv.slice(1), { env: { ...env, ...opts.env }, stdio: ["pipe", "ignore", "ignore"] });
      c.on("close", res);
      c.stdin.end(payload);
    });
    times.push(performance.now() - t0);
  }
  return `${label}: median ${median(times).toFixed(1)} ms, p90 ${[...times].sort((a, b) => a - b)[Math.floor(times.length * 0.9)].toFixed(1)} ms`;
}

try {
  daemon = spawn(node, [...flagsArg.split(" ").filter(Boolean), "--disable-warning=ExperimentalWarning", daemonJs], { env, stdio: "ignore" });
  const t0 = Date.now();
  while (!existsSync(join(data, "agentwatch-hook.sh")) && Date.now() - t0 < 10000) await sleep(100);
  await sleep(1500);
  const startup = Date.now() - t0;
  const base = await sample(daemon.pid);
  console.log(`flags: ${flagsArg}\nruntime: ${execFileSync(node, ["-v"]).toString().trim()}, started in ${startup} ms, RSS right after start ${mb(base.rss)} MB`);

  const payload = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "bench", cwd: "/x", tool_name: "Read", tool_use_id: "t", tool_input: { file_path: "/x/a.ts" } });
  if (!QUICK) console.log("hook latency per tool call (20 runs each, includes process start):");
  if (!QUICK) console.log("  " + (await hookLatency("curl forwarder (new)  ", ["/bin/sh", join(data, "agentwatch-hook.sh"), "claude"], payload)));
  if (!QUICK) console.log("  " + (await hookLatency("node forwarder (old)  ", [node, cliJs, "hook", "claude"], payload)));

  console.log(`\ndaemon, idle for ${IDLE}s:`);
  const idle = await window(daemon.pid, IDLE);
  console.log(`  RSS avg ${idle.rssAvg} MB (max ${idle.rssMax}), footprint ${await footprintMb(daemon.pid)} MB, CPU avg ${idle.cpuAvg}% (max ${idle.cpuMax}%)`);

  const secret = (await run("cat", [join(data, "secret")])).stdout.trim();
  const port = Number(/127\.0\.0\.1:(\d+)/.exec((await run("cat", [join(data, "agentwatch-hook.sh")])).stdout)[1]);
  const post = (body) => fetch(`http://127.0.0.1:${port}/hook/claude`, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
  let sent = 0;
  const loadTimer = setInterval(() => {
    for (let i = 0; i < RATE / 10; i++) {
      void post({ ...JSON.parse(payload), tool_use_id: `t${sent}`, session_id: `bench-${sent % 3}` });
      sent += 1;
    }
  }, 100);
  console.log(`\ndaemon under a steady load of ${RATE} events/s for ${LOAD}s (3 sessions):`);
  const load = await window(daemon.pid, LOAD);
  clearInterval(loadTimer);
  console.log(`  RSS avg ${load.rssAvg} MB (max ${load.rssMax}), footprint ${await footprintMb(daemon.pid)} MB, CPU avg ${load.cpuAvg}% (max ${load.cpuMax}%), ${sent} events sent`);

  const burstStart = performance.now();
  const codes = await Promise.all(Array.from({ length: 2000 }, (_, i) => post({ ...JSON.parse(payload), tool_use_id: `b${i}` }).then((r) => r.status, () => 0)));
  const accepted = codes.filter((c) => c === 204).length;
  await sleep(500);
  const after = await sample(daemon.pid);
  console.log(`\nburst of 2000 simultaneous requests: ${accepted} accepted, ${2000 - accepted} refused (connection cap), took ${(performance.now() - burstStart - 500).toFixed(0)} ms; RSS afterwards ${mb(after.rss)} MB`);
  await sleep(4000);
  const settled = await sample(daemon.pid);
  console.log(`4 s later: RSS ${mb(settled.rss)} MB, footprint ${await footprintMb(daemon.pid)} MB, CPU ${settled.cpu}%`);
} finally {
  clearTimeout(hard);
  daemon?.kill("SIGTERM");
  await sleep(500);
  rmSync(home, { recursive: true, force: true });
}
