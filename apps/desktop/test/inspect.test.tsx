import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGraph } from "../src/components/AgentGraph";
import { DaemonProvider } from "../src/lib/context";
import { layoutGraph } from "../src/lib/graph";
import { summarizeActivity } from "../src/lib/activity";
import { breakdown } from "../src/lib/graph";
import { inspectNode, inspectPart } from "../src/lib/inspect";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { event, kids, mainAgent, resetSeq, session } from "./fixtures";

beforeEach(resetSeq);
afterEach(cleanup);

const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const agents = [mainAgent("s1", { toolCount: 12, model: "claude-sonnet-5-5" }), ...kids(2, "s1", ["done", "failed"])];
const events = [
  event({ kind: "file.read", payload: { path: "src/a.ts" } }),
  event({ kind: "file.write", payload: { path: "src/a.ts", additions: 5, deletions: 1 } }),
  event({ kind: "file.read", payload: { path: "src/b.ts" } }),
  event({ kind: "command.started", payload: { argvDisplay: "pnpm test" } }),
  event({ kind: "tool.failed", agentId: "s1:k1", payload: { toolName: "Bash", error: "exit 1" } }),
  event({ kind: "file.write", agentId: "unknown", source: "filesystem", confidence: "low", payload: { path: "src/c.ts" } }),
];

function nodeOf(id: string) {
  const layout = layoutGraph(session(), agents, { "claude-hook": 5, filesystem: 1 });
  return layout.nodes.find((n) => n.id === id)!;
}

describe("inspectNode", () => {
  const input = { session: session(), agents, events, now: NOW };

  it("describes an agent with its facts, files and newest events first", () => {
    const i = inspectNode(nodeOf("main"), input);
    const facts = Object.fromEntries(i.facts);
    expect(facts["Status"]).toBe("Running");
    expect(facts["Tools used"]).toBe("12");
    expect(facts["Model"]).toBe("claude-sonnet-5-5");
    expect(facts["Commands"]).toBe("1");
    expect(facts["Active for"]).toBe("10:00");
    // src/a.ts was read and then edited: it stays an edit; the most recently touched file is first
    expect(i.files.map((f) => [f.path, f.op])).toEqual([["src/b.ts", "read"], ["src/a.ts", "edit"]]);
    expect(i.recent[0]!.kind).toBe("Run"); // newest first
    expect(i.recent.map((r) => r.kind)).toContain("Edit");
  });

  it("shows the failure of a subagent", () => {
    const k = layoutGraph(session(), agents).nodes.find((n) => n.agentId === "s1:k1")!;
    const i = inspectNode(k, input);
    expect(i.recent[0]).toMatchObject({ kind: "Fail", tone: "fail" });
    expect(Object.fromEntries(i.facts)["Status"]).toBe("Failed");
  });

  it("describes an evidence source, and says observed changes are not attributed", () => {
    const fs = inspectNode(nodeOf("src:filesystem"), input);
    expect(Object.fromEntries(fs.facts)["Confidence"]).toBe("Low");
    expect(Object.fromEntries(fs.facts)["Events"]).toBe("1");
    expect(fs.files).toEqual([{ path: "src/c.ts", op: "changed" }]);
    expect(fs.note).toMatch(/never attributed/);
    const hook = inspectNode(nodeOf("src:claude-hook"), input);
    expect(hook.note).toBeUndefined();
    expect(Object.fromEntries(hook.facts)["Kinds"]).toMatch(/file.read 2/);
  });

  it("lists the agents behind the merge node", () => {
    const i = inspectNode(nodeOf("merge"), input);
    expect(i.members.map((m) => [m.name, m.state])).toEqual([["explore", "Done"], ["worker", "Failed"]]);
  });

  it("freezes the active time of an agent when its session is idle", () => {
    const idle = session({ status: "idle" });
    const a = [mainAgent("s1", { lastEventAt: "2026-01-01T00:04:00.000Z" })];
    const main = layoutGraph(idle, a).nodes.find((n) => n.kind === "main")!;
    expect(Object.fromEntries(inspectNode(main, { session: idle, agents: a, events: [], now: NOW }).facts)["Active for"]).toBe("04:00");
    expect(inspectNode(main, { session: idle, agents: a, events: [], now: NOW }).note).toMatch(/No events/);
  });
});

