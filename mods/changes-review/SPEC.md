---
id: submodule-mod-changes-review
type: submodule-design
status: active
title: Changes Review Mod (mods/changes-review)
parent: module-mods
references: [module-layouts, module-shared, spec-lifecycle]
covers: [git-diff-viewer, inline-review-comments, commit-history-inspection, agent-feedback-dispatch, multi-repo-discovery, service-filter-pills, cross-service-review, multi-repo-commits, per-service-branch-badges, per-tab-review-checklist, lead-terminal-dispatch, markdown-rendered-preview]
tags: [mod, git, code-review, agent-feedback, multi-repo, cognivisor, checklist]
---

## Responsibility

The `submodule-mod-changes-review` provides interactive source control inspection, visual Git diff analysis, session-attributed multi-repository microservice aggregation, per-service branch and organic status visibility, and human-in-the-loop agent feedback dispatch. Operating in two synchronized view modes sharing the same component—the docked `#changes` sidebar in the Herdr `#panel-body` stack and a single reusable non-terminal **Review tab** (`props.role === "viewer"`) opened in `#main`—it enables developers to scan changed files, review full-width diffs with inline review notes, approve individual files via the non-checkbox `Approve` / `Approved ✓` button (`#diff-viewed-btn`) with automatic advancement to the next unreviewed file inside the same Review tab, observe organic service pill status (`pending` | `has_notes` | `approved`) with automatic check invalidation on working-tree or commit changes, and transmit structured review notes directly to the session's lead AI agent (`leadTerminal`).

## Boundary

