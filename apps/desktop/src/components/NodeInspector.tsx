import type { Inspection } from "../lib/inspect";
import { Conf } from "./ui";
import "../styles/inspector.css";

const TONE_COLOR: Record<string, string> = { run: "var(--run)", done: "var(--done)", ask: "var(--ask)", fail: "var(--fail)" };
const OP_LABEL = { read: "read", edit: "edit", changed: "changed", deleted: "deleted" } as const;

/** The detail behind one graph node: facts, files, and what it did last. Hover previews it, a click pins it. */
export function NodeInspector({ info, pinned, onClear }: { info: Inspection; pinned: boolean; onClear: () => void }) {
  return (
    <section className="insp" aria-label={`Details: ${info.title}`} data-node-id={info.nodeId}>
      <header className="insp__head">
        <span className="insp__dot" style={{ background: TONE_COLOR[info.tone] ?? "var(--faint)" }} aria-hidden="true" />
        <b className="insp__title">{info.title}</b>
        {info.tag && <span className="insp__tag">{info.tag}</span>}
        <span className="insp__mode">{pinned ? "Pinned" : "Preview"}</span>
        {pinned && (
          <button type="button" className="insp__clear" onClick={onClear}>
            Unpin
          </button>
        )}
      </header>
      {info.note && <p className="insp__note">{info.note}</p>}
      <div className="insp__body">
        <dl className="insp__facts">
          {info.facts.map(([k, v]) => (
            <div key={k} className="insp__fact">
              <dt>{k}</dt>
              <dd title={v}>{v}</dd>
            </div>
          ))}
        </dl>
        <div className="insp__col">
          {info.members.length > 0 && (
            <>
              <h4>Agents</h4>
              <ul className="insp__list">
                {info.members.map((m, i) => (
                  <li key={`${m.name}${i}`}>
                    <span className="insp__dot" style={{ background: TONE_COLOR[m.tone] ?? "var(--faint)" }} aria-hidden="true" />
                    <span className="insp__cell">{m.name}</span>
                    <span className="insp__sub">{m.state}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {info.files.length > 0 && (
            <>
              <h4>Files</h4>
              <ul className="insp__list">
                {info.files.map((f) => (
                  <li key={f.path}>
                    <span className={`insp__op insp__op--${f.op}`}>{OP_LABEL[f.op]}</span>
                    <span className="insp__cell" title={f.path}>
                      {f.path}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <div className="insp__col insp__col--wide">
          <h4>Recent</h4>
          {info.recent.length === 0 ? (
            <p className="insp__empty">Nothing yet.</p>
          ) : (
            <ul className="insp__list insp__list--events">
              {info.recent.map((r) => (
                <li key={r.id} className={r.tone === "fail" ? "is-fail" : r.tone === "ask" ? "is-ask" : undefined}>
                  <span className="insp__time">{r.time}</span>
                  <span className="insp__kind">{r.kind}</span>
                  <span className="insp__cell" title={r.text}>
                    {r.text}
                  </span>
                  <Conf level={r.conf} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
