---
id: submodule-mod-changes-review
type: submodule-design
status: active
title: Changes Review Mod (mods/changes-review)
parent: module-mods
references: [module-layouts, module-shared, spec-lifecycle]
covers: [git-diff-viewer, unified-session-diff, origin-base-branch-resolution, inline-review-comments, agent-feedback-dispatch, multi-repo-discovery, strict-session-repo-attribution, cross-service-review, per-tab-review-checklist, commit-resilient-approvals, lead-terminal-dispatch, markdown-rendered-preview]
tags: [mod, git, code-review, agent-feedback, multi-repo, cognivisor, checklist, unified-diff]
---

## Responsibility

The `submodule-mod-changes-review` provides interactive source control inspection, unified origin-branch Git diff analysis, strict session-attributed multi-repository aggregation, commit-resilient per-file review approval, and human-in-the-loop agent feedback dispatch. Operating in two synchronized view modes sharing the same component—the docked `#changes` sidebar in the Herdr `#panel-body` stack and a single reusable non-terminal **Review tab** (`props.role === "viewer"`) opened in `#main`—it merges all committed, staged, unstaged, and untracked session modifications relative to each repository's origin/base branch (`merge-base HEAD <originBaseRef>`) into one deduplicated file list across only the repositories touched in the active session (distinguished by per-file `[serviceName]` badges without a repo filter bar or commit picker), lets developers inspect full-width soft-wrapped diffs with side-aware inline review notes, approve files via the non-checkbox `Approve` / `Approved ✓` button (`#diff-viewed-btn`) with automatic advancement to the next unreviewed file and persistence across `git commit`, commit visible dirty working-tree files safely via the bottom `Commit` drawer, and transmit structured review notes directly to the session's lead AI agent (`leadTerminal`).

## Boundary

