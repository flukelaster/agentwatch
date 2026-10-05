import { countLines } from "@agentwatch/adapter-sdk";

export interface PatchFileStat {
  path: string;
  op: "add" | "update" | "delete";
  additions: number;
  deletions: number;
}

/**
 * Reads an apply_patch body (or a unified diff string) and returns per-file metadata ONLY.
 * The patch text itself is never returned or stored.
 */
export function summarizePatch(text: unknown): PatchFileStat[] {
  if (typeof text !== "string") return [];
  const out: PatchFileStat[] = [];
  let cur: PatchFileStat | undefined;
  for (const line of text.split("\n")) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (head) {
      cur = { path: head[2]!.trim(), op: head[1] === "Add" ? "add" : head[1] === "Delete" ? "delete" : "update", additions: 0, deletions: 0 };
      out.push(cur);
      continue;
    }
    if (!cur || line.startsWith("***")) continue;
    if (line.startsWith("+")) cur.additions += 1;
    else if (line.startsWith("-")) cur.deletions += 1;
  }
  return out;
}

/** +/- line counts of a unified diff string for one file. */
export function diffStat(diff: unknown): { additions: number; deletions: number } {
  if (typeof diff !== "string") return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export { countLines };
