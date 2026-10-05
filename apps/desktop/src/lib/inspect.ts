import type { AgentEvent, AgentView, SessionView } from "@agentwatch/protocol";
import { MAX_SHOWN, SOURCE_DESC, agentTone, type GNode, type Tone } from "./graph";
import { agentName, clock, confLabel, describeEvent, duration, isTicking, type LogRow } from "./format";
import { summarizeActivity } from "./activity";

export interface Inspection {
  nodeId: string;
  title: string;
  tag: string;
  tone: Tone;
  state: string;
  facts: Array<[string, string]>;
  /** Files this node touched, newest first. */
  files: Array<{ path: string; op: "read" | "edit" | "changed" | "deleted" }>;
  /** For "back to main" and "+N more": the agents it stands for. */
  members: Array<{ name: string; state: string; tone: Tone }>;
  /** Newest first. */
  recent: LogRow[];
  note?: string;
}

export interface InspectInput {
  session: SessionView;
  agents: readonly AgentView[];
  events: readonly AgentEvent[];
  now: number;
  /** Whether prompt / response text is kept (Settings). Only used for the prompt box. */
  policy?: { prompts: boolean; responses: boolean };
}

const RECENT = 8;
const FILES = 6;

const STATUS_WORD: Record<string, string> = { running: "Running", waiting: "Needs approval", failed: "Failed", done: "Done", idle: "Idle" };

const str = (e: AgentEvent, k: string): string | undefined => (typeof e.payload[k] === "string" ? (e.payload[k] as string) : undefined);

function filesOf(events: readonly AgentEvent[], limit = FILES): Inspection["files"] {
  const seen = new Map<string, Inspection["files"][number]["op"]>();
  for (const e of events) {
    if (e.kind !== "file.read" && e.kind !== "file.write" && e.kind !== "file.delete") continue;
    const path = str(e, "path");
    if (!path) continue;
    const observed = e.confidence === "low" && (e.source === "filesystem" || e.source === "git");
    const op = e.kind === "file.delete" ? "deleted" : e.kind === "file.read" ? "read" : observed ? "changed" : "edit";
    const prev = seen.get(path);
    seen.delete(path); // re-insert so the map stays ordered by last touch
    seen.set(path, prev === "edit" && op === "read" ? "edit" : op);
  }
  return [...seen.entries()].reverse().slice(0, limit).map(([path, op]) => ({ path, op }));
}

function recentRows(events: readonly AgentEvent[], agents: ReadonlyMap<string, AgentView>): LogRow[] {
  const rows: LogRow[] = [];
  for (let i = events.length - 1; i >= 0 && rows.length < RECENT; i--) {
    const r = describeEvent(events[i]!, agents);
    if (r) rows.push(r);
  }
  return rows;
}

function topKinds(events: readonly AgentEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");
}

export type PartKey = "shell" | "files" | "subagents";
export const partId = (k: PartKey): string => `part:${k}`;
export const partOf = (id: string | undefined): PartKey | undefined => (id === "part:shell" || id === "part:files" || id === "part:subagents" ? (id.slice(5) as PartKey) : undefined);

