# Herdr Mesh — Agent Repository Instructions

Herdr Mesh is a unified Multi-Microservice Agent IDE layout and mod suite for the Herdr desktop application. It integrates cross-service code review, workspace-wide file and text search, and multi-service agent coordination into a coherent, high-performance developer workspace.

This repository is strictly governed by the **Fractal Spec-Graph** (`goal-and-requirements.md`, `architecture.md`, and per-directory `SPEC.md`) and **OpenSpec** (`openspec/config.yaml`). Every AI agent operating in this repository must adhere to the rules, boundaries, and invariants documented below.

---

## Read context proportionally

- **Root Requirements:** Consult `goal-and-requirements.md` to understand the product goal, user personas, capabilities, and non-goals.
- **System Architecture:** Consult `architecture.md` for top-level layout topology, mod lifecycle, inter-mod shared state contracts, and system-wide invariants.
- **Owning Module Specs:** When reading, altering, or adding features to layout templates, shared modules, or mods, read the owning `SPEC.md`:
  - `layouts/SPEC.md` for layout topology and window container structures (`[[module-layouts]]`).
  - `shared/SPEC.md` for canonical shared pure engines and GPUI UI adapters (`[[module-shared]]`).
  - `mods/SPEC.md` for the catalog of registered mods (`[[module-mods]]`).
  - `mods/changes-review/SPEC.md` for line-by-line diff review and agent feedback dispatch (`[[submodule-mod-changes-review]]`).
  - `mods/files-search/SPEC.md` for the IntelliJ-style Search Everywhere overlay and file tree viewer (`[[submodule-mod-files-search]]`).
  - `mods/git-history/SPEC.md` for the read-only GitKraken-style commit graph and Before/After comparison viewer (`[[submodule-mod-git-history]]`).
  - `mods/mesh-tabs/SPEC.md` for the workspace tab strip, auto-naming, and `Files`/`Review`/`Git` panel switcher (`[[submodule-mod-mesh-tabs]]`).
  - `mods/mesh-status/SPEC.md` for the bottom workspace telemetry bar (`[[submodule-mod-mesh-status]]`).
- **Proportional Scope:** Localized fixes (e.g., tweaking a style token, fixing a typo, updating documentation) inspect only the relevant files and do not require loading unrelated specifications or mapping the entire repository.

---

## Module structure and boundaries

Modularity in `herdr-mesh` is strict, declarative, and fractal:

- **Per-Directory Specifications:** Every layout collection and mod directory maintains a `SPEC.md` defining its responsibility, exported surface, public state keys, and forbidden reaches.
- **Frontmatter Standard:** Every spec file begins with YAML frontmatter containing:
  ```yaml
  ---
  id: <unique-kebab-slug>
  type: goal-and-requirements | architecture-design | module-design | submodule-design | task-spec
  status: draft | active | done | deprecated
  title: <Human-readable Title>
  parent: <parent-spec-id>
  covers: [<capability-1>, <capability-2>]
  tags: [<tag-1>, <tag-2>]
  ---
  ```
- **Boundary First Rule:** Any proposed change that moves, expands, or alters a module boundary or cross-module state contract must update the owning `SPEC.md` before or alongside the code implementation.
- **Encapsulation:** Mods do not access or mutate internal closures or state fields of sibling mods. All inter-mod communication flows strictly through the Herdr shared state bus (`shared()`, `setShared()`).

---

## Spec-Graph & OpenSpec rules

1. **Fractal Spec-Graph Hierarchy:**
   - `goal-and-requirements` (Root requirements: scope, value, personas)
     └── `architecture` (Top-level topology, cross-cutting contracts, invariants)
         ├── `module-layouts` (`layouts/SPEC.md` — layout definitions and container regions)
         ├── `module-shared` (`shared/SPEC.md` — canonical reusable engines and GPUI UI adapters)
         └── `module-mods` (`mods/SPEC.md` — installed mod manifests and components)
             ├── `submodule-mod-changes-review` (`mods/changes-review/SPEC.md`)
             ├── `submodule-mod-files-search` (`mods/files-search/SPEC.md`)
             ├── `submodule-mod-git-history` (`mods/git-history/SPEC.md`)
             ├── `submodule-mod-mesh-tabs` (`mods/mesh-tabs/SPEC.md`)
             └── `submodule-mod-mesh-status` (`mods/mesh-status/SPEC.md`)
