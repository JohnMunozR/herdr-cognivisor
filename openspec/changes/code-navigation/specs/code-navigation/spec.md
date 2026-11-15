---
id: delta-code-navigation
type: task-spec
status: active
title: Delta Specification — Code Navigation (Ctrl+Click)
parent: spec-lifecycle
references: [goal-and-requirements, architecture, module-shared, submodule-mod-files-search]
covers: [code-navigation-ctrl-click, java-js-python-resolution, interactive-windowed-viewer, symbol-index-cache]
tags: [openspec, code-navigation, files-search, shared]
---

## ADDED Requirements

### Requirement: Interactive Windowed File Viewer and Line/Column Jumping

`mods/files-search` (`[[submodule-mod-files-search]]`) SHALL render non-binary source files in `#main` using an interactive windowed code viewer by default while preserving an on-demand `Select Text` mode backed by `EditorState`.

- The File Viewer MUST compute soft-wrapped visual sub-rows via `shared/code-wrap.js` (`computeWrapColumns`, `wrapStyledSpans`) coalescing viewport width reflows on a `16ms` timer (`timer.after(16, ...)`) and rendering only visible rows inside the viewport.
- Opening or updating a File Viewer tab with `{ line, column, highlightSymbol, navSeq }` via `cognivisor.openFileTabs` MUST scroll the viewport to center the target line/row and visually highlight the target line and symbol.
- The File Viewer header MUST provide `←` (Back) and `→` (Forward) navigation history controls (`Alt+Left` / `Alt+Right` when focused), a `Copy` action (`cx.write_to_clipboard`), and an on-demand `Select Text` toggle button that allocates `EditorState.new({ readonly: true, ... })` ONLY while `Select Text` mode is active and releases it on toggle-off, target change, or `closeViewer()`.
- Rendered Markdown mode (`isMarkdownFile`) MUST continue defaulting to `false` and remain mutually exclusive with `Select Text` mode.

#### Scenario: Jumping to a target line and returning via navigation history

- **GIVEN** a File Viewer tab displaying `src/service.js` at line 10
- **WHEN** the developer `Ctrl+Click`s a function call `calculateTotal(order)` resolving to `src/pricing.js:48`
- **THEN** the current location (`src/service.js:10`) is pushed to the viewer's `Back` history stack, `src/pricing.js` opens or updates in the viewer scrolled so line `48` is visible and highlighted, and clicking `←` returns to `src/service.js:10`.

---

### Requirement: Ctrl+Hover Visual Affordance and Ctrl+Click Invocation

Both the `#main` File Viewer and the Search Everywhere Preview (`files-search-win`) MUST detect the platform primary modifier (`event.modifiers.control || event.modifiers.platform`) on navigable identifier tokens.

- Navigable tokens (identifiers, variables, functions, methods, types, annotations, and import specifiers outside non-import strings/comments) MUST carry logical 1-based `(line, col)` coordinates preserved across `wrapStyledSpans`.
- When the primary modifier is held and the pointer hovers a navigable token in the File Viewer or Search Everywhere Preview, the token MUST display `cursor_pointer()` and underline styling.
- `Ctrl+Click` (or `Cmd+Click` on macOS) on a navigable token in the File Viewer MUST invoke symbol resolution and navigate to the resolved target (or open the disambiguation popover when multiple targets tie).
- `Ctrl+Click` on a navigable token in the Search Everywhere Preview MUST resolve the symbol, close the overlay, and open the File Viewer at the resolved declaration/implementation; plain clicks without the modifier MUST preserve existing row selection (`selectResult`).

---

### Requirement: Semantic Symbol Navigation for Java, JavaScript/TypeScript, and Python

`shared/code-nav-logic.js` and language modules `shared/code-nav-js.js`, `shared/code-nav-python.js`, and `shared/code-nav-java.js` (`[[module-shared]]`) SHALL classify cursor usage and resolve targets cleanly without external LSP processes or persistent daemons:

- **Variable / Parameter / Field Usage -> Declaration:** `Ctrl+Click` on a variable, parameter, destructured binding, class field, or `this.`/`self.` attribute MUST resolve to its nearest lexical or class declaration according to each language's scoping rules.
- **Function / Method / Constructor Usage -> Implementation:** `Ctrl+Click` on a function or method call (including `const fn = (...) => ...` arrow functions, class methods, constructors, and `Cls::method` references) MUST resolve to its concrete implementation body.
- **JavaScript / TypeScript (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`):** MUST resolve `{}` block and function scopes, destructuring, `function` hoisting, `const fn = () => ...`, `class` methods/`this.method`, ES `import`/`export`/re-exports, CommonJS `require`/`module.exports`, and `jsconfig.json`/`tsconfig.json`/`package.json` relative/alias paths.
- **Python (`.py`, `.pyw`, `.pyi`):** MUST resolve indentation-based LEGB scopes, `global`/`nonlocal`, parameters (`self`/`cls`/`*args`/`**kwargs`), first assignments, type annotations, `self.attr`/`self.method()`, inheritance (`super()`/bases), `@property`/`@classmethod`/`@staticmethod`, and absolute/relative `import` / `from ... import ...` across module files and `__init__.py`.
- **Java (`.java`):** MUST resolve `package`, explicit/static/wildcard `import`s, `{}` block/method/class/record/enum/interface scopes, local `var` and typed declarations, method arity disambiguation, Lombok/Spring field injection (`@RequiredArgsConstructor`, `@Service`, `@Component`, `@Autowired`, `@Getter`, `@Data`), and interface/abstract polymorphism: when a call resolves to an interface or abstract method without a body, resolution MUST search the workspace/service index for concrete `implements`/`extends` classes implementing that method.
- **Disambiguation Popover:** When resolution yields multiple candidate implementations (e.g., multiple concrete Java `implements` classes), the File Viewer MUST present an adaptive popover using `shared/dropdown.js` (`computeDropdownMetrics`) allowing the developer to select the target implementation.

---

### Requirement: Multi-Service Symbol Indexing and Remote SSH Parity

`mods/files-search/symbol-index.js` SHALL resolve cross-file and cross-service symbols across all repositories in `cognivisor.services` cleanly on local and remote (`on`) hosts:

- On local workspaces, `symbol-index.js` MAY maintain an incremental symbol summary cache persisted at `${appHome()}/cognivisor/workspaces/<slug>-<fnv1a8>/symbols-index.json`, invalidated via debounced `watchFolder` events and `(mtimeMs, size)` checks.
- On remote (`on`) workspaces or when unindexed symbols are queried, cross-file resolution MUST read direct import targets via `readTextFile(path, { on })` and query workspace symbols via bounded `rg` or lock-free `git grep` (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`) through `exec(..., { on })`.
- All asynchronous resolution steps MUST guard against `_viewerClosed` / `_overlayClosed` and stale sequence tokens (`viewerNavSeq`, `viewerLoadSeq`) before mutating UI state or calling `cx.notify()`.
