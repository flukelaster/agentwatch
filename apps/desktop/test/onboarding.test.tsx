import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { Onboarding } from "../src/pages/Onboarding";

async function setup(tweak?: (m: MockDaemonClient) => void) {
  const store = new LiveStore();
  const mock = new MockDaemonClient(store, { live: false });
  tweak?.(mock);
  mock.start();
  render(
    <DaemonProvider daemon={{ store, client: mock }}>
      <Onboarding />
    </DaemonProvider>,
  );
  await screen.findByText("Claude Code");
  return mock;
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});
afterEach(cleanup);

describe("Onboarding (real setup)", () => {
  it("pre-selects what can be set up here and nothing for tools that are not installed", async () => {
    await setup();
    expect((screen.getByLabelText(/Claude Code/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Codex/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Codex/) as HTMLInputElement).disabled).toBe(false); // can still be chosen
    expect(screen.getByText(/Codex was not found on this Mac/)).toBeTruthy();
    expect((screen.getByLabelText(/Command line/) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Start at login/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Set up (3)" })).toBeTruthy();
    expect(screen.getAllByText(/Your file is backed up first/).length).toBe(7);
    expect((screen.getByLabelText(/Antigravity CLI/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Gemini CLI/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Cursor/) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/Gemini CLI was not found on this Mac/)).toBeTruthy();
  });

  it("changes nothing until the button is pressed, then does everything chosen in one call", async () => {
    const mock = await setup();
    const spy = vi.spyOn(mock, "command");
    expect(spy).not.toHaveBeenCalled();
    expect(mock.setup.claude.hooks.state).toBe("missing");
    fireEvent.click(screen.getByRole("button", { name: "Set up (3)" }));
    await screen.findByText("You are set");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("setupApply", { items: ["claude", "cli", "autostart"] });
    expect([mock.setup.claude.hooks.state, mock.setup.cli.state, mock.setup.autostart.state]).toEqual(["installed", "installed", "installed"]);
    expect(mock.setup.codex.hooks.state).toBe("missing");
    expect(localStorage.getItem("aw.onboarded")).toBe("1");
    expect(screen.getByText(/Backup of your previous file/)).toBeTruthy();
    expect(screen.getByText(/Start a new session in your agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(window.location.hash).toBe("#/");
  });

  it("respects un-ticking, and can add a tool that was not pre-selected", async () => {
    const mock = await setup();
    const spy = vi.spyOn(mock, "command");
    fireEvent.click(screen.getByLabelText(/Start at login/));
    fireEvent.click(screen.getByLabelText(/Codex/));
    expect(screen.getByRole("button", { name: "Set up (3)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up (3)" }));
    await screen.findByText("You are set");
    expect(spy).toHaveBeenCalledWith("setupApply", { items: ["claude", "codex", "cli"] });
    expect(mock.setup.autostart.state).toBe("missing");
  });

  it("skip records that setup was seen, changes nothing and goes to the dashboard", async () => {
    const mock = await setup();
    const spy = vi.spyOn(mock, "command");
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(spy).not.toHaveBeenCalled();
    expect(localStorage.getItem("aw.onboarded")).toBe("1");
    expect(window.location.hash).toBe("#/");
    expect(mock.setup.claude.hooks.state).toBe("missing");
  });

  it("shows items that are already installed as done and does not offer them again", async () => {
    await setup((m) => {
      m.setup.claude.hooks.state = "installed";
      m.setup.cli.state = "installed";
      m.setup.autostart.state = "installed";
    });
    const box = screen.getByLabelText(/Claude Code/) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(screen.getAllByText("Installed").length).toBe(3);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("is honest about items this build cannot do (not running from the app)", async () => {
    await setup((m) => {
      m.setup.cli.state = "unavailable";
      m.setup.autostart.state = "unavailable";
      m.setup.managed = false;
    });
    expect((screen.getByLabelText(/Command line/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText("Not available here").length).toBe(2);
    expect(screen.getByRole("button", { name: "Set up (1)" })).toBeTruthy();
  });

  it("reports a failure instead of pretending, and still finishes the rest", async () => {
    const mock = await setup();
    vi.spyOn(mock, "command").mockRejectedValueOnce(new Error("daemon went away"));
    fireEvent.click(screen.getByRole("button", { name: "Set up (3)" }));
    await screen.findByText("You are set");
    expect((await screen.findByRole("alert")).textContent).toContain("daemon went away");
    expect(localStorage.getItem("aw.onboarded")).toBe("1");
  });

  it("waits for the daemon instead of showing a dead form", async () => {
    const store = new LiveStore(); // status stays "connecting": nothing ever answers
    const never = { start() {}, stop() {}, query: () => new Promise<never>(() => undefined), command: () => new Promise<never>(() => undefined) };
    render(
      <DaemonProvider daemon={{ store, client: never }}>
        <Onboarding />
      </DaemonProvider>,
    );
    expect(screen.getByText("Starting AgentWatch…")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Set up|Continue/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
