---
id: submodule-mod-files-search
type: submodule-design
status: active
title: Files & Search Everywhere Mod (mods/files-search)
parent: module-mods
references: [module-layouts]
covers: [file-tree-panel, search-everywhere-overlay, ripgrep-live-search, shared-file-selection, multi-repo-git-status, service-quick-filter, cross-service-search]
tags: [mod, files, search, overlay]
---

## Responsibility

The `submodule-mod-files-search` delivers workspace file tree navigation and ripgrep-powered fuzzy search for Herdr. It operates polymorphically in two distinct UI modes depending on instantiation context:

1. **Docked File Tree Panel:** Renders within the `#files` slot of `#panel-body`, displaying a collapsible directory tree of the active workspace, file badges, and selection states.
2. **Search Everywhere Overlay:** Renders as a floating, frameless modal window (`files-search-win`) triggered globally via `Ctrl+P` or `Alt+F`. It supports searching files by name, full-text searching across source code with ripgrep, live code preview, and keyboard-centric selection.

## Boundary

- **Owns:**
  - Manifest file: `mods/files-search/mod.json` (identifies as `files-search`, cloned from `files` v0.1.13, overlay key `files-search-win`).
  - Main component: `mods/files-search/main.js`.
  - Icon assets: `mods/files-search/*.svg` (`file.svg`, `folder.svg`, `search.svg`, `preview.svg`, `grip.svg`, etc.).
  - Type definitions and config: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `files-search`.
  - Layout slot: `#panel-body` child `files` in `layouts/mesh.json`.
  - Window overlay key: `files-search-win`.
  - Global shortcuts registered in `keys.json`:
    - `ctrl-p` -> `mod.open:files-search`
    - `alt-f` -> `mod.open:files-search`
  - Shared state event channels:
    - `files-search.select`: `{ root: string, path: string, line: number|null, ts: number }`.
    - `files-search.customSize`: `{ w: number, h: number }`.
    - `mesh.services`: `{ tabId: string|null, workspaceRoot: string, on: string|null, services: Array<...>, candidates: Array<...>, sig: string, ts: number }`.
    - `mesh.activeService`: `{ workspaceRoot: string, serviceId: string, ts: number }`.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`, `TextareaState`, `Textarea`, `Scrollbar`.
  - `herdr`: `spaces`, `panes`, `focused`, `agents`, `hc`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `window`, `layout`, `props`, `openOverlay`, `closeOverlay`, `shared`, `setShared`.
- **Forbidden:**
  - Running synchronous file operations or unbounded recursive disk scans on the main thread.
  - Spawning uncancelled `ripgrep` subprocesses on every keystroke or reloading expanded folders while the `#files` panel is hidden.
  - Calling `cx.notify()` or mutating shared/panel state synchronously during `renderPanel()` (deferred via `schedulePanelSync` using `cx.timer.after(0, ...)`).
  - Retaining overlay resources, focus timers, or background tasks after window destruction.

## Dual-Mode Architecture

The mod detects its operational mode during initialization via `props()`:

```text
                        +----------------------+
                        |   FilesSearch.init   |
                        +----------+-----------+
                                   |
                  Boolean(props()?.overlay) ?
                                  / \
                                 /   \
                             YES/     \NO
                               /       \
                              v         v
           +--------------------+     +--------------------+
           |    initOverlay     |     |     initPanel      |
           | (files-search-win) |     |  (Docked #files)   |
           +--------------------+     +--------------------+
```

### 1. Docked Panel Mode (`isOverlay: false`)
- **Workspace Root Anchoring (`location().cwd`):** Tracks the workspace directory using `space.folder` as the primary anchor whenever the focused pane's `cwd` resides within `space.folder` (`pane.cwd === space.folder || pane.cwd.startsWith(space.folder + "/")` or Windows `\`). This guarantees that terminal `cd` into microservice subfolders does not shrink the file tree or search scope.
- **Session-Scoped Multi-Repository Discovery (`discoverRepos`, `attributeSessionServices`):** Discovers Git repositories under `workspaceRoot` up to depth 2 (plus parent siblings when `workspaceRoot` is itself a repo and extra active-tab `pane.cwd` paths) using native async `fs/promises` scans locally (`fsScanRepos`) and POSIX/PowerShell over SSH (`on`), cached for `REPO_CACHE_TTL_MS = 60000`. Executes lock-free `git status --porcelain=v1 -b -z --no-renames --untracked-files=normal` in parallel, attributes touched repositories to the active tab session via `mesh.flows[tabId].sessionRepos`, and publishes `mesh.services` with a `sig` change key (`45s` heartbeat) so `changes-review` reuses results cleanly.
- **Folder Modification Counters & Badges:**
  - Aggregates file modification marks (`marks`: `fullPath -> "A" | "M" | "D" | "U"`).
  - Computes ancestor directory modification counters (`dirCounts` / `dirMarks`: `dirFullPath -> count`).
  - Folder rows display a compact modification counter badge on the right when changes exist inside that subtree (`dirCounts[fullPath] > 0`).
  - Discovered session Git repository roots render a distinct `repo` pill next to the folder name, distinguishing touched microservices within the tree.
