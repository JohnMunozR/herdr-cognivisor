---
id: architecture
type: architecture-design
status: active
title: Herdr Cognivisor — Top-level Architecture
parent: goal-and-requirements
references: [module-layouts, module-mods, module-shared, spec-lifecycle]
covers: [layout-topology, mod-lifecycle, shared-state-bus, multi-repo-discovery, lock-free-git, session-scoped-repo-attribution, zero-localstorage]
tags: [architecture, herdr, gpui-kit, layout, mods]
---

## Drivers

The architecture of Herdr Cognivisor is governed by requirements for multi-service agent agility, organic terminal-first workflows, non-blocking cross-platform performance, and strict spec-driven modularity (`[[spec-lifecycle]]`):

1. **Session-Scoped Multi-Service Workflows:** Engineering features routinely span multiple microservice repositories or lead an agent from one microservice into a sibling repo. `files-search` and `changes-review` attribute touched repositories per tab session (`sessionRepos`) so developers see only relevant repos without `/Projects` clutter.
2. **Native GPUI-Kit High-Performance UI:** All UI views run in Herdr's embedded GPUI JavaScript engine (`gpui-shell 0.7.x`) using native builders (`div()`, `h_flex()`, `v_flex()`, `svg()`, `list()`), keeping `render()` pure (deferring sync actions via `cx.timer.after(0, ...)`) and clean teardown in `close()`.
3. **Lock-Free Filesystem & Cross-Platform Performance:** Background repository discovery (`fs/promises` locally, SSH shell remotely, cached 60s), git status (`--untracked-files=normal`), debounced `watchFolder` (ignoring `node_modules`, `target`, `.git` internal locks), hidden-panel throttling, and `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` eliminate Windows PowerShell storms and `.git/index.lock` contention.
4. **Decoupled Shared State Bus & Zero `localStorage`:** Mods coordinate strictly through Herdr's reactive bus (`shared()`, `setShared()`) using `cognivisor.*` and mod-prefixed namespaces; browser `localStorage` is strictly prohibited.

---

## Topology

The root UI topology is defined by `layouts/cognivisor.json` (`[[module-layouts]]`), partitioning the desktop window into `#sidebar`, `#work` (`#tabs`, `#work-body` with `#main` + collapsible `#panel` stack), `#status`, and the floating `files-search-win` overlay.

```text
+------------------------------------------------------------------------------------------------------------+
|                             Herdr Cognivisor Layout (layouts/cognivisor.json)                              |
+--------------+-----------------------------------------------------------------------------+---------------+
|   #sidebar   |  #tabs (42px, mod: cognivisor-tabs — auto-naming, inline rename, toggles)   |               |
|              +---------------------------------------------------------+-------------------+               |
| - Spaces     |  #main (Active Agent & Terminal Panes)                  |  #panel-body      |    #panel     |
| - Agents     |                                                         |  [stack active]   | (Collapsible) |
| - Footer     |    $ claude "Implement PROJ-412..."                     |  - files-search   |               |
|              |                                                         |  - changes-review |               |
|              |    +-------------------------------------------+        |  - git-history    |               |
|              |    | files-search-win (Ctrl+P / Alt+F)         |        |                   |               |
|              |    +-------------------------------------------+        |                   |               |
+--------------+---------------------------------------------------------+-------------------+---------------+
| #status (28px, mod: cognivisor-status — machine, services · dirty, branch, agents, commands palette hint)  |
+------------------------------------------------------------------------------------------------------------+
```

### Zone Breakdown