- **Owns:**
  - Manifest file: `mods/changes-review/mod.json` (`{ "place": "none", "title": "Changes Review" }`).
  - Dual-mode component: `mods/changes-review/main.js` (`renderPanel` for `#changes` sidebar, `renderViewer` for `role: "viewer"` Review tab in `#main`).
  - Pure diff, syntax lexer, file-type icon, session/tab/baseline resolution, fingerprint/invalidation, next-target selection, Markdown source/cache planning, & watch filter helpers: `mods/changes-review/review-logic.js`.
  - Synced shared modules (`[[module-shared]]`):
    - `mods/changes-review/code-wrap.js` (`computeWrapColumns`, `wrapPlainText`, `wrapStyledSpans`).
    - `mods/changes-review/markdown-syntax.js` (`isMarkdownExt`, `createMarkdownState`, `advanceMarkdownState`, `tokenizeMarkdownLine` — YAML frontmatter and fenced code block state tracking across diff hunks via `resetMdStateForLine`).
    - `mods/changes-review/markdown-view-logic.js` (`isMarkdownFile`, `resolveRelativeMarkdownPath`, `getDiffMarkdownPlan`).
    - `mods/changes-review/markdown-view.js` (`createMarkdownRenderCache`, `renderMarkdownToggleButton`, `renderMarkdownViewer`).
    - `mods/changes-review/dropdown-logic.js` & `mods/changes-review/dropdown.js` (`renderDropdownTrigger` for `#commit-selector-btn`, `renderDropdownPopover` for `#commit-dropdown-floating` with adaptive sizing via `computeDropdownMetrics`).
  - Icon assets: `mods/changes-review/changes.svg`, `mods/changes-review/icons/*.svg`, and `mods/changes-review/icons/file-types/*.svg` (22 vector file-type icons).
  - Type definitions and compiler configuration: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `changes-review` (docked panel when `props()?.role !== "viewer"`; full-pane Review tab when created with `props: { role: "viewer", spaceId, sourceTabId }`).
  - Layout slot: `#panel-body` child `changes` in `layouts/cognivisor.json`; `#main` tab via `run("tab.new" | "tab.rename" | "tab.select")`.
  - Host IPC: Outbound review notes dispatched through `hc(["send", agent.address, message])`.
  - Shared state bus:
    - Consumes and publishes `cognivisor.services` (with `sig` change key, `candidates` cache, and per-service `branch`/`workingCount`/`aheadCount`, `BUS_MAX_AGE_MS = 90000`).
    - Reads and writes `cognivisor.activeService` for synchronized service filtering across sidebar and Review tab.
    - Reads and defers updates to `cognivisor.spaceAgentTabs` (`Record<spaceId, tabId>`) recording the most recent terminal-bearing tab per space so session identity, flows, and agent resolution stay intact while the non-terminal Review tab is active.
    - Coordinates the active space's single Review tab via `changes-review.activeDiff` (`Record<spaceId, ActiveDiffState>` containing `spaceId`, `sourceTabId`, `workspaceRoot`, `on`, `viewMode`, `selectedCommit`, `activeService`, `openFileKey`, `openFile` with `buildFileDescriptor` preserving `sig`/`mtimeMs`, `files`, `allFiles`, `services`, `requestSeq`, `focusLine`, `openCommentLine`, `ts`).
    - Synchronizes inline review notes bidirectionally between the Review tab and docked `#changes` via `cognivisor.reviewNotes` (`Record<sessionKey, Array<ReviewNote>>` where `sessionKey = "${spaceId}::${sourceTabId || 'global'}"`).
    - Reads and updates `cognivisor.flows[sessionTabId]` (`reviewedFiles` per-file approval map storing `{ reviewed: true, fp, reviewedAt }`, `repoHeads` persisted per-repo `HEAD` map for cross-reload commit invalidation, `sessionRepos` attribution, and `sessionBaseline` session snapshot, preserving all sibling fields such as `leadTerminal`, `ticket`, `derivedTitle`, `manualTitle`).
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `v_virtual_list`, `VirtualListScrollHandle`, `InputState`, `Input`, `TextareaState`, `Textarea`, `TextView` (via `markdown-view.js`), `Scrollbar`, `ScrollHandle`.
  - `herdr`: `props`, `run`, `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `notify`, `hc`, `layout`, `shared`, `setShared`, `window`, `appHome`.
  - `fs/promises`, `path`: Local directory discovery, file statting (`size:mtimeMs`), and session baseline persistence under `${appHome()}/cognivisor/sessions/`.
- **Forbidden:**
  - Any usage of `localStorage` or browser DOM APIs.
  - Calling `cx.notify()`, `setShared()`, or mutating inputs synchronously inside `render()` (all refreshes, `viewerLoadedKey` diff fetches, `cognivisor.spaceAgentTabs` recordings, and cross-mode syncs run asynchronously via `cx.timer.after(0, ...)` or explicit interaction handlers).
  - Rendering the inline diff viewer (`#diff-file-review-bar`, `#changes-diff-lines`) inside the docked `#changes` sidebar.
  - Spawning duplicate Review tabs in the same space when one already exists (`findReviewTabInSpace` reuses, updates `changes-review.activeDiff`, `tab.rename`, and `tab.select`).
  - Executing git commands without `READ` safety flags (avoids `.git/index.lock` collisions with external editors and filesystem watchers).
  - Executing destructive git operations (`reset --hard`, `checkout -f`, `clean -fd`).
  - Hardcoded color hex values that ignore user `theme()`, `settings()`, or `layout()` palette configurations.
  - Resetting review notes, `key()`, or agent session state on service filter switches, Review-tab switches, or terminal pane focus changes.
  - Mutating or overwriting `cognivisor.flows[tabId].leadTerminal` or sibling flow fields outside explicit user actions.

## Architecture & Interaction Flow

