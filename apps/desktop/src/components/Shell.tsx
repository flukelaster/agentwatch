import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLive, useQuery } from "../lib/context";
import { pendingRequests, runningCount } from "../lib/store";
import { href, useRoute } from "../lib/router";
import type { Settings } from "@agentwatch/protocol";
import { Dot, Icon, LockIcon, Logo, NAV } from "./ui";
import { UpdateBanner, UpdateModal } from "./Updates";
import { startAutoCheck } from "../lib/updater";

function activeFor(path: string, current: string): boolean {
  if (path === "/") return current === "/";
  return current === path || current.startsWith(`${path}/`);
}

export function Shell({ children }: { children: ReactNode }) {
  const live = useLive();
  const route = useRoute();
  const settings = useQuery<Settings>("settings", undefined, { live: false });
  const running = runningCount(live);
  const pending = pendingRequests(live);
  const waiting = pending.length;
  // Every request that is new gets its own flash around the window; the glow itself lasts as long as any request is open.
  const pendingKey = pending.map((r) => r.id).join("|");
  const known = useRef<Set<string>>(new Set());
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    const fresh = pending.filter((r) => !known.current.has(r.id));
    known.current = new Set(pending.map((r) => r.id));
    if (fresh.length) setFlash((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);
  const failed = [...live.sessions.values()].filter((s) => s.status === "failed" && !s.endedAt).length;
  const conn = live.status === "connected" ? "agentwatchd connected" : live.status === "connecting" ? "connecting to agentwatchd" : "agentwatchd not reachable";
  const retention = settings.data?.retentionDays;
  const keepsText = settings.data?.storePromptText === true || settings.data?.storeAssistantText === true;
  // the page scrolls inside the window now, so a new page starts at the top by itself
  const mainRef = useRef<HTMLElement>(null);
  const path = route.path;
  useEffect(() => startAutoCheck(), []);
  useEffect(() => {
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [path]);

  return (
    <div className="app" data-attention={waiting > 0 ? "1" : undefined}>
      <UpdateModal />
      {waiting > 0 && <div key={flash} className="attn" aria-hidden="true" />}
      <header className="topbar">
        <a className="brand" href={href("/")}>
          <Logo />
          <span className="brand__name">AGENTWATCH</span>
        </a>
        <div className="topbar__right">
          <span className={`badge ${running > 0 ? "badge--run" : "badge--muted"}`}>
            <Dot tone={running > 0 ? "run" : undefined} />
            {running} running
          </span>
          {waiting > 0 && (
            <span className="badge badge--ask">
              <b>!</b>
              {waiting} needs you
            </span>
          )}
          {failed > 0 && <span className="badge badge--fail">✕ {failed} failed</span>}
          <span className="badge badge--muted badge--lock">
            <LockIcon />
            127.0.0.1 · local only
          </span>
        </div>
      </header>
      <div className="body">
        <nav className="sidebar" aria-label="Primary">
          {NAV.map((n) => (
            <a key={n.path} className="nav" href={href(n.path)} aria-current={activeFor(n.path, route.path) ? "page" : undefined}>
              <Icon d={n.d} />
              <span>{n.label}</span>
            </a>
          ))}
          <div className="sidebar__foot">
            <span className={`conn conn--${live.status === "connected" ? "ok" : live.status === "connecting" ? "wait" : "down"}`} role="status">
              <span className="conn__dot" aria-hidden="true" />
              {conn}
            </span>
            <span>
              {keepsText ? "Prompt and reply text is kept on this Mac, because you turned it on." : "Prompts and transcripts are not stored."}
              {retention !== undefined && (retention === 0 ? " History is cleared when a session ends." : ` History kept ${retention} days.`)}
            </span>
          </div>
        </nav>
        <main className="main" ref={mainRef}>
          {live.status === "disconnected" && <DisconnectedBanner message={live.error} />}
          <UpdateBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

export function DisconnectedBanner({ message }: { message?: string }) {
  return (
    <section className="panel" role="status">
      <div className="callout">
        <h2>The AgentWatch daemon is not running</h2>
        <p>
          {message ?? "AgentWatch cannot reach its background service."} The window keeps retrying. Start it from the AgentWatch project folder with the command below. To have it start by itself, run agentwatch launchagent --apply once.
        </p>
        <code className="code">pnpm daemon</code>
      </div>
    </section>
  );
}
