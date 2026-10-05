import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mapClaudeHook } from "@agentwatch/adapter-claude-code";
import type { AgentEventInput } from "@agentwatch/protocol";
import { Store } from "../src/db/store";
import { SessionManager } from "../src/session-manager";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../fixtures/claude/session-with-subagents.json", import.meta.url)), "utf8"),
) as unknown[];

function feed(manager: SessionManager, raws = fixture): void {
  for (const raw of raws) for (const e of mapClaudeHook(raw)) manager.ingest(e);
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("SessionManager", () => {
  it("builds sessions, agents and the failure story from a Claude session", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    // everything except the SessionEnd so the live state is inspectable
    feed(m, fixture.slice(0, -1));
    expect(m.sessions.size).toBe(1);
    const s = [...m.sessions.values()][0]!;
    expect(s.provider).toBe("claude-code");
    expect(s.cwd).toBe("/Users/dev/work/auth-service");
    expect(s.model).toBe("claude-sonnet-5-5");
    expect(s.counts.commands).toBe(1);
    expect(s.counts.failedCommands).toBe(1);
    expect(s.diff).toEqual({ additions: 4, deletions: 2 });
    expect(s.sources).toEqual(["claude-hook"]);
    // the permission request was answered by the Bash call that followed it, and Stop left the session idle
    expect(s.status).toBe("idle");
    expect([...m.requests.values()].every((r) => r.status === "resolved")).toBe(true);
    expect(m.snapshot().pendingRequests).toHaveLength(0);

    const agents = [...m.agents.values()];
    expect(agents.map((a) => a.providerAgentId ?? "main").sort()).toEqual(["agent_explorer", "agent_worker", "main"]);
    const explorer = agents.find((a) => a.providerAgentId === "agent_explorer")!;
    const worker = agents.find((a) => a.providerAgentId === "agent_worker")!;
    expect(explorer.status).toBe("done");
    expect(explorer.parentAgentId).toBe(`${s.id}:main`);
    expect(worker.status).toBe("failed");
    expect(worker.failureNote).toContain("exit 1");
  });

  it("ends the session and resolves pending requests on SessionEnd", () => {
    const m = new SessionManager(new Store(":memory:"));
    feed(m);
    const s = [...m.sessions.values()][0]!;
    expect(s.status).toBe("finished");
    expect(m.snapshot().pendingRequests).toHaveLength(0);
    expect([...m.agents.values()].filter((a) => a.status === "running")).toHaveLength(0);
  });

  it("assigns a strictly increasing global sequence", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    const seen: number[] = [];
    m.on("event", (e) => seen.push(e.sequence));
    feed(m);
    expect(seen.length).toBeGreaterThan(10);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1);
    expect(store.lastSequence).toBe(seen[seen.length - 1]);
  });

  it("stores no prompt, content or credential anywhere in SQLite", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    feed(m);
    const dump = JSON.stringify(store.queryEvents({ limit: 5000 })) + JSON.stringify(store.queryCommands()) + JSON.stringify(store.queryFiles());
    expect(dump).not.toContain("SENTINEL");
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("abcdef1234567890xyz");
    expect(dump).toContain("[REDACTED]");
  });

  it("does not count an observed write the provider already reported", () => {
    const m = new SessionManager(new Store(":memory:"));
    feed(m, fixture.slice(0, 9)); // through the Edit PostToolUse
    const before = m.stats.accepted;
    const obs: AgentEventInput = {
      provider: "claude-code",
      providerSessionId: "sess_7f3a",
      kind: "file.write",
      source: "filesystem",
      confidence: "low",
      payload: { path: "/Users/dev/work/auth-service/src/auth/session.ts" },
    };
    expect(m.ingest(obs)).toBeNull();
    expect(m.stats.deduped).toBe(1);
    expect(m.stats.accepted).toBe(before);
    // a different file is still a real observation, kept at low confidence and unattributed
    const other = m.ingest({ ...obs, payload: { path: "/Users/dev/work/auth-service/src/auth/session.test.ts" } });
    expect(other?.confidence).toBe("low");
  });

  it("never lets an observer claim high confidence", () => {
    const m = new SessionManager(new Store(":memory:"));
    const e = m.ingest({
      provider: "generic",
      providerSessionId: "w1",
      kind: "file.write",
      source: "filesystem",
      confidence: "high",
      payload: { path: "/x/a.ts" },
    });
    expect(e?.confidence).toBe("low");
    const files = m.sessions.size ? new Store(":memory:") : null;
    expect(files).not.toBeNull();
  });

  it("rejects malformed events and counts them", () => {
    const m = new SessionManager(new Store(":memory:"));
    expect(() => m.ingest({ provider: "nope" })).toThrow();
    expect(m.stats.rejected).toBe(1);
    expect(m.sessions.size).toBe(0);
  });

  it("attaches provider events to a wrapper session", () => {
    const m = new SessionManager(new Store(":memory:"));
    m.ingest({ provider: "generic", providerSessionId: "wrap1", wrapperSessionId: "wrap1", kind: "session.started", source: "pty", confidence: "low", payload: { executable: "/usr/bin/claude" } });
    m.ingest({ provider: "generic", providerSessionId: "wrap1", wrapperSessionId: "wrap1", kind: "log", source: "pty", confidence: "low", payload: { message: "hi" } });
    expect(m.sessions.size).toBe(1);
    expect(m.sessions.get("wrap1")?.executable).toBe("/usr/bin/claude");
  });

  it("reconstructs state after a restart; open sessions read as idle", () => {
    const dir = mkdtempSync(join(tmpdir(), "aw-"));
    tmpDirs.push(dir);
    const path = join(dir, "t.db");
    const store1 = new Store(path);
    const m1 = new SessionManager(store1);
    feed(m1, fixture.slice(0, 5));
    const id = [...m1.sessions.keys()][0]!;
    const lastSeq = store1.lastSequence;
    m1.flush();
    store1.close();

    const store2 = new Store(path);
    const m2 = new SessionManager(store2);
    expect(store2.lastSequence).toBe(lastSeq);
    const s = m2.sessions.get(id)!;
    expect(s.status).toBe("idle");
    expect(s.counts.events).toBeGreaterThan(0);
    // a new event on the same provider session resumes it instead of creating a second one
    feed(m2, fixture.slice(5, 7));
    expect(m2.sessions.size).toBe(1);
    expect(m2.sessions.get(id)!.status).not.toBe("idle");
    store2.close();
  });

  it("deletes a session and everything under it", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    feed(m);
    const id = [...m.sessions.keys()][0]!;
    expect(m.removeSession(id)).toBe(true);
    expect(store.counts()).toEqual({ sessions: 0, events: 0 });
    expect(store.queryFiles()).toHaveLength(0);
    expect(store.queryCommands()).toHaveLength(0);
  });

  it("purges finished sessions past retention and keeps live ones", () => {
    const store = new Store(":memory:");
    let clock = new Date();
    const m = new SessionManager(store, { now: () => clock });
    feed(m); // finished session (adapter stamps real time)
    m.ingest({ provider: "claude-code", providerSessionId: "live", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });
    clock = new Date(Date.now() + 30 * 86_400_000);
    const gone = m.purge(14);
    expect(gone).toHaveLength(1);
    expect(m.sessions.size).toBe(1);
    expect([...m.sessions.values()][0]!.providerSessionId).toBe("live");
  });

  it("wipes the database file and starts clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "aw-"));
    tmpDirs.push(dir);
    const path = join(dir, "w.db");
    const store = new Store(path);
    const m = new SessionManager(store);
    feed(m);
    store.setSettings({ retentionDays: 7 });
    m.wipeAll();
    expect(m.sessions.size).toBe(0);
    expect(store.counts()).toEqual({ sessions: 0, events: 0 });
    expect(store.lastSequence).toBe(0);
    expect(store.getSettings().retentionDays).toBe(7);
    expect(readFileSync(path).length).toBeGreaterThan(0);
    store.close();
  });

  it("marks silent running sessions idle", () => {
    const store = new Store(":memory:");
    let clock = new Date("2026-01-01T00:00:00Z");
    const m = new SessionManager(store, { now: () => clock });
    m.ingest({ provider: "claude-code", providerSessionId: "x", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });
    clock = new Date("2026-01-01T00:05:00Z");
    expect(m.sweepIdle(120_000)).toHaveLength(1);
    expect([...m.sessions.values()][0]!.status).toBe("idle");
  });
});

