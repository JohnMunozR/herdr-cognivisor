---
id: module-shared
type: module-design
status: active
title: Shared Pure Utilities Module (shared/)
parent: architecture
references: [submodule-mod-files-search, submodule-mod-changes-review, submodule-mod-git-history]
covers: [soft-line-wrapping, column-budget-reflow]
tags: [shared, pure-logic, wrapping, sync]
---

## Responsibility

The `module-shared` directory holds the canonical source of truth for pure JavaScript helpers shared across multiple `herdr-mesh` mods without violating Herdr's per-mod bundling and `herdr-app check` sandboxing rules (which disallow relative `../` imports across `mods/*/` directories).

## Boundary

- **Owns:**
  - `shared/code-wrap.js`: Pure dependency-free soft line-wrapping module (`DEFAULT_TAB_SIZE`, `computeWrapColumns`, `codeUnitEndForColumns`, `expandTabsFromColumn`, `expandTabs`, `computeWrapRanges`, `countWrappedLines`, `wrapPlainText`, `wrapStyledSpans`).
  - Synced intra-mod runtime copies at `mods/files-search/code-wrap.js`, `mods/changes-review/code-wrap.js`, and `mods/git-history/code-wrap.js`, maintained identically via `scripts/sync-shared.mjs` (`npm run sync:shared` / `npm run check:shared`, enforced automatically in `npm test` and synced during `install.sh`).
- **Allowed deps:** Zero external or host imports (`node`, `gpui-kit`, `gpui-base`, and `herdr` free so it executes identically under both Node tests and QuickJS inside GPUI).
- **Forbidden:**
  - Directly importing `shared/*.js` across `../` boundaries from inside `mods/*/`.
  - Allowing any synced mod copy (`mods/*/code-wrap.js`) to drift from canonical `shared/code-wrap.js`.

## Invariants

1. **Zero Line-Number Inflation:** Wrapping splits long logical lines into visual continuation sub-rows without emitting extra logical line numbers in any consuming viewer (`files-search`, `changes-review`, `git-history`).
2. **Lossless Surrogate-Safe Splitting:** `wrapPlainText` and `wrapStyledSpans` never split UTF-16 surrogate pairs, never drop or reorder characters, preserve syntax token spans/colors/attributes across continuation sub-rows, and maintain an exact `O(1)` fast path when line length fits `maxCols`.
3. **Byte-for-Byte Sync Parity:** `node scripts/sync-shared.mjs --check` and `tests/shared-code-wrap.test.mjs` fail whenever `mods/{files-search,changes-review,git-history}/code-wrap.js` diverge from `shared/code-wrap.js`.
