import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { MintResponse } from "@agentwatch/protocol";
import { createConnection } from "node:net";
import { loadConfig } from "../src/config";
import { startDaemon, type RunningDaemon } from "../src/daemon";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/claude/session-with-subagents.json", import.meta.url)), "utf8")) as Array<Record<string, unknown>>;

let dir: string;
let home: string;
let daemon: RunningDaemon;
const saved = { HOME: process.env.HOME, APP: process.env.AGENTWATCH_APP_EXE, CLI: process.env.AGENTWATCH_CLI_SCRIPT, NODE: process.env.AGENTWATCH_NODE };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "awh-"));
  home = join(dir, "AgentWatch");
  mkdirSync(home);
  process.env.HOME = dir; // the setup commands must only ever touch this throwaway home
  process.env.AGENTWATCH_APP_EXE = join(dir, "AgentWatch.app", "Contents", "MacOS", "agentwatch-desktop");
  process.env.AGENTWATCH_CLI_SCRIPT = join(dir, "agentwatch.mjs");
  process.env.AGENTWATCH_NODE = process.execPath;
  mkdirSync(join(dir, ".claude"));
  daemon = await startDaemon(loadConfig({ AGENTWATCH_HOME: home }), { quiet: true, observers: false });
});
afterEach(async () => {
  await daemon.stop().catch(() => undefined);
  for (const [k, v] of [["HOME", saved.HOME], ["AGENTWATCH_APP_EXE", saved.APP], ["AGENTWATCH_CLI_SCRIPT", saved.CLI], ["AGENTWATCH_NODE", saved.NODE]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const script = () => join(home, "agentwatch-hook.sh");

function runHook(provider: string, payload: unknown, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn("/bin/sh", [script(), provider], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code, out }));
    c.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

// async on purpose: the daemon runs inside this test process, so a blocking spawn would stall it
const curl = (args: string[], body?: string): Promise<string> =>
  new Promise((resolve) => {
    const c = execFile("/usr/bin/curl", ["-s", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", ...args], (_e, out) => resolve(out));
    c.stdin?.on("error", () => undefined);
    c.stdin?.end(body ?? "");
  });
const curlRaw = (args: string[]): Promise<string> => new Promise((resolve) => execFile("/usr/bin/curl", ["-s", "-i", "-m", "5", ...args], (_e, out) => resolve(out)));

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 15));
  }
};

describe("curl forwarder", () => {
  it("writes a private script, header file and secret", () => {
    expect(statSync(script()).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "hook-headers")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "secret")).mode & 0o777).toBe(0o600);
    const text = readFileSync(script(), "utf8");
    expect(text).toContain(`127.0.0.1:${daemon.wsPort}`);
    expect(text).not.toContain(readFileSync(join(home, "secret"), "utf8").trim()); // the secret is only in the 0600 file
    expect(text).toContain("/usr/bin/curl");
  });

  it("turns a real Claude session into rows, exits 0 and prints nothing", async () => {
    for (const p of fixture) {
      const r = await runHook("claude", p);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    }
    await waitFor(() => [...daemon.manager.sessions.values()].some((s) => s.status === "finished"));
    const s = [...daemon.manager.sessions.values()][0]!;
    expect(s.counts.failedCommands).toBe(1);
    expect([...daemon.manager.agents.values()].some((a) => a.providerAgentId === "agent_worker" && a.status === "failed")).toBe(true);
  });

  it("never stores or logs prompts, file contents or credentials from the raw payload", async () => {
    for (const p of fixture) await runHook("claude", p);
    await waitFor(() => [...daemon.manager.sessions.values()].some((s) => s.status === "finished"));
    const dump = JSON.stringify(daemon.store.queryEvents({ limit: 5000 })) + JSON.stringify(daemon.store.queryCommands()) + JSON.stringify(daemon.store.queryFiles()) + JSON.stringify(daemon.diagnostics.recent(500));
    for (const secret of ["SENTINEL", "hunter2", "abcdef1234567890xyz"]) expect(dump).not.toContain(secret);
    // and a raw dump of the database file itself
    daemon.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(join(home, "agentwatch.db")).includes("SENTINEL")).toBe(false);
  });

  it("joins a wrapped session through AGENTWATCH_SESSION_ID", async () => {
    await runHook("claude", { hook_event_name: "SessionStart", session_id: "p1", cwd: "/x", model: "m" }, { AGENTWATCH_SESSION_ID: "wrap-77" });
    await waitFor(() => daemon.manager.sessions.has("wrap-77"));
    expect(daemon.manager.sessions.get("wrap-77")?.providerSessionId).toBe("p1");
  });

  it("turns real Gemini CLI and Cursor sessions into rows, with their own provider and evidence source", async () => {
    const load = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/${n}/hooks-session.json`, import.meta.url)), "utf8")) as Array<Record<string, unknown>>;
    for (const p of load("gemini")) expect((await runHook("gemini", p)).out).toBe("");
    for (const p of load("cursor")) expect((await runHook("cursor", p)).out).toBe("");
    await waitFor(() => [...daemon.manager.sessions.values()].filter((s) => s.status === "finished").length === 2);
    const by = (provider: string) => [...daemon.manager.sessions.values()].find((s) => s.provider === provider)!;
    expect(by("gemini-cli")).toMatchObject({ providerSessionId: "g-sess-1", sources: ["gemini-hook"], cwd: "/Users/dev/work/api" });
    expect(by("gemini-cli").counts.failedCommands).toBe(1);
    expect(by("cursor")).toMatchObject({ providerSessionId: "c-conv-1", sources: ["cursor-hook"], cwd: "/Users/dev/work/web" });
    const dump = JSON.stringify(daemon.store.queryEvents({ limit: 5000 })) + JSON.stringify(daemon.diagnostics.recent(500));
    expect(dump).not.toContain("SECRET");
    expect(dump).not.toContain("dev@example.com");
  });

  it("shows a Gemini session as running while a turn is in flight", async () => {
    await runHook("gemini", { hook_event_name: "SessionStart", session_id: "live", cwd: "/x", source: "startup" });
    await runHook("gemini", { hook_event_name: "BeforeAgent", session_id: "live", cwd: "/x", prompt: "SECRET" });
    await waitFor(() => [...daemon.manager.sessions.values()].some((s) => s.provider === "gemini-cli" && s.status === "running"));
    await runHook("gemini", { hook_event_name: "AfterAgent", session_id: "live", cwd: "/x", prompt: "SECRET", prompt_response: "SECRET" });
    await waitFor(() => [...daemon.manager.sessions.values()].some((s) => s.provider === "gemini-cli" && s.status === "idle"));
  });

  it("turns a real Antigravity session into rows, and answers with the {} that agy reads from a hook (other agents get nothing)", async () => {
    const load = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/antigravity/hooks-session.json", import.meta.url)), "utf8")) as Array<Record<string, unknown>>;
    for (const p of load) expect((await runHook("antigravity", p)).out).toBe("{}\n");
    expect((await runHook("claude", { hook_event_name: "SessionStart", session_id: "s", cwd: "/x" })).out).toBe("");
    await waitFor(() => [...daemon.manager.sessions.values()].some((s) => s.provider === "antigravity" && s.status === "idle"));
    const s = [...daemon.manager.sessions.values()].find((x) => x.provider === "antigravity")!;
    expect(s).toMatchObject({ sources: ["antigravity-hook"], cwd: "/Users/dev/work/site" });
    expect(s.counts.failedCommands).toBe(1);
    expect(JSON.stringify(daemon.store.queryEvents({ limit: 5000 }))).not.toContain("SECRET-CODE"); // the file body was in the payload
  });

  it("refuses a provider it does not know", async () => {
    const secret = readFileSync(join(home, "secret"), "utf8").trim();
    expect(await curl(["-X", "POST", "-H", `Authorization: Bearer ${secret}`, `http://127.0.0.1:${daemon.wsPort}/hook/aider`], "{}")).toBe("404");
  });

  it("maps Codex hooks too", async () => {
    await runHook("codex", { hook_event_name: "SessionStart", session_id: "t1", cwd: "/x", model: "gpt-5-codex" });
    await waitFor(() => [...daemon.manager.sessions.values()].some((s) => s.provider === "codex"));
  });

  it("is fast and does not start Node", async () => {
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      await runHook("claude", { hook_event_name: "Stop", session_id: "perf" });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)]!;
    process.stdout.write(`      hook.sh median ${median.toFixed(1)} ms (p90 ${times[Math.floor(times.length * 0.9)]!.toFixed(1)} ms)\n`);
    expect(median).toBeLessThan(150);
  });

  it("exits 0 silently when the daemon is not running", async () => {
    await daemon.stop();
    const t0 = performance.now();
    const r = await runHook("claude", fixture[0]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(performance.now() - t0).toBeLessThan(2500);
    daemon = await startDaemon(loadConfig({ AGENTWATCH_HOME: home }), { quiet: true, observers: false });
  });
});

