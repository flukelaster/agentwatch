import type { AgentView, Confidence, SessionView } from "@agentwatch/protocol";
import type { Activity } from "./activity";
import { agentName } from "./format";
import { MAX_CONFIDENCE_BY_SOURCE, isProviderSource, type EventSource } from "@agentwatch/protocol";

export type Pt = [number, number];
export type Tone = "run" | "ask" | "fail" | "idle" | "done" | "src";

/** What the first box of the graph shows. Text is only ever filled in while the person has turned prompt storage on. */
export interface PromptInfo {
  /** The latest prompt, one line. Absent when text is not stored or nothing has been read yet. */
  userText?: string;
  /** Always shown: how many prompts, or why there is no text. */
  userNote: string;
  /** What is known about the system prompt. */
  systemText: string;
}

/** One breakdown chip on the main node: what it works through (subagents, shell, files) and how many. */
export interface GPart {
  key: "subagents" | "shell" | "files";
  label: string;
  value: string;
  sub: string;
  tone: Tone;
}

export interface GNode {
  id: string;
  kind: "main" | "agent" | "source" | "merge" | "more" | "prompt";
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  tag: string;
  state: string;
  tone: Tone;
  detail: string;
  agentId?: string;
  source?: string;
  conf?: Confidence;
  parts?: GPart[];
  /** The input box: what the person asked and what the agent was set up with. */
  prompt?: PromptInfo;
}

export interface GEdge {
  key: string;
  kind: "source" | "delegate" | "return" | "loop";
  pts: Pt[];
  to: string;
  dashed: boolean;
  conf: Confidence;
  fail?: boolean;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: GNode[];
  edges: GEdge[];
  label: string;
  delegateLabel?: { x: number; y: number; text: string; align: "center" | "left" };
  hiddenCount: number;
}

export const KW = 230;
export const KH = 130;
export const GAP = 20;
export const MAIN_W = 400;
export const MAIN_H = 152;
export const SRC_W = 210;
export const SRC_H = 104;
export const PROMPT_H = 188;
export const MAX_PER_ROW = 4;
export const MAX_SHOWN = 12;
const LEFT = 290; // children never start left of this, so the source column keeps clear air

export const SOURCE_DESC: Record<string, string> = {
  "claude-hook": "provider hooks",
  "codex-hook": "provider hooks",
  "gemini-hook": "provider hooks",
  "antigravity-hook": "provider hooks",
  "cursor-hook": "provider hooks",
  "codex-app-server": "structured events",
  process: "process tree sampler",
  filesystem: "file watcher",
  git: "status and numstat",
  pty: "terminal activity",
};

const SOURCE_ORDER = ["claude-hook", "codex-app-server", "codex-hook", "gemini-hook", "antigravity-hook", "cursor-hook", "process", "filesystem", "git", "pty"];

export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function firstWord(text: string | undefined): string | undefined {
  const w = text?.split(/\s+/)[0];
  return w && w.length < 14 ? w : undefined;
}

export function agentTone(a: AgentView): Tone {
  return a.status === "running" ? "run" : a.status === "waiting" ? "ask" : a.status === "failed" ? "fail" : a.status === "done" ? "done" : "idle";
}

function agentState(a: AgentView): { state: string; detail: string } {
  const dur = a.endedAt ? mmss(Date.parse(a.endedAt) - Date.parse(a.startedAt)) : undefined;
  switch (a.status) {
    case "running":
      return { state: `● ${firstWord(a.lastAction) ?? "running"}`, detail: a.lastAction ?? "working" };
    case "waiting":
      return { state: "! needs approval", detail: (a.lastAction ?? "waiting").replace(/^waiting for approval:\s*/, "") };
    case "failed":
      return { state: "✕ failed", detail: a.failureNote ?? a.lastAction ?? "failed" };
    case "done":
      return { state: "✓ done", detail: `${a.toolCount} tools${dur ? ` · ${dur}` : ""}` };
    default:
      return { state: "○ idle", detail: a.lastAction ?? "no recent activity" };
  }
}

function agentTitle(a: AgentView, isMain: boolean, session: SessionView, ordinal?: number): string {
  if (isMain) {
    if (session.provider === "generic" && session.executable) return session.executable.split("/").pop() ?? "agent";
    return "main";
  }
  return agentName(a, ordinal);
}

