import { useEffect, useMemo, useState } from "react";
import { ProviderIcon } from "../components/icons";
import { isProviderSource, type AgentView, type Confidence, type SessionView } from "@agentwatch/protocol";
import { Chips, Conf, Empty, EmptyState, PageHead, Panel } from "../components/ui";
import { clock, duration, providerLabel, agentName as readableAgentName, sessionTitle } from "../lib/format";
import { useLive } from "../lib/context";
import { agentsOf, sessionList } from "../lib/store";
import "../styles/agents.css";

type ProviderFilter = "all" | "claude-code" | "codex" | "gemini-cli" | "antigravity" | "cursor" | "generic";

const PROVIDER_COLOR: Record<string, string> = { "claude-code": "var(--g-ed)", codex: "var(--g-c8)", "gemini-cli": "var(--g-bd)", antigravity: "var(--g-85)", cursor: "var(--g-a3)", generic: "var(--g-99)" };
const LOW_FIRST = ["pty", "filesystem", "git", "process"];

const STATE: Record<string, { text: string; tone: string }> = {
  running: { text: "● running", tone: "tone-run" },
  waiting: { text: "! needs approval", tone: "tone-ask" },
  idle: { text: "○ idle", tone: "tone-muted" },
  done: { text: "✓ done", tone: "tone-muted" },
  failed: { text: "✕ failed", tone: "tone-fail" },
};

const COLUMNS = "minmax(0,1.2fr) 128px minmax(0,1.4fr) 76px 72px 150px";

/** [signal, Claude Code, Codex, Gemini CLI, Antigravity CLI, Cursor, Generic CLI]. A dash means the provider cannot tell AgentWatch. */
export const SIGNAL_MATRIX: ReadonlyArray<readonly [string, string, string, string, string, string, string]> = [
  ["Session lifecycle", "High · hooks", "High · hooks / API", "High · hooks", "Partial · hooks", "Partial · hooks", "High when wrapped"],
  ["Tool calls", "High · hooks", "High · hooks / API", "High · hooks", "High · hooks", "High · hooks", "Low · heuristic"],
  ["File writes", "High · tool events", "High · fileChange items", "High · write tools", "Partial · write tools", "High · afterFileEdit", "Med · filesystem"],
  ["Commands", "High · Bash tool", "High · command items", "High · shell tool", "High · run_command", "High · after shell", "Med · process tree"],
  ["Subagents", "High · agent_id", "High · agent_id", "—", "—", "—", "—"],
  ["Approval needed", "High · PermissionRequest", "High · approval requests", "—", "—", "—", "—"],
  ["Token usage", "Partial · only if stable", "High · App Server only", "—", "—", "—", "—"],
];

function matrixTone(v: string): string {
  if (v === "—") return "mx-val--none";
  return /^(Partial|Med|Low|When)/.test(v) ? "mx-val--partial" : "mx-val--strong";
}

/** Strongest evidence for a session's agents: a provider hook/API source means high, otherwise the weakest observed source. */
export function sessionEvidence(s: SessionView): { conf: Confidence; source: string } | undefined {
  const hook = s.sources.find(isProviderSource);
  if (hook) return { conf: "high", source: hook };
  if (s.sources.length === 0) return undefined;
  const lowest = [...s.sources].sort((a, b) => LOW_FIRST.indexOf(a) - LOW_FIRST.indexOf(b))[0]!;
  return { conf: lowest === "process" ? "medium" : "low", source: lowest };
}

export interface TreeRow {
  agent: AgentView;
  depth: number;
}

/** Main agent first, then its children by start time, indented by parentAgentId depth. */
export function orderAgents(agents: readonly AgentView[]): TreeRow[] {
  const ids = new Set(agents.map((a) => a.id));
  const children = new Map<string, AgentView[]>();
  const roots: AgentView[] = [];
  for (const a of agents) {
    if (a.parentAgentId && ids.has(a.parentAgentId) && a.parentAgentId !== a.id) children.set(a.parentAgentId, [...(children.get(a.parentAgentId) ?? []), a]);
    else roots.push(a);
  }
  const isMain = (a: AgentView) => !a.parentAgentId && a.id.endsWith(":main");
  roots.sort((a, b) => Number(isMain(b)) - Number(isMain(a)) || a.startedAt.localeCompare(b.startedAt));
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (a: AgentView, depth: number) => {
    if (seen.has(a.id)) return;
    seen.add(a.id);
    out.push({ agent: a, depth });
    for (const c of [...(children.get(a.id) ?? [])].sort((x, y) => x.startedAt.localeCompare(y.startedAt))) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const a of agents) walk(a, 0); // anything caught in a parent cycle
  return out;
}

function agentDisplayName(a: AgentView, s: SessionView, depth: number, ordinal: number): string {
  if (depth === 0 && s.provider === "generic" && s.executable) return s.executable.split("/").pop() ?? s.executable;
  return depth === 0 ? a.displayName ?? "main" : readableAgentName(a, ordinal);
}

function agentRole(a: AgentView, s: SessionView, depth: number): string {
  if (depth === 0 && s.provider === "generic") return "wrapped process";
  return a.role ?? a.model ?? (depth === 0 ? "main agent" : "subagent");
}

function nowText(a: AgentView): string {
  if (a.status === "failed") return a.failureNote ?? a.lastAction ?? "—";
  if (a.lastAction) return a.lastAction;
  if (a.status === "done" && a.endedAt) return `finished ${clock(a.endedAt)}`;
  return a.failureNote ?? "—";
}

const isTicking = (a: AgentView, s: SessionView) => !a.endedAt && !s.endedAt && a.status !== "done" && a.status !== "failed";

