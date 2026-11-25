---
id: submodule-mod-git-history
type: submodule-design
status: active
title: Git History & Commit Comparison Mod (mods/git-history)
parent: module-mods
references: [module-layouts, module-shared, spec-lifecycle]
covers: [git-history-graph, commit-diff-viewer, side-by-side-diff, single-tab-reuse, multi-repo-history, lock-free-git, markdown-rendered-preview]
tags: [mod, git, history, commit-graph, diff-viewer, multi-repo]
---

## Responsibility

The `submodule-mod-git-history` provides read-only repository commit history inspection, a GitKraken-style topological branch graph, and Before/After commit diff comparison across all discovered workspace repositories (both clean and dirty). Operating as a dual-mode GPUI component sharing the same class (`GitHistory`)—the docked `#git` panel inside `#panel-body` and a single reusable non-terminal **Git Diff** comparison tab (`props.role === "viewer"`) opened in `#main`—it lets developers browse commits by repository, branch, or search filter, inspect modified files in a commit, and compare changes **Side-by-Side (`Before | After`)** or **Unified** inside one reusable tab per space.

## Boundary

- **Owns:**
  - Manifest file: `mods/git-history/mod.json` (`{ "place": "none", "title": "Git History" }`).
  - Dual-mode view component and retained diff sub-view: `mods/git-history/main.js` (`GitHistory`: `renderPanel` for `#git` sidebar, `renderViewer` for `role: "viewer"` comparison tab in `#main` rendering block-virtualized Side-by-Side blocks directly via `v_virtual_list`, plus retained `GitDiffUnifiedView` for isolated Unified diff pane invalidation).
  - Pure topological commit graph, ref decoration, filtering, and relative-time helpers: `mods/git-history/graph-logic.js` (`LOG_FIELD_SEP`, `LOG_RECORD_SEP`, `parseDecorations`, `parseGitLogOutput`, `computeCommitGraphLayout`, `filterCommits`, `formatRelativeTime`).
  - Pure commit file-list parsing, Side-by-Side/Unified row alignment (with optional `deferTokens` lazy tokenization), row pagination, wrap-aware wave layout geometry, token capping, pre-baked span preparation (`prepareWrappedRenderLines`, `computeUnifiedRowHeights`, `countCellVisualRows`), syntax lexing, file-type icon, width estimation, Markdown blob spec resolution (`resolveHistoryMarkdownBlobSpec`), and tab-title helpers: `mods/git-history/diff-logic.js` (`MAX_DIFF_SYNTAX_LINE_CHARS`, `MAX_VIEWER_DIFF_LINES`, `DEFAULT_SBS_PAGE_ROWS`, `MAX_RENDER_TOKENS_PER_LINE`, `DIFF_ROW_HEIGHT`, `DIFF_HUNK_HEIGHT`, `DIFF_WAVE_GUTTER_WIDTH`, `DIFF_WAVE_MAX_CENTER_OFFSET_ROWS`, `parseCommitFiles`, `buildSideBySideRows`, `buildUnifiedRows`, `paginateDiffRows`, `buildWaveDiffLayout`, `computeUnifiedRowHeights`, `countCellVisualRows`, `capRenderTokens`, `tokenizeDiffLine`, `tokenizeDeferredRow`, `tokenizeSideBySidePage`, `getDiffSyntaxPalette`, `diffSyntaxTokenColor`, `toNbspString`, `prepareRenderLineData`, `prepareWrappedRenderLines`, `getFileExt`, `expandCodeTabs`, `resolveGitFileIcon`, `computeDiffColumnWidths`, `computeViewerLoadedKey`, `resolveHistoryMarkdownBlobSpec`, `formatGitTabTitle`).
  - Synced shared modules (`[[module-shared]]`):
    - `mods/git-history/code-wrap.js` (`computeWrapColumns`, `wrapPlainText`, `wrapStyledSpans`).
    - `mods/git-history/markdown-syntax.js` (`isMarkdownExt`, `createMarkdownState`, `advanceMarkdownState`, `tokenizeMarkdownLine` — tracking YAML frontmatter and fenced code block state independently across `Before` and `After` diff lines via `resetMdStateForLine`).
    - `mods/git-history/markdown-view-logic.js` (`DEFAULT_MARKDOWN_MAX_CHARS`, `isMarkdownFile`, `prepareMarkdownForRender`, `getDiffMarkdownPlan`, `classifyMarkdownLink`, `resolveRelativeMarkdownPath` — pure Markdown preview preparation, link validation, and deleted-vs-current diff planning).
    - `mods/git-history/markdown-view.js` (`createMarkdownRenderCache`, `renderMarkdownToggleButton`, `renderMarkdownViewer` — bounded preparation cache, `#git-markdown-toggle` toolbar pill, and scrollable `TextView.markdown` surface).
    - `mods/git-history/dropdown-logic.js` & `mods/git-history/dropdown.js` (`renderDropdownTrigger`, `renderDropdownPopover`, `computeDropdownMetrics`, `filterDropdownItems`, `findFirstSelectableDropdownOption` powering adaptive shrink-wrapping popovers `#git-repo-dropdown` and searchable `#git-branch-dropdown`).
    - `mods/git-history/diagnostics-logic.js` & `mods/git-history/diagnostics.js` (`createModLogger`, `renderErrorFallbackCard` for non-reentrant render error boundaries and JSON report export).
  - Pure repository discovery merging, branch ref parsing, `.git` watch filtering, workspace root resolution, and session agent-tab preservation helpers: `mods/git-history/repo-logic.js` (`READ_GIT`, `DISCOVER_SKIP_DIRS`, `isHomeDirectoryRoot`, `resolveWorkspaceRoot`, `parseBranchesOutput`, `mergeDiscoveredWithServices`, `resolveSelectedRepo`, `shouldIgnoreGitWatchEvent`, `resolveSessionAgentTabId`).
  - Icon assets: `mods/git-history/icons/{git-branch,git-commit,git-compare,chevron-down}.svg` and `mods/git-history/icons/file-types/*.svg` (22 vector file-type icons).
  - Type definitions and compiler configuration: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `git-history` (docked panel when `props()?.role !== "viewer"`; full-pane comparison tab when created with `props: { role: "viewer", spaceId, sourceTabId, diffMode? }`).
  - Layout slot: `#panel-body` child `git` in `layouts/cognivisor.json`; `#main` tab via `run("tab.new" | "tab.rename" | "tab.select")`.
  - Keyboard shortcuts: No global shortcut is registered by default in `keys.json` for `git-history` in v1 (users access `#git` via the `Git` toggle button in `cognivisor-tabs` or `layout.select --stack panel-body --child git`).
  - Shared state bus:
    - Coordinates the active space's single `git-history` viewer tab via `git-history.activeDiff` (`Record<spaceId, GitDiffViewerState>` containing `spaceId`, `sourceTabId`, `workspaceRoot`, `repoRoot`, `repoName`, `on`, `commitHash`, `shortHash`, `parentHashes`, `commitSubject`, `commitAuthor`, `commitTimestamp`, `diffMode`, `openFileKey`, `openFile`, `files`, `expanded`, `requestSeq`, `ts`).
    - Persists per-space repository selection (clean or dirty) via `git-history.selectedRepo` (`Record<spaceId, { repoRoot: string, ts: number }>`).
    - Reads `cognivisor.services` as a fast candidate/dirty-status hint and `sig`-based refresh signal while retaining clean repositories discovered under the workspace.
    - Reads `cognivisor.activeService` (following external dirty-service switches with monotonic `ts > lastActiveServiceTs`) and writes `cognivisor.activeService` only when the selected repo exists in `cognivisor.services.services` (preventing clean-repo inspections from blanking `changes-review`).
    - Reads and updates `cognivisor.spaceAgentTabs` (`Record<spaceId, tabId>`) before opening the non-terminal `git-history` viewer tab so terminal session identity stays anchored to the space's active terminal tab.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`, `PathBuilder`, `Background` (plus global `window.paint_path`, importing `herdr`'s `window` aliased as `herdrWindow`).
  - `gpui-base`: `v_flex`, `h_flex`, `v_resizable`, `resizable_panel`, `v_virtual_list`, `VirtualListScrollHandle`, `Scrollbar`, `ScrollHandle`, `InputState`, `Input`, `TextView` (via `./markdown-view.js`).
  - `herdr`: `spaces`, `panes`, `focused`, `exec`, `watchFolder`, `theme`, `settings`, `run`, `layout`, `props`, `shared`, `setShared`, `window`, `appHome`.
  - `fs/promises`, `path`: `readdir`, `exists`, `join` for local repository scanning and `.git/HEAD` resolution.
