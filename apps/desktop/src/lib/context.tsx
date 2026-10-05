import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { DaemonClient } from "./client";
import { LiveStore, type LiveState } from "./store";

export interface Daemon {
  store: LiveStore;
  client: DaemonClient;
}

const Ctx = createContext<Daemon | null>(null);

export function DaemonProvider({ daemon, children }: { daemon: Daemon; children: ReactNode }) {
  useEffect(() => {
    daemon.client.start();
    return () => daemon.client.stop();
  }, [daemon]);
  return <Ctx.Provider value={daemon}>{children}</Ctx.Provider>;
}

export function useDaemon(): Daemon {
  const d = useContext(Ctx);
  if (!d) throw new Error("DaemonProvider missing");
  return d;
}

export function useLive(): LiveState {
  const { store } = useDaemon();
  return useSyncExternalStore(store.subscribe, store.getState);
}

export interface QueryResult<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  refresh: () => void;
}

/**
 * Ask the daemon for history (files, commands, logs, settings...). Refreshes when new events arrive,
 * at most every `minIntervalMs`, so a busy session does not hammer SQLite.
 */
export function useQuery<T>(name: string, params?: Record<string, unknown>, opts: { live?: boolean; minIntervalMs?: number } = {}): QueryResult<T> {
  const { client } = useDaemon();
  const live = useLive();
  const key = JSON.stringify(params ?? {});
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const last = useRef(0);
  const connected = live.status === "connected";
  const seq = opts.live === false ? 0 : live.lastSequence;

  useEffect(() => {
    if (!connected) return;
    const wait = Math.max(0, (opts.minIntervalMs ?? 1500) - (Date.now() - last.current));
    let cancelled = false;
    const t = setTimeout(() => {
      last.current = Date.now();
      client
        .query<T>(name, params)
        .then((data) => !cancelled && setState({ data, loading: false }))
        .catch((e: Error) => !cancelled && setState((s) => ({ ...s, error: e.message, loading: false })));
    }, wait);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, name, key, connected, seq, tick]);

  return useMemo(() => ({ data: state.data, error: state.error, loading: state.loading && connected, refresh: () => setTick((n) => n + 1) }), [state, connected]);
}
