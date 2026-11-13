# Herdr Mesh — Agent Repository Instructions

Herdr Mesh is a unified Multi-Microservice Agent IDE layout and mod suite for the Herdr desktop application. It integrates cross-service code review, workspace-wide file and text search, and multi-service agent coordination into a coherent, high-performance developer workspace.

This repository is strictly governed by the **Fractal Spec-Graph** (`goal-and-requirements.md`, `architecture.md`, and per-directory `SPEC.md`) and **OpenSpec** (`openspec/config.yaml`). Every AI agent operating in this repository must adhere to the rules, boundaries, and invariants documented below.

---

## Read context proportionally

- **Root Requirements:** Consult `goal-and-requirements.md` to understand the product goal, user personas, capabilities, and non-goals.
- **System Architecture:** Consult `architecture.md` for top-level layout topology, mod lifecycle, inter-mod shared state contracts, and system-wide invariants.
- **Owning Module Specs:** When reading, altering, or adding features to layout templates or mods, read the owning `SPEC.md`:
  - `layouts/SPEC.md` for layout topology and window container structures (`[[module-layouts]]`).
  - `mods/SPEC.md` for the catalog of registered mods (`[[module-mods]]`).
  - `mods/changes-review/SPEC.md` for line-by-line diff review and agent feedback dispatch (`[[submodule-mod-changes-review]]`).
  - `mods/files-search/SPEC.md` for the IntelliJ-style Search Everywhere overlay and file tree viewer (`[[submodule-mod-files-search]]`).
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
         └── `module-mods` (`mods/SPEC.md` — installed mod manifests and components)
             ├── `submodule-mod-changes-review` (`mods/changes-review/SPEC.md`)
             └── `submodule-mod-files-search` (`mods/files-search/SPEC.md`)
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
   - Every read-only Git invocation (`status`, `diff`, `rev-parse`, `ls-files`, `log`) executed by mods or scripts MUST include:
     ```bash
     --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false
     ```
   - This prevents acquiring `.git/index.lock`, avoids blocking active developer commits, and stops infinite filesystem watcher loops.
3. **Shared State Bus Key Isolation:**
   - All shared state bus operations via `shared(key)` and `setShared(key, value)` MUST follow prefix namespacing:
     - Mod-private keys: `<mod-name>.*` (e.g., `files-search.select`, `changes-review.active_file`).
     - Mesh-wide cross-service keys: `mesh.*` (`mesh.services`, `mesh.activeService`, `mesh.flows`, `mesh.spacePanels`).
   - Unprefixed global keys are strictly forbidden.
4. **Layout Immutability & Ownership:**
   - Herdr's default shipped layouts (`main.json`, `terminals.json`, `win98.json`) are immutable and restored on startup.
   - The primary custom layout owned and delivered by this project is `layouts/mesh.json`.
   - Modifications to layout structure must be tested in `layouts/mesh.json` or personal clones, never in Herdr's core shipped layouts.

---

## Verification

Before delivering any change, execute the following verification steps:

1. **GPUI Component Materialization Check:**
   ```bash
   for d in mods/*/; do herdr-app check "$d" || exit 1; done
   ```
   All mod checks (including the 4 active layout mods `files-search`, `changes-review`, `mesh-tabs`, `mesh-status`) must pass (exit code 0), verifying that view definitions, eager elements, and manifests materialize without errors.
2. **Syntax Validation:**
   ```bash
   for f in mods/*/main.js; do node --check "$f" || exit 1; done
   ```
3. **JSON Structure Integrity:**
   ```bash
   node -e 'JSON.parse(require("fs").readFileSync("keys.json"))'
   ```
   (And similarly validate `layouts/mesh.json` whenever present).
4. **Spec-Graph Link Consistency:**
   Ensure all frontmatter fields (`id`, `parent`, `type`, `status`) and cross-spec wikilinks (`[[id]]`) resolve accurately without orphan references.
