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
  {
    source: "shared/code-syntax.js",
    targets: [
      "mods/files-search/code-syntax.js",
      "mods/changes-review/code-syntax.js",
      "mods/git-history/code-syntax.js",
    ],
  },
  {
    source: "shared/markdown-syntax.js",
    targets: [
      "mods/files-search/markdown-syntax.js",
      "mods/changes-review/markdown-syntax.js",
      "mods/git-history/markdown-syntax.js",
    ],
  },
  {
    source: "shared/markdown-view-logic.js",
    targets: [
      "mods/files-search/markdown-view-logic.js",
      "mods/changes-review/markdown-view-logic.js",
      "mods/git-history/markdown-view-logic.js",
    ],
  },
  {
    source: "shared/markdown-view.js",
    targets: [
      "mods/files-search/markdown-view.js",
      "mods/changes-review/markdown-view.js",
      "mods/git-history/markdown-view.js",
    ],
  },
  {
    source: "shared/dropdown-logic.js",
    targets: [
      "mods/files-search/dropdown-logic.js",
      "mods/git-history/dropdown-logic.js",
    ],
  },
  {
    source: "shared/dropdown.js",
    targets: [
      "mods/files-search/dropdown.js",
      "mods/git-history/dropdown.js",
    ],
  },
  {
    source: "shared/code-nav-logic.js",
    targets: [
      "mods/files-search/code-nav-logic.js",
    ],
  },
  {
    source: "shared/code-nav-js.js",
    targets: [
      "mods/files-search/code-nav-js.js",
    ],
  },
  {
    source: "shared/code-nav-python.js",
    targets: [
      "mods/files-search/code-nav-python.js",
    ],
  },
  {
    source: "shared/code-nav-java.js",
    targets: [
      "mods/files-search/code-nav-java.js",
    ],
  },
  {
    source: "shared/diagnostics-logic.js",
    targets: [
      "mods/files-search/diagnostics-logic.js",
      "mods/changes-review/diagnostics-logic.js",
      "mods/git-history/diagnostics-logic.js",
      "mods/cognivisor-tabs/diagnostics-logic.js",
      "mods/cognivisor-status/diagnostics-logic.js",
    ],
  },
  {
    source: "shared/diagnostics.js",
    targets: [
      "mods/files-search/diagnostics.js",
      "mods/changes-review/diagnostics.js",
      "mods/git-history/diagnostics.js",
      "mods/cognivisor-tabs/diagnostics.js",
      "mods/cognivisor-status/diagnostics.js",
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
