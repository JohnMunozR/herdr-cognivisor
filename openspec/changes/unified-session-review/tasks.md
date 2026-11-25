# Tasks: Unified Session Review (`unified-session-review`)

## Phase 0 — Specs & Governance
- [x] 0.1 Create OpenSpec change artifacts (`proposal.md`, `design.md`, `specs/changes-review/spec.md`, `tasks.md`)
- [x] 0.2 Update `mods/changes-review/SPEC.md`, `architecture.md`, and `shared/SPEC.md`

## Phase 1 — Pure Logic Engine (`mods/changes-review/review-logic.js`)
- [x] 1.1 Implement `resolveRepoBaseRefWithExec`, `countUntrackedFileLines`, and unified `collectServiceSessionSnapshot`
- [x] 1.2 Implement `evaluateRepoSessionActivity`, `partitionSessionUnifiedEntries`, `startHead`/`rev` baseline support, `"deleted:D"` & SSH sig fixes, and remove 12h orphaned baseline stealing
- [x] 1.3 Migrate `computeFileReviewFingerprint` & `reconcileReviewedFiles` to commit-resilient `session::` scope
- [x] 1.4 Add `buildCommentKey` / `side` support, update `formatReviewAgentMessage`, update `resolveReviewMarkdownSourceSpec` for `baseHash`, fix `expandDiffGapInRows` Markdown `mdState`, and remove commit-inspection helpers

## Phase 2 — GPUI Component & Runtime (`mods/changes-review/main.js`)
- [x] 2.1 Remove commit selector dropdown (`#commit-selector-btn`, `#commit-dropdown-floating`, `viewMode`, `selectedCommit`, `dropdown.js` import)
- [x] 2.2 Remove `#service-filter-bar`, `#microservice-review-bar`, `activeService`, and `cognivisor.activeService` sync; render unified `#changes-list` with `[serviceName]` badges
- [x] 2.3 Wire unified `collectServiceSessionSnapshot`, `evaluateRepoSessionActivity`, `baseHash` diff/Markdown loading, and `[vs <baseRef>]` viewer pill
- [x] 2.4 Fix always-on candidate watchers, `pendingRefresh` retry queue, stable `location()`/`key()`, null `sessionTabId` bus guard, `!visible` short-circuit, `side`-aware comments, and dirty-only `Commit` drawer (`git add -- <dirtyPaths>`)

## Phase 3 — Cross-Mod Baseline Sync & Shared Packaging
- [x] 3.1 Update `mods/files-search/session-baseline.js` and `mods/files-search/panel-controller.js` to preserve `startHead`/`startBranch`/`rev`, invalidate `SESSION_BASELINE_CACHE` via `baselineRev`, and handle `"deleted:D"` parity
- [x] 3.2 Remove `mods/changes-review/dropdown.js` and `mods/changes-review/dropdown-logic.js` from `scripts/sync-shared.mjs`, `install.sh`, and disk

## Phase 4 — Tests & Verification Gate
- [x] 4.1 Update & expand `tests/changes-review-logic.test.mjs` and `tests/files-session-baseline.test.mjs`
- [x] 4.2 Run full verification gate (`npm test`, `herdr-app check`, `sync-shared --check`, `node --check`, `bash -n install.sh`, JSON integrity)
