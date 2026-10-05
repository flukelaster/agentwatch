import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientFrameSchema,
  PROTOCOL_VERSION,
  type AgentEvent,
  type ClientFrame,
  type ServerFrame,
} from "@agentwatch/protocol";
import type { DaemonConfig } from "../config";
import type { Diagnostics } from "../diagnostics";
import type { SessionManager } from "../session-manager";
import type { CapabilityStore } from "./capabilities";
import { handleHookRequest, type HookHandlerDeps } from "./hook-http";
import { runCommand, runQuery, type QueryContext } from "./queries";

const HELLO_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_BAD_FRAMES = 5;
const MAX_REPLAY = 5000;

interface Client {
  ws: WebSocket;
  authed: boolean;
  /** "*" or an explicit set of session ids. */
  sessions: Set<string> | "*";
  bad: number;
}

export interface WsServerDeps {
  config: DaemonConfig;
  manager: SessionManager;
  caps: CapabilityStore;
  diagnostics: Diagnostics;
  query: QueryContext;
  hook: HookHandlerDeps;
}

export interface RunningWsServer {
  port: number;
  clients: () => number;
  close: () => Promise<void>;
}

/**
 * Loopback-only WebSocket for the UI. No session data is sent before the first frame authenticates
 * with a single-use capability. Browsers cannot set an Authorization header, so the token travels in
 * the first frame, never in the URL.
 */
export async function startWsServer(deps: WsServerDeps): Promise<RunningWsServer> {
  const { config, manager, caps, diagnostics, query } = deps;
  const http: Server = createServer((req, res) => {
    if (handleHookRequest(req, res, deps.hook)) return;
    res.writeHead(404, { "content-length": "0" }).end();
  });
  // Loopback only and tiny traffic: cap what a runaway client could cost us in memory.
  http.maxConnections = 256;
  http.headersTimeout = 5000;
  http.requestTimeout = 10_000;
  http.keepAliveTimeout = 1000;
  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: (info, done) => {
      const origin = info.origin;
      if (origin && !config.allowedOrigins.includes(origin)) {
        diagnostics.warn("ws", `rejected origin ${origin}`);
        done(false, 403, "origin not allowed");
        return;
      }
      done(true);
    },
  });
  const clients = new Set<Client>();

  const sendText = (c: Client, text: string): void => {
    if (c.ws.readyState !== c.ws.OPEN) return;
    if (c.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      diagnostics.warn("ws", "dropping slow consumer");
      c.ws.close(4008, "slow consumer");
      return;
    }
    c.ws.send(text);
  };
  const send = (c: Client, frame: ServerFrame): void => sendText(c, JSON.stringify(frame));
  /** One JSON.stringify per frame no matter how many windows are listening, and none when nobody is. */
  const fanout = (sessionId: string | undefined, frame: ServerFrame): void => {
    let text: string | undefined;
    for (const c of clients) {
      if (!c.authed || (sessionId !== undefined && !wants(c, sessionId))) continue;
      text ??= JSON.stringify(frame);
      sendText(c, text);
    }
  };
  const wants = (c: Client, sessionId: string): boolean => c.authed && (c.sessions === "*" || c.sessions.has(sessionId));

  const onEvent = (e: AgentEvent): void => fanout(e.sessionId, { type: "event", event: e });
  const onSession = (session: { id: string }): void => fanout(session.id, { type: "session", session: session as never });
  const onAgent = (agent: { sessionId: string }): void => fanout(agent.sessionId, { type: "agent", agent: agent as never });
  const onRequest = (request: { sessionId: string }): void => fanout(request.sessionId, { type: "request", request: request as never });
  const onRemoved = (sessionId: string): void => fanout(undefined, { type: "removed", sessionId });
  const onWiped = (): void => fanout(undefined, { type: "wiped" });
  manager.on("event", onEvent);
  manager.on("session", onSession);
  manager.on("agent", onAgent);
  manager.on("request", onRequest);
  manager.on("removed", onRemoved);
  manager.on("wiped", onWiped);

  const handle = (c: Client, frame: ClientFrame): void => {
    switch (frame.type) {
      case "hello":
        send(c, { type: "error", code: "already_authenticated", message: "hello already accepted" });
        return;
      case "ping":
        send(c, { type: "pong" });
        return;
      case "unsubscribe":
        c.sessions = new Set();
        return;
      case "subscribe": {
        c.sessions = frame.sessionIds.includes("*") ? "*" : new Set(frame.sessionIds);
        if (frame.afterSequence !== undefined) {
          const ids = c.sessions === "*" ? [undefined] : [...c.sessions];
          for (const sessionId of ids) {
            const replay = query.store.queryEvents({ sessionId, afterSequence: frame.afterSequence, limit: MAX_REPLAY });
            for (const event of replay) send(c, { type: "event", event });
          }
        }
        return;
      }
      case "query":
        try {
          send(c, { type: "result", id: frame.id, data: runQuery(frame.name, frame.params, query) });
        } catch (err) {
          send(c, { type: "error", code: "query_failed", message: (err as Error).message, id: frame.id });
        }
        return;
      case "command":
        try {
          send(c, { type: "result", id: frame.id, data: runCommand(frame.name, frame.params, query) });
        } catch (err) {
          send(c, { type: "error", code: "command_failed", message: (err as Error).message, id: frame.id });
        }
        return;
    }
  };

  wss.on("connection", (ws) => {
    const c: Client = { ws, authed: false, sessions: "*", bad: 0 };
    clients.add(c);
    const timer = setTimeout(() => {
      if (!c.authed) ws.close(4001, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        parsed = undefined;
      }
      const result = ClientFrameSchema.safeParse(parsed);
      if (!result.success) {
        c.bad += 1;
        if (!c.authed) {
          ws.close(4400, "bad frame");
          return;
        }
        send(c, { type: "error", code: "bad_frame", message: "invalid frame" });
        if (c.bad >= MAX_BAD_FRAMES) ws.close(4400, "too many bad frames");
        return;
      }
      const frame = result.data;
      if (!c.authed) {
        if (frame.type !== "hello" || !caps.consume(frame.token)) {
          diagnostics.warn("ws", "unauthenticated client rejected");
          ws.close(4401, "unauthorized");
          return;
        }
        c.authed = true;
        clearTimeout(timer);
        diagnostics.info("ws", "ui client authenticated");
        send(c, { type: "ready", protocol: PROTOCOL_VERSION, serverTime: new Date().toISOString(), version: config.version });
        send(c, manager.snapshot());
        return;
      }
      handle(c, frame);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      clients.delete(c);
    });
    ws.on("error", () => {
      clients.delete(c);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.wsPort, config.wsHost, () => resolve());
  });
  const port = (http.address() as AddressInfo).port;
  diagnostics.info("ws", `listening on ${config.wsHost}:${port}`);

  return {
    port,
    clients: () => [...clients].filter((c) => c.authed).length,
    close: async () => {
      manager.off("event", onEvent);
      manager.off("session", onSession);
      manager.off("agent", onAgent);
      manager.off("request", onRequest);
      manager.off("removed", onRemoved);
      manager.off("wiped", onWiped);
      for (const c of clients) c.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
