---
id: architecture
type: architecture-design
status: active
title: Herdr Mesh — Top-level Architecture
parent: goal-and-requirements
references: [module-layouts, module-mods, spec-lifecycle]
covers: [layout-topology, mod-lifecycle, shared-state-bus, multi-repo-discovery, lock-free-git, session-scoped-repo-attribution, zero-localstorage]
tags: [architecture, herdr, gpui-kit, layout, mods]
---

## Drivers

The architecture of Herdr Mesh is governed by requirements for multi-service agent agility, organic terminal-first workflows, non-blocking cross-platform performance, and strict spec-driven modularity (`[[spec-lifecycle]]`):

1. **Session-Scoped Multi-Service Workflows:** Engineering features routinely span multiple microservice repositories or lead an agent from one microservice into a sibling repo. `files-search` and `changes-review` attribute touched repositories per tab session (`sessionRepos`) so developers see only relevant repos without `/Projects` clutter.
2. **Native GPUI-Kit High-Performance UI:** All UI views run in Herdr's embedded GPUI JavaScript engine (`gpui-shell 0.7.x`) using native builders (`div()`, `h_flex()`, `v_flex()`, `svg()`, `list()`), keeping `render()` pure (deferring sync actions via `cx.timer.after(0, ...)`) and clean teardown in `close()`.
3. **Lock-Free Filesystem & Cross-Platform Performance:** Background repository discovery (`fs/promises` locally, SSH shell remotely, cached 60s), git status (`--untracked-files=normal`), debounced `watchFolder` (ignoring `node_modules`, `target`, `.git` internal locks), hidden-panel throttling, and `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` eliminate Windows PowerShell storms and `.git/index.lock` contention.
4. **Decoupled Shared State Bus & Zero `localStorage`:** Mods coordinate strictly through Herdr's reactive bus (`shared()`, `setShared()`) using `mesh.*` and mod-prefixed namespaces; browser `localStorage` is strictly prohibited.

---

## Topology

The root UI topology is defined by `layouts/mesh.json` (`[[module-layouts]]`), partitioning the desktop window into `#sidebar`, `#work` (`#tabs`, `#work-body` with `#main` + collapsible `#panel` stack), `#status`, and the floating `files-search-win` overlay.

```text
+------------------------------------------------------------------------------------------------------+
|                                  Herdr Mesh Layout (layouts/mesh.json)                               |
+--------------+-----------------------------------------------------------------------+---------------+
|   #sidebar   |  #tabs (42px, mod: mesh-tabs — auto-naming, inline rename, toggles)   |               |
|              +---------------------------------------------------+-------------------+               |
| - Spaces     |  #main (Active Agent & Terminal Panes)            |  #panel-body      |    #panel     |
| - Agents     |                                                   |  [stack active]   | (Collapsible) |
| - Footer     |    $ claude "Implement PROJ-412..."               |  - files-search   |               |
|              |                                                   |  - changes-review |               |
|              |    +-------------------------------------------+  |                   |               |
|              |    | files-search-win (Ctrl+P / Alt+F)         |  |                   |               |
|              |    +-------------------------------------------+  |                   |               |
+--------------+---------------------------------------------------+-------------------+---------------+
| #status (28px, mod: mesh-status — machine, services · dirty, branch, agents, commands palette hint)  |
+------------------------------------------------------------------------------------------------------+
```

### Zone Breakdown

- **`#sidebar`:** Hosts workspace spaces, remote machines, agent roster, and preferences (`workspace-chrome`, `spaces`, `agents`).
- **`#tabs` (`42px`, `mesh-tabs`):** Workspace tab strip with organic auto-naming (Jira key + prompt/branch summary), double-click inline rename, drag reorder, `mesh.spacePanels` per-space panel memory, and drawer toggles (`files`, `changes`).
- **`#main`:** Primary terminal workspace hosting feature agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`).
- **`#panel` / `#panel-body`:** Collapsible mutually exclusive stack hosting:
  - `#files` (`[[submodule-mod-files-search]]`): Session-scoped multi-repo file tree with git status decorators and Search Everywhere overlay (`files-search-win`).
  - `#changes` (`[[submodule-mod-changes-review]]`): Per-service branches, diffs, inline review notes, and `reviewedServices` checklist (`Approve Service ✓`).
