---
id: submodule-mod-mesh-status
type: submodule-design
status: active
title: Mesh Status Bar Mod (mods/mesh-status)
parent: module-mods
references: [module-layouts, submodule-mod-mesh-flow]
covers: [workspace-status-bar, stage-indicator, live-test-alert-pill, ship-alert-pill, agent-counters]
tags: [mod, status-bar, telemetry, alerts]
---

## Responsibility

The `submodule-mod-mesh-status` provides the bottom `28px` workspace telemetry bar (`#status`) in `layouts/mesh.json` (`[[module-layouts]]`). Upgrading Herdr's core `workspace-status` mod for the Agent IDE Lifecycle (`[[spec-lifecycle]]`), it preserves core host, branch, live agent counters, and command palette controls while surfacing multi-service counts, the active tab's 6-stage lifecycle indicator (`[[submodule-mod-mesh-flow]]`), clickable live test execution alerts (`mesh.testAlert`), and clickable PR/CI/review comment alerts (`mesh.flows[tabId].prs`).

## Boundary

- **Owns:**
  - Manifest file: `mods/mesh-status/mod.json` (`{ "place": "none", "title": "Mesh Status" }`).
  - Main view component: `mods/mesh-status/main.js` (`MeshStatus` extending `View`).
  - Self-contained SVG icon assets: `mods/mesh-status/icons/{server,monitor,branch,layers,check,alert,git-pr}.svg`.
- **Public surface:**
  - Registered mod identifier: `mesh-status`.
  - Layout slot: `#status` (`28px` height) in `layouts/mesh.json`.
  - Reactive read-only shared bus consumers:
    - `shared("mesh.services")`: Multi-microservice topology summary.
    - `shared("mesh.flows")`: Per-tab lifecycle stage (`stage`) and open PR metadata (`prs`).
    - `shared("mesh.testAlert")`: Active tab/workspace test execution status.
  - Host command dispatches:
    - Test alert click -> `run("layout.select", { stack: "panel-body", child: "test" })` and `run("layout.show", { id: "panel" })`.
    - Ship alert click -> `run("layout.select", { stack: "panel-body", child: "ship" })` and `run("layout.show", { id: "panel" })`.
    - Palette click -> `run("app.palette")`.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `h_flex`.
  - `herdr`: `spaces`, `agents`, `theme`, `shared`, `run`, `window`, `keys`.
- **Forbidden:**
  - Any reference to `localStorage`, browser DOM globals, or non-GPUI elements.
  - Hardcoded hex color literals outside dynamic `theme()` tokens.
  - Mutating `mesh.*` shared state or spawning subprocesses (`exec`, `hc`) during status bar rendering.
  - Reading or mutating internal closures of sibling mods (`mesh-flow`, `mesh-test`, `mesh-ship`).

## Architecture & Interaction Flow

```text
+----------------------------------------------------------------------------------------------------------+
| [monitor/server] Machine | [layers] N services | [branch] main | [● 4. Test]                             |
|   | [check/alert] Test: 3/4 passed (click -> #test) | [git-pr] PRs: 2 · 3 comments (click -> #ship)      |
|   | [●] 3 agents · 1 needs you                                                      [Ctrl+K  commands]   |
+----------------------------------------------------------------------------------------------------------+
```

### Telemetry Segments

1. **Machine Badge (`#status-machine`):**
   Displays `space?.machine ?? "This computer"` paired with `server.svg` (remote machine) or `monitor.svg` (local host).
2. **Services & Branch Summary (`#status-services`, `#status-branch`):**
   When `shared("mesh.services")` matches the active space folder and reports more than 1 service (`services.length > 1`), displays `${services.length} services` (appending `· ${dirtyCount} dirty` when dirty counts are present) with `layers.svg`, alongside `space?.branch` with `branch.svg` when present. When 1 or fewer services exist, falls back to `space?.branch` only.
