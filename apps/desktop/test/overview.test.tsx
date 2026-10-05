import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGraph, buildView, edgeKeysFor, graphState } from "../src/components/AgentGraph";
import { DaemonProvider, type Daemon } from "../src/lib/context";
import { layoutGraph } from "../src/lib/graph";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore, agentsOf, sessionList } from "../src/lib/store";
import { Overview } from "../src/pages/Overview";
import { event, kids, mainAgent, resetSeq, session } from "./fixtures";

function setup(): { daemon: Daemon; mock: MockDaemonClient } {
  const store = new LiveStore();
  const mock = new MockDaemonClient(store, { live: false });
  return { daemon: { store, client: mock }, mock };
}

beforeEach(() => {
  resetSeq();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(cleanup);

describe("Overview with the mock daemon", () => {
  it("opens on the Running tab, whatever else is waiting, and shows that session's graph", () => {
    const { daemon } = setup();
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    expect(screen.getByRole("tab", { name: /Running/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /auth-service/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /billing-web/ })).toBeNull(); // the waiting one is on its own tab
    expect(screen.getByRole("tab", { name: /Needs you/ })).toBeTruthy();
  });

  it("shows the session that needs you, with its graph, stats and log, on the Needs you tab", () => {
    const { daemon } = setup();
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Needs you/ }));
    expect(screen.getByRole("button", { name: /billing-web/ }).getAttribute("aria-pressed")).toBe("true");
    const graph = screen.getByTestId("agent-graph");
    expect(within(graph).getAllByText("reviewer").length).toBeGreaterThan(0);
    expect(within(graph).getByText("! needs approval")).toBeTruthy();
    expect(within(graph).getByText("codex-app-server")).toBeTruthy();
    expect(screen.getByText("61.4k reported")).toBeTruthy();
    expect(screen.getByText("rm -rf dist && pnpm build", { selector: "span.cell-mono" })).toBeTruthy();
  });

  it("switches the graph when another session is chosen", () => {
    const { daemon } = setup();
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /auth-service/ }));
    const graph = screen.getByTestId("agent-graph");
    for (const name of ["explorer", "worker", "researcher"]) expect(within(graph).getAllByText(name).length).toBeGreaterThan(0);
    expect(within(graph).getByText("✕ failed")).toBeTruthy();
    expect(within(graph).getByText("2 of 3 reported")).toBeTruthy();
    expect(graph.querySelector('[data-node-id="merge"]')).toBeTruthy();
  });

  it("with nothing running it shows the empty state and nothing else: no stats, no graph, no log of another session", () => {
    const { daemon, mock } = setup();
    mock.data.sessions = mock.data.sessions.filter((s) => s.status !== "running");
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    expect(screen.getByRole("tab", { name: /Running/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Nothing is running right now")).toBeTruthy();
    expect(document.querySelector(".radar.radar--run")).toBeTruthy();
    expect(document.querySelector(".estate--hero")).toBeTruthy(); // alone on the page, so large
    expect((document.querySelector(".radar") as HTMLElement).style.width).toBe("220px");
    expect(screen.queryByTestId("agent-graph")).toBeNull();
    expect(document.querySelector(".stats")).toBeNull();
    expect(screen.queryByText("Session log")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Idle/ })); // leaving is a choice, and then the idle session is shown in full
    expect(screen.getByTestId("agent-graph")).toBeTruthy();
  });

  it("jumps to a session that has just started running, from the empty Running tab or from another tab, and only once", () => {
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    mock.data.sessions = mock.data.sessions.filter((s) => s.status !== "running");
    const daemon: Daemon = { store, client: mock };
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    expect(screen.getByText("Nothing is running right now")).toBeTruthy(); // waiting on the empty state
    fireEvent.click(screen.getByRole("tab", { name: /Idle/ })); // the person looks elsewhere
    const young = session({ id: "fresh1", cwd: "/Users/demo/work/brand-new", status: "running", startedAt: new Date().toISOString(), lastEventAt: new Date().toISOString() });
    act(() => void store.apply({ type: "session", session: young }));
    expect(screen.getByRole("tab", { name: /Running/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /brand-new/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("agent-graph")).toBeTruthy();
    // it does not fight the person afterwards: they go to Idle, and a later update of the same session leaves them there
    fireEvent.click(screen.getByRole("tab", { name: /Idle/ }));
    act(() => void store.apply({ type: "session", session: { ...young, activity: "editing x.ts" } }));
    expect(screen.getByRole("tab", { name: /Idle/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("does not jump to a running session that started long ago", () => {
    const { daemon, mock } = setup();
    mock.data.sessions = mock.data.sessions.filter((s) => s.status !== "running");
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    const old = session({ id: "old1", cwd: "/Users/demo/work/long-running", status: "running", startedAt: new Date(Date.now() - 3_600_000).toISOString(), lastEventAt: new Date().toISOString() });
    act(() => void daemon.store.apply({ type: "session", session: old }));
    expect(screen.getByRole("tab", { name: /Running/ }).getAttribute("aria-selected")).toBe("true"); // it opens on Running anyway
    expect(screen.getByRole("button", { name: /long-running/ })).toBeTruthy();
  });

  it("draws a lone agent for a generic CLI and no subagent nodes", () => {
    const { daemon } = setup();
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Idle/ }));
    fireEvent.click(screen.getByRole("button", { name: /notes-cli/ }));
    const graph = screen.getByTestId("agent-graph");
    expect(graph.querySelectorAll('[data-node-id^="s3:"]').length).toBe(0);
    expect(graph.querySelector('[data-node-id="merge"]')).toBeNull();
    expect(within(graph).getByText("pty")).toBeTruthy();
  });

  it("filters the log to high confidence", () => {
    const { daemon } = setup();
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Running/ }));
    fireEvent.click(screen.getByRole("button", { name: /auth-service/ }));
    const before = screen.getAllByText("Low").length;
    expect(before).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "High confidence only" }));
    // the Low confidence label inside the log disappears (source nodes in the graph keep theirs)
    const log = screen.getByRole("region", { name: "Session log" });
    expect(within(log).queryAllByText("Low")).toHaveLength(0);
  });

  it("explains how to start when nothing is running", () => {
    const store = new LiveStore();
    const client = new MockDaemonClient(store, { live: false });
    client.data.sessions = [];
    client.data.agents = [];
    client.data.events = [];
    client.data.requests = [];
    render(
      <DaemonProvider daemon={{ store, client }}>
        <Overview />
      </DaemonProvider>,
    );
    expect(screen.getByText("Nothing is running")).toBeTruthy();
    expect(screen.getAllByText(/agentwatch claude/).length).toBeGreaterThan(0);
    expect(screen.getByText(/pnpm agentwatch install-cli --apply/)).toBeTruthy();
  });
});

