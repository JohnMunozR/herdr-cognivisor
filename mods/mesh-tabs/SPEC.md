---
id: submodule-mod-mesh-tabs
type: submodule-design
status: active
title: Mesh Tabs Mod (mods/mesh-tabs)
parent: module-mods
references: [module-layouts, submodule-mod-mesh-flow]
covers: [four-panel-switcher, space-panel-persistence, organic-tab-auto-naming, tab-stage-badges]
tags: [mod, tabs, navigation, auto-naming]
---

## Responsibility

The `submodule-mod-mesh-tabs` implements the top 42px workspace tab strip (`#tabs`) for `layouts/mesh.json` (`[[module-layouts]]`, `[[module-mods]]`). Cloned and evolved from Herdr's core `tabs` view, it preserves native Herdr window dragging, macOS traffic-light padding, Windows/Linux window buttons, tab selection/drag-reordering, right-click tab context menus, and `+` new-menu creation while adding four Agent IDE capabilities:

1. **Four-Panel Switcher:** Top-right toggle buttons for `#panel-body` stack children (`files` -> `Files`, `changes` -> `Review`, `test` -> `Test`, `ship` -> `Ship`).
2. **Space Panel Persistence (`mesh.spacePanels`):** Zero-`localStorage` per-space panel memory stored on Herdr's persisted reactive bus (`shared("mesh.spacePanels")`).
3. **Organic Tab Auto-Naming:** Non-blocking, cooldown-throttled detection of generic/unnamed agent tabs using `hc get` / `hc read` and lock-free `git rev-parse --abbrev-ref HEAD` to derive concise Jira-key + prompt/branch titles via `run("tab.rename")`.
4. **Inline Rename & Stage Mini-Badges:** Double-click inline `Input` renaming inside the tab pill (`Enter` saves with `manualTitle: true`, `Esc` cancels) and compact stage badges (`Plan`, `Build`, `Rev`, `Test`, `PR`, `CI`) read from `shared("mesh.flows")`.

## Boundary

- **Owns:**
  - Manifest: `mods/mesh-tabs/mod.json` (`{ "place": "none", "title": "Mesh Tabs" }`).
  - View implementation: `mods/mesh-tabs/main.js` (`MeshTabs` view).
  - Self-contained SVG icon assets: `mods/mesh-tabs/icons/*.svg` (`files.svg`, `changes.svg`, `test.svg`, `ship.svg`, `close.svg`, `spinner.svg`, `win-min.svg`, `win-max.svg`, `win-restore.svg`, `win-close.svg`).