- **`#sidebar`:** Hosts workspace spaces, remote machines, agent roster, and preferences (`workspace-chrome`, `spaces`, `agents`).
- **`#tabs` (`42px`, `cognivisor-tabs`):** Workspace tab strip with organic auto-naming (Jira key + prompt/branch summary), double-click inline rename, drag reorder, `cognivisor.spacePanels` per-space panel memory, and drawer toggles (`files`, `changes`, `git`).
- **`#main`:** Primary terminal workspace hosting feature agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`) and reusable single-tab `role: "viewer"` tabs (`files-search`, `changes-review`, `git-history`).
- **`#panel` / `#panel-body`:** Collapsible mutually exclusive stack hosting:
  - `#files` (`[[submodule-mod-files-search]]`): Session-scoped multi-repo file tree with git status decorators and Search Everywhere overlay (`files-search-win`).
  - `#changes` (`[[submodule-mod-changes-review]]`): Per-service branches, diffs, inline review notes, per-file `Approve` / `Approved ✓` review tracking with automatic fingerprint/commit invalidation, and organic service pill status (`pending | has_notes | approved`).
  - `#git` (`[[submodule-mod-git-history]]`): All-repo (clean + dirty) commit graph, branch/text filters, and modified files driving a reusable `#main` Before/After comparison tab.
- **`#status` (`28px`, `cognivisor-status`):** Bottom telemetry bar displaying active host, service/dirty counts, active branch, agent summary, and palette shortcut.

---

## Module Catalog

```text
herdr-cognivisor/
├── package.json           <- Zero-dependency test runner entrypoint (`npm test`)
├── tests/                 <- Native `node --test` unit/regression suites (`*.test.mjs` + `helpers/herdr-mock.mjs`)
├── layouts/               <- [[module-layouts]]: Layout recipe (layouts/cognivisor.json) & SPEC.md
├── shared/                <- [[module-shared]]: Canonical pure engines (`code-wrap.js`, `code-syntax.js`, `code-nav-*.js`, `dropdown-logic.js`, `markdown-syntax.js`, `markdown-view-logic.js`), UI adapters (`dropdown.js`, `markdown-view.js`), & `scripts/sync-shared.mjs`
├── openspec/specs/        <- [[spec-lifecycle]]: Agent Workspace domain specification
└── mods/                  <- [[module-mods]]: Independent GPUI-kit mod extensions
    ├── SPEC.md
    ├── files-search/      <- [[submodule-mod-files-search]]: Search Everywhere, interactive File Viewer (`indexer.js`, `symbol-index.js`, `code-viewer.js`, `search-logic.js`, `tree-logic.js`, `session-baseline.js`, synced `shared/` modules)
    ├── changes-review/    <- [[submodule-mod-changes-review]]: Per-service diff review & file approval (`review-logic.js`, `code-wrap.js`, `markdown-syntax.js`, `dropdown-logic.js`, `dropdown.js`)
    ├── git-history/       <- [[submodule-mod-git-history]]: Topological commit graph & Before/After diff viewer (`graph-logic.js`, `diff-logic.js`, `repo-logic.js`, `code-wrap.js`, `markdown-syntax.js`, `dropdown-logic.js`, `dropdown.js`)
    ├── cognivisor-tabs/   <- [[submodule-mod-cognivisor-tabs]]: Tab strip, auto-naming, `cognivisor.spacePanels` (`tab-logic.js`)
    └── cognivisor-status/ <- [[submodule-mod-cognivisor-status]]: Telemetry status bar
```

*(Legacy `mods/cognivisor-flow/` remains unused by `layouts/cognivisor.json` and is removed from `$HERDR_APP_HOME/mods/` during installation alongside obsolete `cognivisor-test` and `cognivisor-ship` directories.)*

---

## Multi-Repository Workspace Discovery & Review Architecture

1. **Workspace Root Anchoring (`location`):**
   - Anchored to `space.folder` whenever `pane.cwd` equals or lies inside `space.folder`; falls back to `pane.cwd` only when `space.folder` is absent or `pane.cwd` is outside `space.folder`.
   - Component cache identity `key()` derives from `{ cwd, on, spaceId }` so focusing auxiliary panes never resets review state.
2. **Fast Lock-Free Multi-Repository Discovery & Attribution:**
   - Scans `workspaceRoot` up to depth 2 (`$root/*`, `$root/*/*`), plus parent siblings (`depth 1`) when `workspaceRoot` is itself a repo and extra tab `pane.cwd` paths, pruning `DISCOVER_SKIP_DIRS` and caching candidates (`REPO_CACHE_TTL_MS = 60000`).
   - Filters discovered dirty/ahead repos through `attributeSessionServices` / `attributeSessionRepos`, matching active-tab `pane.cwd`, transcript activity (`hc read`), and previously recorded `cognivisor.flows[tabId].sessionRepos` so unrelated repos stay hidden.
