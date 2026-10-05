import type { AgentEvent } from "@agentwatch/protocol";

/** What main has been doing, counted from the live events: the numbers behind the Shell and Files chips. */
export interface Activity {
  shell: {
    /** Commands the agent ran through its shell tool (provider hooks / API). */
    total: number;
    running: number;
    failed: number;
    /** Child processes only the process sampler saw: lower confidence, never mixed into `total`. */
    observed: number;
  };
  files: {
    read: number;
    edited: number;
    deleted: number;
    /** Distinct files read, edited or deleted (a file read and then edited counts once). */
    touched: number;
    /** Changes only the file watcher or Git saw: not attributed to an agent. */
    changed: number;
  };
}

export const EMPTY_ACTIVITY: Activity = { shell: { total: 0, running: 0, failed: 0, observed: 0 }, files: { read: 0, edited: 0, deleted: 0, touched: 0, changed: 0 } };

const str = (e: AgentEvent, k: string): string | undefined => (typeof e.payload[k] === "string" ? (e.payload[k] as string) : undefined);

/** `live` is false once the session is not running: a command with no result then is unfinished, not running. */
export function summarizeActivity(events: readonly AgentEvent[], live: boolean): Activity {
  const started = new Set<string>();
  const done = new Map<string, number | undefined>();
  const observed = new Set<string>();
  const read = new Set<string>();
  const edited = new Set<string>();
  const deleted = new Set<string>();
  const changed = new Set<string>();

  for (const e of events) {
    if (e.kind === "command.started" || e.kind === "command.completed") {
      const id = str(e, "commandId") ?? e.id;
      if (e.source === "process") {
        if (e.kind === "command.started") observed.add(id);
      } else if (e.kind === "command.started") started.add(id);
      else {
        started.add(id);
        done.set(id, typeof e.payload.exitCode === "number" ? e.payload.exitCode : undefined);
      }
    }
    const path = str(e, "path");
    if (!path) continue;
    const seenOnly = e.confidence === "low" && (e.source === "filesystem" || e.source === "git");
    if (e.kind === "file.read") read.add(path);
    else if (e.kind === "file.write") (seenOnly ? changed : edited).add(path);
    else if (e.kind === "file.delete") deleted.add(path);
  }

  let failed = 0;
  for (const code of done.values()) if (code !== undefined && code !== 0) failed += 1;
  return {
    shell: { total: started.size, running: live ? [...started].filter((id) => !done.has(id)).length : 0, failed, observed: observed.size },
    files: { read: read.size, edited: edited.size, deleted: deleted.size, touched: new Set([...read, ...edited, ...deleted]).size, changed: changed.size },
  };
}