2. **Wikilink Syntax:** Cross-spec references use double brackets matching spec identifiers (e.g., `[[goal-and-requirements]]`, `[[architecture]]`, `[[submodule-mod-files-search]]`).
3. **OpenSpec Governance (`openspec/`):**
   - Structured change proposals, exploration artifacts, and delta specifications live under `openspec/changes/{change-name}/`.
   - `openspec/config.yaml` provides the active configuration for spec-driven workflows.
   - When a substantial capability change is planned, create a proposal in `openspec/changes/` following the OpenSpec convention before modifying production specs.
   - Merged or completed changes are archived to `openspec/changes/archive/YYYY-MM-DD-{change-name}/`.

---

## Herdr runtime & repo-wide invariants

All code in this repository runs inside Herdr's native GPUI shell (`gpui-shell 0.7.x`) and must follow these fundamental invariants:

1. **Native GPUI Views (No DOM / No HTML):**
   - Views are JavaScript classes exporting GPUI-kit component trees using native builders: `div()`, `h_flex()`, `v_flex()`, `TextareaState`, `InputState`.
   - DOM, HTML elements, and CSS classes do not exist.
   - Font family styling must be applied through `.font_family(...)` containers, never nonexistent methods like `.font_mono()`.
   - Theme styling must consume Herdr's theme tokens via `theme()`, `settings()`, and `layout()` rather than hardcoded hex colors.
2. **Lock-Free Git Inspection Flags:**
   - Every read-only Git invocation (`status`, `diff`, `diff-tree`, `show`, `rev-parse`, `ls-files`, `log`, `for-each-ref`) executed by mods or scripts MUST include:
     ```bash
     --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false
     ```
   - This prevents acquiring `.git/index.lock`, avoids blocking active developer commits, and stops infinite filesystem watcher loops.
3. **Shared State Bus Key Isolation:**
   - All shared state bus operations via `shared(key)` and `setShared(key, value)` MUST follow prefix namespacing:
     - Mod-private keys: `<mod-name>.*` (e.g., `files-search.select`, `changes-review.activeDiff`, `git-history.activeDiff`, `git-history.selectedRepo`).
     - Mesh-wide cross-service keys: `mesh.*` (`mesh.services`, `mesh.activeService`, `mesh.flows`, `mesh.spacePanels`, `mesh.spaceAgentTabs`, `mesh.openFileTabs`, `mesh.reviewNotes`).
   - Unprefixed global keys are strictly forbidden.
4. **Layout Immutability & Ownership:**
   - Herdr's default shipped layouts (`main.json`, `terminals.json`, `win98.json`) are immutable and restored on startup.
   - The primary custom layout owned and delivered by this project is `layouts/mesh.json`.
   - Modifications to layout structure must be tested in `layouts/mesh.json` or personal clones, never in Herdr's core shipped layouts.
5. **Shared Reusable Components & `shared/` Registry:**
   - Before introducing UI widgets, soft line-wrappers, dropdown popovers, or syntax tokenizers in any mod, developers and AI agents MUST inspect `shared/` (`[[module-shared]]`) first and extend or reuse the canonical engines and UI adapters (`code-wrap.js`, `dropdown-logic.js`, `dropdown.js`, `markdown-syntax.js`) rather than duplicating implementations per mod.
   - Every shared file MUST be registered in `scripts/sync-shared.mjs` (`SHARED_TARGETS`), synced into `install.sh` (`for mod in "${MODS[@]}"`), and documented in `shared/SPEC.md`. Always run `node scripts/sync-shared.mjs` after editing `shared/*.js` and verify zero drift via `node scripts/sync-shared.mjs --check` (`npm test`).
   - Keep pure engines (`code-wrap.js`, `dropdown-logic.js`, `markdown-syntax.js`) free of `gpui-kit`, `gpui-base`, and `herdr` imports so Node `--test` exercises them cleanly; keep shared GPUI UI adapters (`dropdown.js`) focused on declarative GPUI composition backed by pure `*-logic.js` helpers.
