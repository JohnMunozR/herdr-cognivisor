---
id: submodule-mod-changes-review
type: submodule-design
status: active
title: Changes Review Mod (mods/changes-review)
parent: module-mods
references: [module-layouts, spec-lifecycle]
covers: [git-diff-viewer, inline-review-comments, commit-history-inspection, agent-feedback-dispatch, multi-repo-discovery, service-filter-pills, cross-service-review, multi-repo-commits, per-service-branch-badges, per-tab-review-checklist, lead-terminal-dispatch]
tags: [mod, git, code-review, agent-feedback, multi-repo, mesh, checklist]
---

## Responsibility

The `submodule-mod-changes-review` provides interactive source control inspection, visual Git diff analysis, session-attributed multi-repository microservice aggregation, per-service branch and checklist tracking, and human-in-the-loop agent feedback dispatch. Operating in two synchronized view modes sharing the same component—the docked `#changes` sidebar in the Herdr `#panel-body` stack and a single reusable non-terminal **Review tab** (`props.role === "viewer"`) opened in `#main`—it enables developers to scan changed files, review full-width diffs with inline review notes, mark files reviewed (`Mark reviewed`), approve individual microservices (`Approve Service ✓`) with automatic advancement inside the same Review tab, and transmit structured review notes directly to the session's lead AI agent (`leadTerminal`).

## Boundary

- **Owns:**
  - Manifest file: `mods/changes-review/mod.json` (`{ "place": "none", "title": "Changes Review" }`).
  - Dual-mode component: `mods/changes-review/main.js` (`renderPanel` for `#changes` sidebar, `renderViewer` for `role: "viewer"` Review tab in `#main`).
  - Pure diff, syntax lexer, file-type icon, session/tab resolution, next-target selection, & watch filter helpers: `mods/changes-review/review-logic.js`.
  - Icon assets: `mods/changes-review/changes.svg`, `mods/changes-review/icons/*.svg`, and `mods/changes-review/icons/file-types/*.svg` (22 vector file-type icons).
  - Type definitions and compiler configuration: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `changes-review` (docked panel when `props()?.role !== "viewer"`; full-pane Review tab when created with `props: { role: "viewer", spaceId, sourceTabId }`).
  - Layout slot: `#panel-body` child `changes` in `layouts/mesh.json`; `#main` tab via `run("tab.new" | "tab.rename" | "tab.select")`.
  - Host IPC: Outbound review notes dispatched through `hc(["send", agent.address, message])`.
  - Shared state bus:
    - Consumes and publishes `mesh.services` (with `sig` change key, `candidates` cache, and per-service `branch`/`workingCount`/`aheadCount`, `BUS_MAX_AGE_MS = 90000`).
    - Reads and writes `mesh.activeService` for synchronized service filtering across sidebar and Review tab.
    - Reads and defers updates to `mesh.spaceAgentTabs` (`Record<spaceId, tabId>`) recording the most recent terminal-bearing tab per space so session identity, flows, and agent resolution stay intact while the non-terminal Review tab is active.
    - Coordinates the active space's single Review tab via `changes-review.activeDiff` (`Record<spaceId, ActiveDiffState>` containing `spaceId`, `sourceTabId`, `workspaceRoot`, `on`, `viewMode`, `selectedCommit`, `activeService`, `openFileKey`, `openFile`, `files`, `allFiles`, `services`, `requestSeq`, `focusLine`, `openCommentLine`, `ts`).
    - Synchronizes inline review notes bidirectionally between the Review tab and docked `#changes` via `mesh.reviewNotes` (`Record<sessionKey, Array<ReviewNote>>` where `sessionKey = "${spaceId}::${sourceTabId || 'global'}"`).
    - Reads and updates `mesh.flows[sessionTabId]` (`reviewedServices` checklist map, `reviewedFiles` per-file viewed map, and `sessionRepos` attribution, preserving all sibling fields such as `leadTerminal`, `ticket`, `derivedTitle`, `manualTitle`).
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`, `TextareaState`, `Textarea`, `Scrollbar`, `ScrollHandle`.
  - `herdr`: `props`, `run`, `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `notify`, `hc`, `layout`, `shared`, `setShared`, `window`.
