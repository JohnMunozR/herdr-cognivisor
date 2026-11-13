---
id: spec-lifecycle
type: module-design
status: active
title: Agent IDE Lifecycle Specification
parent: architecture
references: [goal-and-requirements, module-layouts, module-mods, submodule-mod-changes-review, submodule-mod-files-search, submodule-mod-mesh-tabs, submodule-mod-mesh-flow, submodule-mod-mesh-test, submodule-mod-mesh-ship, submodule-mod-mesh-status]
covers: [tab-auto-naming, six-stage-pipeline, microservice-review-checks, live-agent-testing, playwright-e2e-screenshots, multi-service-pr-promotion, shared-bus-persistence]
tags: [openspec, lifecycle, mesh-tabs, mesh-flow, mesh-test, mesh-ship, mesh-status, changes-review]
---

## Purpose

This specification defines the complete **Agent IDE Lifecycle** for Herdr Mesh (`[[goal-and-requirements]]`, `[[architecture]]`). It extends the workspace from file navigation and code review into an organic, terminal-first, six-stage multi-microservice engineering pipeline (`Plan → Build → Review → Test → PR → dev → CI → main`) coordinated across `[[module-layouts]]`, `[[module-mods]]`, `[[submodule-mod-changes-review]]`, `[[submodule-mod-files-search]]`, and the lifecycle mods `mods/mesh-tabs` (`[[submodule-mod-mesh-tabs]]`), `mods/mesh-flow` (`[[submodule-mod-mesh-flow]]`), `mods/mesh-test` (`[[submodule-mod-mesh-test]]`), `mods/mesh-ship` (`[[submodule-mod-mesh-ship]]`), and `mods/mesh-status` (`[[submodule-mod-mesh-status]]`).

## Requirements

### Requirement: Organic Tab Auto-Naming and Manual Override Preservation

