---
id: module-layouts
type: module-design
status: active
title: Herdr Mesh Layout Definition (layouts/mesh.json)
parent: architecture
references: [module-mods, submodule-mod-changes-review, submodule-mod-files-search, submodule-mod-git-history, spec-lifecycle]
covers: [layout-tree, panel-stack, workspace-blocks, status-bar]
tags: [layout, herdr, ui-shell, lifecycle]
---

## Responsibility

The `module-layouts` defines the declarative user interface tree for Herdr in `layouts/mesh.json`. It coordinates the top-level spatial arrangement of the desktop application shell, partitioning screen real estate between the global navigation sidebar (`#sidebar`), organic workspace tabs (`#tabs`), primary terminal execution canvas (`#main`), collapsible multi-service side-panel stack (`#panel`), and telemetry status bar (`#status`).

In the `mesh` layout, the shell chrome and side-panel stack bind natively to the 5 active workspace mods (`[[module-mods]]`, `[[spec-lifecycle]]`): `mesh-tabs`, `files-search`, `changes-review`, `git-history`, and `mesh-status`.

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
    - `#main`: Primary terminal pane container.
    - `#panel`: Collapsible auxiliary side drawer.
    - `#panel-body`: Mutually exclusive view stack housing `#files`, `#changes`, and `#git`.
    - `#status`: Bottom telemetry bar (`mod: "mesh-status"`).
  - Command targets:
    - `layout.show --id panel` / `layout.hide --id panel`
    - `layout.select --stack panel-body --child files`
    - `layout.select --stack panel-body --child changes`
    - `layout.select --stack panel-body --child git`
- **Allowed deps:**
  - Core Herdr built-in mods: `workspace-chrome`, `spaces`, `agents`, `pane`.
  - Active Mesh extension mods (`[[module-mods]]`): `[[submodule-mod-mesh-tabs]]`, `[[submodule-mod-files-search]]`, `[[submodule-mod-changes-review]]`, `[[submodule-mod-git-history]]`, `[[submodule-mod-mesh-status]]`.
- **Forbidden:**
  - Renaming child block IDs inside `#panel-body` away from `"files"`, `"changes"`, and `"git"` (breaks `mesh-tabs` drawer toggles and backwards compatibility with Herdr's core `"files"`/`"changes"` toggle handlers).
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
    │           └── git (block, mod: "git-history")
    ├── status (block, height: 28px, mod: "mesh-status")
    └── files-indexer (block, height: 0px, mod: "files-search", props: { role: "indexer" })
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
| `tabs` | `block` | `px: 42` | `mesh-tabs` — workspace tab bar, auto-naming, inline rename, `files`/`changes`/`git` toggles, `mesh.spacePanels` sync, and window drag |
| `work-body` | `row` | Flex remaining | Horizontal split containing main terminal canvas and side drawer |
| `main` | `block` | Flex 1 | Primary active terminal and split panes with rounded corners and focus borders |
| `panel` | `column` | `px: 420` (300-960 bounds) | Collapsible side panel drawer (defaults to `hidden: true`) |
| `panel-body` | `stack` | 100% of panel | Mutually exclusive stack switching between `#files`, `#changes`, and `#git` |
| `files` | `block` | Stack item | Renders `files-search` in docked file-tree mode |
| `changes` | `block` | Stack item | Renders `changes-review` per-service diff, checklist, and `Checks` inspector |
| `git` | `block` | Stack item | Renders `git-history` topological commit graph and per-commit modified files inspector |
| `status` | `block` | `px: 28` | Bottom telemetry bar rendering `mesh-status` |
| `files-indexer` | `block` | `px: 0` | Headless `files-search` (`props.role = "indexer"`) agent-gated workspace file+directory indexer |

## Invariants

1. **Stack Child ID Preservation:**
   The child blocks within `#panel-body` MUST maintain exact IDs `"files"`, `"changes"`, and `"git"`. Preserving `"files"`, `"changes"`, and `"git"` guarantees backwards compatibility with Herdr's core `tabs` toggle contract and `mesh-tabs` panel buttons.
2. **Stack Mutual Exclusion:**
   `#panel-body` MUST remain `type: "stack"`. Only one child view is mounted and rendered at any given moment, conserving rendering cycles and GPU resources.
3. **Zero-Height Headless Indexer Slot:**
   `#files-indexer` (`px: 0`, `mod: "files-search"`, `props: { role: "indexer" }`) MUST stay visible in layout terms (`hidden` omitted) so the agent-gated workspace indexer runs even while `#panel` starts collapsed (`hidden: true`).
4. **Pane Header and Frame Contract:**
   The `#main` block MUST declare `lone: true` and retain its header configuration targeting the `pane` mod (`reveal: "always"`, `height: 30`) to render terminal breadcrumbs, close buttons, and process status indicators across agent and service-runner splits.
5. **Frameless Drag Compliance:**
   `titlebar: "none"` requires that `#brand` and `#tabs` specify `"window_drag": true`, ensuring smooth window movement across Linux/Wayland, X11, Windows, and macOS compositors without native decoration borders.