3. **Loop-Free Shared Bus Synchronization (`cognivisor.services`):**
   - `files-search` runs git status once (`--untracked-files=normal`) and publishes `cognivisor.services` with a canonical `sig` and 45s heartbeat; `changes-review` consumes `cognivisor.services` (`BUS_MAX_AGE_MS = 90000`) when fresh instead of re-scanning the filesystem, waking only when `bus.sig` changes.
   - Synchronizes `cognivisor.activeService` with monotonic timestamp checks (`ts > lastActiveServiceTs`).
4. **Composite File Disambiguation (`${serviceId}::${path}`):**
   - Prevents path collisions across microservices for file selection, hunk expansion (`git diff -U99999`), and inline review comments.
5. **Tab-Scoped Lead Agent & Review Dispatch (`findActiveAgent`):**
   - Resolves target agent with `cognivisor.flows[tabId].leadTerminal` first, then focused agent, tab primary agent, and global `agents()[0]` fallback.
6. **Per-File Review Tracking, Automatic Invalidation & Organic Service Status:**
   - Tracks per-file review records (`{ reviewed: true, fp, reviewedAt }`) in `cognivisor.flows[tabId].reviewedFiles` using `computeFileReviewFingerprint` (`buildFileDescriptor` preserving `sig`/`mtimeMs`), automatically invalidating stale checks via `reconcileReviewedFiles` when working files change or leave the tree, when `headHash` transitions, or when newer commits touch reviewed files.
   - Service pill status (`pending | has_notes | approved`) is derived organically from `cognivisor.reviewNotes` (`"has_notes"`) and `reviewedFiles` (`"approved"` only when dirty working files exist and all of them are reviewed), while the Review tab's non-checkbox `Approve` / `Approved ✓` button advances to the next unreviewed file.

---

## Cross-Module Shared State Contract

Communication between mods occurs exclusively over Herdr's persisted reactive bus (`shared(key)` / `setShared(key, value)`):

| Bus Key | Producer | Consumer | Payload Format | Description |
|---|---|---|---|---|
| `cognivisor.services` | `files-search`, `changes-review` | `files-search`, `changes-review`, `git-history`, `cognivisor-status` | `{ tabId, workspaceRoot, on, services, candidates, sig, ts }` | Session-attributed touched repositories and candidate cache metadata. |
| `cognivisor.activeService` | `changes-review`, `files-search`, `git-history` | `changes-review`, `files-search`, `git-history` | `{ workspaceRoot, serviceId, ts }` | Synchronized active service filter (`"all"` or specific `serviceId`; `git-history` updates only for repos present in `cognivisor.services`). |
| `cognivisor.flows` | `cognivisor-tabs`, `changes-review` | `cognivisor-tabs`, `changes-review`, `files-search` | `Record<tabId, { tabId?, ticket?, derivedTitle?, autoNamed?, manualTitle?, leadTerminal?, reviewedFiles?, sessionRepos?, sessionBaseline?, updatedAt }>` | Tab-scoped metadata: naming state, `leadTerminal`, per-file review checklist (`reviewedFiles`), session baseline, and attributed session repos. |
| `cognivisor.spacePanels` | `cognivisor-tabs` | `cognivisor-tabs` | `Record<spaceId, "files" \| "changes" \| "git" \| null>` | Persisted active `#panel-body` selection per space (replaces `localStorage`). |
| `cognivisor.spaceAgentTabs` | `files-search`, `changes-review`, `git-history` | `files-search`, `changes-review`, `git-history` | `Record<spaceId, tabId>` | Preserves each space's active terminal-bearing tab ID while non-terminal `role: "viewer"` tabs are focused. |
| `files-search.select` | `files-search` | `files-search` | `{ root: string, path: string, line: number\|null, ts: number }` | Triggers tree expansion and file preview jump from Search Everywhere. |
| `files-search.customSize` | `files-search` | `files-search` | `{ w: number, h: number }` | Persisted custom dimensions for Search Everywhere overlay. |
| `changes-review.focus` | `changes-review` | `changes-review` | `{ path: string, line?: number }` | Jumps to a modified line in the diff viewer. |
| `git-history.activeDiff` | `git-history` | `git-history` | `Record<spaceId, GitDiffViewerState>` | Coordinates the space's single `#main` `git-history` comparison tab (`commitHash`, `openFileKey`, `files`, `diffMode`, `expanded`, `requestSeq`, `ts`). |
| `git-history.selectedRepo` | `git-history` | `git-history` | `Record<spaceId, { repoRoot: string, ts: number }>` | Persists the selected repository (clean or dirty) per space in `#git`. |

