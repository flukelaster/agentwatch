import { describe, expect, it } from "vitest";
import { layoutGraph, polyAt, polyLen, type GNode } from "../src/lib/graph";
import { kids, mainAgent, session } from "./fixtures";

const overlaps = (a: GNode, b: GNode) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const SOURCE_SETS: string[][] = [
  ["claude-hook", "process", "filesystem"],
  ["codex-app-server", "codex-hook", "process", "git"],
  ["claude-hook", "codex-hook", "codex-app-server", "process", "filesystem", "git", "pty"],
  ["pty"],
  [],
];

function check(n: number, sources: string[] = SOURCE_SETS[0]!) {
  const s = session({ sources });
  const g = layoutGraph(s, [mainAgent(), ...kids(n)], Object.fromEntries(sources.map((x) => [x, 3])));
  for (let i = 0; i < g.nodes.length; i++) {
    const a = g.nodes[i]!;
    expect(a.x, `${a.id} left`).toBeGreaterThanOrEqual(0);
    expect(a.y, `${a.id} top`).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w, `${a.id} right`).toBeLessThanOrEqual(g.width);
    expect(a.y + a.h, `${a.id} bottom`).toBeLessThanOrEqual(g.height);
    for (let j = i + 1; j < g.nodes.length; j++) expect(overlaps(a, g.nodes[j]!), `${a.id} overlaps ${g.nodes[j]!.id} (n=${n})`).toBe(false);
  }
  return g;
}

