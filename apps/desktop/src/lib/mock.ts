import { DEFAULT_SETTINGS, type AgentEvent, type AgentView, type CommandRow, type FileActivityRow, type RequestView, type ServerFrame, type SessionView, type Settings } from "@agentwatch/protocol";
import type { DaemonClient } from "./client";
import type { LiveStore } from "./store";

/**
 * In-browser stand-in for the daemon: same frames, same query answers, synthetic data. Used for UI
 * development without a daemon (`?mock=1`), for tests, and for design review. Nothing here is real.
 */

export interface MockFile extends Omit<FileActivityRow, "id" | "sessionId" | "agentId" | "operation" | "occurredAt"> {
  sessionId: string;
  repo?: string;
  provider: string;
  operation: string;
  lastAt: string;
  agentName?: string;
  touches: number;
}
export interface MockCommand extends CommandRow {
  repo?: string;
  provider: string;
  agentName?: string;
}

const iso = (msAgo: number, now: number) => new Date(now - msAgo).toISOString();

export interface MockData {
  sessions: SessionView[];
  agents: AgentView[];
  requests: RequestView[];
  events: AgentEvent[];
  files: MockFile[];
  commands: MockCommand[];
  settings: Settings;
}

/** ?mock=1&tokens=1&ctx=0.92: a context window that is that full (default 18%), to see the meter at each level. */
function contextSample(fraction: number): NonNullable<NonNullable<SessionView["usage"]>["context"]> {
  const window = 1_000_000;
  const used = Math.round(window * Math.min(1, fraction));
  const setup = 21_000;
  const rest = Math.max(0, used - setup);
  return { used, window, windowAuto: true, setup, conversation: Math.round(rest * 0.23), tools: rest - Math.round(rest * 0.23) };
}

/** ?mock=1&tokens=1&reported=1: what a session looks like after `/context` was run in it (numbers from a real run). */
function reportedSample(): NonNullable<NonNullable<SessionView["usage"]>["context"]> {
  const categories = [
    { name: "System prompt", tokens: 2400 },
    { name: "System tools", tokens: 14600 },
    { name: "MCP tools", tokens: 1800 },
    { name: "MCP server instructions", tokens: 3200 },
    { name: "Custom agents", tokens: 729 },
    { name: "Memory files", tokens: 830 },
    { name: "Skills", tokens: 10000 },
    { name: "Messages", tokens: 805800 },
  ];
  const used = categories.reduce((n, c) => n + c.tokens, 0);
  return { used, window: 1_000_000, windowAuto: false, setup: used - 805800, conversation: 805800, tools: 0, categories, reported: true, buffer: 33_000 };
}

