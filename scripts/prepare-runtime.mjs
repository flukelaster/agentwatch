#!/usr/bin/env node
// Prepares everything the .app carries so it works with nothing installed on the user's Mac:
//   binaries/node-<triple>      official Node runtime (Homebrew's node is not portable: it links /opt/homebrew dylibs)
//   runtime/agentwatchd.mjs     the daemon, bundled
//   runtime/agentwatch.mjs      the CLI, bundled
//   runtime/node_modules/node-pty   the PTY addon for `agentwatch run` (this architecture only)
// Usage: node scripts/prepare-runtime.mjs [aarch64|x86_64]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauri = join(root, "apps", "desktop", "src-tauri");
const cache = join(root, ".cache");
const arg = process.argv[2] ?? (process.arch === "arm64" ? "aarch64" : "x86_64");
const triple = arg === "aarch64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const nodeArch = arg === "aarch64" ? "arm64" : "x64";
const mb = (p) => (statSync(p).size / 1048576).toFixed(1) + " MB";

mkdirSync(cache, { recursive: true });
mkdirSync(join(tauri, "binaries"), { recursive: true });

async function latestNode24() {
  if (process.env.NODE_VERSION) return process.env.NODE_VERSION.replace(/^v?/, "v");
  const list = await (await fetch("https://nodejs.org/dist/index.json")).json();
  const hit = list.find((e) => e.version.startsWith("v24.") && e.lts);
  if (!hit) throw new Error("no Node 24 LTS found in nodejs.org index");
  return hit.version;
}

async function fetchNode() {
  const out = join(tauri, "binaries", `node-${triple}`);
  const version = await latestNode24();
  const stamp = join(cache, `node-${version}-${nodeArch}.ok`);
  if (existsSync(out) && existsSync(stamp)) return console.log(`node ${version} (${triple}): cached, ${mb(out)}`);
  const name = `node-${version}-darwin-${nodeArch}`;
  const tgz = join(cache, `${name}.tar.gz`);
  if (!existsSync(tgz)) {
    console.log(`downloading ${name}.tar.gz ...`);
    const res = await fetch(`https://nodejs.org/dist/${version}/${name}.tar.gz`);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const want = sums.split("\n").find((l) => l.endsWith(`  ${name}.tar.gz`))?.split(/\s+/)[0];
  const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
  if (!want || want !== got) {
    rmSync(tgz, { force: true });
    throw new Error(`checksum mismatch for ${name}.tar.gz (wanted ${want}, got ${got})`);
  }
  execFileSync("tar", ["-xzf", tgz, "-C", cache, `${name}/bin/node`]);
  copyFileSync(join(cache, name, "bin", "node"), out);
  chmodSync(out, 0o755);
  writeFileSync(stamp, version);
  console.log(`node ${version} (${triple}): checksum ok, ${mb(out)}`);
}

function bundleJs() {
  const rt = join(tauri, "runtime");
  rmSync(rt, { recursive: true, force: true });
  mkdirSync(rt, { recursive: true });
  const esbuild = join(root, "node_modules", ".bin", "esbuild");
  const banner = "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);";
  const common = ["--bundle", "--platform=node", "--format=esm", "--target=node24", "--minify", `--banner:js=${banner}`];
  execFileSync(esbuild, ["services/daemon/src/main.ts", ...common, "--external:node:sqlite", `--outfile=${join(rt, "agentwatchd.mjs")}`], { cwd: root, stdio: "inherit" });
  execFileSync(esbuild, ["cli/agentwatch/src/main.ts", ...common, "--external:node-pty", `--outfile=${join(rt, "agentwatch.mjs")}`], { cwd: root, stdio: "inherit" });
  // node-pty: JS + only this architecture's prebuilt addon
  const req = createRequire(join(root, "cli", "agentwatch", "package.json"));
  const pty = dirname(req.resolve("node-pty/package.json"));
  const dst = join(rt, "node_modules", "node-pty");
  mkdirSync(join(dst, "prebuilds"), { recursive: true });
  copyFileSync(join(pty, "package.json"), join(dst, "package.json"));
  cpSync(join(pty, "lib"), join(dst, "lib"), { recursive: true, filter: (s) => !s.endsWith(".map") && !s.includes("/windows") && !s.endsWith(".test.js") });
  const prebuild = `darwin-${nodeArch}`;
  cpSync(join(pty, "prebuilds", prebuild), join(dst, "prebuilds", prebuild), { recursive: true });
  const helper = join(dst, "prebuilds", prebuild, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
  console.log(`runtime: daemon ${mb(join(rt, "agentwatchd.mjs"))}, cli ${mb(join(rt, "agentwatch.mjs"))}, node-pty ${prebuild}`);
}

await fetchNode();
bundleJs();
