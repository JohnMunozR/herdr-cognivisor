---
id: submodule-mod-files-search
type: submodule-design
status: active
title: Files & Search Everywhere Mod (mods/files-search)
parent: module-mods
references: [module-layouts, module-shared]
covers: [file-tree-panel, search-everywhere-overlay, ripgrep-live-search, shared-file-selection, multi-repo-git-status, service-quick-filter, cross-service-search]
tags: [mod, files, search, overlay]
---

## Responsibility

The `submodule-mod-files-search` delivers workspace file tree navigation, ripgrep-powered fuzzy search, and full-pane IDE file viewing for Herdr. It operates polymorphically in four modes depending on instantiation context (`props()`):

1. **Docked File Tree Panel (`#files`):** Renders within the `#files` slot of `#panel-body`, displaying a collapsible directory tree of the active workspace, service filters, file badges, and selection highlights without replacing the explorer with an inline editor.
2. **File Viewer Tab (`role: "viewer"`):** Opens in `#main` via `run("tab.new", ...)` whenever a file is opened from `#files` or Search Everywhere, rendering a readonly syntax-highlighted `Editor` workspace tab with a compact `40px` header and reload support.
3. **Search Everywhere Overlay (`overlay: true`):** Renders as a floating, frameless modal window (`files-search-win`) triggered globally via `Ctrl+P` or `Alt+F`. It supports searching files by name, full-text searching across source code with ripgrep, live code preview, and keyboard-centric selection.
4. **Headless Indexer (`role: "indexer"`):** Renders a `0px` background instance in `#files-indexer` that maintains workspace file indexes, watcher-triggered cache invalidations, and service inventory updates.

## Boundary

