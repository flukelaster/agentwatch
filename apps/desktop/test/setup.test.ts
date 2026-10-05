import { describe, expect, it } from "vitest";
import { itemInfos, tildePath, type SetupStatusView } from "../src/lib/setup";
import { mockSetupStatus } from "../src/lib/mock";

describe("tildePath", () => {
  it("shortens a home directory and leaves everything else alone", () => {
    expect(tildePath("/Users/ada/.claude/settings.json")).toBe("~/.claude/settings.json");
    expect(tildePath("/home/ada/.codex/hooks.json")).toBe("~/.codex/hooks.json");
    expect(tildePath("/Users/ada")).toBe("~");
    expect(tildePath("/var/folders/xx/T/aw/.claude/settings.json")).toBe("/var/folders/xx/T/aw/.claude/settings.json");
  });
});

describe("itemInfos", () => {
  it("describes each item with the file it changes and whether it can be applied here", () => {
    const s: SetupStatusView = mockSetupStatus();
    const infos = itemInfos(s);
    expect(infos.map((i) => i.item)).toEqual(["claude", "codex", "gemini", "antigravity", "cursor", "cli", "autostart"]);
    expect(infos[0]).toMatchObject({ target: "~/.claude/settings.json", available: true, detected: true });
    expect(infos[1]).toMatchObject({ detected: false, note: expect.stringContaining("not found") });
    expect(infos[2]).toMatchObject({ title: "Gemini CLI", target: "~/.gemini/settings.json", available: true, detected: false });
    expect(infos[3]).toMatchObject({ title: "Antigravity CLI", target: "~/.gemini/config/hooks.json", available: true, detected: false });
    expect(infos[4]).toMatchObject({ title: "Cursor", target: "~/.cursor/hooks.json", available: true, detected: false });
  });

  it("tells a person who has Gemini CLI or Cursor that their own hooks are kept", () => {
    const s = mockSetupStatus();
    s.gemini.detected = true;
    s.cursor.detected = true;
    s.antigravity.detected = true;
    const infos = itemInfos(s);
    expect(infos[2]!.note).toMatch(/existing Gemini hooks are kept/);
    expect(infos[3]!.note).toMatch(/existing Antigravity hooks are kept/);
    expect(infos[4]!.note).toMatch(/existing Cursor hooks are kept/);
  });

  it("blocks an item whose settings file cannot be read, and one blocked by a foreign file", () => {
    const s = mockSetupStatus();
    s.claude.hooks.state = "unreadable";
    s.cli.state = "conflict";
    const [claude, , , , , cli] = itemInfos(s);
    expect(claude!.available).toBe(false);
    expect(cli!.available).toBe(false);
    expect(cli!.note).toMatch(/left alone/);
  });

  it("reminds about PATH only once the command is installed and its folder is not on PATH", () => {
    const s = mockSetupStatus();
    expect(itemInfos(s)[5]!.note).toBeUndefined();
    s.cli.state = "installed";
    expect(itemInfos(s)[5]!.note).toMatch(/PATH/);
    s.cli.dirOnPath = true;
    expect(itemInfos(s)[5]!.note).toBeUndefined();
  });
});
