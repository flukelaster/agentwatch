import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSwitcher, ago, groupSessions, labelSessions, matches } from "../src/components/SessionSwitcher";
import { agentName, isOpaqueId, isTicking, prettyName, sessionElapsedMs, sessionTitle } from "../src/lib/format";
import { session } from "./fixtures";

afterEach(cleanup);
const NOW = Date.parse("2026-10-05T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const mk = (id: string, status: string, over: Record<string, unknown> = {}) => session({ id, status: status as never, cwd: `/w/${over.repo ?? id}`, startedAt: at(120_000), lastEventAt: at(5_000), ...over });

describe("grouping and labels", () => {
  it("splits sessions by status", () => {
    const g = groupSessions([mk("a", "running"), mk("b", "idle"), mk("c", "idle"), mk("d", "finished"), mk("e", "waiting"), mk("f", "failed")]);
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length]))).toEqual({ running: 1, waiting: 1, idle: 2, failed: 1, finished: 1 });
  });

  it("only adds an id suffix when two sessions share a name, so nothing looks identical", () => {
    const a = mk("sess-aaaa1111", "idle", { repo: "eng-142" });
    const b = mk("sess-bbbb2222", "idle", { repo: "eng-142" });
    const c = mk("sess-cccc3333", "idle", { repo: "agent-watch" });
    const l = labelSessions([a, b, c], NOW);
    expect(l.get(a.id)!.suffix).toBe("#1111");
    expect(l.get(b.id)!.suffix).toBe("#2222");
    expect(l.get(c.id)!.suffix).toBeUndefined();
  });

  it("shows elapsed while live, and time since the end afterwards", () => {
    const live = mk("l", "running", { startedAt: at(75_000) });
    const done = mk("d", "finished", { endedAt: at(7 * 60_000) });
    const l = labelSessions([live, done], NOW);
    expect(l.get("l")!.time).toBe("01:15");
    expect(l.get("d")!.time).toBe("7m ago");
    expect(ago(30_000)).toBe("just now");
    expect(ago(3 * 3600_000)).toBe("3h ago");
  });

  it("freezes the time of an idle session at its last activity, and only running or waiting ones keep counting", () => {
    const idle = mk("i", "idle", { startedAt: at(30 * 60_000), lastEventAt: at(20 * 60_000) });
    const run = mk("r", "running", { startedAt: at(30 * 60_000) });
    const wait = mk("w", "waiting", { startedAt: at(30 * 60_000) });
    expect(sessionElapsedMs(idle, NOW)).toBe(10 * 60_000);
    expect(sessionElapsedMs(idle, NOW + 3_600_000)).toBe(10 * 60_000); // an hour later: unchanged
    expect(sessionElapsedMs(run, NOW)).toBe(30 * 60_000);
    expect(sessionElapsedMs(run, NOW + 60_000)).toBe(31 * 60_000);
    expect(sessionElapsedMs(mk("d", "finished", { startedAt: at(30 * 60_000), endedAt: at(5 * 60_000) }), NOW + 9_999_999)).toBe(25 * 60_000);
    expect(labelSessions([idle], NOW).get("i")!.time).toBe("10:00");
    expect([idle, run, wait, mk("f", "finished", { endedAt: at(1) })].map(isTicking)).toEqual([false, true, true, false]);
  });

  it("turns worktree and branch names into something a person can read", () => {
    expect(prettyName("eng-142-checkout-flow-spec-review-alignm")).toBe("ENG-142 · checkout flow spec review alignm");
    expect(prettyName("agent-watch")).toBe("agent-watch"); // short names are left alone
    expect(prettyName("some_long_project_directory_name")).toBe("some long project directory name");
    expect(sessionTitle({ id: "x", cwd: "/w/shop/eng-142-checkout-flow-spec-review-alignm" })).toMatch(/^ENG-142 · /);
    expect(labelSessions([mk("a", "idle", { repo: "eng-142-checkout-flow-spec-review-alignm" })], NOW).get("a")!.name).toMatch(/^ENG-142 · checkout flow spec/);
  });

  it("names subagents by task label, then type, then order, and never by hash", () => {
    expect(isOpaqueId("ab3bffafebdf350d6")).toBe(true);
    expect(isOpaqueId("5c2e782a-734c-4b46-996b-1e1ffe1114b0")).toBe(true);
    expect(isOpaqueId("explorer")).toBe(false);
    const base = { id: "i", providerAgentId: "ab3bffafebdf350d6" };
    expect(agentName({ ...base, displayName: "Repair account-switch claims", role: "web-dev" })).toBe("Repair account-switch claims");
    expect(agentName({ ...base, role: "web-dev" })).toBe("web-dev");
    expect(agentName({ ...base, displayName: "ab3bffafebdf350d6" }, 2)).toBe("subagent 2");
    expect(agentName({ ...base })).toBe("subagent");
    expect(agentName({ id: "i", providerAgentId: "reviewer" })).toBe("reviewer");
  });

  it("filters by name, branch or path", () => {
    const s = mk("a", "idle", { repo: "billing-web", branch: "feat/x" });
    expect(matches(s, "billing")).toBe(true);
    expect(matches(s, "FEAT")).toBe(true);
    expect(matches(s, "nope")).toBe(false);
    expect(matches(s, "  ")).toBe(true);
  });
});

