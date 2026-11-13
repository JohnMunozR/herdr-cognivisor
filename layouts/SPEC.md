---
id: module-layouts
type: module-design
status: active
title: Herdr Mesh Layout Definition (layouts/mesh.json)
parent: architecture
references: [module-mods, submodule-mod-changes-review, submodule-mod-files-search, spec-lifecycle]
covers: [layout-tree, panel-stack, workspace-blocks, lifecycle-flow-bar, status-bar]
tags: [layout, herdr, ui-shell, lifecycle]
---

## Responsibility

The `module-layouts` defines the declarative user interface tree for Herdr in `layouts/mesh.json`. It coordinates the top-level spatial arrangement of the desktop application shell, partitioning screen real estate between the global navigation sidebar (`#sidebar`), organic workspace tabs (`#tabs`), tab-scoped 6-stage lifecycle bar (`#flow`), primary terminal execution canvas (`#main`), collapsible multi-stage side-panel stack (`#panel`), and lifecycle status bar (`#status`).

In the `mesh` layout, the shell chrome and side-panel stack bind natively to the complete Agent IDE Lifecycle suite (`[[module-mods]]`, `[[spec-lifecycle]]`): `mesh-tabs`, `mesh-flow`, `files-search`, `changes-review`, `mesh-test`, `mesh-ship`, and `mesh-status`.

## Boundary

- **Owns:**
  - Layout schema file: `layouts/mesh.json`.
  - Spatial topology and hierarchy of rows, columns, stacks, and leaf blocks.
  - Declarative bindings between layout block IDs and mesh mod identifiers.
- **Public surface:**
  - Layout name: `mesh` (activated via `herdr-app do layout.switch '{"name":"mesh"}'`).
  - Controllable element IDs:
    - `#sidebar`: Collapsible left navigation drawer.
    - `#tabs`: Top workspace tab strip (`mod: "mesh-tabs"`).
    - `#flow`: 38px 6-stage tab-scoped pipeline bar (`mod: "mesh-flow"`) mounted directly above `#work-body`.
    - `#main`: Primary terminal pane container.
    - `#panel`: Collapsible auxiliary side drawer.
    - `#panel-body`: Mutually exclusive view stack housing `#files`, `#changes`, `#test`, and `#ship`.
    - `#status`: Bottom lifecycle telemetry bar (`mod: "mesh-status"`).
  - Command targets:
    - `layout.show --id panel` / `layout.hide --id panel`
    - `layout.select --stack panel-body --child files`
    - `layout.select --stack panel-body --child changes`
    - `layout.select --stack panel-body --child test`
    - `layout.select --stack panel-body --child ship`
- **Allowed deps:**
  - Core Herdr built-in mods: `workspace-chrome`, `spaces`, `agents`, `pane`.
  - Mesh extension mods (`[[module-mods]]`): `mesh-tabs`, `mesh-flow`, `[[submodule-mod-files-search]]`, `[[submodule-mod-changes-review]]`, `mesh-test`, `mesh-ship`, `mesh-status`.
