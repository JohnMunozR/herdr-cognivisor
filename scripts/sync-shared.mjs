#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SHARED_TARGETS = [
  {
    source: "shared/code-wrap.js",
    targets: [
      "mods/files-search/code-wrap.js",
      "mods/changes-review/code-wrap.js",
      "mods/git-history/code-wrap.js",
    ],
  },
];

const checkOnly = process.argv.includes("--check");
let driftCount = 0;

for (const entry of SHARED_TARGETS) {
  const srcPath = resolve(ROOT, entry.source);
  const srcContent = readFileSync(srcPath, "utf8");

  for (const relTarget of entry.targets) {
    const destPath = resolve(ROOT, relTarget);
    const existing = existsSync(destPath) ? readFileSync(destPath, "utf8") : null;
    if (existing === srcContent) continue;

    if (checkOnly) {
      console.error(`drift: ${relTarget} does not match ${entry.source}`);
      driftCount += 1;
    } else {
      writeFileSync(destPath, srcContent, "utf8");
      console.log(`synced: ${entry.source} -> ${relTarget}`);
    }
  }
}

if (checkOnly && driftCount > 0) {
  process.exit(1);
}
