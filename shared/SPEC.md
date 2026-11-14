---
id: module-shared
type: module-design
status: active
title: Shared Reusable Components & Pure Engines Module (shared/)
parent: architecture
references: [submodule-mod-files-search, submodule-mod-changes-review, submodule-mod-git-history]
covers: [soft-line-wrapping, column-budget-reflow, dropdown-geometry, reusable-gpui-dropdown, markdown-syntax-tokenization, markdown-rendered-preview]
tags: [shared, pure-logic, ui-adapters, wrapping, dropdown, markdown, sync]
---

## Responsibility

The `module-shared` directory holds the canonical source of truth for reusable pure JavaScript engines and shared GPUI UI adapters consumed across multiple `herdr-mesh` mods without violating Herdr's per-mod bundling and `herdr-app check` sandboxing rules (which disallow relative `../` imports across `mods/*/` directories).

Developers and AI agents MUST inspect `shared/` first before creating any new wrapper, dropdown popover, syntax tokenizer, rendered Markdown viewer, or reusable GPUI widget inside an individual mod, and extend or reuse these canonical components via `scripts/sync-shared.mjs` and `install.sh`.

## Boundary

- **Owns:**
  - **Zero-Dependency Pure Logic & Engines** (executable identically under Node `--test` and QuickJS inside GPUI):
    - `shared/code-wrap.js`: Pure soft line-wrapping engine (`DEFAULT_TAB_SIZE`, `computeWrapColumns`, `codeUnitEndForColumns`, `expandTabsFromColumn`, `expandTabs`, `computeWrapRanges`, `countWrappedLines`, `wrapPlainText`, `wrapStyledSpans`) synced to `mods/{files-search,changes-review,git-history}/code-wrap.js`.
    - `shared/dropdown-logic.js`: Pure popover geometry, scroll-gating, and reopen-guard calculator (`DEFAULT_REOPEN_GUARD_MS`, `clampDropdownNumber`, `computeDropdownMetrics` returning `{ width, contentHeight, bodyHeight, shouldScroll }`, `shouldSuppressDropdownReopen`) synced to `mods/{changes-review,git-history}/dropdown-logic.js`.
    - `shared/markdown-syntax.js`: Single-pass `O(n)` Markdown syntax tokenizer (`isMarkdownExt`, `isFrontmatterDelimiter`, `parseFenceOpen`, `parseFenceClose`, `createMarkdownState`, `getMarkdownStateTag`, `advanceMarkdownState`, `tokenizeMarkdownLine`) supporting YAML frontmatter (`---` on line 0 through closing `---`), fenced code blocks (` ```lang ` / `~~~lang` with `fallbackCodeTokenizer` delegation and lossless tab restoration), ATX headings (`#`–`######`), horizontal rules, blockquotes, lists and task checkboxes, inline code spans, HTML comments, autolinks, images, links, and escaped punctuation without regex backtracking, synced to `mods/{files-search,changes-review,git-history}/markdown-syntax.js`.
    - `shared/markdown-view-logic.js`: Pure Markdown preview preparation, link validation, and diff snapshot planner (`DEFAULT_MARKDOWN_MAX_CHARS`, `getFileExtension`, `isMarkdownFile`, `splitMarkdownFrontmatter`, `truncateMarkdownSafely`, `detectMdxCues`, `prepareMarkdownForRender`, `classifyMarkdownLink`, `isSafeExternalUrl`, `resolveRelativeMarkdownPath`, `getDiffMarkdownPlan`) importing only `./markdown-syntax.js`, synced to `mods/{files-search,changes-review,git-history}/markdown-view-logic.js`.
  - **Shared GPUI UI Adapters** (thin declarative GPUI builders paired with sibling pure `*-logic.js` modules):
    - `shared/dropdown.js`: Reusable GPUI dropdown trigger (`renderDropdownTrigger`) and adaptive shrink-wrapping overlay popover (`renderDropdownPopover`) importing `computeDropdownMetrics` from `./dropdown-logic.js`, synced to `mods/{changes-review,git-history}/dropdown.js`.
    - `shared/markdown-view.js`: Reusable GPUI Markdown toggle pill (`renderMarkdownToggleButton`), bounded preparation cache (`createMarkdownRenderCache`), and scrollable `TextView.markdown` surface (`renderMarkdownViewer`) with compact frontmatter cards and guarded `cx.open_url` link dispatch, synced to `mods/{files-search,changes-review,git-history}/markdown-view.js`.
  - Sync parity enforcement: Maintained identically across consuming `mods/*/` directories via `scripts/sync-shared.mjs` (`SHARED_TARGETS`, `npm run sync:shared` / `npm run check:shared`, executed automatically in `npm test`) and synced during `install.sh`.
- **Allowed deps:**
  - **Zero-dependency pure engines (`code-wrap.js`, `dropdown-logic.js`, `markdown-syntax.js`, `markdown-view-logic.js`):** Zero external or host imports (`node`, `gpui-kit`, `gpui-base`, and `herdr` free; intra-shared pure imports such as `./markdown-syntax.js` permitted when both files sync together).
  - **Shared GPUI UI adapters (`dropdown.js`, `markdown-view.js`):** `gpui-kit` (`div`, `svg`), `gpui-base` (`v_flex`, `h_flex`, `TextView`, `Scrollbar`), and sibling intra-mod pure logic modules (`./dropdown-logic.js`, `./markdown-view-logic.js`); zero `localStorage`, DOM APIs, or hardcoded hex colors.
- **Forbidden:**
  - Directly importing `shared/*.js` across `../` boundaries from inside `mods/*/`.
  - Importing `gpui-kit`, `gpui-base`, or `herdr` inside zero-dependency pure logic engines (`code-wrap.js`, `dropdown-logic.js`, `markdown-syntax.js`, `markdown-view-logic.js`).
  - Allowing any synced mod copy (`mods/{files-search,changes-review,git-history}/{code-wrap,markdown-syntax,markdown-view-logic,markdown-view,dropdown-logic,dropdown}.js`) to drift from canonical `shared/*.js`.
  - Duplicating shared wrappers, dropdown popovers, rendered Markdown viewers, or Markdown/syntax tokenizers inside individual mods instead of registering and reusing them through `shared/`.

## Invariants

1. **Zero Line-Number Inflation & Lossless Surrogate-Safe Wrapping (`code-wrap.js`):**
   Wrapping splits long logical lines into visual continuation sub-rows without emitting extra logical line numbers in any consuming viewer (`files-search`, `changes-review`, `git-history`). `wrapPlainText` and `wrapStyledSpans` never split UTF-16 surrogate pairs, never drop or reorder characters, preserve syntax token spans/colors/attributes across continuation sub-rows, and maintain an `O(1)` fast path when line length fits `maxCols`.
2. **Adaptive Dropdown Sizing Without Empty Overflow Scrollboxes (`dropdown-logic.js` + `dropdown.js`):**
   `renderDropdownPopover` computes exact dimensions via `computeDropdownMetrics` so short menus shrink-wrap cleanly to content height and attach `.h(metrics.bodyHeight).overflow_y_scrollbar().track_scroll(...)` ONLY when `metrics.shouldScroll === true`, preventing empty scrollboxes and zero-allocation overhead when menus are closed (`.when(isOpen, ...)`).
3. **Single-Pass O(n) Backtracking-Free Markdown Tokenization (`markdown-syntax.js`):**
   `tokenizeMarkdownLine` and `advanceMarkdownState` scan linearly in `O(n)` time without catastrophic backtracking regexes, preserve exact character concatenation losslessly across all tokens, and keep prose calm while accurately tracking multi-line YAML frontmatter and fenced code block state across virtualized windows and diff hunks.
4. **Safe Rendered Markdown Preparation & Zero Idle Allocation (`markdown-view-logic.js` + `markdown-view.js`):**
   Every viewer starts in raw source or diff mode by default and performs zero `TextView.markdown` allocation or Markdown preprocessing when rendered preview is inactive. `prepareMarkdownForRender` strips valid YAML frontmatter cleanly for badge display, truncates long documents along surrogate/newline boundaries with automatic open-fence closure, and `classifyMarkdownLink` restricts `cx.open_url` strictly to `http://` and `https://` URLs with non-empty hosts.
5. **Byte-for-Byte Sync Parity (`scripts/sync-shared.mjs` & `install.sh`):**
   `node scripts/sync-shared.mjs --check`, `tests/shared-code-wrap.test.mjs`, `tests/shared-dropdown.test.mjs`, `tests/shared-markdown-syntax.test.mjs`, and `tests/shared-markdown-view.test.mjs` fail whenever any target copy in `mods/*/` diverges from canonical `shared/*.js`, and `install.sh` copies each applicable `shared/*.js` file into `$HERDR_APP_HOME/mods/$mod/`.
