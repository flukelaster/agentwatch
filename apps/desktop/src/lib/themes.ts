/**
 * Themes.
 *
 * Every grey in the interface is a token `--g-XX`, where XX is the level it has in the original black design
 * (`--g-05` is the page, `--g-0b` a panel, `--g-ed` the text). A theme says where black and white go:
 * a level is placed on the line between the theme's `floor` and `ceiling`. A higher floor and a lower ceiling mean
 * less contrast, and a tinted floor tints the whole interface. Status colours are the same in every theme.
 */

export type Rgb = readonly [number, number, number];

export interface Theme {
  id: string;
  name: string;
  tagline: string;
  /** What level 0 (black) becomes. */
  floor: Rgb;
  /** What level 255 (white) becomes. */
  ceiling: Rgb;
}

export const DEFAULT_THEME = "dusk";

export const THEMES: readonly Theme[] = [
  { id: "dusk", name: "Dusk", tagline: "Soft charcoal. Easy on the eyes, the default.", floor: [20, 21, 25], ceiling: [236, 234, 229] },
  { id: "graphite", name: "Graphite", tagline: "Lighter and flatter, the gentlest contrast.", floor: [31, 32, 35], ceiling: [244, 244, 242] },
  { id: "midnight-ink", name: "Midnight Ink", tagline: "Deep blue-black, like a late-night terminal.", floor: [10, 16, 32], ceiling: [230, 237, 250] },
  { id: "ember", name: "Ember", tagline: "Warm brown-black, a dimmed fireplace.", floor: [26, 19, 15], ceiling: [244, 232, 218] },
  { id: "nebula", name: "Nebula", tagline: "Violet-tinted night sky.", floor: [20, 16, 31], ceiling: [238, 232, 248] },
  { id: "obsidian", name: "Obsidian", tagline: "True black, the original. Highest contrast.", floor: [0, 0, 0], ceiling: [255, 255, 255] },
];

/** Every grey level the interface uses (hex, as in the original design). */
export const GRAY_LEVELS = ["00", "05", "08", "09", "0b", "0d", "0e", "10", "11", "13", "14", "16", "17", "18", "1a", "20", "2a", "30", "3a", "44", "4a", "5a", "5f", "6b", "85", "99", "a3", "bd", "c8", "ed", "f2", "ff"] as const;

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");

/** The colour a level takes in a theme, as #rrggbb. */
export function shade(theme: Theme, level: number): string {
  const t = level / 255;
  const c = (i: 0 | 1 | 2) => theme.floor[i] + (theme.ceiling[i] - theme.floor[i]) * t;
  return `#${hex2(c(0))}${hex2(c(1))}${hex2(c(2))}`;
}

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

/** `--g-XX: #rrggbb` for every level. */
export function themeVars(theme: Theme): Record<string, string> {
  return Object.fromEntries(GRAY_LEVELS.map((g) => [`--g-${g}`, shade(theme, parseInt(g, 16))]));
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const ch = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

export const THEME_KEY = "aw.theme";

export function loadTheme(): string {
  try {
    return themeById(localStorage.getItem(THEME_KEY)).id;
  } catch {
    return DEFAULT_THEME; // storage can be unavailable
  }
}

/**
 * Applies a theme by setting the grey tokens on the page. The default theme is written in tokens.css, so it needs
 * no overrides; any other theme sets all of them.
 */
export function applyTheme(id: string, root: HTMLElement = document.documentElement): string {
  const theme = themeById(id);
  const vars = themeVars(theme);
  for (const [k, v] of Object.entries(vars)) {
    if (theme.id === DEFAULT_THEME) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
  root.dataset.theme = theme.id;
  return theme.id;
}

export function saveTheme(id: string): void {
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {
    /* the choice still applies until the window closes */
  }
}

/** Keeps every open window in step when one of them changes the theme. */
export function followThemeChanges(): () => void {
  const on = (e: StorageEvent) => {
    if (e.key === THEME_KEY) applyTheme(e.newValue ?? DEFAULT_THEME);
  };
  window.addEventListener("storage", on);
  return () => window.removeEventListener("storage", on);
}
