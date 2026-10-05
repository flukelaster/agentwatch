import { useSyncExternalStore } from "react";
import { isTauri } from "./native";

/**
 * Updates. The one request AgentWatch makes of its own: it asks GitHub Releases for `latest.json`, and installs a
 * build only if its signature matches the key built into the app. Nothing about the user or their sessions is sent.
 * The check itself runs in the Tauri shell (Rust); in a plain browser every call degrades to "not available".
 */

export type UpdatePhase = "idle" | "checking" | "uptodate" | "available" | "downloading" | "ready" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** The version offered (available / downloading / ready). */
  version?: string;
  notes?: string;
  /** 0..1 while downloading; undefined when the size is not known. */
  progress?: number;
  error?: string;
  checkedAt?: number;
}

const AUTO_KEY = "agentwatch.autoUpdateCheck";
const FIRST_CHECK_MS = 8_000;
const RECHECK_MS = 6 * 60 * 60_000;

/** The slice of the plugin's `Update` object that is used, so the rest can be tested without Tauri. */
interface PendingUpdate {
  version: string;
  body?: string;
  downloadAndInstall(onEvent?: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void): Promise<void>;
}

let state: UpdateState = { phase: "idle" };
let pending: PendingUpdate | undefined;
const listeners = new Set<() => void>();
let timers: ReturnType<typeof setTimeout>[] = [];

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function getUpdateState(): UpdateState {
  return state;
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Whether the app may look for updates by itself. On unless the user turned it off (kept on this Mac only). */
export function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutoCheck(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "on" : "off");
  } catch {
    /* private mode: the choice just does not stick */
  }
  if (!on) stopAutoCheck();
  for (const l of listeners) l();
}

export async function appVersion(): Promise<string | undefined> {
  if (!isTauri()) return undefined;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return undefined;
  }
}

export async function checkForUpdate(): Promise<void> {
  if (!isTauri()) {
    set({ phase: "error", error: "Updates are only available in the AgentWatch app." });
    return;
  }
  if (state.phase === "checking" || state.phase === "downloading" || state.phase === "ready") return;
  set({ phase: "checking", error: undefined });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (update) {
      pending = update;
      set({ phase: "available", version: update.version, notes: update.body ?? undefined, checkedAt: Date.now() });
    } else {
      pending = undefined;
      set({ phase: "uptodate", version: undefined, notes: undefined, checkedAt: Date.now() });
    }
  } catch (e) {
    set({ phase: "error", error: e instanceof Error ? e.message : String(e), checkedAt: Date.now() });
  }
}

export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update || state.phase !== "available") return;
  set({ phase: "downloading", progress: undefined, error: undefined });
  let total = 0;
  let got = 0;
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data?.contentLength ?? 0;
      else if (e.event === "Progress") {
        got += e.data?.chunkLength ?? 0;
        if (total > 0) set({ progress: Math.min(1, got / total) });
      }
    });
    set({ phase: "ready", progress: 1 });
  } catch (e) {
    set({ phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/** Start the new build. The shell stops the daemon first, then restarts the app. */
export async function relaunchApp(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("relaunch");
}

/** Look once shortly after the dashboard opens, then every few hours while it stays open. Idempotent. */
export function startAutoCheck(): void {
  if (!isTauri() || !autoCheckEnabled() || timers.length) return;
  const tick = (): void => {
    if (!autoCheckEnabled()) return;
    void checkForUpdate();
    timers = [setTimeout(tick, RECHECK_MS)];
  };
  timers = [setTimeout(tick, FIRST_CHECK_MS)];
}

export function stopAutoCheck(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

/** Test seam. */
export function resetUpdaterForTests(next: UpdateState = { phase: "idle" }, update?: PendingUpdate): void {
  stopAutoCheck();
  state = next;
  pending = update;
  for (const l of listeners) l();
}
