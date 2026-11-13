---
id: module-mods
type: module-design
status: active
title: Herdr Mesh Mods Suite
parent: architecture
references: [module-layouts, spec-lifecycle]
covers: [gpui-kit-views, mod-manifests, shared-state-contracts, zero-localstorage, session-scoped-multi-repo]
tags: [mods, gpui-kit, herdr, lifecycle]
---

## Responsibility

The `module-mods` encapsulates the suite of interactive GPUI extensions operating within the Herdr desktop application runtime (`gpui-shell 0.7.x`). Together with `[[module-layouts]]` and `[[spec-lifecycle]]`, the mods suite transforms Herdr's terminal workspace into a multi-microservice Agent IDE: organic tab auto-naming (`mesh-tabs`), workspace-wide navigation (`files-search`), session-scoped microservice code review (`changes-review`), and bottom telemetry (`mesh-status`).

Mods run as QuickJS JavaScript modules utilizing `gpui-kit` and `gpui-base` declarative components and interface with Herdr's native Rust core via the `herdr` host module.

## Boundary

- **Owns:**
  - Active mod packages under `mods/*` (`files-search`, `changes-review`, `mesh-tabs`, `mesh-status`; legacy `mods/mesh-flow` excluded from `layouts/mesh.json` and cleaned up on install).
  - Manifest definitions (`mod.json`) and mod registration schemas.
  - Mod view components (`main.js`) and intra-mod pure logic modules (`indexer.js`, `search-logic.js`, `tree-logic.js`, `review-logic.js`, `tab-logic.js`).
  - Shared state event namespaces (`mesh.*`, `files-search.*`, `changes-review.*`) and cross-mod protocol contracts.
- **Public surface:**
  - Active mod directories installed into `$HERDR_APP_HOME/mods/`:
    - `mods/files-search`: Docked session-scoped multi-repo file tree and floating Search Everywhere overlay.
    - `mods/changes-review`: Per-service Git branch/diff inspector, tab-scoped review checklist (`Approve Service ✓`), and `leadTerminal`-prioritized agent dispatch.
    - `mods/mesh-tabs`: Workspace tab strip with organic Jira/prompt auto-naming, 1-click inline rename, 2-panel drawer toggles (`Files`, `Review`), and `mesh.spacePanels` persistence.
    - `mods/mesh-status`: Bottom status bar displaying host machine, multi-service/dirty counts, active branch, agent activity, and palette trigger.
  - Mod command endpoints:
    - `mod.open:files-search` (bound to `Ctrl+P` / `Alt+F`).
    - `layout.select --stack panel-body --child files|changes`.
  - Reactive shared state channels:
    - `files-search.select`, `files-search.customSize`
    - `changes-review.activeDiff`
    - `mesh.services`, `mesh.activeService`, `mesh.flows`, `mesh.spacePanels`, `mesh.spaceAgentTabs`, `mesh.openFileTabs`, `mesh.reviewNotes`
- **Allowed deps:**
  - `gpui-kit` primitives: `View`, `div`, `svg`, `image`, `list`.
  - `gpui-base` widgets: `v_flex`, `h_flex`, `Input`, `InputState`, `Textarea`, `TextareaState`, `Scrollbar`, `ScrollHandle`.
  - `herdr` host APIs: `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `notify`, `hc`, `run`, `layout`, `shared`, `setShared`, `props`, `openOverlay`, `closeOverlay`, `window`, `keys`.
- **Forbidden:**
  - Any usage of browser `localStorage` across `herdr-mesh` mods (persist via `shared()`/`setShared()`).
  - Calling `cx.notify()`, `setShared()`, or mutating input widget values synchronously during `render()`.
  - Spawning blocking synchronous loops in the JS thread or uncancelled `rg` / `exec` polling loops.
  - Invoking read-only Git operations without lock-free flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
  - Hardcoded color hex strings ignoring `theme()`, `settings()`, or `layout()`.

## Internal & Planned Submodules

| Submodule | Owns | Status / Spec |
| :--- | :--- | :--- |
| `submodule-mod-files-search` | Dual-mode file tree panel and floating Search Everywhere overlay (`files-search-win`) with ripgrep live search and shared file selection | Active (`[[submodule-mod-files-search]]`) |
| `submodule-mod-changes-review` | Multi-repo Git diff viewer, per-service branch/checklist (`Approve Service ✓`), inline notes, and `leadTerminal` dispatch | Active (`[[submodule-mod-changes-review]]`, extended by `[[spec-lifecycle]]`) |
| `submodule-mod-mesh-tabs` | Tab strip, generic-name detection, Jira/prompt/branch auto-naming, inline rename, `Files`/`Review` toggles, and `mesh.spacePanels` sync | Active (`[[submodule-mod-mesh-tabs]]`) |
| `submodule-mod-mesh-status` | 28px `#status` telemetry bar rendering machine, service/dirty count, active branch, agents, and palette hint | Active (`[[submodule-mod-mesh-status]]`) |