describe("AgentGraph inspector", () => {
  function mount(opts: { details?: boolean } = { details: true }) {
    const store = new LiveStore();
    const mock = new MockDaemonClient(store, { live: false });
    render(
      <DaemonProvider daemon={{ store, client: mock }}>
        <AgentGraph session={session()} agents={agents} events={events} />
      </DaemonProvider>,
    );
    if (opts.details !== false) fireEvent.click(screen.getByRole("tab", { name: "Details" })); // the chat is what is under the graph by default
  }

  it("previews the main agent by default, keeps the last node it settled on instead of snapping back, and pins on click", async () => {
    mount();
    expect(screen.getByRole("region", { name: "Details: main" }).textContent).toMatch(/Preview/);
    const worker = screen.getByRole("button", { name: "Inspect worker" });
    fireEvent.mouseEnter(worker);
    expect(await screen.findByRole("region", { name: "Details: worker" })).toBeTruthy();
    fireEvent.mouseLeave(worker);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole("region", { name: "Details: worker" })).toBeTruthy(); // no flicker back to main

    fireEvent.click(screen.getByRole("button", { name: "Inspect main" }));
    const pinned = screen.getByRole("region", { name: "Details: main" });
    expect(pinned.textContent).toMatch(/Pinned/);
    fireEvent.mouseEnter(worker);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole("region", { name: "Details: main" })).toBeTruthy(); // pinned wins over hover
    fireEvent.click(within(pinned).getByRole("button", { name: "Unpin" }));
    expect(await screen.findByRole("region", { name: "Details: worker" })).toBeTruthy(); // back to the last preview
  });

  it("ignores a node the pointer only passes over", async () => {
    mount();
    const a = screen.getByRole("button", { name: "Inspect claude-hook" });
    fireEvent.mouseEnter(a);
    fireEvent.mouseLeave(a);
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByRole("region", { name: "Details: main" })).toBeTruthy();
  });

  it("splits what main works through into subagents, shell and files, and each chip opens its own detail", async () => {
    mount();
    const chips = screen.getByRole("group", { name: "What main works through" });
    expect(within(chips).getByRole("button", { name: /^Subagents: 2, 1 done · 1 failed/ })).toBeTruthy();
    expect(within(chips).getByRole("button", { name: /^Shell: 1, / })).toBeTruthy();
    expect(within(chips).getByRole("button", { name: /^Files: 2, 2 read · 1 edited · 1 seen/ })).toBeTruthy();

    fireEvent.click(within(chips).getByRole("button", { name: /^Shell:/ }));
    const shell = screen.getByRole("region", { name: "Details: Shell" });
    expect(shell.textContent).toMatch(/pnpm test/);
    expect(shell.textContent).toMatch(/Pinned/);
    fireEvent.click(within(chips).getByRole("button", { name: /^Subagents:/ }));
    const subs = screen.getByRole("region", { name: "Details: Subagents" });
    expect(subs.textContent).toMatch(/explore/);
    expect(subs.textContent).toMatch(/worker/);
  });

  it("works from the keyboard", () => {
    mount();
    const node = screen.getByRole("button", { name: "Inspect claude-hook" });
    fireEvent.keyDown(node, { key: "Enter" });
    expect(node.getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(node, { key: " " });
    expect(node.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("activity and breakdown", () => {
  it("counts shell commands apart from processes only the sampler saw, and files apart from watcher-only changes", () => {
    const ev = [
      event({ kind: "command.started", payload: { commandId: "c1", argvDisplay: "pnpm test" } }),
      event({ kind: "command.completed", payload: { commandId: "c1", exitCode: 1 } }),
      event({ kind: "command.started", payload: { commandId: "c2", argvDisplay: "pnpm build" } }),
      event({ kind: "command.started", source: "process", confidence: "medium", payload: { commandId: "p1", argvDisplay: "vitest (child process)" } }),
      event({ kind: "file.read", payload: { path: "a.ts" } }),
      event({ kind: "file.read", payload: { path: "a.ts" } }),
      event({ kind: "file.write", payload: { path: "a.ts" } }),
      event({ kind: "file.write", source: "filesystem", confidence: "low", payload: { path: "z.ts" } }),
    ];
    expect(summarizeActivity(ev, true)).toEqual({ shell: { total: 2, running: 1, failed: 1, observed: 1 }, files: { read: 1, edited: 1, deleted: 0, touched: 1, changed: 1 } });
    expect(summarizeActivity(ev, false).shell.running).toBe(0); // an idle session is not running anything
  });

  it("says plainly when there is nothing, including no subagents", () => {
    const parts = breakdown([], undefined);
    expect(parts.map((p) => [p.key, p.value, p.sub])).toEqual([["subagents", "0", "none spawned"], ["shell", "0", "none yet"], ["files", "0", "none yet"]]);
    const i = inspectPart("subagents", { session: session(), agents: [mainAgent()], events: [] });
    expect(i.note).toMatch(/not started any subagent/);
  });

  it("tones the chips by state", () => {
    const [sub, shell] = breakdown(kids(2, "s1", ["failed", "running"]), { shell: { total: 3, running: 1, failed: 0, observed: 0 }, files: { read: 0, edited: 0, deleted: 0, touched: 0, changed: 0 } });
    expect(sub!.tone).toBe("fail");
    expect(sub!.sub).toBe("1 running · 1 failed");
    expect(shell!.tone).toBe("run");
  });

  it("lists the commands in the shell detail, newest first", () => {
    const ev = [event({ kind: "command.started", payload: { commandId: "a", argvDisplay: "first" } }), event({ kind: "command.started", payload: { commandId: "b", argvDisplay: "second" } })];
    const i = inspectPart("shell", { session: session(), agents: [mainAgent()], events: ev });
    expect(i.recent.map((r) => r.text)).toEqual(["second", "first"]);
  });
});