export function buildMockData(now = Date.now(), extraSessions = 0): MockData {
  const counts = (events: number, tools: number, files: number, commands: number, failed = 0) => ({ events, tools, files, commands, failedCommands: failed });
  const sessions: SessionView[] = [
    { id: "s1", provider: "claude-code", providerSessionId: "sess_7f3a", model: "claude-sonnet-5-5", cwd: "/Users/demo/work/auth-service", branch: "fix/session-fk", status: "running", activity: "editing src/auth/session.ts", startedAt: iso(222_000, now), lastEventAt: iso(2_000, now), counts: counts(96, 41, 12, 14, 1), diff: { additions: 142, deletions: 38 }, sources: ["claude-hook", "process", "filesystem"] },
    { id: "s2", provider: "codex", providerSessionId: "thr_c21e", model: "gpt-5-codex", cwd: "/Users/demo/work/billing-web", branch: "feat/invoice-totals", status: "waiting", activity: "waiting for approval: rm -rf dist && pnpm build", startedAt: iso(728_000, now), lastEventAt: iso(134_000, now), counts: counts(44, 28, 3, 3), diff: { additions: 64, deletions: 9 }, usage: { inputTokens: 48200, outputTokens: 13200, cachedInputTokens: 31000, reasoningTokens: 4100, scope: "thread", providerReported: true }, sources: ["codex-app-server", "process", "git"] },
    { id: "s3", provider: "generic", providerSessionId: "wrap_90b4", executable: "custom-agent", cwd: "/Users/demo/work/notes-cli", status: "idle", activity: "no output", startedAt: iso(2_475_000, now), lastEventAt: iso(125_000, now), counts: counts(9, 0, 1, 1), diff: { additions: 3, deletions: 1 }, sources: ["pty", "process", "filesystem"] },
    { id: "s4", provider: "claude-code", providerSessionId: "sess_old1", model: "claude-sonnet-5-5", cwd: "/Users/demo/work/api-gateway", branch: "chore/rate-limits", status: "finished", startedAt: iso(5_400_000, now), endedAt: iso(2_500_000, now), lastEventAt: iso(2_500_000, now), counts: counts(210, 120, 7, 18), diff: { additions: 96, deletions: 21 }, sources: ["claude-hook"] },
    { id: "s5", provider: "claude-code", providerSessionId: "sess_old2", model: "claude-sonnet-5-5", cwd: "/Users/demo/work/docs-site", branch: "main", status: "failed", exitCode: 1, startedAt: iso(9_000_000, now), endedAt: iso(8_640_000, now), lastEventAt: iso(8_640_000, now), counts: counts(31, 14, 2, 5, 2), diff: { additions: 8, deletions: 0 }, sources: ["claude-hook"] },
  ];
  const ag = (id: string, sessionId: string, over: Partial<AgentView>): AgentView => ({ id, sessionId, status: "running", startedAt: iso(200_000, now), toolCount: 0, lastEventAt: iso(2_000, now), ...over });
  const agents: AgentView[] = [
    ag("s1:main", "s1", { displayName: "main", model: "claude-sonnet-5-5", toolCount: 41, lastAction: "editing src/auth/session.ts" }),
    ag("s1:explorer", "s1", { parentAgentId: "s1:main", providerAgentId: "explorer", role: "explore", displayName: "explorer", status: "done", toolCount: 14, endedAt: iso(150_000, now), startedAt: iso(192_000, now) }),
    ag("s1:worker", "s1", { parentAgentId: "s1:main", providerAgentId: "worker", role: "worker", displayName: "worker", status: "failed", toolCount: 9, failureNote: "pnpm test · exit 1", lastAction: "running pnpm test" }),
    ag("s1:researcher", "s1", { parentAgentId: "s1:main", providerAgentId: "researcher", role: "research", displayName: "researcher", toolCount: 6, lastAction: "reading docs/migrations.md" }),
    ag("s2:main", "s2", { displayName: "main", model: "gpt-5-codex", status: "waiting", toolCount: 28, lastAction: "waiting for approval: rm -rf dist && pnpm build" }),
    ag("s2:reviewer", "s2", { parentAgentId: "s2:main", providerAgentId: "reviewer", role: "review", displayName: "reviewer", toolCount: 7, lastAction: "reading src/invoice/format.ts" }),
    ag("s3:main", "s3", { displayName: "main", status: "idle", lastAction: "no output" }),
    ag("s4:main", "s4", { displayName: "main", status: "done", toolCount: 120 }),
    ag("s5:main", "s5", { displayName: "main", status: "failed", toolCount: 14, failureNote: "exit 1" }),
  ];
  const requests: RequestView[] = [{ id: "s2:appr-1", sessionId: "s2", agentId: "s2:main", providerRequestId: "appr-1", kind: "command", status: "pending", summary: "rm -rf dist && pnpm build", createdAt: iso(134_000, now), source: "codex-app-server" }];

  let seq = 400;
  const ev = (sessionId: string, agentId: string, kind: AgentEvent["kind"], msAgo: number, payload: Record<string, unknown>, source: AgentEvent["source"] = "claude-hook", confidence: AgentEvent["confidence"] = "high"): AgentEvent => ({
    schemaVersion: 1, id: `m${seq}`, sequence: ++seq, sessionId, agentId, provider: sessions.find((s) => s.id === sessionId)!.provider, kind, occurredAt: iso(msAgo, now), receivedAt: iso(msAgo, now), source, confidence, redacted: false, payload,
  });
  const events: AgentEvent[] = [
    ev("s1", "s1:explorer", "file.read", 14_000, { path: "src/auth/session.ts" }),
    ev("s1", "s1:main", "file.write", 12_000, { path: "src/auth/session.ts", additions: 21, deletions: 4 }),
    ev("s1", "s1:main", "file.write", 10_000, { path: "src/auth/session.test.ts" }, "filesystem", "low"),
    ev("s1", "s1:worker", "command.started", 9_000, { commandId: "w1", argvDisplay: "pnpm test" }),
    ev("s1", "s1:worker", "command.started", 8_000, { commandId: "pid-1", argvDisplay: "vitest run  (child process)" }, "process", "medium"),
    ev("s1", "s1:worker", "tool.failed", 5_000, { toolName: "Bash", error: "FK constraint · exit 1" }),
    ev("s1", "s1:researcher", "file.read", 3_000, { path: "docs/migrations.md" }),
    ev("s1", "s1:main", "file.write", 1_000, { path: "src/auth/session.ts", additions: 9, deletions: 2 }),
    ev("s1", "s1:main", "message", 215_000, { role: "user", body: "Sessions are failing with a foreign key error after login. Can you find out why and fix it?" }, "transcript"),
    ev("s1", "s1:main", "message", 190_000, { role: "assistant", body: "I'll start by reading the session code and the migration that created the table.\n\nThe error comes from `src/auth/session.ts`: a session row is inserted before its user row exists. Two things need to change:\n\n- create the user first, inside the same transaction\n- make the foreign key `DEFERRABLE INITIALLY DEFERRED` so the order stops mattering\n\n```ts\nawait db.transaction(async (tx) => {\n  const user = await tx.insert(users).values(profile).returning();\n  await tx.insert(sessions).values({ userId: user.id, token });\n});\n```\n\nI'm running the tests now." }, "transcript"),
    ev("s2", "s2:main", "file.write", 700_000, { path: "src/invoice/totals.ts", additions: 38, deletions: 5 }, "codex-app-server"),
    ev("s2", "s2:main", "file.write", 690_000, { path: "src/invoice/totals.test.ts", additions: 26, deletions: 4 }, "codex-app-server"),
    ev("s2", "s2:reviewer", "file.read", 600_000, { path: "src/invoice/format.ts" }, "codex-hook"),
    ev("s2", "s2:main", "command.started", 300_000, { commandId: "c1", argvDisplay: "pnpm test invoice" }, "codex-app-server"),
    ev("s2", "s2:main", "approval.requested", 134_000, { requestId: "appr-1", kind: "command", summary: "rm -rf dist && pnpm build" }, "codex-app-server"),
    ev("s3", "s3:main", "log", 130_000, { message: 'terminal output: "compiling…"' }, "pty", "low"),
    ev("s3", "s3:main", "file.write", 126_000, { path: "src/index.ts" }, "filesystem", "low"),
  ];

  const f = (sessionId: string, repo: string, provider: string, over: Partial<MockFile>): MockFile => ({ path: "", sessionId, repo, provider, operation: "write", additions: 0, deletions: 0, source: "claude-hook", confidence: "high", lastAt: iso(10_000, now), touches: 1, ...over });
  const files: MockFile[] = [
    f("s1", "auth-service", "claude-code", { path: "src/auth/session.ts", additions: 30, deletions: 6, agentName: "main", touches: 3 }),
    f("s1", "auth-service", "claude-code", { path: "src/db/schema.ts", additions: 12, deletions: 3, agentName: "worker" }),
    f("s1", "auth-service", "claude-code", { path: "src/auth/session.test.ts", source: "filesystem", confidence: "low" }),
    f("s1", "auth-service", "claude-code", { path: "docs/migrations.md", operation: "read", agentName: "researcher" }),
    f("s2", "billing-web", "codex", { path: "src/invoice/totals.ts", additions: 38, deletions: 5, agentName: "main", source: "codex-app-server" }),
    f("s2", "billing-web", "codex", { path: "src/invoice/totals.test.ts", additions: 26, deletions: 4, agentName: "main", source: "codex-app-server" }),
    f("s2", "billing-web", "codex", { path: "src/invoice/format.ts", operation: "read", agentName: "reviewer", source: "codex-hook" }),
    f("s2", "billing-web", "codex", { path: "pnpm-lock.yaml", source: "git", confidence: "low", operation: "dirty" }),
    f("s3", "notes-cli", "generic", { path: "src/index.ts", source: "filesystem", confidence: "low", additions: 3, deletions: 1 }),
  ];
  const c = (id: string, sessionId: string, repo: string, provider: string, over: Partial<MockCommand>): MockCommand => ({ id, sessionId, repo, provider, argvDisplay: "", startedAt: iso(30_000, now), source: "claude-hook", confidence: "high", redacted: false, agentName: "main", ...over });
  const commands: MockCommand[] = [
    c("w1", "s1", "auth-service", "claude-code", { argvDisplay: "pnpm test", agentName: "worker", endedAt: iso(5_000, now), exitCode: 1 }),
    c("pid-1", "s1", "auth-service", "claude-code", { argvDisplay: "vitest run  (child process)", agentName: "worker", endedAt: iso(5_000, now), exitCode: 1, source: "process", confidence: "medium" }),
    c("g1", "s1", "auth-service", "claude-code", { argvDisplay: "git diff --stat", endedAt: iso(70_000, now), exitCode: 0 }),
    c("cu1", "s1", "auth-service", "claude-code", { argvDisplay: 'curl -H "Authorization: Bearer [REDACTED]" localhost:4010/health', agentName: "researcher", endedAt: iso(80_000, now), exitCode: 0, redacted: true }),
    c("dev", "s1", "auth-service", "claude-code", { argvDisplay: "pnpm dev --port 4010", agentName: "researcher", startedAt: iso(150_000, now) }),
    c("c2", "s2", "billing-web", "codex", { argvDisplay: "rm -rf dist && pnpm build", startedAt: iso(134_000, now), source: "codex-app-server" }),
    c("c1", "s2", "billing-web", "codex", { argvDisplay: "pnpm test invoice", endedAt: iso(294_000, now), exitCode: 0, source: "codex-app-server" }),
    c("c0", "s2", "billing-web", "codex", { argvDisplay: "git status --short", endedAt: iso(500_000, now), exitCode: 0, source: "codex-app-server" }),
    c("p3", "s3", "notes-cli", "generic", { argvDisplay: "git status  (child of wrapper)", agentName: undefined, endedAt: iso(125_000, now), exitCode: null, source: "process", confidence: "medium" }),
  ];
  // ?mock=1&many=N: N more sessions with repeating names and mixed statuses, to see the switcher under load
  const names = ["eng-142-checkout-flow-spec-review-alignment-notes", "agent-watch", "auth-service", "billing-web"];
  const cycle = ["idle", "idle", "running", "finished", "idle", "waiting", "finished", "failed"] as const;
  for (let i = 0; i < extraSessions; i++) {
    const status = cycle[i % cycle.length]!;
    const id = `x${String(i).padStart(3, "0")}${(i * 7919).toString(16).slice(-4)}`;
    const ended = status === "finished" || status === "failed";
    sessions.push({ id, provider: i % 3 === 0 ? "codex" : "claude-code", cwd: `/Users/demo/work/${names[i % names.length]}`, branch: i % 2 ? "main" : undefined, status, activity: status === "running" ? "editing src/app.ts" : status === "waiting" ? "waiting for approval: pnpm build" : undefined, startedAt: iso(600_000 + i * 90_000, now), ...(ended ? { endedAt: iso(60_000 + i * 30_000, now) } : {}), lastEventAt: iso(5_000 + i * 20_000, now), counts: counts(10, 4, 1, 1), diff: { additions: 0, deletions: 0 }, sources: ["claude-hook"] });
    agents.push(ag(`${id}:main`, id, { displayName: "main", status: status === "running" ? "running" : status === "waiting" ? "waiting" : status === "failed" ? "failed" : ended ? "done" : "idle" }));
  }
  return { sessions, agents, requests, events, files, commands, settings: { ...DEFAULT_SETTINGS }, };
}

