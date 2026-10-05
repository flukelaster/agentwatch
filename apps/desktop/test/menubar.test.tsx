import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { MenuBar } from "../src/pages/MenuBar";
import { resetSeq } from "./fixtures";

const open = vi.fn();
vi.mock("../src/lib/native", () => ({ openDashboard: (...a: unknown[]) => open(...a), saveTextFile: vi.fn(), isTauri: () => false }));

function setup(prep?: (m: MockDaemonClient) => void) {
  const store = new LiveStore();
  const mock = new MockDaemonClient(store, { live: false });
  prep?.(mock);
  render(
    <DaemonProvider daemon={{ store, client: mock }}>
      <MenuBar />
    </DaemonProvider>,
  );
  return mock;
}

beforeEach(() => {
  resetSeq();
  open.mockClear();
});
afterEach(cleanup);

describe("MenuBar", () => {
  it("shows the first pending request with its command and opens the session in the dashboard", () => {
    setup();
    const card = screen.getByRole("region", { name: "Needs you" });
    expect(within(card).getByText("rm -rf dist && pnpm build")).toBeTruthy();
    expect(within(card).getByText("billing-web")).toBeTruthy();
    expect(within(card).getByText("Codex")).toBeTruthy();
    fireEvent.click(within(card).getByRole("link", { name: "Open session" }));
    expect(open).toHaveBeenCalledWith("/sessions/s2");
    // observe-only: no way to answer from here
    expect(screen.queryByRole("button", { name: /allow|deny|approve|reject/i })).toBeNull();
  });

  it("lists active sessions with the running count and a failed badge", () => {
    setup();
    expect(screen.getByText("1 running")).toBeTruthy(); // the waiting and idle sessions are open but not running
    const list = screen.getByRole("region", { name: "Sessions" });
    expect(within(list).getAllByRole("link").length).toBe(3); // finished and failed sessions are not listed
    expect(within(list).getByText("auth-service")).toBeTruthy();
    expect(within(list).getByText("✕ 1 failed")).toBeTruthy();
    expect(within(list).getByText("Needs you")).toBeTruthy();
    expect(within(list).queryByText("docs-site")).toBeNull();
  });

  it("footer opens the dashboard and settings and states it is local only", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(open).toHaveBeenLastCalledWith("/");
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(open).toHaveBeenLastCalledWith("/settings");
    expect(screen.getByText("local only · no telemetry")).toBeTruthy();
  });

  it("shows an empty state and no approval card when nothing runs", () => {
    setup((m) => {
      m.data.sessions = [];
      m.data.agents = [];
      m.data.requests = [];
      m.data.events = [];
    });
    expect(screen.getByText("Nothing is running")).toBeTruthy();
    expect(screen.getByText("0 running")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open dashboard" })).toBeTruthy();
  });
});