/** The three chips on the main node: how many subagents, shell commands and files it works through, split by state. */
export function breakdown(agents: readonly AgentView[], activity?: Activity): GPart[] {
  const count = (s: AgentView["status"]) => agents.filter((a) => a.status === s).length;
  const running = count("running");
  const waiting = count("waiting");
  const failed = count("failed");
  const done = count("done");
  const subSub = agents.length ? [running && `${running} running`, waiting && `${waiting} waiting`, done && `${done} done`, failed && `${failed} failed`].filter(Boolean).join(" · ") : "none spawned";
  const sh = activity?.shell;
  const fi = activity?.files;
  const shellSub = !sh || (!sh.total && !sh.observed) ? "none yet" : [sh.running && `${sh.running} running`, sh.failed && `${sh.failed} failed`, sh.observed && `${sh.observed} seen`].filter(Boolean).join(" · ") || "all ok";
  const touched = fi?.touched ?? 0;
  const filesSub = !fi || (!touched && !fi.changed) ? "none yet" : [`${fi.read} read`, `${fi.edited} edited`, fi.changed && `${fi.changed} seen`].filter(Boolean).join(" · ");
  return [
    { key: "subagents", label: "Subagents", value: String(agents.length), sub: subSub, tone: failed ? "fail" : running ? "run" : waiting ? "ask" : agents.length && done === agents.length ? "done" : "idle" },
    { key: "shell", label: "Shell", value: String(sh?.total ?? 0), sub: shellSub, tone: sh?.running ? "run" : sh?.failed ? "fail" : "idle" },
    { key: "files", label: "Files", value: String(touched), sub: filesSub, tone: "idle" },
  ];
}

/**
 * Pure layout of one session's agent graph. Dynamic by construction: any number of subagents (rows of
 * four, then a "+N more" node), any set of evidence sources. Observed sources feed the graph on the
 * left; delegation goes down from the main agent; results return to a merge point and loop back up.
 */
