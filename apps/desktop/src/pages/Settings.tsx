import { useCallback, useState, type ReactNode } from "react";
import type { Settings as SettingsData } from "@agentwatch/protocol";
import { PageHead, Panel } from "../components/ui";
import { ResultList, SetupRow } from "../components/Setup";
import { ThemePicker } from "../components/ThemePicker";
import { itemInfos, useSetup } from "../lib/setup";
import { useDaemon, useLive, useQuery } from "../lib/context";
import { saveTextFile } from "../lib/native";
import type { LogsResult } from "../lib/types";
import { buildDiagnosticsBundle, exportFilename } from "./Logs";
import "../styles/settings.css";

type WritableKey = "retentionDays" | "startAtLogin" | "claudeIntegration" | "codexIntegration" | "geminiIntegration" | "antigravityIntegration" | "cursorIntegration" | "cliInstalled" | "storePromptText" | "storeAssistantText" | "trackTokenUsage" | "contextWindow";

/**
 * The daemon only records these choices. The commands below are what actually changes the machine,
 * so the UI shows them instead of claiming the change happened.
 */

const RETENTION: Array<{ days: number; label: string }> = [
  { days: 0, label: "Session only" },
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
];

const CONTEXT_WINDOWS: Array<{ size: number; label: string }> = [
  { size: 0, label: "Auto" },
  { size: 200_000, label: "200k" },
  { size: 1_000_000, label: "1M" },
  { size: 2_000_000, label: "2M" },
];

const LOCKED_OFF: Array<{ label: string; desc: string }> = [
  { label: "Keep raw terminal transcript", desc: "Not implemented, always off. Terminal output is read live for status and is not saved." },
  { label: "Keep full Git patches", desc: "Not implemented, always off. Only +/− counts are stored; a patch is built when you open a diff." },
];

function Switch({ label, on, disabled, onChange, stateText }: { label: string; on: boolean; disabled?: boolean; onChange?: (v: boolean) => void; stateText?: string }) {
  return (
    <div className="setting__ctl">
      <span className={`switch-state${on ? " switch-state--on" : ""}`} aria-hidden="true">
        {stateText ?? (on ? "on" : "off")}
      </span>
      <button type="button" role="switch" className="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange?.(!on)} />
    </div>
  );
}

function Row({ label, desc, hint, code, control }: { label: string; desc: string; hint?: string; code?: string; control: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting__text">
        <span className="setting__label">{label}</span>
        <span className="setting__desc">{desc}</span>
        {hint && <span className="setting__hint">{hint}</span>}
        {code && <code className="code">{code}</code>}
      </div>
      {control}
    </div>
  );
}

