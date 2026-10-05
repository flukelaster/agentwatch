import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonProvider } from "../src/lib/context";
import { MockDaemonClient } from "../src/lib/mock";
import { LiveStore } from "../src/lib/store";
import { Settings } from "../src/pages/Settings";
import { itemInfos, type SetupStatusView } from "../src/lib/setup";
import { resetSeq } from "./fixtures";

const save = vi.fn();
vi.mock("../src/lib/native", () => ({ saveTextFile: (...a: unknown[]) => save(...a), openDashboard: vi.fn(), isTauri: () => false }));

async function setup() {
  const store = new LiveStore();
  const mock = new MockDaemonClient(store, { live: false });
  render(
    <DaemonProvider daemon={{ store, client: mock }}>
      <Settings />
    </DaemonProvider>,
  );
  await waitFor(() => expect((screen.getByRole("button", { name: "30 days" }) as HTMLButtonElement).disabled).toBe(false));
  await screen.findByText("Claude Code");
  return mock;
}
const sw = (name: string) => screen.getByRole("switch", { name });

beforeEach(() => {
  resetSeq();
  save.mockClear();
});
afterEach(cleanup);

describe("Settings", () => {
  it("shows what is really installed on this Mac, with the file each item changes", async () => {
    await setup();
    const row = (t: string) => screen.getByText(t, { selector: ".setuprow__title" }).closest(".setuprow") as HTMLElement;
    expect(within(row("Claude Code")).getByText("Not set up")).toBeTruthy();
    expect(within(row("Claude Code")).getByText(/Changes: ~\/\.claude\/settings\.json/)).toBeTruthy();
    expect(within(row("Codex")).getByText(/Codex was not found on this Mac/)).toBeTruthy();
    expect(within(row("Command line")).getByRole("button", { name: "Install Command line" })).toBeTruthy();
    expect(within(row("Start at login")).getByRole("button", { name: "Install Start at login" })).toBeTruthy();
    // no "run this in a terminal" homework any more
    expect(screen.queryByText(/Run this in a terminal/)).toBeNull();
  });

  it("installs for real, reports the backup, then offers Remove, which really removes", async () => {
    const mock = await setup();
    const spy = vi.spyOn(mock, "command");
    fireEvent.click(screen.getByRole("button", { name: "Install Claude Code" }));
    await waitFor(() => expect(mock.setup.claude.hooks.state).toBe("installed"));
    expect(spy).toHaveBeenCalledWith("setupApply", { items: ["claude"] });
    expect(await screen.findByText(/Backup of your previous file/)).toBeTruthy();
    const remove = await screen.findByRole("button", { name: "Remove Claude Code" });
    fireEvent.click(remove);
    await waitFor(() => expect(mock.setup.claude.hooks.state).toBe("missing"));
    expect(spy).toHaveBeenCalledWith("setupRevert", { items: ["claude"] });
    expect(await screen.findByRole("button", { name: "Install Claude Code" })).toBeTruthy();
  });

  it("tells the user Codex needs a one-time review once its hooks are installed", async () => {
    const mock = await setup();
    const status = structuredClone(mock.setup) as SetupStatusView;
    status.codex = { ...status.codex, detected: true, hooks: { ...status.codex.hooks, state: "installed" } };
    const codex = itemInfos(status).find((i) => i.item === "codex")!;
    expect(codex.note).toMatch(/run \/hooks once to trust/);
    status.codex.hooks.state = "missing";
    expect(itemInfos(status).find((i) => i.item === "codex")!.note).toBeUndefined();
  });

  it("says plainly when an install fails and leaves the state alone", async () => {
    const mock = await setup();
    vi.spyOn(mock, "command").mockRejectedValueOnce(new Error("settings file is not valid JSON"));
    fireEvent.click(screen.getByRole("button", { name: "Install Claude Code" }));
    expect((await screen.findByRole("alert")).textContent).toContain("settings file is not valid JSON");
    expect(mock.setup.claude.hooks.state).toBe("missing");
    expect((screen.getByRole("button", { name: "Install Claude Code" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves the retention choice", async () => {
    const mock = await setup();
    const group = screen.getByRole("group", { name: "Keep event history for" });
    expect(within(group).getByRole("button", { name: "14 days" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Session only" }));
    await waitFor(() => expect(mock.data.settings.retentionDays).toBe(0));
    expect(within(group).getByRole("button", { name: "Session only" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "14 days" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("lets you turn on prompt and response text, saves the choice, and keeps the other privacy rows locked off", async () => {
    const mock = await setup();
    const spy = vi.spyOn(mock, "command");
    for (const [name, key] of [["Store prompt text", "storePromptText"], ["Store assistant responses", "storeAssistantText"]] as const) {
      const s = sw(name) as HTMLButtonElement;
      expect(s.disabled).toBe(false);
      expect(s.getAttribute("aria-checked")).toBe("false"); // off by default
      fireEvent.click(s);
      await waitFor(() => expect(spy).toHaveBeenCalledWith("setSettings", { patch: { [key]: true } }));
      await waitFor(() => expect(sw(name).getAttribute("aria-checked")).toBe("true"));
    }
    expect(mock.data.settings).toMatchObject({ storePromptText: true, storeAssistantText: true });
    for (const name of ["Keep raw terminal transcript", "Keep full Git patches"]) {
      const s = sw(name) as HTMLButtonElement;
      expect(s.disabled).toBe(true);
      expect(s.getAttribute("aria-checked")).toBe("false");
      fireEvent.click(s);
    }
    expect(screen.getAllByText(/Not implemented, always off/).length).toBe(2);
    const redact = sw("Redact credentials in commands and errors") as HTMLButtonElement;
    expect(redact.disabled).toBe(true);
    expect(redact.getAttribute("aria-checked")).toBe("true");
  });

  it("deletes all history only after a second confirming click, and can be cancelled", async () => {
    const mock = await setup();
    const spy = vi.spyOn(mock, "command");
    fireEvent.click(screen.getByRole("button", { name: "Delete history…" }));
    expect(screen.getByText(/It cannot be undone/)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    expect(mock.data.sessions.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete history…" })).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete history…" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete everything" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("deleteAllHistory"));
    await screen.findByText(/Done\. All sessions/);
    expect(mock.data.sessions.length).toBe(0);
    expect((screen.getByRole("button", { name: "Deleted" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lets you pin the context window size, and starts on Auto", async () => {
    const mock = await setup();
    const spy = vi.spyOn(mock, "command");
    const group = screen.getByRole("group", { name: "Context window size" });
    expect(within(group).getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "1M" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("setSettings", { patch: { contextWindow: 1_000_000 } }));
    await waitFor(() => expect(within(group).getByRole("button", { name: "1M" }).getAttribute("aria-pressed")).toBe("true"));
    expect(within(group).getByRole("button", { name: "Auto" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("exports diagnostics to a file on this Mac", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Export bundle" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(JSON.parse((save.mock.calls[0] as [string, string])[1]).diagnostics.length).toBeGreaterThan(0);
  });
});
