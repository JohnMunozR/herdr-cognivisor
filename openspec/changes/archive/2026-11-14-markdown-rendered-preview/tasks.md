# Tasks: Markdown Rendered Preview (`markdown-rendered-preview`)

## Phase 1: Shared Foundation & Unit Tests

- [x] 1.1 Export `isFrontmatterDelimiter`, `parseFenceOpen`, and `parseFenceClose` from `shared/markdown-syntax.js` without altering tokenization behavior.
- [x] 1.2 Create `shared/markdown-view-logic.js` (pure engine) and `shared/markdown-view.js` (GPUI UI adapter wrapping `TextView.markdown`).
- [x] 1.3 Register `shared/markdown-view-logic.js` and `shared/markdown-view.js` in `scripts/sync-shared.mjs` (`SHARED_TARGETS` for `files-search`, `changes-review`, `git-history`), `install.sh`, and `shared/SPEC.md`.
- [x] 1.4 Run `node scripts/sync-shared.mjs` and write deterministic unit tests in `tests/shared-markdown-view.test.mjs`.
  - Verify: `npm test`

## Phase 2: Parallel Viewer Integrations

- [x] 2.1 Integrate toggle + rendered view into `mods/files-search/main.js` (both File Viewer Tab and Search Everywhere Preview Pane), update `mods/files-search/SPEC.md`, and add regression tests in `tests/files-search-logic.test.mjs`.
  - Verify: `herdr-app check mods/files-search && npm test`
- [x] 2.2 Integrate toggle + lazy lock-free rendered view into `mods/changes-review/main.js` (`#diff-file-review-bar`), update `mods/changes-review/SPEC.md`, and add regression tests in `tests/changes-review-logic.test.mjs`.
  - Verify: `herdr-app check mods/changes-review && npm test`
- [x] 2.3 Integrate toggle + lazy lock-free rendered view into `mods/git-history/main.js` (`#git-diff-toolbar`), update `mods/git-history/SPEC.md`, and add regression tests in `tests/git-history-diff-logic.test.mjs`.
  - Verify: `herdr-app check mods/git-history && npm test`

## Phase 3: Full Repository Verification & Deployment

- [x] 3.1 Run full verification gate:
  - `npm test`
  - `node scripts/sync-shared.mjs --check`
  - `for d in mods/*/; do herdr-app check "$d" || exit 1; done`
  - `for f in mods/*/*.js shared/*.js; do node --check "$f" || exit 1; done`
  - `bash -n install.sh`
  - JSON validation (`package.json`, `layouts/cognivisor.json`, `keys.json`)
- [x] 3.2 Run `./install.sh` cleanly and confirm runtime install + verification.
