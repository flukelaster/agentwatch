import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { IngestFrameSchema, type MintResponse, type TraySummary } from "@agentwatch/protocol";
import type { DaemonConfig } from "../config";
import type { Diagnostics } from "../diagnostics";
import type { SessionManager } from "../session-manager";
import type { CapabilityStore } from "./capabilities";
import type { QueryContext } from "./queries";
import { runQuery } from "./queries";

const MAX_LINE_BYTES = 256 * 1024;

export interface IngestDeps {
  config: DaemonConfig;
  manager: SessionManager;
  caps: CapabilityStore;
  diagnostics: Diagnostics;
  query: QueryContext;
  wsPort: () => number;
}

/** Counts for the menu-bar item. Sessions that are actually running (an idle one is open but not running), approvals waiting on a person, sessions with a failed agent. */
export function traySummary(manager: SessionManager): TraySummary {
  const open = [...manager.sessions.values()].filter((s) => !s.endedAt);
  const failedIds = new Set([...manager.agents.values()].filter((a) => a.status === "failed").map((a) => a.sessionId));
  return {
    running: open.filter((s) => s.status === "running").length,
    waiting: [...manager.requests.values()].filter((r) => r.status === "pending").length,
    failed: open.filter((s) => failedIds.has(s.id)).length,
  };
}

function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    const done = (live: boolean) => {
      s.destroy();
      resolve(live);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), 500).unref();
  });
}

/**
 * Local ingestion channel: newline-delimited JSON over a Unix domain socket in a 0700 directory.
 * Hook forwarders and the wrapper post events here; the Tauri side asks it to mint UI capabilities.
 * Access control is filesystem permissions on the socket, i.e. the logged-in user only.
 */
export async function startIngestServer(deps: IngestDeps): Promise<{ close: () => Promise<void> }> {
  const { config, manager, caps, diagnostics, query, wsPort } = deps;
  // macOS allows 103 bytes in a Unix socket path. Say so plainly instead of failing with "listen EINVAL".
  const len = Buffer.byteLength(config.socketPath);
  if (len > 103) {
    throw new Error(`the data directory path is too long for a Unix socket (${len} bytes; macOS allows 103). Set AGENTWATCH_HOME to a shorter path.`);
  }
  mkdirSync(dirname(config.socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(config.socketPath)) {
    if (await isLive(config.socketPath)) throw new Error("agentwatchd is already running (socket is live)");
    unlinkSync(config.socketPath);
  }

  const reply = (sock: Socket, body: unknown): void => {
    if (!sock.destroyed) sock.write(JSON.stringify(body) + "\n");
  };

  const watchers = new Set<Socket>();
  let last = "";
  let timer: NodeJS.Timeout | undefined;
  const pushSummary = (force = false) => {
    if (watchers.size === 0) return;
    const line = JSON.stringify({ ok: true, summary: traySummary(manager) });
    if (!force && line === last) return;
    last = line;
    for (const w of watchers) if (!w.destroyed) w.write(line + "\n");
  };
  const schedule = () => {
    if (watchers.size === 0 || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      pushSummary();
    }, 250);
    timer.unref();
  };
  for (const ev of ["session", "request", "agent", "removed", "wiped"] as const) manager.on(ev, schedule);

  const server: Server = createServer((sock) => {
    let buf = "";
    sock.on("close", () => watchers.delete(sock));
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES && !buf.includes("\n")) {
        reply(sock, { ok: false, error: "line too long" });
        sock.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame: ReturnType<typeof IngestFrameSchema.safeParse>;
        try {
          frame = IngestFrameSchema.safeParse(JSON.parse(line));
        } catch {
          reply(sock, { ok: false, error: "bad json" });
          continue;
        }
        if (!frame.success) {
          reply(sock, { ok: false, error: "bad frame" });
          continue;
        }
        const f = frame.data;
        if (f.op === "event") {
          try {
            const e = manager.ingest(f.event);
            reply(sock, { ok: true, sequence: e?.sequence ?? null });
          } catch {
            reply(sock, { ok: false, error: "invalid event" });
          }
        } else if (f.op === "watch") {
          watchers.add(sock);
          reply(sock, { ok: true, summary: traySummary(manager) });
        } else if (f.op === "mint") {
          const { token, expiresAt } = caps.mint();
          const body: MintResponse = { token, expiresAt, port: wsPort(), host: "127.0.0.1" };
          reply(sock, { ok: true, ...body });
        } else {
          reply(sock, { ok: true, status: runQuery("status", undefined, query) });
        }
      }
    });
    sock.on("error", () => sock.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.socketPath, () => resolve());
  });
  chmodSync(config.socketPath, 0o600);
  diagnostics.info("ingest", `socket ${config.socketPath}`);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        for (const ev of ["session", "request", "agent", "removed", "wiped"] as const) manager.off(ev, schedule);
        for (const w of watchers) w.destroy();
        server.close(() => {
          try {
            unlinkSync(config.socketPath);
          } catch {
            /* already gone */
          }
          resolve();
        });
        // idle connections would hold close() open
        setTimeout(resolve, 500).unref();
      }),
  };
}