- **Forbidden:**
  - Any usage of `localStorage` or browser DOM APIs.
  - Calling `cx.notify()`, `setShared()`, or mutating `InputState` values synchronously inside `render()` (all refreshes, `scheduleSharedSync`, `scheduleAgentTabSync`, and `scheduleViewerLoad` defer via `cx.timer.after(0, ...)`).
  - Rendering commit diff comparison panes inside the docked `#git` sidebar.
  - Spawning duplicate `git-history` viewer tabs in the same space when one already exists (`findGitDiffTabInSpace` reuses, updates `git-history.activeDiff`, calls `tab.rename`, and calls `tab.select`).
  - Executing any Git command without `READ_GIT` lock-free flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
  - Executing mutating or destructive Git commands (`checkout`, `switch`, `branch`, `cherry-pick`, `rebase`, `reset`, `commit`, `push`, `stash`) — v1 is strictly read-only.
  - Hardcoded color hex literals inside view rendering ignoring `theme()`, `settings().colors`, or `layout().colors`.
  - Cross-mod relative `../` JavaScript imports.

## Architecture & Interaction Flow

```text
Docked Panel (#git, props.role !== "viewer")                Main Comparison Tab (#git-diff-tab-viewer, role === "viewer")
+-------------------------------------------------+        +--------------------------------------------------------------+
| [branch-icon] [repo v]  [All Branches v]   [↻]  |        | [repo] [abc1234] M icon path/to/file +14 -5 [<- 1/3 ->] [↻]  |
| [Filter message, author, SHA...           ] [×] |        | [Expand/Collapse]  [Side-by-Side | Unified] [Render]       |
+-------------------------------------------------+        +--------------------------------------------------------------+
| *   [HEAD->main] feat: refresh token  Alex 2h   |        | Commit subject · author · relTime · parent 9876fed           |
| |\                                              |        +------------------------------+-------------------------------+
| | * [feat/auth] add token store       Sam  4h   | -----> | Before (9876fed)             | After (abc1234)               |
| |/                                              | commit | 12   const ttl = 300;        | 12   const ttl = 900;         |
| *   fix: cors headers                 Alex 1d   | click  | 13 - return issue(ttl);      | 13 + return rotate(ttl);      |
+=================== v_resizable =================+        |                              | 14 + auditLog(user.id);       |
| [abc1234] Alex · 2h · parent 9876fed  [3 files] |        +------------------------------+-------------------------------+
| Commit subject                                  |        ^
| > M  src/auth.ts                       +14 -5   | -------+ clicks switch file IN PLACE (same tab via tab.rename/select)
|   A  src/token-store.ts                +48 -0   |
+-------------------------------------------------+
```