```text
Docked Sidebar (#changes, role !== "viewer")          Main Review Tab (#review-tab-viewer, role === "viewer")
+--------------------------------------------+       +-------------------------------------------------------------------+
| Changes [N files] [Working Tree v] +12 -3  |       | [svc] [M] file.svg  path/to/file.ext +12 -3 [Working]            |
+--------------------------------------------+       | [<-][2/7][->] [3/7 ✓] [↻] [Approve] (or [Approved ✓])             |
| [ All ] [ o auth-api ] [ ✓ web-client ]    |       +-------------------------------------------------------------------+
| auth-api · feat/PROJ-412 (sole repo bar)   |       | Virtualized Wrapped Diff Viewer (#changes-diff-lines)               |
+--------------------------------------------+       |   Line 14  - console.log(prev);                                   |
| Changed Files List (#changes-list, flex_1) | ----> |   Line 14  + logger.info(next);   [Click row to comment]          |
|   [✓] M [auth-api] src/jwt.ts       +12 -3 | click |   +-------------------------------------------------------------+ |
|   [ ] A [web-client] LoginModal.tsx +45 -0 |       |   | Inline Comment Textarea -> shared("cognivisor.reviewNotes") | |
+--------------------------------------------+       |   +-------------------------------------------------------------+ |
| Review (N) | Commit                        |       +-------------------------------------------------------------------+
|   • [auth-api] jwt.ts:14 Verify log level  | <---- synced via cognivisor.reviewNotes[spaceId::sourceTabId]
|   [claude]      [Clear all] [Send to agent]|
+--------------------------------------------+
```

### Dual-Mode Review Tab Lifecycle

1. **Opening & Reuse (`pick` / `jumpToComment`):** Clicking any changed file in `#changes` records the space's active terminal tab in `cognivisor.spaceAgentTabs`, writes the target file/list/service snapshot to `changes-review.activeDiff[spaceId]` with an incremented `requestSeq`, and either creates one Review tab in `#main` (`run("tab.new", { space, name: formatReviewTabTitle(file), mod: "changes-review", props: { role: "viewer", spaceId, sourceTabId } })`) or reuses and focuses the existing Review tab (`findReviewTabInSpace`, `tab.rename`, `tab.select`). Clicking a review note in `#changes` similarly focuses the existing/new Review tab with `focusLine` and `openCommentLine` set to scroll to and open that inline comment editor.
2. **Deferred Diff Loading (`viewerLoadedKey`):** Inside `renderViewer`, comparing `computeViewerLoadedKey(diff)` (`requestSeq`, `openFileKey`, `viewMode`, `commitHash`, `expanded`) against `viewerLoadedKey` schedules `loadViewerDiffNow` asynchronously via `cx.timer.after(0, ...)`. Explicit navigation (`←`/`→`, `↻`, `Approve` / `Approved ✓`, `Expand context`) loads the diff immediately while updating `viewerLoadedKey` cleanly.
3. **File-Level `Approve` / `Approved ✓` & Organic Service Pill Status:**
   - **File level (`#diff-viewed-btn` in Review tab & `#file-check-*` in `#changes`):** Clicking the non-checkbox `Approve` button (`#diff-viewed-btn`, displaying `Approved ✓` or compact `Approved` when already approved) toggles `reviewed` for the current file in `cognivisor.flows[sourceTabId].reviewedFiles` (`{ reviewed: true, fp: computeFileReviewFingerprint(file), reviewedAt: Date.now() }`). When newly approved, `toggleViewerFileReviewed` selects the next unreviewed file via `pickNextUnreviewedFile`, updates `changes-review.activeDiff[spaceId]`, renames the same Review tab via `tab.rename`, and loads its diff immediately without opening another tab. Checkbox clicks (`#file-check-*`) in `#changes` remain non-jumping batch toggles (`applyFileReviewToggle`).
   - **Organic service pill status (`getServiceReviewStatus`):** Service pills (`#service-pill-*`) do NOT use a manual service-approval button; status is derived organically from `cognivisor.reviewNotes` (`"has_notes"` `✎` when any session note belongs to `serviceId`), else `"approved"` (`✓`) ONLY when dirty working files exist for `serviceId` and every working file in that service is reviewed, else `"pending"` (`○`).
   - **Automatic check invalidation (`computeFileReviewFingerprint`, `reconcileReviewedFiles`, `headHash`, `buildFileDescriptor`):** `buildFileDescriptor` preserves `sig` and `mtimeMs` on file descriptors so `computeFileReviewFingerprint` (`status|add|del|fresh|binary|sig|mtimeMs`) detects re-edits reliably. On working refresh, `loadServiceWorkingSnapshot` returns `headHash`, persists per-repo `HEAD` hashes (`repoHeads` inside `cognivisor.flows[sessionTabId]`), detects `HEAD` transitions (`lastRepoHeads` / persisted `repoHeads`) and newer commits modifying reviewed files via `collectCommitInvalidations`, and `reconcileReviewedFiles` automatically clears un-fingerprinted legacy checks plus stale `working::` checks (when a file leaves the working tree, is committed, or changes fingerprint `fp !== curFp`) and stale `commit:<hash>::` checks superseded by newer commits (`committedSet` or `commitMs > reviewedAt`).
