import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { containsForbiddenKey } from "@agentwatch/protocol";
import { loadConfig } from "../../../services/daemon/src/config";
import { startDaemon } from "../../../services/daemon/src/daemon";
import { buildScenario, playDemo } from "../src/demo";

describe("demo scenario", () => {
  it("covers the states the UI draws and stays within the privacy contract", () => {
    const events = buildScenario("t").flatMap((s) => s.events);
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ["agent.started", "agent.ended", "tool.failed", "approval.requested", "usage.updated", "file.write", "command.completed"]) expect(kinds.has(k as never)).toBe(true);
    expect(new Set(events.map((e) => e.provider))).toEqual(new Set(["claude-code", "codex", "generic"]));
    for (const e of events) expect(containsForbiddenKey(e.payload)).toBe(false);
  });

  it("plays into a daemon and produces three sessions with the intended states", async () => {
    const dir = mkdtempSync(join(tmpdir(), "awdemo-"));
    const daemon = await startDaemon(loadConfig({ AGENTWATCH_HOME: dir }), { quiet: true, observers: false });
    try {
      const r = await playDemo({ socket: daemon.config.socketPath, speed: 40, maxSeconds: 30 });
      expect(r.sent).toBeGreaterThan(40);
      const sessions = [...daemon.manager.sessions.values()];
      expect(sessions).toHaveLength(3);
      const claude = sessions.find((s) => s.provider === "claude-code")!;
      const codex = sessions.find((s) => s.provider === "codex")!;
      expect(codex.status).toBe("waiting");
      expect(codex.usage?.inputTokens).toBe(48200);
      const agents = [...daemon.manager.agents.values()].filter((a) => a.sessionId === claude.id);
      expect(agents.find((a) => a.providerAgentId === "worker")?.status).toBe("failed");
      expect(agents.find((a) => a.providerAgentId === "explorer")?.status).toBe("done");
      expect(daemon.manager.snapshot().pendingRequests).toHaveLength(1);
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
