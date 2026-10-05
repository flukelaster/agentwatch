import type { AgentEvent, AgentView, SessionView } from "@agentwatch/protocol";

export function session(over: Partial<SessionView> = {}): SessionView {
  return {
    id: "s1",
    provider: "claude-code",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastEventAt: "2026-01-01T00:00:00.000Z",
    counts: { tools: 0, files: 0, commands: 0, failedCommands: 0, events: 0 },
    diff: { additions: 0, deletions: 0 },
    sources: ["claude-hook", "process", "filesystem"],
    model: "claude-sonnet-5-5",
    cwd: "/Users/dev/work/auth-service",
    ...over,
  };
}

export function mainAgent(sessionId = "s1", over: Partial<AgentView> = {}): AgentView {
  return { id: `${sessionId}:main`, sessionId, displayName: "main", status: "running", startedAt: "2026-01-01T00:00:00.000Z", toolCount: 3, lastEventAt: "2026-01-01T00:00:00.000Z", lastAction: "editing src/a.ts", ...over };
}

export function kids(n: number, sessionId = "s1", statuses: AgentView["status"][] = []): AgentView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${sessionId}:k${i}`,
    sessionId,
    parentAgentId: `${sessionId}:main`,
    providerAgentId: `k${i}`,
    role: ["explore", "worker", "research", "review"][i % 4],
    status: statuses[i] ?? "running",
    startedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    toolCount: i,
    lastEventAt: "2026-01-01T00:00:00.000Z",
    lastAction: `reading file${i}.ts`,
  }));
}

let seq = 0;
export function event(over: Partial<AgentEvent> = {}): AgentEvent {
  seq += 1;
  return {
    schemaVersion: 1,
    id: `e${seq}`,
    sequence: seq,
    sessionId: "s1",
    agentId: "s1:main",
    provider: "claude-code",
    kind: "tool.started",
    occurredAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    source: "claude-hook",
    confidence: "high",
    redacted: false,
    payload: { toolName: "Read" },
    ...over,
  };
}
export const resetSeq = () => {
  seq = 0;
};