`mods/mesh-tabs` (`[[submodule-mod-mesh-tabs]]`) and `mods/mesh-flow` (`[[submodule-mod-mesh-flow]]`) SHALL support an organic terminal-first workflow in which developers open a terminal tab, launch any AI coding agent (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`, etc.), and describe the Jira ticket or feature in their first message without upfront form entry.

- Both mods MUST detect generic or unnamed tab labels (such as `^tb\d+$`, numeric tab indices, `tab.named === false`, or bare program/shell titles) and automatically derive a concise representative tab name.
- Name derivation MUST inspect `hc get <t> --json` and/or `hc read <t>` to extract Jira ticket keys matching `[A-Z][A-Z0-9]{1,9}-\d+` and summarize the agent's `first_message`, falling back to the active git branch name (queried with lock-free flags) when no ticket or prompt message is available.
- Automatic renaming MUST invoke `run("tab.rename", { id, name })` and MUST NOT overwrite manual user renames (`tab.named === true` or an explicit user-locked title recorded in `mesh.flows[tabId]`).
- `mesh-tabs` and `mesh-flow` MUST provide a 1-click inline rename control on the active tab/flow header and an `Auto` re-sync trigger in `#flow` that recomputes and applies the derived tab name on demand.

#### Scenario: Automatic tab naming from first agent prompt with Jira key

- **GIVEN** a newly opened terminal tab with a generic name (`tb3`) running an agent whose `hc get <t> --json` or `hc read <t>` payload contains `"Implement PROJ-412 checkout webhook validation across cart-api and web-client"`
- **WHEN** `mesh-tabs` or `mesh-flow` evaluates unnamed tabs
- **THEN** it extracts `"PROJ-412"`, summarizes `first_message`, calls `run("tab.rename", { id, name })` with a concise title (e.g., `"PROJ-412 Checkout webhook validation"`), and records metadata in `mesh.flows[tabId]` without blocking terminal input.

#### Scenario: Preserving manual rename and honoring explicit Auto re-sync

- **GIVEN** a tab whose title was manually edited by the developer via 1-click inline rename or `tab.rename` (`tab.named === true`)
- **WHEN** subsequent terminal output or branch changes occur
- **THEN** automatic background naming MUST leave the manual tab title untouched
- **AND** clicking the `Auto` trigger in `#flow` MUST explicitly re-derive the representative name from current agent prompt/branch state and apply `run("tab.rename", { id, name })`.

---

### Requirement: Six-Stage Tab-Scoped Development Pipeline and Mesh Layout Topology

`mods/mesh-flow` (`[[submodule-mod-mesh-flow]]`) and `layouts/mesh.json` (`[[module-layouts]]`) SHALL orchestrate a tab-scoped six-stage development pipeline across the workspace.

- Each tab MUST track its active lifecycle stage in `shared("mesh.flows")[tabId].stage` using exact stage identifiers:
  1. `plan` (`1. Plan`)
  2. `build` (`2. Build`)
  3. `review` (`3. Review`)
  4. `test` (`4. Test`)
  5. `pr_dev` (`5. PR → dev`)
  6. `promote` (`6. CI → main`)
- Selecting a stage in `#flow` MUST update `mesh.flows[tabId].stage` and automatically open and select the corresponding `#panel-body` stack slot:
  - `review` MUST select `changes` and show `#panel`.
  - `test` MUST select `test` and show `#panel`.
  - `pr_dev` and `promote` MUST select `ship` and show `#panel`.
- `layouts/mesh.json` MUST mount `#flow` (`38px`, `mod: "mesh-flow"`) inside `#work` directly above `#work-body`, upgrade `#tabs` (`42px`) to `mod: "mesh-tabs"`, expand `#panel-body` stack children to `files` (`files-search`), `changes` (`changes-review`), `test` (`mesh-test`), and `ship` (`mesh-ship`), and upgrade `#status` (`28px`) to `mod: "mesh-status"`.

#### Scenario: Stage selection synchronizes panel visibility and stack view

- **GIVEN** a tab currently in stage `build` with `#panel` hidden
- **WHEN** the user clicks stage `4. Test` in `#flow`
- **THEN** `mesh.flows[tabId].stage` is updated to `"test"`
- **AND** `mesh-flow` invokes `layout.select` for `#panel-body` child `"test"` and `layout.show` for `#panel`.

#### Scenario: Backwards-compatible panel IDs in layouts/mesh.json

- **GIVEN** `layouts/mesh.json` with expanded `#panel-body` stack
- **WHEN** Herdr loads `layouts/mesh.json`
- **THEN** `#panel-body` preserves `"files"` and `"changes"` child IDs verbatim alongside `"test"` and `"ship"`, and `#brand` and `#tabs` preserve `"window_drag": true`.

---

### Requirement: Microservice-by-Microservice Review, Repo Standards Checks, and Lead Agent Priority

`mods/changes-review` (`[[submodule-mod-changes-review]]`) SHALL support structured microservice-by-microservice review, automated repository standard checks, and tab-scoped lead-agent targeting.

- `changes-review` MUST display the current Git branch per discovered microservice using lock-free Git read flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
- `changes-review` MUST maintain a per-service review checklist with state `"pending" | "has_notes" | "approved"` persisted per tab in `mesh.flows[tabId].reviewedServices[serviceId]`.
- Adding inline notes on a service MUST mark its review status `"has_notes"`; clicking `Approve Service ✓` MUST set the current service's status to `"approved"` and jump directly to the next unreviewed dirty microservice (`workingCount > 0` and status !== `"approved"`), updating `mesh.activeService`.
- Clicking the `Checks` button MUST inspect repository standards and build manifests (`AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, `Makefile`) to resolve lint/test/check commands, execute them asynchronously per microservice, surface check statuses and output, and permit 1-click dispatch of check failures to the active feature agent.
- `findActiveAgent()` MUST resolve the target agent with `mesh.flows[tabId].leadTerminal` as highest priority before falling back to focused pane agent, tab agent, or global `agents()`.

#### Scenario: Approving a microservice advances to next unreviewed dirty service

- **GIVEN** dirty microservices `auth-service` (`pending`) and `web-client` (`pending`), with `auth-service` selected
- **WHEN** the reviewer clicks `Approve Service ✓`
- **THEN** `mesh.flows[tabId].reviewedServices["auth-service"].status` becomes `"approved"`
- **AND** `changes-review` switches `mesh.activeService` to `web-client` and loads its working-tree diffs.

#### Scenario: Running repository standard checks and dispatching failures to leadTerminal

- **GIVEN** a tab whose `leadTerminal` is `t1` while a service runner pane `t4` is focused
- **WHEN** the reviewer clicks `Checks` and a test command fails in `cart-api`
- **THEN** `changes-review` displays the failed check output and dispatches the failure summary via `hc(["send", leadTerminal, ...])` to `t1` rather than the auxiliary runner `t4`.

---

### Requirement: Zero-Pollution Live Agent-Driven Testing and Playwright E2E Screenshots

`mods/mesh-test` (`[[submodule-mod-mesh-test]]`) SHALL orchestrate live agent-driven API (`curl`) and Playwright E2E testing while keeping microservice Git repositories free of untracked test files.

- All runtime test-plan JSON files and screenshot artifacts MUST reside under `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json` and `${appHome()}/mesh/workspaces/<workspaceHash>/screenshots/<tabId>/`, NEVER inside microservice repository working trees.
- Clicking `Ask Agent for Test Plan` MUST dispatch a prompt via `hc send` to the tab's lead agent containing the exact JSON path, screenshot output directory, browser mode (`headed` or `headless`), and required schema (`title`, `approved`, `servicesToStart`, `cases[]` with `kind: "curl" | "e2e"`, `status: "pending" | "running" | "passed" | "failed"`, `httpCode`, `durationMs`, `summary`, `screenshot`, `screenshots`).
- `mesh-test` MUST observe the test-plans directory via `watchFolder` (with a visible polling fallback) to render real-time updates as the agent executes `curl` and Playwright E2E tests across full-stack workspaces (e.g., Angular + Java/Node.js).
- Playwright PNG screenshots stored under `appHome()` MUST be rendered inline in GPUI via `image(absPath)` and open in a click-to-zoom modal overlay via `openOverlay`.
- Clicking `Approve Plan` MUST atomically set `approved: true` in the test-plan JSON via `writeTextFile` and send an `hc send` confirmation instructing the agent to start local services and run the approved cases.
- `mesh-test` MUST probe local TCP listening ports via `ss -tln` (or `hc exec --on` for remote spaces), offer 1-click `+ Service Runner` split panes in the active tab without hijacking `leadTerminal`, support optional manual re-runs of `curl` cases, and provide `Send Failures to Agent` for automatic fix-and-retest loops.

#### Scenario: Live rendering of E2E progress and inline Playwright screenshots

- **GIVEN** an approved test plan at `${appHome()}/mesh/workspaces/<hash>/test-plans/<tabId>.json`
- **WHEN** the agent updates a `kind: "e2e"` case to `status: "passed"`, `durationMs: 1420`, and writes `screenshots/<tabId>/checkout-success.png`
- **THEN** `mesh-test` detects the file update via `watchFolder`/polling, renders the `passed` badge and timing live, displays the PNG thumbnail inline via `image(absPath)`, and opens a zoomed overlay on click without touching any microservice Git working tree.

#### Scenario: Approving test plan triggers service startup and execution

- **GIVEN** a newly generated test plan with `approved: false` and `servicesToStart` entries
- **WHEN** the developer clicks `Approve Plan`
- **THEN** `mesh-test` persists `approved: true` using optimistic `writeTextFile` and dispatches an `hc send` prompt to `leadTerminal` to boot required services and run tests.

---

### Requirement: Configurable PR Template and Multi-Service Promotion Pipeline

`mods/mesh-ship` (`[[submodule-mod-mesh-ship]]`) SHALL manage multi-service GitHub Pull Request creation, template enforcement, live PR/CI/review monitoring, and branch-chain promotion.

- `mesh-ship` MUST maintain a configurable branch promotion chain defaulting to `["development", "ci", "main"]` in `shared("mesh.pipelineConfig")`, editable per workspace in the UI with optional per-repo branch chain overrides.
- `mesh-ship` MUST manage a configurable PR template in `shared("mesh.pipelineConfig").prTemplate` and `${appHome()}/mesh/pr-template.md` supporting `{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, and `{{testSummary}}` placeholders.
- Placeholder-expanded PR template bodies MUST be injected identically into both direct `gh pr create` actions and `Ask Agent to Create PRs` prompts so every PR across all microservices follows the same structure.
- `mesh-ship` MUST query `gh` asynchronously per microservice to monitor PR status, CI `statusCheckRollup`, `reviewDecision`, and unresolved review comments/threads, and MUST offer a 1-click `Send Review Comments to Agent` button to dispatch unresolved feedback to the tab's lead agent.
- `mesh-ship` MUST support both single-service and batch promotion PRs across chain transitions (e.g., `feature -> development`, `development -> ci`, `ci -> main`).

#### Scenario: Consistent PR template injection across direct gh and agent PR creation

- **GIVEN** a configured PR template containing `{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, and `{{testSummary}}`
- **WHEN** the user triggers either direct `gh pr create` or `Ask Agent to Create PRs` for `PROJ-412`
- **THEN** all placeholders resolve from `mesh.flows[tabId]`, `mesh.services`, and the tab's test plan summary so every microservice PR receives an identical formatted body structure.

#### Scenario: Resolving unresolved GitHub review threads via agent dispatch

- **GIVEN** an open PR in `cart-api` reporting `reviewDecision: "CHANGES_REQUESTED"` and 2 unresolved review threads via `gh`
- **WHEN** the user clicks `Send Review Comments to Agent`
- **THEN** `mesh-ship` compiles file paths, line numbers, author, and thread text and sends them via `hc send` to `leadTerminal`.

---

### Requirement: Shared Bus Contracts, Zero `localStorage`, and Status Telemetry

All `herdr-mesh` mods MUST comply with Herdr's native persistence and GPUI-kit invariants (`[[architecture]]`, `[[module-mods]]`).

- `herdr-mesh` mods MUST contain zero `localStorage` references; `mesh-tabs` MUST replace `tabs`'s `localStorage` panels store with `shared("mesh.spacePanels")` / `setShared("mesh.spacePanels", ...)`.
- Cross-mod state MUST use exclusively documented `mesh.*` keys (`mesh.services`, `mesh.activeService`, `mesh.flows`, `mesh.pipelineConfig`, `mesh.spacePanels`, `mesh.testAlert`) and mod-prefixed keys (`files-search.*`, `changes-review.*`).
- `mods/mesh-status` (`[[submodule-mod-mesh-status]]`) SHALL render active pipeline stage, microservice/dirty counts, `mesh.testAlert` test status, and PR/review alerts inside `#status` (`28px`).

#### Scenario: Persisting space panel selection without localStorage

- **GIVEN** two spaces `space-a` (active panel `test`) and `space-b` (active panel `ship`)
- **WHEN** the user switches between `space-a` and `space-b` in `mesh-tabs`
- **THEN** `mesh-tabs` reads and writes `shared("mesh.spacePanels")` to restore each space's `#panel-body` selection without calling `localStorage`.
