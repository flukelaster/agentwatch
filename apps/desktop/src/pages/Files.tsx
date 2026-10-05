import { useMemo, useState } from "react";
import { Chips, Conf, Empty, EmptyState, PageHead, Panel } from "../components/ui";
import { clock } from "../lib/format";
import { useQuery } from "../lib/context";
import type { FileRowView } from "../lib/types";
import "../styles/files.css";

type FileFilter = "all" | "edit" | "read" | "none";

const PROVIDER_COLOR: Record<string, string> = { "claude-code": "var(--g-ed)", codex: "var(--g-c8)", generic: "var(--g-99)" };
const COLUMNS = "minmax(0,1.6fr) 110px 76px 84px 168px 150px 72px";

/** Only a provider report (not low confidence, with a named agent) may be attributed to an agent. */
export const isAttributed = (r: FileRowView): boolean => r.confidence !== "low" && !!r.agentName;

export function matchesFilter(r: FileRowView, f: FileFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "edit":
      return (r.operation === "write" || r.operation === "delete") && isAttributed(r);
    case "read":
      return r.operation === "read";
    case "none":
      return !isAttributed(r);
  }
}

function opLabel(r: FileRowView): string {
  if (r.operation === "read") return "Read";
  if (r.operation === "delete") return "Delete";
  if (r.operation === "dirty") return "Dirty";
  if (r.operation === "write") return isAttributed(r) ? "Edit" : "Changed";
  return r.operation;
}

function deltaText(r: FileRowView): string {
  if (r.operation === "dirty") return "at start";
  return r.additions || r.deletions ? `+${r.additions} −${r.deletions}` : "—";
}

export function Files() {
  const q = useQuery<FileRowView[]>("files");
  const [filter, setFilter] = useState<FileFilter>("all");
  const rows = useMemo(() => [...(q.data ?? [])].sort((a, b) => b.lastAt.localeCompare(a.lastAt)), [q.data]);
  const count = (f: FileFilter) => rows.filter((r) => matchesFilter(r, f)).length;
  const shown = rows.filter((r) => matchesFilter(r, filter));

  let body;
  if (q.error && !q.data) {
    body = (
      <div className="callout" role="alert">
        <h2>Could not load file activity</h2>
        <p>{q.error}</p>
        <button type="button" className="btn" onClick={q.refresh}>Try again</button>
      </div>
    );
  } else if (!q.data) {
    body = <Empty>{q.loading ? "Loading file activity…" : "File history is unavailable until agentwatchd is connected."}</Empty>;
  } else {
    body = (
      <div className="tablewrap">
        <div className="table" style={{ ["--cols" as string]: COLUMNS, ["--min" as string]: "960px" }}>
          <div className="tr tr--head">
            <span>Path</span><span>Session</span><span>Op</span><span>+ / −</span><span>Attributed to</span><span>Evidence</span><span>Last</span>
          </div>
          {shown.length === 0 && (rows.length === 0 ? <EmptyState icon="folder-open" title="No file activity yet" hint="Files an agent reads or edits are listed here, with who did it and how sure AgentWatch is." /> : <EmptyState icon="search" title="No files match this filter" hint="Try another provider or clear the search." compact />)}
          {shown.map((r, i) => {
            const who = isAttributed(r) ? r.agentName : undefined;
            return (
              <div key={`${r.sessionId}:${r.path}:${r.operation}:${i}`} className="tr tr--tall">
                <span className="fl-path">
                  <span className="fl-path__text" title={r.path}>{r.path}</span>
                </span>
                <span className="fl-session" style={{ color: PROVIDER_COLOR[r.provider] }} title={r.repo ?? r.sessionId}>{r.repo ?? r.sessionId.slice(0, 8)}</span>
                <span className="fl-op">{opLabel(r)}</span>
                <span className="fl-delta">{deltaText(r)}</span>
                <span className={`fl-who${who ? "" : " fl-who--none"}`}>{who ?? "not attributed"}</span>
                <span className="fl-evid">
                  <Conf level={r.confidence} />
                  <span className="fl-src">{r.operation === "dirty" && r.source === "git" ? "git baseline" : r.source}</span>
                </span>
                <span className="fl-last" title={r.lastAt}>{clock(r.lastAt).slice(0, 5)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHead title="Files" sub="What was read or changed. A provider report is shown separately from a change only observed on disk.">
        <Chips
          label="Filter files"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: count("all") },
            { value: "edit", label: "Edited", count: count("edit") },
            { value: "read", label: "Read", count: count("read") },
            { value: "none", label: "Not attributed", count: count("none") },
          ]}
        />
      </PageHead>
      <Panel label="File activity" foot="File contents are never stored. A change seen only by the file watcher proves the file changed, not who changed it.">
        {body}
      </Panel>
    </>
  );
}