- **Forbidden:**
  - Any usage of `localStorage` or browser DOM APIs.
  - Calling `cx.notify()`, `setShared()`, or mutating inputs synchronously inside `render()` (all refreshes, `viewerLoadedKey` diff fetches, `mesh.spaceAgentTabs` recordings, and cross-mode syncs run asynchronously via `cx.timer.after(0, ...)` or explicit interaction handlers).
  - Rendering the inline diff viewer (`#diff-file-review-bar`, `#changes-diff-x`, `#changes-diff-lines`) inside the docked `#changes` sidebar.
  - Spawning duplicate Review tabs in the same space when one already exists (`findReviewTabInSpace` reuses, updates `changes-review.activeDiff`, `tab.rename`, and `tab.select`).
  - Executing git commands without `READ` safety flags (avoids `.git/index.lock` collisions with external editors and filesystem watchers).
  - Executing destructive git operations (`reset --hard`, `checkout -f`, `clean -fd`).
  - Hardcoded color hex values that ignore user `theme()`, `settings()`, or `layout()` palette configurations.
  - Resetting review notes, `key()`, or agent session state on service filter switches, Review-tab switches, or terminal pane focus changes.
  - Mutating or overwriting `mesh.flows[tabId].leadTerminal` or sibling flow fields outside explicit user actions.

## Architecture & Interaction Flow

```text
Docked Sidebar (#changes, role !== "viewer")          Main Review Tab (#review-tab-viewer, role === "viewer")
+--------------------------------------------+       +------------------------------------------------------------+
| Changes [N files] [Working Tree v] +12 -3  |       | [svc] [M] file.svg  path/to/file.ext +12 -3 [Working Tree]|
+--------------------------------------------+       | [<-][2/7][->] [3/7 reviewed] [↻] [Mark reviewed] [Approve ✓]|
| [ All ] [ o auth-api ] [ ✓ web-client ]    |       +------------------------------------------------------------+
| auth-api · feat/PROJ-412  [Approve Service]|       | Dual-axis Diff Viewer (#changes-diff-x / #changes-diff-lines)|
+--------------------------------------------+       |   Line 14  - console.log(prev);                            |
| Changed Files List (#changes-list, flex_1) | ----> |   Line 14  + logger.info(next);   [Click row to comment]     |
|   [✓] M [auth-api] src/jwt.ts       +12 -3 | click |   +------------------------------------------------------+ |
|   [ ] A [web-client] LoginModal.tsx +45 -0 |       |   | Inline Comment Textarea -> shared("mesh.reviewNotes")  | |
+--------------------------------------------+       |   +------------------------------------------------------+ |
| Review (N) | Commit                        |       +------------------------------------------------------------+
|   • [auth-api] jwt.ts:14 Verify log level  | <---- synced via mesh.reviewNotes[spaceId::sourceTabId]
|   [claude]      [Clear all] [Send to agent]|
+--------------------------------------------+
```

### Dual-Mode Review Tab Lifecycle