4. **Comment Composition & Synchronization (`cognivisor.reviewNotes`):** Inline comments added, updated, or deleted in the Review tab write directly to `shared("cognivisor.reviewNotes")[getSessionNotesKey(spaceId, sourceTabId)]` (reflected automatically as `"has_notes"` on `#service-pill-*`). `#changes` renders the synchronized note list (`Review (N)`), supports `jumpToComment`, individual deletion (`removeComment`), `Clear all`, and Markdown dispatch (`Send to agent` via `findActiveAgent()` resolved against `sessionTabId`).
5. **On-Demand Markdown Rendered Preview (`#diff-markdown-toggle`, `resolveReviewMarkdownSourceSpec`, `renderMarkdownViewer`):**
   - **Default Diff Mode & Toggle Button:** Diff view remains the default whenever opening a Review tab, switching to another file (via `#changes-list`, `←`/`→`, `Approve` advancing, relative link navigation, or `jumpToComment` targeting a line comment), switching between working tree and commits, or closing the viewer; toggle state (`viewerMarkdownRendered`) is preserved only when reloading/refreshing the same file in the same mode. `#diff-file-review-bar` shows `renderMarkdownToggleButton` (`id: "diff-markdown-toggle"`) alongside `#diff-reload-btn` and `#diff-viewed-btn` ONLY when `isMarkdownFile(openFile.path || openFile.displayPath)` is true.
   - **Zero Idle Allocation & Lazy Snapshot Loading:** When toggled OFF, zero extra file or git reads, zero `prepareMarkdownForRender` calls, and zero `TextView.markdown` elements are allocated. When toggled ON, `loadViewerMarkdownNow` consults `resolveReviewMarkdownSourceSpec` (which consumes `getDiffMarkdownPlan(status)`): working-tree non-deleted files read asynchronously via `readTextFile`; working-tree deleted files (`status === "D"`) run lock-free `git show HEAD:<oldPath || path>` with the deleted-file notice banner (or show a clear unavailable error when untracked / missing from `HEAD`); commit-mode non-deleted files run lock-free `git show <commitHash>:<path>`; and commit-mode deleted files run lock-free `git show <commitHash>^:<oldPath || path>` with the deleted-file notice banner and readable root-commit/missing-parent handling. All loaded content checks for binary NUL bytes (`validateMarkdownTextContent`) and memoizes raw snapshots and prepared Markdown in bounded 16-entry LRU caches (`viewerMarkdownRawCache` + `createMarkdownRenderCache(16)`) keyed by repo/commit/file/status/loadToken, invalidating stale entries on explicit manual reload (`#diff-reload-btn`) and guarding async callbacks against stale `viewerMarkdownLoadGen`, switched files, or closed viewers (`_viewerClosed`).
   - **Body & Review Compatibility:** When rendered mode is active, `renderMarkdownViewer` replaces `v_virtual_list("changes-diff-lines")` with unique `id`/`scrollId` per file+revision (`monoFont`, `noticeBanner`, `loading`, `error`, relative diff-file link navigation), clears/hides the active inline line-comment composer (`activeComment`) so `TextView.markdown` does not collide with diff line commenting, and keeps `Approve` / `Approved ✓`, file count pill, and existing review note counts intact.

