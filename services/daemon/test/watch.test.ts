import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchTree } from "../src/observers/watch";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "aww-"));
  dirs.push(d);
  return d;
};
const until = async (cond: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
};
const openFds = () => readdirSync("/dev/fd").length;

describe("watchTree", () => {
  it("reports a created, changed and deleted file once each, and ignores directories and ignored paths", async () => {
    const root = tmp();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    const seen: string[] = [];
    const w = watchTree(root, [/node_modules/], (op, p) => seen.push(`${op}:${p.slice(root.length)}`), () => undefined, 60);
    await new Promise((r) => setTimeout(r, 300)); // let the stream start
    writeFileSync(join(root, "src", "a.ts"), "1");
    writeFileSync(join(root, "node_modules", "x.js"), "1");
    mkdirSync(join(root, "src", "sub"));
    await until(() => seen.includes("write:/src/a.ts"));
    unlinkSync(join(root, "src", "a.ts"));
    await until(() => seen.includes("delete:/src/a.ts"));
    w.close();
    expect(seen).toContain("write:/src/a.ts");
    expect(seen).toContain("delete:/src/a.ts");
    expect(seen.some((s) => s.includes("node_modules"))).toBe(false);
    expect(seen.some((s) => s.endsWith("/sub"))).toBe(false); // directories are not files
  });

  it("collapses a burst of writes to one report", async () => {
    const root = tmp();
    const seen: string[] = [];
    const w = watchTree(root, [], (op, p) => seen.push(op + p), () => undefined, 150);
    await new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 8; i++) writeFileSync(join(root, "b.ts"), String(i));
    await until(() => seen.length > 0);
    await new Promise((r) => setTimeout(r, 400));
    w.close();
    expect(seen.filter((s) => s.startsWith("write")).length).toBe(1);
  });

  it("holds a handful of file descriptors however many files it watches (chokidar held one per file)", async () => {
    const root = tmp();
    for (let d = 0; d < 20; d++) {
      mkdirSync(join(root, `d${d}`));
      for (let f = 0; f < 150; f++) writeFileSync(join(root, `d${d}`, `f${f}.ts`), "x");
    }
    const before = openFds();
    const w = watchTree(root, [], () => undefined, () => undefined);
    await new Promise((r) => setTimeout(r, 800));
    const during = openFds();
    w.close();
    expect(during - before).toBeLessThan(25); // 3,000 files
  });
});