1. **Opening & Reuse (`pick` / `jumpToComment`):** Clicking any changed file in `#changes` records the space's active terminal tab in `mesh.spaceAgentTabs`, writes the target file/list/service snapshot to `changes-review.activeDiff[spaceId]` with an incremented `requestSeq`, and either creates one Review tab in `#main` (`run("tab.new", { space, name: formatReviewTabTitle(file), mod: "changes-review", props: { role: "viewer", spaceId, sourceTabId } })`) or reuses and focuses the existing Review tab (`findReviewTabInSpace`, `tab.rename`, `tab.select`). Clicking a review note in `#changes` similarly focuses the existing/new Review tab with `focusLine` and `openCommentLine` set to scroll to and open that inline comment editor.
2. **Deferred Diff Loading (`viewerLoadedKey`):** Inside `renderViewer`, comparing `computeViewerLoadedKey(diff)` (`requestSeq`, `openFileKey`, `viewMode`, `commitHash`, `expanded`) against `viewerLoadedKey` schedules `loadViewerDiffNow` asynchronously via `cx.timer.after(0, ...)`. Explicit navigation (`←`/`→`, `↻`, `Mark reviewed`, `Approve Service ✓`, `Expand context`) loads the diff immediately while updating `viewerLoadedKey` cleanly.
3. **Single-Tab Approve-and-Advance:**
   - **File level (`Mark reviewed` in Review tab):** Marks the current file reviewed in `mesh.flows[sourceTabId].reviewedFiles`, selects the next unreviewed file via `pickNextUnreviewedFile`, updates `changes-review.activeDiff[spaceId]`, renames the same Review tab via `tab.rename`, and loads its diff immediately without opening another tab. Checkbox clicks (`#file-check-*`) in `#changes` remain non-jumping batch toggles.
   - **Service level (`Approve Service ✓` in either Review tab or `#changes`):** Records `"approved"` for the service in `mesh.flows[sourceTabId].reviewedServices` (disabled/dim with tooltip when `"has_notes"`), picks the next dirty unapproved service via `pickNextDirtyService`, broadcasts `mesh.activeService`, filters to that service's files, selects its first unreviewed file (`pickNextUnreviewedFile` / `files[0]`), updates `changes-review.activeDiff[spaceId]`, renames the existing Review tab via `tab.rename`, and updates/loads the next file inside that **same Review tab**.
4. **Comment Composition & Synchronization (`mesh.reviewNotes`):** Inline comments added, updated, or deleted in the Review tab write directly to `shared("mesh.reviewNotes")[getSessionNotesKey(spaceId, sourceTabId)]` and synchronize `"has_notes"` / `"pending"` on `mesh.flows[sourceTabId].reviewedServices[serviceId]`. `#changes` renders the synchronized note list (`Review (N)`), supports `jumpToComment`, individual deletion (`removeComment`), `Clear all`, and Markdown dispatch (`Send to agent` via `findActiveAgent()` resolved against `sessionTabId`).

### Review Dispatch Sequence

1. **Comment Composition:** Clicking any diff line in the Review tab opens the inline `TextareaState` editor; saving persists `{ fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, text, snippet }` into `shared("mesh.reviewNotes")[sessionKey]` and marks the service `"has_notes"`.
2. **Payload Generation:** Clicking "Send to agent" in `#changes` formats uncommitted or commit-scoped Markdown grouped by `### Service: ${serviceName} (${repoRoot})` with ``- `${displayPath}:${line}`:`` and diff snippets.
3. **Transmission:** Resolves target via `findActiveAgent()` (using `sessionTabId = resolveSessionAgentTabId(...)` so viewing the non-terminal Review tab never loses `leadTerminal`) and invokes `await hc(["send", agent.address, message])`.
4. **Completion:** On zero exit code, shows `notify({ title: "Review notes sent to agent", level: "success" })` and clears the session's `mesh.reviewNotes` entry and `"has_notes"` service flags.

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
2. **Virtual Pre-Tokenized Diff Rendering:**
   Diff lines are pre-processed once inside `diffRows(lines, filePath)` into numbered metadata objects with linear single-pass syntax tokens (`tokenizeDiffLine`, capped at 500 chars per line, separating `annotation`, `keyword`, `type`, `function`, `string`, `string.escape`, `number`, `boolean`, `constant`, `variable`, `operator`, and `comment` across Java/Spring Boot, Python, JavaScript, YAML, JSON, and `.properties`), keeping `diffRow()` allocation-light during scroll/re-renders.
