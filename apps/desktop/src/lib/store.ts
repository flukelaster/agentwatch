import type { AgentEvent, AgentView, RequestView, ServerFrame, SessionView } from "@agentwatch/protocol";

export type ConnStatus = "connecting" | "connected" | "disconnected";

export interface LiveState {
  status: ConnStatus;
  error?: string;
  daemonVersion?: string;
  sessions: ReadonlyMap<string, SessionView>;
  agents: ReadonlyMap<string, AgentView>;
  requests: ReadonlyMap<string, RequestView>;
  /** Recent events per session, oldest first. Bounded. */
  events: ReadonlyMap<string, readonly AgentEvent[]>;
  lastSequence: number;
}

export const EVENT_BUFFER = 300;

export function emptyState(): LiveState {
  return { status: "connecting", sessions: new Map(), agents: new Map(), requests: new Map(), events: new Map(), lastSequence: 0 };
}

type Listener = () => void;
type EventListener = (e: AgentEvent) => void;

/**
 * UI-side read model. Pure reducer over daemon frames, plus subscription plumbing for
 * useSyncExternalStore and a separate fast path for live events (animation).
 */
export class LiveStore {
  private state: LiveState = emptyState();
  private listeners = new Set<Listener>();
  private eventListeners = new Set<EventListener>();

  getState = (): LiveState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  onEvent = (l: EventListener): (() => void) => {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  };

  private set(next: Partial<LiveState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  setStatus(status: ConnStatus, error?: string): void {
    this.set({ status, error });
  }

  /** Apply one frame from the daemon. Returns the event when the frame carried a new one. */
  apply(frame: ServerFrame): AgentEvent | undefined {
    switch (frame.type) {
      case "ready":
        this.set({ daemonVersion: frame.version, status: "connected", error: undefined });
        return undefined;
      case "snapshot": {
        const events = new Map(this.state.events);
        // sessions removed while we were away
        const keep = new Set(frame.sessions.map((s) => s.id));
        for (const id of events.keys()) if (!keep.has(id)) events.delete(id);
        this.set({
          sessions: new Map(frame.sessions.map((s) => [s.id, s])),
          agents: new Map(frame.agents.map((a) => [a.id, a])),
          requests: new Map(frame.pendingRequests.map((r) => [r.id, r])),
          events,
          lastSequence: Math.max(this.state.lastSequence, frame.lastSequence),
        });
        return undefined;
      }
      case "session":
        this.set({ sessions: new Map(this.state.sessions).set(frame.session.id, frame.session) });
        return undefined;
      case "agent":
        this.set({ agents: new Map(this.state.agents).set(frame.agent.id, frame.agent) });
        return undefined;
      case "request": {
        const requests = new Map(this.state.requests);
        if (frame.request.status === "pending") requests.set(frame.request.id, frame.request);
        else requests.delete(frame.request.id);
        this.set({ requests });
        return undefined;
      }
      case "event": {
        const e = frame.event;
        const prev = this.state.events.get(e.sessionId) ?? [];
        if (prev.length && prev[prev.length - 1]!.sequence >= e.sequence) return undefined; // replay overlap
        const list = prev.length >= EVENT_BUFFER ? [...prev.slice(prev.length - EVENT_BUFFER + 1), e] : [...prev, e];
        this.set({ events: new Map(this.state.events).set(e.sessionId, list), lastSequence: Math.max(this.state.lastSequence, e.sequence) });
        for (const l of this.eventListeners) l(e);
        return e;
      }
      case "removed": {
        const sessions = new Map(this.state.sessions);
        const events = new Map(this.state.events);
        sessions.delete(frame.sessionId);
        events.delete(frame.sessionId);
        const agents = new Map([...this.state.agents].filter(([, a]) => a.sessionId !== frame.sessionId));
        const requests = new Map([...this.state.requests].filter(([, r]) => r.sessionId !== frame.sessionId));
        this.set({ sessions, events, agents, requests });
        return undefined;
      }
      case "wiped":
        this.set({ sessions: new Map(), agents: new Map(), requests: new Map(), events: new Map(), lastSequence: 0 });
        return undefined;
      default:
        return undefined;
    }
  }
}

// ---- selectors ----

export function sessionList(s: LiveState): SessionView[] {
  return [...s.sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function agentsOf(s: LiveState, sessionId: string): AgentView[] {
  return [...s.agents.values()].filter((a) => a.sessionId === sessionId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function pendingRequests(s: LiveState): RequestView[] {
  return [...s.requests.values()].filter((r) => r.status === "pending");
}

export function runningCount(s: LiveState): number {
  return [...s.sessions.values()].filter((x) => x.status === "running" && !x.endedAt).length;
}
