---
id: submodule-mod-cognivisor-status
type: submodule-design
status: active
title: Cognivisor Status Bar Mod (mods/cognivisor-status)
parent: module-mods
references: [module-layouts]
covers: [workspace-status-bar, agent-counters]
tags: [mod, status-bar, telemetry]
---

## Responsibility

The `submodule-mod-cognivisor-status` provides the bottom `28px` workspace telemetry bar (`#status`) in `layouts/cognivisor.json` (`[[module-layouts]]`). Upgrading Herdr's core `workspace-status` mod, it preserves core host, branch, live agent counters, and command palette controls while surfacing session-attributed multi-service and dirty counts from `shared("cognivisor.services")`.

## Boundary

- **Owns:**
  - Manifest file: `mods/cognivisor-status/mod.json` (`{ "place": "none", "title": "Cognivisor Status" }`).
  - Main view component: `mods/cognivisor-status/main.js` (`CognivisorStatus` extending `View`).
  - Self-contained SVG icon assets: `mods/cognivisor-status/icons/{server,monitor,branch,layers}.svg`.
- **Public surface:**
  - Registered mod identifier: `cognivisor-status`.
  - Layout slot: `#status` (`28px` height) in `layouts/cognivisor.json`.
  - Reactive read-only shared bus consumer:
    - `shared("cognivisor.services")`: Multi-microservice topology and dirty summary.
  - Host command dispatches:
    - Palette click -> `run("app.palette")`.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `h_flex`.
  - `herdr`: `spaces`, `agents`, `theme`, `shared`, `run`, `window`, `keys`.
- **Forbidden:**
  - Any reference to `localStorage`, browser DOM globals, or non-GPUI elements.
  - Hardcoded hex color literals outside dynamic `theme()` tokens.
  - Mutating `cognivisor.*` shared state or spawning subprocesses (`exec`, `hc`) during status bar rendering.
  - Reading or mutating internal closures of sibling mods.

## Architecture & Interaction Flow

```text
+----------------------------------------------------------------------------------------------------------+
| [monitor/server] Machine | [layers] N services · M dirty | [branch] main | [●] 3 agents · 1 needs you     |
|                                                                                     [Ctrl+K  commands]   |
+----------------------------------------------------------------------------------------------------------+
```

### Telemetry Segments

1. **Machine Badge (`#status-machine`):**
   Displays `space?.machine ?? "This computer"` paired with `server.svg` (remote machine) or `monitor.svg` (local host).
2. **Services & Branch Summary (`#status-services`, `#status-branch`):**
   When `shared("cognivisor.services")` matches the active space folder and reports more than 1 service (`services.length > 1`), displays `${services.length} services` (appending `· ${dirtyCount} dirty` when dirty counts are present) with `layers.svg`, alongside `space?.branch` with `branch.svg` when present. When 1 or fewer services exist, falls back to `space?.branch` only.
3. **Agent Counters (`#status-agents`):**
   Displays `${agents().length} agents` with status dot (`t.blocked`, `t.working`, or `t.dim`) and appends `· ${needs} needs you` in `t.blocked` when any agent reports `status === "blocked"`.
4. **Command Palette Trigger (`#palette`):**
   Resolves the global `app.palette` binding from `keys()` formatted for the active `window().platform` (`⌘`/`⌃`/`⇧`/`⌥` on macOS, `Ctrl+`/`Shift+`/`Alt+` on Linux/Windows) and invokes `run("app.palette")` on click.

## Shared Bus Contracts

| Key | Role | Expected Shape |
| :--- | :--- | :--- |
| `cognivisor.services` | Consumer | `{ workspaceRoot?: string, services: Array<{ id, name, relPath, root, workingCount?, dirty? }> }` |

## Invariants

1. **Zero `localStorage` Invariant:**
   `mods/cognivisor-status` contains zero `localStorage` references and persists no local state.
2. **Pure GPUI-Kit & Dynamic Theme Tokens:**
   All visual nodes use `gpui-kit` / `gpui-base` primitives (`View`, `div`, `svg`, `h_flex`) and derive all colors from `theme()` tokens without hardcoded hex literals.
3. **Read-Only Non-Blocking Telemetry:**
   `CognivisorStatus.render()` performs zero subprocess executions, zero filesystem I/O, and zero `setShared()` mutations, ensuring deterministic frame rendering.
4. **Workspace Isolation:**
   `cognivisor.services` entries are gated against the active space folder (normalized across platforms) when present to prevent cross-workspace leakage.
