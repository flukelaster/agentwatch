import { useMemo } from "react";
import type { SessionView } from "@agentwatch/protocol";
import { allocateCells, contextParts, GRID_COLUMNS } from "../lib/contextGrid";
import { providerLabel, readsContext, tokens } from "../lib/format";
import { EmptyState } from "./ui";
import "../styles/context.css";

/** Where each tool's context is read from. A tool that is not listed does not tell AgentWatch how full its window is. */
const CONTEXT_FILE: Record<string, string> = { "claude-code": "Claude Code's conversation file", codex: "Codex's session file" };

/**
 * The context window as a grid of cells, in the style of Claude Code's `/context`, with the list of what fills it.
 * Claude Code's own breakdown is shown when `/context` has been run in the session; otherwise an estimate. Codex reports the total and the window, and the split is an estimate.
 */
export function ContextPanel({ session, tracking }: { session: SessionView; tracking?: boolean }) {
  const c = session.usage?.context;
  const parts = useMemo(() => (c ? contextParts(c) : []), [c]);
  const cells = useMemo(() => (c ? allocateCells(parts, c.window) : []), [c, parts]);
  const name = providerLabel[session.provider] ?? "This tool";
  const file = readsContext(session.provider) ? CONTEXT_FILE[session.provider] : undefined;
  if (!c) {
    return (
      <EmptyState
        icon="activity"
        title={!file ? `Context is not shown for ${name}` : tracking === false ? "Token tracking is off" : "The context window has not been read yet"}
        hint={!file ? `${name} does not tell AgentWatch how full its window is.` : tracking === false ? "Turn on Track token usage in Settings to see how full the window is." : `It is read from ${file} as soon as this session makes its next request.`}
        action={file && tracking === false ? { label: "Open Settings", href: "#/settings" } : undefined}
        compact
      />
    );
  }
  const pct = Math.round((c.used / c.window) * 100);
  const byKey = new Map(parts.map((p) => [p.key, p]));
  return (
    <div className="ctxp">
      <div className="ctxp__grid" role="img" aria-label={`Context window: ${pct}% used, ${tokens(Math.max(0, c.window - c.used))} left`} style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, 1fr)` }}>
        {cells.map((key, i) => {
          const p = byKey.get(key)!;
          return <i key={i} className={`ctxp__cell ctxp__cell--${p.kind}`} style={p.kind === "used" ? { background: p.color } : undefined} title={p.name} />;
        })}
      </div>
      <div className="ctxp__side">
        <div className="ctxp__head">
          {session.model && <span className="ctxp__model">{session.model}</span>}
          <b className="ctxp__total">
            {tokens(c.used)} <span>/ {c.windowAuto ? "≈" : ""}{tokens(c.window)} tokens ({pct}%)</span>
          </b>
        </div>
        <span className="ctxp__title">{c.reported ? "Usage by category · from /context" : "Estimated usage by category"}</span>
        <ul className="ctxp__list">
          {parts.map((p) => (
            <li key={p.key}>
              <i className={`ctxp__swatch ctxp__swatch--${p.kind}`} style={p.kind === "used" ? { background: p.color } : undefined} aria-hidden="true" />
              <span className="ctxp__name">{p.name}</span>
              <span className="ctxp__tok">{tokens(p.tokens)}</span>
              <span className="ctxp__pc">{((p.tokens / c.window) * 100).toFixed(p.tokens / c.window < 0.1 ? 1 : 0)}%</span>
            </li>
          ))}
        </ul>
        <p className="ctxp__note">
          {session.provider === "codex"
            ? "The total and the window size are Codex's own, from its session file. How the total splits is an estimate: the first request is the setup, and what was added since is shared between conversation and tool calls by how much text each wrote."
            : c.reported
              ? "Claude Code's own breakdown from the last /context run, plus what was added since (counted as messages). The window size is the one Claude Code reported."
              : `The total is Claude Code's own count. How it splits is an estimate. Run /context in the session to see Claude Code's exact breakdown here.${c.windowAuto ? " The window size is a guess from the model and the largest context seen; pin it in Settings if it is wrong." : ""}`}
        </p>
      </div>
    </div>
  );
}
