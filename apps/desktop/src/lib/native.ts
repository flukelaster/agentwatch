/** Thin bridge to the Tauri shell. In a plain browser every call degrades to something harmless. */

export function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

/** Bring the main dashboard window forward (from the menu-bar popover). */
export async function openDashboard(path = "/"): Promise<void> {
  if (isTauri()) {
    await invoke("show_main_window", { path });
    return;
  }
  window.open(`${window.location.pathname}#${path}`, "_blank", "noopener");
}

/** Save text as a file on this Mac. Nothing is uploaded anywhere. */
export function saveTextFile(filename: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
