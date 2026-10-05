import { beforeEach, describe, expect, it } from "vitest";
import { EVENT_BUFFER, LiveStore, pendingRequests, runningCount, sessionList } from "../src/lib/store";
import { event, kids, mainAgent, resetSeq, session } from "./fixtures";

const snap = (store: LiveStore, sessions = [session()], lastSequence = 0) =>
  store.apply({ type: "snapshot", sessions, agents: [mainAgent(), ...kids(2)], pendingRequests: [], lastSequence });

beforeEach(resetSeq);

describe("LiveStore", () => {
  it("builds state from a snapshot and marks the connection ready", () => {
    const s = new LiveStore();
    s.apply({ type: "ready", protocol: 1, serverTime: "", version: "0.1.0" });
    snap(s);
    expect(s.getState().status).toBe("connected");
    expect(s.getState().daemonVersion).toBe("0.1.0");
    expect(sessionList(s.getState())).toHaveLength(1);
    expect(s.getState().agents.size).toBe(3);
  });

  it("keeps events in order, ignores replay overlap, and bounds the buffer", () => {
    const s = new LiveStore();
    snap(s);
    const seen: number[] = [];
    s.onEvent((e) => seen.push(e.sequence));
    const e1 = event();
    s.apply({ type: "event", event: e1 });
    s.apply({ type: "event", event: e1 }); // duplicate from a replay
    expect(s.getState().events.get("s1")).toHaveLength(1);
    expect(seen).toEqual([1]);
    for (let i = 0; i < EVENT_BUFFER + 50; i++) s.apply({ type: "event", event: event() });
    const buf = s.getState().events.get("s1")!;
    expect(buf).toHaveLength(EVENT_BUFFER);
    expect(buf[buf.length - 1]!.sequence).toBe(s.getState().lastSequence);
  });

  it("tracks pending approvals and clears them when resolved", () => {
    const s = new LiveStore();
    snap(s);
    const req = { id: "s1:r1", sessionId: "s1", kind: "command", status: "pending" as const, createdAt: "", source: "claude-hook" };
    s.apply({ type: "request", request: req });
    expect(pendingRequests(s.getState())).toHaveLength(1);
    s.apply({ type: "request", request: { ...req, status: "resolved" } });
    expect(pendingRequests(s.getState())).toHaveLength(0);
  });

  it("drops a removed session and everything under it", () => {
    const s = new LiveStore();
    snap(s);
    s.apply({ type: "event", event: event() });
    s.apply({ type: "removed", sessionId: "s1" });
    expect(s.getState().sessions.size).toBe(0);
    expect(s.getState().agents.size).toBe(0);
    expect(s.getState().events.size).toBe(0);
  });

  it("clears everything when history is wiped", () => {
    const s = new LiveStore();
    snap(s, [session()], 5);
    s.apply({ type: "wiped" });
    expect(s.getState().sessions.size).toBe(0);
    expect(s.getState().lastSequence).toBe(0);
  });

  it("notifies subscribers and gives a new snapshot object per change", () => {
    const s = new LiveStore();
    let n = 0;
    s.subscribe(() => n++);
    const before = s.getState();
    snap(s);
    expect(n).toBeGreaterThan(0);
    expect(s.getState()).not.toBe(before);
  });

  it("counts only sessions that are running: not idle, waiting or ended ones", () => {
    const s = new LiveStore();
    snap(s, [session(), session({ id: "s2", status: "finished", endedAt: "x" }), session({ id: "s3", status: "idle" }), session({ id: "s4", status: "waiting" })]);
    expect(runningCount(s.getState())).toBe(1);
  });
});
