# Design: Unified Session Review (`unified-session-review`)

## 1. GPUI View Hierarchy

### Docked Sidebar (`#changes`, `props()?.role !== "viewer"`)
```text
#changes (v_flex, size_full, track_focus) [short-circuits immediately when !visible]
├── Header (h_flex, compact-responsive)
│   ├── "Changes" + [N files] badge + [M/N ✓] progress badge
│   └── +add / −del totals
├── #preexisting-baseline-bar (conditional: hiddenPreExistingCount > 0 || showAllWorkingChanges)
│   ├── Status label ("N files hidden as pre-existing")
│   ├── #toggle-preexisting-btn ("Show all" / "Session only")
│   └── #reset-baseline-btn ("Reset baseline")
├── #changes-list (v_flex flex_1, scrollable unified list, sorted by serviceName then path)
│   └── #change-row-* (h_flex: #file-check-* checkbox, status mark, [serviceName] badge when services.length > 1, file-type SVG, path, +add/−del)
└── Bottom Drawer (v_flex, border_t)
    ├── Tabs: #tab-reviews ("Review (N)") | #tab-commit ("Commit")
    ├── Review tab: #reviews-list (with [serviceName] + file:line + side tag), agent badge, Clear all, Send to agent
    └── Commit tab: dirty-only status summary, commit message Input, Commit (N repos) button (disabled when 0 dirty working-tree files)
```

### Main Review Tab (`#review-tab-viewer`, `props()?.role === "viewer"`)
```text
#review-tab-viewer (v_flex, size_full)
├── #diff-file-review-bar (h_flex)
│   ├── [serviceName] badge (when services.length > 1) + status mark + file-type SVG + displayPath + +add/−del + [vs <baseRef>] badge
│   └── Prev/Next [<-][i/N][->] + [M/N ✓] + [#diff-markdown-toggle (MD only)] + [↻] + [#diff-viewed-btn Approve / Approved ✓]
├── Body (flex_1)
│   ├── Rendered Markdown Preview (when toggled ON; deleted files read via `git show <baseHash>:<oldPath||path>`)
│   └── #changes-diff-viewport (windowed variable-height soft-wrapped diff + per-block anchored gap expansion + right-edge scrollbar)
└── #review-comment-composer (docked bottom Textarea when activeComment is open, bound to { fileKey, line, side })
```

## 2. Git & Session State Contracts

### Lock-Free Git Invariant
Every read-only `git` invocation (`status`, `rev-parse`, `symbolic-ref`, `for-each-ref`, `merge-base`, `diff`, `ls-files`, `show`) MUST prepend:
```js
const READ_GIT_FLAGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
```

### Base Ref Resolution (`resolveRepoBaseRefWithExec`)
1. Check `git symbolic-ref --quiet refs/remotes/origin/HEAD` -> strip `refs/remotes/`.
2. Check `git for-each-ref --format=%(refname:short)` for `origin/development`, `origin/main`, `origin/master`, `origin/ci`, then local `development`, `main`, `master`, `ci`.
3. Compute `mergeBase = git merge-base HEAD <candidateRef>`.
4. If current `branch` is the base branch OR `mergeBase === headHash`:
   - Prefer `origin/<branch>` if `merge-base HEAD origin/<branch>` differs from `headHash`.
   - Else prefer `baselineRepo.startHead` if it differs from `headHash` and `git merge-base --is-ancestor <startHead> HEAD` exits `0`.
   - Else use `headHash`.
5. If `!hasHead` (unborn repo), return `{ hasHead: false, baseHash: "", baseRef: "", baseSource: "unborn" }`.

### Unified Snapshot & Strict Attribution
- `collectServiceSessionSnapshot` merges `git diff <baseHash> --name-status -z --no-renames` + `--numstat -z --no-renames` (or `--cached` for unborn repos) with `git status --porcelain=v1 -b -z --no-renames --untracked-files=normal` (expanding untracked directories and counting untracked lines bounded by `MAX_UNTRACKED_COUNT_BYTES = 400_000` with NUL-byte binary detection).
- Pre-existing dirty filtering queries `git diff --name-only -z <baseHash> HEAD` when `baseHash !== headHash` and either `baselineRepo.dirtyFiles` is non-empty or the repo is unbaselined with working-tree edits. Files present in `baseHash..HEAD` are always visible; remaining working-tree entries matching `baselineRepo.dirtyFiles[path]` (`status` & `sig`, with `"deleted:D"` for deletions and SSH diff-stat fallback signatures) are hidden as pre-existing.
- `evaluateRepoSessionActivity` marks a repo active only when `hasNewWorkingEdit || inPaneCwd || inSessionRepos || (headMoved && repoMatchesTranscript)`. `touched = sessionActivity && displayFiles.length > 0`.

### Bus & Disk Persistence
- Disk session baseline (`${appHome()}/cognivisor/sessions/tabs/<safeTabId>.json`) schema v1 extends cleanly with optional `rev: number` and per-repo `{ startHead?: string, startBranch?: string, dirtyFiles: Record<relPath, { status, sig }> }`.
- `cognivisor.flows[tabId].baselineRev` (monotonic integer) allows both `changes-review` and `files-search` to invalidate their in-memory `SESSION_BASELINE_CACHE` whenever the sibling mod resets or updates the disk baseline.
- `reviewedFiles` uses `session::<serviceId>::<path>` keys with fingerprint `${status}|${add}|${del}|${binary?1:0}|${baseHash}|${sig}` so `git commit` preserves `Approved ✓` while subsequent edits or base shifts invalidate it.

## 3. Concurrency, Watchers & Performance Safeguards
- Watch all discovered `candidateServices` (falling back to `workspaceRoot`) even when `this.services.length === 0`, keeping debounce coalesced (`800ms`) and ignoring `.git` internal locks / build dirs via `hasRelevantWatchChange`.
- Queue one follow-up refresh via `this.pendingRefresh = true` whenever a watch triggers while `this.loading === true`.
- Anchor `location()` / `key()` to `sessionTabId`'s terminal pane before `focusedPane?.cwd` so split-pane focus changes never reset panel state.
- Short-circuit `renderPanel()` immediately when `!visible` for zero idle allocations.
- Keep all async handlers (`refresh`, `loadViewerDiffNow`, `loadViewerMarkdownNow`, `sendReview`, `commit`) using `cx.spawn(async (asyncCx) => ...)` or generation guards so `cx` never expires across `await`.
