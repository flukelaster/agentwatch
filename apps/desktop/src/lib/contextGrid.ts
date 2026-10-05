import type { ContextView } from "@agentwatch/protocol";

export const GRID_CELLS = 200;
export const GRID_COLUMNS = 20;

export type PartKind = "used" | "free" | "buffer";

export interface ContextPart {
  key: string;
  name: string;
  tokens: number;
  kind: PartKind;
  /** CSS colour of its cells. */
  color: string;
}

// Same idea as Claude Code's own /context: a stable colour for each kind of use.
const PALETTE: Array<[RegExp, string]> = [
  [/^system prompt$/i, "oklch(0.74 0.03 270)"],
  [/^system tools$/i, "oklch(0.62 0.04 270)"],
  [/^mcp tools/i, "oklch(0.78 0.09 195)"],
  [/^mcp server instructions/i, "oklch(0.78 0.11 150)"],
  [/^custom agents/i, "oklch(0.72 0.12 250)"],
  [/^memory files/i, "oklch(0.76 0.14 55)"],
  [/^skills/i, "oklch(0.86 0.12 100)"],
  [/^messages$/i, "oklch(0.68 0.12 285)"],
  [/^setup/i, "oklch(0.7 0.03 270)"],
  [/^conversation/i, "oklch(0.68 0.12 285)"],
  [/^tool calls/i, "oklch(0.78 0.09 195)"],
];
const SPARE = ["oklch(0.75 0.1 20)", "oklch(0.75 0.1 330)", "oklch(0.75 0.1 120)", "oklch(0.75 0.1 220)"];

export const colorFor = (name: string, index = 0): string => PALETTE.find(([re]) => re.test(name))?.[1] ?? SPARE[index % SPARE.length]!;

/**
 * What the grid and its list show, in order: each kind of use, then what is free, then the space Claude Code
 * keeps for auto-compaction. Claude Code's own categories when `/context` has been run, otherwise three estimates.
 */
export function contextParts(c: ContextView): ContextPart[] {
  const used: ContextPart[] =
    c.reported && c.categories?.length
      ? c.categories.map((x, i) => ({ key: `c${i}`, name: x.name, tokens: x.tokens, kind: "used" as const, color: colorFor(x.name, i) }))
      : [
          { key: "setup", name: "Setup (system prompt, tools, memory)", tokens: c.setup, kind: "used" as const, color: colorFor("setup") },
          { key: "chat", name: "Conversation", tokens: c.conversation, kind: "used" as const, color: colorFor("conversation") },
          { key: "tools", name: "Tool calls and results", tokens: c.tools, kind: "used" as const, color: colorFor("tool calls") },
        ];
  const buffer = c.buffer ?? 0;
  const free = Math.max(0, c.window - c.used - buffer);
  const parts = used.filter((p) => p.tokens > 0);
  parts.push({ key: "free", name: "Free space", tokens: free, kind: "free", color: "transparent" });
  if (buffer > 0) parts.push({ key: "buffer", name: "Autocompact buffer", tokens: buffer, kind: "buffer", color: "transparent" });
  return parts;
}

/** One entry per cell: which part it belongs to. Every part that has tokens gets at least one cell. */
export function allocateCells(parts: readonly ContextPart[], window: number, cells = GRID_CELLS): string[] {
  const total = Math.max(1, window);
  const raw = parts.map((p) => (p.tokens / total) * cells);
  const counts = raw.map((r, i) => (parts[i]!.tokens > 0 ? Math.max(1, Math.floor(r)) : 0));
  let diff = cells - counts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem);
  for (let k = 0; diff > 0 && order.length; k++, diff--) counts[order[k % order.length]!.i]! += 1; // largest remainder first
  const byBiggest = counts.map((n, i) => ({ n, i })).sort((a, b) => b.n - a.n);
  for (let k = 0; diff < 0; k++) {
    const target = byBiggest[k % byBiggest.length]!;
    if (counts[target.i]! > 1) {
      counts[target.i]! -= 1;
      diff++;
    }
    if (k > cells * 4) break;
  }
  return parts.flatMap((p, i) => Array.from({ length: counts[i]! }, () => p.key));
}