describe("Overview setup banner", () => {
  it("offers one-click connection for an agent that is installed but not connected, then confirms", async () => {
    const { daemon, mock } = setup();
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    expect(await screen.findByText("Claude Code is not connected yet")).toBeTruthy();
    expect(screen.queryByText(/Codex is not connected/)).toBeNull(); // Codex is not installed here, so it is not nagged about
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude Code" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(mock.setup.claude.hooks.state).toBe("installed");
    expect(screen.getByText(/Start a new session in your agent/)).toBeTruthy();
  });

  it("can be closed, stays closed for the agents it named, and returns only for a new one", async () => {
    const { daemon, mock } = setup();
    const view = () => (
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>
    );
    const first = render(view());
    expect(await screen.findByText("Claude Code is not connected yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/not connected yet/)).toBeNull();
    expect(mock.setup.claude.hooks.state).toBe("missing"); // closing connects nothing
    first.unmount();
    render(view()); // a fresh visit to the first page
    await screen.findByText("auth-service");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/not connected yet/)).toBeNull();
    cleanup();
    mock.setup.antigravity.detected = true; // an agent it has not named before
    render(view());
    expect(await screen.findByText("Antigravity CLI is not connected yet")).toBeTruthy();
    expect(screen.queryByText(/Claude Code.*not connected/)).toBeNull(); // Claude Code stays closed
  });

  it("the confirmation can be dismissed too", async () => {
    const { daemon } = setup();
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect Claude Code" }));
    await screen.findByText("Connected");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("stays out of the way once everything is connected", async () => {
    const { daemon, mock } = setup();
    mock.setup.claude.hooks.state = "installed";
    render(
      <DaemonProvider daemon={daemon}>
        <Overview />
      </DaemonProvider>,
    );
    await screen.findByText("auth-service");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/not connected yet/)).toBeNull();
  });
});

