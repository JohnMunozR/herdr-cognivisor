---
id: spec-lifecycle
type: module-design
status: active
title: Agent Workspace Lifecycle Specification
parent: architecture
references: [goal-and-requirements, module-layouts, module-mods, submodule-mod-changes-review, submodule-mod-files-search, submodule-mod-mesh-tabs, submodule-mod-mesh-status]
covers: [tab-auto-naming, session-scoped-repo-attribution, microservice-review-checklist, cross-platform-performance, shared-bus-persistence]
tags: [openspec, lifecycle, mesh-tabs, mesh-status, changes-review, files-search]
---

## Purpose

This specification defines the active **Agent Workspace Lifecycle** for Herdr Mesh (`[[goal-and-requirements]]`, `[[architecture]]`). It covers organic, terminal-first tab naming, session-scoped multi-repository attribution, service-by-service code review with per-service checklist tracking, cross-platform Search Everywhere and watch debouncing, and non-blocking bus coordination across `[[module-layouts]]`, `[[module-mods]]`, `[[submodule-mod-changes-review]]`, `[[submodule-mod-files-search]]`, `[[submodule-mod-mesh-tabs]]`, and `[[submodule-mod-mesh-status]]`.

## Requirements

### Requirement: Organic Tab Auto-Naming and Manual Override Preservation

