---
id: submodule-mod-changes-review
type: submodule-design
status: active
title: Changes Review Mod (mods/changes-review)
parent: module-mods
references: [module-layouts, spec-lifecycle]
covers: [git-diff-viewer, inline-review-comments, commit-history-inspection, agent-feedback-dispatch, multi-repo-discovery, service-filter-pills, cross-service-review, multi-repo-commits, per-service-branch-badges, per-tab-review-checklist, repo-standards-checks, lead-terminal-dispatch]
tags: [mod, git, code-review, agent-feedback, multi-repo, mesh, checks, checklist]
---

## Responsibility

The `submodule-mod-changes-review` provides interactive source control inspection, visual Git diff analysis, session-attributed multi-repository microservice aggregation, per-service branch and checklist tracking, repository standard check execution, and human-in-the-loop agent feedback dispatch. Docked within the `#changes` slot of the Herdr `#panel-body` stack, it enables developers to review uncommitted modifications or historical commits across session-touched microservices in a workspace, compose structured code review annotations, run repository lint/test/check commands (cross-platform), approve individual microservices (`Approve Service ✓`), and transmit review notes or check failures directly to the active tab's lead AI agent (`leadTerminal`).

## Boundary

- **Owns:**
  - Manifest file: `mods/changes-review/mod.json` (`{ "place": "none", "title": "Changes Review" }`).
  - Main component: `mods/changes-review/main.js`.
  - Icon assets: `mods/changes-review/changes.svg` and `mods/changes-review/icons/*.svg`.
  - Type definitions and compiler configuration: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `changes-review`.
  - Layout slot: `#panel-body` child `changes` in `layouts/mesh.json`.
  - Host IPC: Outbound review notes and check failure diagnostics dispatched through `hc(["send", agent.address, message])`.
  - Shared state bus:
    - Consumes and publishes `mesh.services` (with `sig` change key, `candidates` cache, and per-service `branch`/`workingCount`/`aheadCount`, `BUS_MAX_AGE_MS = 90000`).
    - Reads and writes `mesh.activeService` for synchronized service filtering.
    - Reads and updates `mesh.flows[activeTabId]` (`reviewedServices` checklist map, `reviewedFiles` per-file viewed map, and `sessionRepos` attribution, preserving all sibling fields such as `leadTerminal`, `ticket`, `derivedTitle`, `manualTitle`).
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`, `TextareaState`, `Textarea`, `Scrollbar`, `ScrollHandle`.
  - `herdr`: `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `notify`, `hc`, `layout`, `shared`, `setShared`, `window`.
- **Forbidden:**
  - Any usage of `localStorage` or browser DOM APIs.
  - Calling `cx.notify()`, `setShared()`, or mutating inputs synchronously inside `render()` (`scheduleRenderRefresh` defers refreshes via `cx.timer.after(0, ...)`).
  - Executing git commands without `READ` safety flags (avoids `.git/index.lock` collisions with external editors and filesystem watchers).
  - Executing destructive git operations (`reset --hard`, `checkout -f`, `clean -fd`).
  - Hardcoded color hex values that ignore user `theme()`, `settings()`, or `layout()` palette configurations.
  - Resetting review notes on service filter switches or terminal pane focus changes.
  - Mutating or overwriting `mesh.flows[tabId].leadTerminal` or sibling flow fields outside explicit user actions.

## Architecture & Interaction Flow

```text
+----------------------------------------------------------------------------------+
| Header: Changes [N files] [Working Tree v]   +12 -3   [Checks]                   |
+----------------------------------------------------------------------------------+
| Service Filter Bar (multi-repo):                                                 |
|   [ All (12) ] [ o auth-api feat/PROJ-412 (5) ] [ ✓ web-client feat/PROJ-412 ]   |
+----------------------------------------------------------------------------------+
| Microservice Review Bar (single service or sole repo):                           |
|   auth-api · feat/PROJ-412   [Pending]    [Approve Service ✓]                    |
+----------------------------------------------------------------------------------+
| [When Checks Open] Repo Checks Drawer:                                           |
|   Standards: [AGENTS.md] [package.json]     [Run All] [Send Failures to Agent]   |
|   [✓ Pass] npm run lint   (package.json)                            [Re-run]     |
|   [✗ Fail] npm test       (package.json)  > scrollable tail output  [Re-run]     |
+----------------------------------------------------------------------------------+
| Changed Files List:                                                              |
|   [M] [auth-api] src/jwt.ts                                               +12 -3 |
|   [A] [web-client] src/components/LoginModal.tsx                          +45 -0 |
+----------------------------------------------------------------------------------+
| Diff Viewer: Hunk expansion, Unified line numbers (old / new)                    |
|   Line 14  - console.log(prev);                                                  |
|   Line 14  + logger.info(next);   [+] Add Comment Button                         |
|   +----------------------------------------------------------------------------+ |
|   | Inline Comment Textarea: "Verify logging level in production"              | |
|   +----------------------------------------------------------------------------+ |
+----------------------------------------------------------------------------------+
| Review / Commit Footer:                                                          |
|   Target Agent (leadTerminal priority): [claude]    [Clear all] [Send to agent]  |
|   Commit Bar (Working Tree mode): [ Commit message... ] [ Commit (2 repos) ]     |
+----------------------------------------------------------------------------------+
```

