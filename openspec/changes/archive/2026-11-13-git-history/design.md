# Design: Git History & Commit Comparison (`git-history`)

## Architecture Overview

`mods/git-history` follows the same dual-mode View pattern proven by `mods/changes-review` (`role !== "viewer"` for the docked `#git` side panel, `role === "viewer"` for the reusable `#main` comparison tab), while isolating all GitKraken graph layout, diff alignment, syntax lexing, and multi-repo parsing into pure zero-UI modules (`graph-logic.js`, `diff-logic.js`, `repo-logic.js`).

```text
Docked Panel (#git, props.role !== "viewer")                Main Comparison Tab (#git-diff-tab-viewer, role === "viewer")
+-------------------------------------------------+        +--------------------------------------------------------------+
| Git History  [repo-a v]  [All Branches v]  [↻]  |        | [repo-a] abc1234 [M] src/auth.ts +14 -5  [<- 1/3 ->] [↻]    |
| [Filter commits by message, author, or SHA... ] |        | [Expand]  [Side-by-Side | Unified]                           |
+-------------------------------------------------+        +--------------------------------------------------------------+
| *   [main] feat: JWT refresh rotation  Alex 2h  |        | Commit abc1234 · Alex · 2h ago · parent 9876fed              |
| |\                                              |        +------------------------------+-------------------------------+
| | * [feat/auth] add token store       Sam  4h   | -----> | Before (9876fed)             | After (abc1234)               |
| |/                                              | commit | 12   const ttl = 300;        | 12   const ttl = 900;         |
| *   fix: cors headers                 Alex 1d   | click  | 13 - return issue(ttl);      | 13 + return rotate(ttl);      |
+=================== v_resizable =================+        |    ~                         | 14 + auditLog(user.id);       |
| Commit abc1234 · "feat: JWT refresh rotation"   |        +------------------------------+-------------------------------+
| Files (3):                                      |        ^
| > M  src/auth.ts                       +14 -5   | -------+ clicks switch file IN PLACE (same tab via tab.rename/select)
|   A  src/token-store.ts                +48 -0   |
|   M  tests/auth.test.mjs               +19 -2   |
+-------------------------------------------------+
```

### Key Architectural Choices (Confirmed)

1. **Single Reusable Viewer Tab per Space (`findGitDiffTabInSpace`)**:
   - Clicking a commit or any file in its bottom file list resolves `existing = findGitDiffTabInSpace(spaceId)` (matching `panes()` with `p.mod === "git-history"` inside `spaceId`).
   - If absent, calls `run("tab.new", { space: spaceId, name, mod: "git-history", props: { role: "viewer", spaceId, sourceTabId } })`.
   - If present, updates `git-history.activeDiff[spaceId]` (incrementing `requestSeq`), calls `run("tab.rename", { id: existing.tabId, name })`, and calls `run("tab.select", { id: existing.tabId })`—zero tab accumulation across file or commit switches.
2. **Side-by-Side (`Before | After`) Default with Unified Toggle**:
   - Paired-row layout inside ONE vertical scroll container (`#git-diff-y`) containing two side-by-side columns (`#git-diff-left-x` and `#git-diff-right-x`), each with its own `overflow_x_scrollbar()` and identical explicit row heights (`22px` code lines, `26px` hunk bars).
   - Because `gpui-kit` `ScrollHandle` / `VirtualListScrollHandle` do not expose imperative `scrollOffset` synchronization between two independent vertical scroll areas, putting both columns inside one shared vertical scroll parent guarantees 1:1 native vertical sync while preserving independent horizontal scrolling for long lines on either side.
3. **All Workspace Repos (Clean + Dirty)**:
   - Discovers all Git repos under `workspaceRoot` (depth 2 + parent siblings for single-repo workspaces + active-tab `pane.cwd`) regardless of dirty state, enriching matches with `cognivisor.services` branch/dirty badges when available.
4. **Read-Only v1 Scope**:
   - All Git invocations (`log`, `for-each-ref`, `diff-tree`, `show`, `diff`, `rev-parse`) are read-only with `READ_GIT` lock-free flags.

---

## GPUI-Kit View Hierarchies

### 1. Docked Panel (`#git`, `mods/git-history/main.js` -> `renderPanel`)

