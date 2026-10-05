import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { Files, isAttributed } from "../src/pages/Files";
import type { FileRowView } from "../src/lib/types";

function renderFiles(tweak?: (c: MockDaemonClient) => void) {
  const store = new LiveStore();
  const client = new MockDaemonClient(store, { live: false });
  tweak?.(client);
  render(
    <DaemonProvider daemon={{ store, client }}>
      <Files />
    </DaemonProvider>,
  );
  return client;
}

const chip = (name: RegExp) => screen.getByRole("button", { name });
const tableRows = () => [...document.querySelectorAll<HTMLElement>(".tr.tr--tall")];
const rowFor = (path: string) => tableRows().find((r) => r.textContent!.includes(path))!;

afterEach(cleanup);

describe("Files page", () => {
  it("shows a loading state until the first query answers", async () => {
    renderFiles((c) => {
      c.query = () => new Promise(() => {});
    });
    expect(await screen.findByText(/Loading file activity/)).toBeTruthy();
  });

  it("shows an error with a way to retry when the query fails", async () => {
    let fail = true;
    const client = renderFiles((c) => {
      const real = c.query.bind(c);
      c.query = ((name: string, params?: Record<string, unknown>) => (fail ? Promise.reject(new Error("daemon said no")) : real(name, params))) as typeof c.query;
    });
    expect((await screen.findByRole("alert")).textContent).toContain("daemon said no");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("src/auth/session.ts", undefined, { timeout: 4000 }); // refresh is throttled to 1.5s
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client).toBeTruthy();
  });

  it("counts the filters and filters rows", async () => {
    renderFiles();
    await screen.findByText("src/auth/session.ts");
    expect(tableRows()).toHaveLength(9);
    expect(chip(/^All/).textContent).toBe("All9");
    expect(chip(/^Edited/).textContent).toBe("Edited4");
    expect(chip(/^Read/).textContent).toBe("Read2");
    expect(chip(/^Not attributed/).textContent).toBe("Not attributed3");

    fireEvent.click(chip(/^Edited/));
    expect(chip(/^Edited/).getAttribute("aria-pressed")).toBe("true");
    expect(tableRows().map((r) => r.querySelector(".fl-path__text")!.textContent).sort()).toEqual(["src/auth/session.ts", "src/db/schema.ts", "src/invoice/totals.test.ts", "src/invoice/totals.ts"]);

    fireEvent.click(chip(/^Read/));
    expect(tableRows()).toHaveLength(2);
    expect(tableRows().every((r) => r.querySelector(".fl-op")!.textContent === "Read")).toBe(true);
  });

  it("never attributes observed or low-confidence changes to an agent", async () => {
    renderFiles();
    await screen.findByText("src/auth/session.ts");

    const observed = rowFor("src/auth/session.test.ts");
    expect(within(observed).getByText("not attributed")).toBeTruthy();
    expect(within(observed).getByText("Changed")).toBeTruthy();
    expect(within(observed).getByText("Low")).toBeTruthy();
    expect(within(observed).getByText("filesystem")).toBeTruthy();

    const baseline = rowFor("pnpm-lock.yaml");
    expect(within(baseline).getByText("not attributed")).toBeTruthy();
    expect(within(baseline).getByText("Dirty")).toBeTruthy();
    expect(within(baseline).getByText("at start")).toBeTruthy();
    expect(within(baseline).getByText("git baseline")).toBeTruthy();

    const reported = rowFor("src/db/schema.ts");
    expect(within(reported).getByText("worker")).toBeTruthy();
    expect(within(reported).getByText("+12 −3")).toBeTruthy();
    expect(within(reported).getByText("auth-service")).toBeTruthy();

    fireEvent.click(chip(/^Not attributed/));
    expect(tableRows().map((r) => r.querySelector(".fl-path__text")!.textContent).sort()).toEqual(["pnpm-lock.yaml", "src/auth/session.test.ts", "src/index.ts"]);
  });

  it("drops an agent name the daemon should not have sent for a low-confidence row", async () => {
    const leaky: FileRowView = { path: "leak.ts", sessionId: "s1", provider: "claude-code", operation: "write", additions: 1, deletions: 0, agentName: "main", source: "filesystem", confidence: "low", lastAt: "2026-01-01T00:00:00.000Z", touches: 1 };
    expect(isAttributed(leaky)).toBe(false);
    renderFiles((c) => {
      c.data.files = [leaky as never];
    });
    await screen.findByText("leak.ts");
    const row = rowFor("leak.ts");
    expect(within(row).getByText("not attributed")).toBeTruthy();
    expect(within(row).queryByText("main")).toBeNull();
  });

  it("does not invent a shared-diff tag and keeps the privacy footer", async () => {
    renderFiles();
    await screen.findByText("src/auth/session.ts");
    expect(screen.queryByText(/shared diff/i)).toBeNull();
    expect(screen.getByText(/File contents are never stored/)).toBeTruthy();
  });

  it("explains an empty result", async () => {
    renderFiles((c) => {
      c.data.files = [];
    });
    expect(await screen.findByText("No file activity yet")).toBeTruthy();
    expect(chip(/^All/).textContent).toBe("All0");
  });

  it("explains an empty filter", async () => {
    renderFiles((c) => {
      c.data.files = c.data.files.filter((f) => f.operation !== "read");
    });
    await screen.findByText("src/auth/session.ts");
    fireEvent.click(chip(/^Read/));
    await waitFor(() => expect(screen.getByText("No files match this filter")).toBeTruthy());
  });
});
