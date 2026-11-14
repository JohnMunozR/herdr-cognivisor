# Design: Markdown Rendered Preview (`markdown-rendered-preview`)

## Architecture Overview

Every viewer continues to open Markdown (`.md`, `.mdx`) files in raw source or diff mode by default. Only when the user clicks the shared Markdown toggle button does the viewer prepare content via `shared/markdown-view-logic.js` (memoized in a bounded cache) and mount `TextView.markdown(...)` through `shared/markdown-view.js`.

```text
Default (Raw / Diff) ──[User Clicks Toggle Button]──▶ Prepare (cached, frontmatter split, fence-safe cap)
        ▲                                                        │
        └─────────[Click Toggle / Switch File / Mode]────────────▼
                                                  TextView.markdown + Scrollbar.vertical
                                                    ├─ Optional compact frontmatter pills
                                                    ├─ Optional notice banner (truncated/deleted/MDX)
                                                    └─ Guarded on_link_click (http(s) / relative / ignore)
```

## Pure Engine (`shared/markdown-view-logic.js`)

Reuses `isMarkdownExt`, `isFrontmatterDelimiter`, `parseFenceOpen`, and `parseFenceClose` from `./markdown-syntax.js` (zero external/GPUI imports):

- `getFileExtension(filePath)` & `isMarkdownFile(pathOrExt)`
- `splitMarkdownFrontmatter(rawText)`: strips leading `--- ... ---` block up to a safe bound (`150` lines / `16 KB`) so `TextView.markdown` receives clean Markdown body rather than raw YAML after an `<hr>`. Parses top-level `key: value` entries into a capped summary array for compact badge display.
- `truncateMarkdownSafely(text, maxChars = 240000)`: surrogate-pair-safe and newline-aligned cut with single-pass fenced code tracking so unclosed ` ``` ` / `~~~` blocks are closed automatically.
- `prepareMarkdownForRender(rawText, options)`: combines normalization, frontmatter extraction, safe truncation, and `.mdx` syntax detection.
- `classifyMarkdownLink(url)` / `isSafeExternalUrl(url)` / `resolveRelativeMarkdownPath(currentFilePath, href)`: ensures `cx.open_url(url)` is invoked strictly on validated `http://` and `https://` URLs.
- `getDiffMarkdownPlan(status)`: returns `{ mode: "before" | "after", notice }` so deleted (`D`) files cleanly display the prior snapshot with a banner instead of failing silently.

## GPUI View Composition (`shared/markdown-view.js`)

Imports `{ div, svg }` from `"gpui-kit"`, `{ v_flex, h_flex, TextView, Scrollbar }` from `"gpui-base"`, and `{ ... }` from `"./markdown-view-logic.js"`.

### Toggle Button (`renderMarkdownToggleButton`)
```text
h_flex#id (h(24 or 26), rounded(5/6), border_1, cursor_pointer)
├── [active]: bg(selected/hover), border_color(accent), dot(accent), label("Rendered" | compact)
└── [inactive]: bg(background/raised), border_color(border), label("Render" | compact)
```

### Rendered Container (`renderMarkdownViewer`)
```text
v_flex (relative, flex_1, min_h(0), w_full, overflow_hidden)
├── [if loading]: centered loading indicator
├── [else if error]: padded error message
├── [else if empty]: centered "Empty Markdown file" state
└── [else]:
    ├── v_flex#scrollId (size_full, overflow_y_scroll, px(18), py(14), gap(10))
    │   ├── [if noticeBanner]: muted/warning rounded banner
    │   ├── [if hasFrontmatter]: compact subtle frontmatter metadata bar
    │   └── TextView.markdown(viewId, prepared.markdown).selectable(true).scrollable(false).w_full().on_link_click(...)
    └── Scrollbar.vertical(scrollId).absolute().inset_0()
```

## Lock-Free Git & Lifecycle Invariants

- All on-demand `git show` invocations in `changes-review` and `git-history` MUST pass `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`.
- Async file/git fetches MUST guard against stale sequence numbers or file switches before mutating state or calling `cx.notify()`.
- `render()` MUST remain strictly pure (`O(1)` cache hit or short-circuited when toggled off); never mutate state or call `cx.notify()` synchronously inside `render()`.
- Switching to another file, closing the viewer/overlay, or choosing `Side-by-Side`/`Unified` resets rendered Markdown state back to default raw/diff mode.
