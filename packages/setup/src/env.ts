import { homedir } from "node:os";
import { join } from "node:path";
import { appLocationProblem, type SetupContext } from "./setup";

export function defaultAgentwatchHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENTWATCH_HOME ?? join(env.HOME ?? homedir(), "Library", "Application Support", "AgentWatch");
}

/**
 * Where things live is told to us through the environment, because the app (or a developer) knows
 * the paths and this code does not:
 *   AGENTWATCH_HOME        data directory
 *   AGENTWATCH_NODE        Node runtime for the `agentwatch` command (defaults to the running one)
 *   AGENTWATCH_CLI_SCRIPT  the CLI bundle the launcher should run
 *   AGENTWATCH_APP_EXE     the app executable, for start-at-login
 */
export function contextFromEnv(env: NodeJS.ProcessEnv = process.env, fallbackCliScript?: string): SetupContext {
  const script = env.AGENTWATCH_CLI_SCRIPT ?? fallbackCliScript;
  const ctx: SetupContext = { home: env.HOME ?? homedir(), agentwatchHome: defaultAgentwatchHome(env) };
  const problem = env.AGENTWATCH_APP_EXE ? appLocationProblem(env.AGENTWATCH_APP_EXE) : undefined;
  if (problem) {
    // the CLI bundle and the executable live inside the same temporary copy: offer neither
    ctx.appProblem = problem;
    return ctx;
  }
  if (script) ctx.cli = { node: env.AGENTWATCH_NODE ?? process.execPath, script };
  if (env.AGENTWATCH_APP_EXE) {
    ctx.appExe = env.AGENTWATCH_APP_EXE;
    if (env.AGENTWATCH_HOME) ctx.appEnv = { AGENTWATCH_HOME: env.AGENTWATCH_HOME };
  }
  return ctx;
}
