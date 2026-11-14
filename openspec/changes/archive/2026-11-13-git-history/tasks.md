# Tasks: Git History & Commit Comparison (`git-history`)

## Phase 1: Pure Logic Modules & Test Foundation (`mods/git-history/` + `tests/`)

- [x] 1.1 Create `mods/git-history/mod.json`, `jsconfig.json`, copy `gpui-kit.d.ts`, and add `mods/git-history/icons/` + `mods/mesh-tabs/icons/git.svg`.
  - Verify: `node -e 'JSON.parse(require("fs").readFileSync("mods/git-history/mod.json","utf8"))'`
- [x] 1.2 Implement `mods/git-history/graph-logic.js` (`parseGitLogOutput`, `parseDecorations`, `computeCommitGraphLayout`, `filterCommits`, `formatRelativeTime`) handling linear history, forks, merges, octopus merges, root commits, and lane color continuity.
  - Verify: `node --check mods/git-history/graph-logic.js`
- [x] 1.3 Implement `mods/git-history/diff-logic.js` (`parseCommitFiles`, `buildSideBySideRows`, `buildUnifiedRows`, `tokenizeDiffLine`, `resolveGitFileIcon`, `computeDiffColumnWidths`, `computeViewerLoadedKey`) handling root commits, deletions, renames (`-M`), binary markers, and paired row alignment.
  - Verify: `node --check mods/git-history/diff-logic.js`
- [x] 1.4 Implement `mods/git-history/repo-logic.js` (`READ_GIT`, `DISCOVER_SKIP_DIRS`, `isHomeDirectoryRoot`, `resolveWorkspaceRoot`, `parseBranchesOutput`, `mergeDiscoveredWithServices`, `resolveSelectedRepo`, `shouldIgnoreGitWatchEvent`, `resolveSessionAgentTabId`; paired with `discoverRepoRoots` in `mods/git-history/main.js`) supporting clean + dirty repos across local and SSH (`on`) workspaces.
  - Verify: `node --check mods/git-history/repo-logic.js`
- [x] 1.5 Add comprehensive zero-dependency `node --test` suites (`tests/git-history-graph-logic.test.mjs`, `tests/git-history-diff-logic.test.mjs`, `tests/git-history-repo-logic.test.mjs`).
  - Verify: `npm test`

## Phase 2: Docked `#git` Panel & GitKraken Commit Graph (`mods/git-history/main.js`)

- [x] 2.1 Implement repository discovery, `mesh.services` / `mesh.activeService` / `git-history.selectedRepo` coordination, lock-free `git log` pagination (`-n 200`), branch filter (`All Branches` / local / remote), and search input (`InputState`) inside `GitHistory.renderPanel`.
  - Verify: `node --check mods/git-history/main.js`
- [x] 2.2 Implement the top `v_resizable` pane rendering the virtualized GitKraken commit graph (`v_virtual_list` + `PathBuilder` + `window.paint_path` + theme-derived lane colors + HEAD/branch/tag pills) with visible-only refresh throttling and `shouldIgnoreGitWatchEvent` debounced `.git` watching.
  - Verify: `node --check mods/git-history/main.js`
- [x] 2.3 Implement the bottom `v_resizable` pane showing selected commit metadata and modified files list (`M`/`A`/`D`/`R`, file icons, `+add -del`), plus `openGitDiffTabForCommit` and `selectCommitFileInPlace` coordinating `git-history.activeDiff` and single-tab reuse (`findGitDiffTabInSpace` + `tab.new` / `tab.rename` / `tab.select`).
  - Verify: `herdr-app check mods/git-history`

## Phase 3: Reusable `#main` Before/After Comparison Tab (`role: "viewer"`)

- [x] 3.1 Implement `GitHistory.renderViewer` for `props()?.role === "viewer"` consuming `git-history.activeDiff[spaceId]` with deferred `viewerLoadedKey` loading (`cx.timer.after(0, ...)`) and monotonic `viewerLoadGen` cancellation.
  - Verify: `node --check mods/git-history/main.js`
- [x] 3.2 Implement toolbar (`←`/`→` file navigation, file position counter, repo/commit/file badges, `Expand`/`Collapse` `-U99999`, `Side-by-Side | Unified` mode toggle, `↻` reload) and commit summary banner.
  - Verify: `node --check mods/git-history/main.js`
- [x] 3.3 Implement **Side-by-Side (`Before | After`)** view (`#git-diff-y` vertical sync + independent `#git-diff-left-x` / `#git-diff-right-x` horizontal scrollbars + syntax highlighting + empty/root/binary handling) and **Unified** view fallback, plus complete `close()` cleanup.
  - Verify: `herdr-app check mods/git-history`

## Phase 4: Layout, Tab Bar, Installer & Unit Tests Integration

- [x] 4.1 Update `layouts/mesh.json` to add `{"id": "git", "type": "block", "content": {"mod": "git-history"}}` inside `#panel-body` stack while keeping `"files"` and `"changes"` intact.
  - Verify: `node -e 'JSON.parse(require("fs").readFileSync("layouts/mesh.json","utf8"))'`
- [x] 4.2 Update `mods/mesh-tabs/main.js` (`PANEL_DEFS` with `git` button + `isGitTab` viewer icon handling), `mods/mesh-tabs/tab-logic.js` (`classifyViewerTab`, `resolveSpacePanelTarget`), and add tests in `tests/mesh-tabs-logic.test.mjs`.
  - Verify: `herdr-app check mods/mesh-tabs && npm test`
- [x] 4.3 Update `install.sh` (`MODS=(files-search changes-review git-history mesh-tabs mesh-status)`, `keys.json` uninstall regex to include `git-history`); `keys.json` intentionally retains only `ctrl-p` and `alt-f` for `files-search` (optional `git-history` shortcut left unbound in v1).
  - Verify: `bash -n install.sh && node -e 'JSON.parse(require("fs").readFileSync("keys.json","utf8"))'`

## Phase 5: Spec-Graph Synchronization & Full Verification Gate

- [x] 5.1 Create `mods/git-history/SPEC.md` and update `goal-and-requirements.md`, `architecture.md`, `layouts/SPEC.md`, `mods/SPEC.md`, `mods/mesh-tabs/SPEC.md`, `AGENTS.md`, and `openspec/specs/lifecycle/spec.md`, then archive `openspec/changes/git-history/` to `openspec/changes/archive/2026-11-13-git-history/`.
  - Verify: Confirm all Fractal Spec-Graph frontmatter fields (`id`, `parent`, `type`, `status`) and `[[wikilinks]]` resolve without orphans.
- [x] 5.2 Run the full `herdr-mesh` verification gate:
  - `npm test`
  - `for d in mods/*/; do herdr-app check "$d" || exit 1; done`
  - `for f in mods/*/*.js; do node --check "$f" || exit 1; done`
  - `node -e 'for (const p of ["package.json", "layouts/mesh.json", "keys.json"]) JSON.parse(require("fs").readFileSync(p, "utf8"))'`
  - `! rg -n "localStorage" mods/*/*.js`