export function Settings() {
  const { client } = useDaemon();
  const setup = useSetup();
  const live = useLive();
  const q = useQuery<SettingsData>("settings", undefined, { live: false });
  const [pending, setPending] = useState<Partial<SettingsData>>({});
  const [committed, setCommitted] = useState<Partial<SettingsData>>({});
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<"delete" | "export" | undefined>();
  const [wiped, setWiped] = useState(false);
  const [exported, setExported] = useState(false);

  const s: SettingsData | undefined = q.data ? { ...q.data, ...committed, ...pending } : undefined;

  const save = useCallback(
    async (key: WritableKey, value: boolean | number, what: string) => {
      setError(undefined);
      setPending((p) => ({ ...p, [key]: value }));
      try {
        await client.command("setSettings", { patch: { [key]: value } });
        setCommitted((c) => ({ ...c, [key]: value }));
      } catch (e) {
        setError(`Could not save “${what}”: ${e instanceof Error ? e.message : "unknown error"}. The setting was left as it was.`);
      } finally {
        setPending((p) => {
          const { [key]: _drop, ...rest } = p;
          return rest;
        });
      }
    },
    [client],
  );

  const deleteAll = async () => {
    setBusy("delete");
    setError(undefined);
    try {
      await client.command("deleteAllHistory");
      setWiped(true);
      setConfirm(false);
    } catch (e) {
      setError(`Could not delete history: ${e instanceof Error ? e.message : "unknown error"}. Nothing was removed.`);
    } finally {
      setBusy(undefined);
    }
  };

  const exportDiagnostics = async () => {
    setBusy("export");
    setError(undefined);
    setExported(false);
    try {
      const logs = await client.query<LogsResult>("logs");
      saveTextFile(exportFilename(), buildDiagnosticsBundle(logs.diagnostics, logs.events, live.daemonVersion));
      setExported(true);
    } catch (e) {
      setError(`Could not export diagnostics: ${e instanceof Error ? e.message : "unknown error"}.`);
    } finally {
      setBusy(undefined);
    }
  };

  const ready = !!s;
  const sw = (key: WritableKey, label: string) => <Switch label={label} on={!!s?.[key]} disabled={!ready} onChange={(v) => void save(key, v, label)} />;

  return (
    <>
      <PageHead title="Settings" sub="Anything that contains your words stays off until you turn it on. AgentWatch never leaves this Mac." />
      {q.error && !s && <div className="settings-alert" role="alert">Could not load settings: {q.error}</div>}
      {!s && !q.error && <p className="settings-status" role="status">Loading settings…</p>}
      {error && (
        <div className="settings-alert" role="alert">
          {error}
        </div>
      )}
      <div className="settings">
        <Panel title="CONNECTIONS" right={<span className="group-note">installed by the app, undone with one click</span>}>
          {setup.loading && !setup.status && <p className="settings-status" role="status" style={{ padding: "16px 18px" }}>Checking this Mac…</p>}
          {setup.error && !setup.status && <div className="settings-alert" role="alert">Could not read the setup state: {setup.error}</div>}
          {setup.actionError && <div className="settings-alert" role="alert">{setup.actionError}</div>}
          {setup.status &&
            itemInfos(setup.status).map((info) => (
              <SetupRow key={info.item} info={info} busy={setup.busy} onApply={(i) => void setup.apply([i]).catch(() => undefined)} onRevert={(i) => void setup.revert([i]).catch(() => undefined)} />
            ))}
          {setup.results && (
            <div style={{ padding: "12px 18px" }}>
              <ResultList results={setup.results} />
            </div>
          )}
        </Panel>

        <Panel title="APPEARANCE" right={<span className="group-note">applies at once, kept on this Mac</span>}>
          <ThemePicker />
        </Panel>

        <Panel title="PRIVACY" right={<span className="group-note">what gets written to disk</span>}>
          <Row
            label="Track token usage"
            desc="Records how many tokens each Claude Code session has used (fresh input, output and cache). AgentWatch reads only the token counts from Claude Code's conversation file; not a word of the conversation is kept. On by default; turn it off to stop reading the file for this."
            control={sw("trackTokenUsage", "Track token usage")}
          />
          <Row
            label="Store prompt text"
            desc="Shows what you asked in the Chat panel. AgentWatch reads Claude Code's own conversation file on this Mac and keeps the text of your prompts in its local database, credentials redacted. Off by default; turning it off deletes what was kept."
            control={sw("storePromptText", "Store prompt text")}
          />
          <Row
            label="Store assistant responses"
            desc="Shows the assistant's replies, as they are written, in the Chat panel. Read from the same conversation file and kept locally, credentials redacted. Off by default; turning it off deletes what was kept."
            control={sw("storeAssistantText", "Store assistant responses")}
          />
          {LOCKED_OFF.map((r) => (
            <Row key={r.label} label={r.label} desc={r.desc} control={<Switch label={r.label} on={false} disabled stateText="off · not implemented" />} />
          ))}
          <Row
            label="Redact credentials in commands and errors"
            desc="Applied before anything is saved, so a token in a command line never reaches the database."
            control={<Switch label="Redact credentials in commands and errors" on disabled stateText="always on" />}
          />
        </Panel>

        <Panel title="DATA" right={<span className="group-note">stored in ~/Library/Application Support/AgentWatch</span>}>
          <Row
            label="Keep event history for"
            desc="Older sessions are deleted automatically. Session only clears everything when a session ends."
            control={
              <div className="seg" role="group" aria-label="Keep event history for">
                {RETENTION.map((r) => (
                  <button key={r.days} type="button" disabled={!ready} aria-pressed={s?.retentionDays === r.days} onClick={() => void save("retentionDays", r.days, "Keep event history for")}>
                    {r.label}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            label="Context window size"
            desc="Claude Code does not say how big a session's context window is, so the Context meter works it out from the largest context it has seen. If that is wrong for your model, choose the size here."
            control={
              <div className="seg" role="group" aria-label="Context window size">
                {CONTEXT_WINDOWS.map((w) => (
                  <button key={w.size} type="button" disabled={!ready} aria-pressed={(s?.contextWindow ?? 0) === w.size} onClick={() => void save("contextWindow", w.size, "Context window size")}>
                    {w.label}
                  </button>
                ))}
              </div>
            }
          />
          <Row
            label="Delete all local history"
            desc={wiped ? "Done. All sessions, events, files and commands were deleted from this Mac." : confirm ? "This removes every session, event, file and command from this Mac. It cannot be undone." : "Removes every stored session, event, file and command."}
            control={
              <div className="setting__ctl">
                {confirm && !wiped && (
                  <button type="button" className="btn" onClick={() => setConfirm(false)} disabled={busy === "delete"}>
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  className={`btn${wiped ? "" : " btn--danger"}`}
                  disabled={wiped || busy === "delete"}
                  onClick={() => (confirm ? void deleteAll() : setConfirm(true))}
                >
                  {wiped ? "Deleted" : confirm ? "Yes, delete everything" : "Delete history…"}
                </button>
              </div>
            }
          />
          <Row
            label="Diagnostics"
            desc={exported ? "Saved a redacted bundle file on this Mac. Nothing was uploaded." : "Builds a redacted bundle as a file on this Mac. AgentWatch does not upload crash reports or analytics."}
            control={
              <button type="button" className="btn" disabled={busy === "export"} onClick={() => void exportDiagnostics()}>
                Export bundle
              </button>
            }
          />
        </Panel>
      </div>
    </>
  );
}