describe("the Claude fixture's permission request", () => {
  it("keeps the session waiting until the tool it asked about runs", () => {
    const m = new SessionManager(new Store(":memory:"));
    feed(m, fixture.slice(0, 10)); // up to and including the PermissionRequest (real ones carry no tool-use id)
    const s = [...m.sessions.values()][0]!;
    expect(s.status).toBe("waiting");
    expect([...m.requests.values()].filter((r) => r.status === "pending")).toHaveLength(1);
    feed(m, fixture.slice(10, 12)); // the Bash call runs (and fails): the person said yes
    expect([...m.requests.values()].filter((r) => r.status === "pending")).toHaveLength(0);
  });
});

describe("pending approvals that never get an answer event", () => {
  const ev = (kind: string, payload: Record<string, unknown>): AgentEventInput => ({ provider: "claude-code", providerSessionId: "q", kind: kind as AgentEventInput["kind"], source: "claude-hook", confidence: "high", payload });
  const ask = (m: SessionManager) => {
    m.ingest(ev("session.started", {}));
    m.ingest(ev("tool.started", { toolName: "AskUserQuestion", toolUseId: "toolu_1" }));
    // Claude's PermissionRequest hook has no tool-use id, so the request id cannot match the tool's later result
    m.ingest(ev("approval.requested", { requestId: "perm-AskUserQuestion-1", kind: "permission", summary: "use AskUserQuestion", toolName: "AskUserQuestion" }));
  };
  const status = (m: SessionManager) => [...m.sessions.values()][0]!.status;
  const pending = (m: SessionManager) => [...m.requests.values()].filter((r) => r.status === "pending").length;

  it("is resolved when the same tool completes afterwards, even without a matching id", () => {
    const m = new SessionManager(new Store(":memory:"));
    ask(m);
    expect(status(m)).toBe("waiting");
    expect(pending(m)).toBe(1);
    m.ingest(ev("tool.completed", { toolName: "AskUserQuestion", toolUseId: "toolu_1" }));
    expect(pending(m)).toBe(0);
    expect(status(m)).toBe("running");
  });

  it("is not resolved by a different tool finishing", () => {
    const m = new SessionManager(new Store(":memory:"));
    ask(m);
    m.ingest(ev("tool.completed", { toolName: "Read", toolUseId: "toolu_2" }));
    expect(pending(m)).toBe(1);
    expect(status(m)).toBe("waiting");
  });

  it("a finished turn (Stop) closes what that agent asked, so a denied question does not linger", () => {
    const m = new SessionManager(new Store(":memory:"));
    ask(m);
    m.ingest(ev("status.changed", { status: "idle", label: "turn finished" }));
    expect(pending(m)).toBe(0);
    expect(status(m)).toBe("idle");
  });

  it("measures the silence of the provider, not of the observers that keep reporting git and file changes", () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const m = new SessionManager(new Store(":memory:"), { now: () => clock });
    ask(m);
    for (const minute of [5, 10, 14]) {
      clock = new Date(Date.UTC(2026, 0, 1, 0, minute));
      m.ingest({ provider: "claude-code", providerSessionId: "q", kind: "git.changed", source: "git", confidence: "low", payload: { changedFiles: 1, additions: 1, deletions: 0 } });
    }
    clock = new Date("2026-01-01T00:16:00Z");
    expect(m.sweepIdle(120_000)).toHaveLength(1); // the git events 2 minutes ago did not keep the question alive
    expect(pending(m)).toBe(0);
  });

  it("stops claiming a person is needed after a long silence, and a later event brings the session back", () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const m = new SessionManager(new Store(":memory:"), { now: () => clock });
    ask(m);
    const requests: string[] = [];
    m.on("request", (r) => requests.push(r.status));
    clock = new Date("2026-01-01T00:14:00Z");
    expect(m.sweepIdle(120_000)).toHaveLength(0); // 14 minutes: still plausibly waiting for a person
    expect(status(m)).toBe("waiting");
    clock = new Date("2026-01-01T00:16:00Z");
    expect(m.sweepIdle(120_000)).toHaveLength(1);
    expect(status(m)).toBe("idle");
    expect(pending(m)).toBe(0);
    expect(requests).toEqual(["resolved"]); // clients are told, so the "needs you" count drops
    m.ingest(ev("tool.started", { toolName: "Read", toolUseId: "toolu_3" }));
    expect(status(m)).toBe("running");
  });
});

