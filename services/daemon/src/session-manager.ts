import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  isProviderSource,
  parseEventInput,
  sanitizeInput,
  type AgentEvent,
  type AgentEventInput,
  type AgentView,
  type RequestView,
  type SessionView,
  type SnapshotFrame,
} from "@agentwatch/protocol";
import type { Store } from "./db/store";

export interface ManagerOptions {
  now?: () => Date;
  /** Observer events for a path are dropped when a provider already reported that write this recently. */
  dedupeWindowMs?: number;
}

export interface IngestStats {
  accepted: number;
  rejected: number;
  deduped: number;
}

/** A session waiting on a person for this long with no event at all is treated as abandoned. */
export const WAITING_STALE_MS = 15 * 60_000;


const FILE_TOOL_VERBS: Record<string, string> = {
  Read: "reading",
  NotebookRead: "reading",
  Edit: "editing",
  MultiEdit: "editing",
  Write: "editing",
  NotebookEdit: "editing",
  Grep: "searching",
  Glob: "searching",
  Bash: "running",
  Task: "delegating",
  Agent: "delegating",
  WebFetch: "fetching",
  WebSearch: "searching",
  // Gemini CLI's tool names
  read_file: "reading",
  read_many_files: "reading",
  list_directory: "reading",
  replace: "editing",
  write_file: "editing",
  grep_search: "searching",
  glob: "searching",
  google_web_search: "searching",
  web_fetch: "fetching",
  run_shell_command: "running",
  // Antigravity CLI's
  run_command: "running",
  write_to_file: "editing",
  replace_file_content: "editing",
  multi_replace_file_content: "editing",
  view_file: "reading",
  search_web: "searching",
};

