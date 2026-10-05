import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { MintResponse, ServerFrame } from "@agentwatch/protocol";
import { loadConfig } from "../src/config";
import { startDaemon, type RunningDaemon } from "../src/daemon";

let dir: string;
let daemon: RunningDaemon;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "awd-"));
  daemon = await startDaemon(loadConfig({ AGENTWATCH_HOME: dir }), { quiet: true, observers: false });
});
afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

function ipc(frame: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = createConnection(daemon.config.socketPath);
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      if (buf.includes("\n")) {
        s.end();
        resolve(JSON.parse(buf.split("\n")[0]!));
      }
    });
    s.on("error", reject);
    s.on("connect", () => s.write(JSON.stringify(frame) + "\n"));
  });
}

const mint = async (): Promise<MintResponse> => (await ipc({ op: "mint" })) as unknown as MintResponse;

function open(origin?: string): Promise<{ ws: WebSocket; frames: ServerFrame[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`, origin ? { origin } : undefined);
    const frames: ServerFrame[] = [];
    const closed = new Promise<number>((res) => ws.on("close", (code) => res(code)));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    ws.on("open", () => resolve({ ws, frames, closed }));
    ws.on("error", reject);
  });
}

const waitFor = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const evt = (extra: Record<string, unknown> = {}) => ({
  provider: "claude-code",
  providerSessionId: "s1",
  kind: "tool.started",
  source: "claude-hook",
  confidence: "high",
  payload: { toolName: "Read", target: "/a/b.ts" },
  ...extra,
});

describe("daemon", () => {
  it("binds the WebSocket to loopback and locks down the socket", () => {
    expect(daemon.config.wsHost).toBe("127.0.0.1");
    expect(statSync(daemon.config.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(daemon.config.statePath).mode & 0o777).toBe(0o600);
  });

  it("sends nothing before authentication and closes unauthenticated clients", async () => {
    await ipc({ op: "event", event: evt() });
    const { ws, frames, closed } = await open();
    ws.send(JSON.stringify({ type: "subscribe", sessionIds: ["*"], afterSequence: 0 }));
    expect(await closed).toBe(4401);
    expect(frames).toHaveLength(0);
  });

  it("rejects a bad or reused capability", async () => {
    const a = await open();
    a.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: "not-a-real-token-123" }));
    expect(await a.closed).toBe(4401);

    const { token } = await mint();
    const b = await open();
    b.ws.send(JSON.stringify({ type: "hello", protocol: 1, token }));
    await waitFor(() => b.frames.some((f) => f.type === "ready"));
    b.ws.close();

    const c = await open();
    c.ws.send(JSON.stringify({ type: "hello", protocol: 1, token }));
    expect(await c.closed).toBe(4401);
    expect(c.frames).toHaveLength(0);
  });

  it("rejects a foreign browser origin even with a valid capability", async () => {
    const { token } = await mint();
    await expect(open("https://evil.example")).rejects.toThrow();
    // the token was not consumed by the rejected handshake
    const ok = await open("http://localhost:5173");
    ok.ws.send(JSON.stringify({ type: "hello", protocol: 1, token }));
    await waitFor(() => ok.frames.some((f) => f.type === "ready"));
  });

  it("streams live events and answers queries after authenticating", async () => {
    const { token } = await mint();
    const { ws, frames } = await open();
    ws.send(JSON.stringify({ type: "hello", protocol: 1, token }));
    await waitFor(() => frames.some((f) => f.type === "snapshot"));

    const ack = await ipc({ op: "event", event: evt() });
    expect(ack.ok).toBe(true);
    await waitFor(() => frames.some((f) => f.type === "event"));
    const ev = frames.find((f) => f.type === "event") as Extract<ServerFrame, { type: "event" }>;
    expect(ev.event.kind).toBe("tool.started");
    expect(ev.event.sequence).toBe(1);
    expect(frames.some((f) => f.type === "session")).toBe(true);

    ws.send(JSON.stringify({ type: "query", id: "q1", name: "sessions" }));
    await waitFor(() => frames.some((f) => f.type === "result" && f.id === "q1"));
    const res = frames.find((f) => f.type === "result" && f.id === "q1") as Extract<ServerFrame, { type: "result" }>;
    expect((res.data as unknown[]).length).toBe(1);
  });

  it("replays events after a given sequence on subscribe", async () => {
    for (let i = 0; i < 3; i++) await ipc({ op: "event", event: evt({ payload: { toolName: `T${i}` } }) });
    const { token } = await mint();
    const { ws, frames } = await open();
    ws.send(JSON.stringify({ type: "hello", protocol: 1, token }));
    await waitFor(() => frames.some((f) => f.type === "snapshot"));
    ws.send(JSON.stringify({ type: "subscribe", sessionIds: ["*"], afterSequence: 1 }));
    await waitFor(() => frames.filter((f) => f.type === "event").length === 2);
    const seqs = frames.filter((f) => f.type === "event").map((f) => (f as Extract<ServerFrame, { type: "event" }>).event.sequence);
    expect(seqs).toEqual([2, 3]);
  });

  it("deletes a session through a command and tells clients", async () => {
    await ipc({ op: "event", event: evt() });
    const { token } = await mint();
    const { ws, frames } = await open();
    ws.send(JSON.stringify({ type: "hello", protocol: 1, token }));
    await waitFor(() => frames.some((f) => f.type === "snapshot"));
    const snap = frames.find((f) => f.type === "snapshot") as Extract<ServerFrame, { type: "snapshot" }>;
    ws.send(JSON.stringify({ type: "command", id: "c1", name: "deleteSession", params: { sessionId: snap.sessions[0]!.id } }));
    await waitFor(() => frames.some((f) => f.type === "removed"));
    expect(daemon.manager.sessions.size).toBe(0);
  });

  it("rejects invalid ingest frames without crashing", async () => {
    expect((await ipc({ op: "event", event: { nope: true } })).ok).toBe(false);
    expect((await ipc({ op: "bogus" })).ok).toBe(false);
    expect((await ipc({ op: "status" })).ok).toBe(true);
  });

  it("refuses to start a second daemon on a live socket", async () => {
    await expect(startDaemon(loadConfig({ AGENTWATCH_HOME: dir }), { quiet: true, observers: false })).rejects.toThrow(/already running/);
  });
});

describe("tray summary watch", () => {
  it("sends the counts at once, then again when they change, without being asked", async () => {
    const lines: Array<{ summary: { running: number; waiting: number; failed: number } }> = [];
    const sock = createConnection(daemon.config.socketPath);
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    await new Promise((r) => sock.on("connect", r));
    sock.write('{"op":"watch"}\n');
    await waitFor(() => lines.length === 1);
    expect(lines[0]!.summary).toEqual({ running: 0, waiting: 0, failed: 0 });

    await ipc({ op: "event", event: evt({ providerSessionId: "w1", kind: "approval.requested", payload: { requestId: "r1", kind: "command", summary: "rm -rf x" } }) });
    await waitFor(() => lines.length >= 2);
    // a session blocked on an approval is open but not running
    expect(lines[lines.length - 1]!.summary).toEqual({ running: 0, waiting: 1, failed: 0 });
    await ipc({ op: "event", event: evt({ providerSessionId: "w2" }) });
    await waitFor(() => lines[lines.length - 1]!.summary.running === 1);
    expect(lines[lines.length - 1]!.summary).toEqual({ running: 1, waiting: 1, failed: 0 });
    const n = lines.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(lines.length).toBe(n); // no change, no chatter
    sock.destroy();
  });
});

describe("long data directory", () => {
  it("explains the Unix socket path limit instead of failing with EINVAL, and leaves nothing running", async () => {
    const long = join(dir, "x".repeat(90));
    await expect(startDaemon(loadConfig({ AGENTWATCH_HOME: long }), { quiet: true, observers: false })).rejects.toThrow(/too long for a Unix socket.*AGENTWATCH_HOME/);
  });
});
