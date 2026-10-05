import type { AgentEvent } from "@agentwatch/protocol";

/** Shapes the daemon returns from the `files`, `commands` and `logs` queries. */
export interface FileRowView {
  path: string;
  sessionId: string;
  repo?: string;
  provider: string;
  operation: string; // read | write | delete (git baseline rows use "dirty" in the mock)
  additions: number;
  deletions: number;
  /** Set only when a provider reported the change. Observed changes are never attributed. */
  agentName?: string;
  source: string;
  confidence: "high" | "medium" | "low";
  lastAt: string;
  touches: number;
}

export interface CommandRowView {
  id: string;
  sessionId: string;
  repo?: string;
  provider: string;
  agentName?: string;
  argvDisplay: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string;
  source: string;
  confidence: "high" | "medium" | "low";
  redacted: boolean;
}

export interface DiagnosticRow {
  t: string;
  level: "INFO" | "WARN" | "ERROR";
  where: string;
  msg: string;
}

export interface LogsResult {
  events: AgentEvent[];
  diagnostics: DiagnosticRow[];
}