6. **Performance & Rendering Optimization Invariant:**
   - Virtualize scrollable lists, commit graphs, and diff views using `v_virtual_list` + `VirtualListScrollHandle` with precomputed/memoized row heights outside item render callbacks.
   - Guarantee zero per-frame allocations when overlays, dropdown menus, or panels are closed/hidden (short-circuit hidden panels before querying state or constructing UI trees; gate popovers behind `.when(isOpen, ...)`).
   - Size floating dropdown popovers adaptively (`computeDropdownMetrics`) so short menus shrink-wrap cleanly and enable `.h(bodyHeight).overflow_y_scrollbar()` only when `shouldScroll === true` (no empty overflow scrollboxes).
   - Author tokenizers and parsers as single-pass `O(n)` linear scanners without catastrophic backtracking regexes, capping extreme line lengths and render tokens cleanly.
   - Bound all caches (`WeakMap` keyed by immutable row/line objects or capped LRU maps) and coalesce resize reflows using `16ms` timers (`timer.after(16, ...)`).
   - Enforce lock-free Git flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`), preflight cheap ref signature checks (`git show-ref --head` skip when refs and `HEAD` have not moved), and never call `cx.notify()`, `setShared()`, or `set_value()` synchronously inside `render()`.

---

## Verification & Mandatory Unit Testing

Every agent developing, refactoring, or fixing bugs in `herdr-mesh` MUST write or update unit tests in `tests/*.test.mjs` and run the full verification gate before finishing any task:

1. **Mandatory Test Policy (Unit & Regression Tests):**
   - **Always write/update tests during development:** New features, refactors, and bug fixes touching business logic, path handling, Git/CLI parsing, watcher filters, indexing, caching, scoring, or tab-naming rules MUST add or update deterministic unit tests under `tests/`. Every bug fix MUST include a regression test that reproduces the prior failure.
   - **Keep pure logic decoupled from GPUI Views:** Place testable pure functions in intra-mod logic modules (e.g., `mods/files-search/indexer.js`, `mods/files-search/search-logic.js`, `mods/changes-review/review-logic.js`, `mods/git-history/graph-logic.js`, `mods/git-history/diff-logic.js`, `mods/git-history/repo-logic.js`, `mods/mesh-tabs/tab-logic.js`) imported by `main.js`. Keep `gpui-kit` / `gpui-base` rendering in `main.js` so logic modules load cleanly in Node without mocking UI builders. Never use cross-mod `../` relative imports (forbidden by `herdr-app check`).
   - **Zero-dependency test harness:** Tests MUST use Node's native test runner (`node --test tests/*.test.mjs` via `npm test`) without adding `node_modules` dependencies. Mock `herdr` and `fs/promises` cleanly via `tests/helpers/herdr-mock.mjs` only when testing modules that call host APIs. Keep `tests/` and `package.json` at repository root (never inside `mods/*/` runtime bundles installed by `install.sh`).
2. **Unit Test Execution (`node --test`):**
   ```bash
   npm test
   ```
   All unit tests under `tests/*.test.mjs` MUST pass with exit code 0.
3. **GPUI Component Materialization Check:**
   ```bash
   for d in mods/*/; do herdr-app check "$d" || exit 1; done
   ```
   All mod checks (including the 5 active layout mods `files-search`, `changes-review`, `git-history`, `mesh-tabs`, `mesh-status`) must pass (exit code 0), verifying that view definitions, intra-mod imports, eager elements, and manifests materialize without errors. Note that `install.sh` installs all 5 active mods and registers `ctrl-p`/`alt-f` (`mod.open:files-search`) in `keys.json` (no default global shortcut is registered for `git-history` in `keys.json`).
4. **Syntax & Sync Validation:**
   ```bash
   node scripts/sync-shared.mjs --check
   for f in mods/*/*.js shared/*.js; do node --check "$f" || exit 1; done
   bash -n install.sh
   ```
5. **JSON Structure Integrity:**
   ```bash
   node -e 'for (const p of ["package.json", "layouts/mesh.json", "keys.json"]) JSON.parse(require("fs").readFileSync(p, "utf8"))'
   ```
6. **Spec-Graph Link Consistency:**
   Ensure all frontmatter fields (`id`, `parent`, `type`, `status`) and cross-spec wikilinks (`[[id]]`) resolve accurately without orphan references.
