---
id: delta-spec-git-history
type: module-design
status: done
title: OpenSpec Delta — Git History & Commit Comparison (git-history)
parent: spec-lifecycle
references: [goal-and-requirements, architecture, module-layouts, module-mods, submodule-mod-cognivisor-tabs]
covers: [three-panel-layout, git-history-graph, commit-diff-viewer, side-by-side-diff, single-tab-reuse, shared-bus-persistence]
tags: [openspec, delta, git-history, gpui-kit, lifecycle]
---

## RENAMED Requirements

- `Two-Panel Cognivisor Layout Topology` → `Three-Panel Cognivisor Layout Topology`

---

## MODIFIED Requirements

### Requirement: Three-Panel Cognivisor Layout Topology

`layouts/cognivisor.json` (`[[module-layouts]]`) and `mods/cognivisor-tabs` SHALL organize workspace drawers concisely across three primary panels (`files`, `changes`, `git`) without removed E2E test or PR pipeline chrome (`cognivisor-test`, `cognivisor-ship`, `#flow`).

- `layouts/cognivisor.json` MUST mount `#tabs` (`42px`, `mod: "cognivisor-tabs"`), `#work-body` (`#main` + collapsible `#panel`), `#panel-body` stack with child IDs `"files"` (`files-search`), `"changes"` (`changes-review`), and `"git"` (`git-history`), `#status` (`28px`, `mod: "cognivisor-status"`), and `0px` headless `#files-indexer` (`mod: "files-search"`, `props: { role: "indexer" }`), while preserving `"window_drag": true` on `#brand` and `#tabs`.
- `mods/cognivisor-tabs` MUST expose toggle buttons in `PANEL_DEFS` for `"files"` (`Files`), `"changes"` (`Review`), and `"git"` (`Git`), and recognize `git-history` viewer tabs with a Git icon in `#tabs`.

---

### Requirement: Shared Bus Contracts, Zero `localStorage`, Pure Render, and Status Telemetry

All `herdr-cognivisor` mods MUST comply with Herdr's native persistence and GPUI-kit invariants (`[[architecture]]`, `[[module-mods]]`).

- `herdr-cognivisor` mods MUST contain zero `localStorage` references; `cognivisor-tabs` MUST persist per-space drawers via `shared("cognivisor.spacePanels")` / `setShared("cognivisor.spacePanels", ...)` supporting `"files" | "changes" | "git" | null`.
- Views MUST NEVER call `cx.notify()`, `setShared()`, or widget `set_value()` synchronously during `render()`, and MUST cancel scheduled timers and release inputs/scroll handles inside `close()`.
- Cross-mod state MUST use exclusively documented `cognivisor.*` keys (`cognivisor.services`, `cognivisor.activeService`, `cognivisor.flows`, `cognivisor.spacePanels`, `cognivisor.spaceAgentTabs`, `cognivisor.openFileTabs`, `cognivisor.reviewNotes`) and mod-prefixed keys (`files-search.*`, `changes-review.*`, `git-history.activeDiff`, `git-history.selectedRepo`).
- `mods/cognivisor-status` (`[[submodule-mod-cognivisor-status]]`) SHALL render active host, session service/dirty counts, active branch, live agent counters, and command palette shortcut inside `#status` (`28px`).

#### Scenario: Persisting space panel selection without localStorage

- **GIVEN** two spaces `space-a` (active panel `files`) and `space-b` (active panel `git`)
- **WHEN** the user switches between `space-a` and `space-b` in `cognivisor-tabs`
- **THEN** `cognivisor-tabs` schedules deferred `syncPanel()` reads and writes via `shared("cognivisor.spacePanels")` to restore each space's `#panel-body` selection without calling `localStorage`.

---

### Requirement: Pure Mod Logic Separation & Mandatory Unit Test Gate

All `herdr-cognivisor` mods MUST keep testable non-UI business logic (indexing, watch filtering, query scoring, diff/syntax parsing, graph lane layout, repo filtering, tab naming) separated into intra-mod logic modules (`indexer.js`, `*-logic.js`) verified by native `node --test` unit suites (`tests/*.test.mjs`).

- Feature development, refactors, and bug fixes affecting mod logic MUST add or update unit/regression tests in `tests/*.test.mjs` and pass `npm test` (`node --test tests/*.test.mjs`) alongside `herdr-app check` before completion (`[[architecture]]`).

