---
id: submodule-mod-cognivisor-tabs
type: submodule-design
status: active
title: Cognivisor Tabs Mod (mods/cognivisor-tabs)
parent: module-mods
references: [module-layouts]
covers: [three-panel-switcher, space-panel-persistence, organic-tab-auto-naming, inline-tab-rename]
tags: [mod, tabs, navigation, auto-naming]
---

## Responsibility

The `submodule-mod-cognivisor-tabs` implements the top 42px workspace tab strip (`#tabs`) for `layouts/cognivisor.json` (`[[module-layouts]]`, `[[module-mods]]`). Cloned and evolved from Herdr's core `tabs` view, it preserves native Herdr window dragging, macOS traffic-light padding, Windows/Linux window buttons, tab selection/drag-reordering, right-click tab context menus, and `+` new-menu creation while adding three workspace capabilities:

1. **Three-Panel Switcher:** Top-right toggle buttons for `#panel-body` stack children (`files` -> `Files`, `changes` -> `Review`, `git` -> `Git`).
2. **Space Panel Persistence (`cognivisor.spacePanels`):** Zero-`localStorage` per-space panel memory stored on Herdr's persisted reactive bus (`shared("cognivisor.spacePanels")`).
3. **Organic Tab Auto-Naming & Inline Rename:** Non-blocking, cooldown-throttled (`8000ms`) detection of generic/unnamed agent tabs using `hc get` / `hc read` and lock-free `git rev-parse --abbrev-ref HEAD` to derive concise Jira-key + prompt/branch titles via `run("tab.rename")`, plus double-click inline `Input` renaming (`Enter` saves with `manualTitle: true`, `Esc` cancels).

## Boundary

- **Owns:**
  - Manifest: `mods/cognivisor-tabs/mod.json` (`{ "place": "none", "title": "Cognivisor Tabs" }`).
  - View implementation: `mods/cognivisor-tabs/main.js` (`CognivisorTabs` view).
  - Pure tab-naming, panel-target, viewer-tab classification, & lead-pane helpers: `mods/cognivisor-tabs/tab-logic.js`.
  - Synced shared diagnostics modules (`[[module-shared]]`): `mods/cognivisor-tabs/diagnostics-logic.js`, `mods/cognivisor-tabs/diagnostics.js`.
  - Self-contained SVG icon assets: `mods/cognivisor-tabs/icons/*.svg` (`files.svg`, `changes.svg`, `git.svg`, `close.svg`, `spinner.svg`, `win-min.svg`, `win-max.svg`, `win-restore.svg`, `win-close.svg`).
