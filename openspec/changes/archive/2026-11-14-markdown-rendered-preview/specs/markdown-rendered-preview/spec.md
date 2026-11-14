---
id: spec-markdown-rendered-preview
type: task-spec
status: active
title: On-Demand Markdown Rendered Preview Specification
parent: architecture
references: [module-shared, submodule-mod-files-search, submodule-mod-changes-review, submodule-mod-git-history]
covers: [markdown-rendered-preview, shared-markdown-viewer]
tags: [openspec, markdown, preview, shared, gpui, textview]
---

# Specification: On-Demand Markdown Rendered Preview

## Requirements

### Requirement: Default Raw/Diff Mode & Explicit Toggle Visibility
All four Markdown viewing surfaces (`files-search` File Viewer Tab, `files-search` Search Everywhere Preview Pane, `changes-review` Diff Viewer Tab, `git-history` Commit Diff Viewer Tab) SHALL open `.md` and `.mdx` files in raw source or diff mode by default.

1. When the active file extension is `.md` or `.mdx` (case-insensitive), the viewer header SHALL display the shared Markdown render toggle button (`renderMarkdownToggleButton`).
2. When the active file is NOT `.md` or `.mdx`, the toggle button SHALL NOT be rendered and zero Markdown rendering state or elements SHALL be constructed.
3. Opening a different file, closing the viewer/overlay, or explicitly selecting `Side-by-Side` / `Unified` diff mode SHALL reset the rendered Markdown toggle back to inactive (raw/diff).

### Requirement: Shared Engine & Single Source of Truth (`shared/`)
All Markdown preparation logic and GPUI rendering composition SHALL reside in `shared/markdown-view-logic.js` and `shared/markdown-view.js`, synchronized across consuming mods (`files-search`, `changes-review`, `git-history`) via `scripts/sync-shared.mjs` and `install.sh`.

1. `prepareMarkdownForRender` SHALL strip valid opening YAML frontmatter (`---` ... `---`) from the body passed to `TextView.markdown` and expose parsed summary metadata entries without regex backtracking.
2. When content exceeds `maxChars`, `truncateMarkdownSafely` SHALL cut cleanly on newline/surrogate boundaries and automatically close any open fenced code block (` ``` ` / `~~~`).
3. Link handling SHALL validate URLs via `classifyMarkdownLink` / `isSafeExternalUrl` so `cx.open_url` is called ONLY for `http://` and `https://` URLs with a non-empty host.

### Requirement: Lazy Diff Snapshot & Lock-Free Git Invariants
In `changes-review` and `git-history`, full file content for Markdown rendering SHALL be fetched lazily only when the user enables the toggle:

1. Read-only Git commands (`git show`) MUST include `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`.
2. Deleted files (`status === "D"`) SHALL fall back to the previous revision (`HEAD` or parent commit) with an explicit informational notice banner rather than failing silently.
3. Inline diff line selection/commenting in `changes-review` SHALL be disabled while rendered Markdown mode is active, leaving existing review notes and `Approve` / `Send Notes` controls intact.
