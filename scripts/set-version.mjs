#!/usr/bin/env node
// Sets the release version everywhere it is written, so a release is one command and one commit.
// Usage: node scripts/set-version.mjs 0.2.0      (then: git commit -am "Release v0.2.0" && git tag v0.2.0 && git push --follow-tags)
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(2);
}

const edit = (rel, fn) => {
  const p = join(root, rel);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (after === before) return console.log(`unchanged  ${rel}`);
  writeFileSync(p, after);
  console.log(`updated    ${rel}`);
};
const replaceOnce = (re, to, what) => (text) => {
  if (!re.test(text)) throw new Error(`${what}: pattern not found`);
  return text.replace(re, to);
};

// every workspace package.json (root, apps, cli, packages, services)
const manifests = ["package.json"];
const walk = (dir) => {
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name === "target" || name === "dist" || name.startsWith(".")) continue;
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) walk(rel);
    else if (name === "package.json") manifests.push(rel);
  }
};
for (const d of ["apps", "cli", "packages", "services"]) walk(d);
for (const rel of manifests) edit(rel, replaceOnce(/("version":\s*")[^"]+(")/, `$1${version}$2`, rel));

edit("apps/desktop/src-tauri/tauri.conf.json", replaceOnce(/("version":\s*")[^"]+(")/, `$1${version}$2`, "tauri.conf.json"));
edit("apps/desktop/src-tauri/Cargo.toml", replaceOnce(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`, "Cargo.toml"));
edit("apps/desktop/src-tauri/Cargo.lock", replaceOnce(/(name = "agentwatch-desktop"\nversion = ")[^"]+(")/, `$1${version}$2`, "Cargo.lock"));
edit("services/daemon/src/config.ts", replaceOnce(/(DAEMON_VERSION = ")[^"]+(")/, `$1${version}$2`, "config.ts"));
