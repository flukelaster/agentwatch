import { useEffect, useState, type MouseEvent } from "react";
import type { SessionView } from "@agentwatch/protocol";
import { Dot, Logo } from "../components/ui";
import { useLive } from "../lib/context";
import { ProviderIcon, UiIcon } from "../components/icons";
import { duration, providerLabel, sessionTitle, sessionLength } from "../lib/format";
import { openDashboard } from "../lib/native";
import { pendingRequests, runningCount, sessionList } from "../lib/store";
import "../styles/menubar.css";

const PROVIDER_COLOR: Record<string, string> = { "claude-code": "var(--g-ed)", codex: "var(--g-c8)", generic: "var(--g-99)" };
const STATUS_TEXT: Record<string, string> = { running: "Running", waiting: "Needs you", idle: "Idle", finished: "Finished", failed: "Failed" };
const STATUS_TONE: Record<string, string> = { running: "tone-run", finished: "tone-done", waiting: "tone-ask", failed: "tone-fail" };

/** Open a route in the main dashboard window instead of navigating this popover. */
const open = (path: string) => (e: MouseEvent) => {
  e.preventDefault();
  void openDashboard(path);
};

function Row({ s, now }: { s: SessionView; now: number }) {
  const failed = s.counts.failedCommands;
  return (
    <a className="mb__row" href={`#/sessions/${s.id}`} onClick={open(`/sessions/${s.id}`)}>
      <span className="mb__row-top">
        <span className="mb__repo">
          <ProviderIcon provider={s.provider} size={13} className="mb__pbrand" />
          {sessionTitle(s)}
          {failed > 0 && <span className="mb__fail">✕ {failed} failed</span>}
        </span>
        <span className="mb__elapsed">{sessionLength(s, now)}</span>
      </span>
      <span className="mb__row-bot">
        <span className="mb__act">{s.activity ?? "no activity reported"}</span>
        <span className={`mb__status ${STATUS_TONE[s.status] ?? "tone-muted"}`}>{STATUS_TEXT[s.status] ?? s.status}</span>
      </span>
    </a>
  );
}

export function MenuBar() {
  const live = useLive();
  const [now, setNow] = useState(() => Date.now());
  const active = sessionList(live).filter((s) => !s.endedAt);
  const need = pendingRequests(live)[0];
  const needSession = need ? live.sessions.get(need.sessionId) : undefined;
  const running = runningCount(live);

  useEffect(() => {
    if (!active.length && !need) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active.length, need]);

  return (
    <div className="mb">
      <div className="mb__card">
        <header className="mb__head">
          <span className="mb__brand">
            <Logo size={18} />
            <span className="brand__name">AGENTWATCH</span>
          </span>
          <span className="mb__count">
            <Dot tone="run" />
            {running} running
          </span>
        </header>

        {need && (
          <section className="mb__need" aria-label="Needs you">
            <div className="mb__need-top">
              <span className="mb__need-title">Needs you</span>
              <span className="mb__need-wait">waiting {duration(now - Date.parse(need.createdAt))}</span>
            </div>
            <div className="mb__need-who">
              <span className="mb__pdot" style={{ background: PROVIDER_COLOR[needSession?.provider ?? ""] ?? "var(--g-99)" }} />
              {needSession ? sessionTitle(needSession) : need.sessionId.slice(0, 8)}
              {needSession && <small>{providerLabel[needSession.provider] ?? needSession.provider}</small>}
            </div>
            <code className="code">{need.summary ?? "request details not reported"}</code>
            <a className="mb__link" href={`#/sessions/${need.sessionId}`} onClick={open(`/sessions/${need.sessionId}`)}>
              Open session
            </a>
          </section>
        )}

        <section className="mb__list" aria-label="Sessions">
          {active.length > 0 ? (
            <>
              <div className="mb__list-title">Sessions</div>
              {active.map((s) => (
                <Row key={s.id} s={s} now={now} />
              ))}
            </>
          ) : (
            <div className="mb__empty">
              <UiIcon name="inbox" size={20} />
              <h2>Nothing is running</h2>
              <span>{live.status === "disconnected" ? "AgentWatch cannot reach agentwatchd right now. It keeps retrying." : "Agents show up here while they work. Start one under monitoring, or turn on hooks in Settings."}</span>
            </div>
          )}
        </section>

        <footer className="mb__foot">
          <button type="button" className="mb__primary" onClick={() => void openDashboard("/")}>
            Open dashboard
          </button>
          <div className="mb__meta">
            <span>local only · no telemetry</span>
            <a href="#/settings" onClick={open("/settings")}>
              Settings
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
