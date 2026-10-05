#!/usr/bin/env node
// Real end-to-end check, no mocks: starts agentwatchd, the Vite dev server (which mints the UI's capability
// over the daemon's socket) and the demo scenario, then drives headless Chrome through DevTools Protocol,
// visits every screen, records console errors, takes screenshots and asserts what the user would see.
//
// Everything this script starts is killed when it finishes, and the whole run has a hard deadline.
// Usage: node scripts/e2e-browser.mjs [outDir]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(root, ".data", "e2e-shots"));
mkdirSync(outDir, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "aw-e2e-"));
const chromeBin = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const requireFrom = (dir) => createRequire(join(dir, "package.json"));
const WebSocket = requireFrom(join(root, "services", "daemon"))("ws");
const DEADLINE_MS = 150_000;

const children = [];
let vite;
let profile;
const failures = [];
const notes = [];
const consoleErrors = [];
const check = (name, ok, detail = "") => {
  (ok ? notes : failures).push(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
  try {
    await vite?.close();
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 400));
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  rmSync(home, { recursive: true, force: true });
  if (profile) rmSync(profile, { recursive: true, force: true });
}
const hardStop = setTimeout(async () => {
  console.error("e2e: hard deadline reached, aborting");
  await cleanup();
  process.exit(2);
}, DEADLINE_MS);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// HOME is the throwaway directory too, so nothing in this run can read or touch your real settings files
const env = { ...process.env, AGENTWATCH_HOME: home, HOME: home };

function start(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], ...opts });
  c.stdout.on("data", () => {});
  c.stderr.on("data", () => {});
  children.push(c);
  return c;
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return;
    } catch {
      /* retry */
    }
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ---- Chrome DevTools Protocol, minimal
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        const { resolve: res, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : res(m.result);
      } else if (m.method) for (const h of this.handlers) h(m);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(h) {
    this.handlers.push(h);
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  }
}

