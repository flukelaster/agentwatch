// node-pty ships its spawn-helper without the executable bit when installed through pnpm.
// Without +x every pty.spawn() fails with "posix_spawnp failed". Idempotent and harmless.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [join(process.cwd(), "node_modules", ".pnpm")];
let fixed = 0;
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith("node-pty@")) continue;
    const prebuilds = join(root, dir, "node_modules", "node-pty", "prebuilds");
    if (!existsSync(prebuilds)) continue;
    for (const arch of readdirSync(prebuilds)) {
      const helper = join(prebuilds, arch, "spawn-helper");
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        fixed += 1;
      }
    }
  }
}
if (fixed) console.log(`fix-pty: made ${fixed} spawn-helper executable`);
