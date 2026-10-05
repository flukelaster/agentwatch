import { useCallback, useMemo, useState } from "react";
import { useDaemon, useQuery } from "./context";

export type Item = "claude" | "codex" | "gemini" | "antigravity" | "cursor" | "cli" | "autostart";
export const ALL_ITEMS: readonly Item[] = ["claude", "codex", "gemini", "antigravity", "cursor", "cli", "autostart"];

/** The agents connected through a hooks file (the rest of the items are AgentWatch's own setup). */
export const AGENT_ITEMS: readonly Item[] = ["claude", "codex", "gemini", "antigravity", "cursor"];
export const isAgentItem = (item: Item): boolean => AGENT_ITEMS.includes(item);

export type HooksState = "installed" | "outdated" | "missing" | "unreadable";
export type FileState = "installed" | "outdated" | "missing" | "conflict" | "unavailable";

export interface SetupStatusView {
  claude: { detected: boolean; hooks: { state: HooksState; path: string; foreign: string[] } };
  codex: { detected: boolean; hooks: { state: HooksState; path: string; foreign: string[] } };
  gemini: { detected: boolean; hooks: { state: HooksState; path: string; foreign: string[] } };
  antigravity: { detected: boolean; hooks: { state: HooksState; path: string; foreign: string[] } };
  cursor: { detected: boolean; hooks: { state: HooksState; path: string; foreign: string[] } };
  cli: { state: FileState; path: string; dirOnPath: boolean; note?: string };
  autostart: { state: FileState; path: string; note?: string };
  managed: boolean;
}

export interface ItemResultView {
  item: Item;
  ok: boolean;
  changed: boolean;
  message: string;
  backup?: string;
  error?: string;
}

export type ItemState = HooksState | FileState;

export interface ItemInfo {
  item: Item;
  title: string;
  desc: string;
  state: ItemState;
  /** The file that gets changed, shown before anything is touched. */
  target: string;
  /** Can this item be applied here at all? */
  available: boolean;
  /** Agents only: was the tool found on this Mac? */
  detected?: boolean;
  note?: string;
}

export const STATE_TEXT: Record<ItemState, string> = {
  installed: "Installed",
  outdated: "Needs update",
  missing: "Not set up",
  conflict: "Blocked",
  unreadable: "Can't read file",
  unavailable: "Not available here",
};

/** /Users/me/.claude/x -> ~/.claude/x. Paths that are not under a home directory are shown as they are. */
export function tildePath(path: string): string {
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/.exec(path);
  return m ? `~${m[2] ?? ""}` : path;
}

export function itemInfos(s: SetupStatusView): ItemInfo[] {
  const cli = s.cli;
  const hint = cli.note ?? (cli.state === "installed" && !cli.dirOnPath ? "Add ~/.local/bin to your PATH to use it: export PATH=\"$HOME/.local/bin:$PATH\"" : cli.state === "conflict" ? "A different file already exists there and was left alone." : undefined);
  return [
    { item: "claude", title: "Claude Code", desc: "Lets Claude Code sessions, tools and subagents appear here. File contents are never stored; prompt and reply text is kept only if you turn it on under Privacy.", state: s.claude.hooks.state, target: tildePath(s.claude.hooks.path), available: s.claude.hooks.state !== "unreadable", detected: s.claude.detected, note: s.claude.detected ? undefined : "Claude Code was not found on this Mac." },
    { item: "codex", title: "Codex", desc: "Lets Codex sessions appear here. Prompts and assistant text are never stored.", state: s.codex.hooks.state, target: tildePath(s.codex.hooks.path), available: s.codex.hooks.state !== "unreadable", detected: s.codex.detected, note: !s.codex.detected ? "Codex was not found on this Mac." : s.codex.hooks.state === "installed" ? "Codex only runs hooks you have reviewed: open Codex and run /hooks once to trust the AgentWatch ones." : undefined },
    { item: "gemini", title: "Gemini CLI", desc: "Lets Gemini CLI sessions, tool calls, commands and file edits appear here. Prompts and replies are never read.", state: s.gemini.hooks.state, target: tildePath(s.gemini.hooks.path), available: s.gemini.hooks.state !== "unreadable", detected: s.gemini.detected, note: s.gemini.detected ? "Your existing Gemini hooks are kept." : "Gemini CLI was not found on this Mac." },
    { item: "antigravity", title: "Antigravity CLI", desc: "Lets Antigravity CLI (agy) sessions, tool calls and commands appear here. Prompts and replies are never read.", state: s.antigravity.hooks.state, target: tildePath(s.antigravity.hooks.path), available: s.antigravity.hooks.state !== "unreadable", detected: s.antigravity.detected, note: s.antigravity.detected ? "Your existing Antigravity hooks are kept." : "Antigravity CLI was not found on this Mac." },
    { item: "cursor", title: "Cursor", desc: "Lets Cursor agent sessions, tool calls, shell commands and file edits appear here. Prompts and replies are never read.", state: s.cursor.hooks.state, target: tildePath(s.cursor.hooks.path), available: s.cursor.hooks.state !== "unreadable", detected: s.cursor.detected, note: s.cursor.detected ? "Your existing Cursor hooks are kept. Restart Cursor after installing." : "Cursor was not found on this Mac." },
    { item: "cli", title: "Command line", desc: "Adds the agentwatch command so you can monitor any agent: agentwatch run -- <agent>.", state: cli.state, target: tildePath(cli.path), available: cli.state !== "unavailable" && cli.state !== "conflict", note: hint },
    { item: "autostart", title: "Start at login", desc: "AgentWatch starts quietly in the menu bar when you log in, so monitoring is always on.", state: s.autostart.state, target: tildePath(s.autostart.path), available: s.autostart.state !== "unavailable", note: s.autostart.note },
  ];
}

export interface UseSetup {
  status: SetupStatusView | undefined;
  loading: boolean;
  error: string | undefined;
  busy: boolean;
  actionError: string | undefined;
  results: ItemResultView[] | undefined;
  refresh: () => void;
  apply: (items: readonly Item[]) => Promise<ItemResultView[]>;
  revert: (items: readonly Item[]) => Promise<ItemResultView[]>;
}

/** What is installed, and the two actions that change it. The daemon does the work and reports each item. */
export function useSetup(): UseSetup {
  const { client } = useDaemon();
  const q = useQuery<SetupStatusView>("setupStatus", undefined, { live: false });
  const [fresh, setFresh] = useState<SetupStatusView | undefined>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [results, setResults] = useState<ItemResultView[] | undefined>();

  const run = useCallback(
    async (name: "setupApply" | "setupRevert", items: readonly Item[]): Promise<ItemResultView[]> => {
      setBusy(true);
      setActionError(undefined);
      try {
        const out = await client.command<{ results: ItemResultView[]; status: SetupStatusView }>(name, { items: [...items] });
        setFresh(out.status);
        setResults(out.results);
        return out.results;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        setActionError(msg);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  return useMemo(
    () => ({
      status: fresh ?? q.data,
      loading: q.loading && !fresh,
      error: q.error,
      busy,
      actionError,
      results,
      refresh: q.refresh,
      apply: (items) => run("setupApply", items),
      revert: (items) => run("setupRevert", items),
    }),
    [fresh, q.data, q.loading, q.error, q.refresh, busy, actionError, results, run],
  );
}
