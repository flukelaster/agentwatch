import { useState } from "react";
import { ResultList, StateChip } from "../components/Setup";
import { LockIcon, Logo } from "../components/ui";
import { useLive } from "../lib/context";
import { ALL_ITEMS, isAgentItem, itemInfos, useSetup, type Item } from "../lib/setup";
import "../styles/onboarding.css";

function markOnboarded(): void {
  try {
    localStorage.setItem("aw.onboarded", "1");
  } catch {
    /* storage unavailable: the setup screen may show again, which is harmless */
  }
}

const openDashboard = () => {
  window.location.hash = "#/";
};

export function Onboarding() {
  const live = useLive();
  const setup = useSetup();
  const [picked, setPicked] = useState<ReadonlySet<Item> | undefined>();
  const [finished, setFinished] = useState(false);

  const infos = setup.status ? itemInfos(setup.status) : [];
  // Pre-selected: everything that can be set up here and whose tool is actually on this Mac.
  const defaults = infos.filter((i) => i.available && i.state !== "installed" && i.detected !== false).map((i) => i.item);
  const chosen: ReadonlySet<Item> = picked ?? new Set(defaults);

  const toggle = (item: Item) => {
    const next = new Set(chosen);
    if (!next.delete(item)) next.add(item);
    setPicked(next);
  };

  const finish = async () => {
    markOnboarded();
    if (chosen.size) await setup.apply(ALL_ITEMS.filter((i) => chosen.has(i))).catch(() => undefined); // fixed order, whatever order they were ticked in
    setFinished(true);
  };

  const head = (
    <div className="ob__head">
      <div className="ob__brand">
        <Logo size={22} />
        <span className="brand__name">AGENTWATCH</span>
      </div>
      <h1>{finished ? "You are set" : "Set up AgentWatch"}</h1>
      {!finished && <p className="ob__lead">See what the AI agents on this Mac are doing, what they just did, and what changed. Nothing leaves your computer and prompts are not stored. One click connects everything below.</p>}
    </div>
  );

  if (finished) {
    const results = setup.results ?? [];
    const hooked = results.some((r) => r.ok && isAgentItem(r.item));
    return (
      <main className="ob">
        {head}
        <div className="ob__done" role="status">
          {results.length === 0 && <p>Nothing was changed. You can set things up any time in Settings.</p>}
          {results.length > 0 && <ResultList results={results} />}
          {setup.actionError && <p className="tone-fail" role="alert">{setup.actionError}</p>}
          {hooked && <p>Start a new session in your agent to see it here. Sessions that were already open will not appear.</p>}
        </div>
        <div className="ob__foot">
          <span className="ob__note">
            <LockIcon />
            Change or undo any of this in Settings.
          </span>
          <button type="button" className="ob__go" onClick={openDashboard}>
            Open dashboard
          </button>
        </div>
      </main>
    );
  }

  const connected = live.status === "connected";
  const allDone = infos.length > 0 && infos.every((i) => i.state === "installed" || !i.available);

  return (
    <main className="ob">
      {head}
      <fieldset className="ob__opts" aria-busy={!setup.status}>
        <legend className="sr-only">What to set up</legend>
        {!setup.status && <p className="ob__lead">{connected ? "Checking this Mac…" : "Starting AgentWatch…"}</p>}
        {setup.error && !setup.status && <p className="tone-fail" role="alert">Could not read the setup state: {setup.error}</p>}
        {infos.map((i) => {
          const done = i.state === "installed";
          const off = !i.available || done;
          return (
            <div key={i.item} className={`ob__opt${chosen.has(i.item) ? " ob__opt--on" : ""}`}>
              <input id={`ob-${i.item}`} type="checkbox" checked={done || chosen.has(i.item)} disabled={off || setup.busy} onChange={() => toggle(i.item)} />
              <label htmlFor={`ob-${i.item}`}>
                <span className="ob__opt-title">
                  {i.title} <StateChip state={i.state} />
                </span>
                <span className="ob__opt-desc">{i.desc}</span>
                <span className="ob__opt-desc mono">Changes: {i.target}. Your file is backed up first.</span>
                {i.note && <span className="ob__opt-desc tone-ask">{i.note}</span>}
              </label>
            </div>
          );
        })}
      </fieldset>

      <div className="ob__foot">
        <span className="ob__note">
          <LockIcon />
          Nothing is changed until you press the button. Undo any of it in Settings.
        </span>
        <div className="ob__actions">
          <button
            type="button"
            className="ob__skip"
            onClick={() => {
              markOnboarded();
              openDashboard();
            }}
          >
            Skip for now
          </button>
          <button type="button" className="ob__go" disabled={!setup.status || setup.busy} onClick={() => void finish()}>
            {setup.busy ? "Setting up…" : allDone ? "Open dashboard" : chosen.size ? `Set up (${chosen.size})` : "Continue"}
          </button>
        </div>
      </div>
    </main>
  );
}