export function Agents() {
  const live = useLive();
  const [filter, setFilter] = useState<ProviderFilter>("all");
  const [now, setNow] = useState(() => Date.now());

  const groups = useMemo(
    () =>
      sessionList(live)
        .map((s) => ({ session: s, rows: orderAgents(agentsOf(live, s.id)) }))
        .filter((g) => g.rows.length > 0),
    [live],
  );
  const shown = groups.filter((g) => filter === "all" || g.session.provider === filter);
  const anyTicking = shown.some((g) => g.rows.some((r) => isTicking(r.agent, g.session)));

  useEffect(() => {
    if (!anyTicking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyTicking]);

  return (
    <>
      <PageHead title="Agents" sub="Every main agent and subagent AgentWatch can see, grouped by session.">
        <Chips
          label="Filter by provider"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "claude-code", label: providerLabel["claude-code"]! },
            { value: "codex", label: providerLabel.codex! },
            { value: "gemini-cli", label: providerLabel["gemini-cli"]! },
            { value: "antigravity", label: providerLabel.antigravity! },
            { value: "cursor", label: providerLabel.cursor! },
            { value: "generic", label: providerLabel.generic! },
          ]}
        />
      </PageHead>

      <Panel label="Agent list">
        <div className="tablewrap">
          <div className="table" style={{ ["--cols" as string]: COLUMNS, ["--min" as string]: "930px" }}>
            <div className="tr tr--head">
              <span>Agent</span><span>State</span><span>Now</span><span>Tools</span><span>Up</span><span>Evidence</span>
            </div>
            {shown.length === 0 && (
              groups.length === 0 ? (
                live.status === "connecting" ? (
                  <Empty>Connecting to agentwatchd…</Empty>
                ) : (
                  <EmptyState visual="radar" icon="sparkles" title="No agents yet" hint="Each agent session, and every subagent it starts, appears here with what it is doing right now." action={{ label: "Check the connections", href: "#/settings" }} />
                )
              ) : (
                <EmptyState icon="search" title={`No ${providerLabel[filter] ?? filter} agents right now`} hint="Choose All to see every provider." compact />
              )
            )}
            {shown.map(({ session: s, rows }) => {
              const ev = sessionEvidence(s);
              // "subagent N": N is the start order among the agents at the same depth under the same parent
              const ordinalOf = (a: AgentView) => rows.filter((r) => r.agent.parentAgentId === a.parentAgentId).findIndex((r) => r.agent.id === a.id) + 1;
              return (
                <div key={s.id} role="group" aria-label={`${sessionTitle(s)}, ${providerLabel[s.provider] ?? s.provider}`} data-session-id={s.id}>
                  <div className="ag-head">
                    <ProviderIcon provider={s.provider} size={16} />
                    <span className="ag-head__title">{sessionTitle(s)}</span>
                    <span className="ag-head__prov" style={{ color: PROVIDER_COLOR[s.provider] }}>{providerLabel[s.provider] ?? s.provider}</span>
                  </div>
                  {rows.map(({ agent: a, depth }) => {
                    const st = STATE[a.status] ?? { text: a.status, tone: "tone-muted" };
                    const end = a.endedAt ? Date.parse(a.endedAt) : s.endedAt ? Date.parse(s.endedAt) : now;
                    const now_ = nowText(a);
                    return (
                      <div key={a.id} className={`tr tr--tall${a.status === "waiting" ? " tr--ask" : ""}`} data-agent-id={a.id} data-depth={depth}>
                        <span className="ag-name" style={{ paddingLeft: depth * 22 }}>
                          {depth > 0 && <span className="ag-name__branch" aria-hidden="true">└</span>}
                          <span className="ag-name__text">
                            <span className="ag-name__name">{agentDisplayName(a, s, depth, ordinalOf(a))}</span>
                            <span className="ag-name__role">{agentRole(a, s, depth)}</span>
                          </span>
                        </span>
                        <span className={`ag-state ${st.tone}`}>{st.text}</span>
                        <span className="cell-mono cell-ellipsis muted" title={now_}>{now_}</span>
                        <span className="cell-mono" style={{ fontWeight: 500 }}>{s.provider === "generic" ? "—" : a.toolCount}</span>
                        <span className="ag-up">{duration(end - Date.parse(a.startedAt))}</span>
                        <span className="ag-evid">
                          {ev ? (
                            <>
                              <Conf level={ev.conf} />
                              <span className="ag-src">{ev.source}</span>
                            </>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </Panel>

      <Panel title="What each provider exposes" label="Signal fidelity" right={<span className="mx-note">why some rows show less detail</span>} foot="A dash means AgentWatch cannot know it for that provider and shows nothing instead of a guess.">
        <div className="tablewrap">
          <div className="table" style={{ ["--cols" as string]: "minmax(0,1.1fr) repeat(6, minmax(0,1fr))", ["--min" as string]: "1060px" }}>
            <div className="tr tr--head">
              <span>Signal</span><span>Claude Code</span><span>Codex</span><span>Gemini CLI</span><span>Antigravity CLI</span><span>Cursor</span><span>Generic CLI</span>
            </div>
            {SIGNAL_MATRIX.map(([signal, ...vals]) => (
              <div key={signal} className="tr" data-signal={signal}>
                <span className="mx-signal">{signal}</span>
                {vals.map((v, i) => (
                  <span key={i} className={`mx-val ${matrixTone(v)}`}>
                    {v === "—" ? (
                      <>
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">cannot be known</span>
                      </>
                    ) : (
                      v
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </>
  );
}