### Review Dispatch Sequence

1. **Comment Composition:** Clicking any diff line in the Review tab opens the inline `TextareaState` editor; saving persists `{ fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, text, snippet }` into `shared("cognivisor.reviewNotes")[sessionKey]` and marks the service `"has_notes"`.
2. **Payload Generation:** Clicking "Send to agent" in `#changes` formats uncommitted or commit-scoped Markdown grouped by `### Service: ${serviceName} (${repoRoot})` with ``- `${displayPath}:${line}`:`` and diff snippets.
3. **Transmission:** Resolves target via `findActiveAgent()` (using `sessionTabId = resolveSessionAgentTabId(...)` so viewing the non-terminal Review tab never loses `leadTerminal`) and invokes `await hc(["send", agent.address, message])`.
4. **Completion:** On zero exit code, shows `notify({ title: "Review notes sent to agent", level: "success" })` and clears the session's `cognivisor.reviewNotes` entry and `"has_notes"` service flags.

## Invariants

1. **Lock-Free Read Operations:**
   All read-only `git` commands executed via `exec("git", [...])` MUST prepend the flag array:
   ```javascript
   const READ = [
     "--no-optional-locks",
     "-c", "core.fsmonitor=false",
     "-c", "diff.autoRefreshIndex=false"
   ];
   ```
   *Rationale:* This prevents Git from touching timestamps in the index or creating lock files, which would trip the `watchFolder` listener and trigger a perpetual re-render cascade.
2. **Virtual Pre-Tokenized Diff Rendering & Shared Markdown State:**
   Diff lines are pre-processed once inside `diffRows(lines, filePath)` into numbered metadata objects with linear single-pass syntax tokens (`tokenizeDiffLine`, capped at `MAX_DIFF_SYNTAX_LINE_CHARS = 1600` per line, separating `annotation`, `keyword`, `type`, `function`, `string`, `string.escape`, `number`, `boolean`, `constant`, `variable`, `operator`, and `comment` across Java/Spring Boot, Python, JavaScript, YAML, JSON, and `.properties`, and delegating `.md`/`.mdx` files to shared `./markdown-syntax.js` with `createMarkdownState`, `advanceMarkdownState`, `tokenizeMarkdownLine`, and `resetMdStateForLine` for YAML frontmatter and fenced code block state tracking across `oldMdState`/`newMdState` diff hunks), keeping `diffRow()` allocation-light during scroll/re-renders.
3. **Theme Dynamic Adaptation & Diff + Syntax Color Layering:**
   Diff additions and deletions preserve unambiguous diff markers—background tint (`hexWithAlpha` from `theme().diff_add` / `theme().diff_del` or ANSI fallback tokens), left accent border, `+`/`-` gutter glyph, and colored line number—while rendering code content through `getDiffSyntaxPalette` / `diffSyntaxTokenColor` with luminance-guarded `theme()` syntax tokens across both light and dark themes.
4. **Composite File Keys & Session Note Keys:**
   All internal file references (`openFileKey`, `expandedFiles`, `reviewedFiles`, `cognivisor.reviewNotes`) index files via composite `${serviceId}::${path}` keys and scope review notes via `getSessionNotesKey(spaceId, sourceTabId)` (`"${spaceId}::${sourceTabId}"`) to prevent cross-service and cross-session collision.
