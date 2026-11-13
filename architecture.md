---
id: architecture
type: architecture-design
status: active
title: Herdr Mesh — Top-level Architecture
parent: goal-and-requirements
references: [module-layouts, module-mods, spec-lifecycle]
covers: [layout-topology, mod-lifecycle, shared-state-bus, multi-repo-discovery, lock-free-git, runtime-storage-boundary, zero-localstorage]
tags: [architecture, herdr, gpui-kit, layout, mods, lifecycle]
---

## Drivers

The architecture of Herdr Mesh is governed by requirements for multi-service agent agility, organic terminal-first workflows, zero repository pollution, non-blocking background interactions, and strict spec-driven modularity (`[[spec-lifecycle]]`):

1. **Multi-Service Microservice Workflows:** Engineering features routinely span multiple microservice repositories. The layout and mods present integrated terminal sessions, stage tracking, file trees, per-service reviews, live tests, and promotion PRs without forcing manual directory switching.
2. **Native GPUI-Kit High-Performance UI:** All UI views run in Herdr's embedded GPUI JavaScript engine (`gpui-shell 0.7.x`) using native builders (`div()`, `h_flex()`, `v_flex()`, `image()`, `svg()`, `list()`), ensuring sub-millisecond input handling and 60fps scrolling without DOM/HTML or `localStorage`.
3. **Lock-Free Filesystem & Git Concurrency:** Background repository discovery, branch tracking, git status polling, and diff rendering MUST include strict lock-free flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`) so concurrent agent Git operations never fail on `.git/index.lock`.
4. **Decoupled Shared State Bus & Zero `localStorage`:** Mods coordinate strictly through Herdr's reactive bus (`shared()`, `setShared()`) using documented `mesh.*` and mod-prefixed namespaces; browser `localStorage` is strictly prohibited.
5. **Zero-Pollution Runtime Storage:** Runtime test plans, Playwright E2E screenshots, and shared PR templates reside exclusively under `${appHome()}/mesh/`, keeping microservice working trees completely clean.

---

## Topology

The root UI topology is defined by `layouts/mesh.json` (`[[module-layouts]]`), partitioning the desktop window into `#sidebar`, `#work` (`#tabs`, `#flow`, `#work-body` with `#main` + collapsible `#panel` stack), `#status`, and floating modal overlays (`files-search-win`, screenshot zoom dialog).

```text
+------------------------------------------------------------------------------------------------------+
|                                  Herdr Mesh Layout (layouts/mesh.json)                               |
+--------------+-----------------------------------------------------------------------+---------------+
|   #sidebar   |  #tabs (42px, mod: mesh-tabs — auto-naming, inline rename, toggles)   |               |
|              +-----------------------------------------------------------------------+               |
| - Spaces     |  #flow (38px, mod: mesh-flow — PROJ-412 | Auto | 1.Plan..6.CI→main)   |               |
| - Agents     +---------------------------------------------------+-------------------+    #panel     |
| - Footer     |  #main (Active Agent & Runner Split Panes)        |  #panel-body      | (Collapsible) |
|              |                                                   |  [stack active]   |               |
|              |    $ claude "Implement PROJ-412..."               |  - files-search   |               |
|              |    [Lead Agent: t1 | Service Runner: t2]          |  - changes-review |               |
|              |                                                   |  - mesh-test      |               |
|              |    +-------------------------------------------+  |  - mesh-ship      |               |
|              |    | files-search-win / screenshot-zoom        |  |                   |               |
|              |    +-------------------------------------------+  |                   |               |
+--------------+---------------------------------------------------+-------------------+---------------+
| #status (28px, mod: mesh-status — machine, services/branch, stage, mesh.testAlert, PRs, agents)       |
+------------------------------------------------------------------------------------------------------+
```

### Zone Breakdown

- **`#sidebar`:** Hosts workspace spaces, remote machines, agent roster, and preferences (`workspace-chrome`, `spaces`, `agents`).
- **`#tabs` (`42px`, `mesh-tabs`):** Workspace tab strip with organic auto-naming (Jira key + prompt/branch summary), 1-click inline rename, drag reorder, `mesh.spacePanels` per-space panel memory, and drawer toggles (`files`, `changes`, `test`, `ship`).
- **`#flow` (`38px`, `mesh-flow`):** Tab-scoped 6-stage lifecycle bar (`1. Plan` → `2. Build` → `3. Review` → `4. Test` → `5. PR → dev` → `6. CI → main`), inline title/ticket pill, `Auto` name re-sync trigger, `leadTerminal` indicator, and stage-to-panel coupling.
- **`#main`:** Primary terminal workspace hosting feature agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`) and optional `+ Service Runner` split panes managed by `herdr-core` (`hc`).
- **`#panel` / `#panel-body`:** Collapsible mutually exclusive stack hosting:
  - `#files` (`[[submodule-mod-files-search]]`): Multi-repo file tree with git status decorators and Search Everywhere overlay (`files-search-win`).
  - `#changes` (`[[submodule-mod-changes-review]]`): Per-service branches, diffs, inline review notes, `reviewedServices` checklist (`Approve Service ✓`), and `Checks` runner.
  - `#test` (`mesh-test`, `[[submodule-mod-mesh-test]]`): Zero-pollution test plan review (`curl` & Playwright E2E), live `watchFolder` updates, `ss -tln` port detection, `+ Service Runner` panes, and inline PNG screenshots via `image()`.
  - `#ship` (`mesh-ship`, `[[submodule-mod-mesh-ship]]`): Configurable promotion chain (`development → ci → main`), shared PR templates, live `gh` PR/CI/review monitoring, and single/batch promotion.
