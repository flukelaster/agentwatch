import type {
  AgentEvent,
  AgentProvider,
  AgentView,
  CommandRow,
  RequestView,
  SessionView,
  Settings,
} from "@agentwatch/protocol";
import { DEFAULT_SETTINGS } from "@agentwatch/protocol";
import { destroyDatabase, openDatabase, type Db } from "./database";

const ADAPTER_VERSION = "1";

type Row = Record<string, unknown>;

/** node:sqlite rejects `undefined` bindings; everything optional goes in as null. */
function nn<T>(value: T | undefined | null): T | null {
  return value === undefined ? null : value;
}

function s(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function n(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export interface EventQuery {
  sessionId?: string;
  afterSequence?: number;
  limit?: number;
  kinds?: string[];
}

export interface FileSummaryRow {
  path: string;
  sessionId: string;
  repo?: string;
  provider: AgentProvider;
  operation: string;
  additions: number;
  deletions: number;
  agentName?: string;
  source: string;
  confidence: string;
  lastAt: string;
  touches: number;
}

export interface CommandSummaryRow extends CommandRow {
  repo?: string;
  provider: AgentProvider;
  agentName?: string;
}

export class Store {
  db: Db;
  private seq = 0;
  private txDepth = 0;

  constructor(
    private readonly dbPath: string,
    db?: Db,
  ) {
    this.db = db ?? openDatabase(dbPath);
    this.seq = this.readMaxSequence();
  }

  private readMaxSequence(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS m FROM events").get() as { m: number };
    return row.m;
  }

  /** Daemon-wide monotonic sequence. The canonical replay order. */
  nextSequence(): number {
    this.seq += 1;
    return this.seq;
  }
  get lastSequence(): number {
    return this.seq;
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN");
    this.txDepth += 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }

  // ---- sessions ----

  findSessionId(provider: string, providerSessionId: string): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM sessions WHERE provider = ? AND provider_session_id = ?")
      .get(provider, providerSessionId) as { id: string } | undefined;
    return row?.id;
  }

  sessionExists(id: string): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM sessions WHERE id = ?").get(id);
  }

  upsertSession(v: SessionView): void {
    const meta = JSON.stringify({
      activity: v.activity,
      counts: v.counts,
      diff: v.diff,
      usage: v.usage,
      sources: v.sources,
      branch: v.branch,
      lastEventAt: v.lastEventAt,
    });
    this.db
      .prepare(
        `INSERT INTO sessions (id, provider, provider_session_id, adapter_version, executable, model, cwd, repo_root, status, started_at, ended_at, exit_code, privacy_mode, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'metadata-only', ?)
         ON CONFLICT(id) DO UPDATE SET provider_session_id = COALESCE(excluded.provider_session_id, sessions.provider_session_id),
           executable = excluded.executable, model = excluded.model, cwd = excluded.cwd, repo_root = excluded.repo_root,
           status = excluded.status, ended_at = excluded.ended_at, exit_code = excluded.exit_code, metadata_json = excluded.metadata_json`,
      )
      .run(
        v.id,
        v.provider,
        nn(v.providerSessionId),
        ADAPTER_VERSION,
        nn(v.executable),
        nn(v.model),
        nn(v.cwd),
        nn(v.repoRoot),
        v.status,
        v.startedAt,
        nn(v.endedAt),
        nn(v.exitCode),
        meta,
      );
  }

  private rowToSession(r: Row): SessionView {
    const meta = JSON.parse(String(r.metadata_json ?? "{}")) as Partial<SessionView>;
    const view: SessionView = {
      id: String(r.id),
      provider: r.provider as AgentProvider,
      status: r.status as SessionView["status"],
      startedAt: String(r.started_at),
      lastEventAt: meta.lastEventAt ?? String(r.ended_at ?? r.started_at),
      counts: meta.counts ?? { tools: 0, files: 0, commands: 0, failedCommands: 0, events: 0 },
      diff: meta.diff ?? { additions: 0, deletions: 0 },
      sources: meta.sources ?? [],
    };
    const providerSessionId = s(r.provider_session_id);
    if (providerSessionId) view.providerSessionId = providerSessionId;
    if (s(r.executable)) view.executable = s(r.executable);
    if (s(r.model)) view.model = s(r.model);
    if (s(r.cwd)) view.cwd = s(r.cwd);
    if (s(r.repo_root)) view.repoRoot = s(r.repo_root);
    if (meta.branch) view.branch = meta.branch;
    if (meta.activity) view.activity = meta.activity;
    if (s(r.ended_at)) view.endedAt = s(r.ended_at);
    if (r.exit_code !== null && r.exit_code !== undefined) view.exitCode = Number(r.exit_code);
    if (meta.usage) view.usage = meta.usage;
    return view;
  }

  loadSessions(limit = 500): SessionView[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map((r) => this.rowToSession(r));
  }

  getSession(id: string): SessionView | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? this.rowToSession(r) : undefined;
  }

  // ---- agents ----

  upsertAgent(v: AgentView): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, session_id, parent_agent_id, provider_agent_id, role, display_name, model, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent_agent_id = excluded.parent_agent_id, role = excluded.role,
           display_name = excluded.display_name, model = excluded.model, status = excluded.status, ended_at = excluded.ended_at`,
      )
      .run(
        v.id,
        v.sessionId,
        nn(v.parentAgentId),
        nn(v.providerAgentId),
        nn(v.role),
        nn(v.displayName),
        nn(v.model),
        v.status,
        v.startedAt,
        nn(v.endedAt),
      );
  }

  loadAgents(sessionId?: string): AgentView[] {
    const rows = (
      sessionId
        ? this.db.prepare("SELECT * FROM agents WHERE session_id = ? ORDER BY started_at").all(sessionId)
        : this.db.prepare("SELECT * FROM agents ORDER BY started_at").all()
    ) as Row[];
    return rows.map((r) => {
      const a: AgentView = {
        id: String(r.id),
        sessionId: String(r.session_id),
        status: r.status as AgentView["status"],
        startedAt: String(r.started_at),
        toolCount: this.agentToolCount(String(r.id)),
        lastEventAt: String(r.ended_at ?? r.started_at),
      };
      if (s(r.parent_agent_id)) a.parentAgentId = s(r.parent_agent_id);
      if (s(r.provider_agent_id)) a.providerAgentId = s(r.provider_agent_id);
      if (s(r.role)) a.role = s(r.role);
      if (s(r.display_name)) a.displayName = s(r.display_name);
      if (s(r.model)) a.model = s(r.model);
      if (s(r.ended_at)) a.endedAt = s(r.ended_at);
      return a;
    });
  }

  private agentToolCount(agentId: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE agent_id = ? AND kind = 'tool.started'")
      .get(agentId) as { c: number };
    return r.c;
  }

  // ---- events ----

  insertEvent(e: AgentEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (id, session_id, agent_id, sequence, occurred_at, received_at, kind, source, confidence, correlation_id, redacted, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.sessionId,
        e.agentId,
        e.sequence,
        e.occurredAt,
        e.receivedAt,
        e.kind,
        e.source,
        e.confidence,
        nn(e.correlationId),
        e.redacted ? 1 : 0,
        JSON.stringify(e.payload),
      );
  }

  private rowToEvent(r: Row, provider?: AgentProvider): AgentEvent {
    const e: AgentEvent = {
      schemaVersion: 1,
      id: String(r.id),
      sequence: Number(r.sequence),
      sessionId: String(r.session_id),
      agentId: String(r.agent_id ?? ""),
      provider: provider ?? (r.provider as AgentProvider),
      kind: r.kind as AgentEvent["kind"],
      occurredAt: String(r.occurred_at),
      receivedAt: String(r.received_at),
      source: r.source as AgentEvent["source"],
      confidence: r.confidence as AgentEvent["confidence"],
      redacted: Number(r.redacted) === 1,
      payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
    };
    if (s(r.correlation_id)) e.correlationId = s(r.correlation_id);
    return e;
  }

  queryEvents(q: EventQuery): AgentEvent[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (q.sessionId) {
      where.push("e.session_id = ?");
      params.push(q.sessionId);
    }
    if (q.afterSequence !== undefined) {
      where.push("e.sequence > ?");
      params.push(q.afterSequence);
    }
    if (q.kinds?.length) {
      where.push(`e.kind IN (${q.kinds.map(() => "?").join(",")})`);
      params.push(...q.kinds);
    }
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000);
    const sql = `SELECT e.*, s.provider AS provider FROM events e JOIN sessions s ON s.id = e.session_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY e.sequence ${q.afterSequence !== undefined ? "ASC" : "DESC"} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Row[];
    const events = rows.map((r) => this.rowToEvent(r));
    return q.afterSequence !== undefined ? events : events.reverse();
  }

  // ---- files ----

  insertFile(row: { id: string; sessionId: string; agentId?: string; path: string; operation: string; occurredAt: string; additions?: number; deletions?: number; source: string; confidence: string }): void {
    this.db
      .prepare(
        `INSERT INTO file_activity (id, session_id, agent_id, path, operation, occurred_at, additions, deletions, source, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.sessionId, nn(row.agentId), row.path, row.operation, row.occurredAt, nn(row.additions), nn(row.deletions), row.source, row.confidence);
  }

  distinctPaths(sessionId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT path FROM file_activity WHERE session_id = ?").all(sessionId) as Array<{ path: string }>).map((r) => r.path);
  }

  distinctFileCount(sessionId: string): number {
    const r = this.db.prepare("SELECT COUNT(DISTINCT path) AS c FROM file_activity WHERE session_id = ?").get(sessionId) as { c: number };
    return r.c;
  }

  /** Was this path written by a high-evidence provider event for this session in the last `windowMs`? */
  recentProviderWrite(sessionId: string, path: string, sinceIso: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 AS x FROM file_activity WHERE session_id = ? AND path = ? AND occurred_at >= ? AND confidence = 'high' AND operation IN ('write','delete') LIMIT 1`,
      )
      .get(sessionId, path, sinceIso);
  }

  queryFiles(opts: { sessionId?: string; limit?: number } = {}): FileSummaryRow[] {
    const params: Array<string | number> = [];
    let where = "";
    if (opts.sessionId) {
      where = "WHERE f.session_id = ?";
      params.push(opts.sessionId);
    }
    const rows = this.db
      .prepare(
        `SELECT f.session_id, f.path, s.provider AS provider, s.cwd AS cwd, s.metadata_json AS meta,
                COALESCE(SUM(f.additions), 0) AS additions, COALESCE(SUM(f.deletions), 0) AS deletions,
                COUNT(*) AS touches, MAX(f.occurred_at) AS last_at
           FROM file_activity f JOIN sessions s ON s.id = f.session_id ${where}
          GROUP BY f.session_id, f.path ORDER BY last_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(opts.limit ?? 500, 2000)) as Row[];
    const latest = this.db.prepare(
      `SELECT f.operation, f.source, f.confidence, a.display_name AS name, a.provider_agent_id AS pid FROM file_activity f
         LEFT JOIN agents a ON a.id = f.agent_id WHERE f.session_id = ? AND f.path = ? ORDER BY f.occurred_at DESC, f.rowid DESC LIMIT 1`,
    );
    return rows.map((r) => {
      const l = latest.get(r.session_id as string, r.path as string) as Row;
      const cwd = s(r.cwd);
      const out: FileSummaryRow = {
        path: String(r.path),
        sessionId: String(r.session_id),
        provider: r.provider as AgentProvider,
        operation: String(l.operation),
        additions: Number(r.additions),
        deletions: Number(r.deletions),
        source: String(l.source),
        confidence: String(l.confidence),
        lastAt: String(r.last_at),
        touches: Number(r.touches),
      };
      if (cwd) out.repo = cwd.split("/").filter(Boolean).pop();
      // Attribution only when the evidence is a provider report; observed changes stay unattributed.
      if (l.confidence === "high") out.agentName = s(l.name) ?? (l.pid ? String(l.pid) : "main");
      return out;
    });
  }

  // ---- commands ----

  insertCommand(c: { id: string; sessionId: string; agentId?: string; toolUseId?: string; pid?: number; ppid?: number; argvDisplay: string; cwd?: string; startedAt: string; source: string; confidence: string; redacted: boolean }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO commands (id, session_id, agent_id, provider_tool_id, pid, ppid, argv_display, cwd, started_at, source, confidence, redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.sessionId, nn(c.agentId), nn(c.toolUseId), nn(c.pid), nn(c.ppid), c.argvDisplay, nn(c.cwd), c.startedAt, c.source, c.confidence, c.redacted ? 1 : 0);
  }

  completeCommand(id: string, endedAt: string, exitCode: number | null | undefined, signal?: string): { existed: boolean; agentId?: string; argvDisplay?: string } {
    const row = this.db.prepare("SELECT agent_id, argv_display FROM commands WHERE id = ?").get(id) as Row | undefined;
    if (!row) return { existed: false };
    this.db.prepare("UPDATE commands SET ended_at = ?, exit_code = ?, signal = ? WHERE id = ?").run(endedAt, nn(exitCode), nn(signal), id);
    const out: { existed: boolean; agentId?: string; argvDisplay?: string } = { existed: true, argvDisplay: String(row.argv_display) };
    if (s(row.agent_id)) out.agentId = s(row.agent_id);
    return out;
  }

  queryCommands(opts: { sessionId?: string; limit?: number } = {}): CommandSummaryRow[] {
    const params: Array<string | number> = [];
    let where = "";
    if (opts.sessionId) {
      where = "WHERE c.session_id = ?";
      params.push(opts.sessionId);
    }
    const rows = this.db
      .prepare(
        `SELECT c.*, s.provider AS provider, s.cwd AS scwd, a.display_name AS agent_name, a.provider_agent_id AS agent_pid FROM commands c
           JOIN sessions s ON s.id = c.session_id LEFT JOIN agents a ON a.id = c.agent_id ${where} ORDER BY c.started_at DESC LIMIT ?`,
      )
      .all(...params, Math.min(opts.limit ?? 500, 2000)) as Row[];
    return rows.map((r) => {
      const out: CommandSummaryRow = {
        id: String(r.id),
        sessionId: String(r.session_id),
        argvDisplay: String(r.argv_display),
        startedAt: String(r.started_at),
        source: String(r.source),
        confidence: String(r.confidence),
        redacted: Number(r.redacted) === 1,
        provider: r.provider as AgentProvider,
      };
      if (s(r.agent_id)) out.agentId = s(r.agent_id);
      if (n(r.pid) !== undefined) out.pid = n(r.pid);
      if (s(r.ended_at)) out.endedAt = s(r.ended_at);
      if (r.exit_code !== null && r.exit_code !== undefined) out.exitCode = Number(r.exit_code);
      if (s(r.signal)) out.signal = s(r.signal);
      const cwd = s(r.scwd);
      if (cwd) out.repo = cwd.split("/").filter(Boolean).pop();
      out.agentName = s(r.agent_name) ?? (r.agent_id ? "main" : undefined);
      return out;
    });
  }

  // ---- usage ----

  insertUsage(u: { id: string; sessionId: string; agentId?: string; occurredAt: string; model?: string; scope: string; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number; source: string }): void {
    this.db
      .prepare(
        `INSERT INTO usage_samples (id, session_id, agent_id, occurred_at, model, scope, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(u.id, u.sessionId, nn(u.agentId), u.occurredAt, nn(u.model), u.scope, nn(u.inputTokens), nn(u.outputTokens), nn(u.cachedInputTokens), nn(u.reasoningTokens), u.source);
  }

  // ---- requests ----

  upsertRequest(r: RequestView): void {
    this.db
      .prepare(
        `INSERT INTO requests (id, session_id, agent_id, provider_request_id, kind, status, summary, created_at, resolved_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, resolved_at = excluded.resolved_at, summary = excluded.summary`,
      )
      .run(r.id, r.sessionId, nn(r.agentId), nn(r.providerRequestId), r.kind, r.status, nn(r.summary), r.createdAt, nn(r.resolvedAt), r.source);
  }

  loadPendingRequests(): RequestView[] {
    const rows = this.db.prepare("SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at").all() as Row[];
    return rows.map((r) => {
      const out: RequestView = {
        id: String(r.id),
        sessionId: String(r.session_id),
        kind: String(r.kind),
        status: "pending",
        createdAt: String(r.created_at),
        source: String(r.source),
      };
      if (s(r.agent_id)) out.agentId = s(r.agent_id);
      if (s(r.provider_request_id)) out.providerRequestId = s(r.provider_request_id);
      if (s(r.summary)) out.summary = s(r.summary);
      return out;
    });
  }

  // ---- settings ----

  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value_json FROM settings").all() as Array<{ key: string; value_json: string }>;
    const stored: Record<string, unknown> = {};
    for (const r of rows) stored[r.key] = JSON.parse(r.value_json);
    return { ...DEFAULT_SETTINGS, ...stored, storePromptText: stored.storePromptText === true, storeAssistantText: stored.storeAssistantText === true, trackTokenUsage: stored.trackTokenUsage !== false, contextWindow: [200_000, 1_000_000, 2_000_000].includes(Number(stored.contextWindow)) ? Number(stored.contextWindow) : 0, keepRawTranscript: false, keepFullPatches: false, redactCredentials: true } as Settings;
  }

  /** Only user-controllable keys are writable. Privacy keys are not stored in this prototype: they are constants. */
  /**
   * Removes the subagents older versions invented: a row whose only trace is one `agent.ended` event, with no name, role,
   * tool or file activity and no duration. Returns how many were removed.
   */
  pruneGhostAgents(): number {
    const ghosts = (this.db
      .prepare(
        `SELECT a.id FROM agents a
         WHERE a.parent_agent_id IS NOT NULL AND a.display_name IS NULL AND a.role IS NULL AND a.model IS NULL AND a.ended_at = a.started_at
           AND (SELECT COUNT(*) FROM events e WHERE e.agent_id = a.id) = 1
           AND (SELECT COUNT(*) FROM events e WHERE e.agent_id = a.id AND e.kind = 'agent.ended') = 1`,
      )
      .all() as Array<{ id: string }>).map((r) => r.id);
    if (ghosts.length === 0) return 0;
    const delEvents = this.db.prepare("DELETE FROM events WHERE agent_id = ? AND kind = 'agent.ended'");
    const delAgent = this.db.prepare("DELETE FROM agents WHERE id = ?");
    this.transaction(() => {
      for (const id of ghosts) {
        delEvents.run(id);
        delAgent.run(id);
      }
    });
    return ghosts.length;
  }

  /** Removes stored chat messages of one role (when the matching setting is turned off). */
  deleteMessages(role: "user" | "assistant"): number {
    const r = this.db.prepare("DELETE FROM events WHERE kind = 'message' AND json_extract(payload_json, '$.role') = ?").run(role);
    return Number(r.changes);
  }

  /** Message ids already stored for a session, so re-reading a conversation file never duplicates a message. */
  messageIds(sessionId: string): Set<string> {
    const rows = this.db.prepare("SELECT correlation_id AS c FROM events WHERE session_id = ? AND kind = 'message' AND correlation_id IS NOT NULL").all(sessionId) as Array<{ c: string }>;
    return new Set(rows.map((r) => r.c));
  }

  setSettings(patch: Record<string, unknown>): Settings {
    const writable = new Set(["retentionDays", "startAtLogin", "claudeIntegration", "codexIntegration", "geminiIntegration", "antigravityIntegration", "cursorIntegration", "cliInstalled", "storePromptText", "storeAssistantText", "trackTokenUsage", "contextWindow"]);
    const stmt = this.db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json");
    for (const [k, v] of Object.entries(patch)) {
      if (!writable.has(k)) continue;
      if (k === "retentionDays" && ![0, 7, 14, 30].includes(Number(v))) continue;
      if (k === "contextWindow" && ![0, 200_000, 1_000_000, 2_000_000].includes(Number(v))) continue;
      if (k !== "retentionDays" && k !== "contextWindow" && typeof v !== "boolean") continue;
      stmt.run(k, JSON.stringify(k === "retentionDays" || k === "contextWindow" ? Number(v) : v));
    }
    return this.getSettings();
  }

  // ---- deletion & retention ----

  deleteSession(id: string): boolean {
    const r = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return Number(r.changes) > 0;
  }

  /** Delete finished sessions that ended before the cutoff. retentionDays 0 = keep nothing once ended. */
  purgeOlderThan(cutoffIso: string): string[] {
    const ids = (this.db.prepare("SELECT id FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?").all(cutoffIso) as Array<{ id: string }>).map((r) => r.id);
    if (ids.length) {
      const del = this.db.prepare("DELETE FROM sessions WHERE id = ?");
      this.transaction(() => ids.forEach((id) => del.run(id)));
    }
    return ids;
  }

  /** Close handles, delete the DB and WAL/SHM files, start a fresh database. */
  wipe(): void {
    if (this.dbPath === ":memory:") {
      this.db.exec("DELETE FROM sessions; DELETE FROM settings;");
      return;
    }
    const settings = this.getSettings();
    destroyDatabase(this.db, this.dbPath);
    this.db = openDatabase(this.dbPath);
    this.seq = 0;
    this.setSettings({
      retentionDays: settings.retentionDays,
      startAtLogin: settings.startAtLogin,
      claudeIntegration: settings.claudeIntegration,
      codexIntegration: settings.codexIntegration,
      geminiIntegration: settings.geminiIntegration,
      antigravityIntegration: settings.antigravityIntegration,
      cursorIntegration: settings.cursorIntegration,
      cliInstalled: settings.cliInstalled,
    });
  }

  counts(): { sessions: number; events: number } {
    const a = this.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
    const b = this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    return { sessions: a.c, events: b.c };
  }

  close(): void {
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    this.db.close();
  }
}