describe("layoutGraph", () => {
  it("matches the designed layout for three subagents", () => {
    const g = check(3);
    const main = g.nodes.find((n) => n.id === "main")!;
    expect([main.x, main.y, main.w, main.h]).toEqual([455, 16, 400, 152]);
    const k = g.nodes.filter((n) => n.kind === "agent");
    expect(k.map((n) => n.x)).toEqual([290, 540, 790]);
    expect(k.every((n) => n.y === 290)).toBe(true);
    const merge = g.nodes.find((n) => n.id === "merge")!;
    expect([merge.x, merge.y]).toEqual([505, 500]);
    expect(g.delegateLabel?.text).toBe("delegate · 3 subagents");
  });

  it("draws only the main agent and its sources when there are no subagents", () => {
    const g = check(0);
    expect(g.nodes.filter((n) => n.kind === "agent")).toHaveLength(0);
    expect(g.nodes.some((n) => n.id === "merge")).toBe(false);
    expect(g.edges.every((e) => e.kind === "source")).toBe(true);
    expect(g.height).toBeLessThan(500);
    expect(g.delegateLabel).toBeUndefined();
  });

  it("never overlaps or leaves the stage, for any number of subagents", () => {
    for (let n = 0; n <= 30; n++) check(n);
  });

  it("keeps every source box on the stage for every combination of sources", () => {
    for (const sources of SOURCE_SETS) for (const n of [0, 1, 2, 3, 4, 5, 9, 14]) check(n, sources);
  });

  it("stacks two sources that evidence the same agent without overlap or clipping", () => {
    const g = check(1, ["codex-app-server", "codex-hook", "process", "git"]);
    const src = g.nodes.filter((n) => n.kind === "source");
    expect(src).toHaveLength(4);
    expect(Math.min(...src.map((n) => n.y))).toBeGreaterThanOrEqual(12);
  });

  it("wraps into rows of four and collapses past the cap", () => {
    const g5 = check(5);
    expect(new Set(g5.nodes.filter((n) => n.kind === "agent").map((n) => n.y)).size).toBe(2);
    const g20 = check(20);
    expect(g20.hiddenCount).toBe(9);
    const more = g20.nodes.find((n) => n.kind === "more")!;
    expect(more.title).toBe("+9 more");
    expect(g20.nodes.filter((n) => n.kind === "agent")).toHaveLength(11);
    expect(g20.edges.some((e) => e.key === `ret:${more.id}`)).toBe(false);
    expect(g20.edges.some((e) => e.key === `dlg:${more.id}`)).toBe(true);
  });

  it("connects every edge to the border of the node it targets", () => {
    for (const n of [0, 1, 3, 6]) {
      const g = check(n);
      for (const e of g.edges) {
        const target = g.nodes.find((x) => x.id === e.to)!;
        const [x, y] = e.pts[e.pts.length - 1]!;
        const onBorder = (x === target.x || x === target.x + target.w) && y >= target.y && y <= target.y + target.h ? true : (y === target.y || y === target.y + target.h) && x >= target.x && x <= target.x + target.w;
        expect(onBorder, `${e.key} (n=${n}) ends at ${x},${y}`).toBe(true);
        // orthogonal segments only
        for (let i = 1; i < e.pts.length; i++) expect(e.pts[i]![0] === e.pts[i - 1]![0] || e.pts[i]![1] === e.pts[i - 1]![1]).toBe(true);
      }
    }
  });

  it("marks the return edge of a failed subagent and tones its node", () => {
    const g = layoutGraph(session(), [mainAgent(), ...kids(3, "s1", ["done", "failed", "running"])]);
    const failed = g.nodes.find((n) => n.tone === "fail" && n.kind === "agent")!;
    expect(failed.state).toBe("✕ failed");
    expect(g.edges.find((e) => e.key === `ret:${failed.id}`)?.fail).toBe(true);
    expect(g.nodes.find((n) => n.id === "merge")?.state).toBe("2 of 3 reported");
  });

  it("derives sources from evidence and gives each its confidence ceiling", () => {
    const g = layoutGraph(session({ sources: ["claude-hook", "filesystem", "git"] }), [mainAgent(), ...kids(2)], { "claude-hook": 5 });
    const byName = Object.fromEntries(g.nodes.filter((n) => n.kind === "source").map((n) => [n.source, n]));
    expect(Object.keys(byName).sort()).toEqual(["claude-hook", "filesystem", "git"]);
    expect(byName["claude-hook"]!.conf).toBe("high");
    expect(byName["filesystem"]!.conf).toBe("low");
    expect(byName["claude-hook"]!.detail).toBe("events 5");
  });

  it("shows nothing for sources it has no evidence from", () => {
    const g = layoutGraph(session({ provider: "generic", sources: ["pty"] }), [mainAgent()], {});
    expect(g.nodes.filter((n) => n.kind === "source").map((n) => n.source)).toEqual(["pty"]);
  });

  it("labels nested agents on their parent instead of drawing them", () => {
    const nested = { ...kids(1)[0]!, id: "s1:deep", providerAgentId: "deep", parentAgentId: "s1:k0" };
    const g = layoutGraph(session(), [mainAgent(), ...kids(1), nested]);
    expect(g.nodes.filter((n) => n.kind === "agent")).toHaveLength(1);
    expect(g.nodes.find((n) => n.kind === "agent")!.detail).toContain("+1 nested");
  });

  it("tells apart several subagents of the same type", () => {
    const same = kids(3).map((k, i) => ({ ...k, role: "general-purpose", displayName: "general-purpose", providerAgentId: `agent-abc${i}x` }));
    const g = layoutGraph(session(), [mainAgent(), ...same]);
    const titles = g.nodes.filter((n) => n.kind === "agent").map((n) => n.title);
    expect(new Set(titles).size).toBe(3);
    expect(titles).toEqual(["general-purpose #1", "general-purpose #2", "general-purpose #3"]); // by start order, not by hash
  });

  it("polyline helpers walk the path", () => {
    const pts: [number, number][] = [[0, 0], [10, 0], [10, 20]];
    expect(polyLen(pts)).toBe(30);
    expect(polyAt(pts, 5)).toEqual([5, 0]);
    expect(polyAt(pts, 20)).toEqual([10, 10]);
    expect(polyAt(pts, 99)).toEqual([10, 20]);
  });

  it("never names a subagent after a hash", () => {
    const hashes = kids(3).map((k, i) => ({ ...k, role: undefined, displayName: undefined, providerAgentId: ["ab3bffafebdf350d6", "acff1480a8922f67b", "a9029f256fbb777ed"][i] }));
    const g = layoutGraph(session(), [mainAgent(), ...hashes]);
    expect(g.nodes.filter((n) => n.kind === "agent").map((n) => n.title)).toEqual(["subagent 1", "subagent 2", "subagent 3"]);
  });

  it("uses the label of the task as the name when there is one", () => {
    const [k] = kids(1);
    const g = layoutGraph(session(), [mainAgent(), { ...k!, displayName: "Repair account-switch claims", role: "web-dev", providerAgentId: "ab3bffafebdf350d6" }]);
    expect(g.nodes.find((n) => n.kind === "agent")!.title).toBe("Repair account-switch claims");
  });
});
