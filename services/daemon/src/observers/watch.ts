import { statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface TreeWatcher {
  close: () => void;
}

/**
 * Watches a whole directory tree with ONE handle.
 *
 * On macOS Node's recursive fs.watch is a single FSEvents stream. The library this replaces (chokidar 4) held one
 * open file descriptor per watched file: a workspace with 11,000 files used up every descriptor the daemon had and
 * made every later child process (git) fail to start. Reports regular files only, once per burst (`settleMs`).
 */
export function watchTree(
  root: string,
  ignored: readonly RegExp[],
  onFile: (op: "write" | "delete", path: string) => void,
  onError: (err: Error) => void,
  settleMs = 120,
): TreeWatcher {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const settle = (path: string) => {
    pending.delete(path);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      onFile("delete", path); // it is gone
      return;
    }
    if (isFile) onFile("write", path);
  };
  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true, persistent: true }, (_event, name) => {
      if (!name) return;
      const path = join(root, name.toString());
      if (ignored.some((re) => re.test(path))) return;
      const t = pending.get(path);
      if (t) clearTimeout(t);
      pending.set(path, setTimeout(() => settle(path), settleMs));
    });
  } catch (err) {
    onError(err as Error);
    return { close: () => undefined };
  }
  watcher.on("error", (err) => onError(err));
  return {
    close: () => {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      watcher.close();
    },
  };
}