5. **Zero `localStorage` & Non-Reentrant Shared Updates:**
   Never call `localStorage`, `cx.notify()`, or `setShared()` synchronously inside `render()`. Defer refreshes, `cognivisor.spaceAgentTabs` updates, `viewerLoadedKey` diff fetches, and cross-mode syncs via `cx.timer.after(0, ...)`. Keep `cognivisor.services` deduplicated via `sig` and merge `cognivisor.flows[sessionTabId]` mutations onto the latest snapshot.
6. **Stale-Context Cancellation & Cleanup:**
   Async flows (`refresh`, `loadViewerDiffNow` via monotonic `viewerLoadGen`, `loadViewerMarkdownNow` via monotonic `viewerMarkdownLoadGen` and `_viewerClosed`, watchers) validate context/generation across awaits, and `close()` cancels all active tasks (`renderRefreshTask`, `watchDebounceTask`, `agentTabSyncTask`, `sharedSyncTask`, `viewerLoadTask`, `diffResizeTask`, `pollTask`), resets and clears bounded Markdown caches, and releases `input`, `commentInput`, `serviceFilterScroll`, `commitDropdownScroll`, and `diffScroll`.

## Multi-Repo & Cognivisor Implementation

### Workspace Root Anchoring (`location`, `resolveWorkspaceRoot`) & Session Preservation (`resolveSessionAgentTabId`)
The workspace root anchors to `space.folder` via `resolveWorkspaceRoot` whenever `pane.cwd` equals or lies inside `space.folder`, except when `space.folder` points to a user home directory (`isHomeDirectoryRoot`, e.g., `$HOME` or `/Users/<name>`) and `pane.cwd` targets a deeper project directory — in which case `pane.cwd` becomes the workspace root so `$HOME` never leaks unrelated home folders or sibling projects. When the active tab is a non-terminal Review or File tab, `location()` and `getActiveSpaceAndTab()` resolve `sessionTabId = resolveSessionAgentTabId(space, allPanes, shared("cognivisor.spaceAgentTabs"))` and prefer panes matching `sessionTabId` with `cwd`. State cache identity `key()` keys by `{ cwd: loc.cwd, on: loc.on, spaceId: loc.spaceId, tabId: loc.tabId }` (where `tabId` is `sessionTabId`), preventing Review-tab focus switches from resetting workspace/agent state while still isolating per-agent-tab sessions.

### Multi-Repository Discovery & Session Attribution (`discoverRepos`, `filterUnbaselinedRepoEntries`)
Scans `workspaceRoot` up to depth 2 (`$root/*` and `$root/*/*`) using `fs/promises` on local workspaces (and POSIX/PowerShell over SSH when `on` is set), plus parent/sibling discovery for single-repo workspaces and active-tab `pane.cwd` paths (`extraCwds` scoped strictly to `sessionTabId`, never unrelated tabs), caching candidates for `REPO_CACHE_TTL_MS = 60000`. Shared `loadServiceWorkingSnapshot` queries `git status --porcelain=v1 -b -z --no-renames --untracked-files=normal` (expanding `?? dir/` via `git ls-files --others --exclude-standard -z`) and `numstat` in lock-free passes per repo, updating touched repositories on `cognivisor.flows[sessionTabId].sessionRepos` and publishing empty results when `sessionTabId` is unresolved.