- **`#status` (`28px`, `mesh-status`):** Bottom telemetry bar displaying active host, service/dirty counts, active branch, agent summary, and palette shortcut.

---

## Module Catalog

```text
herdr-mesh/
├── package.json           <- Zero-dependency test runner entrypoint (`npm test`)
├── tests/                 <- Native `node --test` unit/regression suites (`*.test.mjs` + `helpers/herdr-mock.mjs`)
├── layouts/               <- [[module-layouts]]: Layout recipe (layouts/mesh.json) & SPEC.md
├── openspec/specs/        <- [[spec-lifecycle]]: Agent Workspace domain specification
└── mods/                  <- [[module-mods]]: Independent GPUI-kit mod extensions
    ├── SPEC.md
    ├── files-search/      <- [[submodule-mod-files-search]]: Search Everywhere, indexer engine (`indexer.js`, `search-logic.js`)
    ├── changes-review/    <- [[submodule-mod-changes-review]]: Per-service diff review & checklist (`review-logic.js`)
    ├── mesh-tabs/         <- [[submodule-mod-mesh-tabs]]: Tab strip, auto-naming, `mesh.spacePanels` (`tab-logic.js`)
    └── mesh-status/       <- [[submodule-mod-mesh-status]]: Telemetry status bar
```

*(Legacy `mods/mesh-flow/` remains unused by `layouts/mesh.json` and is removed from `$HERDR_APP_HOME/mods/` during installation alongside obsolete `mesh-test` and `mesh-ship` directories.)*

---

## Multi-Repository Workspace Discovery & Review Architecture

1. **Workspace Root Anchoring (`location`):**
   - Anchored to `space.folder` whenever `pane.cwd` equals or lies inside `space.folder`; falls back to `pane.cwd` only when `space.folder` is absent or `pane.cwd` is outside `space.folder`.
   - Component cache identity `key()` derives from `{ cwd, on, spaceId }` so focusing auxiliary panes never resets review state.
2. **Fast Lock-Free Multi-Repository Discovery & Attribution:**
   - Scans `workspaceRoot` up to depth 2 (`$root/*`, `$root/*/*`), plus parent siblings (`depth 1`) when `workspaceRoot` is itself a repo and extra tab `pane.cwd` paths, pruning `DISCOVER_SKIP_DIRS` and caching candidates (`REPO_CACHE_TTL_MS = 60000`).
   - Filters discovered dirty/ahead repos through `attributeSessionServices` / `attributeSessionRepos`, matching active-tab `pane.cwd`, transcript activity (`hc read`), and previously recorded `mesh.flows[tabId].sessionRepos` so unrelated repos stay hidden.
3. **Loop-Free Shared Bus Synchronization (`mesh.services`):**
   - `files-search` runs git status once (`--untracked-files=normal`) and publishes `mesh.services` with a canonical `sig` and 45s heartbeat; `changes-review` consumes `mesh.services` (`BUS_MAX_AGE_MS = 90000`) when fresh instead of re-scanning the filesystem, waking only when `bus.sig` changes.
   - Synchronizes `mesh.activeService` with monotonic timestamp checks (`ts > lastActiveServiceTs`).
4. **Composite File Disambiguation (`${serviceId}::${path}`):**
   - Prevents path collisions across microservices for file selection, hunk expansion (`git diff -U99999`), and inline review comments.
5. **Tab-Scoped Lead Agent & Review Dispatch (`findActiveAgent`):**
   - Resolves target agent with `mesh.flows[tabId].leadTerminal` first, then focused agent, tab primary agent, and global `agents()[0]` fallback.
