# Proposal: Unified Session Review (`unified-session-review`)

## Summary
Redesign `mods/changes-review` (`[[submodule-mod-changes-review]]`) from a split `Working Tree` / per-commit dropdown + multi-service filter pill bar into a **single unified session review** diffing against each repository's origin/base branch (`merge-base HEAD <originBaseRef>`), displaying all changes from session-touched repositories together in one unified list distinguished by per-file `[serviceName]` badges, while resolving 16 audited correctness, baseline-attribution, watcher, approval, comment, and commit-drawer defects.

## Motivation
1. **Repeated Review Friction:** Agents frequently edit a file, commit, and edit the same file again across subsequent commits and the working tree. Inspecting commits one by one via `#commit-selector-btn` forces developers to review the same file repeatedly and obscures the net change.
2. **Untouched Repository Leakage:** Clean or unrelated workspace repositories leak into the Changes panel due to commit-timestamp heuristics (`sessionCommits.length > 0`), 12-hour cross-tab orphaned baseline inheritance, premature `updatedAt` anchoring, pre-existing deleted file `mtimeMs: 0` leaks, and `SESSION_BASELINE_CACHE` split-brain between `changes-review` and `files-search`.
3. **Unnecessary Service Selector Chrome:** When a session modifies multiple repositories, clicking between `#service-filter-bar` pills slows review; files already carry `[serviceName]` labels that distinguish services cleanly in one unified list.
4. **Runtime & Review Reliability Bugs:** Watchers stop completely when a session starts clean (30s lag), watch events drop during in-flight refreshes, split-pane focus flips `key()`, untracked files show `+0` lines, deleted vs added line comments collide on the same line number, approvals wipe on commit, hidden panels still render full trees, and the bottom `Commit` drawer can stage hidden pre-existing files via `git add -A`.

## Scope & Decisions
- **1A — Origin/Base Branch Unified Diff:** Always diff tracked files against `merge-base HEAD <originBaseRef>` (`origin/HEAD` -> `origin/{development,main,master,ci}` -> local base branches), falling back to upstream tracking or `sessionBaseline.repos[root].startHead` when working directly on the base branch itself, plus untracked (`??`) files with real line counts. Remove commit inspection mode and `#commit-selector-btn` / `#commit-dropdown-floating`.
- **2A — Session-Only Pre-Existing Dirty Filtering:** Keep `#preexisting-baseline-bar` (`Show all` / `Reset baseline`) for uncommitted dirty files that existed before session start and are outside `baseHash..HEAD`, with all baseline bugs and cross-mod cache split-brain fixed.
- **3A — Fixed Bottom `Commit` Drawer:** Keep `Review (N) | Commit` strictly scoped to visible dirty working-tree files (`dirtyPaths.length > 0`) staged explicitly via `git add -- <paths>`.
- **4B — Clean Unified Panel:** Remove both `#service-filter-bar` and `#microservice-review-bar` (and `cognivisor.activeService` reading/writing in `changes-review`), rendering all touched repos' files in one unified `#changes-list` with `[serviceName]` badges.

## Impact Analysis
- **Layout Blocks (`layouts/cognivisor.json`):** No layout JSON structure changes required; `#changes` remains mounted in `#panel-body` and `#main` continues hosting the single reusable `role: "viewer"` Review tab.
- **Shared State Bus Keys:**
  - `cognivisor.services`: Schema preserved (`{ tabId, workspaceRoot, on, services, candidates, sig, ts }`) for full compatibility with `files-search`, `git-history`, and `cognivisor-status`; `changes-review` no longer overwrites the bus with `[]` when `sessionTabId` is transiently null.
  - `cognivisor.activeService`: `changes-review` stops reading/writing `cognivisor.activeService`; `files-search` and `git-history` continue synchronizing it unaffected.
  - `cognivisor.flows`: Adds lightweight integer `baselineRev` per tab (preserved by `compactFlowsMap`) to synchronize disk baseline updates across `changes-review` and `files-search`; drops dead `reviewedServices` writes; migrates `reviewedFiles` to commit-resilient `session::<serviceId>::<path>` keys.
  - `changes-review.activeDiff`: Drops `viewMode`, `selectedCommit`, and `activeService`; adds per-file `baseRef`/`baseHash` and optional `focusSide`.
  - `cognivisor.reviewNotes`: Adds `side: "old" | "new"` to disambiguate deleted vs added lines with identical line numbers (legacy notes without `side` default to `"new"`).
- **Shared Registry (`shared/`, `scripts/sync-shared.mjs`, `install.sh`):** Remove unused `dropdown.js` and `dropdown-logic.js` from `mods/changes-review/` (retained in `shared/` for `files-search` and `git-history`).
- **Backwards Compatibility:** Herdr default shipped layouts (`main.json`, `terminals.json`, `win98.json`) and `keys.json` remain completely untouched and compatible. Existing disk session baselines without `startHead` / `rev` normalize gracefully.