/** The loop of "live" events the mock keeps producing so the graph has something to animate. */
const LIVE_LOOP: Array<(n: number) => Omit<AgentEvent, "id" | "sequence" | "occurredAt" | "receivedAt" | "schemaVersion" | "provider" | "redacted">> = [
  () => ({ sessionId: "s1", agentId: "s1:researcher", kind: "file.read", source: "claude-hook", confidence: "high", payload: { path: "docs/migrations.md" } }),
  () => ({ sessionId: "s1", agentId: "s1:main", kind: "file.write", source: "claude-hook", confidence: "high", payload: { path: "src/auth/session.ts", additions: 3, deletions: 1 } }),
  () => ({ sessionId: "s1", agentId: "s1:main", kind: "file.write", source: "filesystem", confidence: "low", payload: { path: "src/auth/session.test.ts" } }),
  () => ({ sessionId: "s1", agentId: "s1:worker", kind: "command.started", source: "claude-hook", confidence: "high", payload: { commandId: "w-live", argvDisplay: "pnpm test" } }),
  () => ({ sessionId: "s1", agentId: "s1:worker", kind: "command.started", source: "process", confidence: "medium", payload: { commandId: "p-live", argvDisplay: "vitest run  (child process)" } }),
  () => ({ sessionId: "s1", agentId: "s1:worker", kind: "tool.failed", source: "claude-hook", confidence: "high", payload: { toolName: "Bash", error: "FK constraint · exit 1" } }),
  () => ({ sessionId: "s2", agentId: "s2:reviewer", kind: "file.read", source: "codex-hook", confidence: "high", payload: { path: "src/invoice/format.ts" } }),
  () => ({ sessionId: "s3", agentId: "s3:main", kind: "file.write", source: "filesystem", confidence: "low", payload: { path: "src/index.ts" } }),
];

