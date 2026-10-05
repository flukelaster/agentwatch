#!/usr/bin/env node
// Regenerates the screenshots in docs/images from the UI's built-in demo data (?mock=1), so they never show anyone's
// real sessions. Starts the Vite dev server and a headless Chrome, drives it over the DevTools Protocol, and stops both.
// Usage: node scripts/readme-shots.mjs     (CHROME_BIN overrides the Chrome location)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "images");
mkdirSync(out, { recursive: true });
const chromeBin = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const requireFrom = (dir) => createRequire(join(dir, "package.json"));
const WebSocket = requireFrom(join(root, "services", "daemon"))("ws");
const PORT = 5198;
const DEBUG = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let vite;
let chrome;
const profile = mkdtempSync(join(tmpdir(), "aw-shots-"));
async function cleanup() {
  try { chrome?.kill("SIGTERM"); } catch { /* gone */ }
  try { await vite?.close(); } catch { /* ignore */ }
  await sleep(300);
  try { chrome?.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(profile, { recursive: true, force: true });
}
const hardStop = setTimeout(async () => { console.error("readme-shots: hard deadline reached"); await cleanup(); process.exit(2); }, 120_000);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        const { resolve: res, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  }
}

try {
  const { createServer } = await import(requireFrom(join(root, "apps", "desktop")).resolve("vite").replace(/\\/g, "/").replace(/^/, "file://"));
  vite = await createServer({ root: join(root, "apps", "desktop"), logLevel: "silent", server: { host: "127.0.0.1", port: PORT, strictPort: true } });
  await vite.listen();

  chrome = spawn(chromeBin, ["--headless=new", `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, "--disable-gpu", "--hide-scrollbars", "--no-first-run", "about:blank"], { stdio: "ignore" });
  let version;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${DEBUG}/json/version`)).json(); } catch { await sleep(200); }
  }
  if (!version) throw new Error("Chrome did not start");
  const target = await (await fetch(`http://127.0.0.1:${DEBUG}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const shot = async (name, width, height) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`wrote docs/images/${name}.png (${width}x${height} @2x)`);
  };
  const open = async (query, hash, width, height) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/?mock=1${query}${hash}` });
    await sleep(1800);
  };
  const click = (text, role) => cdp.eval(`(() => { const el = [...document.querySelectorAll('${role}')].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.click(); return true; })()`);

  // 1. the Running tab: stats, context window, the agent graph (without the approval glow the demo data would add)
  await open("&tokens=1&reported=1", "", 1440, 1180);
  await click("Not now", "button"); // the "connect your agents" notice is not what this picture is about
  await cdp.eval(`(() => { const s = document.createElement("style"); s.id = "no-attn"; s.textContent = ".attn{display:none!important}"; document.head.append(s); })()`);
  await sleep(500);
  await shot("overview", 1440, 1180);

  // 2. a session asks for approval: the window glows
  await cdp.eval(`document.getElementById("no-attn")?.remove()`);
  await click("Needs you", '[role="tab"]');
  await sleep(1500);
  await shot("approval", 1440, 900);

  // 3. nothing running
  await open("&quiet=1", "", 1440, 900);
  await shot("empty", 1440, 900);

  // 4. the agents table and what each provider exposes
  await open("", "#/agents", 1440, 1180);
  await shot("agents", 1440, 1180);

  // 5. connections
  await open("", "#/settings", 1440, 1300);
  await shot("connections", 1440, 1300);

  ws.close();
} finally {
  clearTimeout(hardStop);
  await cleanup();
}