### Review Dispatch Sequence

1. **Comment Composition:** The reviewer clicks a diff row to attach a comment. Comments are indexed by composite key `${serviceId}::${path}` and line number in local view state, and mark the service's checklist status as `"has_notes"`.
2. **Payload Generation:** When the reviewer clicks "Send to agent", `changes-review` formats a Markdown document containing:
   - Header specifying uncommitted changes or commit reference.
   - Microservice groups (`### Service: ${serviceName} (${repoRoot})`).
   - For each commented file, line references (`- \`${displayPath}:${line}\`:`) and contextual diff snippets.
   - Reviewer instructions and observations.
3. **Transmission:** Resolves target via `findActiveAgent()` and invokes `await hc(["send", agent.address, message])`.
4. **Completion:** Upon zero exit code, displays confirmation via `notify({ title: "Review notes sent to agent", level: "success" })` and atomically clears submitted comments.

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
   Diff lines are pre-processed once inside `diffRows(lines, filePath)` into numbered metadata objects with linear single-pass syntax tokens (`tokenizeDiffLine`, capped at 500 chars per line), keeping `diffRow()` allocation-light during scroll/re-renders.
3. **Theme Dynamic Adaptation & Diff + Syntax Color Layering:**
   Diff additions and deletions preserve unambiguous diff markers—background tint (`hexWithAlpha` from `theme().diff_add` / `theme().diff_del` or ANSI fallback tokens), left accent border, `+`/`-` gutter glyph, and colored line number—while rendering code content with semantic `theme()` syntax tokens (`ansi1`–`ansi6`, `dim`, `foreground`) across both light and dark themes.
4. **Composite File Keys:**
   All internal state references (`this.open`, `this.expandedFiles`, `this.reviews`) MUST index files via composite `${serviceId}::${path}` keys to prevent cross-service collision.
5. **Zero `localStorage` & Non-Reentrant Shared Updates:**
   Never call `localStorage`, `cx.notify()`, or `setShared()` synchronously inside `render()`. Publish `mesh.services` (with `sig` change key) when topology/branch/dirty counts change and merge `mesh.flows[tabId]` mutations onto the latest snapshot.
6. **Stale-Context Cancellation & Cleanup:**
   Async flows (`jumpToComment`, `runAllChecks`, watchers) validate `key() === context` across awaits, and `close()` cancels scheduled `renderRefreshTask` / `watchDebounceTask` timers alongside releasing inputs and scroll handles.

## Multi-Repo & Mesh Implementation

### Workspace Root Anchoring (`location`)
The workspace root is anchored to `space.folder`. When developers or terminal sessions navigate into subfolders or individual microservice directories, the review context maintains `space.folder` as the workspace boundary. Only when `space.folder` is absent or `pane.cwd` is outside `space.folder` does `location()` fall back to `pane.cwd`. State cache identity `key()` depends only on `{ cwd: loc.cwd, on: loc.on, spaceId: loc.spaceId }`, preventing pane focus switches from resetting review view state.

### Multi-Repository Discovery & Session Attribution (`discoverRepos`, `attributeSessionRepos`)
Scans `workspaceRoot` up to depth 2 (`$root/*` and `$root/*/*`) using `fs/promises` on local workspaces (and POSIX/PowerShell over SSH when `on` is set), plus parent/sibling discovery for single-repo workspaces, caching candidates for `REPO_CACHE_TTL_MS = 60000`. Uses `git status --porcelain=v1 -b -z --no-renames --untracked-files=normal` to extract branch/ahead/file state in one lock-free pass per repo, and filters to repositories touched by the active tab's session (`attributeSessionRepos`), persisting `sessionRepos` in `mesh.flows[activeTabId]`.

### Shared Bus Synchronization (`mesh.services` & `mesh.activeService`)
Consumes `mesh.services` published by `files-search` (`BUS_MAX_AGE_MS = 90000`, `sig`-matched to ignore heartbeat-only `ts` ticks when unchanged) and publishes updates only when topology/branch/dirty signature changes, keeping `files-search` and `mesh-status` synchronized without redundant git scans. Active service filter state (`"all"` or a specific `serviceId`) is synchronized bidirectionally over `mesh.activeService` with monotonic timestamp ordering.