- **Owns:**
  - Manifest file: `mods/changes-review/mod.json` (`{ "place": "none", "title": "Changes Review" }`).
  - Dual-mode component: `mods/changes-review/main.js` (`renderPanel` for `#changes` sidebar, `renderViewer` for `role: "viewer"` Review tab in `#main`).
  - Pure diff, base-branch resolution, unified session snapshot, syntax lexer, file-type icon, session/tab/baseline resolution, strict attribution, commit-resilient fingerprint/invalidation, side-aware comment keys, next-target selection, Markdown source/cache planning, & watch filter helpers: `mods/changes-review/review-logic.js`.
  - Synced shared modules (`[[module-shared]]`):
    - `mods/changes-review/code-wrap.js` (`computeWrapColumns`, `wrapPlainText`, `wrapStyledSpans`).
    - `mods/changes-review/code-syntax.js` (`tokenizeCodeLine`, `getDiffSyntaxPalette`, `diffSyntaxTokenColor`, `expandCodeTabs`).
    - `mods/changes-review/markdown-syntax.js` (`isMarkdownExt`, `createMarkdownState`, `advanceMarkdownState`, `tokenizeMarkdownLine` — YAML frontmatter and fenced code block state tracking across diff hunks and expanded context gaps).
    - `mods/changes-review/markdown-view-logic.js` (`isMarkdownFile`, `resolveRelativeMarkdownPath`, `getDiffMarkdownPlan`).
    - `mods/changes-review/markdown-view.js` (`createMarkdownRenderCache`, `renderMarkdownToggleButton`, `renderMarkdownViewer`).
    - `mods/changes-review/diagnostics-logic.js` & `mods/changes-review/diagnostics.js` (`createModLogger`, `renderErrorFallbackCard` for non-reentrant render error boundaries, user-action breadcrumbs, and JSON report export).
  - Icon assets: `mods/changes-review/changes.svg`, `mods/changes-review/icons/*.svg`, and `mods/changes-review/icons/file-types/*.svg` (22 vector file-type icons).
  - Type definitions and compiler configuration: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `changes-review` (docked panel when `props()?.role !== "viewer"`; full-pane Review tab when created with `props: { role: "viewer", spaceId, sourceTabId }`).
  - Layout slot: `#panel-body` child `changes` in `layouts/cognivisor.json`; `#main` tab via `run("tab.new" | "tab.rename" | "tab.select")`.
  - Host IPC: Outbound review notes dispatched through `hc(["send", "--json", agent.address, message])` with bounded submit-key verification.
  - Shared state bus:
    - Consumes and publishes `cognivisor.services` (with `sig` change key, `candidates` cache, and per-service `branch`/`workingCount`/`aheadCount`, `BUS_MAX_AGE_MS = 90000`), never overwriting the bus with `[]` when `sessionTabId` is transiently unresolved.
    - Does NOT read or write `cognivisor.activeService` (renders all session-touched repositories in a single unified panel).
    - Reads and defers updates to `cognivisor.spaceAgentTabs` (`Record<spaceId, tabId>`) recording the most recent terminal-bearing tab per space so session identity, flows, and agent resolution stay intact while the non-terminal Review tab is active.
    - Coordinates the active space's single Review tab via `changes-review.activeDiff` (`Record<spaceId, ActiveDiffState>` containing `spaceId`, `sourceTabId`, `workspaceRoot`, `on`, `openFileKey`, `openFile` with `buildFileDescriptor` preserving `sig`/`mtimeMs`/`baseRef`/`baseHash`/`headHash`/`hasHead`, `files`, `services`, `requestSeq`, `focusLine`, `focusSide`, `openCommentLine`, `openCommentSide`, `ts`).
    - Synchronizes inline review notes bidirectionally between the Review tab and docked `#changes` via `cognivisor.reviewNotes` (`Record<sessionKey, Array<ReviewNote>>` where `sessionKey = "${spaceId}::${sourceTabId || 'global'}"` and each note carries `side: "old" | "new"` alongside `line`).
    - Reads and updates `cognivisor.flows[sessionTabId]` (`reviewedFiles` per-file approval map storing `{ reviewed: true, fp, reviewedAt }` under `session::<serviceId>::<path>`, `baselineRev` monotonic integer for cross-mod disk baseline cache coherence, `sessionStartedAt`, and `sessionRepos` attribution, preserving all sibling fields such as `leadTerminal`, `ticket`, `derivedTitle`, `manualTitle`).
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`, `TextareaState`, `Textarea`, `TextView` (via `markdown-view.js`), `Scrollbar`, `ScrollHandle`.
  - `herdr`: `props`, `run`, `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `notify`, `hc`, `layout`, `shared`, `setShared`, `window`, `appHome`.
  - `fs/promises`, `path`: Local directory discovery, file statting (`size:mtimeMs`), untracked line counting, and session baseline persistence under `${appHome()}/cognivisor/sessions/`.
- **Forbidden:**
  - Any usage of `localStorage` or browser DOM APIs.
  - Calling `cx.notify()`, `setShared()`, or mutating inputs synchronously inside `render()` (all refreshes, `viewerLoadedKey` diff fetches, `cognivisor.spaceAgentTabs` recordings, and cross-mode syncs run asynchronously via `cx.timer.after(0, ...)` or explicit interaction handlers).
  - Rendering the inline diff viewer (`#diff-file-review-bar`, `#changes-diff-lines`) inside the docked `#changes` sidebar.
  - Rendering commit-history picker dropdowns (`#commit-selector-btn`, `#commit-dropdown-floating`) or repository filter/summary strips (`#service-filter-bar`, `#microservice-review-bar`) inside `#changes`.
  - Spawning duplicate Review tabs in the same space when one already exists (`findReviewTabInSpace` reuses, updates `changes-review.activeDiff`, `tab.rename`, and `tab.select`).
  - Executing git commands without `READ` safety flags (avoids `.git/index.lock` collisions with external editors and filesystem watchers).
  - Executing `git add -A` in the bottom `Commit` drawer (MUST stage only explicit visible dirty working-tree paths via `git add -- <paths>`).
  - Executing destructive git operations (`reset --hard`, `checkout -f`, `clean -fd`).
  - Hardcoded color hex values that ignore user `theme()`, `settings()`, or `layout()` palette configurations.
  - Resetting review notes, `key()`, or agent session state on Review-tab switches or auxiliary split-pane focus changes.
  - Mutating or overwriting `cognivisor.flows[tabId].leadTerminal` or sibling flow fields outside explicit user actions.

## Architecture & Interaction Flow