---

## ADDED Requirements

### Requirement: GitKraken-Style Visual History and Multi-Repo Inspection (`mods/git-history`)

`mods/git-history` (`[[submodule-mod-git-history]]`) SHALL provide a docked `#git` drawer displaying a GitKraken-style topological commit graph in the upper section and the selected commit's modified files in the lower section.

- `git-history` MUST discover and expose all workspace Git repositories (both clean and dirty, local and remote via `on`) in a repository selector, syncing with `cognivisor.activeService` when a dirty service is selected without erasing clean-repo selections in `git-history.selectedRepo`.
- `git-history` MUST execute all read-only Git commands (`git log`, `git diff-tree`, `git show`, `git diff`, `git for-each-ref`, `git rev-parse`) using lock-free flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
- `git-history` MUST compute deterministic topological lanes, branch/merge Bezier connectors, commit/merge/HEAD nodes, and colored ref badges (`HEAD`, local branches, remote branches, tags) rendered via `gpui-kit` `PathBuilder` + `window.paint_path` inside a virtualized commit list (`v_virtual_list`) with theme-derived palette colors (`theme()`, `settings().colors`, `layout().colors`).
- `git-history` MUST partition `#git` vertically using `v_resizable` / `resizable_panel` so the top pane displays the commit graph + branch/search filters and the bottom pane displays the selected commit's metadata and list of modified files (`M`, `A`, `D`, `R`, `+add`/`-del`, file-type icons).
- `git-history` MUST support branch filtering (`All Branches` or specific branch) and text filtering (commit subject, author, SHA) plus bounded pagination (`-n 200` chunks) so large repositories stay responsive.

#### Scenario: Inspecting a commit in the GitKraken graph and viewing changed files

- **GIVEN** a Git repository open in the `#git` panel with multiple branches and merge commits
- **WHEN** the developer switches to the `Git` panel and clicks a commit in the topological graph
- **THEN** the commit row is highlighted, its metadata and modified file list appear in the lower pane of `#git`, and the comparison tab opens in `#main` showing the first modified file.

---

### Requirement: Single-Tab Before/After Commit Diff Comparison and In-Place File Switching

Selecting a commit or any of its modified files in `mods/git-history` SHALL drive a single reusable `#main` comparison tab (`role: "viewer"`) per space without spawning duplicate tabs.

- Selecting a commit in `#git` MUST record the active terminal tab in `cognivisor.spaceAgentTabs`, populate `git-history.activeDiff[spaceId]` with the commit's file list and first modified file, and either create one `#main` tab (`run("tab.new", { space, mod: "git-history", props: { role: "viewer", spaceId, sourceTabId } })`) or reuse and focus the existing `git-history` viewer tab in that space (`tab.rename` + `tab.select`).
- Selecting another commit while a `git-history` viewer tab already exists in the space MUST reuse and update that same tab rather than opening a second tab.
- Clicking any file in the bottom changed-files list of `#git` MUST update `git-history.activeDiff[spaceId]` and switch the displayed comparison in the existing viewer tab **in place** without opening a new tab.
- The viewer tab MUST render **Side-by-Side (`Before | After`)** comparison by default—keeping `Before` (left) and `After` (right) rows aligned inside one vertical scroll container with independent horizontal scrollbars—and provide a toggle to switch to **Unified** view, Prev/Next (`←`/`→`) file navigation, and full-context expansion (`-U99999`).
- Root/initial commits (`0` parents), deleted files, renamed files (`-M`), and binary files MUST be handled cleanly with explicit `Before` / `After` empty or binary notices.

#### Scenario: Switching files in a commit without opening extra tabs

- **GIVEN** commit `abc1234` changed 3 files (`a.ts`, `b.ts`, `c.ts`) and clicking `abc1234` opened the `Git` comparison tab on `a.ts`
- **WHEN** the developer clicks `b.ts` in the bottom changed-files list of `#git` (or clicks another commit `def5678` in the graph)
- **THEN** `git-history` updates `git-history.activeDiff[spaceId]`, renames and focuses the existing `#main` `git-history` viewer tab in place, and loads the `Before | After` diff without creating any additional tab in `#tabs`.