### Docked `#git` Panel & Topological Commit Graph

1. **All-Repository Discovery & Selection (`discoverRepoRoots`, `mergeDiscoveredWithServices`, `resolveSelectedRepo`):**
   - Resolves `workspaceRoot` via `resolveWorkspaceRoot` (anchoring to `space.folder` unless `space.folder` is a home directory root and `pane.cwd` targets a deeper directory) and scans up to depth 2 using `fs/promises` locally (or `sh` / `powershell` when `on` is set), plus parent siblings for single-repo workspaces and active-space `pane.cwd` paths, caching roots for `REPO_CACHE_TTL_MS = 60000`.
   - Merges discovered roots with `shared("cognivisor.services")` hints (`mergeDiscoveredWithServices`) so both clean and dirty repositories appear in `#git-repo-btn` (`#git-repo-dropdown`, rendered via shared `./dropdown.js` `renderDropdownTrigger` + `renderDropdownPopover` with `computeDropdownMetrics` adaptive sizing and zero empty overflow scrollboxes) with dirty dot indicators, counts, and branches.
   - Persists selection per space in `git-history.selectedRepo` and synchronizes `cognivisor.activeService` only when the picked repo belongs to `cognivisor.services.services`.
2. **Branch Filtering, Search, Ref-Signature Poll Gating & Paginated Graph (`loadBranchesAndCommits`, `loadMoreCommits`):**
   - Queries `git for-each-ref` (`refs/heads`, `refs/remotes`) using `%09` tab-delimited `GIT_BRANCH_FORMAT` (`"%(HEAD)%09%(refname:short)%09%(refname)%09%(objectname:short)"`) parsed by `parseBranchesOutput` (which strips symbolic `/HEAD` refs such as `origin/HEAD` via `fullName.endsWith("/HEAD")`) for `#git-branch-btn` (`#git-branch-dropdown` rendered via shared `./dropdown.js`, selecting `All Branches` -> `--all HEAD` or a specific local/remote ref) and `git log --topo-order --decorate=short --date=unix -n 200` using `\x1f` / `\x1e` delimiters (`GIT_LOG_FORMAT`, omitting unused bodies). Background refreshes from the 30s poll, `.git` watchers, or `cognivisor.services` bus signals first compare `git show-ref --head` against the cached signature and skip reloading when refs and `HEAD` have not moved.
   - `computeCommitGraphLayout` computes deterministic lane indices, color indices, pass-through vertical segments, incoming merge/converging Bezier connectors, and outgoing fork/parent Bezier connectors cached per row layout (batched by `colorIndex`) via `PathBuilder` + `window.paint_path` inside `v_virtual_list("git-commits-list", ..., 30)` (with `Scrollbar.vertical("git-commits-list")` and `#git-load-more-row` pagination in chunks of `COMMIT_PAGE_SIZE = 200`).
   - `InputState` in `#git-search-bar` debounces (`SEARCH_DEBOUNCE_MS = 60`) and filters loaded commits client-side (`filterCommits`, memoized across renders) across `hash`, `shortHash`, `subject`, `author`, and `refs[].label`.