import { isAgentItem, type Item, type ItemResultView, type SetupStatusView } from "./setup";

export function mockSetupStatus(): SetupStatusView {
  return {
    claude: { detected: true, hooks: { state: "missing", path: "/Users/demo/.claude/settings.json", foreign: [] } },
    codex: { detected: false, hooks: { state: "missing", path: "/Users/demo/.codex/hooks.json", foreign: [] } },
    gemini: { detected: false, hooks: { state: "missing", path: "/Users/demo/.gemini/settings.json", foreign: [] } },
    antigravity: { detected: false, hooks: { state: "missing", path: "/Users/demo/.gemini/config/hooks.json", foreign: [] } },
    cursor: { detected: false, hooks: { state: "missing", path: "/Users/demo/.cursor/hooks.json", foreign: [] } },
    cli: { state: "missing", path: "/Users/demo/.local/bin/agentwatch", dirOnPath: false },
    autostart: { state: "missing", path: "/Users/demo/Library/LaunchAgents/dev.agentwatch.app.plist" },
    managed: true,
  };
}

export class MockDaemonClient implements DaemonClient {
  readonly data: MockData;
  setup: SetupStatusView = mockSetupStatus();
  private timer: ReturnType<typeof setInterval> | undefined;
  private n = 0;
  private seq: number;

