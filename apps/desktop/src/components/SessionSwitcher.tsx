import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionView } from "@agentwatch/protocol";
import { duration, providerLabel, repoName, sessionElapsedMs, sessionTitle } from "../lib/format";
import { ProviderIcon, type UiIconName } from "./icons";
import { EmptyState, type EmptyTone } from "./ui";
import "../styles/sessionswitch.css";

export type Group = "running" | "waiting" | "idle" | "failed" | "finished";

/** Order is the order of the tabs. `always` tabs show even when empty ("Running 0" is information). */
export const GROUPS: ReadonlyArray<{ key: Group; label: string; always: boolean }> = [
  { key: "running", label: "Running", always: true },
  { key: "waiting", label: "Needs you", always: false },
  { key: "idle", label: "Idle", always: true },
  { key: "failed", label: "Failed", always: false },
  { key: "finished", label: "Finished", always: false },
];

const FILTER_FROM = 8;

const EMPTY_COPY: Record<Group, { title: string; hint: string }> = {
  running: { title: "Nothing is running right now", hint: "A session shows up here, in blue, while its agent is working." },
  waiting: { title: "No session needs you", hint: "A session that asks for approval or asks you a question appears here." },
  idle: { title: "No idle sessions", hint: "A session that is open but quiet waits here." },
  failed: { title: "Nothing has failed", hint: "A session that ends with an error appears here, in red." },
  finished: { title: "Nothing has finished yet", hint: "Sessions that ended normally are listed here, in green." },
};

const EMPTY_TONE: Record<Group, EmptyTone | undefined> = { running: "run", waiting: "ask", idle: undefined, failed: "fail", finished: "done" };
const EMPTY_ICON: Record<Group, UiIconName> = { running: "activity", waiting: "user", idle: "inbox", failed: "shield-check", finished: "sparkles" };

export const groupOf = (s: Pick<SessionView, "status">): Group => (GROUPS.some((g) => g.key === s.status) ? (s.status as Group) : "idle");

export function groupSessions(sessions: readonly SessionView[]): Record<Group, SessionView[]> {
  const out: Record<Group, SessionView[]> = { running: [], waiting: [], idle: [], failed: [], finished: [] };
  for (const s of sessions) out[groupOf(s)].push(s);
  return out;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export interface SessionLabel {
  name: string;
  /** Present only when another session has the same name, so two entries never look identical. */
  suffix?: string;
  /** Right-hand time: elapsed while it is live, "x ago" afterwards. */
  time: string;
  /** Second line. */
  meta: string;
}

/** Names repeat (several sessions in one repo); the suffix is the short session id, shown only on collisions. */
export function labelSessions(sessions: readonly SessionView[], now: number): Map<string, SessionLabel> {
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(sessionTitle(s), (counts.get(sessionTitle(s)) ?? 0) + 1);
  const out = new Map<string, SessionLabel>();
  for (const s of sessions) {
    const name = sessionTitle(s);
    // counts up while running or waiting; an idle session keeps the time it had at its last activity
    const time = s.endedAt ? ago(now - Date.parse(s.endedAt)) : duration(sessionElapsedMs(s, now));
    const meta =
      s.status === "running" ? s.activity ?? "Working" : s.status === "waiting" ? s.activity ?? "Waiting for you" : [providerLabel[s.provider] ?? s.provider, s.branch].filter(Boolean).join(" · ");
    const label: SessionLabel = { name, time, meta };
    if ((counts.get(name) ?? 0) > 1) label.suffix = `#${s.id.slice(-4)}`;
    out.set(s.id, label);
  }
  return out;
}

export function matches(s: SessionView, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [repoName(s), s.branch, s.cwd, s.activity, s.id].some((v) => v?.toLowerCase().includes(needle));
}

/** A one-line scroller: edges fade only where there is more to see, arrows appear only where they can go. */
function Scroller({ children, selectedKey }: { children: React.ReactNode; selectedKey: string | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ l: false, r: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const l = el.scrollLeft > 2;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdge((p) => (p.l === l && p.r === r ? p : { l, r }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
    };
  }, [measure, children]);

  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-pressed="true"]');
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [selectedKey]);

  const by = (dir: -1 | 1) => ref.current?.scrollBy?.({ left: dir * Math.max(200, (ref.current?.clientWidth ?? 0) * 0.8), behavior: "smooth" });

  return (
    <div className="sw-scrollwrap">
      {edge.l && (
        <button type="button" className="sw-arrow sw-arrow--l" aria-label="Scroll sessions left" onClick={() => by(-1)}>
          ‹
        </button>
      )}
      <div ref={ref} className="sw-scroll" data-l={edge.l ? "1" : "0"} data-r={edge.r ? "1" : "0"}>
        {children}
      </div>
      {edge.r && (
        <button type="button" className="sw-arrow sw-arrow--r" aria-label="Scroll sessions right" onClick={() => by(1)}>
          ›
        </button>
      )}
    </div>
  );
}

