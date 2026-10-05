import type { Settings } from "@agentwatch/protocol";
import { ITEMS, setupApply, setupRevert, setupStatus, type Item, type SetupContext } from "@agentwatch/setup";
import type { Store } from "../db/store";
import type { Diagnostics } from "../diagnostics";
import type { SessionManager } from "../session-manager";
import { schemaVersion } from "../db/database";

export interface QueryContext {
  store: Store;
  manager: SessionManager;
  diagnostics: Diagnostics;
  startedAt: number;
  version: string;
  setup: SetupContext;
  hookStats?: { accepted: number; rejected: number };
  onSettingsChanged?: (s: Settings) => void;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length <= 200 ? v : undefined;
}
function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function runQuery(name: string, params: Record<string, unknown> | undefined, ctx: QueryContext): unknown {
  const p = params ?? {};
  switch (name) {
    case "sessions":
      return ctx.manager.snapshot().sessions;
    case "agents": {
      const sessionId = str(p.sessionId);
      return [...ctx.manager.agents.values()].filter((a) => !sessionId || a.sessionId === sessionId);
    }
    case "events":
      return ctx.store.queryEvents({
        sessionId: str(p.sessionId),
        afterSequence: int(p.afterSequence),
        limit: int(p.limit),
        kinds: Array.isArray(p.kinds) ? p.kinds.filter((k): k is string => typeof k === "string").slice(0, 20) : undefined,
      });
    case "files":
      return ctx.store.queryFiles({ sessionId: str(p.sessionId), limit: int(p.limit) });
    case "commands":
      return ctx.store.queryCommands({ sessionId: str(p.sessionId), limit: int(p.limit) });
    case "logs":
      return {
        events: ctx.store.queryEvents({ kinds: ["log"], limit: int(p.limit) ?? 200 }),
        diagnostics: ctx.diagnostics.recent(int(p.limit) ?? 100),
      };
    case "settings":
      return ctx.store.getSettings();
    case "setupStatus":
      return setupStatus(ctx.setup);
    case "status":
      return {
        version: ctx.version,
        pid: process.pid,
        uptimeMs: Date.now() - ctx.startedAt,
        schemaVersion: schemaVersion(ctx.store.db),
        lastSequence: ctx.store.lastSequence,
        counts: ctx.store.counts(),
        ingest: ctx.manager.stats,
        hooks: ctx.hookStats,
      };
    default:
      throw new Error(`unknown query: ${name}`);
  }
}

export function runCommand(name: string, params: Record<string, unknown> | undefined, ctx: QueryContext): unknown {
  const p = params ?? {};
  switch (name) {
    case "deleteSession": {
      const id = str(p.sessionId);
      if (!id) throw new Error("sessionId required");
      return { deleted: ctx.manager.removeSession(id) };
    }
    case "deleteAllHistory":
      ctx.manager.wipeAll();
      ctx.diagnostics.warn("db", "all local history deleted by user");
      return { deleted: true };
    case "setSettings": {
      const next = ctx.store.setSettings((p.patch ?? {}) as Record<string, unknown>);
      ctx.onSettingsChanged?.(next);
      return next;
    }
    case "setupApply":
    case "setupRevert": {
      const asked = Array.isArray(p.items) ? p.items : [];
      const items = asked.filter((i): i is Item => typeof i === "string" && (ITEMS as readonly string[]).includes(i));
      if (items.length === 0) throw new Error("no valid items");
      const results = name === "setupApply" ? setupApply(ctx.setup, items) : setupRevert(ctx.setup, items);
      // mirror what really happened into the stored choices so the rest of the UI agrees
      const flag: Record<Item, string> = { claude: "claudeIntegration", codex: "codexIntegration", gemini: "geminiIntegration", antigravity: "antigravityIntegration", cursor: "cursorIntegration", cli: "cliInstalled", autostart: "startAtLogin" };
      const patch: Record<string, boolean> = {};
      for (const r of results) if (r.ok) patch[flag[r.item]] = name === "setupApply";
      ctx.store.setSettings(patch);
      ctx.diagnostics.info("setup", `${name === "setupApply" ? "applied" : "reverted"}: ${results.map((r) => `${r.item}=${r.ok ? (r.changed ? "changed" : "unchanged") : "failed"}`).join(" ")}`);
      return { results, status: setupStatus(ctx.setup) };
    }
    default:
      throw new Error(`unknown command: ${name}`);
  }
}