```text
v_flex (size_full, bg: t.background)
├── h_flex#git-header (h(34), px(10), gap(6), items_center, justify_between, border_b, bg: t.chrome)
│   ├── h_flex (gap(6), items_center, min_w(0))
│   │   ├── svg("mods/git-history/icons/git-branch.svg").size(13)
│   │   ├── button#git-repo-btn (repo selector dropdown trigger: activeRepo.name + dirty dot)
│   │   └── button#git-branch-btn (branch filter dropdown trigger: "All Branches" | branch)
│   └── button#git-refresh-btn ("↻", triggers manual reload)
├── h_flex#git-search-bar (px(8), py(6), gap(6), border_b)
│   ├── Input(this.searchInput) (placeholder: "Filter message, author, SHA...")
│   └── [when query non-empty]: button#git-search-clear ("×")
├── v_resizable("git-panel-split").flex_1().min_h(0)
│   ├── resizable_panel().size(380).size_range(160, 900)
│   │   └── div#git-graph-wrap (relative, size_full)
│   │       ├── v_virtual_list("git-commits-list", visibleCommits.length, 30, ...)
│   │       │   └── per row[i]: h_flex#git-commit-{hash} (h(30), px(8), gap(6), items_center, bg: selected ? t.selected : t.background)
│   │       │       ├── div#git-lane-{hash} (w(graphWidth), h(30), relative, flex_none)
│   │       │       │   ├── [for each path segment]: window.paint_path(path, laneColor).absolute().inset_0()
│   │       │       │   └── commit node dot / ring (positioned at x(lane), y=15)
│   │       │       ├── h_flex#git-refs-{hash} (gap(4), flex_none) -> up to 2 ref pills (HEAD / branch / tag) + "+N" overflow pill
│   │       │       ├── div (flex_1, min_w(0), overflow_hidden, text_ellipsis) -> commit.subject
│   │       │       └── div (flex_none, text_size(10.5), text_color(t.dim)) -> author · relTime · shortHash
│   │       ├── Scrollbar.vertical("git-commits-list").viewport_from_layout().absolute().inset_0()
│   │       └── [when loading / empty / hasMore]: status overlay or "Load older commits" row
│   └── resizable_panel().size(220).size_range(120, 600)
│       └── v_flex#git-commit-detail (size_full, border_t, border_color: t.border)
│           ├── v_flex#git-commit-meta (px(10), py(6), gap(2), border_b, bg: t.raised)
│           │   ├── h_flex (justify_between): shortHash badge + parent hashes + author · date
│           │   └── div (text_size(11.5), font_weight: semibold, line_clamp/truncate): commit.subject
│           └── div#git-commit-files-wrap (relative, flex_1, min_h(0))
│               ├── v_virtual_list("git-commit-files", files.length, 26, ...)
│               │   └── per file[j]: h_flex#git-file-{j} (h(26), px(10), gap(6), items_center, cursor_pointer)
│               │       ├── status badge ("M" | "A" | "D" | "R" | "C")
│               │       ├── svg(fileIconPath).size(13)
│               │       ├── div (flex_1, min_w(0), truncate): displayPath (or "old -> new")
│               │       └── div (flex_none): "+add -del" or "BIN"
│               └── Scrollbar.vertical("git-commit-files").viewport_from_layout().absolute().inset_0()
└── [Floating dropdowns when open]: #git-repo-dropdown / #git-branch-dropdown
```

### 2. Main Comparison Tab (`#git-diff-tab-viewer`, `mods/git-history/main.js` -> `renderViewer`)