All bus keys outside mod-private namespaces MUST carry the `cognivisor.*` prefix.

---

## Invariants

1. **Lock-Free Git Invariant:**
   All read-only Git executions (`git rev-parse`, `git status`, `git diff`, `git diff-tree`, `git show`, `git ls-files`, `git log`, `git grep`, `git for-each-ref`, `git rev-list`) invoked by any mod MUST include:
   ```bash
   --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false
   ```
2. **Zero Browser DOM, Zero `localStorage` & Pure Render Invariant:**
   All view components MUST be pure GPUI-kit constructs without `localStorage`, DOM APIs, or synchronous `cx.notify()` / `setShared()` / widget `set_value()` inside `render()`. Persisted UI state uses `shared()` / `setShared()`.
3. **Layout Cloning Invariant:**
   Herdr shipped layouts (`main.json`, `terminals.json`, `win98.json`) and core shipped mods are immutable. Customizations reside exclusively in `layouts/cognivisor.json` and `mods/*`.
4. **Theme Color Inheritance:**
   All UI colors MUST derive dynamically from `theme()`, `settings().colors`, or `layout().colors`. Hardcoded hex color codes are strictly prohibited.
5. **Spec Consistency:**
   Every structural change to directories, layouts, interfaces, or bus keys MUST be reflected in the owning `SPEC.md` and `openspec/specs/` before or alongside code changes.
6. **Pure Logic Decoupling & Mandatory Unit Tests:**
   Testable business logic (indexing, watch filtering, query scoring, Git/diff parsing, tab naming) MUST reside in zero-UI intra-mod helper modules (`indexer.js`, `*-logic.js`) covered by native `node --test` suites under `tests/*.test.mjs` (`npm test`) whenever developed or fixed.
7. **Shared Reusable Components & `shared/` Registry (`[[module-shared]]`):**
   Developers and AI agents MUST inspect `shared/` first and extend/reuse canonical shared engines (`code-wrap.js`, `code-syntax.js`, `code-nav-logic.js`, `code-nav-js.js`, `code-nav-python.js`, `code-nav-java.js`, `dropdown-logic.js`, `markdown-syntax.js`, `markdown-view-logic.js`) and GPUI UI adapters (`dropdown.js`, `markdown-view.js`) registered in `scripts/sync-shared.mjs` and `install.sh` rather than duplicating widgets, wrappers, dropdowns, navigation analyzers, or syntax tokenizers inside individual mods.
8. **Performance & Rendering Optimization Invariant:**
   Scrollable lists and diff panes MUST use `v_virtual_list` + `VirtualListScrollHandle` with precomputed/memoized row heights; closed overlays, dropdown menus, and hidden panels MUST produce zero per-frame UI allocations; floating popovers MUST size adaptively via `computeDropdownMetrics` without empty overflow scrollboxes; scanners and syntax tokenizers MUST run single-pass `O(n)` without catastrophic backtracking regexes; caches MUST be bounded (`WeakMap` or capped LRU maps); resize reflows MUST coalesce through `16ms` timers (`timer.after(16, ...)`); and background Git refreshes MUST combine lock-free flags with `git show-ref --head` signature skipping.