```text
Docked Sidebar (#changes, role !== "viewer")          Main Review Tab (#review-tab-viewer, role === "viewer")
+--------------------------------------------+       +--------------------------------------------------------------------+
| Changes [N files] [M/N ✓]          +84 -19 |       | [auth-api] [M] file.svg  path/to/file.ext +12 -3 [vs origin/main]  |
+--------------------------------------------+       | [<-][2/7][->] [3/7 ✓] [MD] [↻] [Approve] (or [Approved ✓])         |
| (If pre-existing hidden > 0):              |       +--------------------------------------------------------------------+
| 2 files hidden as pre-existing [Show][Rst] |       | Virtualized Wrapped Unified Diff Viewer (#changes-diff-lines)      |
+--------------------------------------------+       |   Line 14  - console.log(prev);   [old side comment]               |
| Unified Changed Files List (#changes-list) | ----> |   Line 14  + logger.info(next);   [new side comment]               |
|   [✓] M [auth-api]   src/jwt.ts    +12 -3  | click |   +--------------------------------------------------------------+ |
|   [ ] A [web-client] LoginModal.ts +45 -0  |       |   | Docked Comment Composer -> shared("cognivisor.reviewNotes")  | |
+--------------------------------------------+       |   +--------------------------------------------------------------+ |
| Review (N) | Commit                        |       +--------------------------------------------------------------------+
|   • [auth-api] jwt.ts:14 Verify log level  | <---- synced via cognivisor.reviewNotes[spaceId::sourceTabId]
|   [claude]      [Clear all] [Send to agent]|
+--------------------------------------------+
```

### Dual-Mode Review Tab Lifecycle

1. **Opening & Reuse (`pick` / `jumpToComment`):** Clicking any changed file in `#changes` records the space's active terminal tab in `cognivisor.spaceAgentTabs`, writes the target file/list/service snapshot to `changes-review.activeDiff[spaceId]` with an incremented `requestSeq`, and either creates one Review tab in `#main` (`run("tab.new", { space, name: formatReviewTabTitle(file), mod: "changes-review", props: { role: "viewer", spaceId, sourceTabId } })`) or reuses and focuses the existing Review tab (`findReviewTabInSpace`, `tab.rename`, `tab.select`). Clicking a review note in `#changes` similarly focuses the existing/new Review tab with `focusLine`, `focusSide`, `openCommentLine`, and `openCommentSide` set to scroll to and open that inline comment editor.
2. **Deferred Diff Loading (`viewerLoadedKey`):** Inside `renderViewer`, comparing `computeViewerLoadedKey(diff)` (`requestSeq`, `openFileKey`, `baseHash`, `expanded`) against `viewerLoadedKey` schedules `loadViewerDiffNow` asynchronously via `cx.timer.after(0, ...)`. Explicit navigation (`←`/`→`, `↻`, `Approve` / `Approved ✓`, `Expand context`) loads the diff immediately while updating `viewerLoadedKey` cleanly.
3. **Commit-Resilient File-Level `Approve` / `Approved ✓`:**
   - **File level (`#diff-viewed-btn` in Review tab & `#file-check-*` in `#changes`):** Clicking the non-checkbox `Approve` button (`#diff-viewed-btn`, displaying `Approved ✓` or compact `Approved` when already approved) toggles `reviewed` for the current file in `cognivisor.flows[sourceTabId].reviewedFiles` under `session::<serviceId>::<path>` (`{ reviewed: true, fp: computeFileReviewFingerprint(file), reviewedAt: Date.now() }`). When newly approved, `toggleViewerFileReviewed` selects the next unreviewed file via `pickNextUnreviewedFile`, updates `changes-review.activeDiff[spaceId]`, renames the same Review tab via `tab.rename`, and loads its diff immediately without opening another tab. Checkbox clicks (`#file-check-*`) in `#changes` remain non-jumping batch toggles (`applyFileReviewToggle`).
   - **Commit-resilient invalidation (`computeFileReviewFingerprint`, `reconcileReviewedFiles`, `buildFileDescriptor`):** `computeFileReviewFingerprint` hashes `${status}|${add}|${del}|${binary ? 1 : 0}|${baseHash}|${sig}` (normalizing out untracked-vs-staged `fresh` so `git add` / `git commit` without file edits preserves `Approved ✓`!). `reconcileReviewedFiles` checks against all unified session files (so toggling `Show all` / `Session only` does not discard approvals), clearing checks only when a file leaves the unified diff, changes content fingerprint (`fp !== curFp`), or changes `baseHash`.