- **Public surface:**
  - Registered mod identifier: `cognivisor-tabs`.
  - Layout slot: `#tabs` (`42px`, `window_drag: true`) in `layouts/cognivisor.json`.
  - Shared state channels:
    - Reads/writes `cognivisor.spacePanels`: `Record<spaceId, "files" | "changes" | "git" | null>`.
    - Reads/writes `cognivisor.flows`: `Record<tabId, CognivisorFlowTabState>` (`ticket`, `derivedTitle`, `autoNamed`, `manualTitle`, `leadTerminal`, `reviewedServices`, `sessionRepos`, `updatedAt`).
    - Reads `cognivisor.openFileTabs`: `Record<tabId, OpenFileTabMeta>` to display semantic file-type icons and path tooltips on non-terminal `files-search` tabs alongside `changes-review` (`changes.svg`) and `git-history` (`git.svg`) viewer tab icons (via `classifyViewerTab` with accent tint) and quick one-click close buttons.
    - Enables `#panel-body` module toggles (`["files", "changes", "git"]`).
  - Herdr command invocations: `tab.select`, `tab.move`, `tab.close`, `tab.rename`, `tab.next`, `tab.prev`, `layout.select`, `layout.show`, `layout.hide`, `window.minimize`, `window.maximize`, `window.close`.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`, `image`.
  - `gpui-base`: `h_flex`, `ScrollHandle`, `InputState`, `Input`.
  - `herdr`: `spaces`, `panes`, `terminals`, `exec`, `hc`, `run`, `openOverlay`, `theme`, `window`, `shared`, `setShared`, `layout`, `settings`.
- **Forbidden:**
  - Any reference to browser `localStorage` or `window.localStorage` (`[[architecture]]`).
  - Read-only `git` executions without `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`.
  - Overwriting user-named tabs (`tab.named === true` or `cognivisor.flows[tabId].manualTitle === true`).
  - Targeting auxiliary runner split panes (`labels.cognivisorRunner === "true"`) during auto-naming probes.
  - Calling `run()`, `setShared()`, or `cx.notify()` synchronously inside `render()` (space-panel sync and newly-seen tab scans defer via `cx.timer.after(0, ...)`).
  - Referencing external core mod icon paths instead of self-contained `mods/cognivisor-tabs/icons/*.svg` assets (except dynamic `program.icon` entries managed by Herdr core and `cognivisor.openFileTabs` `iconPath` entries provided by `files-search`).

## Architecture & Interaction Flow

```text
+---------------------------------------------------------------------------------------------------+
| [lightsPad] [icon Title ● x] [icon PROJ-412 · Checkout ⟳] [+]         | Files Review Git [− □ x] |
+---------------------------------------------------------------------------------------------------+
                  │                                                            │
                  ├─ Double-click -> Input.new(renameInput)                    ├─ Toggle -> layout.select + show/hide #panel
                  │    Enter -> run("tab.rename") + manualTitle: true          └─ scheduleRenderSync() -> syncPanel() <-> shared("cognivisor.spacePanels")
                  │    Esc / Blur -> cancel inline edit
                  └─ Unnamed generic tab -> probeCache (8000ms cooldown)
                       └─ hc get / hc read + lock-free git branch -> run("tab.rename") + cognivisor.flows[tabId]
```

### Space Panel Persistence (`syncPanel`)

- Reads `shared("cognivisor.spacePanels")` (`Record<spaceId, panelId | null>`) and compares against current `#panel` visibility and `#panel-body` active child inside a deferred `cx.timer.after(0, ...)` callback (`scheduleRenderSync`).
- On space change (`space.id !== this.space`), restores the target space's stored panel choice (validated against `enabled` panels) and installs a `1000ms` `pending = { want, until }` transition guard so transient `layout()` states do not overwrite stored choices.
- Writes `setShared("cognivisor.spacePanels", ...)` only when the resolved `now` state differs from the stored value for `space.id`.

### Organic Tab Auto-Naming Pipeline

1. **Eligibility:** Evaluates tabs where `!tab.named`, `flow.manualTitle !== true`, `flow.autoNamed !== true`, and `tab.name` matches generic patterns (`/^tb\d+$/`, `/^\d+$/`, `"Terminal"`, or `program?.name`).
2. **Lead Terminal Resolution:** Resolves `flow.leadTerminal` or the first pane in `panes()` for `tab.id` preferring `program.agent` and excluding panes/terminals labeled `cognivisorRunner === "true"`.
3. **Cooldown & Interaction Gate:** Enforces an `8000ms` per-`(tabId, terminalId)` cooldown in `this.probeCache`. Queries `hc(["get", terminal, "--json"])` and proceeds only once the user has interacted (`first_message`, `turn > 0`, or active status `"working" | "done" | "blocked"`).
4. **Prompt & Branch Signal Gathering:**
   - When `first_message` is absent, runs `hc(["read", "--lines", "40", terminal])` and extracts the first non-boilerplate prompt line (`>`, `❯`, `›`, `User:`, shell quoted task, or first clean text line).
   - Queries `git --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false rev-parse --abbrev-ref HEAD` in `foreground.cwd || leadPane.cwd || space.folder`.
5. **Title Composition & Recording:**
   - Extracts Jira key via `/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/` from `first_message`, `promptLine`, `title`, `branch`, or `status.msg`.
   - Strips greetings/filler phrases and punctuation, collapsing whitespace and trimming cleanly to ~28 characters.
   - Composes `${ticket} · ${summary}`, `${ticket} · ${branchSlug}`, `${ticket}`, `${summary}`, or `${branchSlug}`, verifies the result is non-generic, re-checks post-`await` tab/manual state, invokes `run("tab.rename", { id, name })`, and updates `cognivisor.flows[tabId]`.

## Invariants

1. **Zero `localStorage` Invariant:** All per-space panel persistence flows through `shared("cognivisor.spacePanels")` and `setShared("cognivisor.spacePanels", ...)`.
2. **Manual Title Sovereignty:** Tabs with `tab.named === true` or `cognivisor.flows[tabId].manualTitle === true` are never altered by background auto-naming.
3. **Lock-Free Git Inspection:** Every Git branch lookup prepends `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` and uses a bounded `4000ms` timeout.
4. **Probe Rate Bounding & Clean Teardown:** Auto-naming caches attempts in `this.probeCache` with a minimum `8000ms` cooldown per `(tabId, terminalId)` and halts probing once `autoNamed`, `manualTitle`, or `tab.named` is true; `close()` releases `renameInput` + `scroll` and cancels scheduled tasks (`focusRenameTask`, `pendingPanelSyncTask`, `pendingTabScanTask`).
5. **Self-Contained Assets:** All panel, tab-close, spinner, and window-control SVGs resolve inside `mods/cognivisor-tabs/icons/`.