describe("a session whose first event is a subagent's", () => {
  const ev = (kind: string, payload: Record<string, unknown>, extra: Partial<AgentEventInput> = {}): AgentEventInput => ({ provider: "claude-code", providerSessionId: "fk", kind: kind as AgentEventInput["kind"], source: "claude-hook", confidence: "high", payload, ...extra });

  it("is accepted and kept, not rejected with a foreign-key error", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    expect(() => m.apply(ev("tool.started", { toolName: "Read", toolUseId: "t1" }, { providerAgentId: "bg1" }))).not.toThrow();
    expect(() => m.apply(ev("tool.completed", { toolName: "Read", toolUseId: "t1" }, { providerAgentId: "bg1" }))).not.toThrow(); // and keeps being accepted
    m.flush();
    const id = [...m.sessions.keys()][0]!;
    const rows = store.loadAgents(id);
    expect(rows.map((r) => r.id).sort()).toEqual([`${id}:bg1`, `${id}:main`].sort());
    expect(rows.find((r) => r.id.endsWith(":bg1"))!.parentAgentId).toBe(`${id}:main`);
  });

  it("also works for a subagent that starts and ends before the main agent was ever seen", () => {
    const m = new SessionManager(new Store(":memory:"));
    expect(() => {
      m.apply(ev("agent.started", {}, { providerAgentId: "bg1" }));
      m.apply(ev("agent.ended", { outcome: "done" }, { providerAgentId: "bg1" }));
    }).not.toThrow();
  });

  it("survives a restart in the middle of a run: the next hook is a subagent's, for a session never saved with its main agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "aw-"));
    tmpDirs.push(dir);
    const path = join(dir, "t.db");
    const s1 = new Store(path);
    const m1 = new SessionManager(s1);
    m1.apply(ev("tool.started", { toolName: "Read" }, { providerAgentId: "bg1" }));
    m1.flush();
    s1.close();
    const m2 = new SessionManager(new Store(path));
    expect(() => {
      m2.apply(ev("tool.completed", { toolName: "Read" }, { providerAgentId: "bg1" }));
      m2.apply(ev("tool.started", { toolName: "Read" }));
    }).not.toThrow();
  });
});

