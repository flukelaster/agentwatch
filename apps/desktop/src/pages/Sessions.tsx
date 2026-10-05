import { useEffect, useState } from "react";
import { ProviderIcon } from "../components/icons";
import type { SessionView, Settings } from "@agentwatch/protocol";
import { Chips, DiffStat, Empty, EmptyState, Panel, PageHead, type ChipOption } from "../components/ui";
import { useDaemon, useLive, useQuery } from "../lib/context";
import { dayClock, providerLabel, sessionTitle, sessionLength, usageSummary } from "../lib/format";
import { href } from "../lib/router";
import { sessionList } from "../lib/store";
import "../styles/sessions.css";

export const STATUS_TEXT: Record<string, string> = { running: "Running", waiting: "Needs you", idle: "Idle", finished: "Finished", failed: "Failed" };
export const STATUS_TONE: Record<string, string> = { running: "tone-run", finished: "tone-done", waiting: "tone-ask", failed: "tone-fail" };
export const PROVIDER_COLOR: Record<string, string> = { "claude-code": "var(--g-ed)", codex: "var(--g-c8)", generic: "var(--g-99)" };

type Filter = "all" | "active" | "ask" | "finished" | "failed";

const matches = (s: SessionView, f: Filter): boolean => {
  switch (f) {
    case "all":
      return true;
    case "ask":
      return s.status === "waiting";
    case "finished":
      return s.status === "finished";
    case "failed":
      return s.status === "failed";
    case "active":
      return s.status === "running" || s.status === "waiting" || s.status === "idle";
  }
};

export const canDelete = (s: SessionView): boolean => s.status === "finished" || s.status === "failed";

function statusText(s: SessionView): string {
  return s.status === "running" && s.activity ? s.activity : STATUS_TEXT[s.status] ?? s.status;
}

const TRASH = "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5";

export function Sessions() {
  const live = useLive();
  const { client } = useDaemon();
  const settings = useQuery<Settings>("settings", undefined, { live: false });
  const sessions = sessionList(live);
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState("");

  const anyOpen = sessions.some((s) => !s.endedAt);
  useEffect(() => {
    if (!anyOpen) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyOpen]);

  const retention = settings.data?.retentionDays;
  const sub =
    retention === undefined ? "Running now and kept locally." : retention === 0 ? "Running now. History is cleared when a session ends." : `Running now and kept locally for ${retention} days.`;

  const defs: Array<[Filter, string]> = [
    ["all", "All"],
    ["active", "Active"],
    ["ask", "Needs you"],
    ["finished", "Finished"],
    ["failed", "Failed"],
  ];
  const options: ChipOption<Filter>[] = defs.map(([value, label]) => ({ value, label, count: sessions.filter((s) => matches(s, value)).length }));

  const rows = sessions.filter((s) => matches(s, filter));

  async function remove(s: SessionView) {
    if (!canDelete(s)) return;
    setError(undefined);
    setBusy((b) => new Set(b).add(s.id));
    try {
      await client.command("deleteSession", { sessionId: s.id });
      setNotice(`Deleted session ${sessionTitle(s)}.`);
    } catch (e) {
      setError(`Could not delete ${sessionTitle(s)}: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(s.id);
        return n;
      });
    }
  }

  return (
    <>
      <PageHead title="Sessions" sub={sub}>
        <Chips label="Filter sessions" value={filter} onChange={setFilter} options={options} />
      </PageHead>

      <Panel
        label="Session list"
        foot="Deleting a session removes its events, files and commands from this Mac. Running sessions cannot be deleted. Tokens appear only when the provider reports them."
      >
        <div className="tablewrap">
          <div className="table" style={{ ["--cols" as string]: "112px minmax(0,1fr) 128px 108px 84px 56px 92px 56px 108px 64px", ["--min" as string]: "980px" }}>
            <div className="tr tr--head">
              <span>Provider</span>
              <span>Session</span>
              <span>Status</span>
              <span>Started</span>
              <span>Length</span>
              <span>Files</span>
              <span>+ / −</span>
              <span>Cmds</span>
              <span>Tokens</span>
              <span />
            </div>
            {rows.length === 0 && (sessions.length === 0 ? <EmptyState visual="radar" icon="inbox" title="No sessions yet" hint="Open a new agent session, or run one with agentwatch run. It shows up here by itself." action={{ label: "Check the connections", href: "#/settings" }} /> : <EmptyState icon="search" title="No sessions match this filter" hint="Try another status or provider." compact />)}
            {rows.map((s) => {
              const tokensText = usageSummary(s);
              const reported = s.usage?.providerReported === true;
              const started = dayClock(s.startedAt);
              const text = statusText(s);
              return (
                <div key={s.id} className={`tr tr--tall${s.status === "waiting" ? " tr--ask" : ""}`}>
                  <span className="ss-provider" style={{ color: PROVIDER_COLOR[s.provider] }}>
                    <ProviderIcon provider={s.provider} size={14} />
                    {providerLabel[s.provider] ?? s.provider}
                  </span>
                  <span className="ss-two">
                    <a className="ss-repo" href={href(`/sessions/${encodeURIComponent(s.id)}`)}>
                      {sessionTitle(s)}
                    </a>
                    <span className="ss-branch" title={s.branch}>
                      {s.branch ?? "no Git branch"}
                    </span>
                  </span>
                  <span className={`ss-label cell-ellipsis ${STATUS_TONE[s.status] ?? "tone-muted"}`} title={text}>
                    {text}
                  </span>
                  <span className="cell-mono muted">{started}</span>
                  <span className="ss-num">{sessionLength(s, now)}</span>
                  <span className="ss-num">{s.counts.files}</span>
                  <span className="ss-num"><DiffStat diff={s.diff} /></span>
                  <span className="ss-num">{s.counts.commands}</span>
                  <span className="ss-num" style={{ color: reported ? "var(--text)" : "var(--faint)" }}>
                    {tokensText}
                  </span>
                  <span>
                    {canDelete(s) && (
                      <button type="button" className="iconbtn ss-del" aria-label={`Delete session ${sessionTitle(s)} from ${started}`} disabled={busy.has(s.id)} onClick={() => void remove(s)}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d={TRASH} />
                        </svg>
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {error && (
          <div className="ss-err" role="alert">
            {error}
          </div>
        )}
      </Panel>
      <div className="sr-only" role="status" aria-live="polite">
        {notice}
      </div>
    </>
  );
}
