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
  - Shared indexing & cache engine: `mods/files-search/indexer.js`.
  - Icon assets: `mods/files-search/*.svg` (`file.svg`, `folder.svg`, `search.svg`, `preview.svg`, `grip.svg`, etc.).
  - Type definitions and config: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `files-search`.
  - Layout slots: `#panel-body` child `files` (docked panel) and `#work` 0px headless slot `files-indexer` (`props: { role: "indexer" }`) in `layouts/mesh.json`.
  - Window overlay key: `files-search-win`.
  - Global shortcuts registered in `keys.json`:
    - `ctrl-p` -> `mod.open:files-search`
    - `alt-f` -> `mod.open:files-search`
  - Shared state event channels:
    - `files-search.select`: `{ root: string, kind: "file"|"dir", path: string, line: number|null, ts: number }`.
    - `files-search.customSize`: `{ w: number, h: number }`.
    - `mesh.services`: `{ tabId: string|null, workspaceRoot: string, on: string|null, services: Array<...>, candidates: Array<...>, sig: string, ts: number }`.
    - `mesh.activeService`: `{ workspaceRoot: string, serviceId: string, ts: number }`.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`, `Editor`, `EditorState`, `TextareaState`, `Textarea`, `Scrollbar`.
  - `herdr`: `spaces`, `panes`, `terminals`, `focused`, `agents`, `hc`, `exec`, `run`, `appHome`, `readTextFile`, `watchFolder`, `theme`, `settings`, `window`, `layout`, `props`, `openOverlay`, `closeOverlay`, `shared`, `setShared`.
  - `fs/promises`, `path`: Local asynchronous filesystem scans and cross-platform persistent index cache I/O under `${appHome()}/mesh/workspaces/<slug>-<fnv1a8>/files-index.json`.
- **Forbidden:**
  - Running synchronous file operations or unbounded recursive disk scans on the main thread.
  - Pre-warming or automatically re-indexing workspaces when the active space contains only plain shell terminals (no open non-runner coding agent).
  - Spawning uncancelled `ripgrep` subprocesses on every keystroke or reloading expanded folders while the `#files` panel is hidden.
  - Calling `cx.notify()` or mutating shared/panel state synchronously during `renderPanel()` (deferred via `schedulePanelSync` using `cx.timer.after(0, ...)`).
  - Retaining overlay resources, watchers, focus timers, or background tasks after view destruction.

## Tri-Mode Architecture

The mod detects its operational mode during initialization via `props()`:

```text
                             +----------------------+
                             |   FilesSearch.init   |
                             +----------+-----------+
                                        |
                    Boolean(props()?.overlay) ?
                               /                 \
                          YES /                   \ NO
                             v                     v
           +--------------------+        props()?.role === "indexer" ?
           |    initOverlay     |               /            \
           | (files-search-win) |          YES /              \ NO
           +--------------------+             v                v
                                   +---------------+    +--------------------+
                                   |  initIndexer  |    |     initPanel      |
                                   | (0px headless)|    |  (Docked #files)   |
                                   +---------------+    +--------------------+
```

### 1. Docked Panel Mode (`isOverlay: false`, `isIndexer: false`)
- **Workspace Root Anchoring (`location().cwd`):** Tracks the workspace directory using `space.folder` as the primary anchor whenever the focused pane's `cwd` resides within `space.folder` (`pane.cwd === space.folder || pane.cwd.startsWith(space.folder + "/")` or Windows `\`). This guarantees that terminal `cd` into microservice subfolders does not shrink the file tree or search scope.
- **Session-Scoped Multi-Repository Discovery (`discoverRepos`, `attributeSessionServices`):** Discovers Git repositories under `workspaceRoot` up to depth 2 (plus parent siblings when `workspaceRoot` is itself a repo and extra active-tab `pane.cwd` paths) using native async `fs/promises` scans locally (`fsScanRepos`, falling back to PowerShell on Windows or POSIX `sh` outside `$HOME` / on unsupported `Dirent` shapes) and POSIX/PowerShell over SSH (`on`), cached for `REPO_CACHE_TTL_MS = 60000`. Executes lock-free `git status --porcelain=v1 -b -z --no-renames --untracked-files=normal` in parallel, attributes touched repositories to the active tab session via `mesh.flows[tabId].sessionRepos`, and publishes `mesh.services` with a `sig` change key (`45s` heartbeat) so `changes-review` reuses results cleanly.
- **Folder Modification Counters & Badges:**
  - Aggregates file modification marks (`marks`: `fullPath -> "A" | "M" | "D" | "U"`).
  - Computes ancestor directory modification counters (`dirCounts` / `dirMarks`: `dirFullPath -> count`).
  - Folder rows display a compact modification counter badge on the right when changes exist inside that subtree (`dirCounts[fullPath] > 0`).
  - Discovered session Git repository roots render a distinct `repo` pill next to the folder name, distinguishing touched microservices within the tree.
