import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { SessionDetail } from "../src/pages/SessionDetail";
import { event } from "./fixtures";

function setup(id: string, tweak?: (mock: MockDaemonClient) => void) {
  const store = new LiveStore();
  const mock = new MockDaemonClient(store, { live: false });
  tweak?.(mock);
  render(
    <DaemonProvider daemon={{ store, client: mock }}>
      <SessionDetail id={id} />
    </DaemonProvider>,
  );
  return { store, mock };
}

const region = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(cleanup);

describe("SessionDetail", () => {
  it("renders the header with breadcrumb, provider chip, meta line and status", () => {
    setup("s2");
    const head = region("Session header");
    const crumb = within(head).getByRole("link", { name: "Sessions" });
    expect(crumb.getAttribute("href")).toBe("#/sessions");
    expect(within(head).getByRole("heading", { level: 1 }).textContent).toBe("billing-web");
    expect(within(head).getByText("Codex")).toBeTruthy();
    expect(within(head).getByText(/gpt-5-codex\s+·\s+\/Users\/demo\/work\/billing-web\s+·\s+feat\/invoice-totals/)).toBeTruthy();
    expect(within(head).getByText("! Waiting for approval")).toBeTruthy();
    expect(within(head).getByText((_, el) => el?.className === "diff" && el.textContent === "+64 −9")).toBeTruthy();
  });

  it("shows the pending approval with its command, asker and observe-only wording, with no answer buttons", () => {
    setup("s2");
    const card = region("Approval request");
    expect(within(card).getByText("rm -rf dist && pnpm build")).toBeTruthy();
    expect(within(card).getByText(/Approval requested · command execution/)).toBeTruthy();
    expect(within(card).getByText(/Asked by main at \d\d:\d\d:\d\d · waiting \d\d:\d\d · answer it in the Codex terminal/)).toBeTruthy();
    expect(within(card).getByText("codex-app-server")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /allow|deny|approve|reject/i })).toBeNull();
  });

  it("has no approval card for a session without a pending request", () => {
    setup("s1");
    expect(screen.queryByRole("region", { name: "Approval request" })).toBeNull();
  });

  it("lists file activity and never credits low-confidence changes to an agent", async () => {
    setup("s2", (mock) => {
      // a provider-less observed change that (wrongly) carries a name must still not be credited
      mock.data.files.push({ path: "src/observed.ts", sessionId: "s2", repo: "billing-web", provider: "codex", operation: "write", additions: 0, deletions: 0, source: "filesystem", confidence: "low", lastAt: new Date().toISOString(), touches: 1, agentName: "reviewer" });
    });
    const files = region("File activity");
    await within(files).findByText("src/invoice/totals.ts");
    const row = (path: string) => within(files).getByText(path).closest(".tr") as HTMLElement;

    expect(within(row("src/invoice/totals.ts")).getByText("main")).toBeTruthy();
    expect(within(row("src/invoice/totals.ts")).getByText("+38 −5")).toBeTruthy();
    expect(within(row("src/invoice/format.ts")).getByText("reviewer")).toBeTruthy();
    expect(within(row("src/invoice/format.ts")).getByText("Read")).toBeTruthy();

    const dirty = row("pnpm-lock.yaml");
    expect(within(dirty).getByText("not credited to any agent")).toBeTruthy();
    expect(within(dirty).getByText("at start")).toBeTruthy();
    expect(within(dirty).getByText("git baseline")).toBeTruthy();

    const observed = row("src/observed.ts");
    expect(within(observed).getByText("not credited to any agent")).toBeTruthy();
    expect(within(observed).queryByText("reviewer")).toBeNull();
    expect(within(observed).getByText("Low")).toBeTruthy();
  });

  it("lists command activity with exit state, evidence and attribution rules", async () => {
    setup("s2", (mock) => {
      mock.data.commands.push({ id: "low1", sessionId: "s2", repo: "billing-web", provider: "codex", argvDisplay: "watcher child", startedAt: new Date().toISOString(), source: "pty", confidence: "low", redacted: false, agentName: "main" });
    });
    const cmds = region("Command activity");
    await within(cmds).findByText("pnpm test invoice");
    const row = (cmd: string) => within(cmds).getByText(cmd).closest(".tr") as HTMLElement;
    expect(within(row("pnpm test invoice")).getByText("0")).toBeTruthy();
    expect(within(row("rm -rf dist && pnpm build")).getByText("awaiting you")).toBeTruthy();
    expect(within(row("watcher child")).getByText("not credited to any agent")).toBeTruthy();
    expect(within(row("watcher child")).queryByText("main")).toBeNull();
    expect(within(cmds).getByText(/Command lines are redacted before they are stored/)).toBeTruthy();
  });

  it("shows provider-reported token usage with its breakdown", () => {
    setup("s2");
    const usage = region("Token usage");
    expect(within(usage).getByText("61.4k")).toBeTruthy();
    expect(within(usage).getByText("48.2k")).toBeTruthy();
    expect(within(usage).getByText("31.0k")).toBeTruthy();
    expect(within(usage).getByText("13.2k")).toBeTruthy();
    expect(within(usage).getByText("4.1k")).toBeTruthy();
    expect(within(usage).getByText("thread · provider-reported")).toBeTruthy();
  });

  it("says tokens are not reported when the provider gave none, and never shows numbers", () => {
    setup("s1");
    const usage = region("Token usage");
    expect(within(usage).getByText("Not reported by this provider")).toBeTruthy();
    expect(within(usage).queryByText("input + output")).toBeNull();
  });

  it("does not trust a usage object that the provider did not report", () => {
    setup("s1", (mock) => {
      mock.data.sessions[0]!.usage = { inputTokens: 9000, outputTokens: 1000, scope: "session", providerReported: false };
    });
    const usage = region("Token usage");
    expect(within(usage).getByText("Not reported by this provider")).toBeTruthy();
    expect(within(usage).queryByText("10.0k")).toBeNull();
  });

  it("says usage is unavailable for a generic CLI", () => {
    setup("s3");
    expect(within(region("Token usage")).getByText("Unavailable for a generic CLI")).toBeTruthy();
  });

  it("derives git rows only from real data: no dirty-at-start row without a baseline event", () => {
    setup("s2");
    const git = region("Git");
    expect(within(git).getByText("metadata only")).toBeTruthy();
    expect(within(git).queryByText("dirty at start")).toBeNull();
    expect(within(git).getByText("+64 −9")).toBeTruthy();
    expect(within(git).getByText("not stored")).toBeTruthy();
    expect(within(git).getByText("none")).toBeTruthy();
  });

  it("uses the latest baseline git.changed event for dirty-at-start", () => {
    const { store } = setup("s2");
    act(() => {
      store.apply({ type: "event", event: event({ id: "g1", sequence: 9001, sessionId: "s2", agentId: "s2:main", kind: "git.changed", source: "git", confidence: "low", payload: { baseline: true, dirtyAtStart: 1 } }) });
      store.apply({ type: "event", event: event({ id: "g2", sequence: 9002, sessionId: "s2", agentId: "s2:main", kind: "git.changed", source: "git", confidence: "low", payload: { changedFiles: 2, additions: 64, deletions: 9 } }) });
    });
    const git = region("Git");
    const dt = within(git).getByText("dirty at start");
    expect(dt.nextElementSibling?.textContent).toBe("1 file");
    expect(within(git).getByText("2 files · +64 −9")).toBeTruthy();
  });

  it("shows a clear not-found state with a link back when the session does not exist", async () => {
    setup("does-not-exist");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Session not found" })).toBeTruthy());
    expect(screen.getByText(/It may have been deleted/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Sessions" }).getAttribute("href")).toBe("#/sessions");
  });

  it("turns into the not-found state when the session is deleted while open", async () => {
    const { store } = setup("s4");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("api-gateway");
    act(() => void store.apply({ type: "removed", sessionId: "s4" }));
    expect(screen.getByRole("heading", { name: "Session not found" })).toBeTruthy();
  });
});
