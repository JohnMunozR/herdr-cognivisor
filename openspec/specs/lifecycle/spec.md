---
id: spec-lifecycle
type: module-design
status: active
title: Agent Workspace Lifecycle Specification
parent: architecture
references: [goal-and-requirements, module-layouts, module-mods, submodule-mod-changes-review, submodule-mod-files-search, submodule-mod-git-history, submodule-mod-cognivisor-tabs, submodule-mod-cognivisor-status]
covers: [tab-auto-naming, session-scoped-repo-attribution, microservice-review-checklist, git-history-graph, commit-diff-viewer, cross-platform-performance, shared-bus-persistence]
tags: [openspec, lifecycle, cognivisor-tabs, cognivisor-status, changes-review, files-search, git-history]
---

## Purpose

This specification defines the active **Agent Workspace Lifecycle** for Herdr Cognivisor (`[[goal-and-requirements]]`, `[[architecture]]`). It covers organic, terminal-first tab naming, session-scoped multi-repository attribution, service-by-service code review with per-service checklist tracking, read-only GitKraken-style repository commit history and Before/After diff comparison, cross-platform Search Everywhere and watch debouncing, and non-blocking bus coordination across `[[module-layouts]]`, `[[module-mods]]`, `[[submodule-mod-changes-review]]`, `[[submodule-mod-files-search]]`, `[[submodule-mod-git-history]]`, `[[submodule-mod-cognivisor-tabs]]`, and `[[submodule-mod-cognivisor-status]]`.

## Requirements

### Requirement: Organic Tab Auto-Naming and Manual Override Preservation

