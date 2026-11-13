---
id: submodule-mod-changes-review
type: submodule-design
status: active
title: Changes Review Mod (mods/changes-review)
parent: module-mods
references: [module-layouts, spec-lifecycle, submodule-mod-mesh-flow]
covers: [git-diff-viewer, inline-review-comments, commit-history-inspection, agent-feedback-dispatch, multi-repo-discovery, service-filter-pills, cross-service-review, multi-repo-commits, per-service-branch-badges, per-tab-review-checklist, repo-standards-checks, lead-terminal-dispatch, go-to-test-transition]
tags: [mod, git, code-review, agent-feedback, multi-repo, mesh, checks, checklist]
---

## Responsibility

The `submodule-mod-changes-review` provides interactive source control inspection, visual Git diff analysis, multi-repository microservice aggregation, per-service branch and checklist tracking, repository standard check execution, and human-in-the-loop agent feedback dispatch. Docked within the `#changes` slot of the Herdr `#panel-body` stack, it enables developers to review uncommitted modifications or historical commits across all microservices in a workspace, compose structured code review annotations, run repository lint/test/check commands, approve individual microservices (`Approve Service ✓`), transition to testing (`→ Go to Test`), and transmit review notes or check failures directly to the active tab's lead AI agent (`leadTerminal`).

## Boundary

- **Owns:**
  - Manifest file: `mods/changes-review/mod.json` (identifies as `changes-review`, cloned from `changes` v0.1.13).
  - Main component: `mods/changes-review/main.js`.
  - Icon assets: `mods/changes-review/changes.svg` and `mods/changes-review/icons/*.svg`.
  - Type definitions and compiler configuration: `gpui-kit.d.ts`, `jsconfig.json`.
- **Public surface:**
  - Registered mod identifier: `changes-review`.
  - Layout slot: `#panel-body` child `changes` in `layouts/mesh.json`.
  - Layout transitions: `→ Go to Test` invokes `run("layout.select", { stack: "panel-body", child: "test" })` and `run("layout.show", { id: "panel" })`.
  - Host IPC: Outbound review notes and check failure diagnostics dispatched through `hc(["send", agent.address, message])`.
  - Shared state bus:
    - Publishes `mesh.services` (including per-service `branch`, gated by workspace root + service root/branch signature).
    - Reads and writes `mesh.activeService` for synchronized service filtering.
    - Reads and updates `mesh.flows[activeTabId]` (`reviewedServices` checklist map and `stage: "test"` transition, preserving all sibling fields such as `leadTerminal`, `ticket`, `derivedTitle`, `manualTitle`, `testPlanPath`, and `prs`).
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`, `TextareaState`, `Textarea`, `Scrollbar`, `ScrollHandle`.
  - `herdr`: `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `notify`, `hc`, `run`, `layout`, `shared`, `setShared`, `window`.
- **Forbidden:**
  - Any usage of `localStorage` or browser DOM APIs.
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
|   auth-api · feat/PROJ-412   [Pending]    [Approve Service ✓]   [→ Go to Test]   |
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
2. **Virtual Diff Rendering:**
   Diff lines are pre-processed into lightweight metadata objects via `diffRows()`, ensuring that only visible rows within the scroll viewport are evaluated by GPUI during frame layout.
3. **Theme Dynamic Adaptation:**
   Diff additions and deletions calculate background tint using `hexWithAlpha` derived dynamically from `theme().diff_add` / `theme().diff_del` (or ANSI fallback tokens), ensuring high contrast across both light and dark themes.
4. **Composite File Keys:**
   All internal state references (`this.open`, `this.expandedFiles`, `this.reviews`) MUST index files via composite `${serviceId}::${path}` keys to prevent cross-service collision.
5. **Zero `localStorage` & Non-Reentrant Shared Updates:**
   Never call `localStorage` or write to `shared()` inside `render()`. Publish `mesh.services` only when root/branch topology changes and merge `mesh.flows[tabId]` mutations onto the latest snapshot.

## Multi-Repo & Mesh Implementation

### Workspace Root Anchoring (`location`)
The workspace root is anchored to `space.folder`. When developers or terminal sessions navigate into subfolders or individual microservice directories, the review context maintains `space.folder` as the workspace boundary. Only when `space.folder` is absent or `pane.cwd` is outside `space.folder` does `location()` fall back to `pane.cwd`. State cache identity `key()` depends only on `{ cwd: loc.cwd, on: loc.on, spaceId: loc.spaceId }`, preventing pane focus switches from resetting review view state.

### Multi-Repository Discovery & Per-Service Branches (`discoverRepos`, `currentBranch`)
Scans `workspaceRoot` up to depth 2 (`$root/*` and `$root/*/*`) using a fast, non-recursive POSIX shell command (with PowerShell fallback for Windows). Automatically filters out dependency and build directories (`node_modules`, `target`, `dist`, `build`, `.git`, `vendor`, `.venv`), falling back to `git rev-parse --show-toplevel` on `workspaceRoot`. During `refresh(cx)`, each discovered service resolves `branch` via lock-free `currentBranch(service.root, on)` and stores `service.branch` (and `service.currentBranch`) on `this.services`.

