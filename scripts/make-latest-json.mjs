#!/usr/bin/env node
// Writes the manifest the in-app updater reads (latest.json) from the signed update bundles in a directory.
// Usage: node scripts/make-latest-json.mjs <dist-dir> <version> <owner/repo> [notes-file]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version, repo, notesFile] = process.argv.slice(2);
if (!dir || !/^\d+\.\d+\.\d+$/.test(version ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) {
  console.error("usage: node scripts/make-latest-json.mjs <dist-dir> <major.minor.patch> <owner/repo> [notes-file]");
  process.exit(2);
}

// our build label -> the platform key the updater asks for
const PLATFORMS = { aarch64: "darwin-aarch64", x64: "darwin-x86_64" };
const platforms = {};
for (const [label, key] of Object.entries(PLATFORMS)) {
  const file = `AgentWatch_${version}_${label}.app.tar.gz`;
  if (!existsSync(join(dir, file)) || !existsSync(join(dir, `${file}.sig`))) continue;
  platforms[key] = {
    signature: readFileSync(join(dir, `${file}.sig`), "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${file}`,
  };
}
if (!Object.keys(platforms).length) {
  console.error(`no signed update bundles for ${version} in ${dir}`);
  process.exit(1);
}

const notes = notesFile && existsSync(notesFile) ? readFileSync(notesFile, "utf8").trim() : "";
const manifest = { version, notes, pub_date: new Date().toISOString(), platforms };
writeFileSync(join(dir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${join(dir, "latest.json")} for ${Object.keys(platforms).join(", ")}`);