### Service Filter Bar, Microservice Review Bar & Per-Tab Checklist (`mesh.flows`)
- **Active Tab Identification:** Resolves `activeTabId = spaces().find(s => s.active)?.tabs?.find(t => t.active)?.id || null` and reads `shared("mesh.flows")?.[activeTabId] || {}`.
- **Status Resolution:** Each service resolves to `"has_notes"` if `this.reviews.some(r => r.serviceId === serviceId)`, else `"approved"` if `flow.reviewedServices?.[serviceId]?.status === "approved"`, else `"pending"`.
- **Service Filter Pills:** When multiple repositories exist, renders horizontally scrollable pills sorted dirty-first then alphabetically, displaying status glyph (`✓` in `t.ansi2`, `✎` in `t.blocked`, `○` in `t.dim`), service name, compact `service.branch` badge, and dirty count.
- **Microservice Review Bar & `Approve Service ✓`:** Rendered when a single service is active or when the workspace has a sole repository (`services.length === 1`), showing service name, branch, status pill (`Pending` | `Has notes` | `Approved ✓`), and `Approve Service ✓` (or `Unapprove`). Approving persists `{ status: "approved", branch, updatedAt }` under `mesh.flows[activeTabId].reviewedServices[serviceId]` and automatically jumps `this.activeService` / `mesh.activeService` to the next unapproved dirty microservice (`workingCount > 0`), if any.
- **Per-File Review Checklist (`reviewedFiles`, `#file-check-*`, `#diff-file-review-bar`):** Each changed file row renders an interactive checkbox (`✓`) keyed cleanly by scope (`working::<serviceId>::<path>` or `commit:<hash>::<serviceId>::<path>`) inside `mesh.flows[activeTabId].reviewedFiles` (with `localReviewedFiles` fallback when no tab is active). Checking a file dims its row so unreviewed files stand out, updates header/bar progress (`N/M ✓`), clears matching `working::` entries automatically when committed, and clicking `Mark reviewed` inside `#diff-file-review-bar` checks the active file and advances to the next unreviewed file.

### Repository Standards & Check Runner (`#changes-checks-btn` & Checks Drawer)
Clicking `Checks` (`#changes-checks-btn`) in the header toggles a collapsible drawer above the changed files and diff area for the target service(s) (`activeService === "all"` targets dirty services or all services; otherwise the selected service). Discovery inspects root files via `readTextFile`:
1. `AGENTS.md`, `CLAUDE.md`, `SPEC.md`: displays standards doc indicator badges and parses fenced shell commands, `Checks:`/`Verification:`/`Verify:`/`Test:`/`Lint:` lines, and inline backticked test/lint/build commands (`npm run ...`, `npm test`, `mvn ...`, `cargo ...`, `go test ...`, `pytest ...`, `ng test`, `ng lint`, `herdr-app check`, `node --check`, etc.).
2. `package.json`: detects `scripts.lint`, `scripts.typecheck`, `scripts.test`, and `scripts.build`.
3. `pom.xml`: detects `./mvnw test` (when `mvnw` / `mvnw.cmd` exists) or `mvn test`.
4. `Cargo.toml`: detects `cargo check` and `cargo test`.
5. `Makefile`: detects `lint`, `test`, and `check` targets.

Individual checks (`Run` / `Re-run`) or batch checks (`Run All`) run via `exec(cmd, args, { cwd: service.root, on, timeout: 120000 })` (routing shell chains and Windows `.cmd` package shims such as `npm`/`pnpm`/`yarn`/`npx`/`bun`/`ng`/`mvnw`/`gradlew` via `cmd /c` on Windows and `sh -c` on POSIX), displaying pass/fail badges, duration, and ANSI-stripped scrollable tail output (`stdout`/`stderr`). When any check fails, `Send Failures to Agent` dispatches structured per-service diagnostics via `hc(["send", agent.address, msg])` to `findActiveAgent()`.

### Lead-Terminal-Prioritized Agent Resolution (`findActiveAgent`)
Resolves the target agent strictly in this priority order:
1. `mesh.flows[activeTabId]?.leadTerminal` matched in `agents()` or live `terminals()`.
2. `focused()?.agent` matched in `agents()` (excluding terminals labeled `meshRunner === "true"`).
3. Non-runner agent in `activeTabId` across `panes()`, `terminals()`, and `agents()` (excluding `labels?.meshRunner === "true"`).
4. Any agent in `activeTabId`.
5. `agents()[0]` global fallback.

### Multi-Repository Batch Commits
In `All` mode, committing executes `git add -A` and `git commit -m message` sequentially across all services with dirty working trees (`workingCount > 0`). When a specific service is filtered, only that service is committed. Button copy dynamically displays `Commit (${targetRepos.length} repos)` when multiple services are dirty.