describe("what makes a session running", () => {
  const ev = (kind: string, payload: Record<string, unknown>, extra: Partial<AgentEventInput> = {}): AgentEventInput => ({ provider: "claude-code", providerSessionId: "r", kind: kind as AgentEventInput["kind"], source: "claude-hook", confidence: "high", payload, ...extra });
  const status = (m: SessionManager) => [...m.sessions.values()][0]!.status;

  it("is not brought back by a file watcher, git or a chat message: only by the agent", () => {
    const m = new SessionManager(new Store(":memory:"));
    m.setContentPolicy({ prompts: true, responses: true });
    m.apply(ev("session.started", {}));
    m.apply(ev("status.changed", { status: "idle", label: "turn finished" }));
    expect(status(m)).toBe("idle");
    m.apply(ev("file.write", { path: "/w/a.ts" }, { source: "filesystem", confidence: "low" }));
    m.apply(ev("git.changed", { changedFiles: 1, additions: 1, deletions: 0 }, { source: "git", confidence: "low" }));
    m.apply(ev("message", { role: "user", body: "an old message read back" }, { source: "transcript" }));
    expect(status(m)).toBe("idle"); // someone editing files in the folder is not the agent running
    m.apply(ev("tool.started", { toolName: "Read", toolUseId: "t1" }));
    expect(status(m)).toBe("running");
  });

  it("is still running after the main turn ends while a background subagent works, and idle once it finishes", () => {
    const m = new SessionManager(new Store(":memory:"));
    m.apply(ev("session.started", {}));
    m.apply(ev("agent.started", { agentType: "web-dev" }, { providerAgentId: "bg1" }));
    m.apply(ev("tool.started", { toolName: "Read", toolUseId: "t1" }, { providerAgentId: "bg1" }));
    m.apply(ev("status.changed", { status: "idle", label: "turn finished" })); // the main agent's Stop
    expect(status(m)).toBe("running"); // "Waiting for 1 background agent to finish"
    m.apply(ev("tool.completed", { toolName: "Read", toolUseId: "t1" }, { providerAgentId: "bg1" }));
    expect(status(m)).toBe("running");
    m.apply(ev("agent.ended", { outcome: "done" }, { providerAgentId: "bg1" }));
    expect(status(m)).toBe("idle");
  });

  it("goes idle when only the observers are still reporting, and stays running while the agent's own hooks keep coming", () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const m = new SessionManager(new Store(":memory:"), { now: () => clock });
    m.apply(ev("session.started", {}));
    m.apply(ev("tool.started", { toolName: "Read", toolUseId: "t1" }));
    m.apply(ev("tool.completed", { toolName: "Read", toolUseId: "t1" })); // nothing in flight
    for (const minute of [1, 3, 5, 8]) {
      clock = new Date(Date.UTC(2026, 0, 1, 0, minute));
      m.apply(ev("git.changed", { changedFiles: 1, additions: 1, deletions: 0 }, { source: "git", confidence: "low" }));
    }
    clock = new Date("2026-01-01T00:09:00Z");
    expect(m.sweepIdle(120_000, 3_600_000)).toHaveLength(1); // git has spoken a minute ago, the agent 9 minutes ago
    expect(status(m)).toBe("idle");
    m.apply(ev("tool.started", { toolName: "Read", toolUseId: "t2" }));
    clock = new Date("2026-01-01T00:10:00Z");
    expect(m.sweepIdle(120_000, 3_600_000)).toHaveLength(0);
    expect(status(m)).toBe("running");
  });

  it("is not idle while a tool it started is still running (a long build), but is once that has gone on for far too long", () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const m = new SessionManager(new Store(":memory:"), { now: () => clock });
    m.apply(ev("session.started", {}));
    m.apply(ev("command.started", { commandId: "c1", argvDisplay: "pnpm build" }));
    clock = new Date("2026-01-01T00:06:00Z");
    expect(m.sweepIdle(120_000, 3_600_000)).toHaveLength(0);
    expect(status(m)).toBe("running"); // six silent minutes, but a command is in flight
    clock = new Date("2026-01-01T00:12:00Z");
    expect(m.sweepIdle(120_000, 3_600_000)).toHaveLength(1);
    // and once the command has finished, the ordinary two minutes apply again
    m.apply(ev("tool.started", { toolName: "Read", toolUseId: "t1" }));
    m.apply(ev("tool.completed", { toolName: "Read", toolUseId: "t1" }));
    clock = new Date("2026-01-01T00:15:00Z");
    expect(m.sweepIdle(120_000, 3_600_000)).toHaveLength(1);
  });

  it("is brought back by observed activity for a wrapped process, which has nothing else to go on", () => {
    const m = new SessionManager(new Store(":memory:"));
    m.apply({ provider: "generic", providerSessionId: "g", kind: "session.started", source: "pty", confidence: "low", payload: {} });
    m.sweepIdle(0);
    const s = [...m.sessions.values()][0]!;
    s.status = "idle";
    m.apply({ provider: "generic", providerSessionId: "g", kind: "file.write", source: "filesystem", confidence: "low", payload: { path: "/w/a.ts" } });
    expect(s.status).toBe("running");
  });
});

