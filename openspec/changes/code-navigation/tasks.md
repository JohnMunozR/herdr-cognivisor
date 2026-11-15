# Tasks: Code Navigation (`code-navigation`)

## Phase 1: Shared Syntax, Offset Wrapping & OpenSpec Governance

- [x] 1.1 Reconcile specs (`goal-and-requirements.md`, `architecture.md`, `shared/SPEC.md`, `mods/SPEC.md`, `mods/files-search/SPEC.md`) to document zero-daemon `Ctrl+Click` navigation, `shared/` modules, and optional `cognivisor.openFileTabs` fields.
- [x] 1.2 Create `shared/code-syntax.js` unifying syntax tokenization across `files-search`, `changes-review`, and `git-history`, adding `tokenizeInteractiveCodeLine` with 1-based column offsets and navigable token flags.
- [x] 1.3 Extend `shared/code-wrap.js` (`wrapStyledSpans`) to preserve 3rd-element span metadata and compute shifted `col` offsets across soft-wrapped visual segments without altering `[kind, text]` behavior.
- [x] 1.4 Register `shared/code-syntax.js`, `shared/code-nav-*.js`, and `files-search` targets for `dropdown-logic.js`/`dropdown.js` in `scripts/sync-shared.mjs` and `install.sh`; refactor `search-logic.js`, `review-logic.js`, and `diff-logic.js` to delegate to `./code-syntax.js`.
  - Verify: `node scripts/sync-shared.mjs && npm test`

## Phase 2: Pure Language Navigation Engines (`shared/code-nav-*.js`)

- [x] 2.1 Create `shared/code-nav-logic.js` (cursor classification, dispatcher, history stack helpers, multi-candidate ranking, symbol summary contract).
- [x] 2.2 Implement `shared/code-nav-js.js` (JS/TS/JSX/TSX scope trees, variable declarations vs function/arrow/method implementations, destructuring, ES/CJS/re-exports, alias path helpers) + `tests/code-nav-js.test.mjs`.
- [x] 2.3 Implement `shared/code-nav-python.js` (indentation LEGB scopes, `global`/`nonlocal`, first assignments, type hints, `self.attr`/inheritance, decorators, absolute/relative imports) + `tests/code-nav-python.test.mjs`.
- [x] 2.4 Implement `shared/code-nav-java.js` (`package`/imports, block/class/method scopes, local `var`/fields/arity, Spring/Lombok annotations, `interface`/`abstract` -> concrete `implements`/`extends` implementation resolution) + `tests/code-nav-java.test.mjs`.
  - Verify: `node scripts/sync-shared.mjs && npm test`

## Phase 3: Multi-Service Symbol Index & Cross-File IO Resolver (`mods/files-search`)

- [x] 3.1 Create `mods/files-search/symbol-index.js` supporting local incremental disk-cached symbol summaries (`watchFolder` debounced invalidation), `jsconfig.json`/`tsconfig.json`/`package.json` alias lookup, direct `readTextFile(..., { on })` import resolution, and remote/fallback `rg` + lock-free `git grep` queries via `exec(..., { on })`.
- [x] 3.2 Write unit & mocked-IO tests in `tests/files-symbol-index.test.mjs` using `tests/helpers/herdr-mock.mjs`.
  - Verify: `npm test`

## Phase 4: Interactive File Viewer & Search Everywhere Preview Integration

- [x] 4.1 Implement the interactive virtualized code viewer (`code-viewer.js` + `v_virtual_list` + `Scrollbar.vertical`) in `mods/files-search/main.js` with `16ms` resize wrap reflow, keyboard navigation, `scroll_to_item` centering + target highlight, `Ctrl+Hover` underline + `cursor_pointer()`, `Ctrl+Click` dispatch, `←`/`→` (`Alt+Left`/`Alt+Right`) history, `Copy` actions, disambiguation popover via `shared/dropdown.js`, and on-demand `Select Text` (`Editor.new`) toggle.
- [x] 4.2 Enable `Ctrl+Click` / `Ctrl+Hover` on navigable tokens in the Search Everywhere Preview (`mods/files-search/main.js`) while preserving plain click `selectResult`.
- [x] 4.3 Extend `openFileInTab` / `cognivisor.openFileTabs` syncing for `{ column, highlightSymbol, navOrigin, navSeq }` and add regression tests in `tests/files-search-logic.test.mjs`.
  - Verify: `herdr-app check mods/files-search && npm test`

## Phase 5: Full Repository Verification & Deployment Check

- [x] 5.1 Run full verification gate (`npm test`, `node scripts/sync-shared.mjs --check`, `herdr-app check` on all `mods/*/`, `node --check` on all `.js` files, `bash -n install.sh`, JSON validation, and spec-graph consistency check).
- [x] 5.2 Run independent verification pass across the diff and regression suite, fixing any blockers before final handoff.