/**
 * `tab` and `onTab` make the tab the caller's to own (the Overview does, so it can show only what belongs to the tab).
 * Without them the tab follows the selected session until the person picks one.
 */
export function SessionSwitcher({ sessions, selectedId, onSelect, now, tab, onTab, emptyHero }: { sessions: readonly SessionView[]; selectedId: string | undefined; onSelect: (id: string) => void; now: number; tab?: Group; onTab?: (g: Group) => void; /** The empty state of a tab is the only thing on the page: show it large. */ emptyHero?: boolean }) {
  const grouped = useMemo(() => groupSessions(sessions), [sessions]);
  const selected = sessions.find((s) => s.id === selectedId);
  const [picked, setPicked] = useState<Group | undefined>(undefined);
  const [query, setQuery] = useState("");

  // The tab follows the selected session until the person picks a tab. A tab they picked stays, even when it is empty
  // ("Running 0" is an answer): jumping away to another tab made the empty state impossible to see.
  const active: Group = tab ?? picked ?? (selected ? groupOf(selected) : (GROUPS.find((g) => grouped[g.key].length)?.key ?? "running"));
  const inGroup = grouped[active];
  const shown = useMemo(() => inGroup.filter((s) => matches(s, query)), [inGroup, query]);
  const labels = useMemo(() => labelSessions(sessions, now), [sessions, now]);

  const pick = (g: Group) => {
    setPicked(g);
    onTab?.(g);
    setQuery("");
  };

  return (
    <div className="sw">
      <div className="sw-tabs" role="tablist" aria-label="Sessions by status">
        {GROUPS.filter((g) => g.always || grouped[g.key].length || g.key === active).map((g) => (
          <button key={g.key} type="button" role="tab" aria-selected={g.key === active} className={`sw-tab sw-tab--${g.key}`} onClick={() => pick(g.key)}>
            <i className="sw-ind" aria-hidden="true" />
            <span>{g.label}</span>
            <b className="sw-count">{grouped[g.key].length}</b>
          </button>
        ))}
        {inGroup.length >= FILTER_FROM && (
          <input className="sw-filter" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Filter ${inGroup.length} sessions`} aria-label={`Filter ${GROUPS.find((g) => g.key === active)?.label} sessions`} />
        )}
      </div>

      <div role="tabpanel" aria-label={`${GROUPS.find((g) => g.key === active)?.label} sessions`}>
        {inGroup.length === 0 ? (
          <EmptyState compact={!emptyHero} hero={emptyHero} visual="radar" tone={EMPTY_TONE[active]} icon={EMPTY_ICON[active]} title={EMPTY_COPY[active].title} hint={EMPTY_COPY[active].hint} />
        ) : shown.length === 0 ? (
          <EmptyState compact icon="search" title={`No session matches “${query}”`} hint="Try a project name, branch or folder." />
        ) : (
          <Scroller selectedKey={selectedId}>
            {shown.map((s) => {
              const l = labels.get(s.id)!;
              return (
                <button key={s.id} type="button" className={`sw-card sw-card--${groupOf(s)}`} aria-pressed={s.id === selectedId} onClick={() => onSelect(s.id)} title={[l.name, l.suffix, s.cwd].filter(Boolean).join("  ")}>
                  <span className="sw-card__top">
                    <i className="sw-ind" aria-hidden="true" />
                    <ProviderIcon provider={s.provider} size={13} className="sw-card__brand" />
                    <span className="sw-card__name">{l.name}</span>
                    {l.suffix && <span className="sw-card__id">{l.suffix}</span>}
                    <span className="sw-card__time">{l.time}</span>
                  </span>
                  <span className="sw-card__meta">{l.meta}</span>
                </button>
              );
            })}
          </Scroller>
        )}
      </div>
    </div>
  );
}