describe("naming subagents", () => {
  const ev = (kind: string, payload: Record<string, unknown>, providerAgentId?: string): AgentEventInput => ({ provider: "claude-code", providerSessionId: "n", providerAgentId, kind: kind as AgentEventInput["kind"], source: "claude-hook", confidence: "high", payload });
  it("gives each subagent the label of its task, in the order the tasks started", () => {
    const m = new SessionManager(new Store(":memory:"));
    m.ingest(ev("session.started", {}));
    m.ingest(ev("tool.started", { toolName: "Task", toolUseId: "t1", taskLabel: "Repair account-switch claims", subagentType: "web-dev" }));
    m.ingest(ev("tool.started", { toolName: "Task", toolUseId: "t2", taskLabel: "Review the migration" }));
    m.ingest(ev("agent.started", { agentType: "web-dev" }, "ab3bffafebdf350d6"));
    m.ingest(ev("agent.started", {}, "acff1480a8922f67b"));
    const sub = [...m.agents.values()].filter((a) => a.providerAgentId);
    expect(sub.map((a) => a.displayName)).toEqual(["Repair account-switch claims", "Review the migration"]);
    expect(sub[0]!.role).toBe("web-dev"); // the type stays available as the role
  });

  it("does not invent a subagent from an end signal alone, but still ends one it has seen", () => {
    const m = new SessionManager(new Store(":memory:"));
    m.ingest(ev("session.started", {}));
    expect(m.apply(ev("agent.ended", { outcome: "done" }, "never-started") as never)).toBeNull();
    expect([...m.agents.values()].filter((x) => x.providerAgentId)).toHaveLength(0);
    m.ingest(ev("agent.started", {}, "real1"));
    m.ingest(ev("agent.ended", { outcome: "done" }, "real1"));
    expect([...m.agents.values()].find((x) => x.providerAgentId === "real1")?.status).toBe("done");
    // one that was only ever seen working (its start was missed) is a subagent: it did something
    m.ingest(ev("tool.started", { toolName: "Read" }, "seen-working"));
    m.ingest(ev("agent.ended", { outcome: "done" }, "seen-working"));
    expect([...m.agents.values()].find((x) => x.providerAgentId === "seen-working")?.status).toBe("done");
  });

  it("leaves a subagent without a label unnamed (the UI numbers it) instead of inventing one", () => {
    const m = new SessionManager(new Store(":memory:"));
    m.ingest(ev("session.started", {}));
    m.ingest(ev("agent.started", {}, "ab3bffafebdf350d6"));
    const a = [...m.agents.values()].find((x) => x.providerAgentId)!;
    expect(a.displayName).toBeUndefined();
  });
});