- **Service Quick-Jump / Filter Bar:**
  - Rendered below the `Files` header when multiple services are attributed (`this.services.length > 1`) or an active `serviceFilter` is set (`!== "all"`) and no single file preview is active.
  - Contains an `All` pill and a pill for each attributed service displaying its name and pending change count badge.
  - Clicking a service pill toggles `this.serviceFilter`, automatically expands the service's relative path in `this.folders` (fetching unloaded directory entries), scopes visible top-level tree rows to that service's subtree, and broadcasts `setShared("mesh.activeService", { workspaceRoot, serviceId, ts })`.
  - Listens to `shared("mesh.activeService")` (using timestamp check `ts > this.lastActiveServiceTs`) inside a deferred `schedulePanelSync(cx)` callback to synchronize active service selection from sibling mods like `changes-review` without triggering re-entrant event loops.
- **Debounced Watching, Cross-Platform Directory Listing & Hidden-Panel Throttling:** Lists local directory entries via `fs/promises` `readdir` inside `$HOME` and falls back to PowerShell (`windowsDirectory`) on Windows or POSIX `sh` outside `$HOME` or on runtime errors (`directory`), notifying immediately once folder entries load. Sets up non-blocking directory observers using `watchFolder(root)`, debouncing `750ms` and filtering build/dependency churn (`node_modules`, `target`, `.git` internal locks) via `analyzeWatchBatch`, incrementally reloading only dirty expanded folders. Skips folder listings and throttles background polling intervals to `60000ms` when `#files` is hidden (`isFilesVisible()`), recovering via `!this.entries.has("") || Boolean(this.error) || needsFolderReloadOnShow` on show.
- Renders hierarchical tree nodes with lazy folder expansion and caching.
- Listens to `shared("files-search.select")`: When a file is selected from the overlay search, unpacks the file path, expands all ancestor directories, scrolls the file into view, and highlights it. If the target file resides outside the active `serviceFilter`, resets `serviceFilter` to `"all"`. Prepend any relative root prefix if the selection payload root differs from the panel root.

### 2. Search Everywhere Overlay Mode (`isOverlay: true`)
- **Workspace-Wide Root Resolution:** Resolves search root via `props().root || shared("mesh.services")?.workspaceRoot || location().cwd`. Immediately hydrates memory from persistent disk cache (`restoreDiskIndex`) if available before verifying/refreshing in the background via `ensureWorkspaceIndex`.
- **IntelliJ-Style Floating Dialog with Segmented Category Tabs:**
  - **All:** Combined file, directory, and text content matches.
  - **Files:** Time-sliced chunked fuzzy matching (`triggerFileSearch` / `fileSearchTask` with `scoreSubseqFast`, monotonic prefix narrowing, trailing `/` folder-query tolerance and directory boost, and bounded top-50 scoring so `renderOverlay()` stays O(1) without QuickJS `interrupted` timeouts) against cached workspace file + directory entry lists (`OVERLAY_INDEX_CACHE` refreshed via `rg --files --path-separator /`, `git ls-files`, `mesh.services.candidates` in bounded batches, or native `fsListWorkspace` falling back to Windows PowerShell `Get-ChildItem -Recurse` or POSIX `find`, deriving ancestor directories via `deriveDirsFromFiles`).
  - **Text:** Debounced asynchronous search (`160ms`/`260ms`) with session query cache executing `rg --vimgrep --path-separator / --max-count=3 --max-filesize 512K --threads 4` (caching ripgrep availability via `RG_AVAILABLE_CACHE`, handling `code === 1` empty matches without fallback, retrying regex-syntax `code === 2` with `-F`, and falling back to bounded-concurrency `git grep -F -m 3` across active-first `candidates` only when `rg` is missing/broken), normalizing Windows backslashes cleanly.
- **Microservice Prefix Badges:** When the workspace contains multiple microservices (`mesh.services.services.length > 1`), search result rows display a distinctive badge identifying the microservice to which each matched file or text line belongs.
- Features an optional live preview pane with viewport-clamped column widths (never overflowing down to `winW = 860`) that reads file chunks via `readFileChunk` (centering on matching line numbers) or lists directory children asynchronously when a folder item is highlighted.
- Selecting a directory (`kind === "dir"`) navigates and expands the folder in `#files` (`openFromSearch`); Shift/click-style reveal stays responsive.
- Allows resizing via grip controls, persisting geometry across sessions via `setShared("files-search.customSize", ...)`.

