import type { CSSProperties, ReactNode } from "react";
import type { Confidence } from "@agentwatch/protocol";
import { confBars, confLabel } from "../lib/format";
import { UiIcon, type UiIconName } from "./icons";

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10" cy="10" r="8.25" />
      <path d="M3.5 10.5h3l1.8-4 3 7 1.7-3h3.5" />
    </svg>
  );
}

export function LockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Dot({ tone }: { tone?: "run" | "ask" | "fail" | "muted" }) {
  return <span className={`dot${tone && tone !== "muted" ? ` dot--${tone}` : ""}`} aria-hidden="true" />;
}

/** "+210 −0": additions green, deletions red, and a dash when nothing changed. */
export function DiffStat({ diff }: { diff: { additions: number; deletions: number } }) {
  if (!diff.additions && !diff.deletions) return <span className="diff diff__none">—</span>;
  return (
    <span className="diff">
      <span className="diff__add">+{diff.additions}</span> <span className="diff__del">−{diff.deletions}</span>
    </span>
  );
}

export function Conf({ level }: { level: Confidence }) {
  return (
    <span className={`conf conf--${level}`} title={`${confLabel[level]} confidence`}>
      <span className="conf__bars" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <i key={i} className={i < confBars[level] ? "on" : ""} />
        ))}
      </span>
      <span className="conf__label">{confLabel[level]}</span>
    </span>
  );
}

export function Panel({ title, right, children, foot, label, style, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; foot?: ReactNode; label?: string; style?: CSSProperties; className?: string }) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`} aria-label={label ?? (typeof title === "string" ? title : undefined)} style={style}>
      {(title || right) && (
        <div className="panel__head">
          <span className="panel__title">{title}</span>
          {right}
        </div>
      )}
      {children}
      {foot && <div className="panel__foot">{foot}</div>}
    </section>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

export function Chips<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: ChipOption<T>[] }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="chip" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <small>{o.count}</small>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/**
 * A screen with nothing to show says what it is for, why it is empty and what to do next. `compact` is for
 * small spots (a tab inside a panel); `action` is a link, never a hidden side effect.
 */
const RADAR_SECONDS = 5; // one sweep; the stylesheet uses the same number
/** [angle in degrees clockwise from the top, distance from the centre as a fraction of the radius]. A blip lights when the sweep passes its angle. */
const BLIPS: ReadonlyArray<readonly [number, number]> = [[52, 0.74], [168, 0.86], [285, 0.62]];

export type EmptyTone = "run" | "ask" | "fail" | "done";

/**
 * A radar sweeping an empty field, the icon at its centre: "AgentWatch is looking, nothing there yet".
 * Pure CSS and decorative; under prefers-reduced-motion it stands still. The blips light up only as the sweep passes
 * them and fade, so nothing here reads as something found.
 */
export function Radar({ icon, size, tone }: { icon: UiIconName; size: number; tone?: EmptyTone }) {
  return (
    <span className={`radar${tone ? ` radar--${tone}` : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <i className="radar__ring radar__ring--1" />
      <i className="radar__ring radar__ring--2" />
      <i className="radar__ring radar__ring--3" />
      <i className="radar__cross" />
      <i className="radar__sweep" />
      {BLIPS.map(([deg, r]) => (
        <i key={deg} className="radar__blip" style={{ ["--a" as string]: `${deg}deg`, ["--r" as string]: r, ["--d" as string]: `${((deg / 360) * RADAR_SECONDS).toFixed(2)}s` }} />
      ))}
      <span className="radar__core">
        <UiIcon name={icon} size={Math.round(size * 0.2)} />
      </span>
    </span>
  );
}

export function EmptyState({ icon, title, hint, action, compact, hero, visual, tone }: { icon: UiIconName; title: string; hint?: ReactNode; action?: { label: string; href: string }; compact?: boolean; /** Alone in the middle of the screen: big. */ hero?: boolean; visual?: "radar"; tone?: EmptyTone }) {
  return (
    <div className={`estate${compact ? " estate--compact" : ""}${hero ? " estate--hero" : ""}`} role="status">
      {visual === "radar" ? (
        <Radar icon={icon} size={hero ? 220 : compact ? 92 : 128} tone={tone} />
      ) : (
        <span className="estate__icon" aria-hidden="true">
          <UiIcon name={icon} size={compact ? 18 : 22} />
        </span>
      )}
      <b className="estate__title">{title}</b>
      {hint && <span className="estate__hint">{hint}</span>}
      {action && (
        <a className="estate__action" href={action.href}>
          {action.label}
        </a>
      )}
    </div>
  );
}

export const toneClass = (tone: string | undefined): string => (tone === "fail" ? "tone-fail" : tone === "ask" ? "tone-ask" : tone === "run" ? "tone-run" : "tone-muted");

export const NAV: Array<{ label: string; path: string; d: string }> = [
  { label: "Overview", path: "/", d: "M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5z" },
  { label: "Sessions", path: "/sessions", d: "M2.5 4h11M2.5 8h11M2.5 12h11" },
  { label: "Agents", path: "/agents", d: "M8 3v4M3.5 13V10.5h9V13M8 7v3.5M6 3h4" },
  { label: "Files", path: "/files", d: "M4 2.5h5l3 3V13.5H4zM9 2.5v3h3" },
  { label: "Commands", path: "/commands", d: "M3 4.5l3.5 3.5L3 11.5M8 12h5" },
  { label: "Logs", path: "/logs", d: "M3 3.5h10M3 6.5h7M3 9.5h10M3 12.5h5" },
  { label: "Settings", path: "/settings", d: "M3 5h6M11 5h2M3 11h2M7 11h6M9 3v4M5 9v4" },
];