`mods/mesh-tabs` (`[[submodule-mod-mesh-tabs]]`) SHALL support an organic terminal-first workflow in which developers open a terminal tab, launch any AI coding agent (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`, etc.), and describe the Jira ticket or feature in their first message without upfront form entry.

- `mesh-tabs` MUST detect generic or unnamed tab labels (such as `^tb\d+$`, numeric tab indices, `tab.named === false`, or bare program/shell titles) and automatically derive a concise representative tab name.
- Name derivation MUST inspect `hc get <t> --json` and/or `hc read <t>` to extract Jira ticket keys matching `[A-Z][A-Z0-9]{1,9}-\d+` and summarize the agent's `first_message`, falling back to the active git branch name (queried with lock-free flags) when no ticket or prompt message is available.
- Automatic renaming MUST invoke `run("tab.rename", { id, name })` and MUST NOT overwrite manual user renames (`tab.named === true` or an explicit user-locked title recorded in `mesh.flows[tabId]`).
- `mesh-tabs` MUST provide double-click inline `Input` renaming on the tab pill and defer render-time side effects (`syncPanel`, newly-seen tab scans) via `cx.timer.after(0, ...)`.

#### Scenario: Automatic tab naming from first agent prompt with Jira key

- **GIVEN** a newly opened terminal tab with a generic name (`tb3`) running an agent whose `hc get <t> --json` or `hc read <t>` payload contains `"Implement PROJ-412 checkout webhook validation across cart-api and web-client"`
- **WHEN** `mesh-tabs` evaluates unnamed tabs (at `8000ms` per-terminal cooldown)
- **THEN** it extracts `"PROJ-412"`, summarizes `first_message`, calls `run("tab.rename", { id, name })` with a concise title (e.g., `"PROJ-412 · Checkout webhook validation"`), and records metadata in `mesh.flows[tabId]` without blocking terminal input.

#### Scenario: Preserving manual rename

- **GIVEN** a tab whose title was manually edited by the developer via double-click inline rename or `tab.rename` (`tab.named === true`)
- **WHEN** subsequent terminal output or branch changes occur
- **THEN** automatic background naming MUST leave the manual tab title untouched.

---

### Requirement: Two-Panel Mesh Layout Topology

`layouts/mesh.json` (`[[module-layouts]]`) and `mods/mesh-tabs` SHALL organize workspace drawers concisely without removed E2E test or PR pipeline chrome (`mesh-test`, `mesh-ship`, `#flow`).

- `layouts/mesh.json` MUST mount `#tabs` (`42px`, `mod: "mesh-tabs"`), `#work-body` (`#main` + collapsible `#panel`), `#panel-body` stack with child IDs `"files"` (`files-search`) and `"changes"` (`changes-review`), `#status` (`28px`, `mod: "mesh-status"`), and 0px headless `#files-indexer` (`mod: "files-search"`, `props: { role: "indexer" }`), while preserving `"window_drag": true` on `#brand` and `#tabs`.

---

### Requirement: Session-Scoped Multi-Repository Discovery, Agent-Gated Workspace Indexing & Cross-Platform Performance

`mods/files-search` (`[[submodule-mod-files-search]]`) and `mods/changes-review` (`[[submodule-mod-changes-review]]`) SHALL expose only repositories touched or attributed to the active tab's session while minimizing OS process spawning across Windows, Linux, and macOS.

- `files-search` MUST debounce `watchFolder` events (`750ms`), ignore build/dependency churn (`node_modules/`, `target/`, `.git/` internal locks), cache `discoverRepos` results (`60000ms`), run `git status --untracked-files=normal`, throttle background scans when `#files` is hidden, and use native `fs/promises` scans on local filesystems.
- `files-search` MUST index both workspace files and directories (deriving parent directories + folder listing previews and trailing `/` folder search matching), persist workspace index snapshots under `${appHome()}/mesh/workspaces/<slug>-<fnv1a8>/files-index.json`, hydrate cold starts immediately from disk before verifying cleanly, and gate automatic background pre-warming + headless root `watchFolder` invalidation strictly on an open non-runner coding agent (`hasOpenAgentInSpace()`, zero background pre-indexing when only plain shell terminals are open).
- `files-search` MUST attribute touched repositories to the active tab session in `mesh.flows[tabId].sessionRepos` and publish `mesh.services` with a `sig` change key so `changes-review` reuses fresh `mesh.services` entries (`BUS_MAX_AGE_MS = 90000`) and wakes only when `bus.sig` changes.
- Search Everywhere (`files-search`) MUST pass `--path-separator /` to `rg`, normalize backslashes on Windows, treat `rg` exit code `1` cleanly as zero matches without triggering `git grep` fallback, retry invalid regex exit code `2` with `-F`, clamp split-pane widths without horizontal overflow, and defer panel state sync outside `renderPanel()`.

---

### Requirement: Microservice-by-Microservice Review and Lead Agent Priority

`mods/changes-review` (`[[submodule-mod-changes-review]]`) SHALL support structured microservice-by-microservice review and tab-scoped lead-agent targeting.

- `changes-review` MUST display the current Git branch per touched microservice using lock-free Git read flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
- `changes-review` MUST maintain a per-service review checklist with state `"pending" | "has_notes" | "approved"` persisted per tab in `mesh.flows[tabId].reviewedServices`.
- Adding inline notes on a service MUST mark its review status `"has_notes"`; clicking `Approve Service ✓` MUST set the current service's status to `"approved"` and jump directly to the next unreviewed dirty microservice (`workingCount > 0` and status !== `"approved"`), updating `mesh.activeService`.
- `findActiveAgent()` MUST resolve the target agent with `mesh.flows[tabId].leadTerminal` as highest priority before falling back to focused pane agent, tab agent, or global `agents()`.

---

### Requirement: Shared Bus Contracts, Zero `localStorage`, Pure Render, and Status Telemetry

All `herdr-mesh` mods MUST comply with Herdr's native persistence and GPUI-kit invariants (`[[architecture]]`, `[[module-mods]]`).

- `herdr-mesh` mods MUST contain zero `localStorage` references; `mesh-tabs` MUST persist per-space drawers via `shared("mesh.spacePanels")` / `setShared("mesh.spacePanels", ...)`.
- Views MUST NEVER call `cx.notify()`, `setShared()`, or widget `set_value()` synchronously during `render()`, and MUST cancel scheduled timers and release inputs/scroll handles inside `close()`.
- Cross-mod state MUST use exclusively documented `mesh.*` keys (`mesh.services`, `mesh.activeService`, `mesh.flows`, `mesh.spacePanels`) and mod-prefixed keys (`files-search.*`, `changes-review.*`).
- `mods/mesh-status` (`[[submodule-mod-mesh-status]]`) SHALL render active host, session service/dirty counts, active branch, live agent counters, and command palette shortcut inside `#status` (`28px`).

#### Scenario: Persisting space panel selection without localStorage

- **GIVEN** two spaces `space-a` (active panel `files`) and `space-b` (active panel `changes`)
- **WHEN** the user switches between `space-a` and `space-b` in `mesh-tabs`
- **THEN** `mesh-tabs` schedules deferred `syncPanel()` reads and writes via `shared("mesh.spacePanels")` to restore each space's `#panel-body` selection without calling `localStorage`.

---

### Requirement: Pure Mod Logic Separation & Mandatory Unit Test Gate

All `herdr-mesh` mods MUST keep testable non-UI business logic (indexing, watch filtering, query scoring, diff/syntax parsing, tab naming) separated into intra-mod logic modules (`indexer.js`, `*-logic.js`) verified by native `node --test` unit suites (`tests/*.test.mjs`).

- Feature development, refactors, and bug fixes affecting mod logic MUST add or update unit/regression tests in `tests/*.test.mjs` and pass `npm test` (`node --test tests/*.test.mjs`) alongside `herdr-app check` before completion (`[[architecture]]`).
