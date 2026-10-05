import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { Logs } from "../src/pages/Logs";
import { event, resetSeq } from "./fixtures";

const save = vi.fn();
vi.mock("../src/lib/native", () => ({ saveTextFile: (...a: unknown[]) => save(...a), openDashboard: vi.fn(), isTauri: () => false }));

function setup(prep?: (m: MockDaemonClient) => void) {
  const store = new LiveStore();
  const mock = new MockDaemonClient(store, { live: false });
  prep?.(mock);
  render(
    <DaemonProvider daemon={{ store, client: mock }}>
      <Logs />
    </DaemonProvider>,
  );
  return mock;
}

const rowsOf = () => screen.getAllByTestId("event-row");
const srcOf = (row: HTMLElement) => within(row).getAllByRole("cell")[5]!.textContent;

beforeEach(() => {
  resetSeq();
  save.mockClear();
});
afterEach(cleanup);

describe("Logs: events", () => {
  it("lists normalized events newest sequence first, with raw kind, summary, source and confidence", async () => {
    setup();
    await screen.findAllByTestId("event-row");
    const seqs = rowsOf().map((r) => Number(within(r).getAllByRole("cell")[0]!.textContent));
    expect(seqs.length).toBeGreaterThan(10);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    // describeEvent summary for a write, raw kind in the kind column
    const write = rowsOf().find((r) => within(r).queryByText("src/auth/session.ts +9 −2"));
    expect(write).toBeTruthy();
    expect(within(write!).getByText("file.write")).toBeTruthy();
    expect(within(write!).getByText("claude-hook")).toBeTruthy();
    expect(within(write!).getByText("High")).toBeTruthy();
    expect(within(write!).getByText("auth-service")).toBeTruthy();
  });

  it("filters by source and shows an empty message when nothing matches", async () => {
    setup();
    await screen.findAllByTestId("event-row");
    const group = screen.getByRole("group", { name: "Filter by source" });
    fireEvent.click(within(group).getByRole("button", { name: "Filesystem" }));
    expect(within(group).getByRole("button", { name: "Filesystem" }).getAttribute("aria-pressed")).toBe("true");
    const fs = rowsOf();
    expect(fs.length).toBe(2);
    for (const r of fs) expect(srcOf(r)).toBe("filesystem");
    fireEvent.click(within(group).getByRole("button", { name: "Hooks and API" }));
    for (const r of rowsOf()) expect(["claude-hook", "codex-hook", "codex-app-server"]).toContain(srcOf(r));
    fireEvent.click(within(group).getByRole("button", { name: "Git" }));
    expect(screen.queryAllByTestId("event-row").length).toBe(0);
    expect(screen.getByText("No events from this source")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "All" }));
    expect(rowsOf().length).toBeGreaterThan(10);
  });

  it("tags redacted events", async () => {
    setup((m) => {
      m.data.events.push(event({ id: "red1", sequence: 999, kind: "command.started", payload: { argvDisplay: 'curl -H "Authorization: Bearer [REDACTED]" …' }, redacted: true }));
    });
    const row = (await screen.findByText(/Bearer \[REDACTED\]/)).closest("[data-testid=event-row]") as HTMLElement;
    expect(within(row).getByText("Redacted")).toBeTruthy();
    expect(screen.getAllByText("Redacted").length).toBe(1);
  });
});

describe("Logs: diagnostics", () => {
  it("shows daemon lines with level colors and exports a redacted JSON bundle on this Mac", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    await screen.findByText(/ui client authenticated/);
    const rows = screen.getAllByTestId("diag-row");
    expect(rows.length).toBe(4);
    expect(screen.getByText("WARN").className).toContain("tone-ask");
    expect(screen.getByText("ERROR").className).toContain("tone-fail");
    expect(screen.getByText(/Nothing is uploaded/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Export redacted bundle" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [name, text] = save.mock.calls[0] as [string, string];
    expect(name).toMatch(/^agentwatch-diagnostics-.*\.json$/);
    const bundle = JSON.parse(text);
    expect(bundle.diagnostics).toHaveLength(4);
    expect(bundle.eventCounts.total).toBeGreaterThan(0);
    expect(text).not.toContain("src/auth/session.ts"); // payloads are not exported
  });
});