3. **Bottom Commit Metadata & Modified Files Pane (`#git-commit-detail`):**
   - Partitioned below the graph via `v_resizable("git-panel-split")` (top `380px` [160–900], bottom `220px` [120–600]).
   - Selecting a commit fetches changed files (cached per `(repo, remote, commitHash)` up to `MAX_COMMIT_FILES_CACHE = 32` entries) via parallel `git diff-tree -r --no-commit-id --root --first-parent -M --numstat -z <hash>` and `--name-status -z <hash>` parsed by `parseCommitFiles`, rendering `v_virtual_list("git-commit-files", ..., 26)` with status badges (`M`/`A`/`D`/`R`/`C`/`T`), 22 file-type SVG icons (`resolveGitFileIcon`), rename paths (`old -> new`), and `BIN` or `+add`/`-del` counters.

### Reusable `#main` Comparison Tab & In-Place Diff Switching

1. **Single-Tab Reuse (`openGitDiffTabForCommit`, `selectCommitFileInPlace`, `findGitDiffTabInSpace`):**
   - Clicking a commit in `#git-commits-list` loads its changed files, selects the first file (if any), records the space's active terminal tab in `cognivisor.spaceAgentTabs`, writes `git-history.activeDiff[spaceId]` with an incremented `requestSeq`, and either creates one `#main` tab (`run("tab.new", { space: spaceId, name, mod: "git-history", props: { role: "viewer", spaceId, sourceTabId } })`) or reuses and focuses the existing `git-history` viewer tab (`tab.rename` + `tab.select`).
   - Clicking any file in `#git-commit-files` (`selectCommitFileInPlace`) or stepping `←` / `→` (`#git-diff-prev` / `#git-diff-next`) in `#git-diff-toolbar` updates `git-history.activeDiff[spaceId]` and renames/loads inside that same tab in place.
