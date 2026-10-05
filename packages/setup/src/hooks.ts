import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeHooksConfig } from "@agentwatch/adapter-claude-code";
import { antigravityHooksConfig } from "@agentwatch/adapter-antigravity";
import { codexHooksConfig } from "@agentwatch/adapter-codex";
import { cursorHooksConfig } from "@agentwatch/adapter-cursor";
import { geminiHooksConfig } from "@agentwatch/adapter-gemini-cli";

export type Json = Record<string, unknown>;
/** Claude Code, Codex and Gemini nest commands under `hooks`; Cursor's entries carry `command` directly. */
type HookEntry = { matcher?: string; command?: string; hooks?: Array<{ type?: string; command?: string }> };
export type Target = "claude" | "codex" | "gemini" | "antigravity" | "cursor";

/** Antigravity keeps its hooks in named groups at the top of the file; AgentWatch owns the group with this name. */
export const ANTIGRAVITY_GROUP = "agentwatch";

const isEvents = (v: unknown): v is unknown[] => Array.isArray(v);

/** The event -> entries map for a target: `hooks` for most agents, the AgentWatch group for Antigravity. */
function readHooks(json: Json, target: Target): Record<string, unknown[]> {
  if (target !== "antigravity") return { ...((json.hooks as Record<string, unknown[]>) ?? {}) };
  const group = (json[ANTIGRAVITY_GROUP] as Record<string, unknown> | undefined) ?? {};
  return Object.fromEntries(Object.entries(group).filter(([, v]) => isEvents(v))) as Record<string, unknown[]>;
}

/** Put the map back, leaving everything else in the file (and, for Antigravity, the group's own `enabled` flag) as it was. */
function writeHooks(json: Json, target: Target, hooks: Record<string, unknown[]>): Json {
  const out: Json = { ...json };
  if (target !== "antigravity") {
    if (Object.keys(hooks).length) out.hooks = hooks;
    else delete out.hooks;
    return out;
  }
  const group = (json[ANTIGRAVITY_GROUP] as Record<string, unknown> | undefined) ?? {};
  const rest = Object.fromEntries(Object.entries(group).filter(([, v]) => !isEvents(v)));
  if (Object.keys(hooks).length) out[ANTIGRAVITY_GROUP] = { ...rest, ...hooks };
  else delete out[ANTIGRAVITY_GROUP];
  return out;
}

const commandsOf = (entry: unknown): string[] => {
  const e = entry as HookEntry;
  return [e?.command, ...(e?.hooks ?? []).map((h) => h.command)].filter((c): c is string => typeof c === "string");
};

/**
 * An entry is ours when one of its commands belongs to AgentWatch and forwards for this provider.
 * Two generations are recognised so an upgrade replaces the old entry instead of doubling events:
 *   node ".../agentwatch.mjs" hook claude        (CLI forwarder)
 *   sh ".../AgentWatch/hook.sh" claude           (curl forwarder, no Node per call)
 */
export function isOurs(entry: unknown, target: Target): boolean {
  return commandsOf(entry).some((c) => {
    if (!/agentwatch/i.test(c)) return false;
    return new RegExp(`\\bhook ${target}\\b`).test(c) || new RegExp(`hook\\.sh["']?\\s+${target}\\b`).test(c);
  });
}

export function generateHooks(target: Target, command: string): { hooks: Record<string, unknown[]> } {
  switch (target) {
    case "claude":
      return claudeHooksConfig(command);
    case "codex":
      return codexHooksConfig(command);
    case "gemini":
      return geminiHooksConfig(command);
    case "antigravity":
      return antigravityHooksConfig(command);
    case "cursor":
      return cursorHooksConfig(command);
  }
}

/** Merge our hooks into an existing settings object without touching anyone else's. Idempotent. */
export function mergeHooks(existing: Json, target: Target, command: string): Json {
  const hooks = readHooks(existing, target);
  for (const [event, entries] of Object.entries(generateHooks(target, command).hooks)) {
    const kept = (hooks[event] ?? []).filter((e) => !isOurs(e, target));
    hooks[event] = [...kept, ...entries];
  }
  const out = writeHooks(existing, target, hooks);
  if (target === "cursor" && out.version === undefined) out.version = 1; // Cursor ignores a hooks file without it
  return out;
}

export function removeHooks(existing: Json, target: Target): Json {
  const hooks = readHooks(existing, target);
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = entries.filter((e) => !isOurs(e, target));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  return writeHooks(existing, target, hooks);
}

export function readJsonFile(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Json;
}

/** Back the file up, then replace it atomically. Returns the backup path (if there was a file). */
export function writeJsonWithBackup(path: string, value: Json, now = new Date()): string | undefined {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.agentwatch-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(path, backup);
  }
  const tmp = `${path}.agentwatch-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
  return backup;
}

export type HooksState = "installed" | "outdated" | "missing" | "unreadable";

export interface HooksStatus {
  state: HooksState;
  path: string;
  /** Commands of our entries that differ from the one we would install today. */
  foreign: string[];
}

/** installed = exactly today's command everywhere; outdated = ours but an older command; missing = none. */
export function hooksStatus(path: string, target: Target, expectedCommand: string): HooksStatus {
  let json: Json;
  try {
    json = readJsonFile(path);
  } catch {
    return { state: "unreadable", path, foreign: [] };
  }
  const want = Object.keys(generateHooks(target, expectedCommand).hooks);
  const hooks = readHooks(json, target);
  const ours: string[] = [];
  let covered = 0;
  for (const event of want) {
    const mine = (hooks[event] ?? []).filter((e) => isOurs(e, target));
    for (const e of mine) ours.push(...commandsOf(e).filter((c) => /agentwatch/i.test(c)));
    if (mine.length) covered += 1;
  }
  if (ours.length === 0) return { state: "missing", path, foreign: [] };
  const foreign = [...new Set(ours.filter((c) => c !== expectedCommand))];
  return { state: foreign.length === 0 && covered === want.length ? "installed" : "outdated", path, foreign };
}