```text
v_flex#git-diff-tab-viewer (size_full, bg: t.background)
├── h_flex#git-diff-toolbar (min_h(40), px(12), py(6), gap(8), items_center, justify_between, border_b, bg: t.raised)
│   ├── h_flex (gap(6), items_center, min_w(0), flex_1)
│   │   ├── repo badge + commit shortHash badge + status badge [M/A/D/R]
│   │   ├── svg(fileIconPath).size(14)
│   │   ├── div (min_w(0), truncate): file displayPath (plus rename origin)
│   │   └── "+add" / "-del" counters
│   └── h_flex (gap(6), items_center, flex_none)
│       ├── button#git-diff-prev ("←") + counter ("1/N") + button#git-diff-next ("→")
│       ├── button#git-diff-expand ("Expand" / "Collapse" full file context `-U99999`)
│       ├── segmented toggle ("Side-by-Side" | "Unified")
│       └── button#git-diff-refresh ("↻")
├── h_flex#git-diff-commit-bar (px(12), py(4), gap(8), border_b, bg: t.chrome, text_size(11))
│   └── commit.subject · author · date · parent(s)
├── [when diffMode === "side-by-side"]:
│   ├── h_flex#git-diff-col-headers (h(24), border_b, bg: t.chrome, text_size(11))
│   │   ├── div (flex_1, px(10), items_center): "Before (" + parentLabel + ")"
│   │   └── div (flex_1, px(10), border_l, items_center): "After (" + shortHash + ")"
│   └── div.flex_1.min_h(0).relative.font_family(mono).text_size(11.5)
│       ├── v_flex#git-diff-y (size_full, overflow_y_scroll, track_scroll(this.diffScroll))
│       │   └── h_flex (w_full, items_start)
│       │       ├── div#git-diff-left-x (flex_1, min_w(0), overflow_x_scrollbar)
│       │       │   └── v_flex (w_full, min_w(this.leftWidth)) -> leftCell(row) for each pairedRow
│       │       └── div#git-diff-right-x (flex_1, min_w(0), overflow_x_scrollbar, border_l)
│       │           └── v_flex (w_full, min_w(this.rightWidth)) -> rightCell(row) for each pairedRow
│       └── Scrollbar.vertical("git-diff-y").viewport_from_layout().absolute().inset_0()
└── [when diffMode === "unified"]:
    └── div.flex_1.min_h(0).relative.font_family(mono).text_size(11.5)
        ├── div#git-diff-unified-x (size_full, overflow_x_scrollbar)
        │   └── v_flex#git-diff-unified-y (w_full, min_w(this.unifiedWidth), overflow_y_scroll, track_scroll(this.diffScroll))
        │       └── unifiedRow(row) for each row
        └── Scrollbar.vertical("git-diff-unified-y").viewport_from_layout().absolute().inset_0()
```

### 3. `mods/cognivisor-tabs` (`PANEL_DEFS` & Viewer Tab Icon)

- Extend `PANEL_DEFS` (`mods/cognivisor-tabs/main.js`):
  - `{ id: "files", label: "Files", icon: "mods/cognivisor-tabs/icons/files.svg" }`
  - `{ id: "changes", label: "Review", icon: "mods/cognivisor-tabs/icons/changes.svg" }`
  - `{ id: "git", label: "Git", icon: "mods/cognivisor-tabs/icons/git.svg" }`
- Detect `isGitTab = tabPanes.some((p) => p.mod === "git-history")` in `cognivisor-tabs` item renderer and render `mods/cognivisor-tabs/icons/git.svg` with accent tint when active.

---

## GitKraken Commit Graph Algorithm (`graph-logic.js`)

### Input & Ordering
- Fetch commits via lock-free `git log`:
  `git log --topo-order --decorate=short --date=unix -n <limit> --skip=<skip> --format=...` (optionally `--all` when `branchFilter === "__all__"`, or specific branch ref).
  - Note: Use `\x1f` (unit separator) and `\x1e` (record separator) inside `--format` to parse commit fields cleanly without breaking on quotes or multi-line messages.
- For parent-child edge continuity across rows, `--topo-order` guarantees every child appears strictly above all of its parents.

### Row Lane State Transition & Path Geometry Invariant
Maintain `activeLanes: Array<{ hash: string, colorIndex: number } | null>` across rows:
1. Find all lane indices `matchingLanes` where `activeLanes[l]?.hash === commit.hash`.
2. Choose `commitLane`:
   - If `matchingLanes.length > 0`, pick `matchingLanes[0]` (preserving its `colorIndex`).
   - Otherwise, allocate the lowest `null` index in `activeLanes` (or push a new lane) and assign the next unused `colorIndex` (`0..PALETTE_SIZE-1`).
3. **Top Half Geometry (`y = 0 -> yMid`)**:
   - Every lane `l !== commitLane`:
     - If `l` is in `matchingLanes` (converging branch tip): draw Bezier `(x(l), 0) -> (x(commitLane), yMid)` using `activeLanes[l].colorIndex`, then free `activeLanes[l] = null`.
     - Else if `activeLanes[l] !== null` (pass-through): draw vertical `(x(l), 0) -> (x(l), H)` using `activeLanes[l].colorIndex`.
   - For `commitLane`: if `matchingLanes.length > 0`, draw vertical `(x(commitLane), 0) -> (x(commitLane), yMid)`.
4. **Bottom Half Geometry (`y = yMid -> H`) & Next `activeLanes`**:
   - If `commit.parents.length === 0` (root commit): free `activeLanes[commitLane] = null`.
   - Else for primary parent `p0 = commit.parents[0]`:
     - Check if another lane `existingP0` already expects `p0`:
       - If NO: keep `activeLanes[commitLane] = { hash: p0, colorIndex: commitColor }` and draw vertical `(x(commitLane), yMid) -> (x(commitLane), H)`.
       - If YES: draw Bezier `(x(commitLane), yMid) -> (x(existingP0), H)` with `commitColor` and free `activeLanes[commitLane] = null`.
   - For each secondary parent `pi` (`i >= 1`, merge commit):
     - If `pi` is already in `activeLanes` at `existingPi`: draw Bezier `(x(commitLane), yMid) -> (x(existingPi), H)` using `activeLanes[existingPi].colorIndex`.
     - Else: allocate lowest `null` lane `forkLane`, assign a fresh `colorIndex`, set `activeLanes[forkLane] = { hash: pi, colorIndex }`, and draw Bezier `(x(commitLane), yMid) -> (x(forkLane), H)`.

