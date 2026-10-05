import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RequestView } from "@agentwatch/protocol";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient, type MockCommand } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { Commands, isAwaiting, kindOf } from "../src/pages/Commands";
import type { CommandRowView } from "../src/lib/types";

function renderCommands(tweak?: (c: MockDaemonClient) => void) {
  const store = new LiveStore();
  const client = new MockDaemonClient(store, { live: false });
  tweak?.(client);
  render(
    <DaemonProvider daemon={{ store, client }}>
      <Commands />
    </DaemonProvider>,
  );
  return client;
}

const chip = (name: RegExp) => screen.getByRole("button", { name });
const tableRows = () => [...document.querySelectorAll<HTMLElement>(".tr.tr--tall")];
const cmds = () => tableRows().map((r) => r.querySelector(".cm-cmd__text")!.textContent);
const rowFor = (cmd: string) => tableRows().find((r) => r.querySelector(".cm-cmd__text")!.textContent === cmd)!;

afterEach(cleanup);

describe("Commands page", () => {
  it("shows a loading state until the first query answers", async () => {
    renderCommands((c) => {
      c.query = () => new Promise(() => {});
    });
    expect(await screen.findByText(/Loading commands/)).toBeTruthy();
  });

  it("shows an error with a way to retry when the query fails", async () => {
    let fail = true;
    renderCommands((c) => {
      const real = c.query.bind(c);
      c.query = ((name: string, params?: Record<string, unknown>) => (fail ? Promise.reject(new Error("db locked")) : real(name, params))) as typeof c.query;
    });
    expect((await screen.findByRole("alert")).textContent).toContain("db locked");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("pnpm test", undefined, { timeout: 4000 }); // refresh is throttled to 1.5s
  });

  it("counts and applies the Running, Awaiting you and Failed filters", async () => {
    renderCommands();
    await screen.findByText("pnpm test");
    expect(tableRows()).toHaveLength(9);
    expect(chip(/^All/).textContent).toBe("All9");
    expect(chip(/^Running/).textContent).toBe("Running1");
    expect(chip(/^Awaiting you/).textContent).toBe("Awaiting you1");
    expect(chip(/^Failed/).textContent).toBe("Failed2");

    fireEvent.click(chip(/^Running/));
    expect(chip(/^Running/).getAttribute("aria-pressed")).toBe("true");
    expect(cmds()).toEqual(["pnpm dev --port 4010"]);

    fireEvent.click(chip(/^Awaiting you/));
    expect(cmds()).toEqual(["rm -rf dist && pnpm build"]);

    fireEvent.click(chip(/^Failed/));
    expect(cmds().sort()).toEqual(["pnpm test", "vitest run  (child process)"]);
  });

  it("renders results and tints failed and awaiting rows", async () => {
    renderCommands();
    await screen.findByText("pnpm test");

    const failed = rowFor("pnpm test");
    expect(failed.className).toContain("tr--fail");
    expect(within(failed).getByText("exit 1")).toBeTruthy();
    expect(within(failed).getByText("worker")).toBeTruthy();
    expect(within(failed).getByText("auth-service")).toBeTruthy();
    expect(within(failed).getByText("claude-hook")).toBeTruthy();

    const ask = rowFor("rm -rf dist && pnpm build");
    expect(ask.className).toContain("tr--ask");
    expect(within(ask).getByText("! awaiting you")).toBeTruthy();
    expect(ask.querySelector(".cm-time")!.textContent).toBe("—");

    const run = rowFor("pnpm dev --port 4010");
    expect(within(run).getByText("● running")).toBeTruthy();
    expect(run.className).not.toContain("tr--fail");
    expect(run.querySelector(".cm-time")!.textContent).toMatch(/^\d\d:\d\d$/);

    const ok = rowFor("git diff --stat");
    expect(within(ok).getByText("exit 0")).toBeTruthy();
    // mock data has this one ending before it started, so no duration is invented
    expect(ok.querySelector(".cm-time")!.textContent).toBe("—");
    expect(failed.querySelector(".cm-time")!.textContent).toMatch(/^\d+\.\ds$/);
  });

  it("shows an unknown exit code for process-sampled commands, without an agent", async () => {
    renderCommands();
    await screen.findByText("pnpm test");
    const sampled = rowFor("git status  (child of wrapper)");
    expect(within(sampled).getByText("exit —")).toBeTruthy();
    expect(within(sampled).getByText("unknown")).toBeTruthy();
    expect(within(sampled).getByText("Med")).toBeTruthy();
    expect(within(sampled).getByText("process")).toBeTruthy();
    expect(sampled.className).not.toContain("tr--fail");
    // unknown is neither running nor failed
    fireEvent.click(chip(/^Running/));
    expect(cmds()).not.toContain("git status  (child of wrapper)");
  });

  it("tags commands that were redacted before storage, and only those", async () => {
    renderCommands();
    await screen.findByText("pnpm test");
    const tags = screen.getAllByText("Redacted before storage");
    expect(tags).toHaveLength(1);
    const row = tags[0]!.closest<HTMLElement>(".tr")!;
    expect(within(row).getByText(/Bearer \[REDACTED\]/)).toBeTruthy();
    expect(rowFor("pnpm test").textContent).not.toContain("Redacted before storage");
  });

  it("lists newest first", async () => {
    renderCommands();
    await screen.findByText("pnpm test");
    const starts = tableRows().map((r) => r.querySelector(".cell-mono")!.getAttribute("title")!);
    expect([...starts].sort().reverse()).toEqual(starts);
  });

  it("explains empty results and empty filters", async () => {
    renderCommands((c) => {
      c.data.commands = [];
    });
    expect(await screen.findByText("No commands yet")).toBeTruthy();
    cleanup();
    renderCommands((c) => {
      c.data.commands = c.data.commands.filter((x: MockCommand) => x.exitCode !== 1);
    });
    await screen.findByText("git diff --stat");
    fireEvent.click(chip(/^Failed/));
    expect(screen.getByText("No commands match this filter")).toBeTruthy();
  });
});

describe("command classification", () => {
  const row = (over: Partial<CommandRowView> = {}): CommandRowView => ({ id: "c", sessionId: "s2", provider: "codex", argvDisplay: "make", startedAt: "2026-01-01T00:00:00.000Z", source: "codex-app-server", confidence: "high", redacted: false, ...over });
  const ask = (over: Partial<RequestView> = {}): RequestView => ({ id: "r", sessionId: "s2", kind: "command", status: "pending", summary: "make", createdAt: "2026-01-01T00:00:00.000Z", source: "codex-app-server", ...over }) as RequestView;

  it("only waits on you for a pending request with the same text in the same session", () => {
    expect(isAwaiting(row(), [ask()])).toBe(true);
    expect(isAwaiting(row(), [ask({ summary: "make all" })])).toBe(false);
    expect(isAwaiting(row(), [ask({ sessionId: "s9" })])).toBe(false);
    expect(isAwaiting(row(), [ask({ status: "resolved" })])).toBe(false);
    expect(isAwaiting(row({ exitCode: 0 }), [ask()])).toBe(false);
  });

  it("classifies running, failed, ok and unknown", () => {
    expect(kindOf(row(), [])).toBe("run");
    expect(kindOf(row(), [ask()])).toBe("ask");
    expect(kindOf(row({ exitCode: 2 }), [])).toBe("fail");
    expect(kindOf(row({ exitCode: 0, endedAt: "2026-01-01T00:00:01.000Z" }), [])).toBe("ok");
    expect(kindOf(row({ exitCode: null, endedAt: "2026-01-01T00:00:01.000Z" }), [])).toBe("unknown");
  });
});
