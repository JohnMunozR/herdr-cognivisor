---
id: module-mods
type: module-design
status: active
title: Herdr Cognivisor Mods Suite
parent: architecture
references: [module-layouts, module-shared, spec-lifecycle]
covers: [gpui-kit-views, mod-manifests, shared-state-contracts, zero-localstorage, session-scoped-multi-repo]
tags: [mods, gpui-kit, herdr, lifecycle]
---

## Responsibility

The `module-mods` encapsulates the suite of interactive GPUI extensions operating within the Herdr desktop application runtime (`gpui-shell 0.7.x`). Together with `[[module-layouts]]` and `[[spec-lifecycle]]`, the mods suite transforms Herdr's terminal workspace into a multi-microservice Agent IDE: organic tab auto-naming (`cognivisor-tabs`), workspace-wide navigation (`files-search`), session-scoped microservice code review (`changes-review`), repository commit graph and Before/After diff comparison (`git-history`), and bottom telemetry (`cognivisor-status`).

Mods run as QuickJS JavaScript modules utilizing `gpui-kit` and `gpui-base` declarative components and interface with Herdr's native Rust core via the `herdr` host module.

## Boundary

- **Owns:**
  - Active mod packages under `mods/*` (`files-search`, `changes-review`, `git-history`, `cognivisor-tabs`, `cognivisor-status`; legacy `mods/cognivisor-flow` excluded from `layouts/cognivisor.json` and cleaned up on install).
  - Manifest definitions (`mod.json`) and mod registration schemas.
  - Mod view components (`main.js`, `code-viewer.js`), intra-mod pure logic modules (`indexer.js`, `symbol-index.js`, `search-logic.js`, `tree-logic.js`, `session-baseline.js`, `review-logic.js`, `graph-logic.js`, `diff-logic.js`, `repo-logic.js`, `tab-logic.js`), and synced `[[module-shared]]` runtime copies (`code-wrap.js`, `code-syntax.js`, `code-nav-logic.js`, `code-nav-js.js`, `code-nav-python.js`, `code-nav-java.js`, `markdown-syntax.js`, `markdown-view-logic.js`, `markdown-view.js`, `dropdown-logic.js`, `dropdown.js`).
  - Shared state event namespaces (`cognivisor.*`, `files-search.*`, `changes-review.*`, `git-history.*`) and cross-mod protocol contracts.
- **Public surface:**
  - Active mod directories installed into `$HERDR_APP_HOME/mods/`:
    - `mods/files-search`: Docked session-scoped multi-repo file tree and floating Search Everywhere overlay.
    - `mods/changes-review`: Per-service Git branch/diff inspector, file-level `Approve` / `Approved ✓` review tracking (`reviewedFiles`) with automatic check invalidation and organic service pill status (`pending | has_notes | approved`), and `leadTerminal`-prioritized agent dispatch.
    - `mods/git-history`: Docked all-repo topological commit graph (`#git`) and single reusable `#main` Before/After commit diff comparison tab.
    - `mods/cognivisor-tabs`: Workspace tab strip with organic Jira/prompt auto-naming, 1-click inline rename, 3-panel drawer toggles (`Files`, `Review`, `Git`), and `cognivisor.spacePanels` persistence.
    - `mods/cognivisor-status`: Bottom status bar displaying host machine, multi-service/dirty counts, active branch, agent activity, and palette trigger.
  - Mod command endpoints & keybindings:
    - `mod.open:files-search` (bound to `ctrl-p` and `alt-f` in `keys.json` and `install.sh`; no global shortcut is bound for `git-history` in `keys.json` by default).
    - `layout.select --stack panel-body --child files|changes|git`.
  - Reactive shared state channels:
    - `files-search.select`, `files-search.customSize`
    - `changes-review.activeDiff`
    - `git-history.activeDiff`, `git-history.selectedRepo`
    - `cognivisor.services`, `cognivisor.activeService`, `cognivisor.flows`, `cognivisor.spacePanels`, `cognivisor.spaceAgentTabs`, `cognivisor.openFileTabs`, `cognivisor.reviewNotes`