describe("a question that was open when the service restarted", () => {
  it("keeps its session waiting, and the sweep clears it once it has been silent long enough", () => {
    const dir = mkdtempSync(join(tmpdir(), "awm-"));
    tmpDirs.push(dir);
    const path = join(dir, "t.db");
    let clock = new Date("2026-01-01T00:00:00Z");
    const first = new SessionManager(new Store(path), { now: () => clock });
    first.ingest({ provider: "claude-code", providerSessionId: "r", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });
    first.ingest({ provider: "claude-code", providerSessionId: "r", kind: "approval.requested", source: "claude-hook", confidence: "high", payload: { requestId: "perm-X-1", kind: "permission", toolName: "X" } });
    first.flush();

    clock = new Date("2026-01-01T01:00:00Z"); // the service comes back an hour later
    const second = new SessionManager(new Store(path), { now: () => clock });
    const s = [...second.sessions.values()][0]!;
    expect(s.status).toBe("waiting");
    expect(second.snapshot().pendingRequests).toHaveLength(1);
    expect(second.sweepIdle(120_000)).toHaveLength(1);
    expect(second.snapshot().pendingRequests).toHaveLength(0);
    expect(s.status).toBe("idle");
  });
});

describe("write-behind", () => {
  it("writes the first row at once (foreign keys), changes later, and everything on flush", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    feed(m, fixture.slice(0, 5));
    const id = [...m.sessions.keys()][0]!;
    expect(store.getSession(id)).toBeDefined(); // exists immediately, so events can reference it
    const live = m.sessions.get(id)!.counts.events;
    expect(live).toBeGreaterThan(1);
    expect(store.getSession(id)!.counts.events).toBeLessThan(live); // the later changes have not been written yet
    m.flush();
    expect(store.getSession(id)!.counts.events).toBe(live);
    expect(store.getSession(id)!.counts.files).toBe(m.sessions.get(id)!.counts.files);
    expect(store.loadAgents(id).length).toBe([...m.agents.values()].filter((a) => a.sessionId === id).length);
    m.flush(); // a second flush with nothing changed is a no-op
  });

  it("does not resurrect a deleted session from stale write-behind state", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    feed(m, fixture.slice(0, 5));
    const id = [...m.sessions.keys()][0]!;
    m.removeSession(id);
    m.flush();
    expect(store.counts()).toEqual({ sessions: 0, events: 0 });
  });

  it("counts distinct files from memory, matching what is in SQLite", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    feed(m);
    const s = [...m.sessions.values()][0]!;
    expect(s.counts.files).toBe(store.distinctFileCount(s.id));
  });
});