### 3. Headless Agent-Triggered Indexer Mode (`isIndexer: true`, `props()?.role === "indexer"`)
- Mounted in a `0px` `#files-indexer` block inside `#work` so workspace indexing stays active even while `#panel` starts collapsed (`hidden: true`).
- Renders an inert `div().h(0).w(0)` container (`renderIndexer`).
- Observes workspace/tab/agent lifecycle (`hasOpenAgentInSpace`, ignoring `meshRunner === "true"` splits): remains completely idle when only plain shell terminals are open, and pre-warms (`AGENT_PREWARM_DEBOUNCE_MS = 250`) only once a live coding agent opens in the space.
- Deduplicates concurrent `ensureWorkspaceIndex` scans, persists file + directory snapshots to `${appHome()}/mesh/workspaces/<slug>-<fnv1a8>/files-index.json`, shares root `watchFolder` ownership (`claimRootWatcher` / `releaseRootWatcher`) with docked panel mode, extends cache TTL to `INDEX_WATCHED_TTL_MS = 300000` while watched, ignores pure edits to existing indexed files, and triggers debounced incremental re-indexing (`INDEX_REBUILD_DEBOUNCE_MS = 1200`) on additions, deletions, `.gitignore` changes, branch/HEAD switches, or watch overflow while an agent remains open.

## Invariants

1. **Agent-Gated Background Pre-Warming & Shared Watch Ownership:**
   Automatic workspace indexing and headless `watchFolder` monitoring MUST ONLY start when `hasOpenAgentInSpace()` detects a live non-runner coding agent in the active space (never for plain shell terminals alone), and `indexer.js` MUST enforce single-owner `watchFolder` registration (`claimRootWatcher`) and `INDEX_INFLIGHT` deduplication per workspace root.
2. **Subprocess Throttling, Chunked File Matching, and Cancellation:**
   Entering characters into the search field triggers time-sliced file+directory matching (`triggerFileSearch` / `fileSearchTask`) and a debounced text search task. `renderOverlay()` only reads precomputed `searchResults()`. Any previously running `fileSearchTask` or `textSearchTask` MUST be cancelled via `.cancel()` before launching a subsequent query, guaranteeing that slow work never blocks `render()` or overwrites newer results.
3. **Lock-Free Multi-Repository Git Operations:**
   Every read-only Git status, diff, ls-files, or grep command executed across discovered services MUST supply `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` to prevent touching `.git/index.lock` or tripping filesystem watchers.
4. **Workspace Root Stability:**
   Terminal navigation into subdirectories or microservices must never mutate or truncate the panel's root file tree or search scope. Root resolution strictly anchors to `space.folder` when available.
5. **Non-Reentrant Shared State Synchronization & Pure Render:**
   Shared state listeners (`mesh.activeService`, `files-search.select`) MUST gate incoming events against monotonically increasing timestamps (`ts > this.lastActiveServiceTs`), defer panel mutations outside `renderPanel()`, and never emit reciprocal shared state updates for incoming events.
6. **Deep Path & Directory Auto-Expansion:**
   When `openFromSearch(path, cx, kind)` receives a file or directory selected externally, it iteratively builds and adds all intermediate folder paths (plus the directory itself when `kind === "dir"`) to `this.folders` before rendering, ensuring the target node is immediately visible in the tree.
7. **Graceful Teardown:**
   Upon overlay close or view/indexer release, `_overlayClosed` / `_indexerClosed` is set and all background tasks (`focusInputTask`, `watchDebounceTask`, `pendingPanelSyncTask`, `fileSearchTask`, `textSearchTask`, `previewDebounceTask`, `indexerSyncTask`, `indexerReindexTask`, `indexerWatchDebounceTask`) and allocated resources (`this.input?.release()`, `this.code?.release()`, `releaseRootWatcher(...)`) must be cleanly disposed of.

## Multi-Repo & Mesh Architecture

Herdr Mesh implements a unified multi-repository model where microservices co-exist within an anchored workspace:
- **Unified Multi-Root Search:** Executes federated ripgrep and git search queries across all microservice repositories under the workspace root.
- **Microservice Filtering:** Horizontal service bar and overlay service badges provide immediate visual context and scoped navigation.
- **Shared State Mesh Bus:** Synchronizes active service selection and repository metadata across `files-search`, `changes-review`, and layout containers via `mesh.services` and `mesh.activeService`.
