import { useEffect, useState } from "react";
import { Panel } from "./ui";
import { appVersion, autoCheckEnabled, checkForUpdate, installUpdate, relaunchApp, setAutoCheck, useUpdateState } from "../lib/updater";

function statusText(u: ReturnType<typeof useUpdateState>): string {
  switch (u.phase) {
    case "checking":
      return "Checking GitHub for a newer version…";
    case "uptodate":
      return "You are on the latest version.";
    case "available":
      return `Version ${u.version} is available.`;
    case "downloading":
      return u.progress === undefined ? `Downloading ${u.version}…` : `Downloading ${u.version}… ${Math.round(u.progress * 100)}%`;
    case "ready":
      return `Version ${u.version} is installed. Restart AgentWatch to use it.`;
    case "error":
      return `Could not check for updates: ${u.error ?? "unknown error"}`;
    default:
      return "Looks for a newer signed build on GitHub Releases. Nothing about you or your sessions is sent.";
  }
}

/** Settings → UPDATES. Only shown inside the app. */
export function UpdatesPanel() {
  const u = useUpdateState();
  const [version, setVersion] = useState<string | undefined>();
  const [auto, setAuto] = useState(autoCheckEnabled);
  useEffect(() => {
    void appVersion().then(setVersion);
  }, []);
  const busy = u.phase === "checking" || u.phase === "downloading";

  return (
    <Panel title="UPDATES" right={<span className="group-note">signed builds from GitHub Releases</span>}>
      <div className="setting">
        <div className="setting__text">
          <span className="setting__label">AgentWatch{version ? ` ${version}` : ""}</span>
          <span className="setting__desc" role={u.phase === "error" ? "alert" : "status"}>
            {statusText(u)}
          </span>
          {u.phase === "available" && u.notes && <span className="setting__hint">{u.notes}</span>}
        </div>
        <div className="setting__ctl">
          {u.phase === "available" ? (
            <button type="button" className="btn btn--primary" onClick={() => void installUpdate()}>
              Install {u.version}
            </button>
          ) : u.phase === "ready" ? (
            <button type="button" className="btn btn--primary" onClick={() => void relaunchApp()}>
              Restart now
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={() => void checkForUpdate()}>
              Check for updates
            </button>
          )}
        </div>
      </div>
      <div className="setting">
        <div className="setting__text">
          <span className="setting__label">Check automatically</span>
          <span className="setting__desc">Looks when the dashboard opens and every few hours after. This is the only request AgentWatch makes; turn it off to update by hand.</span>
        </div>
        <div className="setting__ctl">
          <span className={`switch-state${auto ? " switch-state--on" : ""}`} aria-hidden="true">
            {auto ? "on" : "off"}
          </span>
          <button
            type="button"
            role="switch"
            className="switch"
            aria-checked={auto}
            aria-label="Check for updates automatically"
            onClick={() => {
              setAutoCheck(!auto);
              setAuto(!auto);
            }}
          />
        </div>
      </div>
    </Panel>
  );
}

/** A one-line notice above the page when a newer build is waiting. */
export function UpdateBanner() {
  const u = useUpdateState();
  if (u.phase !== "available" && u.phase !== "ready" && u.phase !== "downloading") return null;
  return (
    <section className="panel" role="status" aria-label="Update">
      <div className="callout" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", gap: 16 }}>
        <p style={{ color: "inherit" }}>{statusText(u)}</p>
        {u.phase === "available" && (
          <button type="button" className="btn btn--primary" onClick={() => void installUpdate()}>
            Install and restart
          </button>
        )}
        {u.phase === "ready" && (
          <button type="button" className="btn btn--primary" onClick={() => void relaunchApp()}>
            Restart now
          </button>
        )}
      </div>
    </section>
  );
}