**Continuity Invariant**: Every lane slot `l` occupied at the end of row `r` terminates at `(x(l), H)` on row `r` and enters at `(x(l), 0)` on row `r + 1` with the same `colorIndex`.

### Theme-Derived Lane Palette
Never hardcode hex colors inside UI rendering; derive lane palette array dynamically from `theme()`, `settings().colors`, and `layout().colors`:
`[colors.accent, colors.ansi4, colors.ansi2, colors.ansi5, colors.ansi3, colors.ansi6, colors.ansi1, colors.ansi12, colors.ansi10, colors.ansi13]` (filtering undefined/duplicate values safely with fallback).

---

## Shared State Contracts & Bus Keys

| Bus Key | Scope | Payload Schema | Behavior |
|---|---|---|---|
| `git-history.activeDiff` | `Record<spaceId, GitDiffViewerState>` | `{ spaceId, sourceTabId, repoRoot, repoName, on, commitHash, shortHash, parentHashes, commitSubject, commitAuthor, commitTimestamp, diffMode, openFileKey, openFile, files, expanded, requestSeq, ts }` | Drives the space's single `#main` `git-history` viewer tab. Bumping `requestSeq` on commit or file click triggers deferred `loadViewerDiffNow` via `cx.timer.after(0, ...)`. |
| `git-history.selectedRepo` | `Record<spaceId, { repoRoot, ts }>` | `{ repoRoot: string, ts: number }` | Persists the selected repo (clean or dirty) per space in `#git`. |
| `cognivisor.spacePanels` | `Record<spaceId, "files" \| "changes" \| "git" \| null>` | Panel child ID or `null` | Read/written by `cognivisor-tabs` for space panel memory. |
| `cognivisor.activeService` | `{ workspaceRoot, serviceId, ts }` | Existing format | Synced cleanly by `git-history` on monotonic `ts` changes without overwriting clean-repo inspections. |
| `cognivisor.spaceAgentTabs` | `Record<spaceId, tabId>` | Existing format | Updated by `git-history` prior to `tab.new` so `sessionTabId` stays anchored to the space's terminal tab. |

---

## Concurrency, Watcher Debouncing & Lock-Free Git Safeguards

1. **Lock-Free Read Flags (`READ_GIT`)**:
   - Every `git` command invoked via `exec("git", [...READ_GIT, ...], { cwd, on })` prepends:
     `["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"]`.
2. **Stale Async Generation Cancellation**:
   - Maintain monotonic counters (`logGen`, `commitFilesGen`, `viewerLoadGen`, `repoDiscoverGen`). After every `await exec(...)`, verify the generation still matches and the view is not closed before updating state or calling `cx.notify()`.
3. **Pure Render Invariant**:
   - Zero `cx.notify()`, `setShared()`, or `input.set_value()` synchronously inside `render()`. Use `cx.timer.after(0, ...)` for deferred `viewerLoadedKey` diff fetches and initial/visibility refreshes, and cancel all pending timer tasks + release `InputState` / `ScrollHandle` / `VirtualListScrollHandle` instances inside `close()`.
4. **Scoped & Debounced Watchers**:
   - Watch only the active repo's `.git/HEAD` and `.git/refs` (when local, or poll gently when visible on SSH `on`) with `800ms` debounce and `shouldIgnoreGitWatchEvent` skipping `.lock`, `COMMIT_EDITMSG`, `FETCH_HEAD`, and index locks.
   - Skip background Git log refreshes when `#git` is hidden (`isGitPanelVisible()` false), refreshing on panel reveal or explicit `↻`.
5. **Diff Size & Performance Bounds**:
   - Default diff context (`-U3`), expandable on click (`-U99999`), capped cleanly with explicit truncation banner for huge files (e.g., `MAX_VIEWER_DIFF_LINES = 1500` default / `4000` expanded) and syntax tokenization capped at `500` chars per line.
   - Binary files (`numstat` `- -` or git binary patch marker) short-circuit to a binary metadata card without parsing binary bytes.
