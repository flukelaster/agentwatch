import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { Sessions } from "../src/pages/Sessions";

function setup() {
  const store = new LiveStore();
  const mock = new MockDaemonClient(store, { live: false });
  render(
    <DaemonProvider daemon={{ store, client: mock }}>
      <Sessions />
    </DaemonProvider>,
  );
  return { store, mock };
}

const chip = (name: RegExp) => screen.getByRole("button", { name });
const list = () => screen.getByRole("region", { name: "Session list" });
const rowFor = (repo: string) => within(list()).getByRole("link", { name: repo }).closest(".tr") as HTMLElement;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(cleanup);

describe("Sessions page", () => {
  it("shows the real retention and one row per session with honest token text", async () => {
    setup();
    expect(await screen.findByText("Running now and kept locally for 14 days.")).toBeTruthy();
    for (const repo of ["auth-service", "billing-web", "notes-cli", "api-gateway", "docs-site"]) expect(within(list()).getByRole("link", { name: repo })).toBeTruthy();
    // provider-reported value only, otherwise "not reported" / "unavailable"
    expect(within(rowFor("billing-web")).getByText("61.4k reported")).toBeTruthy();
    expect(within(rowFor("auth-service")).getByText("not reported")).toBeTruthy();
    expect(within(rowFor("notes-cli")).getByText("unavailable")).toBeTruthy();
    expect(within(rowFor("auth-service")).getByText((_, el) => el?.className === "diff" && el.textContent === "+142 −38")).toBeTruthy();
    expect(screen.getByText(/Tokens appear only when the provider reports them/)).toBeTruthy();
  });

  it("links each session to its detail page", () => {
    setup();
    const a = within(list()).getByRole("link", { name: "billing-web" });
    expect(a.getAttribute("href")).toBe("#/sessions/s2");
  });

  it("counts and filters by group", () => {
    setup();
    expect(chip(/^All/).textContent).toBe("All5");
    expect(chip(/^Active/).textContent).toBe("Active3");
    expect(chip(/^Needs you/).textContent).toBe("Needs you1");
    expect(chip(/^Finished/).textContent).toBe("Finished1");
    expect(chip(/^Failed/).textContent).toBe("Failed1");

    fireEvent.click(chip(/^Needs you/));
    expect(chip(/^Needs you/).getAttribute("aria-pressed")).toBe("true");
    expect(within(list()).getAllByRole("link").map((l) => l.textContent)).toEqual(["billing-web"]);

    fireEvent.click(chip(/^Active/));
    expect(within(list()).getAllByRole("link")).toHaveLength(3);

    fireEvent.click(chip(/^Failed/));
    expect(within(list()).getAllByRole("link").map((l) => l.textContent)).toEqual(["docs-site"]);
  });

  it("offers delete only for finished and failed sessions", () => {
    setup();
    expect(within(list()).getAllByRole("button", { name: /^Delete session/ })).toHaveLength(2);
    for (const repo of ["auth-service", "billing-web", "notes-cli"]) expect(within(rowFor(repo)).queryByRole("button")).toBeNull();
    expect(within(rowFor("api-gateway")).getByRole("button", { name: /^Delete session api-gateway from / })).toBeTruthy();
  });

  it("deletes through the daemon command and drops the row when the removed frame arrives", async () => {
    const { mock } = setup();
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const orig = mock.command.bind(mock);
    mock.command = (async (name: string, params?: Record<string, unknown>) => {
      calls.push([name, params]);
      return orig(name, params);
    }) as typeof mock.command;

    fireEvent.click(within(rowFor("api-gateway")).getByRole("button", { name: /^Delete session api-gateway/ }));
    await waitFor(() => expect(within(list()).queryByRole("link", { name: "api-gateway" })).toBeNull());
    expect(calls).toEqual([["deleteSession", { sessionId: "s4" }]]);
    expect(chip(/^All/).textContent).toBe("All4");
    expect(chip(/^Finished/).textContent).toBe("Finished0");
    expect(within(list()).getByRole("link", { name: "billing-web" })).toBeTruthy();
  });

  it("shows an empty state when the filter has no matches", async () => {
    setup();
    fireEvent.click(chip(/^Failed/));
    fireEvent.click(within(list()).getByRole("button", { name: /^Delete session docs-site/ }));
    await waitFor(() => expect(screen.getByText("No sessions match this filter")).toBeTruthy());
  });

  it("keeps the row and reports an error when the delete fails", async () => {
    const { mock } = setup();
    mock.command = (async () => {
      throw new Error("daemon busy");
    }) as typeof mock.command;
    fireEvent.click(within(rowFor("api-gateway")).getByRole("button", { name: /^Delete session api-gateway/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not delete api-gateway: daemon busy");
    expect(within(list()).getByRole("link", { name: "api-gateway" })).toBeTruthy();
  });

  it("explains the empty list when there are no sessions at all", () => {
    const store = new LiveStore();
    const client = new MockDaemonClient(store, { live: false });
    client.data.sessions = [];
    client.data.agents = [];
    client.data.events = [];
    client.data.requests = [];
    render(
      <DaemonProvider daemon={{ store, client }}>
        <Sessions />
      </DaemonProvider>,
    );
    expect(screen.getByText(/No sessions yet/)).toBeTruthy();
    expect(chip(/^All/).textContent).toBe("All0");
  });
});
