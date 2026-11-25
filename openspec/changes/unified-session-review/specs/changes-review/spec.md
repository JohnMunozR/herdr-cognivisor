---
id: spec-unified-session-review
type: task-spec
status: active
title: Unified Origin-Branch Session Review Specification
parent: submodule-mod-changes-review
covers: [unified-session-diff, origin-base-branch-resolution, strict-session-repo-attribution, unified-review-panel, commit-resilient-approvals, side-aware-review-comments, dirty-only-commit-drawer]
tags: [changes-review, git, session, unified-diff, multi-repo]
---

## Requirements

### Unified Origin-Branch Diff
- `changes-review` SHALL present a single unified review mode per session without a commit-history inspection selector (`#commit-selector-btn` / `#commit-dropdown-floating`).
- For each repository with a `HEAD` commit, `changes-review` MUST resolve the comparison base lock-free (`READ_GIT_FLAGS`) using `merge-base HEAD <originBaseRef>` (`origin/HEAD`, then `origin/{development,main,master,ci}`, then local `{development,main,master,ci}`), falling back to `origin/<branch>` or session `startHead` when working directly on a base branch.
- Tracked modifications MUST be computed with `git diff <baseHash>` (or `git diff --cached` for unborn repositories) merged with untracked (`??`) working-tree files so commits, staged edits, unstaged edits, and untracked files appear once per file as a cumulative net diff.
- Untracked text files MUST compute bounded line addition counts (`+N`) rather than defaulting to `+0`, and binary files MUST be flagged without crashing.
- Deleted Markdown previews MUST read prior content from `<baseHash>:<oldPath || path>` so committed deletions render cleanly.
- Expanded Markdown context gaps MUST preserve preceding Markdown syntax state across inserted context rows.

### Strict Session-Touched Repository Attribution & Unified Panel
- `changes-review` MUST NOT render `#service-filter-bar` or `#microservice-review-bar` and MUST NOT filter the review list by `cognivisor.activeService`.
- All changed files from session-touched repositories MUST render in one unified `#changes-list`, distinguished by `[serviceName]` badges whenever more than one repository is touched.
- A repository MUST only be included when it has session activity (`hasNewWorkingEdit`, `inPaneCwd`, `inSessionRepos`, or transcript-attributed `HEAD` movement) AND at least one visible file in its unified diff.
- Unrelated closed tabs' baselines MUST NOT be inherited across a 12-hour window.
- Pre-existing dirty working-tree files outside `baseHash..HEAD` MUST remain hidden behind `#preexisting-baseline-bar` (`Show all` / `Reset baseline`), including pre-existing deleted files (`sig: "deleted:D"`) and SSH edits, and baseline updates MUST synchronize cleanly with `files-search` via `baselineRev` / disk `mtimeMs`.

### Approvals, Comments, Watchers & Bottom Commit Drawer
- Per-file approvals (`reviewedFiles`) MUST use unified `session::<serviceId>::<path>` keys with fingerprints that survive `git commit` when net content against `baseHash` is unchanged and invalidate immediately when content or `baseHash` changes.
- Inline review comments MUST record `side: "old" | "new"` so deleted and added lines sharing a line number never collide or overwrite each other.
- Filesystem watchers MUST remain active across candidate repositories even when no files are currently modified, and watch events arriving while a refresh is in flight MUST queue one follow-up refresh.
- `renderPanel` MUST short-circuit with zero state/UI allocations when `!visible`.
- The bottom `Commit` drawer MUST target only touched repositories with visible dirty working-tree files (`dirtyPaths.length > 0`) and MUST stage only those explicit paths (`git add -- <dirtyPaths>`), never `git add -A`.