## Inter-Mod Communication & Shared State

All mods communicate solely through Herdr's persisted reactive bus (`shared()` / `setShared()`) without cross-mod closure mutation (`[[architecture]]`, `[[spec-lifecycle]]`):

```text
+--------------------+     mesh.flows[tabId]      +---------------------+
| mesh-tabs          | -------------------------> | changes-review      |
| (#tabs 42px)       |   leadTerminal,            | (#changes panel)    |
|                    |   reviewedServices,        |                     |
|                    |   sessionRepos             |                     |
+--------------------+                            +---------------------+
         ^                                                  |
         | mesh.spacePanels (zero localStorage)             | mesh.services /
         v                                                  v mesh.activeService
+--------------------+     shared() reactive bus  +---------------------+
| layouts/mesh.json  | <------------------------> | files-search        |
| (#panel-body)      |     mesh.services / sig    | mesh-status         |
+--------------------+                            +---------------------+
```

### Bus Channels Summary

- **`files-search.select` & `files-search.customSize`**: Tree directory/file reveal coordination `{ root, kind: "dir" | "reveal", path, line, ts }` and overlay geometry persistence `{ w, h }`.
- **`mesh.openFileTabs` & `mesh.spaceAgentTabs`**: Per-tab non-terminal File Viewer metadata `{ tabId, spaceId, viewerId, root, path, absPath, displayPath, iconPath, iconColor, line, ... }` (for deduplication and tab-bar file icons) plus per-space active terminal/agent tab anchors `Record<spaceId, tabId>`.
- **`changes-review.activeDiff` & `mesh.reviewNotes`**: Per-space reusable Review tab state `{ spaceId, sourceTabId, openFileKey, openFile, files, services, viewMode, selectedCommit, requestSeq, focusLine, openCommentLine, ... }` and synchronized inline review notes keyed by `${spaceId}::${sourceTabId}`.
- **`mesh.services` & `mesh.activeService`**: Discovered session-scoped microservice repository list (`{ tabId, workspaceRoot, on, services, candidates, sig, ts }`) published when `sig` changes or heartbeat refreshes, plus synchronized active filter (`"all"` or `serviceId` with monotonic `ts`).
- **`mesh.flows`**: Tab-scoped metadata keyed by `tabId` holding `ticket`, `derivedTitle`, `autoNamed`, `manualTitle`, `leadTerminal`, `reviewedServices` (`pending | has_notes | approved`), `sessionRepos`, and `updatedAt`.
- **`mesh.spacePanels`**: Persisted `Record<spaceId, "files" | "changes" | null>` replacing `localStorage` in `mesh-tabs`.

### Agent Dispatch Priority (`hc send`)

- **Lead Agent Priority:** `changes-review` targets `mesh.flows[tabId].leadTerminal` first via `await hc(["send", agentAddress, message])` so auxiliary split panes (`labels.meshRunner === "true"`) never intercept agent prompts; failures surface via `notify()`.