### Strict Session-Scoped Filtering (`sessionBaseline`, `filterSessionWorkingEntries`, `filterSessionCommits`)
Both `#changes` and `#review-tab-viewer` are strictly session-scoped with no global repository toggle, rendering `"No changes in this session yet"` when no session-scoped modifications exist:
- **Baseline Resolution & Restart Persistence:** `resolveOrInitSessionBaseline` reads `cognivisor.flows[sessionTabId].sessionBaseline` (validating `workspaceRoot` consistency), falling back to `${appHome()}/cognivisor/sessions/tabs/<safeTabId>.json` (validated against `workspaceRoot`) and strict command-line `/resume` terminal detection via `${appHome()}/cognivisor/sessions/resume/<hash>.json` (ignoring paths, banners, or help text). If no baseline exists yet, it initializes `version: 1`, `startedAt = Date.now()`, `workspaceRoot`, and `repos[normRoot].dirtyFiles` from the initial working snapshot and persists to both `cognivisor.flows[sessionTabId]` and disk.
- **Working Tree Filtering:** Local dirty files are inspected via unified `statFileEntry` (`size:mtimeMs` `sig` when `stat` is available, or raw-byte `${len}:b${hex}` hash handling binary files safely and `dir:<status>` for directories/submodules when `stat` is unavailable) with normalized status marks (`normalizeGitStatusMark`). `filterSessionWorkingEntries` excludes entries matching `baselineRepo.dirtyFiles[relFile]` (`status` and `sig`) and surfaces re-edited or newly modified files; when `baselineRepo` is absent, `filterUnbaselinedRepoEntries` includes entries with `mtimeMs >= startedAt` when `stat` timestamps exist, or requires session attribution (`sessionRepos`, active-tab `pane.cwd`, `repoMatchesTranscript`, or session commits) when `mtimeMs === 0`, backfilling un-attributed pre-existing dirty files into `sessionBaseline.repos`.
- **Commit Filtering:** `filterSessionCommits` restricts `#commit-selector-btn` commits to `Number(c.timestamp || 0) >= Math.floor(startedAt / 1000)`, excluding pre-session commits. `loadServiceWorkingSnapshot` / `collectServiceWorkingSnapshot` always loads lock-free commit history even when a repository's working tree is clean and `aheadCount === 0` (e.g., immediately after commit and push) so pushed session commits remain selectable alongside `Working Tree`.

### Shared Bus Synchronization (`cognivisor.services`, `cognivisor.activeService`, `changes-review.activeDiff`, `cognivisor.reviewNotes`, `cognivisor.spaceAgentTabs`)
Consumes `cognivisor.services` published by `files-search` (`BUS_MAX_AGE_MS = 90000`, `sig`-matched to ignore heartbeat-only `ts` ticks when unchanged), merges `bus.candidates` with `bus.services` via `mergeBusCandidateServices` instead of short-circuiting on empty `bus.services`, and publishes updates only when topology/branch/dirty signature changes. Active service filter state (`"all"` or a specific `serviceId`) synchronizes bidirectionally over `cognivisor.activeService`. `changes-review.activeDiff` and `cognivisor.reviewNotes` coordinate the single reusable Review tab and inline comment state without duplicating git scans inside `#main`.