4. **Side-Aware Comment Composition & Synchronization (`cognivisor.reviewNotes`):** Inline comments added, updated, or deleted in the Review tab carry `side: "old" | "new"` (matching deleted vs added/context rows) and write directly to `shared("cognivisor.reviewNotes")[getSessionNotesKey(spaceId, sourceTabId)]`. `commentMap` keys by `buildCommentKey(fileKey, line, side)` so deleted line `N` and added line `N` never collide. `#changes` renders the synchronized note list (`Review (N)`), supports `jumpToComment`, individual deletion (`removeComment`), `Clear all`, and Markdown dispatch (`Send to agent` via `findActiveAgent()` resolved against `sessionTabId`).
5. **On-Demand Markdown Rendered Preview (`#diff-markdown-toggle`, `resolveReviewMarkdownSourceSpec`, `renderMarkdownViewer`):**
   - **Default Diff Mode & Toggle Button:** Diff view remains the default whenever opening a Review tab, switching to another file (via `#changes-list`, `←`/`→`, `Approve` advancing, relative link navigation, or `jumpToComment` targeting a line comment), or closing the viewer; toggle state (`viewerMarkdownRendered`) is preserved only when reloading/refreshing the same file. `#diff-file-review-bar` shows `renderMarkdownToggleButton` (`id: "diff-markdown-toggle"`) alongside `#diff-reload-btn` and `#diff-viewed-btn` ONLY when `isMarkdownFile(openFile.path || openFile.displayPath)` is true.
   - **Zero Idle Allocation & Lazy Snapshot Loading:** When toggled OFF, zero extra file or git reads, zero `prepareMarkdownForRender` calls, and zero `TextView.markdown` elements are allocated. When toggled ON, `loadViewerMarkdownNow` consults `resolveReviewMarkdownSourceSpec` (which consumes `getDiffMarkdownPlan(status)`): non-deleted files read asynchronously from the working tree via `readTextFile`; deleted files (`status === "D"`) run lock-free `git show <file.baseHash || "HEAD">:<oldPath || path>` with the deleted-file notice banner (handling committed deletions that no longer exist in `HEAD`, or showing a clear unavailable error when untracked / unborn). All loaded content checks for binary NUL bytes (`validateMarkdownTextContent`) and memoizes raw snapshots and prepared Markdown in bounded 16-entry LRU caches (`viewerMarkdownRawCache` + `createMarkdownRenderCache(16)`), invalidating stale entries on explicit manual reload (`#diff-reload-btn`) and guarding async callbacks against stale `viewerMarkdownLoadGen`, switched files, or closed viewers (`_viewerClosed`).
   - **Body & Review Compatibility:** When rendered mode is active, `renderMarkdownViewer` replaces the windowed `#changes-diff-lines` diff viewport with unique `id`/`scrollId` per file+revision (`monoFont`, `noticeBanner`, `loading`, `error`, relative diff-file link navigation), clears/hides the active inline line-comment composer (`activeComment`), and keeps `Approve` / `Approved ✓`, file count pill, and existing review note counts intact.

### Review Dispatch Sequence

