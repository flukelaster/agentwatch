import { homedir } from "node:os";
import { join } from "node:path";

export interface DaemonConfig {
  home: string;
  dbPath: string;
  socketPath: string;
  statePath: string;
  secretPath: string;
  /** 0 = pick a free port (written to the state file). */
  wsPort: number;
  wsHost: "127.0.0.1";
  allowedOrigins: string[];
  capabilityTtlMs: number;
  idleAfterMs: number;
  version: string;
}

export const DAEMON_VERSION = "0.1.0";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const home = env.AGENTWATCH_HOME ?? join(homedir(), "Library", "Application Support", "AgentWatch");
  const extraOrigins = (env.AGENTWATCH_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    home,
    dbPath: join(home, "agentwatch.db"),
    socketPath: join(home, "agentwatchd.sock"),
    statePath: join(home, "agentwatchd.json"),
    secretPath: join(home, "secret"),
    wsPort: env.AGENTWATCH_WS_PORT ? Number(env.AGENTWATCH_WS_PORT) : 0,
    wsHost: "127.0.0.1",
    allowedOrigins: [
      "tauri://localhost",
      "http://tauri.localhost",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      ...extraOrigins,
    ],
    capabilityTtlMs: 60_000,
    idleAfterMs: 120_000,
    version: DAEMON_VERSION,
  };
}