- **Allowed deps:**
  - `gpui-kit` primitives: `View`, `div`, `svg`, `image`, `list`, `PathBuilder`.
  - `gpui-base` widgets: `v_flex`, `h_flex`, `v_resizable`, `resizable_panel`, `v_virtual_list`, `VirtualListScrollHandle`, `Input`, `InputState`, `Textarea`, `TextareaState`, `Scrollbar`, `ScrollHandle`.
  - `herdr` host APIs: `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `notify`, `hc`, `run`, `layout`, `shared`, `setShared`, `props`, `openOverlay`, `closeOverlay`, `window`, `keys`.
- **Forbidden:**
  - Any usage of browser `localStorage` across `herdr-cognivisor` mods (persist via `shared()`/`setShared()`).
  - Calling `cx.notify()`, `setShared()`, or mutating input widget values synchronously during `render()`.
  - Spawning blocking synchronous loops in the JS thread or uncancelled `rg` / `exec` polling loops.
  - Invoking read-only Git operations without lock-free flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
  - Hardcoded color hex strings ignoring `theme()`, `settings()`, or `layout()`.
  - Duplicating shared wrappers, dropdown popovers, or Markdown/syntax engines per mod instead of reusing `[[module-shared]]` (`shared/` via `scripts/sync-shared.mjs` and `install.sh`).

## Shared Components & Performance Invariants

1. **Shared Reusable Components & `shared/` Registry (`[[module-shared]]`):**
   - Developers and AI agents MUST check `shared/` first before creating UI widgets, line wrappers, dropdowns, code-navigation analyzers, or syntax tokenizers inside any mod, extending and reusing `code-wrap.js`, `code-syntax.js`, `code-nav-*.js`, `dropdown-logic.js`, `dropdown.js`, `markdown-syntax.js`, `markdown-view-logic.js`, and `markdown-view.js` via `scripts/sync-shared.mjs`, `install.sh`, and `shared/SPEC.md`.
2. **Performance & Rendering Optimization Invariant:**
   - Virtualize scrollable lists and diff/commit panes via `v_virtual_list` + `VirtualListScrollHandle` with precomputed/memoized row heights.
   - Ensure zero per-frame UI allocations when overlays, dropdown menus, or docked panels are closed/hidden.
   - Size dropdown popovers adaptively (`computeDropdownMetrics`) without empty overflow scrollboxes (attach `.h(bodyHeight).overflow_y_scrollbar()` only when `shouldScroll === true`).
   - Write single-pass `O(n)` scanners and tokenizers with zero catastrophic backtracking regexes.
   - Bound caches (`WeakMap` or capped LRU maps) and coalesce resize reflows with `16ms` timers (`timer.after(16, ...)`).
   - Pair lock-free Git flags with `git show-ref --head` signature skip checks and zero synchronous side effects (`cx.notify()`, `setShared()`, `set_value()`) inside `render()`.

## Internal & Planned Submodules

| Submodule | Owns | Status / Spec |
| :--- | :--- | :--- |
| `submodule-mod-files-search` | Dual-mode file tree panel and floating Search Everywhere overlay (`files-search-win`) with ripgrep live search and shared file selection | Active (`[[submodule-mod-files-search]]`) |
| `submodule-mod-changes-review` | Multi-repo Git diff viewer, file-level review tracking (`Approve` / `Approved ✓`) with organic service status & automatic invalidation, inline notes, and `leadTerminal` dispatch | Active (`[[submodule-mod-changes-review]]`, extended by `[[spec-lifecycle]]`) |
| `submodule-mod-git-history` | All-repo topological commit graph (`#git`) and single reusable `#main` Before/After commit diff viewer | Active (`[[submodule-mod-git-history]]`, extended by `[[spec-lifecycle]]`) |
| `submodule-mod-cognivisor-tabs` | Tab strip, generic-name detection, Jira/prompt/branch auto-naming, inline rename, `Files`/`Review`/`Git` toggles, and `cognivisor.spacePanels` sync | Active (`[[submodule-mod-cognivisor-tabs]]`) |
| `submodule-mod-cognivisor-status` | 28px `#status` telemetry bar rendering machine, service/dirty count, active branch, agents, and palette hint | Active (`[[submodule-mod-cognivisor-status]]`) |

