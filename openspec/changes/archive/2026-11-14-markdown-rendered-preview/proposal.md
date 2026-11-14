# Proposal: Markdown Rendered Preview (`markdown-rendered-preview`)

## Intent

Markdown specifications, proposals, and READMEs (`.md`, `.mdx`) are viewed across four surfaces in Herdr Mesh: the `files-search` File Viewer Tab, the `files-search` Search Everywhere preview pane, the `changes-review` Review Diff Viewer, and the `git-history` Commit Diff Viewer. Today every surface only renders raw text or unified/side-by-side diffs. While raw code remains essential for default speed, line numbers, search matches, and inline review comments, developers frequently want to inspect formatted headings, lists, code blocks, links, and tables cleanly.

This change introduces an on-demand **Markdown Rendered Preview toggle** backed by a shared pure preparation engine (`shared/markdown-view-logic.js`) and reusable GPUI adapter (`shared/markdown-view.js`) wrapping Herdr's native `TextView.markdown(...)`.

## Scope

### In Scope

1. **Shared Markdown Preview Engine & GPUI Adapter (`shared/`)**:
   - `shared/markdown-view-logic.js` (zero external imports): extension detection (reusing `shared/markdown-syntax.js`), YAML frontmatter separation, UTF-16 surrogate-safe truncation with automatic open-fence closure, `.mdx` cue detection, safe `http(s)://` link classification, relative link normalization, and diff snapshot planning (`after` vs deleted `before`).
   - `shared/markdown-view.js` (GPUI adapter): reusable toggle button (`renderMarkdownToggleButton`), bounded `prepareMarkdownForRender` LRU cache (`createMarkdownRenderCache`), and native `TextView.markdown` scroll container (`renderMarkdownViewer`) with compact frontmatter metadata badges, truncation/deleted/MDX notice banners, and safe `cx.open_url` handling.
   - Parity sync registration in `scripts/sync-shared.mjs` and `install.sh` for `files-search`, `changes-review`, and `git-history`.

2. **Four Viewing Surfaces (Raw/Diff by Default, Toggle On Demand)**:
   - **`mods/files-search` (File Viewer Tab)**: toggle button next to `#viewer-reload`; switches between existing `EditorState` source view and rendered Markdown without re-reading disk, resetting to source view when opening a different file. Supports safe external links and relative workspace file navigation on click.
   - **`mods/files-search` (Search Everywhere Preview Pane)**: toggle button in preview header next to `Open ↵`; uses already-loaded lines when full file is in memory or asynchronously reads from line 1 when viewing a mid-file text match slice. Resets to code preview when changing item or closing overlay.
   - **`mods/changes-review` (Review Diff Viewer Tab)**: toggle button in `#diff-file-review-bar` next to `#diff-reload-btn` and `#diff-viewed-btn` (adapting cleanly to `compactViewer`). Lazy-loads full Working Tree text (`readTextFile`) or commit blob (`git show --no-optional-locks ...`) only when enabled; handles deleted (`D`) files via `HEAD` / parent snapshot with warning banner and pauses inline line comment selection while rendered mode is active.
   - **`mods/git-history` (Commit Diff Viewer Tab)**: toggle button in `#git-diff-toolbar` alongside `Side-by-Side | Unified`; lazy-loads `<hash>:<path>` (or parent snapshot for `D`) with lock-free git flags into a bounded cache. Clicking `Side-by-Side` or `Unified` exits rendered mode cleanly.

### Out of Scope

- Markdown WYSIWYG editing or saving modified Markdown back to disk.
- Replacing `TextView.markdown` with a custom HTML/CSS parser.
- Rendering Markdown by default on file/diff open (raw/diff always opens first per requirement).
- Changes to `layouts/mesh.json`, `keys.json`, or `mesh.*` cross-mod shared state contracts.

## Impact Analysis

- **Layouts & Keybindings**: No modifications to `layouts/mesh.json` or `keys.json`; zero backwards-compatibility impact on existing `main.json`, `terminals.json`, or `win98.json` layouts.
- **Shared Bus Contracts**: No new `mesh.*` global keys required; toggle state remains local to each viewer instance (`viewerMarkdownRendered`, `previewMarkdownRendered`, etc.).
- **Performance & Memory**: Zero allocations, zero extra disk/git reads, and zero `TextView.markdown` builds while rendered preview is OFF (the default).
