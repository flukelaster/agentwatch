import { useEffect, useMemo, useRef, useState } from "react";
import { AgentGraph } from "../components/AgentGraph";
import { UiIcon } from "../components/icons";
import { ContextMeter } from "../components/ContextMeter";
import { SessionSwitcher, groupSessions, type Group } from "../components/SessionSwitcher";
import { SetupBanner } from "../components/Setup";
import { Chips, Conf, Dot, DiffStat, Empty, EmptyState, Panel, Radar } from "../components/ui";
import { describeEvents, duration, isTicking, sessionElapsedMs, usageDetail, usageSummary, providerLabel } from "../lib/format";
import { useLive, useQuery } from "../lib/context";
import { agentsOf, sessionList } from "../lib/store";
import type { SessionView } from "@agentwatch/protocol";

const STATUS_TEXT: Record<string, string> = { running: "Running", waiting: "Needs you", idle: "Idle", finished: "Finished", failed: "Failed" };

/** How young a running session must be to count as just spawned. */
const JUMP_WINDOW_MS = 30_000;

export function statusLine(s: SessionView): string {
  return s.status === "running" && s.activity ? s.activity : STATUS_TEXT[s.status] ?? s.status;
}

export function Overview() {
  const live = useLive();
  const sessions = sessionList(live);
  const settingsQ = useQuery<{ trackTokenUsage?: boolean }>("settings", undefined, { live: false });
  const [sel, setSel] = useState<string | undefined>(undefined);
  const [highOnly, setHighOnly] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // The page opens on Running and shows only what belongs to the tab: an empty tab is an empty state, not another session's graph.
  const [tab, setTab] = useState<Group>("running");
  const inTab = useMemo(() => groupSessions(sessions)[tab], [sessions, tab]);
  const selected = useMemo(() => inTab.find((s) => s.id === sel) ?? inTab[0], [inTab, sel]);

  // A session that has just started running takes the page: the Running tab, that session. Once per session, so it
  // never fights the person afterwards, and only for a young one, so opening the app does not jump to an old session.
  const jumped = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = [...live.sessions.values()]
      .filter((s) => s.status === "running" && !s.endedAt && !jumped.current.has(s.id) && Date.now() - Date.parse(s.startedAt) < JUMP_WINDOW_MS)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const s of fresh) jumped.current.add(s.id);
    if (fresh[0]) {
      setTab("running");
      setSel(fresh[0].id);
    }
  }, [live.sessions]);

  const anyLive = sessions.some(isTicking);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLive]);

  if (sessions.length === 0) {
    return (
      <>
      <SetupBanner />
      <Panel title="No sessions yet">
        <div className="callout">
          <Radar icon="inbox" size={120} />
          <h2>Nothing is running</h2>
          <p>AgentWatch shows agents it can see. Start one under monitoring, or enable provider hooks so ordinary Claude Code, Codex, Gemini CLI and Cursor sessions appear here by themselves.</p>
          <code className="code">{"agentwatch claude\nagentwatch codex\nagentwatch gemini\nagentwatch run -- <your-agent>"}</code>
          <p className="faint">Command not found? Inside the AgentWatch project folder run <span className="mono">pnpm agentwatch install-cli --apply</span> once, or prefix any command with <span className="mono">pnpm</span> (for example <span className="mono">pnpm agentwatch claude</span>). To see the screen working without an agent, run <span className="mono">pnpm demo</span>.</p>
        </div>
      </Panel>
      </>
    );
  }

  if (!selected) {
    return (
      <>
        <SetupBanner />
        <section aria-label="Session">
          <SessionSwitcher sessions={sessions} selectedId={undefined} onSelect={setSel} now={now} tab={tab} onTab={setTab} emptyHero />
        </section>
      </>
    );
  }

  const agents = agentsOf(live, selected.id);
  const events = live.events.get(selected.id) ?? [];
  const rows = describeEvents(events, live.agents).filter((r) => !highOnly || r.conf === "high").slice(-12);
  const elapsed = duration(sessionElapsedMs(selected, now));
  const meta = [selected.model ?? providerLabel[selected.provider], selected.branch, selected.sources.filter((s) => s !== "transcript").join(" · ")].filter(Boolean).join("  ·  ");

  return (
    <>
      <SetupBanner />
      <section aria-label="Session" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <SessionSwitcher sessions={sessions} selectedId={selected.id} onSelect={setSel} now={now} tab={tab} onTab={setTab} />
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "12px 40px" }}>
          <div className="stats">
            <div className="stat"><span className="label">Elapsed</span><b>{elapsed}</b></div>
            <div className="stat" title={usageDetail(selected)}><span className="label">Tokens</span><b>{usageSummary(selected, settingsQ.data ? settingsQ.data.trackTokenUsage !== false : undefined)}</b>{usageDetail(selected) && <span className="stat__sub">{usageDetail(selected)}</span>}</div>
            <ContextMeter session={selected} tracking={settingsQ.data ? settingsQ.data.trackTokenUsage !== false : undefined} />
            <div className="stat"><span className="label">Files</span><b>{selected.counts.files}</b></div>
            <div className="stat"><span className="label">Diff</span><b><DiffStat diff={selected.diff} /></b></div>
          </div>
          <div className="mono muted" style={{ fontSize: 12, lineHeight: 1.5, flex: "1 1 240px", minWidth: 0 }}>{meta}</div>
        </div>
      </section>

      <AgentGraph session={selected} agents={agents} events={events} />

      <Panel
        title="Session log"
        right={
          <button type="button" className="chip" aria-pressed={highOnly} onClick={() => setHighOnly((v) => !v)}>
            High confidence only
          </button>
        }
        foot="High is a provider hook or API, Med is the process tree, and Low is filesystem, Git or terminal text. AgentWatch shows what is known and does not guess intent."
      >
        <div className="tablewrap">
          <div className="table" style={{ ["--cols" as string]: "84px 104px 64px minmax(0,1fr) 128px 150px", ["--min" as string]: "760px" }}>
            <div className="tr tr--head">
              <span>Time</span><span>Agent</span><span>Kind</span><span>Detail</span><span>Confidence</span><span>Source</span>
            </div>
            <div style={{ minHeight: 300 }}>
              {rows.length === 0 && <EmptyState icon="activity" title="No events yet for this session" hint="Events appear as soon as the agent does something: a tool call, a command, a file change." compact />}
              {rows.map((r, i) => (
                <div key={r.id} className={`tr${r.tone === "fail" ? " tr--fail" : r.tone === "ask" ? " tr--ask" : i === rows.length - 1 ? " tr--new" : ""}`}>
                  <span className="cell-mono muted">{r.time}</span>
                  <span className="cell-mono" style={{ color: r.unattributed ? "var(--faint)" : undefined }}>{r.agent}</span>
                  <span className={r.tone === "fail" ? "tone-fail" : r.tone === "ask" ? "tone-ask" : "muted"} style={{ fontWeight: 500 }}>{r.kind}</span>
                  <span className="cell-mono cell-ellipsis" title={r.text}>{r.text}</span>
                  <Conf level={r.conf} />
                  <span className="cell-mono muted">{r.source}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Panel>
    </>
  );
}

export { Chips, Dot };