6. **Microservice Checklist & Batch Commits:**
   - Tracks per-service review status (`pending | has_notes | approved`) in `mesh.flows[tabId].reviewedServices`; `Approve Service ✓` marks reviewed and advances to the next unreviewed dirty microservice.

---

## Cross-Module Shared State Contract

Communication between mods occurs exclusively over Herdr's persisted reactive bus (`shared(key)` / `setShared(key, value)`):

| Bus Key | Producer | Consumer | Payload Format | Description |
|---|---|---|---|---|
| `mesh.services` | `files-search`, `changes-review` | `files-search`, `changes-review`, `mesh-status` | `{ tabId, workspaceRoot, on, services, candidates, sig, ts }` | Session-attributed touched repositories and candidate cache metadata. |
| `mesh.activeService` | `changes-review`, `files-search` | `changes-review`, `files-search` | `{ workspaceRoot, serviceId, ts }` | Synchronized active service filter (`"all"` or specific `serviceId`). |
| `mesh.flows` | `mesh-tabs`, `changes-review` | `mesh-tabs`, `changes-review`, `files-search` | `Record<tabId, { tabId?, ticket?, derivedTitle?, autoNamed?, manualTitle?, leadTerminal?, reviewedServices?, sessionRepos?, updatedAt }>` | Tab-scoped metadata: naming state, `leadTerminal`, per-service checklist, and attributed session repos. |
| `mesh.spacePanels` | `mesh-tabs` | `mesh-tabs` | `Record<spaceId, "files" \| "changes" \| null>` | Persisted active `#panel-body` selection per space (replaces `localStorage`). |
| `files-search.select` | `files-search` | `files-search` | `{ root: string, path: string, line: number\|null, ts: number }` | Triggers tree expansion and file preview jump from Search Everywhere. |
| `files-search.customSize` | `files-search` | `files-search` | `{ w: number, h: number }` | Persisted custom dimensions for Search Everywhere overlay. |
| `changes-review.focus` | `changes-review` | `changes-review` | `{ path: string, line?: number }` | Jumps to a modified line in the diff viewer. |

All bus keys outside mod-private namespaces MUST carry the `mesh.*` prefix.

---

## Invariants

1. **Lock-Free Git Invariant:**
   All read-only Git executions (`git rev-parse`, `git status`, `git diff`, `git ls-files`, `git log`, `git grep`, `git for-each-ref`, `git rev-list`) invoked by any mod MUST include:
   ```bash
   --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false
   ```
2. **Zero Browser DOM, Zero `localStorage` & Pure Render Invariant:**
   All view components MUST be pure GPUI-kit constructs without `localStorage`, DOM APIs, or synchronous `cx.notify()` / `setShared()` / widget `set_value()` inside `render()`. Persisted UI state uses `shared()` / `setShared()`.
3. **Layout Cloning Invariant:**
   Herdr shipped layouts (`main.json`, `terminals.json`, `win98.json`) and core shipped mods are immutable. Customizations reside exclusively in `layouts/mesh.json` and `mods/*`.
4. **Theme Color Inheritance:**
   All UI colors MUST derive dynamically from `theme()`, `settings().colors`, or `layout().colors`. Hardcoded hex color codes are strictly prohibited.
5. **Spec Consistency:**
   Every structural change to directories, layouts, interfaces, or bus keys MUST be reflected in the owning `SPEC.md` and `openspec/specs/` before or alongside code changes.
6. **Pure Logic Decoupling & Mandatory Unit Tests:**
   Testable business logic (indexing, watch filtering, query scoring, Git/diff parsing, tab naming) MUST reside in zero-UI intra-mod helper modules (`indexer.js`, `*-logic.js`) covered by native `node --test` suites under `tests/*.test.mjs` (`npm test`) whenever developed or fixed.
