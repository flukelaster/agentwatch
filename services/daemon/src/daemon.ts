import { chmodSync, rmSync, writeFileSync } from "node:fs";
import type { DaemonConfig } from "./config";
import { Store } from "./db/store";
import { Diagnostics } from "./diagnostics";
import { CapabilityStore } from "./api/capabilities";
import { startIngestServer } from "./api/ingest-server";
import type { QueryContext } from "./api/queries";
import { startWsServer } from "./api/ws-server";
import { startObservers } from "./observers";
import { startTranscriptObserver } from "./observers/transcript";
import { contextFromEnv, setupRepair } from "@agentwatch/setup";
import { writeHookAssets, loadOrCreateSecret } from "./hook-assets";
import { ingestHook, type HookProviderName } from "./hooks";
import { SessionManager } from "./session-manager";

export interface RunningDaemon {
  config: DaemonConfig;
  store: Store;
  manager: SessionManager;
  diagnostics: Diagnostics;
  wsPort: number;
  stop: () => Promise<void>;
}

/** Wires storage, state, the ingestion socket and the UI WebSocket. Runs in the foreground (launchd-friendly). */
export async function startDaemon(config: DaemonConfig, opts: { quiet?: boolean; observers?: boolean } = {}): Promise<RunningDaemon> {
  const diagnostics = new Diagnostics(200, opts.quiet ? null : undefined);
  const startedAt = Date.now();
  const store = new Store(config.dbPath);
  const prunedGhosts = store.pruneGhostAgents(); // before the manager loads what is stored
  const manager = new SessionManager(store);
  const caps = new CapabilityStore(config.capabilityTtlMs);
  let wsPort = 0;

  if (prunedGhosts) diagnostics.info("db", `removed ${prunedGhosts} subagents that were only ever an end signal (never started, never did anything)`);
  const secret = loadOrCreateSecret(config.secretPath);
  const hookStats: { accepted: number; rejected: number; reasons: Record<string, number> } = { accepted: 0, rejected: 0, reasons: {} };
  const setup = contextFromEnv({ ...process.env, AGENTWATCH_HOME: config.home });
  try {
    const repaired = setupRepair(setup).filter((r) => r.changed || !r.ok);
    for (const r of repaired) diagnostics.info("setup", `${r.item} pointed at an old location: ${r.ok ? "rewritten" : `could not rewrite (${r.error})`}`);
  } catch (err) {
    diagnostics.info("setup", `repair skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Chat text is opt-in. The policy lives in the manager, which refuses a message of any kind that is switched off.
  const initial = store.getSettings();
  manager.setContentPolicy({ prompts: initial.storePromptText, responses: initial.storeAssistantText, tokens: initial.trackTokenUsage, window: initial.contextWindow });
  let transcript: ReturnType<typeof startTranscriptObserver> | null = null;
  const onSettingsChanged = (next: ReturnType<Store["getSettings"]>) => {
    const before = manager.contentPolicy();
    manager.setContentPolicy({ prompts: next.storePromptText, responses: next.storeAssistantText, tokens: next.trackTokenUsage, window: next.contextWindow });
    // turning a kind off also deletes what was kept of it
    if (before.prompts && !next.storePromptText) diagnostics.info("chat", `prompt text turned off: ${store.deleteMessages("user")} stored messages deleted`);
    if (before.responses && !next.storeAssistantText) diagnostics.info("chat", `assistant text turned off: ${store.deleteMessages("assistant")} stored messages deleted`);
    if ((!before.prompts && next.storePromptText) || (!before.responses && next.storeAssistantText) || (!before.tokens && next.trackTokenUsage) || before.window !== next.contextWindow) transcript?.refresh();
  };
  const query: QueryContext = { store, manager, diagnostics, startedAt, version: config.version, setup, hookStats, onSettingsChanged };
  const hook = {
    secret,
    onHook: (provider: HookProviderName, payload: unknown, session: string | undefined) => {
      ingestHook(manager, provider, payload, session);
      hookStats.accepted += 1;
    },
    onReject: (why: string, detail?: string) => {
      hookStats.rejected += 1;
      hookStats.reasons[why] = (hookStats.reasons[why] ?? 0) + 1;
      // say why, for the first few of each kind: a silent counter hid a failing hook for hours
      if (hookStats.reasons[why]! <= 5) diagnostics.warn("hook", `rejected (${why})${detail ? `: ${detail}` : ""}`);
    },
  };

  const ws = await startWsServer({ config, manager, caps, diagnostics, query, hook });
  wsPort = ws.port;
  writeHookAssets(config.home, wsPort, secret);
  let ingest: Awaited<ReturnType<typeof startIngestServer>>;
  try {
    ingest = await startIngestServer({ config, manager, caps, diagnostics, query, wsPort: () => wsPort });
  } catch (err) {
    await ws.close();
    store.close();
    throw err;
  }

  writeFileSync(config.statePath, JSON.stringify({ pid: process.pid, port: wsPort, host: config.wsHost, startedAt: new Date(startedAt).toISOString(), version: config.version }), { mode: 0o600 });
  chmodSync(config.statePath, 0o600);

  const retention = () => {
    const days = store.getSettings().retentionDays;
    const gone = manager.purge(days);
    if (gone.length) diagnostics.info("retention", `purged ${gone.length} session(s) older than ${days}d`);
  };
  retention();
  const timers = [
    setInterval(retention, 60 * 60 * 1000),
    setInterval(() => manager.sweepIdle(config.idleAfterMs), 15_000),
  ];
  timers.forEach((t) => t.unref());

  const observers = opts.observers === false ? null : startObservers({ manager, diagnostics });
  transcript = opts.observers === false ? null : startTranscriptObserver({ manager, diagnostics });

  diagnostics.info("daemon", `started pid ${process.pid} · schema v1 · loopback ${config.wsHost}:${wsPort}`);

  return {
    config,
    store,
    manager,
    diagnostics,
    wsPort,
    stop: async () => {
      timers.forEach(clearInterval);
      await observers?.stop();
      transcript?.stop();
      manager.flush();
      await ingest.close();
      await ws.close();
      store.close();
      rmSync(config.statePath, { force: true });
    },
  };
}