1. **Comment Composition:** Clicking any diff line in the Review tab opens the docked `#review-comment-composer` `TextareaState` editor (auto-focused post-mount via `focusCommentTask`); saving persists `{ fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, side, baseRef, text, snippet }` into `shared("cognivisor.reviewNotes")[sessionKey]`.
2. **Payload Generation:** Clicking "Send to agent" in `#changes` runs inside `cx.spawn(async (asyncCx) => ...)` (so `cx` never expires across `await`) and formats unified session Markdown via `formatReviewAgentMessage` grouped by `### Service: ${serviceName} (${repoRoot})` with ``- `${displayPath}:${line}`:`` (noting removed lines when `side === "old"`) and diff snippets, stripping trailing blank lines so TUI bracketed paste ends cleanly.
3. **Transmission & Submit Verification:** Resolves target via `findActiveAgent()` (using `sessionTabId = resolveSessionAgentTabId(...)` so viewing the non-terminal Review tab never loses `leadTerminal`), captures a pre-send screen snapshot (`hc(["read", "--lines", "0", agent.address])`), and invokes `await hc(["send", "--json", agent.address, message])`. When `SendResult.started !== true` (e.g., Windows ConPTY / TUI bracketed paste swallowed the trailing Enter), `decideSendSubmitAction` inspects live `hc get --json` state (`state`, `status`, `turn`, `submit`) and visible screen (`detectUnsubmittedReviewInScreen`, guarded by `screenLooksBlockedOrPrompting`) and sends a bounded follow-up submit key nudge (`hc(["keys", agent.address, submitKey])`) only when the agent is live, not `working`/`blocked`/`error`, has not advanced a turn, and shows no permission dialog.
4. **Completion:** On zero exit code, logs `review.sendSuccess`, shows `notify({ title: "Review notes sent to agent", level: "success" })`, and clears the session's `cognivisor.reviewNotes` entry via `asyncCx` (failures log `review.sendFailed`, display parsed `formatHcErrorMessage` feedback, and preserve all notes).

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
   *Rationale:* Prevents Git from touching index timestamps or creating lock files that trip `watchFolder` and cause refresh cascades.
2. **Virtual Pre-Tokenized Diff Rendering & Shared Markdown State:**
   Diff lines are pre-processed once inside `diffRows(lines, filePath)` into numbered metadata objects with linear single-pass syntax tokens (`tokenizeDiffLine`, capped at `MAX_DIFF_SYNTAX_LINE_CHARS = 1600` per line, delegating `.md`/`.mdx` files to shared `./markdown-syntax.js` with `createMarkdownState`, `advanceMarkdownState`, `tokenizeMarkdownLine`, and `resetMdStateForLine`), and `expandDiffGapInRows` propagates Markdown state cleanly across expanded context lines.
3. **Theme Dynamic Adaptation & Diff + Syntax Color Layering:**
   Diff additions and deletions preserve unambiguous diff markers—background tint (`hexWithAlpha` from `theme().diff_add` / `theme().diff_del` or ANSI fallback tokens), left accent border, `+`/`-` gutter glyph, and colored line number—while rendering code content through `getDiffSyntaxPalette` / `diffSyntaxTokenColor` with luminance-guarded `theme()` syntax tokens across both light and dark themes.
4. **Composite File Keys & Session Note Keys:**
   All internal file references (`openFileKey`, `reviewedFiles`, `cognivisor.reviewNotes`) index files via composite `${serviceId}::${path}` keys, index review comments via `buildCommentKey(fileKey, line, side)`, and scope review notes via `getSessionNotesKey(spaceId, sourceTabId)` (`"${spaceId}::${sourceTabId}"`).
5. **Zero `localStorage`, Zero Hidden Allocations & Non-Reentrant Shared Updates:**
   Never call `localStorage`, `cx.notify()`, or `setShared()` synchronously inside `render()`. Short-circuit `renderPanel()` immediately when `!visible`. Defer refreshes, `cognivisor.spaceAgentTabs` updates, `viewerLoadedKey` diff fetches, and cross-mode syncs via `cx.timer.after(0, ...)`. Keep `cognivisor.services` deduplicated via `sig` and merge `cognivisor.flows[sessionTabId]` mutations onto the latest snapshot.
6. **Stale-Context Cancellation, Always-On Watchers & Cleanup:**
   Watch discovered candidate repositories even when no files are currently modified, queue a follow-up refresh (`pendingRefresh`) if watch events arrive while `loading === true`, validate context/generation across awaits, and cancel all active tasks in `close()`.

## Multi-Repo & Cognivisor Implementation

### Workspace Root Anchoring (`location`, `resolveWorkspaceRoot`) & Session Preservation (`resolveSessionAgentTabId`)
The workspace root anchors to `space.folder` via `resolveWorkspaceRoot` whenever `pane.cwd` equals or lies inside `space.folder`, except when `space.folder` points to a user home directory (`isHomeDirectoryRoot`, e.g., `$HOME` or `/Users/<name>`) and `pane.cwd` targets a deeper project directory — in which case `pane.cwd` becomes the workspace root. `location()` resolves `sessionTabId = resolveSessionAgentTabId(space, allPanes, shared("cognivisor.spaceAgentTabs"))` and prioritizes panes matching `sessionTabId` over auxiliary split-pane focus so focusing a split terminal in another directory never flips `key()` or resets review state.

