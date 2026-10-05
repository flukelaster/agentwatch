import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AgentEvent, AgentView, SessionView } from "@agentwatch/protocol";
import { useDaemon, useQuery } from "../lib/context";
import { layoutGraph, polyAt, polyLen, segLen, type GEdge, type GNode, type GPart, type GraphLayout, type Pt, type PromptInfo } from "../lib/graph";
import { confBars, confLabel } from "../lib/format";
import { inspectNode, inspectPart, partOf } from "../lib/inspect";
import { summarizeActivity } from "../lib/activity";
import { NodeInspector } from "./NodeInspector";
import { ChatPanel } from "./ChatPanel";
import { ContextPanel } from "./ContextPanel";
import { OPEN_CONTEXT_EVENT } from "./ContextMeter";
import { ProviderIcon, UiIcon, sourceProvider } from "./icons";
import { chatMessages } from "../lib/chat";
import { clock } from "../lib/format";

export type FlowMode = "event" | "sweep" | "dots" | "glow";

const MODES: Array<[FlowMode, string]> = [
  ["event", "Per event"],
  ["sweep", "Sweep"],
  ["dots", "Dots"],
  ["glow", "Glow"],
];

const LEGEND: Record<FlowMode, string> = {
  event: "Nothing moves until something happens. Each event lights its source line and sends one soft streak along it.",
  sweep: "A soft streak travels each line all the time. Dimmer means lower confidence.",
  dots: "Each moving dot is one event. Dimmer dots mean lower confidence.",
  glow: "Lines brighten when they carry a recent event, then fade back. Nothing moves.",
};

const TRAVEL = 0.9; // seconds for one streak to cross an edge
const AFTERGLOW = 2.4;
const SIGNAL = "var(--signal)";
const FAIL = "var(--fail)";
const FLOW = "var(--run)"; // moving signals are "in progress", which is blue
const CONF_ALPHA = { high: 1, medium: 0.7, low: 0.45 } as const;

interface Streak {
  key: string;
  born: number;
}

function loadMode(): FlowMode {
  try {
    const v = localStorage.getItem("aw.flow");
    if (v === "event" || v === "sweep" || v === "dots" || v === "glow") return v;
  } catch {
    /* storage unavailable */
  }
  return "event";
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function countBySource(events: readonly AgentEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.source] = (out[e.source] ?? 0) + 1;
  return out;
}

/** Which edges an event lights: its evidence source, plus the agent's return path (and dispatch the first time). */
export function edgeKeysFor(e: AgentEvent, layout: GraphLayout, seen: Set<string>): string[] {
  const keys: string[] = [];
  const has = (k: string) => layout.edges.some((x) => x.key === k);
  if (e.kind === "message") return e.payload.role === "user" && has("prompt") ? ["prompt"] : [];
  if (has(`src:${e.source}`)) keys.push(`src:${e.source}`);
  const isKid = layout.nodes.some((n) => n.kind === "agent" && n.agentId === e.agentId);
  if (isKid) {
    if (e.kind === "agent.started" || !seen.has(e.agentId)) {
      if (has(`dlg:${e.agentId}`)) keys.push(`dlg:${e.agentId}`);
    }
    seen.add(e.agentId);
    if (e.kind !== "agent.started" && has(`ret:${e.agentId}`)) keys.push(`ret:${e.agentId}`);
  }
  return keys;
}

const mix = (c: string, a: number) => `color-mix(in oklch, ${c} ${Math.round(Math.max(0, Math.min(1, a)) * 100)}%, transparent)`;

