import { useEffect, useMemo, useState } from "react";
import type { RequestView } from "@agentwatch/protocol";
import { Chips, Conf, Empty, EmptyState, PageHead, Panel } from "../components/ui";
import { clock, duration } from "../lib/format";
import { useLive, useQuery } from "../lib/context";
import { pendingRequests } from "../lib/store";
import type { CommandRowView } from "../lib/types";
import "../styles/commands.css";

type CommandFilter = "all" | "run" | "ask" | "fail";
type Kind = "run" | "ask" | "fail" | "ok" | "unknown";

const PROVIDER_COLOR: Record<string, string> = { "claude-code": "var(--g-ed)", codex: "var(--g-c8)", generic: "var(--g-99)" };
const COLUMNS = "76px minmax(0,1.6fr) 96px 108px 84px 130px 150px";

const hasCode = (r: CommandRowView): r is CommandRowView & { exitCode: number } => typeof r.exitCode === "number";

/** A command waits on you when its session has a pending approval whose summary is exactly the command text. */
export function isAwaiting(r: CommandRowView, requests: readonly RequestView[]): boolean {
  if (hasCode(r) || r.endedAt) return false;
  return requests.some((q) => q.status === "pending" && q.sessionId === r.sessionId && q.summary === r.argvDisplay);
}

export function kindOf(r: CommandRowView, requests: readonly RequestView[]): Kind {
  if (hasCode(r)) return r.exitCode === 0 ? "ok" : "fail";
  if (isAwaiting(r, requests)) return "ask";
  if (r.endedAt) return "unknown"; // seen gone (process sampling) but the exit code was never reported
  return "run";
}

function timeText(r: CommandRowView, kind: Kind, now: number): string {
  if (kind === "ask") return "—";
  const start = Date.parse(r.startedAt);
  if (kind === "run") return duration(now - start);
  if (!r.endedAt) return "—";
  const ms = Date.parse(r.endedAt) - start;
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : duration(ms);
}

function Result({ r, kind }: { r: CommandRowView; kind: Kind }) {
  if (kind === "run") return <span className="cm-result tone-run">● running</span>;
  if (kind === "ask") return <span className="cm-result tone-ask">! awaiting you</span>;
  if (kind === "fail")
    return (
      <span className="cm-result tone-fail">
        <span aria-hidden="true">✕ </span>exit {r.exitCode}
      </span>
    );
  if (kind === "ok") return <span className="cm-result tone-muted">exit 0</span>;
  return <span className="cm-result tone-muted">{r.signal ? `signal ${r.signal}` : "exit —"}</span>;
}

export function Commands() {
  const live = useLive();
  const q = useQuery<CommandRowView[]>("commands");
  const [filter, setFilter] = useState<CommandFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const requests = pendingRequests(live);

  const rows = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((r) => ({ r, kind: kindOf(r, requests) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.data, live.requests],
  );
  const count = (f: CommandFilter) => (f === "all" ? rows.length : rows.filter((x) => x.kind === f).length);
  const shown = rows.filter((x) => filter === "all" || x.kind === filter);
  const anyRunning = rows.some((x) => x.kind === "run");

  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  let body;
  if (q.error && !q.data) {
    body = (
      <div className="callout" role="alert">
        <h2>Could not load commands</h2>
        <p>{q.error}</p>
        <button type="button" className="btn" onClick={q.refresh}>Try again</button>
      </div>
    );
  } else if (!q.data) {
    body = <Empty>{q.loading ? "Loading commands…" : "Command history is unavailable until agentwatchd is connected."}</Empty>;
  } else {
    body = (
      <div className="tablewrap">
        <div className="table" style={{ ["--cols" as string]: COLUMNS, ["--min" as string]: "990px" }}>
          <div className="tr tr--head">
            <span>Started</span><span>Command</span><span>Agent</span><span>Session</span><span>Time</span><span>Result</span><span>Evidence</span>
          </div>
          {shown.length === 0 && (rows.length === 0 ? <EmptyState icon="terminal" title="No commands yet" hint="Shell commands an agent runs are listed here, with the exit code and how long they took." /> : <EmptyState icon="search" title="No commands match this filter" hint="Try another status or clear the search." compact />)}
          {shown.map(({ r, kind }) => (
            <div key={`${r.sessionId}:${r.id}`} className={`tr tr--tall${kind === "fail" ? " tr--fail" : kind === "ask" ? " tr--ask" : ""}`} data-kind={kind}>
              <span className="cell-mono muted" title={r.startedAt}>{clock(r.startedAt)}</span>
              <span className="cm-cmd">
                <code className="cm-cmd__text" title={r.argvDisplay}>{r.argvDisplay}</code>
                {r.redacted && <span className="cm-tag">Redacted before storage</span>}
              </span>
              <span className={`cm-agent${r.agentName ? "" : " cm-agent--none"}`} style={r.agentName ? { color: PROVIDER_COLOR[r.provider] } : undefined}>{r.agentName ?? "unknown"}</span>
              <span className="cm-session" style={{ color: PROVIDER_COLOR[r.provider] }} title={r.repo ?? r.sessionId}>{r.repo ?? r.sessionId.slice(0, 8)}</span>
              <span className="cm-time">{timeText(r, kind, now)}</span>
              <Result r={r} kind={kind} />
              <span className="cm-evid">
                <Conf level={r.confidence} />
                <span className="cm-src">{r.source}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHead title="Commands" sub="Shell commands run by agents, newest first.">
        <Chips
          label="Filter commands"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: count("all") },
            { value: "run", label: "Running", count: count("run") },
            { value: "ask", label: "Awaiting you", count: count("ask") },
            { value: "fail", label: "Failed", count: count("fail") },
          ]}
        />
      </PageHead>
      <Panel label="Command history" foot="Command lines are redacted before they are stored. A command found only in the process tree is MED, and one that finishes between samples can be missed.">
        {body}
      </Panel>
    </>
  );
}