async function main() {
  // 1. daemon
  start(process.execPath, ["--import", "tsx", "services/daemon/src/main.ts"]);
  await waitFor(async () => {
    const { existsSync } = await import("node:fs");
    return existsSync(join(home, "agentwatchd.sock")) && existsSync(join(home, "agentwatchd.json"));
  }, 15000, "daemon socket");
  check("daemon started and wrote its socket", true);

  // 2. UI dev server (loads the capability endpoint, which reads AGENTWATCH_HOME)
  process.env.AGENTWATCH_HOME = home;
  const { createServer } = await import(requireFrom(join(root, "apps", "desktop")).resolve("vite").replace(/\\/g, "/").replace(/^/, "file://"));
  vite = await createServer({ root: join(root, "apps", "desktop"), logLevel: "silent", server: { host: "127.0.0.1", port: 5173, strictPort: true } });
  await vite.listen();
  check("vite dev server listening on 127.0.0.1:5173", true);

  // 3. the synthetic scenario starts later, once the browser is watching (see below)

  // 4. Chrome
  profile = mkdtempSync(join(tmpdir(), "aw-chrome-"));
  const port = 9333;
  start(chromeBin, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--window-size=1440,1250", "--hide-scrollbars", "--no-first-run", "--disable-gpu", "about:blank"]);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 15000, "chrome");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  const cdp = new Cdp(ws);
  cdp.on((m) => {
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") consoleErrors.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`);
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1250, deviceScaleFactor: 1, mobile: false });

  // pre-set the onboarding flag so the Overview is the landing page, as for a returning user
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:5173/#/" });
  await sleep(800);
  await cdp.eval(`localStorage.setItem('aw.onboarded','1')`);

  const shot = async (name) => {
    const r = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, "base64"));
  };
  const go = async (hash, wait = 1500) => {
    await cdp.eval(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(wait);
  };
  const text = () => cdp.eval(`document.body.innerText`);

  // ---- Overview, with live data from the real daemon
  await cdp.send("Page.reload");
  await waitFor(async () => { const x = await text(); return x.includes("Nothing is running") && x.includes("agentwatchd connected"); }, 25000, "an authenticated connection and the empty state from the real daemon");
  check("UI connected to the real daemon (empty state before any agent runs)", true);

  // events start flowing now; select the Claude session the moment it appears and watch for streaks
  start(process.execPath, ["--import", "tsx", "cli/agentwatch/src/main.ts", "demo", "--speed", "1", "--seconds", "60"]);
  await waitFor(async () => (await text()).includes("auth-service"), 25000, "sessions to arrive over the real WebSocket");
  await cdp.eval(`(() => { const b=[...document.querySelectorAll('button.tab')].find(x=>x.innerText.includes('auth-service')); b && b.click(); })()`);
  let sawStreak = false;
  let sawFailStreak = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 14000) {
    const r = await cdp.eval(`({ s: document.querySelectorAll('.g-streak').length, f: [...document.querySelectorAll('.g-streak')].some(e => e.style.background.includes('--fail')) })`);
    if (r.s > 0) sawStreak = true;
    if (r.f) sawFailStreak = true;
    await sleep(60);
  }
  check("live events from the daemon produced streaks in the real browser", sawStreak);
  check("the failed worker's return path streaked in the failure color", sawFailStreak);
  let t = await text();
  check("three providers are visible as sessions", /auth-service/.test(t) && /billing-web/.test(t) && /notes-cli/.test(t));
  const claudeTab = await cdp.eval(`(() => { const b=[...document.querySelectorAll('button.tab')].find(x=>x.innerText.includes('auth-service')); b && b.click(); return !!b })()`);
  await sleep(1200);
  const graph = await cdp.eval(`({
    nodes: [...document.querySelectorAll('[data-node-id]')].map(n=>n.dataset.nodeId),
    tones: [...document.querySelectorAll('.gnode[data-tone]')].map(n=>n.dataset.tone),
    streaks: document.querySelector('.stage')?.dataset.streaks,
    mode: document.querySelector('.stage')?.dataset.mode,
    lines: document.querySelectorAll('.g-line').length,
  })`);
  check("Claude session tab is clickable", claudeTab === true);
  check("graph has main + merge + explorer/worker/researcher nodes", ["main", "merge"].every((id) => graph.nodes.includes(id)) && graph.nodes.filter((n) => n.includes(":")).length >= 3, JSON.stringify(graph.nodes));
  check("the failed worker is drawn as failed", graph.tones.includes("fail"));
  check("graph has drawn edges", graph.lines > 8, `${graph.lines} line segments`);
  check("flow defaults to per-event", graph.mode === "event");
  const claudeText = await text();
  check("subagent names come from real hook data (agent_type)", /explore/.test(claudeText) && /worker/.test(claudeText) && /research/.test(claudeText));
  check("session log shows real events, none of them prompts or contents", /Edit|Read|Run/.test(claudeText) && !/SENTINEL|password/i.test(claudeText));
  await shot("overview-claude");


  await cdp.eval(`(() => { const b=[...document.querySelectorAll('button.tab')].find(x=>x.innerText.includes('billing-web')); b && b.click(); })()`);
  await sleep(1000);
  const codexText = await text();
  check("Codex session shows the pending approval and provider-reported tokens", /needs approval/.test(codexText) && /61\.4k/.test(codexText));
  await shot("overview-codex");

  await cdp.eval(`(() => { const b=[...document.querySelectorAll('button.tab')].find(x=>x.innerText.includes('notes-cli')); b && b.click(); })()`);
  await sleep(1000);
  const genericGraph = await cdp.eval(`[...document.querySelectorAll('[data-node-id]')].map(n=>n.dataset.nodeId)`);
  check("generic CLI draws no subagent or merge nodes", !genericGraph.includes("merge") && genericGraph.every((id) => id === "main" || id.startsWith("src:")), JSON.stringify(genericGraph));
  await shot("overview-generic");

  // ---- every other screen
  const screens = [
    ["/sessions", "sessions", (s) => /Sessions/.test(s) && /auth-service/.test(s)],
    ["/agents", "agents", (s) => /What each provider exposes/i.test(s)],
    ["/files", "files", (s) => /Files/.test(s)],
    ["/commands", "commands", (s) => /Commands/.test(s) && /pnpm test/.test(s)],
    ["/logs", "logs", (s) => /Logs/.test(s)],
    ["/settings", "settings", (s) => /Settings/.test(s) && /Delete all local history/i.test(s)],
  ];
  for (const [hash, name, ok] of screens) {
    await go(`#${hash}`, 2200);
    const s = await text();
    check(`screen ${hash} renders its content from the real daemon`, ok(s), s.slice(0, 80).replace(/\n/g, " | "));
    await shot(name);
  }
  // a session detail page via the real link
  await go("#/sessions", 1500);
  const detailHref = await cdp.eval(`[...document.querySelectorAll('a')].map(a=>a.getAttribute('href')).find(h=>h && /^#\\/sessions\\/.+/.test(h))`);
  check("sessions list links to session detail pages", !!detailHref, String(detailHref));
  if (detailHref) {
    await go(detailHref, 2200);
    await shot("session-detail");
    check("session detail renders", /File activity|Command activity/i.test(await text()));
  }
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 640, deviceScaleFactor: 2, mobile: false });
  await go("#/menubar", 2000);
  await shot("menubar");
  check("menu-bar popover renders", /running/i.test(await text()));
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await cdp.eval(`localStorage.removeItem('aw.onboarded')`);
  await go("#/onboarding", 1500);
  await shot("onboarding");
  const onboardingText = await text();
  check("onboarding offers the four setup items", /Set up AgentWatch/.test(onboardingText) && (await cdp.eval(`document.querySelectorAll('input[type=checkbox]').length`)) === 4);
  check("in a browser (not the app) start-at-login and the command line are honestly unavailable", (onboardingText.match(/Not available here/g) ?? []).length === 2);
  const { existsSync } = await import("node:fs");
  check("looking at setup changed nothing on disk", !existsSync(join(home, ".claude", "settings.json")) && !existsSync(join(home, ".local")));

  // ---- privacy: nothing from the page may have gone to a non-loopback host
  const externals = await cdp.eval(`performance.getEntriesByType('resource').map(r=>r.name).filter(n=>!/^(http|ws)s?:\\/\\/(127\\.0\\.0\\.1|localhost)/.test(n) && !n.startsWith('data:') && !n.startsWith('blob:'))`);
  check("no request left the machine (loopback only)", externals.length === 0, externals.join(", "));
  check("no console errors or exceptions in any screen", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" || "));
  ws.close();
}

try {
  await main();
} catch (err) {
  failures.push(`FAIL e2e crashed — ${err.stack ?? err}`);
} finally {
  clearTimeout(hardStop);
  await cleanup();
}
console.log(notes.join("\n"));
if (failures.length) {
  console.log("\n" + failures.join("\n"));
  console.log(`\n${failures.length} check(s) failed. Screenshots: ${outDir}`);
  process.exit(1);
}
console.log(`\nall checks passed. Screenshots: ${outDir}`);