### Service Filter Bar, Commit Selector Dropdown & Per-File Approval (`cognivisor.flows`)
- **Session Tab Identification:** Resolves `sessionTabId = resolveSessionAgentTabId(activeSpace, allPanes, shared("cognivisor.spaceAgentTabs"))` and reads `shared("cognivisor.flows")?.[sessionTabId] || {}`.
- **Organic Status Resolution (`getServiceReviewStatus`):** Each service resolves to `"has_notes"` if any note in `shared("cognivisor.reviewNotes")[sessionKey]` belongs to `serviceId`, else `"approved"` ONLY when dirty working files exist for `serviceId` and every working file in that service is reviewed in `flow.reviewedFiles`, else `"pending"`.
- **Service Filter Pills & Sole-Repo Bar:** Multi-service workspaces render `#service-filter-bar` sorted via `sortServicesDirtyFirst` (dirty-first, then alphabetically), displaying status glyph (`✓`, `✎`, `○`), service name, compact `service.branch` badge, and dirty count. Single-repo workspaces render a compact read-only `#microservice-review-bar` (`${svc.name} · ${branchLabel}`).
- **Commit Selector Dropdown (`./dropdown.js`):** Renders `#commit-selector-btn` via `renderDropdownTrigger` and `#commit-dropdown-floating` via `renderDropdownPopover` (backed by `computeDropdownMetrics`), shrink-wrapping cleanly for short lists and enabling scrolling (`commitDropdownScroll`) only when overflowing `maxHeight = 320`.
- **Per-File Review Checklist, File-Type Icons & `Approve` / `Approved ✓` Button (`reviewedFiles`, `#file-check-*`, `#diff-file-review-bar`, `#diff-viewed-btn`):** File rows in `#changes-list` fill the docked panel above the bottom `Review | Commit` drawer and render interactive checkboxes (`✓`), composite scope keys (`working::<serviceId>::<path>` or `commit:<hash>::<serviceId>::<path>` storing `{ reviewed: true, fp, reviewedAt }`), and `resolveDiffFileIcon(file.path, t)` SVGs. In `#main`'s Review tab, `#diff-file-review-bar` shows service badge, status, icon, `displayPath`, `+add`/`−del`, `Working` / commit short hash badge, Prev/Next (`←`/`→`) file navigation + position counter, `N/M ✓` progress badge, `↻` reload, and the non-checkbox `Approve` / `Approved ✓` button (`#diff-viewed-btn`, advancing via `pickNextUnreviewedFile` in the same Review tab). Stale checks are automatically invalidated on refresh via `computeFileReviewFingerprint` and `reconcileReviewedFiles` using `buildFileDescriptor` (`sig`/`mtimeMs`) and `headHash` commit tracking.
- **Responsive Soft-Wrapped Diff Rendering & Virtual Scrolling (`#changes-diff-lines`):** Inside `#review-tab-viewer`, `#changes-diff-lines` is rendered via `v_virtual_list("changes-diff-lines", ...)` tracked by `VirtualListScrollHandle` (`this.diffScroll`) with list-level `.on_item_click` delegation (`@` hunk context toggle and line comment targeting), monitoring live container width via `.on_size_change` (`diffViewportWidth`, threshold `> 4px`, column-change coalesced via `scheduleDiffResizeReflow` `diffResizeTask`) and computing `computeWrapColumns`, deterministic memoized per-row heights via `countWrappedLines` + wrapped comment heights (`getWrappedCommentLines`), and `WeakMap`-cached wrapped segments via shared `code-wrap.js` (`wrapPlainText`, `wrapStyledSpans`). Both hunk headers and code/syntax-highlighted diff lines automatically wrap onto continuation sub-rows whenever resized narrower or wider while only sub-row `0` renders the line number and `+`/`-` gutter sign (continuation sub-rows keep blank gutters and inherit continuous background tint, border accent, and click-to-comment targeting while `scroll_to_item(rowIdx)` preserves logical row indexing), eliminating horizontal scrollbars and diagonal wheel drift; active comment composition (`Textarea` + `Delete`/`Cancel`/`Save`) renders in a docked `#review-comment-composer` bar below `#changes-diff-lines` outside the virtual-list layout callback, while saved notes continue rendering inline beneath commented rows and `Scrollbar.vertical("changes-diff-lines").viewport_from_layout()` pins the vertical scrollbar cleanly to the right edge.

### Lead-Terminal-Prioritized Agent Resolution (`findActiveAgent`)
Resolves the target agent against `sessionTabId` strictly in priority order:
1. `cognivisor.flows[sessionTabId]?.leadTerminal` matched in `agents()` or live `terminals()`.
2. `focused()?.agent` matched in `agents()` (excluding terminals labeled `cognivisorRunner === "true"`).
3. Non-runner agent in `sessionTabId` across `panes()`, `terminals()`, and `agents()` (excluding `labels?.cognivisorRunner === "true"`).
4. Any agent in `sessionTabId`.
5. `agents()[0]` global fallback.

### Multi-Repository Batch Commits
In `All` mode, committing executes `git add -A` and `git commit -m message` sequentially across all services with dirty working trees (`workingCount > 0`). When a specific service is filtered, only that service is committed. Button copy dynamically displays `Commit (${targetRepos.length} repos)` when multiple services are dirty.