describe("AgentGraph", () => {
  it("is quiet until an event arrives, then lights the source and return edge once", () => {
    const s = session();
    const layout = layoutGraph(s, [mainAgent(), ...kids(3, "s1", ["done", "failed", "running"])], { "claude-hook": 1 });
    const idle = buildView(layout, "event", 5, [], []);
    expect(idle.streaks).toHaveLength(0);
    expect(idle.dots).toHaveLength(0);

    const seen = new Set<string>();
    const e = event({ agentId: "s1:k1", source: "claude-hook" });
    const keys = edgeKeysFor(e, layout, seen);
    expect(keys).toEqual(["src:claude-hook", "dlg:s1:k1", "ret:s1:k1"]); // first sight also dispatches
    expect(edgeKeysFor(e, layout, seen)).toEqual(["src:claude-hook", "ret:s1:k1"]);

    const mid = buildView(layout, "event", 5.3, keys.map((key) => ({ key, born: 5 })), []);
    expect(mid.streaks.length).toBeGreaterThan(0);
    const after = buildView(layout, "event", 8, keys.map((key) => ({ key, born: 5 })), []);
    expect(after.streaks).toHaveLength(0); // the afterglow ended too
  });

  it("draws no continuous flow for a session that is not running", () => {
    const layout = layoutGraph(session({ status: "idle" }), [mainAgent(), ...kids(2)], { "claude-hook": 1 });
    for (const mode of ["sweep", "dots"] as const) {
      const v = buildView(layout, mode, 1.2, [], [], false);
      expect(v.streaks).toHaveLength(0);
      expect(v.dots).toHaveLength(0);
    }
    expect(buildView(layout, "dots", 1.2, [], [], true).dots.length).toBeGreaterThan(0); // and it still flows when running
  });

  it("says why the graph is still instead of claiming to stream", () => {
    expect(graphState(true, { status: "running" })).toBe("streaming events");
    expect(graphState(false, { status: "running" })).toBe("paused");
    expect(graphState(true, { status: "idle" })).toBe("idle · no activity");
    expect(graphState(true, { status: "waiting" })).toBe("waiting for you");
    expect(graphState(true, { status: "finished", endedAt: "x" })).toBe("ended");
  });

  it("lets only the lines of agents that are in progress carry flow: a finished, failed or idle agent stays still", () => {
    const flowOf = (statuses: Array<"running" | "done" | "failed" | "idle">) => {
      const layout = layoutGraph(session({ sources: [] }), [mainAgent(), ...kids(statuses.length, "s1", statuses)], {}); // no source lines: only delegation and return are measured
      return buildView(layout, "dots", 1.2, [], [], true).dots.length;
    };
    const allDone = flowOf(["done", "done", "done"]);
    const oneRunning = flowOf(["done", "running", "done"]);
    const allRunning = flowOf(["running", "running", "running"]);
    expect(allDone).toBe(0); // everything reported: no delegation, no return, no loop
    expect(oneRunning).toBeGreaterThan(0);
    expect(allRunning).toBeGreaterThan(oneRunning);
    expect(flowOf(["failed", "idle"])).toBe(0);
  });

  it("uses blue for work in progress, green for done and red for failed", () => {
    const layout = layoutGraph(session(), [mainAgent(), ...kids(3, "s1", ["running", "done", "failed"])], {});
    const tones = Object.fromEntries(layout.nodes.filter((n) => n.kind === "agent").map((n) => [n.agentId, n.tone]));
    expect(tones).toEqual({ "s1:k0": "run", "s1:k1": "done", "s1:k2": "fail" });
    const { container } = render(
      <DaemonProvider daemon={{ store: new LiveStore(), client: new MockDaemonClient(new LiveStore(), { live: false }) }}>
        <AgentGraph session={session()} agents={[mainAgent(), ...kids(3, "s1", ["running", "done", "failed"])]} events={[]} />
      </DaemonProvider>,
    );
    expect(container.querySelector('[data-node-id="s1:k0"]')!.className).toContain("gnode--run");
    expect(container.querySelector('[data-node-id="s1:k1"]')!.className).toContain("gnode--done");
    expect(container.querySelector('[data-node-id="s1:k2"]')!.className).toContain("gnode--fail");
  });

  it("uses the other flow modes without needing events", () => {
    const layout = layoutGraph(session(), [mainAgent(), ...kids(2)], { "claude-hook": 1 });
    expect(buildView(layout, "sweep", 1.2, [], []).streaks.length).toBeGreaterThan(0);
    expect(buildView(layout, "dots", 1.2, [], []).dots.length).toBeGreaterThan(0);
    const glow = buildView(layout, "glow", 5.2, [{ key: "src:claude-hook", born: 5 }], []);
    expect(glow.streaks).toHaveLength(0);
    expect(glow.dots).toHaveLength(0);
  });

  it("paints a failed return path in the failure color", () => {
    const layout = layoutGraph(session(), [mainAgent(), ...kids(2, "s1", ["failed", "running"])]);
    const v = buildView(layout, "event", 5.3, [{ key: "ret:s1:k0", born: 5 }], []);
    expect(v.streaks.some((s) => String(s.background).includes("--fail"))).toBe(true);
  });

  it("turns live events from the store into streaks and lets the user pause", () => {
    const { daemon, mock } = setup();
    mock.start();
    const live = daemon.store.getState();
    const s = sessionList(live).find((x) => x.id === "s1")!;
    render(
      <DaemonProvider daemon={daemon}>
        <AgentGraph session={s} agents={agentsOf(live, "s1")} events={live.events.get("s1") ?? []} />
      </DaemonProvider>,
    );
    const stage = screen.getByTestId("graph-stage");
    expect(stage.getAttribute("data-mode")).toBe("event");
    // choose another flow mode; the choice is remembered
    fireEvent.click(screen.getByRole("button", { name: "Glow" }));
    expect(stage.getAttribute("data-mode")).toBe("glow");
    expect(localStorage.getItem("aw.flow")).toBe("glow");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("paused")).toBeTruthy();
    act(() => void mock.tick());
    expect(stage.getAttribute("data-streaks")).toBe("0"); // paused: no streaks are queued
    mock.stop();
  });
});