## Inter-Mod Communication & Shared State

All mods communicate solely through Herdr's persisted reactive bus (`shared()` / `setShared()`) without cross-mod closure mutation (`[[architecture]]`, `[[spec-lifecycle]]`):

```text
+-------------------------+  cognivisor.flows[tabId]    +---------------------+
| cognivisor-tabs         | --------------------------> | changes-review      |
| (#tabs 42px)            |   leadTerminal,             | (#changes panel)    |
|                         |   reviewedFiles,            |                     |
|                         |   sessionRepos              |                     |
+-------------------------+                             +---------------------+
             ^                                                     |
             | cognivisor.spacePanels (zero localStorage)          | cognivisor.services /
             v                                                     v cognivisor.activeService
+-------------------------+  shared() reactive bus      +---------------------+
| layouts/cognivisor.json | <-------------------------> | files-search        |
| (#panel-body)           |  cognivisor.services / sig  | cognivisor-status   |
+-------------------------+                             +---------------------+
```

### Bus Channels Summary

- **`files-search.select` & `files-search.customSize`**: Tree directory/file reveal coordination `{ root, kind: "dir" | "reveal", path, line, ts }` and overlay geometry persistence `{ w, h }`.
- **`cognivisor.openFileTabs` & `cognivisor.spaceAgentTabs`**: Per-tab non-terminal File Viewer metadata `{ tabId, spaceId, viewerId, root, path, absPath, displayPath, iconPath, iconColor, line, column?, highlightSymbol?, navOrigin?, navSeq?, ... }` (for deduplication, target symbol highlighting, and tab-bar file icons) plus per-space active terminal/agent tab anchors `Record<spaceId, tabId>` updated by `files-search`, `changes-review`, and `git-history`.
- **`changes-review.activeDiff` & `cognivisor.reviewNotes`**: Per-space reusable Review tab state `{ spaceId, sourceTabId, openFileKey, openFile, files, services, viewMode, selectedCommit, requestSeq, focusLine, openCommentLine, ... }` and synchronized inline review notes keyed by `${spaceId}::${sourceTabId}`.
- **`git-history.activeDiff` & `git-history.selectedRepo`**: Per-space reusable `git-history` comparison tab state `{ spaceId, sourceTabId, repoRoot, repoName, commitHash, shortHash, parentHashes, diffMode, openFileKey, openFile, files, expanded, requestSeq, ts }` and per-space repository selection `{ repoRoot, ts }` preserving clean-repo selections independently of `cognivisor.activeService`.
- **`cognivisor.services` & `cognivisor.activeService`**: Discovered session-scoped microservice repository list (`{ tabId, workspaceRoot, on, services, candidates, sig, ts }`) published when `sig` changes or heartbeat refreshes (and read by `git-history` as candidate hints), plus synchronized active filter (`"all"` or `serviceId` with monotonic `ts`; `git-history` writes `cognivisor.activeService` only for repos present in `cognivisor.services`).
- **`cognivisor.flows`**: Tab-scoped metadata keyed by `tabId` holding `ticket`, `derivedTitle`, `autoNamed`, `manualTitle`, `leadTerminal`, `reviewedFiles` (`{ reviewed: true, fp, reviewedAt }`), `sessionRepos`, `sessionBaseline`, and `updatedAt`.
- **`cognivisor.spacePanels`**: Persisted `Record<spaceId, "files" | "changes" | "git" | null>` replacing `localStorage` in `cognivisor-tabs`.

### Agent Dispatch Priority (`hc send`)

- **Lead Agent Priority:** `changes-review` targets `cognivisor.flows[tabId].leadTerminal` first via `await hc(["send", agentAddress, message])` so auxiliary split panes (`labels.cognivisorRunner === "true"`) never intercept agent prompts; failures surface via `notify()`.