### Origin/Base Branch Unified Diff & Multi-Repository Discovery (`discoverRepos`, `resolveRepoBaseRefWithExec`, `collectServiceSessionSnapshot`)
Scans `workspaceRoot` up to depth 2 (`$root/*` and `$root/*/*`) using `fs/promises` locally (and POSIX/PowerShell over SSH when `on` is set), plus parent/sibling discovery for single-repo workspaces and active-tab `pane.cwd` paths (`extraCwds` scoped strictly to `sessionTabId`), caching candidates for `REPO_CACHE_TTL_MS = 60000`. `resolveRepoBaseRefWithExec` resolves each repo's origin/base branch using Gitflow branch target hints (`inferBranchBaseHintRefs`, e.g., `*/prod/*` → `origin/master`/`origin/main`, `*/dev/*` → `origin/development`, `*/release/*` → `origin/release`, `*/ci/*` → `origin/ci`), `origin/HEAD`, and closest-ancestor distance across multi-base remotes (`origin/{development,develop,main,master,release,ci}`) before falling back to local base branches, upstream, or session `startHead` when working directly on a base branch (and unborn repo support). `collectServiceSessionSnapshot` merges lock-free `git diff <baseHash> --name-status -z --no-renames` and `--numstat -z --no-renames` with `git status --porcelain=v1 -b -z --no-renames --untracked-files=normal` (expanding `?? dir/` and counting bounded untracked text lines so new files show accurate `+N` stats), preserving separate `dirtyPaths` and `workingCount` for dirty-only actions.

### Strict Session Attribution, Pre-Existing Filtering & Cross-Mod Cache Coherence (`sessionBaseline`, `evaluateRepoSessionActivity`, `partitionSessionUnifiedEntries`)
- **Per-Tab Baseline Persistence (No 12h Cross-Tab Stealing):** `resolveOrInitSessionBaseline` checks in-memory cache (re-reading from disk whenever `cognivisor.flows[sessionTabId].baselineRev` advances or disk file `mtimeMs` changes so `changes-review` and `files-search` never split-brain, with case-insensitive Windows drive/path lookup via `findBaselineRepoEntry`), then `${appHome()}/cognivisor/sessions/tabs/<safeTabId>.json`, then strict command-line `/resume` lookup via `${appHome()}/cognivisor/sessions/resume/<hash>.json`. It does NOT steal arbitrary closed tabs' baselines across a 12-hour window. Fresh baselines capture per-repo `{ startHead, startBranch, dirtyFiles }` anchored to `Date.now()` (or explicit `flow.sessionStartedAt`, never `cognivisor-tabs`'s `updatedAt`).
- **Strict Repo Inclusion (`evaluateRepoSessionActivity`):** A candidate repository is active in the session ONLY when at least one holds: `hasNewWorkingEdit` (dirty file not matching `baselineRepo.dirtyFiles`), `inPaneCwd` (active tab's own cwd, matched case-insensitively on Windows), `inWorkspaceRoot` (the Space's `workspaceRoot` itself is that single repository root, keeping single-repo Spaces attributed even when Windows ConPTY terminals omit `pane.cwd`), `inSessionRepos` (previously touched in this session), or `headMoved && repoMatchesTranscript`. A repo appears in the panel ONLY when `sessionActivity && displayFiles.length > 0`, ensuring untouched sibling repos on old branches or with external pulls never leak. When `!sessionTabId` (no terminal tab exists yet in the Space), non-sibling workspace repos still surface cleanly without touching session baselines, and snapshot failures log `review.snapshotFailed` / surface `this.error` when all candidate repos fail.
- **Pre-Existing Dirty File Partitioning (`partitionSessionUnifiedEntries`):** When `baselineRepo.dirtyFiles` is non-empty and `baseHash !== headHash`, committed paths (`git diff --name-only -z <baseHash> HEAD`) remain visible unconditionally while uncommitted pre-existing dirty files matching `baselineRepo.dirtyFiles[path]` (`status` & `sig`, including `"deleted:D"` for deleted files and SSH diff-stat fallback signatures) are hidden behind `#preexisting-baseline-bar` (`"N files hidden as pre-existing"`, `Show all` / `Session only`, `Reset baseline` bumping `baselineRev` in `cognivisor.flows` and persisting to disk).