- **`#status` (`28px`, `mesh-status`):** Bottom telemetry bar displaying active host, service/dirty counts, active tab stage, live `mesh.testAlert` indicator, PR review alerts, agent summary, and palette shortcut.

---

## Module Catalog

```text
herdr-mesh/
├── layouts/               <- [[module-layouts]]: Layout recipe (layouts/mesh.json) & SPEC.md
├── openspec/specs/        <- [[spec-lifecycle]]: Agent IDE Lifecycle domain specification
└── mods/                  <- [[module-mods]]: Independent GPUI-kit mod extensions
    ├── SPEC.md
    ├── files-search/      <- [[submodule-mod-files-search]]: Search Everywhere & file tree
    ├── changes-review/    <- [[submodule-mod-changes-review]]: Per-service diff review & Checks
    ├── mesh-tabs/         <- [[submodule-mod-mesh-tabs]]: Tab strip, auto-naming, mesh.spacePanels
    ├── mesh-flow/         <- [[submodule-mod-mesh-flow]]: 6-stage pipeline & leadTerminal bar
    ├── mesh-test/         <- [[submodule-mod-mesh-test]]: Live curl/Playwright testing & runners
    ├── mesh-ship/         <- [[submodule-mod-mesh-ship]]: PR templates & gh promotion pipeline
    └── mesh-status/       <- [[submodule-mod-mesh-status]]: Lifecycle status telemetry bar
```

*(Note: Lifecycle submodules `mesh-tabs`, `mesh-flow`, `mesh-test`, `mesh-ship`, and `mesh-status` are governed by `[[spec-lifecycle]]` and `openspec/changes/agent-ide-lifecycle/`, with per-directory `SPEC.md` specs and implemented mod manifests.)*

---

## Multi-Repository Workspace Discovery & Review Architecture

1. **Workspace Root Anchoring (`resolveWorkspaceRoot`):**
   - Anchored to `space.folder` whenever `pane.cwd` equals or lies inside `space.folder`; falls back to `pane.cwd` only when `space.folder` is absent or `pane.cwd` is outside `space.folder`.
   - Component cache identity `key()` derives from `{ cwd, on, spaceId }` so focusing auxiliary panes never resets review state.
2. **Fast Lock-Free Multi-Repository Discovery (`discoverRepos`):**
   - Scans `workspaceRoot` up to depth 2 (`$root/*`, `$root/*/*`), pruning `node_modules`, `target`, `dist`, `build`, `.git`, `vendor`, `.venv`, and falling back to `git rev-parse --show-toplevel`.
3. **Loop-Free Shared Bus Synchronization:**
   - Publishes `mesh.services` **only** when the topology signature `${workspaceRoot}::${services.map(s => s.root).join(",")}` changes.
   - Synchronizes `mesh.activeService` with monotonic timestamp checks (`ts > lastActiveServiceTs`).
4. **Composite File Disambiguation (`${serviceId}::${path}`):**
   - Prevents path collisions across microservices for file selection, hunk expansion (`git diff -U99999`), and inline review comments.
5. **Tab-Scoped Lead Agent & Review/Checks Dispatch (`findActiveAgent`):**
   - Resolves target agent with `mesh.flows[tabId].leadTerminal` first, then focused agent, tab primary agent, and global `agents()[0]` fallback.
   - Prevents `+ Service Runner` split panes from hijacking review notes, check failures, test prompts, or PR commands.
6. **Microservice Checklist & Batch Commits:**
   - Tracks per-service review status (`pending | has_notes | approved`) in `mesh.flows[tabId].reviewedServices`; `Approve Service ✓` marks reviewed and advances to the next unreviewed dirty microservice.

---

## Runtime Storage Boundary (Zero Repo Pollution)

All transient and IDE-managed artifacts live inside Herdr's application home (`appHome()`) so microservice Git repositories remain clean:

- **Workspace Test Plans:** `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json`
- **Playwright E2E Screenshots:** `${appHome()}/mesh/workspaces/<workspaceHash>/screenshots/<tabId>/<caseId>.png` (rendered natively via `image(absPath)`)
- **PR Template Mirror:** `${appHome()}/mesh/pr-template.md`

