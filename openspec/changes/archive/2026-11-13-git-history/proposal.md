# Proposal: Git History & Commit Comparison Module (`git-history`)

## Intent

Herdr Mesh currently equips the collapsible `#panel-body` stack with two drawers: `files` (`mods/files-search`) for workspace navigation and `changes` (`mods/changes-review`) for session-scoped uncommitted code review. Neither mod provides a full repository history view: `changes-review` strictly filters commits to `sessionStartedAt`, presents only a flat 30-commit dropdown, and renders unified diffs rather than side-by-side before/after comparisons.

This change introduces a third peer module—**`mods/git-history`** (panel label **`Git`**, stack child ID **`git`**)—that renders a GitKraken-style visual commit graph in the upper split of the `#git` panel, lists the commit's modified files in the lower split, and opens a single reusable **Git Diff** comparison tab in `#main` (`role: "viewer"`) showing **Before | After** side-by-side diffs (with a Unified toggle) that updates in place when switching files or commits without accumulating duplicate tabs.

## Scope

### In Scope

1. **New `mods/git-history` Dual-Mode Mod**:
   - **Docked Panel (`#git`, `props()?.role !== "viewer"`):**
     - Repository selector covering all discovered workspace repositories (both clean and dirty), syncing safely with `mesh.activeService` when a dirty service is selected while tracking `git-history.selectedRepo` independently for clean repos.
     - Branch/ref filter (`All Branches`, `HEAD`, local/remote branches) and search input (subject, author, short/full SHA).
     - Top split (`v_resizable`): GitKraken-style topological multi-lane commit graph drawn with native `gpui-kit` `PathBuilder` + `window.paint_path`, featuring color-coded branch lanes, smooth Bezier fork/merge connectors, commit/HEAD/merge nodes, branch/tag/HEAD badges, message summary, author, relative date, and short SHA, virtualized via `v_virtual_list` with paginated loading.
     - Bottom split (`v_resizable`): Selected commit metadata summary (SHA, parents, author, timestamp, full subject) and scrollable list of files modified in that commit (`M`/`A`/`D`/`R`, file-type SVG icons, `+add`/`-del` counters, rename origin).
   - **Reusable `#main` Comparison Tab (`props()?.role === "viewer"`):**
     - Selecting any commit in `#git` loads its changed files in the bottom panel, selects the first modified file (if any), and opens a `#main` comparison tab via `run("tab.new", { space, name, mod: "git-history", props: { role: "viewer", spaceId, sourceTabId } })`—or reuses and focuses the space's existing `git-history` viewer tab via `tab.rename` + `tab.select`.
     - Clicking any file in the bottom commit-files list updates `git-history.activeDiff[spaceId]` and switches the file in that same `#main` tab **in place without opening a new tab** (mirroring `changes-review`).
     - Renders **Side-by-Side (`Before | After`)** comparison by default—using paired rows inside a unified vertical scroll container with independent per-side horizontal scrollbars—plus a toolbar toggle for **Unified** view, Prev/Next (`←`/`→`) file navigation, full-context expansion (`-U99999`), and theme-aware syntax highlighting.
   - **v1 Read-Only Scope**: Strictly read-only Git history and diff inspection using mandatory lock-free Git flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
2. **Layout, Tab Bar, & Installer Wiring**:
   - Add `"git"` (`mod: "git-history"`) as the 3rd child inside `#panel-body` in `layouts/mesh.json` while keeping `"files"` and `"changes"` IDs intact.
   - Add `"git"` entry to `PANEL_DEFS` (`Files` | `Review` | `Git`) and recognize `git-history` viewer tabs with a dedicated Git icon in `mods/mesh-tabs/main.js`.
   - Update `install.sh` (`MODS` array, `keys.json` uninstall regex) and optionally register `alt-g` (`layout.select` / `panel` toggle or mod action) via `setdefault` in `keys.json`.
3. **Pure Logic Modules & Unit/Regression Test Coverage**:
   - Keep graph lane layout, commit/ref parsing, side-by-side diff pairing, syntax tokenization, and repo discovery/filtering in pure zero-UI modules (`graph-logic.js`, `diff-logic.js`, `repo-logic.js`) tested via `node --test` under `tests/`.
4. **Fractal Spec-Graph & OpenSpec Synchronization**:
   - Update `goal-and-requirements.md`, `architecture.md`, `layouts/SPEC.md`, `mods/SPEC.md`, `mods/mesh-tabs/SPEC.md`, `openspec/specs/lifecycle/spec.md`, and add `mods/git-history/SPEC.md` alongside implementation.

