#!/usr/bin/env node
// Launcher: prefer the built bundle (fast startup for hooks); fall back to a dev hint.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "agentwatch.mjs");
if (existsSync(dist)) {
  await import(dist);
} else {
  process.stderr.write("agentwatch: not built yet. Run: pnpm --filter @agentwatch/cli build\n");
  process.exit(1);
}