/** The detail behind one chip on the main node. */
export function inspectPart(key: PartKey, { session, agents, events }: Omit<InspectInput, "now">): Inspection {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const live = isTicking(session);
  const act = summarizeActivity(events, live);
  const none = { files: [] as Inspection["files"], members: [] as Inspection["members"] };
  if (key === "shell") {
    const cmds = events.filter((e) => e.kind === "command.started" || e.kind === "command.completed");
    return {
      nodeId: partId(key),
      title: "Shell",
      tag: "commands",
      tone: act.shell.running ? "run" : act.shell.failed ? "fail" : "idle",
      state: "",
      ...none,
      facts: [
        ["Commands", String(act.shell.total)],
        ["Running now", String(act.shell.running)],
        ["Failed", String(act.shell.failed)],
        ["Seen as processes", String(act.shell.observed)],
      ],
      recent: recentRows(cmds, byId),
      note: "Commands the agent ran through its shell tool. Child processes that only the process sampler saw are counted apart: they are lower confidence.",
    };
  }
  if (key === "files") {
    const fe = events.filter((e) => e.kind === "file.read" || e.kind === "file.write" || e.kind === "file.delete");
    return {
      nodeId: partId(key),
      title: "Files",
      tag: "touched",
      tone: "idle",
      state: "",
      ...none,
      facts: [
        ["Read", String(act.files.read)],
        ["Edited", String(act.files.edited)],
        ["Deleted", String(act.files.deleted)],
        ["Seen changing", String(act.files.changed)],
      ],
      files: filesOf(fe, 10),
      recent: recentRows(fe, byId),
      note: act.files.changed ? "\"Seen changing\" comes from the file watcher or Git and is never attributed to an agent." : undefined,
    };
  }
  const mainId = `${session.id}:main`;
  const kids = agents.filter((a) => a.parentAgentId === mainId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const roles = new Map<string, number>();
  for (const a of kids) roles.set(a.role ?? "agent", (roles.get(a.role ?? "agent") ?? 0) + 1);
  const status = (s: string) => kids.filter((a) => a.status === s).length;
  return {
    nodeId: partId(key),
    title: "Subagents",
    tag: "delegated work",
    tone: status("failed") ? "fail" : status("running") ? "run" : "idle",
    state: "",
    ...none,
    facts: kids.length
      ? [
          ["Total", String(kids.length)],
          ["Running", String(status("running"))],
          ["Done", String(status("done"))],
          ["Failed", String(status("failed"))],
          ["By type", [...roles.entries()].map(([r, n]) => `${r} ${n}`).join(" · ")],
        ]
      : [["Total", "0"]],
    members: kids.map((a, i) => ({ name: agentName(a, i + 1), state: STATUS_WORD[a.status] ?? a.status, tone: agentTone(a) })),
    recent: [],
    note: kids.length ? undefined : "This session has not started any subagent.",
  };
}

/** Everything the inspector shows for one graph node. Pure: the same inputs always give the same panel. */
export function inspectNode(node: GNode, { session, agents, events, now, policy }: InspectInput): Inspection {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const base = { nodeId: node.id, title: node.title, tag: node.tag, tone: node.tone, state: node.state, files: [] as Inspection["files"], members: [] as Inspection["members"] };
  const mainId = `${session.id}:main`;
  const kids = agents.filter((a) => a.parentAgentId === mainId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  if (node.kind === "prompt") {
    const asked = events.filter((e) => e.kind === "message" && e.payload.role === "user");
    const keep = policy?.prompts === true;
    const provider = session.provider === "codex" ? "Codex" : "Claude Code";
    return {
      ...base,
      state: "",
      facts: [
        ["User prompts", keep ? String(asked.length) : "not stored"],
        ["Prompt text", keep ? "kept on this Mac (Settings)" : "off · turn on in Settings"],
        ["System prompt", `${provider} · built in${session.model ? ` · ${session.model}` : ""}`],
        ...(session.title ? ([["Conversation", session.title]] as Array<[string, string]>) : []),
      ],
      recent: keep
        ? asked
            .slice(-RECENT)
            .reverse()
            .map((e): LogRow => ({ id: e.id, seq: e.sequence, time: clock(e.occurredAt), agent: "you", kind: "Prompt", text: String(e.payload.body ?? "").replace(/\s+/g, " ").slice(0, 220), tone: "plain", conf: e.confidence, source: e.source, unattributed: false }))
        : [],
      note: `${provider} does not give its system prompt to hooks, so AgentWatch can only say what the agent was set up with. ${keep ? "" : "Your prompts are not stored; turn on Store prompt text in Settings to see them here."}`.trim(),
    };
  }

  if (node.kind === "source") {
    const mine = events.filter((e) => e.source === node.source);
    const last = mine[mine.length - 1];
    const observed = node.conf === "low";
    return {
      ...base,
      facts: [
        ["Evidence", SOURCE_DESC[node.source ?? ""] ?? node.title],
        ["Confidence", node.conf ? confLabel[node.conf] : "—"],
        ["Events", String(mine.length)],
        ["Last event", last ? clock(last.occurredAt) : "none yet"],
        ...(mine.length ? ([["Kinds", topKinds(mine)]] as Array<[string, string]>) : []),
      ],
      files: filesOf(mine),
      recent: recentRows(mine, byId),
      note: observed ? "Observed, not reported by the agent: these changes are never attributed to a specific agent." : undefined,
    };
  }

  if (node.kind === "merge" || node.kind === "more") {
    const shown = kids.length > MAX_SHOWN ? kids.slice(0, MAX_SHOWN - 1) : kids;
    const list = node.kind === "more" ? kids.slice(shown.length) : shown;
    return {
      ...base,
      facts: node.kind === "merge" ? [["Reported", node.state], ["Next", node.detail]] : [["Hidden", `${list.length} more subagents`], ["Why", "the graph shows the first 11 so it stays readable"]],
      members: list.map((a) => ({ name: agentName(a, kids.indexOf(a) + 1), state: STATUS_WORD[a.status] ?? a.status, tone: agentTone(a) })),
      recent: [],
    };
  }

  // an agent (main or a subagent)
  const a = node.agentId ? byId.get(node.agentId) : undefined;
  const mine = events.filter((e) => e.agentId === node.agentId);
  const last = mine[mine.length - 1];
  const isMain = node.kind === "main";
  const started = a ? Date.parse(a.startedAt) : Date.parse(session.startedAt);
  let active: string | undefined;
  if (a?.endedAt) active = duration(Date.parse(a.endedAt) - started);
  else if (a) active = duration((isTicking(session) ? now : Date.parse(a.lastEventAt)) - started);
  const facts: Array<[string, string]> = [["Status", a ? STATUS_WORD[a.status] ?? a.status : node.state.replace(/^\S+\s/, "")]];
  const model = a?.model ?? (isMain ? session.model : undefined);
  if (model) facts.push(["Model", model]);
  if (a?.role && a.role !== node.title) facts.push(["Role", a.role]);
  if (active) facts.push([a?.endedAt ? "Took" : "Active for", active]);
  if (a) facts.push(["Tools used", String(a.toolCount)]);
  const files = filesOf(mine);
  if (mine.length) facts.push(["Commands", String(mine.filter((e) => e.kind === "command.started").length)]);
  if (last) facts.push(["Last event", clock(last.occurredAt)]);
  if (a?.lastAction) facts.push(["Last action", a.lastAction]);
  if (a?.failureNote) facts.push(["Failure", a.failureNote]);
  return { ...base, facts, files, recent: recentRows(mine, byId), note: mine.length ? undefined : "No events from this agent in the live buffer yet." };
}