- **Owns:**
  - Manifest file: `mods/files-search/mod.json` (identifies as `files-search`, cloned from `files` v0.1.13, overlay key `files-search-win`).
  - Main component: `mods/files-search/main.js`.
  - Shared indexing & cache engine: `mods/files-search/indexer.js`.
  - Pure search scoring, syntax highlighting, and file-type icon helpers: `mods/files-search/search-logic.js` (`resolveFileIconSpec`, `resolveFileIcon`).
  - Synced shared modules (`[[module-shared]]`):
    - `mods/files-search/code-wrap.js` (`computeWrapColumns`, `wrapStyledSpans`).
    - `mods/files-search/markdown-syntax.js` (`isMarkdownExt`, `createMarkdownState`, `advanceMarkdownState`, `getMarkdownStateTag`, `tokenizeMarkdownLine` — used by `search-logic.js` `tokenizeCodeLine` and `main.js` preview state reconstruction for `.md`/`.mdx` YAML frontmatter and fenced code blocks).
  - Pure tree cascade & subtree filtering helpers: `mods/files-search/tree-logic.js`.
  - Pure session baseline & disk persistence helpers: `mods/files-search/session-baseline.js` (`normalizeGitStatusMark`, `normalizeSessionBaseline`, `readDiskSessionBaseline`, `writeDiskSessionBaseline`, `terminalHasResumeCommand`, `computeFileSig`, `statFileEntry`, `filterSessionDirtyEntries`).
  - Icon assets: `mods/files-search/*.svg` (`file.svg`, `folder.svg`, `spinner.svg`, `search.svg`, `preview.svg`, `grip.svg`, etc.) and `mods/files-search/icons/file-types/*.svg` (22 vector file-type icons for Java, Spring Boot, Python, JS/TS/React, Kotlin, JSON, YAML, settings/env, SQL, HTML/XML, CSS, Docker, Git, build manifests, lockfiles, Markdown, shell, images, generic code, and fallback file).
  - Type definitions and config: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `files-search`.
  - Layout slots: `#panel-body` child `files` (docked panel) and `#work` 0px headless slot `files-indexer` (`props: { role: "indexer" }`) in `layouts/mesh.json`.
  - Window overlay key: `files-search-win`.
  - Global shortcuts registered in `keys.json`:
    - `ctrl-p` -> `mod.open:files-search`
    - `alt-f` -> `mod.open:files-search`
  - Shared state event channels:
    - `files-search.select`: `{ root: string, kind: "dir"|"reveal", path: string, line: number|null, ts: number }`.
    - `files-search.customSize`: `{ w: number, h: number }`.
    - `mesh.spaceAgentTabs`: `Record<spaceId, tabId>` storing the active terminal/agent tab ID per space so workspace root resolution stays anchored even when a non-terminal File Viewer tab is active.
    - `mesh.openFileTabs`: `Record<tabId, { tabId, spaceId, viewerId, root, path, absPath, displayPath, iconPath, line, serviceId, serviceName, updatedAt }>` tracking live File Viewer tabs in `#main` for cross-pane deduplication, line updates, and stale-tab pruning.
    - `mesh.services`: `{ tabId: string|null, workspaceRoot: string, on: string|null, services: Array<...>, candidates: Array<...>, sig: string, ts: number }`.
    - `mesh.activeService`: `{ workspaceRoot: string, serviceId: string, ts: number }`.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`, `Editor`, `EditorState`, `TextareaState`, `Textarea`, `Scrollbar`, `VirtualListScrollHandle`, `v_virtual_list`.
  - `herdr`: `spaces`, `panes`, `terminals`, `focused`, `agents`, `hc`, `exec`, `run`, `appHome`, `readTextFile`, `watchFolder`, `theme`, `settings`, `window`, `layout`, `props`, `openOverlay`, `closeOverlay`, `shared`, `setShared`.
  - `fs/promises`, `path`: Local asynchronous filesystem scans, persistent index cache I/O under `${appHome()}/mesh/workspaces/<slug>-<fnv1a8>/files-index.json`, and persistent session baseline I/O under `${appHome()}/mesh/sessions/{tabs,resume}/*.json`.
- **Forbidden:**
  - Running synchronous file operations or unbounded recursive disk scans on the main thread.
  - Pre-warming or automatically re-indexing workspaces when the active space contains only plain shell terminals (no open non-runner coding agent).
  - Spawning uncancelled `ripgrep` subprocesses on every keystroke or reloading expanded folders while the `#files` panel is hidden.
  - Calling `setShared()`, `cx.notify()`, or mutating shared/panel/viewer state synchronously during `render()`, `renderPanel()`, or `renderViewer()` (deferred via `schedulePanelSync` / `scheduleViewerSync` using `cx.timer.after(0, ...)`).
  - Retaining overlay, viewer, or panel resources, watchers, focus timers, or background tasks after view destruction.

## Quad-Mode Architecture

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
           +--------------------+            props()?.role ?
           |    initOverlay     |         /         |        \
           | (files-search-win) |  "indexer"    "viewer"    default
           +--------------------+     /             |           \
                                     v              v            v
                         +--------------+   +--------------+   +------------------+
                         | initIndexer  |   |  initViewer  |   |    initPanel     |
                         |(0px headless)|   | (#main tab)  |   | (Docked #files)  |
                         +--------------+   +--------------+   +------------------+
```

### 1. Docked Panel Mode (`isOverlay: false`, `isIndexer: false`, `isViewer: false`)
- **Workspace Root Anchoring (`location().cwd`, `resolveWorkspaceRoot` & `mesh.spaceAgentTabs`):** Tracks the workspace directory via `resolveWorkspaceRoot`, using `space.folder` as the primary anchor whenever the active terminal pane's `cwd` resides within `space.folder` (`pane.cwd === space.folder || pane.cwd.startsWith(space.folder + "/")` or Windows `\`) — except when `space.folder` points to a user home directory (`isHomeDirectoryRoot`, e.g., `$HOME` or `/Users/<name>`) while `pane.cwd` is a deeper directory, in which case `pane.cwd` wins so the panel never scans all of `$HOME`. When a non-terminal mod tab (such as a File Viewer tab with no `cwd`) is active, `location()` falls back cleanly to `space?.folder` or the anchored terminal tab stored in `mesh.spaceAgentTabs` (or another live terminal pane in the same space), guaranteeing that terminal `cd` or switching to a File Viewer tab never drops workspace root anchoring.
- **Session-Scoped Multi-Repository Discovery & Baseline Delta Tracking (`discoverRepos`, `session-baseline.js`):** Discovers Git repositories under `workspaceRoot` up to depth 2 (plus parent siblings when `workspaceRoot` is itself a repo and active-tab `pane.cwd` paths scoped to `activeTabId`) using native async `fs/promises` scans locally (`fsScanRepos`, falling back to PowerShell on Windows or POSIX `sh` outside `$HOME` / on unsupported `Dirent` shapes) and POSIX/PowerShell over SSH (`on`), cached for `REPO_CACHE_TTL_MS = 60000`. Executes lock-free `git status --porcelain=v1 -b -z --no-renames --untracked-files=normal` (expanding `?? dir/` via `git ls-files --others --exclude-standard -z`) and `git log -n 1 --since=<floor(startedAt/1000)> --format=%ct` in parallel, tracks per-tab session baselines (`sessionBaseline`, `sessionStartedAt`, `sessionRepos`) in `mesh.flows[tabId]` and on disk under `${appHome()}/mesh/sessions/tabs/<safeTabId>.json` (validated against `workspaceRoot`) and `${appHome()}/mesh/sessions/resume/<hash(normRoot::branch)>.json` (restored only on strict command-line `/resume` detection), filters out pre-existing dirty files and untouched sibling repositories via `filterSessionDirtyEntries` + unified `statFileEntry` (`size:mtimeMs` when `stat` exists, else raw-byte `${len}:b${hex}` / `dir:<status>`) and `normalizeGitStatusMark` (emitting empty services when `activeTabId` is null), and publishes `mesh.services` with a `sig` change key (`45s` heartbeat) so `changes-review` reuses results cleanly.
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
- **Debounced Watching, Cross-Platform Directory Listing, Parallel Reload & Cache Retention:** Lists local directory entries via `fs/promises` `readdir` inside `$HOME` and falls back to PowerShell (`windowsDirectory`) on Windows or POSIX `sh` outside `$HOME` or on runtime errors (`directory`), notifying immediately once folder entries load. Sets up non-blocking directory observers using `watchFolder(root)`, debouncing `750ms` and filtering build/dependency churn (`node_modules`, `target`, `.git` internal locks) via `analyzeWatchBatch`, incrementally reloading only dirty expanded folders in bounded parallel batches (`FOLDER_RELOAD_CONCURRENCY = 8`) while evicting stale collapsed cache entries (`evictDirtyCollapsedEntries` / `evictCollapsedEntries`). Skips folder listings and throttles background polling intervals to `60000ms` when `#files` is hidden (`isFilesVisible()`), recovering via `!this.entries.has("") || Boolean(this.error) || needsFolderReloadOnShow` on show.
- **Synchronous Cached Cascade, Shallow Prewarming, Virtualized Tree & Right-Aligned Spinner:**
  - Expanding a folder in `#files` (`toggle`) first checks `resolveCachedCascade` synchronously against retained in-memory folder entries (preserved across `collapseFolderSubtree` with LRU bounds `MAX_CACHED_FOLDERS = 400` / `MAX_CACHED_ENTRIES = 25000`); complete cache hits commit and draw in a single synchronous frame without spawning a task or showing a loading spinner.
  - On local workspaces (`!context.on`), expanded views schedule bounded background prewarming (`schedulePrewarm`, `FOLDER_PREWARM_LIMIT = 24`, `FOLDER_PREWARM_CONCURRENCY = 4`, skipping build/VCS dirs) for direct visible collapsed child directories and shallow single-folder cascades so first-time opens frequently hit warm cache.
  - When uncached folders require async loading, the clicked folder remains marked `pending` (`mods/files-search/spinner.svg` with `.spin(900)` flush at the right edge of its row) while `runStagedCascade` + `directoryCascade` resolve the full single-directory chain (`MAX_CASCADE_DEPTH = 32`, filtered by active `serviceFilter`) before `commitStagedCascade` commits atomically so nested single folders visually unfold together. Clicking an already-pending folder cancels its in-flight cascade via `pendingTokens`.
  - `#files` renders flattened row metadata (`collectTreeRows`) inside `v_virtual_list("files-tree", ..., 28)` + `Scrollbar.vertical("files-tree").absolute().inset_0()` + `VirtualListScrollHandle`, anchored inside `.w_full().min_w(0)` flex containers with `.overflow_hidden()` on flexible row labels so only viewport-visible rows are built per frame and trailing `.flex_none()` spinner/badge elements are never clipped off-screen; file rows (including sibling rows) render semantic file-type SVG icons and theme palette colors via `resolveFileIcon(row.path, t)`.
- **File Tab Deduplication & Viewer Mode (`role: "viewer"`):**
  - Clicking a `file` or `sibling` row in `#files` or selecting a file in Search Everywhere calls `openFileInTab(...)`, opening or focusing a File Viewer tab in `#main` while keeping `#files` open as an IDE project explorer.
  - Before opening or focusing a tab, `openFileInTab` snapshots `spaces()`, `panes()`, and `mesh.spaceAgentTabs`, and prunes `mesh.openFileTabs` entries whose `tabId` is no longer present in any space's tab list or whose pane is no longer a `files-search` pane (`pruneOpenFileTabs`).
  - Per-space deduplication (`findMatchingOpenFileTab` + `buildFileViewerKey`) checks whether an existing live `files-search` tab in the target space already displays the same normalized `(absPath)` / `(root, path)`. If matched, it updates `line` and `updatedAt` in `mesh.openFileTabs` and calls `run("tab.select", { id: existingTabId })`; otherwise it assigns a unique `viewerId`, computes a concise tab title via `formatFileTabTitle`, and calls `run("tab.new", { space: spaceId, name: tabTitle, mod: "files-search", props: { role: "viewer", viewerId, spaceId, root, path, absPath, displayPath, on, line, serviceId, serviceName } })`.
  - Viewer instances (`initViewer`, `renderViewer`) stay crash-safe on partial/missing props, defer `mesh.openFileTabs` claiming/syncing to `cx.timer.after(0, ...)` (never mutating shared state synchronously inside `render()`), read files asynchronously via `readTextFile(targetPath, { on })` into `EditorState.new` (`readonly: true`, `soft_wrap: true`, `line_numbers: true`, `folding: true`, `font_size: 12.5`, `resolveEditorLanguage`, `getEditorSyntaxConfig(t)`), render a `40px` header (file icon, optional service badge, filename + muted parent folder, optional `Ln <line>` badge, and `↻` Reload button), render `Editor.new(this.viewerCode).flex_1().min_h(0).w_full().min_w(0)` with loading/error/binary fallbacks, sync `line` updates from `mesh.openFileTabs`, and auto-reload when becoming newly active so long lines automatically soft-wrap to the viewer pane width without adding line numbers or requiring horizontal scrolling.
- Listens to `shared("files-search.select")`: When `kind === "dir"` or `kind === "reveal"` arrives from Search Everywhere, unpacks the path, expands all ancestor directories (plus the directory itself when `kind === "dir"`), and scrolls the revealed item into view via `VirtualListScrollHandle.scroll_to_item` (`pendingScrollPath`). File selection emits `kind: "reveal"` so `#files` highlights the selected file in the background without forcing `#panel` open and without replacing `#files` with an inline editor; directory selection (`kind === "dir"`) reveals the folder in `#files` and opens `#panel`. If the target path resides outside the active `serviceFilter`, resets `serviceFilter` to `"all"`, prepending any relative root prefix if the selection payload root differs from the panel root.

### 2. Search Everywhere Overlay Mode (`isOverlay: true`)
- **Workspace-Wide Root Resolution:** Resolves search root via `props().root || shared("mesh.services")?.workspaceRoot || location().cwd`. Immediately hydrates memory from persistent disk cache (`restoreDiskIndex`) if available before verifying/refreshing in the background via `ensureWorkspaceIndex`.
- **Query-Required Results & Outside-Click Dismissal:** Opening the overlay renders zero file/folder results until at least one non-whitespace character is entered (`prepareSearchQuery` returns `null` for empty/whitespace input, displaying `"Type to search files, folders, or text…"` instead of pre-populating cached entries). Clicking or interacting outside `files-search-overlay-root` (`on_mouse_down_out`) automatically closes the overlay (`closeOverlay()`).
- **IntelliJ-Style Floating Dialog with Segmented Category Tabs:**
  - **All:** Combined file, directory, and text content matches.
  - **Files:** Time-sliced chunked fuzzy matching (`triggerFileSearch` / `fileSearchTask` with `scoreSubseqFast`, monotonic prefix narrowing, trailing `/` folder-query tolerance and directory boost, and bounded top-50 scoring so `renderOverlay()` stays O(1) without QuickJS `interrupted` timeouts) against cached workspace file + directory entry lists (`OVERLAY_INDEX_CACHE` refreshed via `rg --files --path-separator /`, `git ls-files`, `mesh.services.candidates` in bounded batches, or native `fsListWorkspace` falling back to Windows PowerShell `Get-ChildItem -Recurse` or POSIX `find`, deriving ancestor directories via `deriveDirsFromFiles`).
  - **Text:** Debounced asynchronous search (`160ms`/`260ms`) with session query cache executing `rg --vimgrep --path-separator / --max-count=3 --max-filesize 512K --threads 4` (caching ripgrep availability via `RG_AVAILABLE_CACHE`, handling `code === 1` empty matches without fallback, retrying regex-syntax `code === 2` with `-F`, and falling back to bounded-concurrency `git grep -F -m 3` across active-first `candidates` only when `rg` is missing/broken), normalizing Windows backslashes cleanly.
- **Microservice Prefix Badges:** When the workspace contains multiple microservices (`mesh.services.services.length > 1`), search result rows display a distinctive badge identifying the microservice to which each matched file or text line belongs.
- Features an optional live preview pane with viewport-clamped column widths (never overflowing down to `winW = 860`) that reads file chunks via `readFileChunk` (centering on matching line numbers) using `tokenizeCodeLine` + `syntaxTokenStyle` (`annotation`, `keyword`, `type`, `function`, `string`, `string.escape`, `number`, `boolean`, `constant`, `variable`, `operator`, `comment` for Java/Spring Boot, Python, JavaScript, YAML, JSON, and `.properties`, and delegating `.md`/`.mdx` previews to shared `./markdown-syntax.js` with `createMarkdownState` + `advanceMarkdownState` reconstructing YAML frontmatter and fenced code block state across scrolled preview lines and delegating fenced languages back to `tokenizeCodeLine`, plus inline query-match highlights) cached per `(text, ext, mdTag, query, isTarget, maxCols)` (`previewWrapCache`, bounded LRU up to 400 entries using `getMarkdownStateTag(mdState)`) and wrapped automatically to `previewW` via shared `code-wrap.js` (`computeWrapColumns`, `wrapStyledSpans`, leaving wrapped continuation sub-row gutters blank so continuation lines never count as extra line numbers and automatically reflowing when resized, bounded to visible rows inside `overflow_hidden` with zero horizontal scrolling), or lists directory children asynchronously when a folder item is highlighted; Search Everywhere result rows (`isFile` and `isText`), preview header, and directory-preview child file rows all display semantic file-type SVG icons resolved by `resolveFileIcon`.
- Selecting a directory (`kind === "dir"`) emits `files-search.select`, reveals and expands the folder in `#files` (`openFromSearch`), and shows `#panel` (`layout.select` + `layout.show`); selecting a file closes the overlay, opens/focuses its File Viewer tab in `#main` via `openFileInTab(...)`, and emits `kind: "reveal"` on `files-search.select` so `#files` expands and highlights the path in the background without forcing `#panel` open.
- Allows resizing via grip controls, persisting geometry across sessions via `setShared("files-search.customSize", ...)`.

### 3. Headless Terminal-Triggered Indexer Mode (`isIndexer: true`, `props()?.role === "indexer"`)
- Mounted in a `0px` `#files-indexer` block inside `#work` so workspace indexing stays active even while `#panel` starts collapsed (`hidden: true`).
- Renders an inert `div().h(0).w(0)` container (`renderIndexer`).
- Observes workspace/tab/terminal lifecycle (`hasOpenTerminalInSpace`, ignoring `meshRunner === "true"` splits): remains idle when the active space has no open terminals, and pre-warms (`AGENT_PREWARM_DEBOUNCE_MS = 250`) as soon as a terminal (plain shell or coding agent) opens in the space for work.
- Deduplicates concurrent `ensureWorkspaceIndex` scans, persists file + directory snapshots to `${appHome()}/mesh/workspaces/<slug>-<fnv1a8>/files-index.json`, shares root `watchFolder` ownership (`claimRootWatcher` / `releaseRootWatcher`) with docked panel mode, extends cache TTL to `INDEX_WATCHED_TTL_MS = 300000` while watched, ignores pure edits to existing indexed files, and triggers debounced incremental re-indexing (`INDEX_REBUILD_DEBOUNCE_MS = 1200`) on additions, deletions, `.gitignore` changes, branch/HEAD switches, or watch overflow while a terminal remains open.

## Invariants

1. **Terminal-Gated Background Pre-Warming & Shared Watch Ownership:**
   Automatic workspace indexing and headless `watchFolder` monitoring MUST start once `hasOpenTerminalInSpace()` detects a live non-runner terminal (plain shell or agent) in the active space (never for spaces with zero terminals or `meshRunner === "true"` splits alone), and `indexer.js` MUST enforce single-owner `watchFolder` registration (`claimRootWatcher`) and `INDEX_INFLIGHT` deduplication per workspace root.
2. **Subprocess Throttling, Chunked File Matching, and Cancellation:**
   Entering characters into the search field triggers time-sliced file+directory matching (`triggerFileSearch` / `fileSearchTask`) and a debounced text search task. `renderOverlay()` only reads precomputed `searchResults()`. Any previously running `fileSearchTask` or `textSearchTask` MUST be cancelled via `.cancel()` before launching a subsequent query, guaranteeing that slow work never blocks `render()` or overwrites newer results.
3. **Lock-Free Multi-Repository Git Operations:**
   Every read-only Git status, diff, ls-files, or grep command executed across discovered services MUST supply `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` to prevent touching `.git/index.lock` or tripping filesystem watchers.
4. **Live Terminal Directory Tracking:**
   Terminal navigation (`cd` outside `space.folder`, or when `space.folder` is unset) updates the panel's active `cwd` and file tree dynamically (`paneCwd || focused.cwd`), switching watchers and background indexing automatically while keeping paths inside `space.folder` anchored to `space.folder`.
5. **Non-Reentrant Shared State Synchronization & Pure Render:**
   Shared state listeners (`mesh.activeService`, `files-search.select`) MUST gate incoming events against monotonically increasing timestamps (`ts > this.lastActiveServiceTs`), defer panel mutations outside `renderPanel()`, and never emit reciprocal shared state updates for incoming events.
6. **Deep Path & Directory Auto-Expansion:**
   When `openFromSearch(path, cx, kind)` receives a file or directory selected externally, it iteratively builds and adds all intermediate folder paths (plus the directory itself when `kind === "dir"`) to `this.folders` before rendering, ensuring the target node is immediately visible in the tree. When `kind === "reveal"`, it expands ancestors and updates `selectedFile` highlight without replacing the `#files` tree with an inline editor.
7. **Graceful Teardown:**
   Upon overlay close or panel/viewer/indexer release, `_overlayClosed` / `_indexerClosed` / `_viewerClosed` is set and all background tasks (`focusInputTask`, `watchDebounceTask`, `pendingPanelSyncTask`, `prewarmTask`, `fileSearchTask`, `textSearchTask`, `previewDebounceTask`, `indexerSyncTask`, `indexerReindexTask`, `indexerWatchDebounceTask`, `viewerSyncTask`), pending folder tokens (`pending`, `pendingTokens`), and allocated resources (`this.treeScrollHandle?.release()`, `this.input?.release()`, `this.viewerCode?.release()`, `releaseRootWatcher(...)`) must be cleanly disposed of.

## Multi-Repo & Mesh Architecture

Herdr Mesh implements a unified multi-repository model where microservices co-exist within an anchored workspace:
- **Unified Multi-Root Search:** Executes federated ripgrep and git search queries across all microservice repositories under the workspace root.
- **Microservice Filtering:** Horizontal service bar and overlay service badges provide immediate visual context and scoped navigation.
- **Shared State Mesh Bus:** Synchronizes active service selection and repository metadata across `files-search`, `changes-review`, and layout containers via `mesh.services` and `mesh.activeService`.
