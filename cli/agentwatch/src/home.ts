import { homedir } from "node:os";
import { join } from "node:path";

export function agentwatchHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTWATCH_HOME ?? join(homedir(), "Library", "Application Support", "AgentWatch");
}

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentwatchHome(env), "agentwatchd.sock");
}