3. **Theme Dynamic Adaptation & Diff + Syntax Color Layering:**
   Diff additions and deletions preserve unambiguous diff markers—background tint (`hexWithAlpha` from `theme().diff_add` / `theme().diff_del` or ANSI fallback tokens), left accent border, `+`/`-` gutter glyph, and colored line number—while rendering code content through `getDiffSyntaxPalette` / `diffSyntaxTokenColor` with luminance-guarded `theme()` syntax tokens across both light and dark themes.
4. **Composite File Keys & Session Note Keys:**
   All internal file references (`openFileKey`, `expandedFiles`, `reviewedFiles`, `mesh.reviewNotes`) index files via composite `${serviceId}::${path}` keys and scope review notes via `getSessionNotesKey(spaceId, sourceTabId)` (`"${spaceId}::${sourceTabId}"`) to prevent cross-service and cross-session collision.
5. **Zero `localStorage` & Non-Reentrant Shared Updates:**
   Never call `localStorage`, `cx.notify()`, or `setShared()` synchronously inside `render()`. Defer refreshes, `mesh.spaceAgentTabs` updates, `viewerLoadedKey` diff fetches, and cross-mode syncs via `cx.timer.after(0, ...)`. Keep `mesh.services` deduplicated via `sig` and merge `mesh.flows[sessionTabId]` mutations onto the latest snapshot.
6. **Stale-Context Cancellation & Cleanup:**
   Async flows (`refresh`, `loadViewerDiffNow` via monotonic `viewerLoadGen`, watchers) validate context/generation across awaits, and `close()` cancels all active tasks (`renderRefreshTask`, `watchDebounceTask`, `agentTabSyncTask`, `sharedSyncTask`, `viewerLoadTask`, `pollTask`) and releases `input`, `commentInput`, `serviceFilterScroll`, and `diffScroll`.

## Multi-Repo & Mesh Implementation

### Workspace Root Anchoring (`location`) & Session Preservation (`resolveSessionAgentTabId`)
The workspace root is anchored to `space.folder`. When the active tab is a non-terminal Review or File tab, `location()` and `getActiveSpaceAndTab()` resolve `sessionTabId = resolveSessionAgentTabId(space, allPanes, shared("mesh.spaceAgentTabs"))` and prefer panes matching `sessionTabId` with `cwd`. State cache identity `key()` keys by `{ cwd: loc.cwd, on: loc.on, spaceId: loc.spaceId, tabId: loc.tabId }` (where `tabId` is `sessionTabId`), preventing Review-tab focus switches from resetting workspace/agent state while still isolating per-agent-tab sessions.

### Multi-Repository Discovery & Session Attribution (`discoverRepos`, `attributeSessionRepos`)
Scans `workspaceRoot` up to depth 2 (`$root/*` and `$root/*/*`) using `fs/promises` on local workspaces (and POSIX/PowerShell over SSH when `on` is set), plus parent/sibling discovery for single-repo workspaces, caching candidates for `REPO_CACHE_TTL_MS = 60000`. Shared `loadServiceWorkingSnapshot` queries `git status --porcelain=v1 -b -z --no-renames --untracked-files=normal` and `numstat` in lock-free passes per repo, attributing touched repositories to `sessionTabId` (`sessionRepos` in `mesh.flows[sessionTabId]`).

### Shared Bus Synchronization (`mesh.services`, `mesh.activeService`, `changes-review.activeDiff`, `mesh.reviewNotes`, `mesh.spaceAgentTabs`)
Consumes `mesh.services` published by `files-search` (`BUS_MAX_AGE_MS = 90000`, `sig`-matched to ignore heartbeat-only `ts` ticks when unchanged) and publishes updates only when topology/branch/dirty signature changes. Active service filter state (`"all"` or a specific `serviceId`) synchronizes bidirectionally over `mesh.activeService`. `changes-review.activeDiff` and `mesh.reviewNotes` coordinate the single reusable Review tab and inline comment state without duplicating git scans inside `#main`.

