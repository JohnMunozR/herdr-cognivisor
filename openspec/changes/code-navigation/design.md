# Design: Code Navigation (`code-navigation`)

## Architecture Overview

Because `gpui-shell 0.7.1` `EditorState` does not expose `scroll_to_line` or pointer/token events and `v_virtual_list` forbids per-token handlers inside row render callbacks, navigable code viewing is delivered entirely in JS via a **windowed interactive code reader** in `mods/files-search/main.js` backed by shared pure engines in `shared/`.

```text
User Ctrl+Hover / Ctrl+Click on token (line, col)
  │
  ├──▶ [Token Layer] shared/code-syntax.js + shared/code-wrap.js
  │      - tokenizeInteractiveCodeLine emits navigable identifiers with 1-based col
  │      - wrapStyledSpans preserves col across wrapped visual sub-rows
  │
  ├──▶ [Pure Resolver] shared/code-nav-logic.js + code-nav-{js,python,java}.js
  │      1. classifyUsageAt(tokens, col) -> variable_ref | call_expr | type_ref | import_ref
  │      2. resolveInFile(lang, text, line, col, targetKind) -> local/class hit OR external hint
  │      3. resolveImportCandidatePaths(...) -> ordered candidate paths (JS/TS, Py, Java)
  │      4. rankCandidates(...) -> exact match or multiple implementations
  │
  └──▶ [IO & UI Controller] mods/files-search/symbol-index.js + main.js
         - Level 1: Intra-file hit (0ms) -> push Back history + scrollToLine
         - Level 2: Direct import readTextFile(..., { on }) + resolveInTargetFile
         - Level 3: Workspace symbol index (local cache) or bounded rg / lock-free git grep
         - 1 target -> navigate & highlight | N targets -> shared/dropdown.js popover
```

## Shared Modules (`shared/`)

All pure logic modules contain zero `gpui-kit`, `gpui-base`, `herdr`, or `node:*` imports and sync via `scripts/sync-shared.mjs` and `install.sh`:

1. **`shared/code-syntax.js`**:
   - Consolidates `getSyntaxExt`, `resolveEditorLanguage`, `getSyntaxPalette`, `getEditorSyntaxConfig`, `syntaxTokenStyle`, `expandCodeTabs`, and single-pass `O(n)` `tokenizeCodeLine(rawText, ext, mdState, opts)` consumed by `files-search`, `changes-review`, and `git-history`.
   - Adds `tokenizeInteractiveCodeLine(rawText, ext, mdState)` returning span tuples `[kind, text, { col, nav }]` where identifiers inside `"plain"` slices are split cleanly into standalone spans with 1-based column positions (`col`) and `nav: true` for navigable symbols.
2. **`shared/code-wrap.js`**:
   - Updates `makeSpanSlice` and `wrapStyledSpans` so 3-element tuples `[kind, text, meta]` and object spans `{ text, col, ... }` preserve `meta` and shift `col` accurately across soft-wrapped continuation sub-rows without changing behavior for existing 2-tuple `[kind, text]` callers.
3. **`shared/code-nav-logic.js`**:
   - Language routing (`detectNavLanguage(filePath)` -> `"java" | "js" | "python" | null`).
   - Token cursor context extraction (`extractNavContext(lineTokens, col)`): identifies target symbol, `usageKind` (`"variable" | "call" | "type" | "import"`), qualifier chain (`this.repo.save` -> `["this", "repo"]` + `"save"`), argument count (for Java overload ranking), and import path strings.
   - Generic history stack helpers (`createNavHistoryState`, `pushNavHistory`, `stepNavBack`, `stepNavForward`).
   - Symbol summary extractor dispatcher (`extractFileSymbolSummary(filePath, text)`) used by `symbol-index.js`.
4. **`shared/code-nav-js.js`, `shared/code-nav-python.js`, `shared/code-nav-java.js`**:
   - Each exports `{ resolveInFile, extractFileSymbolSummary }` implementing full variable-declaration vs function-implementation semantics for its language.
5. **`shared/dropdown-logic.js` & `shared/dropdown.js`**:
   - Synced to `mods/files-search` for rendering the adaptive implementation-picker popover (`computeDropdownMetrics`, `renderDropdownPopover`).

## Windowed File Viewer GPUI Tree (`mods/files-search/main.js`)

```text
v_flex#file-viewer (size_full, bg(t.background), track_focus(viewerFocusHandle))
├── on_modifiers_changed / on_key_down (Alt+Left, Alt+Right, Up/Down/PgUp/PgDn/Home/End)
├── h_flex (h(40), border_b)  [Header]
│   ├── ← / → navigation history buttons
│   ├── file icon + optional service pill + fileName + muted parentDir
│   ├── optional Ln:Col pill + subtle "via Interface" indicator if polymorphic jump
│   ├── Copy button (cx.write_to_clipboard)
│   ├── optional Markdown Toggle (renderMarkdownToggleButton when isMarkdownFile)
│   ├── Select Text toggle (switches between Interactive Reader and lazy Editor.new)
│   └── Reload button
└── [Body]
    ├── [if showRenderedMd]: renderMarkdownViewer(...)
    ├── [else if viewerSelectTextMode && viewerCode]: Editor.new(viewerCode)
    ├── [else if viewerError / binary / loading]: status view
    └── [else]: h_flex#viewer-code-viewport (flex_1, relative, on_size_change -> 16ms wrap reflow, on_scroll_wheel)
        ├── v_flex (flex_1, overflow_hidden) -> visible sub-rows slice [scrollTop .. scrollTop + visibleCount]
        │   └── h_flex (rowHeight = 20, target highlight bg when line === viewerHighlightLine)
        │       ├── line number gutter (click copies line)
        │       └── token spans: div().id(...).on_hover(...).when(ctrl && hovered, underline + cursor_pointer).on_click(...)
        ├── custom proportional vertical scrollbar track (8px, clickable PageUp/PageDown regions + keyboard Up/Down/PageUp/PageDown/Home/End scrolling)
        └── [if disambiguationOpen]: floating popover via renderDropdownPopover(...)
```

## Shared Bus & Performance Safeguards

- `cognivisor.openFileTabs` adds optional `{ column, highlightSymbol, navSeq }` so repeated jumps to the same open file still re-center and highlight cleanly.
- `renderViewer` remains strictly pure (all shared updates and async navigation run in handlers/timers/spawns).
- Single-pass `O(n)` lexing/parsing with per-file size caps (`400KB` viewer cap, `1600` chars/line syntax cap) prevents QuickJS `interrupted` timeouts.
- All `git grep` fallbacks pass `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`.
