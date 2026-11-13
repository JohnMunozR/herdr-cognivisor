---
id: submodule-mod-mesh-flow
type: submodule-design
status: active
title: Mesh Flow Pipeline Bar Mod (mods/mesh-flow)
parent: module-mods
references: [module-layouts, submodule-mod-mesh-tabs]
covers: [six-stage-pipeline, inline-ticket-rename, auto-name-resync, lead-terminal-pinning, subagent-telemetry, quick-service-shell]
tags: [mod, workflow, pipeline, jira, orchestration]
---

## Responsibility

The `submodule-mod-mesh-flow` renders the `38px` tab-scoped lifecycle bar (`#flow`) inside `layouts/mesh.json` (`[[module-layouts]]`). Positioned directly between the workspace tab strip (`#tabs`, `[[submodule-mod-mesh-tabs]]`) and `#work-body`, it surfaces the active tab's extracted Jira ticket badge, 1-click inline editable title, explicit `Auto` title derivation trigger, an interactive 6-stage development pipeline stepper (`1. Plan` through `6. CI → main`), lead-agent pinning (`leadTerminal`), live subagent telemetry, live test failure/running alerts (`mesh.testAlert`), and a `+ Shell` microservice split-pane launcher overlay.

## Boundary

- **Owns:**
  - Manifest file: `mods/mesh-flow/mod.json` (`{ "place": "none", "title": "Mesh Flow" }`).
  - Main GPUI component and popup overlay view: `mods/mesh-flow/main.js`.
  - Self-contained icon assets under `mods/mesh-flow/icons/*.svg` (`sparkles.svg`, `pencil.svg`, `check.svg`, `bot.svg`, `terminal.svg`, `layers.svg`, `chevron-right.svg`, `flask.svg`).
- **Public surface:**
  - Registered mod identifier: `mesh-flow`.
  - Layout slot: `#flow` (`38px`) inside `#work` above `#work-body` in `layouts/mesh.json`.
  - Popup overlay role: `openOverlay({ mod: "mesh-flow", kind: "popup", props: { role: "shellMenu", tabId, spaceId, ... } })`.
  - Shared state bus interactions:
    - Reads and updates `mesh.flows` (`Record<tabId, MeshFlowTabState>`), preserving sibling fields (`reviewedServices`, `testPlanPath`, `prs`).
    - Reads `mesh.services` to populate microservice targets in the `+ Shell` popup overlay.
    - Reads `mesh.testAlert` to surface running or failing test telemetry for `activeTab.id`.
  - Host IPC and commands:
    - `run("tab.rename", { id, name })` for inline rename and `Auto` derivation.
    - `run("layout.select", { stack: "panel-body", child })` + `run("layout.show", { id: "panel" })` when activating panel-backed stages (`review`, `test`, `pr_dev`, `promote`).
    - `run("terminal.peek", { terminal })` when clicking the live subagent counter pill.
    - `run("pane.focus", { terminal })` when clicking a single lead terminal pill.
    - `hc(["get", terminal, "--json"])` and `hc(["read", terminal, "--lines", "40"])` for organic title derivation.
    - `hc(["run", "--bg", "--keep", "--cwd", svc.root, "--label", "herdr.space=...", "--label", "herdr.tab=...", "--label", "meshRunner=true"])` for spawning microservice runner shells.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `h_flex`, `v_flex`, `Input`, `InputState`, `ScrollHandle`.
  - `herdr`: `spaces`, `panes`, `terminals`, `agents`, `exec`, `hc`, `run`, `theme`, `notify`, `props`, `shared`, `setShared`, `openOverlay`, `closeOverlay`, `window`.
- **Forbidden:**
  - Any usage of `localStorage` or browser DOM globals.
  - Periodic or render-loop `setShared(...)` mutations (shared writes occur only on explicit user actions and real state changes).
  - Read-only Git invocations without lock-free flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
  - Rendering floating menus as clipped `absolute()` children inside the `38px` `#flow` bar (menus open in top-level `openOverlay` popups).
  - Allowing `+ Shell` (`meshRunner=true`) terminals to replace or overwrite `leadTerminal`.
  - Hardcoded color hex literals ignoring `theme()`.

## Architecture & Interaction Flow

```text
+----------------------------------------------------------------------------------------------------------+
| #flow (38px, mesh-flow)                                                                                  |
+------------------------------------+------------------------------------+--------------------------------+
| Left Zone (#flow-identity)         | Center Zone (#flow-stages)         | Right Zone (#flow-meta)        |
| [PROJ-412] [Feature title  ✎] [Auto]| (1.Plan)>(2.Build)>(3.Review)>... | [2 failed] [2 sub] [Lead] [+Shell] |
+------------------------------------+------------------------------------+--------------------------------+
                                             |                                                      |
                            stage.panel ? layout.select + layout.show                    openOverlay(role:"shellMenu")
                                             v                                                      v
                                    #panel-body (changes/test/ship)                 +--------------------------+
                                                                                    | Open Split Shell (Popup) |
                                                                                    | - Workspace Root         |
                                                                                    | - auth-service           |
                                                                                    | - web-client             |
                                                                                    +--------------------------+
```