describe("hook endpoint security", () => {
  const url = () => `http://127.0.0.1:${daemon.wsPort}/hook/claude`;
  const good = () => `Authorization: Bearer ${readFileSync(join(home, "secret"), "utf8").trim()}`;
  const body = JSON.stringify({ hook_event_name: "SessionStart", session_id: "sec", cwd: "/x" });

  it("rejects a missing or wrong secret and creates nothing", async () => {
    expect(await curl(["-X", "POST", "--data-binary", "@-", url()], body)).toBe("401");
    expect(await curl(["-X", "POST", "-H", "Authorization: Bearer nope", "--data-binary", "@-", url()], body)).toBe("401");
    await new Promise((r) => setTimeout(r, 100));
    expect(daemon.manager.sessions.size).toBe(0);
  });

  it("says why a hook was rejected, instead of only counting it", async () => {
    await curl(["-X", "POST", "-H", good(), "--data-binary", "@-", url()], "{not json");
    await curl(["-X", "POST", "--data-binary", "@-", url()], "{}"); // no secret
    await new Promise((r) => setTimeout(r, 100));
    const lines = daemon.diagnostics.recent().map((d) => d.msg);
    expect(lines.some((l) => /rejected \(bad json\): \d+ bytes/.test(l))).toBe(true);
    expect(lines.some((l) => /rejected \(unauthorized\)/.test(l))).toBe(true);
  });

  it("accepts the right secret", async () => {
    expect(await curl(["-X", "POST", "-H", good(), "--data-binary", "@-", url()], body)).toBe("204");
    await waitFor(() => daemon.manager.sessions.size === 1);
  });

  it("rejects oversized bodies, bad JSON, wrong paths and methods", async () => {
    expect(await curl(["-X", "POST", "-H", good(), "--data-binary", "@-", url()], "x".repeat(2 * 1024 * 1024 + 10))).toMatch(/413|000|100/); // curl may only ever see the "100 Continue" before the connection is dropped
    expect(await curl(["-X", "POST", "-H", good(), "--data-binary", "@-", url()], "{not json")).toBe("400");
    expect(await curl(["-X", "POST", "-H", good(), "--data-binary", "@-", `http://127.0.0.1:${daemon.wsPort}/hook/evil`], body)).toBe("404");
    expect(await curl(["-X", "GET", `http://127.0.0.1:${daemon.wsPort}/hook/claude`])).toBe("404");
    expect(await curl(["-X", "POST", "-H", good(), "--data-binary", "@-", `http://127.0.0.1:${daemon.wsPort}/`], body)).toBe("404");
    await new Promise((r) => setTimeout(r, 100));
    expect(daemon.manager.sessions.size).toBe(0);
  });

  it("never answers a browser preflight, so a web page cannot post events", async () => {
    const out = await curlRaw(["-X", "OPTIONS", "-H", "Origin: https://evil.example", "-H", "Access-Control-Request-Method: POST", "-H", "Access-Control-Request-Headers: authorization", url()]);
    expect(out).toMatch(/^HTTP\/1\.1 404/);
    expect(out.toLowerCase()).not.toContain("access-control-allow");
  });
});