- **Public surface:**
  - Registered mod identifier: `mesh-tabs`.
  - Layout slot: `#tabs` (`42px`, `window_drag: true`) in `layouts/mesh.json`.
  - Shared state channels:
    - Reads/writes `mesh.spacePanels`: `Record<spaceId, "files" | "changes" | "test" | "ship" | null>`.
    - Reads/writes `mesh.flows`: `Record<tabId, MeshFlowTabState>` (`stage`, `ticket`, `derivedTitle`, `autoNamed`, `manualTitle`, `leadTerminal`, `reviewedServices`, `updatedAt`).
    - Always enables all four `#panel-body` module toggles (`["files", "changes", "test", "ship"]`).
  - Herdr command invocations: `tab.select`, `tab.move`, `tab.close`, `tab.rename`, `tab.next`, `tab.prev`, `layout.select`, `layout.show`, `layout.hide`, `window.minimize`, `window.maximize`, `window.close`.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`, `image`.
  - `gpui-base`: `h_flex`, `ScrollHandle`, `InputState`, `Input`.
  - `herdr`: `spaces`, `panes`, `terminals`, `exec`, `hc`, `run`, `openOverlay`, `theme`, `window`, `shared`, `setShared`, `layout`, `settings`.
- **Forbidden:**
  - Any reference to browser `localStorage` or `window.localStorage` (`[[architecture]]`).
  - Read-only `git` executions without `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`.
  - Overwriting user-named tabs (`tab.named === true` or `mesh.flows[tabId].manualTitle === true`).
  - Targeting auxiliary `+ Service Runner` split panes (`labels.meshRunner === "true"`) during auto-naming probes.
  - Referencing external core mod icon paths instead of self-contained `mods/mesh-tabs/icons/*.svg` assets (except dynamic `program.icon` entries managed by Herdr core).

## Architecture & Interaction Flow

```text
+---------------------------------------------------------------------------------------------------+
| [lightsPad] [icon Title [Rev] ● x] [icon PROJ-412 · Checkout [Build] ⟳] [+] | Files Review Test Ship [− □ x] |
+---------------------------------------------------------------------------------------------------+
                  │                                                                 │
                  ├─ Double-click -> Input.new(renameInput)                         ├─ Toggle -> layout.select + show/hide #panel
                  │    Enter -> run("tab.rename") + manualTitle: true               └─ syncPanel() <-> shared("mesh.spacePanels")
                  │    Esc / Blur -> cancel inline edit
                  └─ Unnamed generic tab -> probeCache (3000ms cooldown)
                       └─ hc get / hc read + lock-free git branch -> run("tab.rename") + mesh.flows[tabId]
```

### Space Panel Persistence (`syncPanel`)

- Reads `shared("mesh.spacePanels")` (`Record<spaceId, panelId | null>`) and compares against current `#panel` visibility and `#panel-body` active child.
- On space change (`space.id !== this.space`), restores the target space's stored panel choice (validated against `enabled` panels) and installs a `1000ms` `pending = { want, until }` transition guard so transient `layout()` states do not overwrite stored choices.
- Writes `setShared("mesh.spacePanels", ...)` only when the resolved `now` state differs from the stored value for `space.id`.

### Organic Tab Auto-Naming Pipeline

1. **Eligibility:** Evaluates tabs where `!tab.named`, `flow.manualTitle !== true`, `flow.autoNamed !== true`, and `tab.name` matches generic patterns (`/^tb\d+$/`, `/^\d+$/`, `"Terminal"`, or `program?.name`).
2. **Lead Terminal Resolution:** Resolves `flow.leadTerminal` or the first pane in `panes()` for `tab.id` preferring `program.agent` and excluding panes/terminals labeled `meshRunner === "true"`.
3. **Cooldown & Interaction Gate:** Enforces a `3000ms` per-`(tabId, terminalId)` cooldown in `this.probeCache`. Queries `hc(["get", terminal, "--json"])` and proceeds only once the user has interacted (`first_message`, `turn > 0`, or active status `"working" | "done" | "blocked"`).
4. **Prompt & Branch Signal Gathering:**
   - When `first_message` is absent, runs `hc(["read", "--lines", "40", terminal])` and extracts the first non-boilerplate prompt line (`>`, `❯`, `›`, `User:`, shell quoted task, or first clean text line).
   - Queries `git --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false rev-parse --abbrev-ref HEAD` in `foreground.cwd || leadPane.cwd || space.folder`.
5. **Title Composition & Recording:**
   - Extracts Jira key via `/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/` from `first_message`, `promptLine`, `title`, `branch`, or `status.msg`.
   - Strips greetings/filler phrases and punctuation, collapsing whitespace and trimming cleanly to ~28 characters.
   - Composes `${ticket} · ${summary}`, `${ticket} · ${branchSlug}`, `${ticket}`, `${summary}`, or `${branchSlug}`, verifies the result is non-generic, re-checks post-`await` tab/manual state, invokes `run("tab.rename", { id, name })`, and updates `mesh.flows[tabId]`.

## Invariants

1. **Zero `localStorage` Invariant:** All per-space panel persistence flows through `shared("mesh.spacePanels")` and `setShared("mesh.spacePanels", ...)`.
2. **Manual Title Sovereignty:** Tabs with `tab.named === true` or `mesh.flows[tabId].manualTitle === true` are never altered by background auto-naming.
3. **Lock-Free Git Inspection:** Every Git branch lookup prepends `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` and uses a bounded `4000ms` timeout.
4. **Probe Rate Bounding:** Auto-naming caches attempts in `this.probeCache` with a minimum `3000ms` cooldown per `(tabId, terminalId)` and halts probing once `autoNamed`, `manualTitle`, or `tab.named` is true.
5. **Self-Contained Assets:** All panel, tab-close, spinner, and window-control SVGs resolve inside `mods/mesh-tabs/icons/`.
