import { useMemo, useState, type CSSProperties } from "react";
import type { AgentEvent, AgentView } from "@agentwatch/protocol";
import { Chips, Conf, Empty, EmptyState, PageHead, Panel } from "../components/ui";
import { useDaemon, useLive, useQuery } from "../lib/context";
import { clock, describeEvent, sessionTitle } from "../lib/format";
import { saveTextFile } from "../lib/native";
import type { DiagnosticRow, LogsResult } from "../lib/types";
import "../styles/logs.css";

type Tab = "events" | "diag";
type SourceFilter = "all" | "hook" | "pty" | "filesystem" | "git" | "process";

const SOURCE_GROUP: Record<string, SourceFilter> = {
  "claude-hook": "hook",
  "codex-hook": "hook",
  "codex-app-server": "hook",
  "gemini-hook": "hook",
  "antigravity-hook": "hook",
  "cursor-hook": "hook",
  pty: "pty",
  filesystem: "filesystem",
  git: "git",
  process: "process",
};
const SOURCE_OPTIONS: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "hook", label: "Hooks and API" },
  { value: "pty", label: "PTY" },
  { value: "filesystem", label: "Filesystem" },
  { value: "git", label: "Git" },
  { value: "process", label: "Process" },
];
const PROVIDER_COLOR: Record<string, string> = { "claude-code": "var(--g-ed)", codex: "var(--g-c8)", generic: "var(--g-99)" };
const MAX_ROWS = 300;

