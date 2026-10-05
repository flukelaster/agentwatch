import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateBanner, UpdatesPanel } from "../src/components/Updates";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { Settings } from "../src/pages/Settings";
import { checkForUpdate, installUpdate, resetUpdaterForTests, setAutoCheck, startAutoCheck } from "../src/lib/updater";

vi.mock("../src/lib/native", () => ({ isTauri: () => true, saveTextFile: vi.fn(), openDashboard: vi.fn() }));
const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.0" }));

beforeEach(() => {
  localStorage.clear();
  check.mockReset();
  invoke.mockReset();
  resetUpdaterForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetUpdaterForTests();
});

describe("updates", () => {
  it("says so when there is nothing newer", async () => {
    check.mockResolvedValue(null);
    render(<UpdatesPanel />);
    await screen.findByText("AgentWatch 0.1.0");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("You are on the latest version.");
  });

  it("offers a newer version, installs it with progress, then restarts through the shell", async () => {
    let finish!: () => void;
    const downloadAndInstall = vi.fn(async (cb: (e: unknown) => void) => {
      cb({ event: "Started", data: { contentLength: 100 } });
      cb({ event: "Progress", data: { chunkLength: 40 } });
      await new Promise<void>((r) => (finish = r));
    });
    check.mockResolvedValue({ version: "0.2.0", body: "Fixes the approval glow", downloadAndInstall });
    render(
      <>
        <UpdateBanner />
        <UpdatesPanel />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect((await screen.findAllByText("Version 0.2.0 is available.")).length).toBe(2);
    expect(screen.getByText("Fixes the approval glow")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /Install/ })[0]!);
    await waitFor(() => expect(screen.getAllByText("Downloading 0.2.0… 40%").length).toBeGreaterThan(0));
    finish();
    await waitFor(() => expect(screen.getAllByText(/is installed\. Restart AgentWatch/).length).toBeGreaterThan(0));
    expect(invoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Restart now" })[0]!);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("relaunch"));
  });

  it("shows a failed check as an error and lets the person try again", async () => {
    check.mockRejectedValueOnce(new Error("offline"));
    render(<UpdatesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    check.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("You are on the latest version.");
  });

  it("checks by itself after a short wait, unless the person turned that off", async () => {
    vi.useFakeTimers();
    check.mockResolvedValue(null);
    startAutoCheck();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(check).toHaveBeenCalledTimes(1);

    resetUpdaterForTests();
    check.mockClear();
    setAutoCheck(false);
    startAutoCheck();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).not.toHaveBeenCalled();
  });

  it("does not install anything that was not offered", async () => {
    await installUpdate();
    expect(invoke).not.toHaveBeenCalled();
    await checkForUpdate();
    expect(check).toHaveBeenCalled();
  });

  it("the app menu's Check for Updates… opens Settings with ?check=1: it looks at once and clears the flag", async () => {
    check.mockResolvedValue({ version: "0.2.0", downloadAndInstall: vi.fn() });
    window.location.hash = "#/settings?check=1";
    const store = new LiveStore();
    render(
      <DaemonProvider daemon={{ store, client: new MockDaemonClient(store, { live: false }) }}>
        <Settings />
      </DaemonProvider>,
    );
    await screen.findByText("Version 0.2.0 is available.");
    expect(check).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(window.location.hash).toBe("#/settings"));
  });
});