### Zone Breakdown

1. **Left Zone (`#flow-identity`) — Ticket Badge, Inline Title Rename & `Auto` Trigger:**
   - Displays `flow.ticket` (or Jira key extracted via `/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/` from `activeTab.name`) with accent tint derived dynamically from `theme().accent`.
   - When not editing, renders a clickable title button (`activeTab.name || "Untitled flow"`) with a subtle pencil glyph. Clicking switches to `this.editingTitle = true`, seeds `this.titleInput` with `activeTab.name`, selects the text, and focuses the input.
   - Inside `Input.new(this.titleInput)`, pressing `Enter` commits via `run("tab.rename", { id: activeTab.id, name })`, extracts `ticket`, sets `manualTitle: true` and `autoNamed: false` in `mesh.flows[activeTab.id]`; pressing `Esc` or blurring cancels without overwriting the tab name.
   - Clicking `Auto` runs asynchronous organic derivation across `hc get <leadTerminal> --json`, `hc read <leadTerminal> --lines 40`, and lock-free `git rev-parse --abbrev-ref HEAD` across `pane.cwd` and `space.folder`, then applies `run("tab.rename", { id: activeTab.id, name })` and records `{ derivedTitle, ticket, manualTitle: false, autoNamed: true }`.

2. **Center Zone (`#flow-stages`) — Interactive 6-Stage Stepper:**
   - Horizontally scrollable strip (`overflow_x_scrollbar().track_scroll(this.stageScroll)`) rendering the six ordered stages separated by `chevron-right.svg`:
     1. `plan` (`1. Plan`)
     2. `build` (`2. Build`)
     3. `review` (`3. Review`, panel: `changes`)
     4. `test` (`4. Test`, panel: `test`)
     5. `pr_dev` (`5. PR → dev`, panel: `ship`)
     6. `promote` (`6. CI → main`, panel: `ship`)
   - Completed stages (`index < activeStageIndex`) show `check.svg`; the active stage highlights with `theme().selected` and `theme().accent`.
   - Clicking any stage updates `mesh.flows[activeTab.id].stage` (plus `shipPhase: stage === "promote" ? "promote" : "dev"` for `ship`-mapped stages) and, when `stage.panel` is defined, dispatches `layout.select` (`stack: "panel-body"`, `child: stage.panel`) and `layout.show` (`id: "panel"`).

3. **Right Zone (`#flow-meta`) — Test Alert, Subagents, Lead Agent & `+ Shell`:**
   - **Test Alert Pill:** Visible whenever `mesh.testAlert` matches `activeTab.id` and indicates `running` or `failed`. Clicking jumps straight to stage `test` and opens `#test`.
   - **Subagent Telemetry Pill (`N sub`):** Counts `terminals().filter(t => t.state === "live" && leadTerminal && t.parent === leadTerminal)`. Clicking peeks the first `blocked` or `working` subagent (falling back to the first live subagent) via `run("terminal.peek", { terminal })`.
   - **Lead Agent Pill (`Lead: <name>`):** Resolves non-runner terminals in `activeTab.id` by joining `panes()` with `terminals()` and `agents()` and excluding `labels?.meshRunner === "true"`. Clicking cycles `leadTerminal` in `mesh.flows[activeTab.id]` when multiple non-runner agents/terminals exist, or focuses the pane when only one exists.
   - **`+ Shell` Button & `shellMenu` Overlay:** Opens a `250x320` popup overlay (`openOverlay({ mod: "mesh-flow", kind: "popup", props: { role: "shellMenu", tabId, spaceId, ... } })`) listing the workspace root and all discovered `mesh.services`. Selecting any entry spawns a kept split shell inside the active tab with `meshRunner=true` via `hc run`, never altering `leadTerminal`.

## Invariants

1. **Zero `localStorage` & Explicit Shared Bus Writes:**
   `mesh-flow` never accesses `localStorage` and never calls `setShared("mesh.flows", ...)` inside `render()`. All mutations to `mesh.flows` occur only inside explicit user handlers or completed `Auto` derivation, and merge onto the latest tab state to preserve `reviewedServices`, `testPlanPath`, and `prs`.
2. **Lock-Free Git Inspection:**
   Every Git branch probe via `exec("git", ...)` prepends `["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"]`.
3. **Top-Level Overlay Menu (`shellMenu`):**
   Because `#flow` is constrained to `38px` height, the `+ Shell` microservice picker renders exclusively in a top-level `openOverlay` popup (`props()?.role === "shellMenu"`) so items are never clipped.
4. **Runner Pane Isolation:**
   Shells spawned via `+ Shell` carry `--label meshRunner=true` and are excluded from lead-agent candidate resolution, ensuring auxiliary processes never hijack `leadTerminal`.
5. **Dynamic Theme Inheritance:**
   All badges, borders, status indicators, and accents derive exclusively from `theme()` tokens (with dynamic alpha suffixes computed from those tokens).
