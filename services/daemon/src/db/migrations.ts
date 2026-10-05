export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Schema from the plan, plus a settings table. The daemon is the only writer. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE sessions (
    id                  TEXT PRIMARY KEY,
    provider            TEXT NOT NULL,
    provider_session_id TEXT,
    adapter_version     TEXT NOT NULL,
    executable          TEXT,
    model               TEXT,
    cwd                 TEXT,
    repo_root           TEXT,
    status              TEXT NOT NULL,
    started_at          TEXT NOT NULL,
    ended_at            TEXT,
    exit_code           INTEGER,
    privacy_mode        TEXT NOT NULL,
    metadata_json       TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_sessions_provider_sid ON sessions(provider, provider_session_id)
    WHERE provider_session_id IS NOT NULL;

CREATE TABLE agents (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
    provider_agent_id TEXT,
    role              TEXT,
    display_name      TEXT,
    model             TEXT,
    status            TEXT NOT NULL,
    started_at        TEXT NOT NULL,
    ended_at          TEXT
);
CREATE INDEX idx_agents_session ON agents(session_id);

CREATE TABLE events (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id       TEXT REFERENCES agents(id) ON DELETE SET NULL,
    sequence       INTEGER NOT NULL,
    occurred_at    TEXT NOT NULL,
    received_at    TEXT NOT NULL,
    kind           TEXT NOT NULL,
    source         TEXT NOT NULL,
    confidence     TEXT NOT NULL,
    correlation_id TEXT,
    redacted       INTEGER NOT NULL DEFAULT 0,
    payload_json   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_events_session_sequence ON events(session_id, sequence);
CREATE INDEX idx_events_sequence ON events(sequence);
CREATE INDEX idx_events_kind_time ON events(kind, occurred_at);

CREATE TABLE commands (
    id               TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id         TEXT REFERENCES agents(id) ON DELETE SET NULL,
    provider_tool_id TEXT,
    pid              INTEGER,
    ppid             INTEGER,
    argv_display     TEXT NOT NULL,
    cwd              TEXT,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    exit_code        INTEGER,
    signal           TEXT,
    source           TEXT NOT NULL,
    confidence       TEXT NOT NULL,
    redacted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_commands_session ON commands(session_id);

CREATE TABLE file_activity (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
    path        TEXT NOT NULL,
    operation   TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    additions   INTEGER,
    deletions   INTEGER,
    source      TEXT NOT NULL,
    confidence  TEXT NOT NULL
);
CREATE INDEX idx_file_activity_session_path ON file_activity(session_id, path);

CREATE TABLE usage_samples (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id            TEXT REFERENCES agents(id) ON DELETE SET NULL,
    occurred_at         TEXT NOT NULL,
    model               TEXT,
    scope               TEXT NOT NULL,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    cached_input_tokens INTEGER,
    reasoning_tokens    INTEGER,
    source              TEXT NOT NULL
);

CREATE TABLE requests (
    id                  TEXT PRIMARY KEY,
    session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id            TEXT REFERENCES agents(id) ON DELETE SET NULL,
    provider_request_id TEXT,
    kind                TEXT NOT NULL,
    status              TEXT NOT NULL,
    summary             TEXT,
    created_at          TEXT NOT NULL,
    resolved_at         TEXT,
    source              TEXT NOT NULL
);
CREATE INDEX idx_requests_session ON requests(session_id, status);

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);
`,
  },
];