### Shared Bus Synchronization (`mesh.services` & `mesh.activeService`)
Discovered microservices (including `branch` and `workingCount`) are published to `mesh.services` only when the signature `workspaceRoot + "::" + services.map(s => `${s.root}@${s.branch || ""}`).join(",")` changes, preventing re-render loops while keeping sibling mods (`mesh-flow`, `mesh-status`, `mesh-test`, `mesh-ship`) synchronized on branch switches. Active service filter state (`"all"` or a specific `serviceId`) is synchronized bidirectionally over `mesh.activeService` with monotonic timestamp ordering.

### Service Filter Bar, Microservice Review Bar & Per-Tab Checklist (`mesh.flows`)
- **Active Tab Identification:** Resolves `activeTabId = spaces().find(s => s.active)?.tabs?.find(t => t.active)?.id || null` and reads `shared("mesh.flows")?.[activeTabId] || {}`.
- **Status Resolution:** Each service resolves to `"has_notes"` if `this.reviews.some(r => r.serviceId === serviceId)`, else `"approved"` if `flow.reviewedServices?.[serviceId]?.status === "approved"`, else `"pending"`.
- **Service Filter Pills:** When multiple repositories exist, renders horizontally scrollable pills sorted dirty-first then alphabetically, displaying status glyph (`✓` in `t.ansi2`, `✎` in `t.blocked`, `○` in `t.dim`), service name, compact `service.branch` badge, and dirty count.
- **Microservice Review Bar & `Approve Service ✓`:** Rendered when a single service is active or when the workspace has a sole repository (`services.length === 1`), showing service name, branch, status pill (`Pending` | `Has notes` | `Approved ✓`), and `Approve Service ✓` (or `Unapprove`). Approving persists `{ status: "approved", branch, updatedAt }` under `mesh.flows[activeTabId].reviewedServices[serviceId]` and automatically jumps `this.activeService` / `mesh.activeService` to the next unapproved dirty microservice (`workingCount > 0`), if any.
- **`→ Go to Test` Transition:** When all dirty microservices (`workingCount > 0`) are `"approved"` (or at least one service is `"approved"` when no files are dirty) and `this.reviews.length === 0`, renders a prominent `→ Go to Test` button that sets `mesh.flows[activeTabId].stage = "test"` and executes `run("layout.select", { stack: "panel-body", child: "test" })` + `run("layout.show", { id: "panel" })`.

### Repository Standards & Check Runner (`#changes-checks-btn` & Checks Drawer)
Clicking `Checks` (`#changes-checks-btn`) in the header toggles a collapsible drawer above the changed files and diff area for the target service(s) (`activeService === "all"` targets dirty services or all services; otherwise the selected service). Discovery inspects root files via `readTextFile`:
1. `AGENTS.md`, `CLAUDE.md`, `SPEC.md`: displays standards doc indicator badges and parses fenced shell commands, `Checks:`/`Verification:`/`Verify:`/`Test:`/`Lint:` lines, and inline backticked test/lint/build commands (`npm run ...`, `npm test`, `mvn ...`, `cargo ...`, `go test ...`, `pytest ...`, `ng test`, `ng lint`, `herdr-app check`, `node --check`, etc.).
2. `package.json`: detects `scripts.lint`, `scripts.typecheck`, `scripts.test`, and `scripts.build`.
3. `pom.xml`: detects `./mvnw test` (when `mvnw` / `mvnw.cmd` exists) or `mvn test`.
4. `Cargo.toml`: detects `cargo check` and `cargo test`.
5. `Makefile`: detects `lint`, `test`, and `check` targets.

Individual checks (`Run` / `Re-run`) or batch checks (`Run All`) run via `exec(cmd, args, { cwd: service.root, on, timeout: 120000 })`, displaying pass/fail badges, duration, and ANSI-stripped scrollable tail output (`stdout`/`stderr`). When any check fails, `Send Failures to Agent` dispatches structured per-service diagnostics via `hc(["send", agent.address, msg])` to `findActiveAgent()`.

### Lead-Terminal-Prioritized Agent Resolution (`findActiveAgent`)
Resolves the target agent strictly in this priority order:
1. `mesh.flows[activeTabId]?.leadTerminal` matched in `agents()` or live `terminals()`.
2. `focused()?.agent` matched in `agents()` (excluding terminals labeled `meshRunner === "true"`).
3. Non-runner agent in `activeTabId` across `panes()`, `terminals()`, and `agents()` (excluding `labels?.meshRunner === "true"`).
4. Any agent in `activeTabId`.
5. `agents()[0]` global fallback.

### Multi-Repository Batch Commits
In `All` mode, committing executes `git add -A` and `git commit -m message` sequentially across all services with dirty working trees (`workingCount > 0`). When a specific service is filtered, only that service is committed. Button copy dynamically displays `Commit (${targetRepos.length} repos)` when multiple services are dirty.