### Service Filter Bar, Microservice Review Bar & Per-Tab Checklist (`mesh.flows`)
- **Session Tab Identification:** Resolves `sessionTabId = resolveSessionAgentTabId(activeSpace, allPanes, shared("mesh.spaceAgentTabs"))` and reads `shared("mesh.flows")?.[sessionTabId] || {}`.
- **Status Resolution:** Each service resolves to `"has_notes"` if any note in `shared("mesh.reviewNotes")[sessionKey]` belongs to `serviceId`, else `"approved"` if `flow.reviewedServices?.[serviceId]?.status === "approved"`, else `"pending"`.
- **Service Filter Pills:** Sorted via `sortServicesDirtyFirst` (dirty-first, then alphabetically), displaying status glyph (`✓`, `✎`, `○`), service name, compact `service.branch` badge, and dirty count.
- **Microservice Review Bar & `Approve Service ✓`:** Rendered both in `#changes` (when focused on one service or sole repo) and inside `#diff-file-review-bar` in the Review tab (when in working mode). Approving persists `{ status: "approved", branch, updatedAt }` under `mesh.flows[sessionTabId].reviewedServices[serviceId]`, selects the next dirty unapproved service via `pickNextDirtyService`, broadcasts `mesh.activeService`, and opens that service's first unreviewed file (`pickNextUnreviewedFile`) inside the same Review tab when one is open.
- **Per-File Review Checklist & File-Type Icons (`reviewedFiles`, `#file-check-*`, `#diff-file-review-bar`):** File rows in `#changes-list` fill the docked panel above the bottom `Review | Commit` drawer and render interactive checkboxes (`✓`), composite scope keys (`working::<serviceId>::<path>` or `commit:<hash>::<serviceId>::<path>`), and `resolveDiffFileIcon(file.path, t)` SVGs. In `#main`'s Review tab, `#diff-file-review-bar` shows service badge, status, icon, `displayPath`, `+add`/`−del`, Working Tree / commit short hash badge, Prev/Next (`←`/`→`) file navigation + position counter, `N/M reviewed` progress, `↻` reload, `Mark reviewed` (advancing via `pickNextUnreviewedFile` in the same Review tab), and `Approve Service ✓` (disabled/dim when `"has_notes"`).
- **Horizontal & Vertical Diff Scrolling (`#changes-diff-x`, `#changes-diff-lines`):** Inside `#review-tab-viewer`, diff rows render unwrapped (`whitespace_nowrap` without `.overflow_hidden()` or `.truncate()`), expand tabs consistently via `expandCodeTabs`, and size an outer `overflow_x_scrollbar()` container to `computeDiffContentWidth(this.rows)` around `v_flex().id("changes-diff-lines").overflow_y_scroll().track_scroll(this.diffScroll)`, while `Scrollbar.vertical("changes-diff-lines").viewport_from_layout()` pins the vertical scrollbar to the visible right edge.

### Lead-Terminal-Prioritized Agent Resolution (`findActiveAgent`)
Resolves the target agent against `sessionTabId` strictly in priority order:
1. `mesh.flows[sessionTabId]?.leadTerminal` matched in `agents()` or live `terminals()`.
2. `focused()?.agent` matched in `agents()` (excluding terminals labeled `meshRunner === "true"`).
3. Non-runner agent in `sessionTabId` across `panes()`, `terminals()`, and `agents()` (excluding `labels?.meshRunner === "true"`).
4. Any agent in `sessionTabId`.
5. `agents()[0]` global fallback.

### Multi-Repository Batch Commits
In `All` mode, committing executes `git add -A` and `git commit -m message` sequentially across all services with dirty working trees (`workingCount > 0`). When a specific service is filtered, only that service is committed. Button copy dynamically displays `Commit (${targetRepos.length} repos)` when multiple services are dirty.