### Shared Bus Synchronization (`cognivisor.services`, `changes-review.activeDiff`, `cognivisor.reviewNotes`, `cognivisor.spaceAgentTabs`)
Consumes `cognivisor.services` candidate hints published by `files-search` (`BUS_MAX_AGE_MS = 90000`, `sig`-matched), merges `bus.candidates` with `bus.services` via `mergeBusCandidateServices`, and publishes updates only when `sessionTabId` is resolved and topology/branch/dirty signature changes. `changes-review.activeDiff` and `cognivisor.reviewNotes` coordinate the single reusable Review tab and side-aware inline comment state without duplicating git scans inside `#main`.

### Unified File List, Diff Viewport & Per-Block Context Expansion
- **Clean Unified Panel:** `#changes` renders a single compact header (`Changes`, `[N files]`, `[M/N ✓]`, `+add`/`−del`), optional `#preexisting-baseline-bar`, and one unified `#changes-list` ordered by `(serviceName, path)` with `[serviceName]` badges whenever `services.length > 1` (zero `#service-filter-bar`, zero `#microservice-review-bar`, zero `#commit-selector-btn`).
- **Review Tab Bar (`#diff-file-review-bar`):** Displays `[serviceName]` (when `services.length > 1`), status, file-type icon, `displayPath`, `+add`/`−del`, comparison badge (`vs origin/main` / `Session`), Prev/Next (`←`/`→`) navigation + counter, `M/N ✓` progress badge, Markdown toggle (for `.md`/`.mdx`), `↻` reload, and non-checkbox `Approve` / `Approved ✓` (`#diff-viewed-btn`).
- **Responsive Soft-Wrapped Diff Rendering, Per-Block Context Expansion & Windowed Virtualization (`#changes-diff-lines`):** Inside `#review-tab-viewer`, `#changes-diff-viewport` (`.on_size_change` coalesced via `16ms` `diffResizeTask`) renders `#changes-diff-lines` via variable-height windowed slicing (`buildVariableRowLayout`, `computeVariableWindowSlice`, `computeDiffScrollOffsetForRow`, `computeDiffScrollbarMetrics`, `resolveDiffWheelDeltaPx`, `resolveDiffScrollbarDragPx`) over memoized per-row heights and `WeakMap`-cached wrapped segments via shared `code-wrap.js`. Collapsed hunk gaps (`annotateDiffGaps`) expand lazily per block via `expandDiffGapInRows` (loading source lines once per revision via `fetchViewerSourceLines`, capped at `MAX_CONTEXT_SOURCE_BYTES = 600_000`, preserving Markdown state across expanded rows and keeping the reviewed code pixel-anchored via `computeAnchorPreservedScrollPx`).

### Lead-Terminal-Prioritized Agent Resolution (`findActiveAgent`)
Resolves the target agent against `sessionTabId` strictly in priority order:
1. `cognivisor.flows[sessionTabId]?.leadTerminal` matched in `agents()` or live `terminals()`.
2. `focused()?.agent` matched in `agents()` (excluding terminals labeled `cognivisorRunner === "true"`).
3. Non-runner agent in `sessionTabId` across `panes()`, `terminals()`, and `agents()` (excluding `labels?.cognivisorRunner === "true"`).
4. Any agent in `sessionTabId`.
5. `agents()[0]` global fallback.

### Safe Multi-Repository Dirty-Only Commits
The bottom `Commit` drawer targets ONLY session-touched repositories with visible dirty working-tree files (`dirtyPaths.length > 0`). Committing executes `git add -- <dirtyPaths...>` (chunked safely, never `git add -A`) followed by `git commit -m message` sequentially across target repos, leaving hidden pre-existing files untouched and preserving commit-resilient `reviewedFiles` approvals. Button copy displays `Commit (${targetRepos.length} repos)` when multiple repos have dirty working-tree files, and disables with an informative message when all session changes are already committed.
