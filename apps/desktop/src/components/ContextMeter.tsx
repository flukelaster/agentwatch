import type { SessionView } from "@agentwatch/protocol";
import { readsContext, tokens } from "../lib/format";

/** The meter in the stats row asks the graph panel to open its Context tab. */
export const OPEN_CONTEXT_EVENT = "aw:open-context";
import "../styles/context.css";

/** How full a session's context window is: the total is the provider's count, the split is an estimate. */
export function contextLevel(used: number, window: number): "ok" | "warn" | "crit" {
  const pct = window > 0 ? used / window : 0;
  return pct >= 0.9 ? "crit" : pct >= 0.75 ? "warn" : "ok";
}

export function ContextMeter({ session, tracking }: { session: SessionView; tracking?: boolean }) {
  const c = session.usage?.context;
  if (!c) {
    const why = !readsContext(session.provider) ? "not reported" : tracking === false ? "tracking off" : "not read yet";
    return (
      <div className="stat ctx">
        <span className="label">Context</span>
        <b className="ctx__none">{why}</b>
      </div>
    );
  }
  const window = Math.max(c.window, 1);
  const pct = (n: number) => Math.min(100, (n / window) * 100);
  const left = Math.max(0, window - c.used);
  const level = contextLevel(c.used, window);
  const shown = Math.round((c.used / window) * 100);
  const title = [
    `${c.used.toLocaleString("en-US")} of ${window.toLocaleString("en-US")} tokens in the window (the provider's own count).`,
    `Setup (system prompt, tools, memory): ${tokens(c.setup)}`,
    `Conversation: ${tokens(c.conversation)} · Tool calls and results: ${tokens(c.tools)}`,
    "The split of what was added after the setup is an estimate, from how much text each part added.",
    c.windowAuto ? "The window size is a guess from the model and the largest context seen. Pin it in Settings if it is wrong." : "Window size set in Settings.",
  ].join("\n");
  const open = () => globalThis.dispatchEvent(new CustomEvent(OPEN_CONTEXT_EVENT));
  return (
    <div
      className={`stat ctx ctx--${level}`}
      title={`${title}\n\nClick for the breakdown.`}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <span className="label">Context</span>
      <div className="ctx__bar" role="meter" aria-label="Context window" aria-valuemin={0} aria-valuemax={window} aria-valuenow={Math.min(c.used, window)} aria-valuetext={`${shown}% used, ${tokens(left)} left`}>
        <i className="ctx__seg ctx__seg--setup" style={{ width: `${pct(c.setup)}%` }} />
        <i className="ctx__seg ctx__seg--chat" style={{ width: `${pct(c.conversation)}%` }} />
        <i className="ctx__seg ctx__seg--tools" style={{ width: `${pct(c.tools)}%` }} />
      </div>
      <b>
        {tokens(c.used)}
        <span className="ctx__of"> / {c.windowAuto ? "≈" : ""}{tokens(window)}</span>
        <span className="ctx__pct">{shown}%</span>
      </b>
      <span className="stat__sub ctx__legend">
        <span className="ctx__key ctx__key--setup">setup {tokens(c.setup)}</span>
        <span className="ctx__key ctx__key--chat">chat {tokens(c.conversation)}</span>
        <span className="ctx__key ctx__key--tools">tools {tokens(c.tools)}</span>
        <span className="ctx__left">{tokens(left)} left</span>
      </span>
    </div>
  );
}
