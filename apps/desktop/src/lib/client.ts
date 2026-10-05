import { ClientFrameSchema, PROTOCOL_VERSION, type ClientFrame, type MintResponse, type ServerFrame } from "@agentwatch/protocol";
import type { LiveStore } from "./store";

export interface DaemonClient {
  start(): void;
  stop(): void;
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  command<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
}

/** Where the capability comes from: the Tauri backend in the app, the dev server in a browser. */
export async function mintCapability(): Promise<MintResponse> {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke("mint_capability")) as MintResponse;
  }
  const res = await fetch("/__aw/mint", { cache: "no-store" });
  const body = (await res.json()) as MintResponse & { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw new Error(body.error ?? "daemon unavailable");
  return body;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REPLAY_BACK = 400;

export class WsDaemonClient implements DaemonClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();

  constructor(
    private readonly store: LiveStore,
    private readonly mint: () => Promise<MintResponse> = mintCapability,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("closed"));
    }
    this.pending.clear();
  }

  private send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ClientFrameSchema.parse(frame)));
  }

  private schedule(): void {
    if (this.stopped) return;
    this.store.setStatus("disconnected", "AgentWatch daemon is not reachable");
    const delay = Math.min(500 * 2 ** this.attempt, 8000);
    this.attempt += 1;
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    this.store.setStatus("connecting");
    let cap: MintResponse;
    try {
      cap = await this.mint();
    } catch {
      return this.schedule();
    }
    const ws = new WebSocket(`ws://${cap.host}:${cap.port}`);
    this.ws = ws;
    let authed = false;
    ws.onopen = () => this.send({ type: "hello", protocol: PROTOCOL_VERSION, token: cap.token });
    ws.onmessage = (m) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(m.data)) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "result" || (frame.type === "error" && frame.id)) {
        const p = this.pending.get(frame.id!);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(frame.id!);
          if (frame.type === "result") p.resolve(frame.data);
          else p.reject(new Error(frame.message));
        }
        return;
      }
      const known = this.store.getState().lastSequence;
      this.store.apply(frame);
      if (frame.type === "ready") authed = true;
      if (frame.type === "snapshot") {
        this.attempt = 0;
        // catch up on recent history so logs and graphs are populated, then follow live
        const after = known > 0 ? known : Math.max(0, frame.lastSequence - REPLAY_BACK);
        this.send({ type: "subscribe", sessionIds: ["*"], afterSequence: after });
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!authed) this.store.setStatus("disconnected", "could not authenticate with the daemon");
      this.schedule();
    };
    ws.onerror = () => ws.close();
  }

  private request<T>(type: "query" | "command", name: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error("not connected"));
      const id = `r${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timeout"));
      }, 8000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ type, id, name, params } as ClientFrame);
    });
  }

  query<T>(name: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>("query", name, params);
  }
  command<T>(name: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>("command", name, params);
  }
}
