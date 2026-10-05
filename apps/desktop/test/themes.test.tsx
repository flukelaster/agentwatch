import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemePicker } from "../src/components/ThemePicker";
import { DEFAULT_THEME, GRAY_LEVELS, THEMES, THEME_KEY, applyTheme, contrast, followThemeChanges, loadTheme, shade, themeById, themeVars } from "../src/lib/themes";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.theme;
});
afterEach(cleanup);

describe("theme colours", () => {
  it("has the cool names, a soft default and the original black", () => {
    expect(THEMES.map((t) => t.name)).toEqual(["Dusk", "Graphite", "Midnight Ink", "Ember", "Nebula", "Obsidian"]);
    expect(DEFAULT_THEME).toBe("dusk");
    expect(THEMES[0]!.id).toBe(DEFAULT_THEME);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });

  it("keeps the default's values in tokens.css identical to what the code computes, so the page never flashes", () => {
    const css = readFileSync(here("../src/styles/tokens.css"), "utf8");
    const dusk = themeVars(themeById("dusk"));
    for (const [name, value] of Object.entries(dusk)) expect(css, name).toContain(`${name}: ${value};`);
    expect([...css.matchAll(/--g-[0-9a-f]{2}:/g)]).toHaveLength(GRAY_LEVELS.length);
  });

  it("Obsidian is exactly the original black design: every level maps to itself", () => {
    const o = themeById("obsidian");
    for (const g of GRAY_LEVELS) expect(shade(o, parseInt(g, 16))).toBe(`#${g}${g}${g}`);
  });

  it("Dusk is softer than the original: a lifted background and a lower peak contrast, still easy to read", () => {
    const dusk = themeById("dusk");
    const orig = themeById("obsidian");
    expect(shade(dusk, 0x05)).not.toBe("#050505");
    expect(contrast(shade(dusk, 0xed), shade(dusk, 0x05))).toBeLessThan(contrast(shade(orig, 0xed), shade(orig, 0x05)));
    expect(contrast(shade(dusk, 0xed), shade(dusk, 0x05))).toBeGreaterThan(9);
  });

  it("stays readable in every theme: text, muted text, faint text and borders", () => {
    for (const t of THEMES) {
      const bg = shade(t, 0x05);
      const panel = shade(t, 0x0b);
      expect(contrast(shade(t, 0xed), bg), `${t.name} text`).toBeGreaterThanOrEqual(7);
      expect(contrast(shade(t, 0xa3), bg), `${t.name} muted`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(shade(t, 0x85), panel), `${t.name} faint`).toBeGreaterThanOrEqual(4.2);
      expect(contrast(shade(t, 0x30), bg), `${t.name} strong border`).toBeGreaterThanOrEqual(1.3);
    }
  });

  it("no style sheet or component fixes a grey of its own any more: every grey goes through a theme token", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${f.name}`;
        if (f.isDirectory()) walk(p);
        else if (/\.(css|tsx)$/.test(f.name) && !f.name.endsWith("tokens.css")) {
          for (const m of readFileSync(p, "utf8").matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
            const h = m[1]!.length === 3 ? m[1]!.replace(/./g, "$&$&") : m[1]!;
            if (h.slice(0, 2) === h.slice(2, 4) && h.slice(2, 4) === h.slice(4, 6)) offenders.push(`${f.name}: #${m[1]}`);
          }
        }
      }
    };
    walk(here("../src"));
    expect(offenders).toEqual([]);
  });
});

describe("applying a theme", () => {
  it("sets every grey for a theme, removes them for the default, and marks the page", () => {
    const root = document.documentElement;
    applyTheme("midnight-ink");
    expect(root.dataset.theme).toBe("midnight-ink");
    expect(root.style.getPropertyValue("--g-05")).toBe(shade(themeById("midnight-ink"), 5));
    expect(GRAY_LEVELS.every((g) => root.style.getPropertyValue(`--g-${g}`) !== "")).toBe(true);
    applyTheme(DEFAULT_THEME);
    expect(root.dataset.theme).toBe("dusk");
    expect(root.style.getPropertyValue("--g-05")).toBe(""); // the stylesheet's own value applies again
  });

  it("falls back to the default for a name it does not know, and when storage is unavailable", () => {
    expect(applyTheme("does-not-exist")).toBe("dusk");
    localStorage.setItem(THEME_KEY, "nebula");
    expect(loadTheme()).toBe("nebula");
    localStorage.setItem(THEME_KEY, "junk");
    expect(loadTheme()).toBe("dusk");
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadTheme()).toBe("dusk");
    spy.mockRestore();
  });

  it("every open window follows when one changes the theme", () => {
    const stop = followThemeChanges();
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "ember" })));
    expect(document.documentElement.dataset.theme).toBe("ember");
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: "something-else", newValue: "nebula" })));
    expect(document.documentElement.dataset.theme).toBe("ember");
    stop();
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "nebula" })));
    expect(document.documentElement.dataset.theme).toBe("ember");
  });
});

describe("the theme picker", () => {
  it("shows every theme with its name and what it is like, with the current one chosen", () => {
    render(<ThemePicker />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.querySelector(".themecard__name")!.textContent)).toEqual(["Duskdefault", "Graphite", "Midnight Ink", "Ember", "Nebula", "Obsidian"]);
    expect(screen.getByRole("radio", { name: /Dusk/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Soft charcoal. Easy on the eyes, the default.")).toBeTruthy();
  });

  it("applies a choice at once, remembers it, and starts from it next time", () => {
    const { unmount } = render(<ThemePicker />);
    fireEvent.click(screen.getByRole("radio", { name: /Midnight Ink/ }));
    expect(document.documentElement.dataset.theme).toBe("midnight-ink");
    expect(localStorage.getItem(THEME_KEY)).toBe("midnight-ink");
    expect(screen.getByRole("radio", { name: /Midnight Ink/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Dusk/ }).getAttribute("aria-checked")).toBe("false");
    unmount();
    render(<ThemePicker />);
    expect(screen.getByRole("radio", { name: /Midnight Ink/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("follows a change made in another window", () => {
    render(<ThemePicker />);
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "obsidian" })));
    expect(screen.getByRole("radio", { name: /Obsidian/ }).getAttribute("aria-checked")).toBe("true");
  });
});