  constructor(
    private readonly store: LiveStore,
    private readonly opts: { intervalMs?: number; live?: boolean } = {},
  ) {
    const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    this.data = buildMockData(Date.now(), Number(params.get("many")) || 0);
    if (params.has("chat") || params.has("tokens")) {
      // ?mock=1&tokens=1: what a Claude Code session looks like once its token counts have been read
      const c = this.data.sessions.find((x) => x.id === "s1");
      if (c) c.usage = { inputTokens: 3_480_000, outputTokens: 1_146_000, cachedInputTokens: 289_100_000, scope: "session", providerReported: true, context: params.has("reported") ? reportedSample() : contextSample(Number(params.get("ctx")) || 0.183) };
    }
    if (params.has("chat")) {
      // ?mock=1&chat=1 shows the chat as it looks once both message settings are on
      this.data.settings.storePromptText = true;
      this.data.settings.storeAssistantText = true;
      const s1 = this.data.sessions.find((x) => x.id === "s1");
      if (s1) s1.title = "Fix the foreign key error that breaks sessions after login";
    }
    if (params.has("quiet")) {
      // ?mock=1&quiet=1: nothing is running or waiting, so the Running tab is the empty state (README screenshots)
      this.data.sessions = this.data.sessions.filter((x) => x.status !== "running" && x.status !== "waiting");
      this.data.requests = [];
    }
    this.seq = Math.max(...this.data.events.map((e) => e.sequence)) + 1;
  }

  private push(frame: ServerFrame) {
    this.store.apply(frame);
  }