`mods/cognivisor-tabs` (`[[submodule-mod-cognivisor-tabs]]`) SHALL support an organic terminal-first workflow in which developers open a terminal tab, launch any AI coding agent (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`, etc.), and describe the Jira ticket or feature in their first message without upfront form entry.

- `cognivisor-tabs` MUST detect generic or unnamed tab labels (such as `^tb\d+$`, numeric tab indices, `tab.named === false`, or bare program/shell titles) and automatically derive a concise representative tab name.
- Name derivation MUST inspect `hc get <t> --json` and/or `hc read <t>` to extract Jira ticket keys matching `[A-Z][A-Z0-9]{1,9}-\d+` and summarize the agent's `first_message`, falling back to the active git branch name (queried with lock-free flags) when no ticket or prompt message is available.
- Automatic renaming MUST invoke `run("tab.rename", { id, name })` and MUST NOT overwrite manual user renames (`tab.named === true` or an explicit user-locked title recorded in `cognivisor.flows[tabId]`).
- `cognivisor-tabs` MUST provide double-click inline `Input` renaming on the tab pill and defer render-time side effects (`syncPanel`, newly-seen tab scans) via `cx.timer.after(0, ...)`.

#### Scenario: Automatic tab naming from first agent prompt with Jira key

- **GIVEN** a newly opened terminal tab with a generic name (`tb3`) running an agent whose `hc get <t> --json` or `hc read <t>` payload contains `"Implement PROJ-412 checkout webhook validation across cart-api and web-client"`
- **WHEN** `cognivisor-tabs` evaluates unnamed tabs (at `8000ms` per-terminal cooldown)
- **THEN** it extracts `"PROJ-412"`, summarizes `first_message`, calls `run("tab.rename", { id, name })` with a concise title (e.g., `"PROJ-412 · Checkout webhook validation"`), and records metadata in `cognivisor.flows[tabId]` without blocking terminal input.

#### Scenario: Preserving manual rename

- **GIVEN** a tab whose title was manually edited by the developer via double-click inline rename or `tab.rename` (`tab.named === true`)
- **WHEN** subsequent terminal output or branch changes occur
- **THEN** automatic background naming MUST leave the manual tab title untouched.

---

### Requirement: Three-Panel Cognivisor Layout Topology

`layouts/cognivisor.json` (`[[module-layouts]]`) and `mods/cognivisor-tabs` SHALL organize workspace drawers concisely across three primary panels (`files`, `changes`, `git`) without removed E2E test or PR pipeline chrome (`cognivisor-test`, `cognivisor-ship`, `#flow`).

- `layouts/cognivisor.json` MUST mount `#tabs` (`42px`, `mod: "cognivisor-tabs"`), `#work-body` (`#main` + collapsible `#panel`), `#panel-body` stack with child IDs `"files"` (`files-search`), `"changes"` (`changes-review`), and `"git"` (`git-history`), `#status` (`28px`, `mod: "cognivisor-status"`), and `0px` headless `#files-indexer` (`mod: "files-search"`, `props: { role: "indexer" }`), while preserving `"window_drag": true` on `#brand` and `#tabs`.
- `mods/cognivisor-tabs` MUST expose toggle buttons in `PANEL_DEFS` for `"files"` (`Files`), `"changes"` (`Review`), and `"git"` (`Git`), and recognize `git-history` viewer tabs with a Git icon in `#tabs`.

---

### Requirement: Session-Scoped Multi-Repository Discovery, Agent-Gated Workspace Indexing & Cross-Platform Performance

`mods/files-search` (`[[submodule-mod-files-search]]`) and `mods/changes-review` (`[[submodule-mod-changes-review]]`) SHALL expose only repositories touched or attributed to the active tab's session while minimizing OS process spawning across Windows, Linux, and macOS.

- `files-search` MUST debounce `watchFolder` events (`750ms`), ignore build/dependency churn (`node_modules/`, `target/`, `.git/` internal locks), cache `discoverRepos` results (`60000ms`), run `git status --untracked-files=normal`, throttle background scans when `#files` is hidden, and use native `fs/promises` scans on local filesystems.
- `files-search` MUST index both workspace files and directories (deriving parent directories + folder listing previews and trailing `/` folder search matching), persist workspace index snapshots under `${appHome()}/cognivisor/workspaces/<slug>-<fnv1a8>/files-index.json`, hydrate cold starts immediately from disk before verifying cleanly, and gate automatic background pre-warming + headless root `watchFolder` invalidation strictly on an open non-runner coding agent (`hasOpenAgentInSpace()`, zero background pre-indexing when only plain shell terminals are open).
- `files-search` MUST attribute touched repositories to the active tab session in `cognivisor.flows[tabId].sessionRepos` and publish `cognivisor.services` with a `sig` change key so `changes-review` reuses fresh `cognivisor.services` entries (`BUS_MAX_AGE_MS = 90000`) and wakes only when `bus.sig` changes.
- Search Everywhere (`files-search`) MUST pass `--path-separator /` to `rg`, normalize backslashes on Windows, treat `rg` exit code `1` cleanly as zero matches without triggering `git grep` fallback, retry invalid regex exit code `2` with `-F`, clamp split-pane widths without horizontal overflow, and defer panel state sync outside `renderPanel()`.

---

### Requirement: Microservice-by-Microservice Review and Lead Agent Priority

`mods/changes-review` (`[[submodule-mod-changes-review]]`) SHALL support structured microservice-by-microservice review and tab-scoped lead-agent targeting.

- `changes-review` MUST display the current Git branch per touched microservice using lock-free Git read flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
- `changes-review` MUST maintain a per-service review checklist with state `"pending" | "has_notes" | "approved"` persisted per tab in `cognivisor.flows[tabId].reviewedServices`.
- Adding inline notes on a service MUST mark its review status `"has_notes"`; clicking `Approve Service ✓` MUST set the current service's status to `"approved"` and jump directly to the next unreviewed dirty microservice (`workingCount > 0` and status !== `"approved"`), updating `cognivisor.activeService`.
- `findActiveAgent()` MUST resolve the target agent with `cognivisor.flows[tabId].leadTerminal` as highest priority before falling back to focused pane agent, tab agent, or global `agents()`.

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

---

### Requirement: Pure Mod Logic Separation & Mandatory Unit Test Gate

All `herdr-cognivisor` mods MUST keep testable non-UI business logic (indexing, watch filtering, query scoring, diff/syntax parsing, graph lane layout, repo filtering, tab naming) separated into intra-mod logic modules (`indexer.js`, `*-logic.js`) verified by native `node --test` unit suites (`tests/*.test.mjs`).

- Feature development, refactors, and bug fixes affecting mod logic MUST add or update unit/regression tests in `tests/*.test.mjs` and pass `npm test` (`node --test tests/*.test.mjs`) alongside `herdr-app check` before completion (`[[architecture]]`).