- **Forbidden:**
  - Renaming child block IDs inside `#panel-body` away from `"files"`, `"changes"`, `"test"`, and `"ship"` (breaks `mesh-flow` stage coupling, `mesh-tabs` drawer toggles, and backwards compatibility with Herdr's core `"files"`/`"changes"` toggle handlers).
  - Removing `"window_drag": true` from `#brand` or `#tabs` (breaks window moving on frameless window managers).
  - Mutating Herdr's shipped immutable layouts (`main.json`, `terminals.json`, `win98.json`).
  - Hardcoding absolute window coordinates or breaking responsive flex layouts.

## Block Hierarchy

The layout tree forms a strict nested structure:

```text
root (row)
├── sidebar (column, width: 268px, chrome background)
│   ├── brand (block, height: 46px, mod: workspace-chrome, window_drag)
│   ├── sidebar-lists (column, flex)
│   │   ├── spaces (block, weight: 1, min: 90px, mod: spaces)
│   │   └── agents (block, weight: 1, min: 90px, mod: agents)
│   └── sidebar-footer (block, height: 69px, mod: workspace-chrome)
└── work (column, flex)
    ├── tabs (block, height: 42px, mod: "mesh-tabs", window_drag)
    ├── work-body (row, flex, padding: 8px, gap: 8px)
    │   ├── main (block, flex, tab: active, pane container)
    │   └── panel (column, width: 420px, min: 300px, max: 960px, hidden: true)
    │       └── panel-body (stack, active: "files")
    │           ├── files (block, mod: "files-search")
    │           ├── changes (block, mod: "changes-review")
    │           ├── test (block, mod: "mesh-test")
    │           └── ship (block, mod: "mesh-ship")
    └── status (block, height: 28px, mod: "mesh-status")
```

### Detailed Component Roles

| Block ID | Container Type | Dimensions | Attached Mod / Role |
| :--- | :--- | :--- | :--- |
| `root` | `row` | Full window | Top-level canvas container with traffic light offsets `[12, 16]` |
| `sidebar` | `column` | `px: 268` (44-480 bounds) | Host for workspace switcher, agent roster, and system controls |
| `brand` | `block` | `px: 46` | Application brand icon and draggable title region |
| `spaces` | `block` | `weight: 1`, `min: 90` | Active workspace list and space switcher |
| `agents` | `block` | `weight: 1`, `min: 90` | Active subagent roster, status indicators, and process monitors |
| `sidebar-footer` | `block` | `px: 69` | Preferences, layout switchers, and profile status |
| `tabs` | `block` | `px: 42` | `mesh-tabs` — workspace tab bar, auto-naming, inline rename, `files`/`changes`/`test`/`ship` toggles, `mesh.spacePanels` sync, and window drag |
| `work-body` | `row` | Flex remaining | Horizontal split containing main terminal canvas and side drawer |
| `main` | `block` | Flex 1 | Primary active terminal and service-runner split panes with rounded corners and focus borders |
| `panel` | `column` | `px: 420` (300-960 bounds) | Collapsible side panel drawer (defaults to `hidden: true`) |
| `panel-body` | `stack` | 100% of panel | Mutually exclusive stack switching between `#files`, `#changes`, `#test`, and `#ship` |
| `files` | `block` | Stack item | Renders `files-search` in docked file-tree mode |
| `changes` | `block` | Stack item | Renders `changes-review` per-service diff, checklist, and `Checks` inspector |
| `test` | `block` | Stack item | Renders `mesh-test` live test plan, `ss -tln` ports, `+ Service Runner`, and Playwright PNGs |
| `ship` | `block` | Stack item | Renders `mesh-ship` PR template editor, live `gh` PR monitoring, and branch promotion |
| `status` | `block` | `px: 28` | Bottom telemetry bar rendering `mesh-status` |

## Invariants

1. **Stack Child ID Preservation:**
   The child blocks within `#panel-body` MUST maintain exact IDs `"files"`, `"changes"`, `"test"`, and `"ship"`. Preserving `"files"` and `"changes"` guarantees backwards compatibility with Herdr's core `tabs` toggle contract, while `"test"` and `"ship"` bind `mesh-flow` stage selection (`test`, `pr_dev`, `promote`) and `mesh-tabs` panel buttons.
2. **Stack Mutual Exclusion:**
   `#panel-body` MUST remain `type: "stack"`. Only one child view is mounted and rendered at any given moment, conserving rendering cycles and GPU resources.
3. **Flow Bar Placement Above `#work-body`:**
   `#flow` (`38px`, `mod: "mesh-flow"`) MUST sit inside `#work` immediately between `#tabs` and `#work-body` so stage navigation remains visible across tab switches even when `#panel` is collapsed.
4. **Pane Header and Frame Contract:**
   The `#main` block MUST declare `lone: true` and retain its header configuration targeting the `pane` mod (`reveal: "always"`, `height: 30`) to render terminal breadcrumbs, close buttons, and process status indicators across agent and service-runner splits.
5. **Frameless Drag Compliance:**
   `titlebar: "none"` requires that `#brand` and `#tabs` specify `"window_drag": true`, ensuring smooth window movement across Linux/Wayland, X11, Windows, and macOS compositors without native decoration borders.