/** A short gradient bar clipped onto every segment of the polyline it overlaps. */
export function streakBars(pts: Pt[], head: number, length: number, alpha: number, color: string): CSSProperties[] {
  const out: CSSProperties[] = [];
  const a = head - length;
  let s0 = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1]!;
    const q = pts[i]!;
    const sl = segLen(p, q);
    const s1 = s0 + sl;
    if (sl) {
      const lo = Math.max(a, s0);
      const hi = Math.min(head, s1);
      if (hi > lo) {
        const dx = Math.sign(q[0] - p[0]);
        const dy = Math.sign(q[1] - p[1]);
        const x0 = p[0] + dx * (lo - s0);
        const y0 = p[1] + dy * (lo - s0);
        const x1 = p[0] + dx * (hi - s0);
        const y1 = p[1] + dy * (hi - s0);
        const horiz = dy === 0;
        const dir = horiz ? (dx > 0 ? "to right" : "to left") : dy > 0 ? "to bottom" : "to top";
        const pa = ((lo - a) / length) * alpha;
        const pb = ((hi - a) / length) * alpha;
        out.push({
          left: horiz ? Math.min(x0, x1) : x0 - 1,
          top: horiz ? y0 - 1 : Math.min(y0, y1),
          width: horiz ? hi - lo : 2,
          height: horiz ? 2 : hi - lo,
          background: `linear-gradient(${dir}, ${mix(color, pa)}, ${mix(color, pb)})`,
        });
      }
    }
    s0 = s1;
  }
  return out;
}

function arrowStyle(pts: Pt[], color: string): CSSProperties {
  let li = pts.length - 1;
  while (li > 0 && !segLen(pts[li - 1]!, pts[li]!)) li--;
  const p0 = pts[li - 1]!;
  const p1 = pts[li]!;
  const dx = Math.sign(p1[0] - p0[0]);
  const dy = Math.sign(p1[1] - p0[1]);
  const T = "4px solid transparent";
  if (dy > 0) return { left: p1[0] - 4, top: p1[1] - 7, borderLeft: T, borderRight: T, borderTop: `7px solid ${color}` };
  if (dy < 0) return { left: p1[0] - 4, top: p1[1], borderLeft: T, borderRight: T, borderBottom: `7px solid ${color}` };
  if (dx > 0) return { left: p1[0] - 7, top: p1[1] - 4, borderTop: T, borderBottom: T, borderLeft: `7px solid ${color}` };
  return { left: p1[0], top: p1[1] - 4, borderTop: T, borderBottom: T, borderRight: `7px solid ${color}` };
}

/** The first box: what was asked (only if prompt text is stored) and what the agent was set up with. */
export function promptInfoFor(session: SessionView, messages: readonly { role: string; body: string; at: string }[], policy: { prompts: boolean }): PromptInfo | undefined {
  if (session.provider === "generic") return undefined; // a wrapped process has no prompt of its own
  const users = messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  const oneLine = (last?.body ?? "").replace(/\s+/g, " ").trim();
  const name = session.provider === "codex" ? "Codex" : "Claude Code";
  const info: PromptInfo = {
    userNote: !policy.prompts ? "Text not stored · turn on in Settings" : last ? `${users.length} prompt${users.length === 1 ? "" : "s"} · last ${clock(last.at)}` : session.provider === "claude-code" ? "No prompt read yet" : "Not available for Codex yet",
    systemText: `${name} · built in${session.model ? ` · ${session.model}` : ""}`,
  };
  if (policy.prompts && oneLine) info.userText = oneLine.length > 150 ? `${oneLine.slice(0, 149)}…` : oneLine;
  return info;
}

/** What the header says about the graph. Only a running session streams; the others say why nothing moves. */
export function graphState(playing: boolean, s: Pick<SessionView, "status" | "endedAt">): string {
  if (s.endedAt || s.status === "finished" || s.status === "failed") return "ended";
  if (s.status === "waiting") return "waiting for you";
  if (s.status === "idle") return "idle · no activity";
  return playing ? "streaming events" : "paused";
}

interface Props {
  session: SessionView;
  agents: AgentView[];
  events: readonly AgentEvent[];
}