describe("producers that bypass ingest()", () => {
  it("redacts a sampled process command line before it is stored, and flags it", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    const e = m.apply({
      provider: "generic",
      providerSessionId: "w9",
      wrapperSessionId: "w9",
      kind: "command.started",
      source: "process",
      confidence: "medium",
      payload: { commandId: "pid-7", argvDisplay: `curl -H "Authorization: Bearer abcdef1234567890xyz" --token abc123 https://x ${"y".repeat(900)}`, pid: 7, ppid: 1 },
    });
    expect(e?.redacted).toBe(true);
    const row = store.queryCommands()[0]!;
    expect(row.redacted).toBe(true);
    expect(row.argvDisplay).toContain("[REDACTED]");
    expect(row.argvDisplay).not.toContain("abcdef1234567890xyz");
    expect(row.argvDisplay).not.toContain("abc123");
    expect(row.argvDisplay.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(store.queryEvents({ limit: 100 }))).not.toContain("abc123");
  });

  it("drops forbidden keys and unknown payload fields from observer events too", () => {
    const store = new Store(":memory:");
    const m = new SessionManager(store);
    m.apply({ provider: "generic", providerSessionId: "w8", wrapperSessionId: "w8", kind: "file.write", source: "filesystem", confidence: "high", payload: { path: "/a/b.ts", content: "SECRET BODY", extra: 1 } });
    const ev = store.queryEvents({ limit: 10 })[0]!;
    expect(ev.payload).toEqual({ path: "/a/b.ts" });
    expect(ev.confidence).toBe("low");
  });
});

describe("Store settings", () => {
  it("ignores the privacy keys that can never be turned on, and invalid retention values", () => {
    const store = new Store(":memory:");
    store.setSettings({ keepRawTranscript: true, keepFullPatches: true, redactCredentials: false, retentionDays: 999, startAtLogin: true });
    const s = store.getSettings();
    expect(s.keepRawTranscript).toBe(false);
    expect(s.keepFullPatches).toBe(false);
    expect(s.redactCredentials).toBe(true);
    expect(s.retentionDays).toBe(14);
    expect(s.startAtLogin).toBe(true);
  });
});

describe("subagents older versions invented", () => {
  const seed = (store: Store) => {
    const m = new SessionManager(store);
    m.ingest({ provider: "claude-code", providerSessionId: "g", kind: "session.started", source: "claude-hook", confidence: "high", payload: {} });
    return m;
  };
  it("removes a stored subagent that is only a lone end signal, and nothing that did anything", () => {
    const store = new Store(":memory:");
    const m = seed(store);
    const sid = [...m.sessions.keys()][0]!;
    m.flush();
    const put = (agent: string, name: string | null, kinds: string[]) => {
      store.db.prepare("INSERT INTO agents (id, session_id, parent_agent_id, provider_agent_id, role, display_name, model, status, started_at, ended_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run(`${sid}:${agent}`, sid, `${sid}:main`, agent, name);
      kinds.forEach((k, i) => store.db.prepare("INSERT INTO events (id, session_id, agent_id, sequence, occurred_at, received_at, kind, source, confidence, redacted, payload_json) VALUES (?, ?, ?, ?, 't', 't', ?, 'claude-hook', 'high', 0, '{}')").run(`${agent}-${i}`, sid, `${sid}:${agent}`, 1000 + Math.random() * 1e6 + i, k));
    };
    put("ghost", null, ["agent.ended"]);
    put("named", "Review the migration", ["agent.ended"]);
    put("worked", null, ["agent.ended", "tool.started"]);
    expect(store.pruneGhostAgents()).toBe(1);
    const left = (store.db.prepare("SELECT provider_agent_id AS p FROM agents WHERE provider_agent_id IS NOT NULL ORDER BY 1").all() as Array<{ p: string }>).map((r) => r.p);
    expect(left).toEqual(["named", "worked"]);
    expect(store.pruneGhostAgents()).toBe(0);
  });
});
