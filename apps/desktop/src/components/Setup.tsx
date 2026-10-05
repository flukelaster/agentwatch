import { useState, type ReactNode } from "react";
import { ProviderIcon, UiIcon } from "./icons";
import { STATE_TEXT, isAgentItem, itemInfos, useSetup, type Item, type ItemInfo, type ItemResultView, type ItemState } from "../lib/setup";
import "../styles/setup.css";

export function StateChip({ state }: { state: ItemState }) {
  return <span className={`chipstate chipstate--${state}`}>{STATE_TEXT[state]}</span>;
}

export function ResultList({ results }: { results: ItemResultView[] }) {
  return (
    <div role="status" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {results.map((r) => (
        <div key={r.item} className={`setupresult ${r.ok ? "setupresult--ok" : "setupresult--fail"}`}>
          <span>
            <b>{r.ok ? (r.changed ? "Done" : "Already set up") : "Could not do this"}</b> · {r.item}
          </span>
          <span>{r.ok ? r.message : r.error}</span>
          {r.backup && <small>Backup of your previous file: {r.backup}</small>}
        </div>
      ))}
    </div>
  );
}

export function SetupRow({ info, busy, onApply, onRevert, extra }: { info: ItemInfo; busy: boolean; onApply: (i: Item) => void; onRevert: (i: Item) => void; extra?: ReactNode }) {
  const installed = info.state === "installed";
  return (
    <div className="setuprow">
      <div className="setuprow__text">
        <span className="setuprow__title">
          <span className="setuprow__brand" aria-hidden="true">
            {info.item === "claude" ? <ProviderIcon provider="claude-code" size={18} /> : info.item === "codex" ? <ProviderIcon provider="codex" size={18} /> : info.item === "gemini" ? <ProviderIcon provider="gemini-cli" size={18} /> : info.item === "antigravity" ? <ProviderIcon provider="antigravity" size={18} /> : info.item === "cursor" ? <ProviderIcon provider="cursor" size={18} /> : info.item === "cli" ? <UiIcon name="terminal" size={18} /> : <UiIcon name="activity" size={18} />}
          </span>
          {info.title}
          <StateChip state={info.state} />
        </span>
        <span className="setuprow__desc">{info.desc}</span>
        <span className="setuprow__target">Changes: {info.target}</span>
        {info.note && <span className="setuprow__note">{info.note}</span>}
        {extra}
      </div>
      <div className="setuprow__actions">
        {installed && (
          <button type="button" className="btn" disabled={busy} onClick={() => onRevert(info.item)} aria-label={`Remove ${info.title}`}>
            Remove
          </button>
        )}
        {!installed && (
          <button type="button" className="btn btn--primary" disabled={busy || !info.available} onClick={() => onApply(info.item)} aria-label={`${info.state === "outdated" ? "Update" : "Install"} ${info.title}`}>
            {info.state === "outdated" ? "Update" : "Install"}
          </button>
        )}
      </div>
    </div>
  );
}

const DISMISSED_KEY = "aw.banner.dismissed";

/** The agents whose "not connected yet" notice the person has closed. Storage can be missing or blocked: then the notice just comes back. */
function readDismissed(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Shown on the Overview when an agent is installed on this Mac but not connected yet: one click fixes it.
 * It can be closed. A closed notice stays closed for those agents; it only comes back for an agent it has not named before.
 */
export function SetupBanner() {
  const setup = useSetup();
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [resultsHidden, setResultsHidden] = useState(false);
  const s = setup.status;
  if (!s) return null;
  const todo = itemInfos(s).filter((i) => isAgentItem(i.item) && i.detected && i.state !== "installed" && i.available && !dismissed.includes(i.item));
  const showResults = !!setup.results && !resultsHidden;
  if (todo.length === 0 && !showResults) return null;
  const close = () => {
    if (todo.length === 0) return setResultsHidden(true);
    const next = [...new Set([...dismissed, ...todo.map((t) => t.item)])];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    } catch {
      /* the notice returns next time; nothing is lost */
    }
  };
  const names = todo.map((t) => t.title).join(todo.length > 2 ? ", " : " and ");
  return (
    <section className="panel" aria-label="Connect your agents">
      <div className="banner">
        <div className="banner__text">
          {todo.length > 0 ? (
            <>
              <b>{names} {todo.length > 1 ? "are" : "is"} not connected yet</b>
              <span>AgentWatch will not see {names} until its hooks are added. Your settings file is backed up first, and prompts are never stored.</span>
            </>
          ) : (
            <>
              <b>Connected</b>
              <span>Start a new session in your agent to see it here. Sessions that were already open will not appear.</span>
            </>
          )}
          {showResults && <ResultList results={setup.results!} />}
          {setup.actionError && <span className="tone-fail" role="alert">{setup.actionError}</span>}
        </div>
        <div className="banner__actions">
          {todo.length > 0 && (
            <button type="button" className="btn btn--primary btn--lg" disabled={setup.busy} onClick={() => void setup.apply(todo.map((t) => t.item)).catch(() => undefined)}>
              {setup.busy ? "Connecting…" : `Connect ${names}`}
            </button>
          )}
          <button type="button" className="btn btn--lg" onClick={close}>
            {todo.length > 0 ? "Not now" : "Dismiss"}
          </button>
        </div>
      </div>
    </section>
  );
}