  start(): void {
    this.push({ type: "ready", protocol: 1, serverTime: new Date().toISOString(), version: "0.1.0-mock" });
    this.push({ type: "snapshot", sessions: this.data.sessions, agents: this.data.agents, pendingRequests: this.data.requests, lastSequence: this.seq });
    for (const event of this.data.events) this.push({ type: "event", event });
    if (this.opts.live === false) return;
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 1300);
  }

  /** One synthetic live event. Public so tests can drive it deterministically. */
  tick(): AgentEvent {
    const make = LIVE_LOOP[this.n % LIVE_LOOP.length]!;
    this.n += 1;
    const base = make(this.n);
    const session = this.data.sessions.find((s) => s.id === base.sessionId)!;
    const now = new Date().toISOString();
    const event: AgentEvent = { schemaVersion: 1, id: `live${this.seq}`, sequence: this.seq++, provider: session.provider, occurredAt: now, receivedAt: now, redacted: false, ...base };
    this.data.events.push(event);
    session.counts.events += 1;
    session.lastEventAt = now;
    this.push({ type: "event", event });
    this.push({ type: "session", session: { ...session } });
    return event;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async query<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const sid = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const by = <X extends { sessionId: string }>(rows: X[]) => (sid ? rows.filter((r) => r.sessionId === sid) : rows);
    switch (name) {
      case "sessions":
        return this.data.sessions as T;
      case "agents":
        return by(this.data.agents) as T;
      case "events":
        return by(this.data.events).slice(-500) as T;
      case "files":
        return by(this.data.files) as T;
      case "commands":
        return by(this.data.commands) as T;
      case "logs":
        return {
          events: [
            { ...this.data.events[0]!, kind: "log", payload: { message: "notification", level: "info" } },
          ],
          diagnostics: [
            { t: new Date().toISOString(), level: "INFO", where: "ws", msg: "ui client authenticated" },
            { t: new Date().toISOString(), level: "WARN", where: "adapter.codex", msg: 'unknown field "turn.phase" ignored · adapter is feature-detecting' },
            { t: new Date().toISOString(), level: "ERROR", where: "adapter.codex", msg: "app-server stdio closed · reconnecting (attempt 1 of 5)" },
            { t: new Date().toISOString(), level: "INFO", where: "observer.fs", msg: "watching ~/work/billing-web (ignoring .git, node_modules, build outputs)" },
          ],
        } as T;
      case "settings":
        return this.data.settings as T;
      case "setupStatus":
        return structuredClone(this.setup) as T;
      case "status":
        return { version: "0.1.0-mock", pid: 0, uptimeMs: 1, schemaVersion: 1, lastSequence: this.seq, counts: { sessions: this.data.sessions.length, events: this.data.events.length }, ingest: { accepted: 0, rejected: 0, deduped: 0 } } as T;
      default:
        throw new Error(`unknown query ${name}`);
    }
  }

  async command<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (name) {
      case "deleteSession": {
        const id = String(params.sessionId);
        this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
        this.push({ type: "removed", sessionId: id });
        return { deleted: true } as T;
      }
      case "deleteAllHistory":
        this.data.sessions = [];
        this.push({ type: "wiped" });
        return { deleted: true } as T;
      case "setSettings": {
        Object.assign(this.data.settings, params.patch ?? {});
        return this.data.settings as T;
      }
      case "setupApply":
      case "setupRevert": {
        const on = name === "setupApply";
        const items = (Array.isArray(params.items) ? params.items : []) as Item[];
        const results: ItemResultView[] = items.map((item) => {
          const before = isAgentItem(item) ? this.setup[item as "claude"].hooks.state : this.setup[item as "cli"].state;
          if (isAgentItem(item)) this.setup[item as "claude"].hooks.state = on ? "installed" : "missing";
          else this.setup[item as "cli"].state = on ? "installed" : "missing";
          const changed = (before === "installed") !== on;
          return { item, ok: true, changed, message: on ? `Set up ${item}.` : `Removed ${item}.`, backup: on && changed && item === "claude" ? "/Users/demo/.claude/settings.json.agentwatch-backup-mock" : undefined };
        });
        return { results, status: structuredClone(this.setup) } as T;
      }
      default:
        throw new Error(`unknown command ${name}`);
    }
  }
}