3. **Active Tab Stage Pill (`#status-stage`):**
   Resolves the active tab ID via `space?.tabs?.find(t => t.active)?.id` and reads `shared("mesh.flows")?.[tabId]?.stage` (defaulting to `"plan"`), mapping stage keys to labels:
   - `plan` -> `1. Plan`
   - `build` -> `2. Build`
   - `review` -> `3. Review`
   - `test` -> `4. Test`
   - `pr_dev` -> `5. PR → dev`
   - `promote` -> `6. CI → main`
4. **Live Test Alert Pill (`#status-test-alert`):**
   Matches `shared("mesh.testAlert")` against the active `tabId` (or active workspace root when `tabId` is absent on either side). Renders status and theme color:
   - `running` (`status === "running"` or `running > 0`): `Test: running (passed/total)` in `t.working`.
   - `failed` (`status === "failed"` or `failed > 0`): `Test: N failed` in `t.ansi1` with `alert.svg`.
   - `passed`: `Test: X/Y passed` in `t.ansi2` with `check.svg`.
   - `plan_ready`: `Test: plan ready (N)` in `t.accent` with `check.svg`.
   Clicking navigates directly to `#test` (`layout.select` + `layout.show`).
5. **Ship / PR Alert Pill (`#status-ship-alert`):**
   Aggregates open PR entries (`state === "OPEN"` or omitted) from `shared("mesh.flows")?.[tabId]?.prs`: counts total open PRs, PRs with `checksStatus === "FAILING"`, and total `unresolvedCount` review comments. Renders when `totalPrs > 0 || failingCount > 0 || unresolvedCount > 0` (e.g., `PRs: 2 · 3 comments`), highlighted in `t.ansi1` when CI checks are failing, `t.blocked` when unresolved comments exist, or `t.muted` otherwise. Clicking opens `#ship` (`layout.select` + `layout.show`).
6. **Agent Counters (`#status-agents`):**
   Displays `${agents().length} agents` with status dot (`t.blocked`, `t.working`, or `t.dim`) and appends `· ${needs} needs you` in `t.blocked` when any agent reports `status === "blocked"`.
7. **Command Palette Trigger (`#palette`):**
   Resolves the global `app.palette` binding from `keys()` formatted for the active `window().platform` (`⌘`/`⌃`/`⇧`/`⌥` on macOS, `Ctrl+`/`Shift+`/`Alt+` on Linux/Windows) and invokes `run("app.palette")` on click.

## Shared Bus Contracts

| Key | Role | Expected Shape |
| :--- | :--- | :--- |
| `mesh.services` | Consumer | `{ workspaceRoot?: string, services: Array<{ id, name, relPath, root, workingCount?, dirty? }> }` |
| `mesh.flows` | Consumer | `Record<tabId, { stage?: FlowStage, prs?: Record<string, { state?, checksStatus?, unresolvedCount? }> }>` |
| `mesh.testAlert` | Consumer | `{ tabId?: string, workspaceRoot?: string, status: "plan_ready" \| "running" \| "passed" \| "failed", total?: number, passed?: number, failed?: number, running?: number, summary?: string }` |

## Invariants

1. **Zero `localStorage` Invariant:**
   `mods/mesh-status` contains zero `localStorage` references and persists no local state.
2. **Pure GPUI-Kit & Dynamic Theme Tokens:**
   All visual nodes use `gpui-kit` / `gpui-base` primitives (`View`, `div`, `svg`, `h_flex`) and derive all colors from `theme()` tokens (computing translucent pill backgrounds via alpha-channel adjustments on `theme()` hex values without hardcoded hex literals).
3. **Read-Only Non-Blocking Telemetry:**
   `MeshStatus.render()` performs zero subprocess executions, zero filesystem I/O, and zero `setShared()` mutations, ensuring deterministic frame rendering.
4. **Workspace & Tab Isolation:**
   `mesh.services` entries are gated against the active space folder when present, and `mesh.testAlert` / `mesh.flows` entries match the active tab (with workspace fallback for tabless `testAlert` payloads) to prevent cross-workspace or cross-tab alert leakage.