describe("setup commands over the authenticated WebSocket", () => {
  async function connect() {
    const sock = createConnection(daemon.config.socketPath);
    const mint = await new Promise<MintResponse>((resolve) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (d: string) => {
        buf += d;
        if (buf.includes("\n")) {
          sock.end();
          resolve(JSON.parse(buf));
        }
      });
      sock.on("connect", () => sock.write('{"op":"mint"}\n'));
    });
    const ws = new WebSocket(`ws://127.0.0.1:${mint.port}`);
    const frames: Array<Record<string, any>> = [];
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", protocol: 1, token: mint.token }));
    await waitFor(() => frames.some((f) => f.type === "ready"));
    const ask = async (type: "query" | "command", name: string, params?: unknown) => {
      const id = `${name}-${frames.length}`;
      ws.send(JSON.stringify({ type, id, name, params }));
      await waitFor(() => frames.some((f) => f.id === id));
      return frames.find((f) => f.id === id)!;
    };
    return { ws, ask };
  }

  it("shows the conversation only after the person turns it on, and deletes it when they turn it off", async () => {
    const projects = join(dir, ".claude", "projects", "p");
    mkdirSync(projects, { recursive: true });
    const file = join(projects, "chat1.jsonl");
    const row = (o: unknown) => JSON.stringify(o) + "\n";
    writeFileSync(
      file,
      row({ type: "ai-title", aiTitle: "Fix the login redirect" }) +
        row({ type: "user", uuid: "u1", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "Why does login loop? my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } }) +
        row({ type: "assistant", uuid: "a1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "The redirect uses the old path.\n\n```ts\nredirect('/home')\n```" }] } }),
    );
    // this test needs the observers (the file reader lives with them), which the other tests leave off
    await daemon.stop();
    daemon = await startDaemon(loadConfig({ AGENTWATCH_HOME: home }), { quiet: true, observers: true });
    // a real hook, through the real script, names the conversation file
    const hook = await runHook("claude", { hook_event_name: "SessionStart", session_id: "chat1", cwd: "/x", transcript_path: file });
    expect(hook.code).toBe(0);
    await waitFor(() => daemon.manager.sessions.size === 1);
    const id = [...daemon.manager.sessions.keys()][0]!;

    // 1. both switches are off by default: nothing is read, nothing is kept
    await new Promise((r) => setTimeout(r, 1500));
    expect(daemon.store.messageIds(id).size).toBe(0);

    // 2. turn them on over the authenticated WebSocket
    const { ws, ask } = await connect();
    await ask("command", "setSettings", { patch: { storePromptText: true, storeAssistantText: true } });
    await waitFor(() => daemon.store.messageIds(id).size === 2, 8000);
    expect(daemon.manager.sessions.get(id)!.title).toBe("Fix the login redirect");

    // the credential was redacted before it was stored
    const rows = (daemon.store as any).db.prepare("SELECT payload_json FROM events WHERE kind = 'message' ORDER BY sequence").all() as Array<{ payload_json: string }>;
    expect(rows.map((r) => JSON.parse(r.payload_json).role)).toEqual(["user", "assistant"]);
    expect(rows[0]!.payload_json).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(JSON.parse(rows[1]!.payload_json).body).toContain("```ts"); // code fences and line breaks survive

    // 3. turning prompts off deletes the prompts, and keeps the replies
    await ask("command", "setSettings", { patch: { storePromptText: false } });
    await waitFor(() => daemon.store.messageIds(id).size === 1);
    const left = (daemon.store as any).db.prepare("SELECT payload_json FROM events WHERE kind = 'message'").all() as Array<{ payload_json: string }>;
    expect(left.map((r) => JSON.parse(r.payload_json).role)).toEqual(["assistant"]);
    ws.close();
  }, 20000);

  it("reports what is installed, applies, is idempotent, and reverts - inside the throwaway home only", async () => {
    const { ws, ask } = await connect();
    const st = (await ask("query", "setupStatus")).data;
    expect(st.claude).toMatchObject({ detected: true, hooks: { state: "missing" } });
    expect(st.managed).toBe(true);

    writeCli();
    const applied = (await ask("command", "setupApply", { items: ["claude", "codex", "cli", "autostart"] })).data;
    expect(applied.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(applied.status.claude.hooks.state).toBe("installed");
    expect(applied.status.autostart.state).toBe("installed");
    const settings = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    expect(settings).toContain(join(home, "agentwatch-hook.sh"));
    expect(settings).not.toContain("agentwatch.mjs");
    expect(existsSync(join(dir, "Library", "LaunchAgents", "dev.agentwatch.app.plist"))).toBe(true);
    expect(readFileSync(join(dir, "Library", "LaunchAgents", "dev.agentwatch.app.plist"), "utf8")).toContain("--hidden");

    const again = (await ask("command", "setupApply", { items: ["claude", "cli", "autostart"] })).data;
    expect(again.results.every((r: { changed: boolean }) => !r.changed)).toBe(true);
    expect((await ask("query", "settings")).data).toMatchObject({ claudeIntegration: true, startAtLogin: true, cliInstalled: true });

    const reverted = (await ask("command", "setupRevert", { items: ["claude", "codex", "cli", "autostart"] })).data;
    expect(reverted.status.claude.hooks.state).toBe("missing");
    expect(reverted.status.cli.state).toBe("missing");
    expect((await ask("query", "settings")).data).toMatchObject({ claudeIntegration: false, startAtLogin: false });
    expect((await ask("command", "setupApply", { items: ["nonsense"] })).type).toBe("error");
    ws.close();
  });

  function writeCli() {
    require("node:fs").writeFileSync(join(dir, "agentwatch.mjs"), "// cli\n");
  }
});

describe("start-up repair of a moved app", () => {
  it("rewrites a launcher and login item that point at the old location when the service starts, and nothing else", async () => {
    await daemon.stop();
    require("node:fs").writeFileSync(join(dir, "agentwatch.mjs"), "// cli\n");
    const old = { home: dir, agentwatchHome: home, cli: { node: process.execPath, script: join(dir, "agentwatch.mjs") }, appExe: "/Applications/Old.app/Contents/MacOS/agentwatch-desktop" };
    const { setupApply, setupStatus } = await import("@agentwatch/setup");
    expect(setupApply(old, ["cli", "autostart"]).every((r) => r.ok)).toBe(true);
    const plist = join(dir, "Library", "LaunchAgents", "dev.agentwatch.app.plist");
    expect(readFileSync(plist, "utf8")).toContain("/Applications/Old.app");

    daemon = await startDaemon(loadConfig({ AGENTWATCH_HOME: home }), { quiet: true, observers: false });
    expect(readFileSync(plist, "utf8")).toContain(process.env.AGENTWATCH_APP_EXE!);
    expect(readFileSync(plist, "utf8")).not.toContain("Old.app");
    const status = setupStatus({ ...old, appExe: process.env.AGENTWATCH_APP_EXE!, appEnv: { AGENTWATCH_HOME: home } });
    expect(status.autostart.state).toBe("installed");
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false); // agent settings are never touched by a repair
  });
});