2. **Deferred Diff Loading, Single-Mode Parsing & Edge Cases (`scheduleViewerLoad`, `loadViewerDiffNow`, `fetchCommitFilePatch`):**
   - `renderViewer` compares `computeViewerLoadedKey(diff)` against `this.viewerLoadedKey` and schedules `loadViewerDiffNow` via `cx.timer.after(0, ...)` guarded by monotonic `viewerLoadGen`.
   - Fetches patches lock-free (LRU-cached per `(repo, remote, commitHash, fileKey, expanded)` up to `MAX_VIEWER_PATCH_CACHE = 24` entries, bypassed on manual `↻` reload) using `git show --root --format= ...` for root commits (`parents.length === 0`) or `git diff ... <parents[0]> <commitHash> -- <pathArgs>` (passing both `oldPath` and `path` for `R`/`C` renames/copies), with `-U3` by default or `-U99999` when expanded (`#git-diff-expand`). Only the active diff mode (`side-by-side` or `unified`) is parsed on load (`deferTokens: true`), lazily parsing the sibling mode only if the user toggles modes.
   - Binary files (`numstat` `- -` or binary patch marker) short-circuit to a binary metadata view; empty commits, zero-diff renames (`"Renamed with no content changes"`), and oversized diffs (`MAX_VIEWER_DIFF_LINES = 1500`, `4000` expanded) surface explicit UI notices.
3. **Side-by-Side (`Before | After`) & Unified Modes:**
   - Default **Side-by-Side** (`#git-mode-sbs`) renders paginated windows of up to `DEFAULT_SBS_PAGE_ROWS` (`180`) rows per page via `paginateDiffRows` (tokenizing only the active page via `tokenizeSideBySidePage`—including independent `leftMdState`/`rightMdState` tracking via shared `./markdown-syntax.js` for `.md`/`.mdx` YAML frontmatter and fenced code blocks—pre-baking and soft-wrapping tokens cleanly per pane width via `prepareWrappedRenderLines` + width-keyed `WeakMap` line baking, and capping per-line token elements to `MAX_RENDER_TOKENS_PER_LINE = 28` via `capRenderTokens` so QuickJS frames stay responsive) and converts the active page into synchronized IntelliJ-style compact side columns, wrap-height-matched `gutterItems`, and cached `PathBuilder` bezier wave transitions (`WeakMap`) via `buildWaveDiffLayout`, grouped into aligned height-matched virtual blocks via `buildWaveDiffBlocks`. When `totalPages > 1`, `#git-diff-sbs-pager` displays page metrics and `#git-diff-page-prev` / `#git-diff-page-next` controls above `#git-diff-col-headers` (`Before (<parent|empty>)` | `git-compare` | `After (<shortHash>)`) and one block-virtualized vertical scroll list (`v_virtual_list("git-diff-y", ...)` tracked by `this.diffScroll` `VirtualListScrollHandle` with `Scrollbar.vertical("git-diff-y")`) rendering Before | stationary `40px` borderless connector gutter (`DIFF_WAVE_GUTTER_WIDTH`) | After lockstep per visible block. Both `#git-diff-col-headers` columns and `#git-diff-unified-x` monitor live width via `.on_size_change` (`updateDiffViewportWidth`, `> 4px` threshold, frame-coalesced via `scheduleDiffResizeReflow` `diffResizeTask`) and recompute wrap layouts whenever column character budgets change on resize—preserving single logical line numbers on sub-row `0` (leaving wrapped continuation rows blank), maintaining zero cumulative height drift (`sum(leftItems.height) === sum(rightItems.height) === sum(gutterItems.height) === sum(blockHeights) === totalHeight`), and stretching cubic Bezier wave ribbons seamlessly across wrapped Before/After blocks without horizontal scrolling. Equal-span `1:1` blocks paint a pure continuous horizontal `Background.linear_gradient(90, ...)` without top/bottom boundary strokes, while asymmetrical or single-sided blocks use soft `PathBuilder.stroke(1)` curves converging to a sharp pinched vertex (`leftTop === leftBot` / `rightTop === rightBot`) joined seamlessly to a `1px` spacer hairline.
   - **Unified** mode (`#git-mode-unified`) renders virtualized dual line-number rows inside the retained `GitDiffUnifiedView` (`#git-diff-unified-x`, lazily tokenizing visible rows via `tokenizeDeferredRow` with `oldMdState`/`newMdState` Markdown tracking via `./markdown-syntax.js` and computing exact wrapped row pixel heights via `computeUnifiedRowHeights`) wrapping `v_virtual_list("git-diff-unified-y", ...)` tracked by `this.uniScroll` (`VirtualListScrollHandle`) and `Scrollbar.vertical("git-diff-unified-y").viewport_from_layout()`, automatically reflowing row heights and keeping line numbers on sub-row `0` only on pane resize.