describe("SessionSwitcher", () => {
  const render_ = (sessions: ReturnType<typeof mk>[], selectedId: string | undefined, onSelect = vi.fn()) => {
    render(<SessionSwitcher sessions={sessions} selectedId={selectedId} onSelect={onSelect} now={NOW} />);
    return onSelect;
  };

  it("shows a count per status, always shows Running and Idle, hides empty optional groups", () => {
    render_([mk("a", "running"), mk("b", "idle"), mk("c", "idle")], "a");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Running1", "Idle2"]);
    expect(screen.getByRole("tab", { name: /Running/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows only the chosen status, in one row, and the tab follows the selected session until a tab is picked", () => {
    const onSelect = render_([mk("a", "running", { repo: "alpha" }), mk("b", "idle", { repo: "beta" }), mk("c", "idle", { repo: "gamma" })], "a");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getAllByRole("button").map((b) => b.textContent)).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: /Idle/ }));
    expect(within(screen.getByRole("tabpanel")).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /gamma/ }));
    expect(onSelect).toHaveBeenCalledWith("c");
  });

  it("stays on Running when it is picked with nothing running, and shows the empty state instead of jumping to Idle", () => {
    render_([mk("b", "idle", { repo: "beta" }), mk("c", "idle", { repo: "gamma" })], "b");
    expect(screen.getByRole("tab", { name: /Idle/ }).getAttribute("aria-selected")).toBe("true"); // follows the selected session
    fireEvent.click(screen.getByRole("tab", { name: /Running/ }));
    expect(screen.getByRole("tab", { name: /Running/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /Idle/ }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText("Nothing is running right now")).toBeTruthy();
    expect(document.querySelector(".radar.radar--run")).toBeTruthy(); // the animated one, in the running colour
    expect(document.querySelector(".radar")?.getAttribute("aria-hidden")).toBe("true"); // decorative
    fireEvent.click(screen.getByRole("tab", { name: /Idle/ })); // and the person can still leave it
    expect(within(screen.getByRole("tabpanel")).getAllByRole("button")).toHaveLength(2);
  });

  it("a tab that was picked and then emptied stays put too (a tab that is not always shown stays while it is the one in view)", () => {
    const view = render(<SessionSwitcher sessions={[mk("a", "waiting", { activity: "waiting for approval" }), mk("b", "idle")]} selectedId="a" onSelect={vi.fn()} now={NOW} />);
    fireEvent.click(screen.getByRole("tab", { name: /Needs you/ }));
    view.rerender(<SessionSwitcher sessions={[mk("a", "running"), mk("b", "idle")]} selectedId="a" onSelect={vi.fn()} now={NOW} />);
    expect(screen.getByRole("tab", { name: /Needs you/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("No session needs you")).toBeTruthy();
  });

  it("disambiguates sessions that share a name", () => {
    render_([mk("sess-aaaa1111", "idle", { repo: "eng-142" }), mk("sess-bbbb2222", "idle", { repo: "eng-142" })], "sess-aaaa1111");
    expect(screen.getByText("#1111")).toBeTruthy();
    expect(screen.getByText("#2222")).toBeTruthy();
  });

  it("offers a filter once a group is large, and says when nothing matches", () => {
    const many = Array.from({ length: 12 }, (_, i) => mk(`s${i}`, "idle", { repo: `repo-${i}` }));
    render_(many, "s0");
    const filter = screen.getByRole("searchbox");
    fireEvent.change(filter, { target: { value: "repo-1" } });
    expect(within(screen.getByRole("tabpanel")).getAllByRole("button").length).toBe(3); // repo-1, repo-10, repo-11
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByText(/No session matches/)).toBeTruthy();
  });

  it("has no filter for a small group", () => {
    render_([mk("a", "idle"), mk("b", "idle")], "a");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("gives a running card its activity and a waiting card the attention state", () => {
    render_([mk("a", "running", { activity: "editing src/x.ts" }), mk("b", "waiting", { activity: "waiting for approval: rm" })], "a");
    expect(screen.getByText("editing src/x.ts")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Needs you/ }));
    expect(document.querySelector(".sw-card--waiting")).toBeTruthy();
  });
});
