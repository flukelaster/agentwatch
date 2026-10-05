import { redactText } from "@agentwatch/protocol";

export interface DiagnosticEntry {
  t: string;
  level: "INFO" | "WARN" | "ERROR";
  where: string;
  msg: string;
}

/** In-memory ring of the daemon's own sanitized log lines, shown on the Logs screen. */
export class Diagnostics {
  private readonly entries: DiagnosticEntry[] = [];
  constructor(
    private readonly max = 200,
    private readonly sink: ((line: string) => void) | null = (line) => process.stdout.write(line + "\n"),
  ) {}

  log(level: DiagnosticEntry["level"], where: string, msg: string): void {
    const entry: DiagnosticEntry = { t: new Date().toISOString(), level, where, msg: redactText(msg).text.slice(0, 400) };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    this.sink?.(`${entry.t} ${level.padEnd(5)} ${where} ${entry.msg}`);
  }
  info(where: string, msg: string): void {
    this.log("INFO", where, msg);
  }
  warn(where: string, msg: string): void {
    this.log("WARN", where, msg);
  }
  error(where: string, msg: string): void {
    this.log("ERROR", where, msg);
  }
  recent(limit = 100): DiagnosticEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