export function AgentGraph({ session, agents, events }: Props) {
  const { store } = useDaemon();
  const [mode, setMode] = useState<FlowMode>(loadMode);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [clock, setClock] = useState(0);
  const clockRef = useRef(0);
  const streaks = useRef<Streak[]>([]);
  const seenAgents = useRef(new Set<string>());
  const playingRef = useRef(playing);
  const modeRef = useRef(mode);
  const flowing = session.status === "running" && !session.endedAt;
  const flowingRef = useRef(flowing);
  playingRef.current = playing;
  modeRef.current = mode;
  flowingRef.current = flowing;

  const [tab, setTab] = useState<"chat" | "details" | "context">("context");
  const settingsQ = useQuery<{ storePromptText?: boolean; storeAssistantText?: boolean; trackTokenUsage?: boolean }>("settings", undefined, { live: false });
  // the context meter above the graph opens the Context tab and brings it into view
  useEffect(() => {
    const open = () => {
      setTab("context");
      document.getElementById("gpanel")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    };
    window.addEventListener(OPEN_CONTEXT_EVENT, open);
    return () => window.removeEventListener(OPEN_CONTEXT_EVENT, open);
  }, []);
  const policy = useMemo(() => ({ prompts: settingsQ.data?.storePromptText === true, responses: settingsQ.data?.storeAssistantText === true }), [settingsQ.data]);
  const messages = useMemo(() => chatMessages(events, policy), [events, policy]);
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [pinned, setPinned] = useState<string | undefined>(undefined);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const counts = useMemo(() => countBySource(events), [events]);
  const sessionLive = session.status === "running" && !session.endedAt;
  const activity = useMemo(() => summarizeActivity(events, sessionLive || session.status === "waiting"), [events, sessionLive, session.status]);
  const promptInfo = useMemo(() => promptInfoFor(session, messages, policy), [session, messages, policy]);
  const layout = useMemo(() => layoutGraph(session, agents, counts, activity, promptInfo), [session, agents, counts, activity, promptInfo]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // new session selected: forget what we have seen
  useEffect(() => {
    streaks.current = [];
    seenAgents.current = new Set();
    setPreview(undefined);
    setPinned(undefined);
    setTab("context");
  }, [session.id]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  // live events become streaks
  useEffect(() => {
    return store.onEvent((e) => {
      if (e.sessionId !== session.id || !playingRef.current) return;
      const keys = edgeKeysFor(e, layoutRef.current, seenAgents.current);
      for (const key of keys) {
        const recent = streaks.current.find((s) => s.key === key && clockRef.current - s.born < 0.12);
        if (!recent) streaks.current.push({ key, born: clockRef.current });
      }
      if (streaks.current.length > 80) streaks.current.splice(0, streaks.current.length - 80);
      wakeRef.current();
    });
  }, [store, session.id]);

  // Animation clock. It advances only while playing, and the frame loop stops completely when nothing
  // is moving or fading (per-event and glow modes between events), so an idle graph costs nothing.
  const wakeRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!playing) {
      wakeRef.current = () => undefined;
      return;
    }
    let raf = 0;
    let active = false;
    let last = performance.now();
    let lastRender = 0;
    const tick = (ts: number) => {
      const dt = Math.min((ts - last) / 1000, 0.25);
      last = ts;
      clockRef.current += dt;
      streaks.current = streaks.current.filter((s) => clockRef.current - s.born < AFTERGLOW + 0.2);
      const latest = events.length ? events[events.length - 1] : undefined;
      const recentlyActive = latest ? Date.now() - Date.parse(latest.receivedAt) < 9000 : false;
      const needs = (flowingRef.current && (modeRef.current === "sweep" || modeRef.current === "dots")) || streaks.current.length > 0 || recentlyActive;
      if (needs) {
        if (ts - lastRender > 33) {
          lastRender = ts;
          setClock(clockRef.current);
        }
        raf = requestAnimationFrame(tick);
      } else {
        active = false;
        setClock(clockRef.current); // one last paint so every glow settles
      }
    };
    const wake = () => {
      if (active || document.hidden) return;
      active = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;
    wake();
    const onVisible = () => {
      if (!document.hidden) wake();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisible);
      wakeRef.current = () => undefined;
    };
  }, [playing, events]);
  useEffect(() => wakeRef.current(), [mode, flowing]);

  // scale the fixed-size stage to the available width
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, Math.max(0.4, (el.clientWidth - 32) / layout.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.width]);

  const now = clock;
  const view = useMemo(() => buildView(layout, mode, now, streaks.current, events, flowing), [layout, mode, now, events, flowing]);

  // The inspector shows what the pointer is over, else the pinned node, else the main agent.
  // Pinned wins. Otherwise the panel keeps the last node the pointer settled on: it never snaps back when the
  // pointer crosses a gap, and a short delay ignores nodes the pointer merely passes over.
  const shownId = pinned ?? preview;
  const shownPart = partOf(shownId);
  const shownNode = layout.nodes.find((n) => n.id === shownId) ?? layout.nodes.find((n) => n.kind === "main") ?? layout.nodes[0];
  const tick = Math.floor(Date.now() / 5000);
  const inspection = useMemo(() => {
    const input = { session, agents, events, now: Date.now(), policy };
    if (shownPart) return inspectPart(shownPart, input);
    return shownNode ? inspectNode(shownNode, input) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownPart, shownNode, session, agents, events, tick, policy]);
  const hover = (id: string | undefined) => {
    clearTimeout(hoverTimer.current);
    if (id) hoverTimer.current = setTimeout(() => setPreview(id), 110);
  };
  const togglePin = (id: string) => {
    if (pinned !== id) setTab("details"); // choosing a node means you want its details
    setPinned((p) => (p === id ? undefined : id));
  };

  const choose = (m: FlowMode) => {
    setMode(m);
    try {
      localStorage.setItem("aw.flow", m);
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <section className="panel" aria-label="Agent graph" data-testid="agent-graph">
      <div className="panel__head">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="panel__title">Agent graph</span>
          <span className="mono muted" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span className={`dot${!playing && flowing ? "" : flowing ? " dot--run" : session.status === "waiting" && !session.endedAt ? " dot--ask" : session.status === "failed" ? " dot--fail" : session.status === "finished" ? " dot--done" : ""}`} />
            {graphState(playing, session)}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 16px" }}>
          <div role="group" aria-label="Flow style" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="label">Flow</span>
            <div className="seg">
              {MODES.map(([k, label]) => (
                <button key={k} type="button" aria-pressed={mode === k} onClick={() => choose(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="btn" onClick={() => setPlaying((p) => !p)} aria-pressed={!playing}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path d={playing ? "M2 1h3v10H2zM7 1h3v10H7z" : "M2.5 1.2 10.5 6l-8 4.8z"} />
            </svg>
            {playing ? "Pause" : "Play"}
          </button>
        </div>
      </div>
      <div className="graphwrap" ref={wrapRef}>
        <div style={{ width: layout.width * scale, height: layout.height * scale, margin: "0 auto" }}>
          <div
            className="stage"
            role="group"
            data-testid="graph-stage"
            aria-label={layout.label}
            data-streaks={streaks.current.length}
            data-mode={mode}
            style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
          >
            {view.lines.map((s, i) => (
              <div key={`l${i}`} className="g-line" style={s} />
            ))}
            {view.arrows.map((s, i) => (
              <div key={`a${i}`} className="g-arrow" style={s} />
            ))}
            {view.streaks.map((s, i) => (
              <div key={`s${i}`} className="g-streak" style={s} />
            ))}
            {view.dots.map((s, i) => (
              <div key={`d${i}`} className="g-dot" style={s} />
            ))}
            {view.nodes.map(({ node, glow, active }) => (
              <NodeBox key={node.id} node={node} glow={glow} active={active} selected={node.id === pinned} pinnedId={pinned} provider={session.provider} onHover={hover} onPin={togglePin} />
            ))}
            {layout.delegateLabel && (
              <div className="g-label" style={{ left: layout.delegateLabel.align === "center" ? layout.delegateLabel.x - 90 : layout.delegateLabel.x, top: layout.delegateLabel.y, width: layout.delegateLabel.align === "center" ? 180 : undefined, textAlign: layout.delegateLabel.align }}>
                {layout.delegateLabel.text}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="gtabs" role="tablist" aria-label="Under the graph">
        <button type="button" role="tab" id="gtab-context" aria-selected={tab === "context"} aria-controls="gpanel" className="gtab" onClick={() => setTab("context")}>
          Context
        </button>
        <button type="button" role="tab" id="gtab-chat" aria-selected={tab === "chat"} aria-controls="gpanel" className="gtab" onClick={() => setTab("chat")}>
          Chat
        </button>
        <button type="button" role="tab" id="gtab-details" aria-selected={tab === "details"} aria-controls="gpanel" className="gtab" onClick={() => setTab("details")}>
          Details
        </button>
        {tab === "chat" && flowing && (policy.prompts || policy.responses) && (
          <span className="gtabs__live">
            <span className="dot dot--run" aria-hidden="true" /> live
          </span>
        )}
      </div>
      <div id="gpanel" role="tabpanel" aria-labelledby={`gtab-${tab}`}>
        {tab === "chat" ? (
          <ChatPanel session={session} messages={messages} policy={policy} />
        ) : tab === "context" ? (
          <ContextPanel session={session} tracking={settingsQ.data ? settingsQ.data.trackTokenUsage !== false : undefined} />
        ) : (
          inspection && <NodeInspector info={inspection} pinned={!!pinned && inspection.nodeId === pinned} onClear={() => setPinned(undefined)} />
        )}
      </div>
      <div className="legend">
        {LEGEND[mode]} Dashed lines are observed sources and solid lines are delegation and results.
      </div>
    </section>
  );
}

function NodeBox({ node, glow, active, selected, pinnedId, provider, onHover, onPin }: { node: GNode; glow: number; active: boolean; selected: boolean; pinnedId: string | undefined; provider: string; onHover: (id: string | undefined) => void; onPin: (id: string) => void }) {
  const cls = ["gnode", node.kind === "main" ? "gnode--main" : "", node.kind === "source" ? "gnode--source" : "", node.kind === "prompt" ? "gnode--prompt" : "", node.kind === "more" ? "gnode--more" : "", node.tone === "ask" ? "gnode--ask" : node.tone === "fail" ? "gnode--fail" : node.tone === "done" && node.kind !== "main" ? "gnode--done" : node.tone === "run" && node.kind !== "main" ? "gnode--run" : ""].filter(Boolean).join(" ");
  const stateColor = node.tone === "run" ? "var(--run)" : node.tone === "done" ? "var(--done)" : node.tone === "ask" ? "var(--ask)" : node.tone === "fail" ? "var(--fail)" : "var(--muted)";
  const style: CSSProperties = {
    left: node.x,
    top: node.y,
    width: node.w,
    height: node.h,
    boxShadow: glow > 0.02 ? `0 0 ${Math.round(glow * 22)}px ${mix(SIGNAL, glow * 0.55)}` : undefined,
    borderColor: active ? "var(--accent)" : undefined,
  };
  return (
    <div
      className={cls}
      style={style}
      data-node-id={node.id}
      data-tone={node.tone}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`Inspect ${node.title}`}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(undefined)}
      onFocus={() => onHover(node.id)}
      onBlur={() => onHover(undefined)}
      onClick={() => onPin(node.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPin(node.id);
        }
      }}
    >
      <div className="gnode__top">
        <span className="gnode__title" title={node.title}>
          {(node.kind === "main" || (node.kind === "source" && sourceProvider(node.source))) && <ProviderIcon provider={node.kind === "main" ? provider : sourceProvider(node.source)!} size={14} className="gnode__brand" />}
          {node.title}
        </span>
        <span className="gnode__tag">{node.tag}</span>
      </div>
      {node.prompt && (
        <div className="gprompt">
          <section className="gprompt__sec">
            <span className="gprompt__label">
              <UiIcon name="user" size={12} /> User prompt
            </span>
            {node.prompt.userText && <span className="gprompt__text">“{node.prompt.userText}”</span>}
            <span className="gprompt__note">{node.prompt.userNote}</span>
          </section>
          <span className="gprompt__arrow" aria-hidden="true">
            ↓
          </span>
          <section className="gprompt__sec">
            <span className="gprompt__label">
              <UiIcon name="scroll-text" size={12} /> System prompt
            </span>
            <span className="gprompt__note" title="Claude Code does not give its system prompt to hooks, so AgentWatch only knows what it is set up with.">
              {node.prompt.systemText}
            </span>
          </section>
        </div>
      )}
      <span className={node.kind === "source" ? "gnode__state--src" : "gnode__state"} style={node.kind === "source" ? undefined : { color: stateColor }}>
        {node.state}
      </span>
      <span className="gnode__detail">{node.detail}</span>
      {node.parts && (
        <div className="gparts" role="group" aria-label="What main works through">
          {node.parts.map((p) => (
            <Part key={p.key} part={p} pinned={pinnedId === `part:${p.key}`} onHover={onHover} onPin={onPin} />
          ))}
        </div>
      )}
      {node.kind === "source" && node.conf && (
        <span className={`conf gnode__conf conf--${node.conf}`}>
          <span className="conf__bars" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <i key={i} className={i < confBars[node.conf!] ? "on" : ""} />
            ))}
          </span>
          <span className="conf__label">{confLabel[node.conf]} confidence</span>
        </span>
      )}
    </div>
  );
}

function Part({ part, pinned, onHover, onPin }: { part: GPart; pinned: boolean; onHover: (id: string | undefined) => void; onPin: (id: string) => void }) {
  const id = `part:${part.key}`;
  return (
    <button
      type="button"
      className={`gpart gpart--${part.tone}`}
      aria-pressed={pinned}
      aria-label={`${part.label}: ${part.value}, ${part.sub}`}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(undefined)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(undefined)}
      onClick={(e) => {
        e.stopPropagation();
        onPin(id);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <span className="gpart__label">{part.label}</span>
      <span className="gpart__value">{part.value}</span>
      <span className="gpart__sub">{part.sub}</span>
    </button>
  );
}

interface View {
  lines: CSSProperties[];
  arrows: CSSProperties[];
  streaks: CSSProperties[];
  dots: CSSProperties[];
  nodes: Array<{ node: GNode; glow: number; active: boolean }>;
}

/**
 * `flowing` is false for a session that is not running (idle, waiting on a person, ended): the continuous modes
 * (sweep, dots) then draw nothing moving, because nothing is happening. Per-event and glow modes are driven by
 * real events and fall silent by themselves.
 */
export function buildView(layout: GraphLayout, mode: FlowMode, t: number, streaks: Streak[], events: readonly AgentEvent[], flowing = true): View {
  const lines: CSSProperties[] = [];
  const arrows: CSSProperties[] = [];
  const bars: CSSProperties[] = [];
  const dots: CSSProperties[] = [];
  const heat: Record<string, number> = {};

  // latest event decides which agent node is "active", fading after a few seconds
  const latest = events[events.length - 1];
  let activeId: string | undefined;
  let activeGlow = 0;
  if (latest) {
    const node = layout.nodes.find((n) => n.agentId === latest.agentId);
    const age = (Date.now() - Date.parse(latest.receivedAt)) / 1000;
    if (node && age >= 0) {
      activeId = node.id;
      activeGlow = Math.max(0, 1 - age / 8);
    }
  }

  const ageByKey = new Map<string, number>();
  for (const s of streaks) {
    const age = t - s.born;
    const prev = ageByKey.get(s.key);
    if (prev === undefined || age < prev) ageByKey.set(s.key, age);
  }

  // A line only carries continuous flow while the node it works for is in progress: edges of a finished, idle,
  // waiting or failed agent stay still, and so does the return loop once nothing is left running.
  const toneOf = new Map(layout.nodes.map((n) => [n.id, n.tone]));
  const liveEdge = (e: GEdge): boolean => {
    const m = /^(dlg|ret):(.+)$/.exec(e.key);
    const owner = m ? m[2]! : e.key === "loop" ? "merge" : e.to;
    return toneOf.get(owner) === "run";
  };

  layout.edges.forEach((e: GEdge, ei) => {
    const age = mode === "event" || mode === "glow" ? ageByKey.get(e.key) : undefined;
    const lit = age === undefined ? 0 : Math.max(0, 1 - age / AFTERGLOW);
    const base = e.dashed ? "var(--g-3a)" : "var(--g-30)";
    const lc = lit > 0 ? `color-mix(in oklch, ${FLOW} ${Math.round(lit * 70)}%, ${base})` : base;
    for (let i = 1; i < e.pts.length; i++) {
      const a = e.pts[i - 1]!;
      const b = e.pts[i]!;
      if (!segLen(a, b)) continue;
      const bd = `1px ${e.dashed ? "dashed" : "solid"} ${lc}`;
      lines.push(a[1] === b[1] ? { left: Math.min(a[0], b[0]), top: a[1], width: Math.abs(b[0] - a[0]), borderTop: bd } : { left: a[0], top: Math.min(a[1], b[1]), height: Math.abs(b[1] - a[1]), borderLeft: bd });
    }
    arrows.push(arrowStyle(e.pts, lc));

    const len = polyLen(e.pts);
    const cf = CONF_ALPHA[e.conf];
    const color = e.fail ? FAIL : FLOW;
    if (mode === "event" && age !== undefined) {
      if (age < TRAVEL) {
        const f = age / TRAVEL;
        const eased = 1 - (1 - f) * (1 - f);
        const a = Math.min(1, f / 0.12, (1 - f) / 0.2 + 0.0) * cf;
        bars.push(...streakBars(e.pts, eased * len, 56, Math.max(0.15, a), color));
      } else if (age < TRAVEL + 0.8) {
        heat[e.to] = Math.max(heat[e.to] ?? 0, 1 - (age - TRAVEL) / 0.8);
      }
    }
    const speed = e.kind === "delegate" ? 150 : e.kind === "return" ? 120 : e.kind === "loop" ? 140 : 100;
    const off = (ei * 0.37) % 1;
    if (mode === "sweep" && flowing && liveEdge(e)) {
      const f = (((t * speed) / len + off) % 1 + 1) % 1;
      const a = Math.min(1, f / 0.06, (1 - f) / 0.06) * cf;
      bars.push(...streakBars(e.pts, f * len, 64, a, color));
      const since = (f * len) / speed;
      if (since < 0.8) heat[e.to] = Math.max(heat[e.to] ?? 0, 1 - since / 0.8);
    }
    if (mode === "dots" && flowing && liveEdge(e)) {
      const nP = Math.max(1, Math.round(len / 240));
      for (let k = 0; k < nP; k++) {
        const f = (((t * speed) / len + off + k / nP) % 1 + 1) % 1;
        const fade = Math.min(1, f / 0.05, (1 - f) / 0.05) * cf;
        const since = (f * len) / speed;
        if (since < 0.8) heat[e.to] = Math.max(heat[e.to] ?? 0, 1 - since / 0.8);
        for (const [back, size, al] of [[0, 8, 1], [11, 6, 0.55], [21, 4, 0.3]] as const) {
          const d = f * len - back;
          if (d < 0) continue;
          const q = polyAt(e.pts, d);
          dots.push({ left: q[0] - size / 2, top: q[1] - size / 2, width: size, height: size, background: color, opacity: fade * al, boxShadow: `0 0 ${size + 4}px ${color}` });
        }
      }
    }
  });

  const nodes = layout.nodes.map((node) => {
    const active = node.id === activeId;
    return { node, glow: Math.max(heat[node.id] ?? 0, active ? activeGlow : 0), active: active && activeGlow > 0.05 };
  });
  return { lines, arrows, streaks: bars, dots, nodes };
}