/** One-line payload summary. Never dumps the raw payload: only fields that are already display-safe. */
export function payloadText(e: AgentEvent, agents: ReadonlyMap<string, AgentView>): string {
  const described = describeEvent(e, agents)?.text;
  if (described) return described;
  const p = e.payload;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  const parts = [str("toolName"), str("argvDisplay"), str("path"), str("message"), str("summary")].filter((x): x is string => !!x);
  if (typeof p.exitCode === "number") parts.push(`exit ${p.exitCode}`);
  if (typeof p.durationMs === "number") parts.push(`${(p.durationMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

/** The JSON the "Export redacted bundle" button writes: daemon diagnostics plus event counts, no payloads. */
export function buildDiagnosticsBundle(diagnostics: DiagnosticRow[], events: readonly AgentEvent[], daemonVersion?: string): string {
  const byKind: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  }
  return JSON.stringify({ kind: "agentwatch-diagnostics", exportedAt: new Date().toISOString(), daemonVersion: daemonVersion ?? "unknown", note: "Redacted: daemon diagnostics lines and event counts only. No prompts, transcripts, file contents or event payloads.", diagnostics, eventCounts: { total: events.length, byKind, bySource } }, null, 2);
}

export function exportFilename(): string {
  return `agentwatch-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}

export function Logs() {
  const live = useLive();
  const { data, error, loading } = useQuery<LogsResult>("logs");
  const [tab, setTab] = useState<Tab>("events");
  const [source, setSource] = useState<SourceFilter>("all");

  const all = useMemo(() => {
    const byId = new Map<string, AgentEvent>();
    for (const list of live.events.values()) for (const e of list) byId.set(e.id, e);
    for (const e of data?.events ?? []) byId.set(e.id, e); // the daemon's copy wins
    return [...byId.values()].sort((a, b) => b.sequence - a.sequence);
  }, [live.events, data]);

  const rows = useMemo(() => all.filter((e) => source === "all" || SOURCE_GROUP[e.source] === source).slice(0, MAX_ROWS), [all, source]);
  const diagnostics = data?.diagnostics ?? [];

  return (
    <>
      <PageHead title="Logs" sub="The normalized event stream, and the daemon's own sanitized diagnostics.">
        <Chips<Tab>
          label="Log type"
          value={tab}
          onChange={setTab}
          options={[
            { value: "events", label: "Events" },
            { value: "diag", label: "Diagnostics" },
          ]}
        />
      </PageHead>

      {tab === "events" ? (
        <Panel
          label="Event log"
          foot="Order is the daemon sequence number, not the clock, because provider, file and process events can arrive out of order."
        >
          <div className="logs-bar">
            <span className="logs-bar__title">AgentEvent v1, ordered by sequence</span>
            <Chips<SourceFilter> label="Filter by source" value={source} onChange={setSource} options={SOURCE_OPTIONS} />
          </div>
          <div className="tablewrap">
            <div className="table" style={{ "--cols": "56px 76px 108px 168px minmax(0, 1fr) 150px 116px", "--min": "980px" } as CSSProperties} role="table" aria-label="Events">
              <div className="tr tr--head" role="row">
                <span role="columnheader">Seq</span>
                <span role="columnheader">Time</span>
                <span role="columnheader">Session</span>
                <span role="columnheader">Kind</span>
                <span role="columnheader">Payload</span>
                <span role="columnheader">Source</span>
                <span role="columnheader">Confidence</span>
              </div>
              {rows.map((e) => {
                const s = live.sessions.get(e.sessionId);
                const cls = e.kind === "tool.failed" || (e.kind === "command.completed" && typeof e.payload.exitCode === "number" && e.payload.exitCode !== 0) ? " tr--fail" : e.kind === "approval.requested" ? " tr--ask" : "";
                const kindTone = cls === " tr--fail" ? "tone-fail" : cls === " tr--ask" ? "tone-ask" : "";
                return (
                  <div className={`tr${cls}`} role="row" key={e.id} data-testid="event-row">
                    <span role="cell" className="cell-mono faint">{e.sequence}</span>
                    <span role="cell" className="cell-mono muted">{clock(e.occurredAt)}</span>
                    <span role="cell" className="log-session" style={{ color: PROVIDER_COLOR[e.provider] ?? "var(--text)" }}>{s ? sessionTitle(s) : e.sessionId.slice(0, 8)}</span>
                    <span role="cell" className={`log-kind ${kindTone}`}>{e.kind}</span>
                    <span role="cell" className="log-payload">
                      <span>{payloadText(e, live.agents)}</span>
                      {e.redacted && <span className="tag">Redacted</span>}
                    </span>
                    <span role="cell" className="cell-mono muted">{e.source}</span>
                    <span role="cell">
                      <Conf level={e.confidence} />
                    </span>
                  </div>
                );
              })}
            </div>
            {rows.length === 0 && (loading || (error && all.length === 0) ? <Empty>{loading ? "Loading events…" : `Could not load events: ${error}`}</Empty> : all.length === 0 ? <EmptyState icon="scroll-text" title="No events recorded yet" hint="Every hook, command, file change and git change an agent produces is logged here, newest last." /> : <EmptyState icon="search" title="No events from this source" hint="Choose another source." compact />)}
          </div>
        </Panel>
      ) : (
        <Panel label="Diagnostics log" foot="The export is written to a file on this Mac. Nothing is uploaded.">
          <div className="logs-bar">
            <span className="logs-bar__title">agentwatchd, sanitized</span>
            <button type="button" className="btn" onClick={() => saveTextFile(exportFilename(), buildDiagnosticsBundle(diagnostics, all, live.daemonVersion))}>
              Export redacted bundle
            </button>
          </div>
          <div className="tablewrap">
            <div className="table" style={{ "--cols": "76px 56px 132px minmax(0, 1fr)", "--min": "640px" } as CSSProperties} role="table" aria-label="Diagnostics">
              {diagnostics.map((d, i) => (
                <div className={`tr tr--diag${d.level === "ERROR" ? " tr--fail" : d.level === "WARN" ? " tr--ask" : ""}`} role="row" key={`${d.t}-${i}`} data-testid="diag-row">
                  <span role="cell" className="cell-mono muted">{clock(d.t)}</span>
                  <span role="cell" className={`diag-level ${d.level === "ERROR" ? "tone-fail" : d.level === "WARN" ? "tone-ask" : ""}`}>{d.level}</span>
                  <span role="cell" className="diag-where">{d.where}</span>
                  <span role="cell" className="diag-msg">{d.msg}</span>
                </div>
              ))}
            </div>
            {diagnostics.length === 0 && <Empty>{loading ? "Loading diagnostics…" : error ? `Could not load diagnostics: ${error}` : "No diagnostics lines yet."}</Empty>}
          </div>
        </Panel>
      )}
    </>
  );
}
