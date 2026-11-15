# Proposal: Code Navigation (`code-navigation`)

## Intent

Developers inspecting source files in Herdr Cognivisor—across multi-microservice Java/Spring/Lombok, JavaScript/TypeScript/JSX/TSX, and Python repositories—need IDE-grade `Ctrl+Click` (and `Cmd+Click` on macOS) navigation directly from variables to their declarations and from function/method calls to their implementations.

Today, the `#main` File Viewer renders files inside Herdr's native `Editor`/`EditorState`, which exposes neither `scroll_to_line` nor mouse/modifier/token callbacks (`gpui-kit.d.ts`), leaving `Ln <line>` as an inert header pill and preventing interactive code navigation. Furthermore, lexical syntax highlighting is duplicated across three mods (`files-search`, `changes-review`, `git-history`) and treats local identifiers as untokenized `"plain"` text.

This change introduces:
1. A canonical, unified syntax and interactive navigation engine in `shared/` (`code-syntax.js`, `code-nav-logic.js`, `code-nav-js.js`, `code-nav-python.js`, `code-nav-java.js`) plus column-preserving wrap offsets in `shared/code-wrap.js`.
2. An interactive windowed GPUI-kit File Viewer (`#main`) with `Ctrl+Hover` underline feedback, `Ctrl+Click` navigation, real `scrollToLine(line, col, highlightSymbol)`, `Back`/`Forward` (`←`/`→`, `Alt+Left`/`Alt+Right`) history, copy helpers, an on-demand `Select Text` (`Editor.new`) escape hatch, and an adaptive disambiguation popover (`shared/dropdown.js`) when multiple implementations exist.
3. `Ctrl+Click` symbol navigation inside the Search Everywhere preview pane (`files-search-win`), plus a cached, agent/terminal-gated multi-service symbol index (`mods/files-search/symbol-index.js`) that works locally and over SSH (`on`) without embedding an LSP or background daemons.

## Scope

### In Scope

1. **Shared Code Syntax & Pure Navigation Engine (`shared/`):**
   - `shared/code-syntax.js`: Unified single-pass `O(n)` syntax lexer (eliminating duplication across `files-search`, `changes-review`, `git-history`) plus `tokenizeInteractiveCodeLine` emitting identifier-granular tokens with 1-based logical column offsets.
   - `shared/code-wrap.js`: Preserve optional 3rd-element token metadata (`{ col, nav }`) and adjust continuation column offsets across wrapped visual rows without breaking existing `[kind, text]` tuple callers.
   - `shared/code-nav-logic.js` + `shared/code-nav-js.js`, `shared/code-nav-python.js`, `shared/code-nav-java.js`: Zero-dependency pure engines for usage classification (`variable_ref` -> declaration, `call_expr` -> implementation, `type_ref` -> definition, `import_ref` -> module/symbol), lexical/indentation scope trees, import/package resolution, and Java interface/superclass polymorphism + Spring/Lombok (`@RequiredArgsConstructor`, `@Getter`, `@Data`, `@Service`/`@Component`).
   - Sync `shared/dropdown-logic.js`, `shared/dropdown.js`, `shared/code-syntax.js`, and `shared/code-nav-*.js` via `scripts/sync-shared.mjs` and `install.sh`.

2. **Interactive Windowed File Viewer & Search Everywhere Preview (`mods/files-search`):**
   - Windowed visual-row code viewer in `#main` with `on_scroll_wheel`, keyboard navigation, clickable vertical scroll track, `scrollToLine` centering + target line/token highlight, `on_modifiers_changed` + `on_hover` underline + `on_click` (`control || platform`), `←`/`→` history stack, `Copy` actions, and on-demand `Select Text` toggle (`EditorState` allocated only while toggled ON).
   - `Ctrl+Click` on navigable tokens inside Search Everywhere preview (`files-search-win`), opening/focusing the resolved declaration or implementation in `#main` while leaving plain row clicks unchanged.
   - `mods/files-search/symbol-index.js`: Disk-cached symbol index under `${appHome()}/cognivisor/workspaces/<slug>-<fnv1a8>/symbols-index.json` with debounced `watchFolder` invalidation locally and bounded lock-free `rg` / `git grep` fallback via `exec(..., { on })` for remote SSH workspaces.

3. **Shared Bus & Spec Governance:**
   - Extend `cognivisor.openFileTabs` with optional backwards-compatible navigation fields (`column`, `highlightSymbol`, `navSeq`).
   - Reconcile `goal-and-requirements.md` Non-Goals (explicitly distinguishing zero-daemon on-demand static navigation from embedded LSP editors), `architecture.md`, `shared/SPEC.md`, `mods/SPEC.md`, and `mods/files-search/SPEC.md`.

### Out of Scope

- Embedding an external Language Server Protocol (LSP) client or spawning persistent background language server daemons.
- Adding `Ctrl+Click` token handlers inside `changes-review` or `git-history` `v_virtual_list` diff views in this change (can be layered later via `cognivisor.openFileTabs` jump requests).
- Modifying `layouts/cognivisor.json`, `keys.json`, or Herdr core shipped layouts (`main.json`, `terminals.json`, `win98.json`).

## Impact Analysis

- **Layouts & Keybindings:** Zero modifications to `layouts/cognivisor.json` or `keys.json`; global shortcuts and default Herdr layouts remain 100% backwards-compatible.
- **Shared Bus Contracts:** `cognivisor.openFileTabs` gains optional `column`, `highlightSymbol`, and `navSeq` fields; existing readers (`cognivisor-tabs`, `files-search`) ignore unknown optional properties cleanly.
- **Performance & Memory:** Windowed rendering builds GPUI elements strictly for visible sub-rows (~35–65 rows); `EditorState` is not allocated in default Navigate Mode; `v_virtual_list` restrictions are avoided cleanly; remote SSH workspaces resolve direct imports via `readTextFile(..., { on })` and cross-repo symbols via bounded `rg` / lock-free `git grep` without mass file downloads.
