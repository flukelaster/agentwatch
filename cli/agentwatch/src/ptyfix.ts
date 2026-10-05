import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** pnpm installs node-pty's spawn-helper without +x. Repair it on first use. */
export function ensureSpawnHelperExecutable(): void {
  try {
    const req = createRequire(import.meta.url);
    const dir = dirname(req.resolve("node-pty/package.json"));
    for (const arch of [`${process.platform}-${process.arch}`]) {
      const helper = join(dir, "prebuilds", arch, "spawn-helper");
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch {
    /* node-pty not resolvable here; the dynamic import below reports it */
  }
}