4. **On-Demand Rendered Markdown Preview (`#git-markdown-toggle`, `resolveHistoryMarkdownBlobSpec`, `loadViewerMarkdownNow`):**
   - `Side-by-Side` / `Unified` diff remains the default whenever opening the viewer, closing the viewer, or switching to a different commit or file; rendered mode (`viewerMarkdownRendered = true`) is preserved only when explicitly clicking `#git-diff-refresh` (`forceReload: true`) on the same repo+commit+file.
   - `#git-diff-toolbar` displays `renderMarkdownToggleButton` (`id: "git-markdown-toggle"`, `height: 24`, `rounded: 5`, `compact: compactViewer`) right beside `[Side-by-Side | Unified]` only when `isMarkdownFile(openFile.path || openFile)` is true. While `viewerMarkdownRendered === true`, `#git-diff-expand` (`Expand` / `Collapse`) is hidden and clicking `#git-mode-sbs` or `#git-mode-unified` deactivates rendered mode (`viewerMarkdownRendered = false`) while preserving the selected `diffMode`.
   - Toggling ON resolves the commit snapshot via `resolveHistoryMarkdownBlobSpec(diff, openFile)` (consuming `getDiffMarkdownPlan(file?.status)` from `./markdown-view-logic.js`): non-deleted entries (`A`, `M`, `R`, `C`, etc.) fetch `${commitHash}:${file.path}`; deleted entries (`status === "D"`) fetch `${parents[0]}:${file.oldPath || file.path}` with the deleted-file notice banner when a parent commit exists, or surface an unavailable error when no parent exists.
   - Blobs are loaded asynchronously on toggle ON using lock-free `READ_GIT` flags (`git show --no-textconv <rev>:<path>`), guarded against `viewerMarkdownGen`, `this.closed`, and current `fileIdentity`. Binary blobs (detected via `openFile.binary` or `\0` NUL bytes) and unreadable errors surface readable error text inside `renderMarkdownViewer`.
   - Raw blob snapshots/errors (`viewerMarkdownBlobCache`) and prepared `prepareMarkdownForRender` results (`createMarkdownRenderCache(16)`) are each bounded to `MAX_VIEWER_MARKDOWN_CACHE = 16` entries, invalidated on manual `#git-diff-refresh` (`forceReload`), and cleared on `closeViewer()` / `close()`. When active, the diff body is replaced by `renderMarkdownViewer(...)` with unique `id` and `scrollId` per repo+commit+file.