export function layoutGraph(session: SessionView, agents: AgentView[], sourceCounts: Record<string, number> = {}, activity?: Activity, prompt?: PromptInfo): GraphLayout {
  const mainId = `${session.id}:main`;
  const main = agents.find((a) => a.id === mainId);
  const all = agents.filter((a) => a.id !== mainId && a.parentAgentId === mainId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const nestedOf = (id: string) => agents.filter((a) => a.parentAgentId === id).length;
  const shown = all.length > MAX_SHOWN ? all.slice(0, MAX_SHOWN - 1) : all;
  const hiddenCount = all.length - shown.length;
  const nKids = shown.length + (hiddenCount ? 1 : 0);

  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const rows = Math.max(1, Math.ceil(nKids / MAX_PER_ROW));
  const multi = rows > 1;

  // ---- geometry of the main column
  const perRow = multi ? MAX_PER_ROW : Math.max(nKids, 1);
  const rowWidth = perRow * KW + (perRow - 1) * GAP;
  const cx = multi ? LEFT + rowWidth / 2 : nKids ? Math.max(655, LEFT + rowWidth / 2) : 655;
  const mainY = nKids ? 16 : 140;
  const mainX = cx - MAIN_W / 2;
  const mainCy = mainY + MAIN_H / 2;
  const mainState = main ? agentState(main) : { state: "● running", detail: "" };
  const mainDetail = session.activity && main?.status !== "failed" ? session.activity : mainState.detail;
  nodes.push({
    id: "main",
    kind: "main",
    x: mainX,
    y: mainY,
    w: MAIN_W,
    h: MAIN_H,
    title: main ? agentTitle(main, true, session) : "main",
    tag: ["main agent", session.model ?? main?.model].filter(Boolean).join(" · "),
    state: main ? mainState.state : "● running",
    tone: main ? agentTone(main) : "run",
    detail: mainDetail,
    agentId: mainId,
    parts: breakdown(all, activity),
  });

  // ---- children
  const kidNodes: GNode[] = [];
  const kidPos = (i: number): { x: number; y: number } => {
    const r = Math.floor(i / MAX_PER_ROW);
    const inRow = i - r * MAX_PER_ROW;
    const count = Math.min(MAX_PER_ROW, nKids - r * MAX_PER_ROW);
    const w = multi ? rowWidth : count * KW + (count - 1) * GAP;
    const start = multi ? LEFT : cx - w / 2;
    // the last row of a wrapped layout is left-aligned under the grid like the rest
    return { x: start + inRow * (KW + GAP), y: multi ? 70 + MAIN_H + r * (KH + 76) : 290 };
  };
  const ordinal = new Map(all.map((a, i) => [a.id, i + 1]));
  const titleCount = new Map<string, number>();
  for (const a of shown) titleCount.set(agentTitle(a, false, session, ordinal.get(a.id)), (titleCount.get(agentTitle(a, false, session, ordinal.get(a.id))) ?? 0) + 1);
  const titleFor = (a: AgentView): string => {
    const t = agentTitle(a, false, session, ordinal.get(a.id));
    // two subagents with the same name are told apart by their start order, not by a hash
    return (titleCount.get(t) ?? 0) > 1 ? `${t} #${ordinal.get(a.id)}` : t;
  };
  shown.forEach((a, i) => {
    const s = agentState(a);
    const nested = nestedOf(a.id);
    const { x, y } = kidPos(i);
    kidNodes.push({
      id: a.id,
      kind: "agent",
      x,
      y,
      w: KW,
      h: KH,
      title: titleFor(a),
      tag: "subagent",
      state: s.state,
      tone: agentTone(a),
      detail: nested ? `${s.detail} · +${nested} nested` : s.detail,
      agentId: a.id,
    });
  });
  if (hiddenCount) {
    const { x, y } = kidPos(shown.length);
    kidNodes.push({ id: "more", kind: "more", x, y, w: KW, h: KH, title: `+${hiddenCount} more`, tag: "hidden", state: "subagents", tone: "idle", detail: "Open the Agents page for the full list" });
  }
  nodes.push(...kidNodes);

  // ---- merge node
  let mergeCy = 0;
  let mergeLeft = 0;
  let mergeId = "main";
  let height = 400;
  let loopX = 0;
  let width = 1090;
  const mainRight = mainX + MAIN_W;
  if (nKids) {
    const lastRowBottom = kidNodes.reduce((m, k) => Math.max(m, k.y + k.h), 0);
    const mergeY = multi ? lastRowBottom + 86 : 500;
    const done = shown.filter((a) => a.status === "done").length;
    const failed = shown.filter((a) => a.status === "failed").length;
    const reported = done + failed;
    nodes.push({
      id: "merge",
      kind: "merge",
      x: cx - 150,
      y: mergeY,
      w: 300,
      h: 92,
      title: "back to main",
      tag: "results",
      state: `${reported} of ${all.length} reported`,
      tone: failed ? "fail" : reported === all.length ? "done" : "run",
      detail: failed ? `${failed} failed · main decides next step` : reported === all.length ? "main reviews and continues" : "waiting on the rest",
    });
    mergeId = "merge";
    mergeCy = mergeY + 46;
    mergeLeft = cx - 150;
    height = mergeY + 92 + 20;
    const kidsRight = multi ? LEFT + rowWidth : Math.max(...kidNodes.map((k) => k.x + k.w));
    const rightEdge = Math.max(mainRight, kidsRight);
    loopX = rightEdge + (multi ? 62 : 42);
    width = Math.max(1090, loopX + 28);
  }

  // ---- delegation and return edges
  const failedIds = new Set(shown.filter((a) => a.status === "failed").map((a) => a.id));
  if (nKids && !multi) {
    kidNodes.forEach((k) => {
      const kx = k.x + KW / 2;
      edges.push({ key: `dlg:${k.id}`, kind: "delegate", pts: [[cx, mainY + MAIN_H], [cx, 230], [kx, 230], [kx, k.y]], to: k.id, dashed: false, conf: "high" });
      if (k.kind === "agent") {
        edges.push({ key: `ret:${k.id}`, kind: "return", pts: [[kx, k.y + KH], [kx, 460], [cx, 460], [cx, 500]], to: "merge", dashed: false, conf: "high", fail: failedIds.has(k.id) });
      }
    });
  } else if (nKids && multi) {
    const gutterX = LEFT - 22;
    const rightX = LEFT + rowWidth + 22;
    const mergeTop = nodes.find((n) => n.id === "merge")!.y;
    const mergeRailY = mergeTop - 30;
    kidNodes.forEach((k) => {
      const kx = k.x + KW / 2;
      const railY = k.y - 28;
      edges.push({ key: `dlg:${k.id}`, kind: "delegate", pts: [[cx, mainY + MAIN_H], [cx, mainY + MAIN_H + 24], [gutterX, mainY + MAIN_H + 24], [gutterX, railY], [kx, railY], [kx, k.y]], to: k.id, dashed: false, conf: "high" });
      if (k.kind === "agent") {
        const retY = k.y + KH + 24;
        edges.push({ key: `ret:${k.id}`, kind: "return", pts: [[kx, k.y + KH], [kx, retY], [rightX, retY], [rightX, mergeRailY], [cx, mergeRailY], [cx, mergeTop]], to: "merge", dashed: false, conf: "high", fail: failedIds.has(k.id) });
      }
    });
  }
  if (nKids) {
    edges.push({ key: "loop", kind: "loop", pts: [[cx + 150, mergeCy], [loopX, mergeCy], [loopX, mainCy], [mainRight, mainCy]], to: "main", dashed: true, conf: "high" });
  }

  // ---- sources (left column), ordered, aligned to what they evidence
  const names = Object.keys(sourceCounts)
    .concat(session.sources)
    .filter((s, i, arr) => arr.indexOf(s) === i && s in SOURCE_DESC)
    .sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
  const targetOf = (name: string): { id: string; cy: number; left: number } => {
    if (isProviderSource(name)) return { id: "main", cy: mainCy, left: mainX };
    if (name === "process" && kidNodes[0]) return { id: kidNodes[0].id, cy: kidNodes[0].y + KH / 2, left: kidNodes[0].x };
    if (nKids) return { id: "merge", cy: mergeCy, left: mergeLeft };
    return { id: "main", cy: mainCy, left: mainX };
  };
  const byTarget = new Map<string, string[]>();
  for (const name of names) {
    const t = targetOf(name).id;
    byTarget.set(t, [...(byTarget.get(t) ?? []), name]);
  }
  // Place each source next to what it evidences, then sweep top-down so boxes never overlap
  // or leave the stage (several sources can point at the same target).
  const specs = names.map((name) => {
    const t = targetOf(name);
    const group = byTarget.get(t.id)!;
    const gi = group.indexOf(name);
    return { name, t, desired: t.cy + (gi - (group.length - 1) / 2) * (SRC_H + 16), top: 0, cy: 0 };
  });
  specs.sort((a, b) => a.desired - b.desired);
  // the prompt box is the first box: top left, with the evidence sources below it
  const promptTop = 12;
  let prevBottom = prompt ? promptTop + PROMPT_H : 0;
  for (const sp of specs) {
    sp.top = Math.max(sp.desired - SRC_H / 2, prevBottom + 12, 12);
    sp.cy = sp.top + SRC_H / 2;
    prevBottom = sp.top + SRC_H;
  }
  specs.forEach((sp, order) => {
    const { name, t, top, cy } = sp;
    const conf = MAX_CONFIDENCE_BY_SOURCE[name as EventSource] ?? "low";
    nodes.push({
      id: `src:${name}`,
      kind: "source",
      x: 0,
      y: top,
      w: SRC_W,
      h: SRC_H,
      title: name,
      tag: "source",
      state: SOURCE_DESC[name] ?? name,
      tone: "src",
      detail: `events ${sourceCounts[name] ?? 0}`,
      source: name,
      conf,
    });
    const elbow = SRC_W + 24 + order * 8;
    const pts: Pt[] = cy === t.cy ? [[SRC_W, cy], [t.left, t.cy]] : [[SRC_W, cy], [elbow, cy], [elbow, t.cy], [t.left, t.cy]];
    edges.push({ key: `src:${name}`, kind: "source", pts, to: t.id, dashed: true, conf });
  });
  if (prompt) {
    const cy = promptTop + PROMPT_H / 2;
    nodes.push({
      id: "prompt",
      kind: "prompt",
      x: 0,
      y: promptTop,
      w: SRC_W,
      h: PROMPT_H,
      title: "Prompt",
      tag: "input",
      state: "",
      tone: "src",
      detail: "",
      prompt,
    });
    const elbow = SRC_W + 12;
    edges.push({ key: "prompt", kind: "source", pts: cy === mainCy ? [[SRC_W, cy], [mainX, mainCy]] : [[SRC_W, cy], [elbow, cy], [elbow, mainCy], [mainX, mainCy]], to: "main", dashed: false, conf: "high" });
  }
  const lowestSource = nodes.filter((n) => n.kind === "source" || n.kind === "prompt").reduce((m, n) => Math.max(m, n.y + n.h), 0);
  height = Math.max(height, lowestSource + 20);

  const label =
    `Agent graph for ${session.provider} session: main ${main?.status ?? "running"}` +
    (nKids ? `, delegating to ${shown.map((a) => `${agentTitle(a, false, session)} (${a.status})`).join(", ")}${hiddenCount ? `, and ${hiddenCount} more` : ""}` : ", no subagents visible");

  const delegateLabel = nKids
    ? multi
      ? { x: cx + 12, y: mainY + MAIN_H + 4, text: `delegate · ${all.length} subagents`, align: "left" as const }
      : { x: cx, y: 184, text: `delegate · ${all.length} subagent${all.length > 1 ? "s" : ""}`, align: "center" as const }
    : undefined;

  return { width, height, nodes, edges, label, delegateLabel, hiddenCount };
}

// ---- polyline helpers (shared by the renderer and tests)

export const segLen = (a: Pt, b: Pt): number => Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
export const polyLen = (pts: Pt[]): number => pts.reduce((s, p, i) => (i ? s + segLen(pts[i - 1]!, p) : 0), 0);

export function polyAt(pts: Pt[], d: number): Pt {
  let rem = d;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const L = segLen(a, b);
    if (rem <= L || i === pts.length - 1) {
      const r = L ? Math.min(1, rem / L) : 0;
      return [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r];
    }
    rem -= L;
  }
  return pts[0]!;
}