- **Service Quick-Jump / Filter Bar:**
  - Rendered below the `Files` header when multiple services are attributed (`this.services.length > 1`) and no single file preview is active.
  - Contains an `All` pill and a pill for each attributed service displaying its name and pending change count badge.
  - Clicking a service pill toggles `this.serviceFilter`, automatically expands the service's relative path in `this.folders` (fetching unloaded directory entries), scopes visible top-level tree rows to that service's subtree, and broadcasts `setShared("mesh.activeService", { workspaceRoot, serviceId, ts })`.
  - Listens to `shared("mesh.activeService")` (using timestamp check `ts > this.lastActiveServiceTs`) inside a deferred `schedulePanelSync(cx)` callback to synchronize active service selection from sibling mods like `changes-review` without triggering re-entrant event loops.
- **Debounced Watching & Hidden-Panel Throttling:** Sets up non-blocking directory observers using `watchFolder(root)`, debouncing `750ms` and filtering build/dependency churn (`node_modules`, `target`, `.git` internal locks) via `analyzeWatchBatch`, incrementally reloading only dirty expanded folders. Skips folder listings and halves background polling intervals to `60000ms` when `#files` is hidden (`isFilesVisible()`), reloading via `needsFolderReloadOnShow` on show.
- Renders hierarchical tree nodes with lazy folder expansion and caching.
- Listens to `shared("files-search.select")`: When a file is selected from the overlay search, unpacks the file path, expands all ancestor directories, scrolls the file into view, and highlights it. If the target file resides outside the active `serviceFilter`, resets `serviceFilter` to `"all"`. Prepend any relative root prefix if the selection payload root differs from the panel root.

### 2. Search Everywhere Overlay Mode (`isOverlay: true`)
- **Workspace-Wide Root Resolution:** Resolves search root via `props().root || shared("mesh.services")?.workspaceRoot || location().cwd`.
- **IntelliJ-Style Floating Dialog with Segmented Category Tabs:**
  - **All:** Combined filename and content matches.
  - **Files:** Rapid in-memory fuzzy matching against workspace file lists (`rg --files --path-separator /`, `git ls-files`, `mesh.services.candidates`, or native `fsListFiles` fallback locally / POSIX `find` remotely).
  - **Text:** Asynchronous live search executing `rg --vimgrep --path-separator / --max-count=8` (handling `code === 1` empty matches without fallback, retrying regex-syntax `code === 2` with `-F`, and falling back to parallel `git grep -F` across `candidates` only when `rg` is missing/broken), normalizing Windows backslashes cleanly.
- **Microservice Prefix Badges:** When the workspace contains multiple microservices (`mesh.services.services.length > 1`), search result rows display a distinctive badge identifying the microservice to which each matched file or text line belongs.
- Features an optional live code preview pane with viewport-clamped column widths (never overflowing down to `winW = 860`) that reads file chunks via `readFileChunk` and centers on matching line numbers.
- Allows resizing via grip controls, persisting geometry across sessions via `setShared("files-search.customSize", ...)`.

## Invariants

1. **Subprocess Throttling and Cancellation:**
   Entering characters into the search field triggers a debounced search task. Any previously running `textSearchTask` MUST be cancelled via `this.textSearchTask?.cancel()` before launching a subsequent query, guaranteeing that slow subprocesses do not overwrite newer results.
2. **Lock-Free Multi-Repository Git Operations:**
   Every read-only Git status, diff, ls-files, or grep command executed across discovered services MUST supply `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` to prevent touching `.git/index.lock` or tripping filesystem watchers.
3. **Workspace Root Stability:**
   Terminal navigation into subdirectories or microservices must never mutate or truncate the panel's root file tree or search scope. Root resolution strictly anchors to `space.folder` when available.
4. **Non-Reentrant Shared State Synchronization & Pure Render:**
   Shared state listeners (`mesh.activeService`, `files-search.select`) MUST gate incoming events against monotonically increasing timestamps (`ts > this.lastActiveServiceTs`), defer panel mutations outside `renderPanel()`, and never emit reciprocal shared state updates for incoming events.
5. **Deep Path Auto-Expansion:**
   When `openFromSearch(path)` receives a file selected externally, it iteratively builds and adds all intermediate folder paths to `this.folders` before rendering, ensuring the target node is immediately visible in the tree.
6. **Graceful Teardown:**
   Upon overlay close or view release, all background tasks (`focusInputTask`, `watchDebounceTask`, `pendingPanelSyncTask`, `textSearchTask`, `previewDebounceTask`) and allocated resources (`this.input?.release()`, `this.code?.release()`) must be cleanly disposed of.

## Multi-Repo & Mesh Architecture

Herdr Mesh implements a unified multi-repository model where microservices co-exist within an anchored workspace:
- **Unified Multi-Root Search:** Executes federated ripgrep and git search queries across all microservice repositories under the workspace root.
- **Microservice Filtering:** Horizontal service bar and overlay service badges provide immediate visual context and scoped navigation.
- **Shared State Mesh Bus:** Synchronizes active service selection and repository metadata across `files-search`, `changes-review`, and layout containers via `mesh.services` and `mesh.activeService`.
