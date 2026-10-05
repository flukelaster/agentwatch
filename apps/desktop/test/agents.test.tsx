import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { Agents, SIGNAL_MATRIX, orderAgents, sessionEvidence } from "../src/pages/Agents";
import { kids, mainAgent, session } from "./fixtures";

function renderAgents(tweak?: (c: MockDaemonClient) => void) {
  const store = new LiveStore();
  const client = new MockDaemonClient(store, { live: false });
  tweak?.(client);
  render(
    <DaemonProvider daemon={{ store, client }}>
      <Agents />
    </DaemonProvider>,
  );
  return client;
}

const group = (name: RegExp) => screen.getByRole("group", { name });
const rowsOf = (g: HTMLElement) => [...g.querySelectorAll<HTMLElement>("[data-agent-id]")];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Agents page", () => {
  it("groups agents by session, newest first, with the main agent first, subagents (by start time) indented", () => {
    renderAgents();
    const groups = [...document.querySelectorAll<HTMLElement>("[data-session-id]")].map((g) => g.getAttribute("data-session-id"));
    expect(groups).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    const auth = group(/auth-service, Claude Code/);
    expect(within(auth).getByText("Claude Code")).toBeTruthy();
    const rows = rowsOf(auth);
    expect(rows[0]!.getAttribute("data-agent-id")).toBe("s1:main");
    expect(rows.map((r) => r.getAttribute("data-depth"))).toEqual(["0", "1", "1", "1"]);
    expect(rows.map((r) => r.querySelector(".ag-name__name")!.textContent)).toEqual(["main", "worker", "researcher", "explorer"]);
    expect(rows[0]!.querySelector<HTMLElement>(".ag-name")!.style.paddingLeft).toBe("0px");
    expect(rows[1]!.querySelector<HTMLElement>(".ag-name")!.style.paddingLeft).toBe("22px");
  });

  it("shows state, what the agent is doing, tool count and a hook-backed evidence meter", () => {
    renderAgents();
    const auth = group(/auth-service/);
    const worker = rowsOf(auth).find((r) => r.getAttribute("data-agent-id") === "s1:worker")!;
    expect(within(worker).getByText("✕ failed")).toBeTruthy();
    expect(within(worker).getByText("pnpm test · exit 1")).toBeTruthy(); // failureNote wins over lastAction
    expect(within(worker).getByText("9")).toBeTruthy();
    expect(within(worker).getByText("High")).toBeTruthy();
    expect(within(worker).getByText("claude-hook")).toBeTruthy();

    const main = rowsOf(auth)[0]!;
    expect(within(main).getByText("editing src/auth/session.ts")).toBeTruthy();

    const codex = rowsOf(group(/billing-web/))[0]!;
    expect(within(codex).getByText("! needs approval")).toBeTruthy();
    expect(codex.className).toContain("tr--ask");
    expect(within(codex).getByText("codex-app-server")).toBeTruthy();
  });

  it("shows a generic CLI as one agent with no subagents and only low evidence it can stand behind", () => {
    renderAgents();
    const notes = group(/notes-cli, Generic CLI/);
    const rows = rowsOf(notes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-depth")).toBe("0");
    expect(within(rows[0]!).getByText("custom-agent")).toBeTruthy();
    expect(within(rows[0]!).getByText("wrapped process")).toBeTruthy();
    expect(within(rows[0]!).getByText("○ idle")).toBeTruthy();
    expect(within(rows[0]!).getByText("Low")).toBeTruthy();
    expect(within(rows[0]!).getByText("pty")).toBeTruthy();
    // tool counts are not known for a wrapped process
    expect(within(rows[0]!).getByText("—")).toBeTruthy();
  });

  it("filters by provider with the chips", () => {
    renderAgents();
    expect(screen.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByRole("button", { name: "Codex" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelectorAll("[data-session-id]")).toHaveLength(1);
    expect(group(/billing-web/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generic CLI" }));
    expect(screen.getByText("custom-agent")).toBeTruthy();
    expect(screen.queryByText("reviewer")).toBeNull();
  });

  it("says so when a provider has no agents", () => {
    renderAgents((c) => {
      c.data.sessions = c.data.sessions.filter((s) => s.provider !== "codex");
    });
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.getByText(/No Codex agents right now/)).toBeTruthy();
  });

  it("explains the empty state when nothing is running", () => {
    renderAgents((c) => {
      c.data.sessions = [];
      c.data.agents = [];
      c.data.events = [];
      c.data.requests = [];
    });
    expect(screen.getByText(/No agents yet/)).toBeTruthy();
    // the capability matrix is static and still explains what to expect
    expect(screen.getByRole("region", { name: "Signal fidelity" })).toBeTruthy();
  });

  it("renders the capability matrix with dashes for what cannot be known", () => {
    renderAgents();
    const m = screen.getByRole("region", { name: "Signal fidelity" });
    expect(within(m).getByText("What each provider exposes")).toBeTruthy();
    for (const h of ["Signal", "Claude Code", "Codex", "Gemini CLI", "Antigravity CLI", "Cursor", "Generic CLI"]) expect(within(m).getByText(h)).toBeTruthy();
    expect(m.querySelectorAll("[data-signal]")).toHaveLength(SIGNAL_MATRIX.length);
    const subagents = m.querySelector<HTMLElement>('[data-signal="Subagents"]')!;
    expect(within(subagents).getAllByText("High · agent_id")).toHaveLength(2);
    expect(within(subagents).getAllByText("cannot be known")).toHaveLength(4); // Gemini CLI, Antigravity CLI, Cursor, Generic CLI
    const tokens = m.querySelector<HTMLElement>('[data-signal="Token usage"]')!;
    expect(within(tokens).getByText("Partial · only if stable")).toBeTruthy();
    expect(within(tokens).getByText("High · App Server only")).toBeTruthy();
    expect(within(m).getByText("High when wrapped")).toBeTruthy();
    expect(within(m).getByText("A dash means AgentWatch cannot know it for that provider and shows nothing instead of a guess.")).toBeTruthy();
  });

  it("ticks the uptime of running agents and freezes finished ones", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    renderAgents();
    const auth = group(/auth-service/);
    const up = (id: string) => rowsOf(auth).find((r) => r.getAttribute("data-agent-id") === id)!.querySelector(".ag-up")!.textContent;
    const before = up("s1:main");
    const doneBefore = up("s1:explorer");
    act(() => void vi.advanceTimersByTime(5000));
    expect(up("s1:main")).not.toBe(before);
    expect(up("s1:explorer")).toBe(doneBefore);
    expect(doneBefore).toBe("00:42");
  });
});

describe("agent tree helpers", () => {
  it("orders by parentAgentId depth and survives a parent cycle", () => {
    const a = mainAgent("s1");
    const [k0, k1] = kids(2, "s1");
    const grand = { ...k1!, id: "s1:g", parentAgentId: k0!.id, startedAt: "2026-01-01T00:01:00.000Z" };
    const rows = orderAgents([grand, k1!, k0!, a]);
    expect(rows.map((r) => [r.agent.id, r.depth])).toEqual([
      ["s1:main", 0],
      ["s1:k0", 1],
      ["s1:g", 2],
      ["s1:k1", 1],
    ]);
    const loop = [
      { ...a, id: "x", parentAgentId: "y" },
      { ...a, id: "y", parentAgentId: "x" },
    ];
    expect(orderAgents(loop)).toHaveLength(2);
  });

  it("uses a hook source as high evidence, otherwise the weakest observed source", () => {
    expect(sessionEvidence(session({ sources: ["process", "claude-hook"] }))).toEqual({ conf: "high", source: "claude-hook" });
    expect(sessionEvidence(session({ sources: ["process", "filesystem", "pty"] }))).toEqual({ conf: "low", source: "pty" });
    expect(sessionEvidence(session({ sources: ["process"] }))).toEqual({ conf: "medium", source: "process" });
    expect(sessionEvidence(session({ sources: [] }))).toBeUndefined();
  });
});