function relPath(path: string, cwd: string | undefined): string {
  if (cwd && path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  return path;
}

function shortCommand(cmd: string): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

/**
 * Normalizer + correlator + live state. Turns sanitized adapter events into persisted AgentEvents,
 * maintains the read models the UI renders (sessions, agents, pending requests), and emits changes.
 * Evidence is never upgraded: confidence and source are carried through untouched.
 */
export class SessionManager extends EventEmitter {
  readonly sessions = new Map<string, SessionView>();
  readonly agents = new Map<string, AgentView>();
  readonly requests = new Map<string, RequestView>();
  readonly stats: IngestStats = { accepted: 0, rejected: 0, deduped: 0 };
  private readonly now: () => Date;
  private readonly dedupeWindowMs: number;
  private providerIndex = new Map<string, string>();
  /** Rows that exist in SQLite. Their later changes are written behind, not on every event. */
  private persistedSessions = new Set<string>();
  private persistedAgents = new Set<string>();
  private dirtySessions = new Set<string>();
  private dirtyAgents = new Set<string>();
  /** When a provider (hook / API) last spoke for each session. Observers (git, file watcher) never count: they run all the time. */
  private lastProviderAt = new Map<string, number>();
  /** Sessions with a tool or command started and not yet finished: a long build is not "idle". */
  private inFlight = new Set<string>();
  /** Labels of subagent tasks waiting for their SubagentStart, per session, in the order the tasks were started. */
  private taskLabels = new Map<string, string[]>();
  /** Where each session's conversation file is (from the hook payloads). Memory only; never stored or streamed. */
  private transcripts = new Map<string, string>();
  /** Which kinds of chat message may exist at all. Both are off until the person turns them on. */
  private content = { prompts: false, responses: false, tokens: false, window: 0 };
  private flushTimer: NodeJS.Timeout | undefined;
  private filePaths = new Map<string, Set<string>>();

  constructor(
    private readonly store: Store,
    opts: ManagerOptions = {},
  ) {
    super();
    this.now = opts.now ?? (() => new Date());
    this.dedupeWindowMs = opts.dedupeWindowMs ?? 3000;
    this.hydrate();
  }

  // ---- lifecycle ----

  /** Rebuild live state from SQLite after a daemon restart. Open sessions become idle until new events arrive. */
  private hydrate(): void {
    this.persistedSessions.clear();
    this.persistedAgents.clear();
    this.dirtySessions.clear();
    this.dirtyAgents.clear();
    this.filePaths.clear();
    this.sessions.clear();
    this.agents.clear();
    this.requests.clear();
    this.providerIndex.clear();
    for (const s of this.store.loadSessions()) {
      if (!s.endedAt && s.status !== "idle") s.status = "idle";
      this.sessions.set(s.id, s);
      this.persistedSessions.add(s.id);
      if (s.providerSessionId) this.providerIndex.set(`${s.provider}:${s.providerSessionId}`, s.id);
    }
    for (const a of this.store.loadAgents()) {
      if (this.sessions.has(a.sessionId)) {
        if (a.status === "running") a.status = "idle";
        this.agents.set(a.id, a);
        this.persistedAgents.add(a.id);
      }
    }
    for (const r of this.store.loadPendingRequests()) {
      const s = this.sessions.get(r.sessionId);
      if (!s) continue;
      this.requests.set(r.id, r);
      // A question that was open when the service stopped keeps its session waiting (never "idle with a pending
      // request"); the stale-waiting sweep then clears it if nobody answers.
      if (!s.endedAt) {
        s.status = "waiting";
        const a = r.agentId ? this.agents.get(r.agentId) : undefined;
        if (a && a.status === "idle") a.status = "waiting";
      }
    }
  }

  snapshot(): SnapshotFrame {
    return {
      type: "snapshot",
      sessions: [...this.sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      agents: [...this.agents.values()],
      pendingRequests: [...this.requests.values()].filter((r) => r.status === "pending"),
      lastSequence: this.store.lastSequence,
    };
  }

  // ---- ingestion ----

  /** Untrusted entry point: validate, sanitize (allow-list + redaction), then apply. */
  ingest(raw: unknown): AgentEvent | null {
    let input: AgentEventInput;
    try {
      input = parseEventInput(raw);
    } catch (err) {
      this.stats.rejected += 1;
      throw err;
    }
    const { event, redacted } = sanitizeInput(input);
    return this.apply(event, redacted);
  }

  private resolveSession(input: AgentEventInput, at: string): { id: string; created: boolean } {
    const key = `${input.provider}:${input.providerSessionId}`;
    if (input.wrapperSessionId) {
      const id = input.wrapperSessionId;
      let created = false;
      if (!this.sessions.has(id)) {
        this.createSession(id, input, at);
        created = true;
      }
      const s = this.sessions.get(id)!;
      if (s.providerSessionId !== input.providerSessionId && input.provider === s.provider) {
        s.providerSessionId = input.providerSessionId;
      }
      this.providerIndex.set(key, id);
      return { id, created };
    }
    const known = this.providerIndex.get(key) ?? this.store.findSessionId(input.provider, input.providerSessionId);
    if (known && this.sessions.has(known)) {
      this.providerIndex.set(key, known);
      return { id: known, created: false };
    }
    const id = randomUUID();
    this.createSession(id, input, at);
    this.providerIndex.set(key, id);
    return { id, created: true };
  }

  private createSession(id: string, input: AgentEventInput, at: string): SessionView {
    const view: SessionView = {
      id,
      provider: input.provider,
      providerSessionId: input.providerSessionId,
      status: "running",
      startedAt: at,
      lastEventAt: at,
      counts: { tools: 0, files: 0, commands: 0, failedCommands: 0, events: 0 },
      diff: { additions: 0, deletions: 0 },
      sources: [],
    };
    if (input.cwd) view.cwd = input.cwd;
    this.sessions.set(id, view);
    this.agents.set(`${id}:main`, {
      id: `${id}:main`,
      sessionId: id,
      displayName: "main",
      status: "running",
      startedAt: at,
      toolCount: 0,
      lastEventAt: at,
    });
    return view;
  }

  private resolveAgent(sessionId: string, input: AgentEventInput, at: string): AgentView {
    const mainId = `${sessionId}:main`;
    if (!input.providerAgentId) return this.agents.get(mainId)!;
    const id = `${sessionId}:${input.providerAgentId}`;
    let agent = this.agents.get(id);
    if (!agent) {
      agent = {
        id,
        sessionId,
        providerAgentId: input.providerAgentId,
        parentAgentId: input.parentProviderAgentId ? `${sessionId}:${input.parentProviderAgentId}` : mainId,
        status: "running",
        startedAt: at,
        toolCount: 0,
        lastEventAt: at,
      };
      this.agents.set(id, agent);
    }
    return agent;
  }

  /** Apply one already-sanitized event. Exposed so observers can feed events without a JSON round trip. */
  /** The one place that decides whether chat text may be kept: a message of a kind that is switched off never gets in. */
  setContentPolicy(policy: { prompts: boolean; responses: boolean; tokens?: boolean; window?: number }): void {
    this.content = { prompts: policy.prompts, responses: policy.responses, tokens: policy.tokens ?? false, window: policy.window ?? 0 };
  }

  /** `prompts` and `responses` are about text; `tokens` is about counts only. */
  contentPolicy(): { prompts: boolean; responses: boolean; tokens: boolean; window: number } {
    return { ...this.content };
  }

  /** Remember where a session's conversation file lives. */
  noteTranscript(provider: AgentEventInput["provider"], providerSessionId: string, path: string): void {
    const id = this.providerIndex.get(`${provider}:${providerSessionId}`);
    if (id) this.transcripts.set(id, path);
  }

  messageIds(sessionId: string): Set<string> {
    return this.store.messageIds(sessionId);
  }

  transcriptFor(sessionId: string): string | undefined {
    return this.transcripts.get(sessionId);
  }

  setSessionTitle(sessionId: string, title: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.title === title) return;
    s.title = title.slice(0, 160);
    this.emit("session", s);
  }

  apply(raw: AgentEventInput, alreadyRedacted = false): AgentEvent | null {
    if (raw.kind === "usage.updated" && raw.source === "transcript" && !this.content.tokens) {
      this.stats.rejected += 1;
      return null; // token tracking is switched off
    }
    if (raw.kind === "message") {
      const role = (raw.payload as { role?: unknown }).role;
      if ((role === "user" && !this.content.prompts) || (role === "assistant" && !this.content.responses) || (role !== "user" && role !== "assistant")) {
        this.stats.rejected += 1;
        return null;
      }
    }
    // Defense in depth: observers call apply() directly, so redaction and the payload allow-list
    // must happen here, not only on the ingest path. It is idempotent for already-sanitized input.
    const clean = sanitizeInput(raw);
    const input = clean.event;
    const redacted = alreadyRedacted || clean.redacted;
    const receivedAt = this.now().toISOString();
    const parsed = input.occurredAt ? Date.parse(input.occurredAt) : NaN;
    const occurredAt = Number.isNaN(parsed) ? receivedAt : new Date(parsed).toISOString();

    const resolved = this.resolveSession(input, occurredAt);
    const session = this.sessions.get(resolved.id)!;

    // Observer correlation: a filesystem write the provider already reported is not a second fact.
    if (input.source === "filesystem" && input.kind === "file.write" && typeof input.payload.path === "string") {
      const since = new Date(Date.parse(receivedAt) - this.dedupeWindowMs).toISOString();
      if (this.store.recentProviderWrite(session.id, input.payload.path, since)) {
        this.stats.deduped += 1;
        return null;
      }
    }

    // A subagent's end with no start and no activity ever seen is not a subagent AgentWatch can describe: Claude Code
    // reports one of these about every half minute. Showing each as "subagent N" invented agents that never ran.
    if (input.kind === "agent.ended" && input.providerAgentId && !this.agents.has(`${session.id}:${input.providerAgentId}`)) return null;

    const agent = this.resolveAgent(session.id, input, occurredAt);
    const event: AgentEvent = {
      schemaVersion: 1,
      id: randomUUID(),
      sequence: this.store.nextSequence(),
      sessionId: session.id,
      agentId: agent.id,
      provider: session.provider,
      kind: input.kind,
      occurredAt,
      receivedAt,
      source: input.source,
      confidence: input.confidence,
      redacted,
      payload: input.payload,
    };
    if (agent.parentAgentId) event.parentAgentId = agent.parentAgentId;
    if (input.cwd) event.cwd = input.cwd;
    if (input.correlationId) event.correlationId = input.correlationId;

    const touched = { agents: new Set<AgentView>([agent]), requests: new Set<RequestView>() };
    this.store.transaction(() => {
      this.reduce(event, session, agent, touched, input);
      if (event.source !== "transcript") {
        // anything read back from a conversation file says nothing about when the agent last did something
        session.lastEventAt = receivedAt;
        session.counts.events += 1;
      }
      if (isProviderSource(event.source)) {
        this.lastProviderAt.set(session.id, Date.parse(receivedAt));
        if (event.kind === "tool.started" || event.kind === "command.started") this.inFlight.add(session.id);
        else if (["tool.completed", "tool.failed", "command.completed", "status.changed", "session.ended"].includes(event.kind)) this.inFlight.delete(session.id);
      }
      if (!session.sources.includes(event.source)) session.sources.push(event.source);
      if (event.source !== "transcript") agent.lastEventAt = receivedAt;
      this.persistSession(session);
      for (const a of touched.agents) this.persistAgent(a);
      this.store.insertEvent(event);
      for (const r of touched.requests) this.store.upsertRequest(r);
      this.persistDerived(event, session);
    });

    this.stats.accepted += 1;
    this.emit("event", event);
    this.emit("session", session);
    for (const a of touched.agents) this.emit("agent", a);
    for (const r of touched.requests) this.emit("request", r);
    return event;
  }

  // ---- state reduction ----

  /** Is something still waiting on the person that was asked at or before `at`? (A later question is not answered by an earlier event.) */
  hasPendingBefore(sessionId: string, at: string): boolean {
    return this.pendingFor(sessionId).some((r) => r.createdAt <= at);
  }

  private pendingFor(sessionId: string): RequestView[] {
    return [...this.requests.values()].filter((r) => r.sessionId === sessionId && r.status === "pending");
  }

  private resolveRequest(sessionId: string, providerRequestId: string, at: string, touched: Set<RequestView>): void {
    const req = this.requests.get(`${sessionId}:${providerRequestId}`);
    if (!req || req.status !== "pending") return;
    req.status = "resolved";
    req.resolvedAt = at;
    touched.add(req);
  }

  /** A tool that finished (or failed) after its permission request was shown means the person answered it. Oldest first. */
  private resolveByTool(agentId: string, toolName: unknown, at: string, touched: Set<RequestView>): void {
    if (typeof toolName !== "string") return;
    const req = [...this.requests.values()].filter((r) => r.status === "pending" && r.agentId === agentId && r.toolName === toolName && r.createdAt <= at).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!req) return;
    req.status = "resolved";
    req.resolvedAt = at;
    touched.add(req);
  }

  private setActivity(session: SessionView, agent: AgentView, text: string): void {
    session.activity = text;
    agent.lastAction = text;
  }

  private reduce(
    e: AgentEvent,
    session: SessionView,
    agent: AgentView,
    touched: { agents: Set<AgentView>; requests: Set<RequestView> },
    input: AgentEventInput,
  ): void {
    const p = e.payload;
    const isMain = agent.id === `${session.id}:main`;
    const cwd = session.cwd;

    // Activity of the agent brings a finished or idle session back, unless the event says otherwise. Only evidence that
    // the agent did something counts: a file watcher seeing a file change, a git status, or a chat message read back
    // from a conversation file says nothing about the agent (a wrapped process has nothing else to go on).
    const evidence = isProviderSource(e.source) || session.provider === "generic";
    if (e.kind !== "session.ended" && e.kind !== "status.changed" && e.kind !== "message" && evidence) {
      if (session.endedAt) {
        delete session.endedAt;
        delete session.exitCode;
      }
      if (session.status === "idle" || session.status === "finished") {
        session.status = "running";
        // a subagent doing work means the main agent that sent it is working too, whatever it read as after a restart
        const main = this.agents.get(`${session.id}:main`);
        if (main && main.status === "idle") {
          main.status = "running";
          touched.agents.add(main);
        }
      }
      if (agent.status === "idle" || agent.status === "done") agent.status = "running";
    }

    switch (e.kind) {
      case "session.started": {
        if (typeof p.cwd === "string") session.cwd = p.cwd;
        if (typeof p.model === "string") {
          session.model = p.model;
          const main = this.agents.get(`${session.id}:main`);
          if (main) {
            main.model = p.model;
            touched.agents.add(main);
          }
        }
        if (typeof p.executable === "string") session.executable = p.executable;
        if (typeof p.repoRoot === "string") session.repoRoot = p.repoRoot;
        if (typeof p.branch === "string") session.branch = p.branch;
        session.status = "running";
        break;
      }
      case "session.ended": {
        const code = typeof p.exitCode === "number" ? p.exitCode : undefined;
        session.endedAt = e.occurredAt;
        if (code !== undefined) session.exitCode = code;
        session.status = code !== undefined && code !== 0 ? "failed" : "finished";
        session.activity = undefined;
        for (const r of this.pendingFor(session.id)) {
          r.status = "resolved";
          r.resolvedAt = e.occurredAt;
          touched.requests.add(r);
        }
        for (const a of this.agents.values()) {
          if (a.sessionId === session.id && (a.status === "running" || a.status === "waiting" || a.status === "idle")) {
            a.status = "done";
            a.endedAt = e.occurredAt;
            touched.agents.add(a);
          }
        }
        break;
      }
      case "agent.started": {
        agent.status = "running";
        if (typeof p.agentType === "string") agent.role = p.agentType;
        if (typeof p.displayName === "string") agent.displayName = p.displayName;
        // The task's own label is the best name for a subagent (its id is a hash). Matched by order: best effort.
        const label = isMain ? undefined : this.taskLabels.get(session.id)?.shift();
        if (label) agent.displayName = label;
        if (typeof p.model === "string") agent.model = p.model;
        break;
      }
      case "agent.ended": {
        agent.endedAt = e.occurredAt;
        agent.status = p.outcome === "failed" || agent.status === "failed" ? "failed" : "done";
        // the last background subagent finished while the main agent was already idle: nothing is running any more
        const main = this.agents.get(`${session.id}:main`);
        const stillBusy = [...this.agents.values()].some((a) => a.sessionId === session.id && a.status === "running");
        if (!isMain && main?.status === "idle" && !stillBusy && session.status === "running" && this.pendingFor(session.id).length === 0 && !session.endedAt) {
          session.status = "idle";
          session.activity = "idle";
        }
        break;
      }
      case "status.changed": {
        if (typeof p.model === "string") {
          session.model = p.model;
          agent.model = p.model;
        }
        if (p.status === "idle") {
          // the turn finished, so nothing this agent asked is still open (denied, cancelled or answered)
          for (const r of this.pendingFor(session.id)) {
            if (r.agentId !== agent.id) continue;
            r.status = "resolved";
            r.resolvedAt = e.occurredAt;
            touched.requests.add(r);
          }
          // an agent whose own questions are all closed is no longer waiting on anyone, even if another agent still is
          if (!session.endedAt && agent.status === "waiting" && !this.pendingFor(session.id).some((r) => r.agentId === agent.id)) agent.status = "idle";
          // The main turn ended, but a background subagent may still be working ("waiting for 1 background agent"):
          // the session is then still running.
          const busy = [...this.agents.values()].some((a) => a.sessionId === session.id && a.id !== agent.id && a.status === "running");
          if (this.pendingFor(session.id).length === 0 && !session.endedAt) {
            if (agent.status === "running") agent.status = "idle";
            if (!busy) {
              session.status = "idle";
              session.activity = typeof p.label === "string" ? p.label : "idle";
            }
          }
        } else if (p.status === "running" && !session.endedAt) {
          session.status = "running";
        } else if (p.status === "waiting" && !session.endedAt) {
          session.status = "waiting";
        }
        break;
      }
      case "tool.started": {
        if (typeof p.taskLabel === "string" && p.taskLabel) {
          const q = this.taskLabels.get(session.id) ?? [];
          q.push(p.taskLabel);
          if (q.length > 20) q.shift();
          this.taskLabels.set(session.id, q);
        }
        const tool = String(p.toolName ?? "tool");
        agent.toolCount += 1;
        session.counts.tools += 1;
        if (agent.status === "failed" && !isMain) {
          agent.status = "running";
          delete agent.failureNote;
        }
        const verb = FILE_TOOL_VERBS[tool] ?? `using ${tool}`;
        const target = typeof p.target === "string" ? ` ${relPath(p.target, cwd)}` : tool === "Bash" || tool === "run_shell_command" || tool === "run_command" ? " a command" : "";
        this.setActivity(session, agent, `${verb}${target}`);
        break;
      }
      case "tool.completed": {
        if (typeof p.toolUseId === "string") this.resolveRequest(session.id, p.toolUseId, e.occurredAt, touched.requests);
        this.resolveByTool(agent.id, p.toolName, e.occurredAt, touched.requests);
        break;
      }
      case "tool.failed": {
        if (typeof p.toolUseId === "string") this.resolveRequest(session.id, p.toolUseId, e.occurredAt, touched.requests);
        this.resolveByTool(agent.id, p.toolName, e.occurredAt, touched.requests);
        if (typeof p.error === "string") agent.failureNote = p.error;
        break;
      }
      case "file.read":
      case "file.write":
      case "file.delete": {
        const path = String(p.path ?? "");
        const verb = e.kind === "file.read" ? "reading" : e.kind === "file.delete" ? "deleting" : "editing";
        if (e.kind !== "file.read" && e.confidence === "high") {
          session.diff.additions += typeof p.additions === "number" ? p.additions : 0;
          session.diff.deletions += typeof p.deletions === "number" ? p.deletions : 0;
        }
        if (e.confidence === "high" || e.kind === "file.read") this.setActivity(session, agent, `${verb} ${relPath(path, cwd)}`);
        break;
      }
      case "command.started": {
        session.counts.commands += 1;
        this.setActivity(session, agent, `running ${shortCommand(String(p.argvDisplay ?? "command"))}`);
        break;
      }
      case "command.completed": {
        const code = typeof p.exitCode === "number" ? p.exitCode : null;
        const done = this.store.completeCommand(String(p.commandId ?? ""), e.occurredAt, code, typeof p.signal === "string" ? p.signal : undefined);
        if (code !== null && code !== 0) {
          session.counts.failedCommands += 1;
          const note = `${shortCommand(done.argvDisplay ?? "command")} · exit ${code}`;
          agent.failureNote = note;
          if (!isMain) agent.status = "failed";
        }
        break;
      }
      case "approval.requested": {
        const providerRequestId = String(p.requestId ?? e.id);
        const req: RequestView = {
          id: `${session.id}:${providerRequestId}`,
          sessionId: session.id,
          agentId: agent.id,
          providerRequestId,
          kind: String(p.kind ?? "other"),
          status: "pending",
          createdAt: e.occurredAt,
          source: e.source,
        };
        if (typeof p.summary === "string") req.summary = p.summary;
        if (typeof p.toolName === "string") req.toolName = p.toolName;
        this.requests.set(req.id, req);
        touched.requests.add(req);
        session.status = "waiting";
        agent.status = "waiting";
        this.setActivity(session, agent, `waiting for approval: ${shortCommand(req.summary ?? req.kind)}`);
        break;
      }
      case "approval.resolved": {
        this.resolveRequest(session.id, String(p.requestId ?? ""), e.occurredAt, touched.requests);
        break;
      }
      case "usage.updated": {
        const u: NonNullable<SessionView["usage"]> = { scope: String(p.scope ?? "thread"), providerReported: p.providerReported === true };
        for (const k of ["model", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"] as const) {
          if (p[k] !== undefined) (u as unknown as Record<string, unknown>)[k] = p[k];
        }
        if (typeof p.contextUsed === "number" && typeof p.contextWindow === "number") {
          u.context = {
            used: p.contextUsed,
            window: p.contextWindow,
            windowAuto: p.contextAuto === true,
            setup: typeof p.contextSetup === "number" ? p.contextSetup : 0,
            conversation: typeof p.contextConversation === "number" ? p.contextConversation : 0,
            tools: typeof p.contextTools === "number" ? p.contextTools : 0,
          };
          if (p.contextReported === true && typeof p.contextCategories === "string") {
            try {
              const raw = JSON.parse(p.contextCategories) as Array<{ name?: unknown; tokens?: unknown }>;
              const cats = raw.filter((c) => typeof c.name === "string" && typeof c.tokens === "number").map((c) => ({ name: String(c.name).slice(0, 40), tokens: Number(c.tokens) }));
              if (cats.length) {
                u.context.categories = cats;
                u.context.reported = true;
              }
            } catch {
              /* a malformed list is ignored: the estimate still shows */
            }
          }
          if (typeof p.contextBuffer === "number") u.context.buffer = p.contextBuffer;
        }
        session.usage = u;
        break;
      }
      case "git.changed": {
        const hasProviderDiff = session.sources.some(isProviderSource);
        if (!p.baseline && !hasProviderDiff && typeof p.additions === "number") {
          session.diff = { additions: p.additions, deletions: typeof p.deletions === "number" ? p.deletions : 0 };
        }
        break;
      }
      default:
        break;
    }

    // Waiting state follows the pending set: an agent only reads as waiting while a question of its own is open.
    // (A denied or interrupted question leaves no answer event, so the session can move on while its agent still says waiting.)
    if (!session.endedAt) {
      if (session.status === "waiting" && this.pendingFor(session.id).length === 0) session.status = "running";
      for (const a of this.agents.values()) {
        if (a.sessionId === session.id && a.status === "waiting" && !this.pendingFor(session.id).some((r) => r.agentId === a.id)) {
          a.status = session.status === "idle" ? "idle" : "running";
          touched.agents.add(a);
        }
      }
    }
    void input;
  }

  /** Rows that exist for fast queries: files, commands, usage. */
  private persistDerived(e: AgentEvent, session: SessionView): void {
    const p = e.payload;
    switch (e.kind) {
      case "file.read":
      case "file.write":
      case "file.delete": {
        const op = e.kind === "file.read" ? "read" : e.kind === "file.delete" ? "delete" : "write";
        const row: Parameters<Store["insertFile"]>[0] = {
          id: e.id,
          sessionId: e.sessionId,
          agentId: e.agentId,
          path: String(p.path ?? ""),
          operation: op,
          occurredAt: e.occurredAt,
          source: e.source,
          confidence: e.confidence,
        };
        if (typeof p.additions === "number") row.additions = p.additions;
        if (typeof p.deletions === "number") row.deletions = p.deletions;
        this.store.insertFile(row);
        let paths = this.filePaths.get(e.sessionId);
        if (!paths) {
          paths = new Set(this.store.distinctPaths(e.sessionId)); // includes the row just inserted
          this.filePaths.set(e.sessionId, paths);
        }
        paths.add(String(p.path ?? ""));
        session.counts.files = paths.size;
        this.dirtySessions.add(session.id);
        this.scheduleFlush();
        break;
      }
      case "command.started": {
        const row: Parameters<Store["insertCommand"]>[0] = {
          id: String(p.commandId ?? e.id),
          sessionId: e.sessionId,
          agentId: e.agentId,
          argvDisplay: String(p.argvDisplay ?? ""),
          startedAt: e.occurredAt,
          source: e.source,
          confidence: e.confidence,
          redacted: e.redacted,
        };
        if (typeof p.toolUseId === "string") row.toolUseId = p.toolUseId;
        if (typeof p.pid === "number") row.pid = p.pid;
        if (typeof p.ppid === "number") row.ppid = p.ppid;
        if (e.cwd) row.cwd = e.cwd;
        this.store.insertCommand(row);
        break;
      }
      case "usage.updated": {
        const row: Parameters<Store["insertUsage"]>[0] = {
          id: e.id,
          sessionId: e.sessionId,
          agentId: e.agentId,
          occurredAt: e.occurredAt,
          scope: String(p.scope ?? "thread"),
          source: e.source,
        };
        for (const k of ["model", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"] as const) {
          if (p[k] !== undefined) (row as unknown as Record<string, unknown>)[k] = p[k];
        }
        this.store.insertUsage(row);
        break;
      }
      default:
        break;
    }
  }

  // ---- write-behind ----

  /** A row must exist before events can reference it (foreign keys), so the first write is immediate. */
  private persistSession(s: SessionView): void {
    if (!this.persistedSessions.has(s.id)) {
      this.store.upsertSession(s);
      this.persistedSessions.add(s.id);
      return;
    }
    this.dirtySessions.add(s.id);
    this.scheduleFlush();
  }

  private persistAgent(a: AgentView): void {
    if (!this.persistedAgents.has(a.id)) {
      // A parent row must exist before its child (foreign key). The first thing the service sees of a session can be a
      // subagent: after a restart in the middle of a run, or when a conversation is resumed under a new session id.
      let row = a;
      if (a.parentAgentId && !this.persistedAgents.has(a.parentAgentId)) {
        const parent = this.agents.get(a.parentAgentId);
        if (parent) this.persistAgent(parent);
        if (!this.persistedAgents.has(a.parentAgentId)) {
          row = { ...a };
          delete row.parentAgentId; // an unknown parent is stored as none rather than failing the whole event
        }
      }
      this.store.upsertAgent(row);
      this.persistedAgents.add(a.id);
      return;
    }
    this.dirtyAgents.add(a.id);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, 400);
    this.flushTimer.unref();
  }

  /** Write every changed session and agent row in one transaction. Cheap when nothing changed. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirtySessions.size === 0 && this.dirtyAgents.size === 0) return;
    const sessions = [...this.dirtySessions].map((id) => this.sessions.get(id)).filter((x): x is SessionView => !!x);
    const agents = [...this.dirtyAgents].map((id) => this.agents.get(id)).filter((x): x is AgentView => !!x);
    this.dirtySessions.clear();
    this.dirtyAgents.clear();
    this.store.transaction(() => {
      for (const s of sessions) if (this.store.sessionExists(s.id)) this.store.upsertSession(s);
      for (const a of agents) this.store.upsertAgent(a);
    });
  }

  // ---- housekeeping ----

  /**
   * Sessions that have been silent for a while, with nothing pending, read as idle rather than running.
   * A session that has been silent for a long time with a question still open is treated the same way: its
   * process may have been killed (or run headless) with no SessionEnd, and it would otherwise claim to need
   * a person forever. If it was only slow, its next event puts it back to running.
   */
  sweepIdle(idleAfterMs: number, waitingStaleAfterMs = WAITING_STALE_MS): SessionView[] {
    const cutoff = this.now().getTime() - idleAfterMs;
    const changed: SessionView[] = [];
    const nowMs = this.now().getTime();
    for (const s of this.sessions.values()) {
      if (s.status !== "waiting" || s.endedAt) continue;
      const providerAt = this.lastProviderAt.get(s.id) ?? 0;
      const stale = this.pendingFor(s.id).filter((r) => nowMs - Math.max(Date.parse(r.createdAt), providerAt) > waitingStaleAfterMs);
      if (!stale.length) continue;
      const at = this.now().toISOString();
      this.store.transaction(() => {
        for (const r of stale) {
          r.status = "resolved";
          r.resolvedAt = at;
          this.store.upsertRequest(r);
          this.emit("request", r);
        }
      });
      if (this.pendingFor(s.id).length) continue; // another question of this session is still fresh
      s.status = "idle";
      s.activity = undefined;
      for (const a of this.agents.values()) {
        if (a.sessionId === s.id && a.status === "waiting") {
          a.status = "idle";
          this.dirtyAgents.add(a.id);
          this.emit("agent", a);
        }
      }
      this.dirtySessions.add(s.id);
      this.scheduleFlush();
      changed.push(s);
      this.emit("session", s);
    }
    for (const s of this.sessions.values()) {
      if (s.status !== "running" || s.endedAt) continue;
      // How long since the AGENT did something. A file watcher or git status keeps reporting while nobody is working,
      // so for a Claude or Codex session only its own hooks count; a wrapped process has only observations to go on.
      const activeAt = s.provider === "generic" ? Date.parse(s.lastEventAt) : this.lastProviderAt.get(s.id) ?? 0;
      // a tool that has started but not finished may legitimately take a long time (a build, a test run)
      const patience = this.inFlight.has(s.id) ? Math.max(idleAfterMs, 10 * 60_000) : idleAfterMs;
      if (activeAt > nowMs - patience) continue;
      if (this.pendingFor(s.id).length) continue;
      s.status = "idle";
      this.dirtySessions.add(s.id);
      this.scheduleFlush();
      changed.push(s);
      this.emit("session", s);
    }
    return changed;
  }

  private forget(id: string): void {
    this.dirtySessions.delete(id);
    this.persistedSessions.delete(id);
    this.filePaths.delete(id);
    this.taskLabels.delete(id);
    this.lastProviderAt.delete(id);
    this.inFlight.delete(id);
    this.transcripts.delete(id);
    for (const [k, a] of this.agents) {
      if (a.sessionId === id) {
        this.dirtyAgents.delete(k);
        this.persistedAgents.delete(k);
      }
    }
  }

  removeSession(id: string): boolean {
    this.flush();
    this.forget(id);
    const ok = this.store.deleteSession(id);
    this.sessions.delete(id);
    for (const [k, a] of this.agents) if (a.sessionId === id) this.agents.delete(k);
    for (const [k, r] of this.requests) if (r.sessionId === id) this.requests.delete(k);
    for (const [k, v] of this.providerIndex) if (v === id) this.providerIndex.delete(k);
    if (ok) this.emit("removed", id);
    return ok;
  }

  wipeAll(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.dirtySessions.clear();
    this.dirtyAgents.clear();
    this.persistedSessions.clear();
    this.persistedAgents.clear();
    this.filePaths.clear();
    this.store.wipe();
    this.sessions.clear();
    this.agents.clear();
    this.requests.clear();
    this.providerIndex.clear();
    this.emit("wiped");
  }

  purge(retentionDays: number): string[] {
    if (!Number.isFinite(retentionDays)) return [];
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    this.flush();
    const ids = this.store.purgeOlderThan(cutoff);
    for (const id of ids) {
      this.forget(id);
      this.sessions.delete(id);
      for (const [k, a] of this.agents) if (a.sessionId === id) this.agents.delete(k);
      for (const [k, r] of this.requests) if (r.sessionId === id) this.requests.delete(k);
      this.emit("removed", id);
    }
    return ids;
  }
}