## Invariants

1. **Lock-Free Read-Only Git Invariant:**
   Every Git command executed via `exec("git", [...], { cwd, on })` MUST prepend:
   ```javascript
   export const READ_GIT = [
     "--no-optional-locks",
     "-c", "core.fsmonitor=false",
     "-c", "diff.autoRefreshIndex=false",
   ];
   ```
   and v1 MUST NOT invoke any Git command that mutates refs, index, or working tree state (including on-demand `git show --no-textconv <rev>:<path>` blob fetches for Markdown preview).
2. **Topological Lane Continuity Invariant:**
   Inside `computeCommitGraphLayout`, every active lane slot `l` at the end of row `r` MUST terminate at `(l, yBot)` on row `r` (via `passThroughLanes` or `outgoingEdges`) and enter row `r + 1` at `(l, yTop)` (via `passThroughLanes` or `incomingEdges`) with the exact same `colorIndex`.
3. **Single-Tab Reuse & Composite File Key Invariant:**
   At most one `git-history` viewer tab is spawned per space (`findGitDiffTabInSpace`), and commit files are keyed by `${commitHash}::${file.path}` (`makeCommitFileKey`) so switching commits or files never collides or leaks stale diff rows.
4. **Theme-Derived Colors & Syntax Highlighting:**
   Lane colors (`getLanePalette`), diff add/delete tints (`getDiffTheme`), ref badges (`buildRefBadgeColors`), and syntax tokens (`getDiffSyntaxPalette`, `diffSyntaxTokenColor`, capped at `MAX_DIFF_SYNTAX_LINE_CHARS = 500`) derive dynamically from `theme()`, `settings().colors`, and `layout().colors`.
5. **Pure Render, Zero `localStorage`, Visible-Only Throttling & Teardown:**
   No `localStorage`, no browser DOM APIs, and no synchronous `cx.notify()`, `setShared()`, or `set_value()` inside `render()`. When `#git` is hidden (`!isGitPanelVisible()`), `renderPanel` short-circuits immediately without querying workspace/tab state or building UI subtrees, flagging `needsRefreshOnShow` until revealed. Background polling (`30000ms`) and `.git` watchers (`watchSelectedRepoGitDir`, `WATCH_DEBOUNCE_MS = 800`, filtered by `shouldIgnoreGitWatchEvent`) likewise skip refreshes while hidden. `close()` sets `this.closed = true`, increments all generation counters (`repoDiscoverGen`, `logGen`, `commitFilesGen`, `viewerLoadGen`, `viewerMarkdownGen` via `closeViewer()`), clears bounded viewer caches (`viewerMarkdownBlobCache`, `markdownRenderCache`, `viewerPatchCache`), unregisters host state (`viewerHostsById`), cancels all task handles (`renderRefreshTask`, `watchDebounceTask`, `searchDebounceTask`, `agentTabSyncTask`, `sharedSyncTask`, `viewerLoadTask`, `diffResizeTask`, `pollTask`), stops watchers, and releases retained handles (`unifiedDiffPane`, `searchInput`, `commitsScroll`, `filesScroll`, `diffScroll`, `uniScroll`, `repoDropdownScroll`, `branchDropdownScroll`, and `handle`).
6. **Zero Idle Markdown Allocation & Bounded Blob Caching:**
   When `viewerMarkdownRendered === false` or a non-Markdown file is selected, `git-history` performs zero `git show` blob calls, zero `prepareMarkdownForRender` calls, and zero `TextView.markdown` allocations. All async `git show` completions verify monotonic `viewerMarkdownGen`, `!this.closed`, `this.viewerMarkdownRendered`, and unchanged `fileIdentity` before updating state or calling `cx.notify()`.