### Out of Scope

- Mutating Git operations (`checkout`, `switch`, `branch`, `cherry-pick`, `rebase`, `reset`, `commit`, `push`, `stash`) inside `git-history` v1.
- Full LSP code editing or opening multiple simultaneous commit-comparison tabs per space.
- Modifying Herdr's immutable shipped layouts (`main.json`, `terminals.json`, `win98.json`) or built-in mods.
- Cross-mod relative `../` JS imports (forbidden by `herdr-app check`).

---

## Impact Analysis

### Layout Blocks (`layouts/mesh.json`)

| Block ID | Current State | Proposed Change | Impact & Compatibility |
|---|---|---|---|
| `#panel-body` | `type: "stack"`, `active: "files"`, children `["files", "changes"]` | Add 3rd child `{"id": "git", "type": "block", "content": {"mod": "git-history"}}` | Preserves `"files"` and `"changes"` IDs, `type: "stack"`, and `active: "files"`. Only 1 child renders per frame. |
| `#tabs` | `42px`, `mod: "mesh-tabs"`, toggles `Files` & `Review` | Add `Git` toggle button in `PANEL_DEFS` + Git tab icon detection for `mod === "git-history"` | Maintains `42px` height and `window_drag: true`; tab strip remains responsive via `overflow_x_scrollbar`. |
| `#main` | `tab: "active"`, `pane` header | Hosts `git-history` `role: "viewer"` tabs created via `run("tab.new", ...)` | Identical pane contract to `changes-review` and `files-search` viewer tabs. |
| `#panel` | `420px` (`min: 300`, `max: 960`), `hidden: true` | Unchanged geometry; hosts `#git` cleanly | User can drag `#panel` wider up to `960px` when viewing multi-branch graphs. |

### Shared State Keys (`shared()` / `setShared()`)

| Key | Status | Producer / Consumer | Impact |
|---|---|---|---|
| `mesh.spacePanels` | Existing (extended) | `mesh-tabs` | Extends allowed panel values from `"files" \| "changes" \| null` to `"files" \| "changes" \| "git" \| null`. |
| `mesh.services` | Existing (read-only consumer) | Producer: `files-search`, `changes-review`; Consumer: `git-history` | `git-history` reads cached `candidates` / `services` as fast hints while still listing clean repos. |
| `mesh.activeService` | Existing (optional sync) | `files-search`, `changes-review`, `git-history` | `git-history` follows `mesh.activeService` when a specific dirty service is picked; updates `mesh.activeService` only when the selected repo is in `mesh.services` (preventing clean-repo selection from blanking `changes-review`). |
| `mesh.spaceAgentTabs` | Existing (shared writer/reader) | `changes-review`, `git-history` | `git-history` records the active terminal tab before opening the non-terminal `git-history` viewer tab and resolves `sessionTabId` through it so terminal session identity is never lost. |
| `git-history.activeDiff` | New (mod-private) | `git-history` panel <-> `git-history` viewer | `Record<spaceId, GitDiffViewerState>` coordinating single-tab commit/file comparison in `#main`. |
| `git-history.selectedRepo` | New (mod-private) | `git-history` panel | `Record<spaceId, { repoRoot, ts }>` remembering selected clean or dirty repository per space without polluting `mesh.activeService`. |

---

## Backwards-Compatibility

1. **Herdr Default Layouts (`main.json`, `terminals.json`, `win98.json`)**:
   - All changes are scoped to `layouts/mesh.json` and `herdr-mesh` mods (`mods/git-history`, `mods/mesh-tabs`). Built-in Herdr layouts and shipped `tabs` / `workspace-status` mods remain untouched.
2. **Existing Panel Commands & `install.sh`**:
   - Existing `layout.select --stack panel-body --child files|changes` calls and `install.sh` initial panel selection (`files`) continue working unchanged.
   - `install.sh` adds `git-history` to `MODS` and updates the uninstall regex in `keys.json` cleanup (`files-search|changes-review|git-history|mesh-[a-z0-9-]+`).
3. **`keys.json`**:
   - Existing `ctrl-p` and `alt-f` (`mod.open:files-search`) bindings are untouched. Any optional new keybinding uses `setdefault` in `install.sh` so existing user bindings are never overwritten.
4. **Coexistence with `changes-review`**:
   - `changes-review` retains its own single Review tab (`findReviewTabInSpace`) and `changes-review.activeDiff`; `git-history` uses its own single Git Diff tab (`findGitDiffTabInSpace`) and `git-history.activeDiff` so active code reviews and historical commit inspections never overwrite each other.