---

## Cross-Module Shared State Contract

Communication between mods occurs exclusively over Herdr's persisted reactive bus (`shared(key)` / `setShared(key, value)`):

| Bus Key | Producer | Consumer | Payload Format | Description |
|---|---|---|---|---|
| `mesh.services` | `changes-review`, `files-search` | All mesh mods | `{ workspaceRoot: string, on: string\|null, services: Array<{ id, name, relPath, root, branch? }>, ts: number }` | Discovered microservice repositories (published on signature change). |
| `mesh.activeService` | `changes-review`, `files-search` | `changes-review`, `files-search`, `mesh-test`, `mesh-ship`, `mesh-status` | `{ workspaceRoot: string, serviceId: string, ts: number }` | Synchronized active service filter (`"all"` or specific `serviceId`). |
| `mesh.flows` | `mesh-flow`, `mesh-tabs`, `changes-review`, `mesh-ship` | `mesh-flow`, `mesh-tabs`, `changes-review`, `mesh-test`, `mesh-ship`, `mesh-status` | `Record<tabId, { tabId, workspaceRoot, stage, ticket, derivedTitle, manualTitle, leadTerminal, reviewedServices, testPlanPath?, prs?, updatedAt }>` | Tab-scoped lifecycle state: active stage (`plan`, `build`, `review`, `test`, `pr_dev`, `promote`), naming metadata, `leadTerminal`, per-service checklist, and PR snapshot. |
| `mesh.pipelineConfig` | `mesh-ship`, `mesh-test` | `mesh-ship`, `mesh-test` | `{ defaultChain: string[], defaultPrTemplate: string, workspaces: Record<workspaceRoot, { chain, repoOverrides?, prTemplate, prTemplatePath, browserMode, updatedAt }> }` | Configurable branch promotion chain (`["development", "ci", "main"]` default), per-repo overrides, PR template (`{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, `{{testSummary}}`), and Playwright browser mode. |
| `mesh.spacePanels` | `mesh-tabs` | `mesh-tabs` | `Record<spaceId, "files" \| "changes" \| "test" \| "ship" \| null>` | Persisted active `#panel-body` selection per space (replaces `localStorage`). |
| `mesh.testAlert` | `mesh-test` | `mesh-status`, `mesh-flow` | `{ tabId: string, workspaceRoot: string, status: "plan_ready" \| "running" \| "passed" \| "failed", total: number, passed: number, failed: number, running: number, summary?: string, ts: number }` | Real-time test execution summary and failure alert for the active tab. |
| `files-search.select` | `files-search` | `files-search` | `{ root: string, path: string, line: number\|null, ts: number }` | Triggers tree expansion and file preview jump from Search Everywhere. |
| `files-search.customSize` | `files-search` | `files-search` | `{ w: number, h: number }` | Persisted custom dimensions for Search Everywhere overlay. |
| `changes-review.focus` | `changes-review` | `changes-review` | `{ path: string, line?: number }` | Jumps to a modified line in the diff viewer. |
| `mesh.workspace_root` / `mesh.active_service` / `mesh.services_list` / `mesh.active_agent` | Layout / Legacy bridges | Legacy readers | Primitive / object payloads | Deprecated compatibility aliases retained only for legacy callers. |

All bus keys outside mod-private namespaces MUST carry the `mesh.*` prefix.

---

## Invariants

1. **Lock-Free Git Invariant:**
   All read-only Git executions (`git rev-parse`, `git status`, `git diff`, `git ls-files`, `git branch`) invoked by any mod MUST include:
   ```bash
   --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false
   ```
2. **Zero Browser DOM & Zero `localStorage` Invariant:**
   All view components MUST be pure GPUI-kit constructs. Browser globals (`window` DOM APIs, `document`, `HTMLElement`, `localStorage`) MUST NOT be referenced in any `herdr-mesh` mod; persisted UI state MUST use `shared()` / `setShared()` (e.g., `mesh.spacePanels`) or atomic `writeTextFile()` under `${appHome()}/mesh/`.
3. **Zero Repo Pollution Invariant:**
   Generated test plans, Playwright screenshot PNGs, and IDE metadata MUST be written exclusively under `${appHome()}/mesh/` and never inside microservice repositories.
4. **Layout Cloning Invariant:**
   Herdr shipped layouts (`main.json`, `terminals.json`, `win98.json`) and core shipped mods are immutable. Customizations reside exclusively in `layouts/mesh.json` and `mods/*`.
5. **Theme Color Inheritance:**
   All UI colors MUST derive dynamically from `theme()`, `settings().colors`, or `layout().colors`. Hardcoded hex color codes are strictly prohibited.
6. **Spec Consistency:**
   Every structural change to directories, layouts, interfaces, or bus keys MUST be reflected in the owning `SPEC.md` and `openspec/specs/` before or alongside code changes.
