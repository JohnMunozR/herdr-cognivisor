# Herdr Mesh

> A unified **Multi-Microservice Agent Workspace** layout and 4-mod suite for the [Herdr](https://github.com/herdr-app) desktop application.

Herdr Mesh adapts Herdr for modern multi-repository and microservice workflows without visual noise or heavyweight IDE chrome. Instead of listing unrelated clean repositories under `/Projects` or hiding sibling microservices edited by an agent started in a single folder, Herdr Mesh tracks session-attributed repositories per tab, auto-names agent tabs from Jira keys and prompts, provides service-by-service code review with repo standard `Checks`, and delivers cross-platform Search Everywhere navigation.

---

## Key Features & 4-Mod Suite

- **Organic Tab Auto-Naming & Space Panel Memory (`mods/mesh-tabs`):**
  - Automatically detects generic or unnamed tabs (`^tb\d+$`, numeric indices, `!tab.named`, bare program titles) and inspects `hc get <t> --json` / `hc read <t>` to extract Jira ticket keys (`[A-Z][A-Z0-9]{1,9}-\d+`) and summarize `first_message` (falling back to lock-free `git rev-parse --abbrev-ref HEAD`).
  - Applies concise titles via `run("tab.rename")` while strictly protecting manual user renames (`tab.named === true` or `manualTitle: true`).
  - Supports double-click inline `InputState` tab renaming, panel drawer toggles (`Files`, `Review`), and per-space panel persistence via `shared("mesh.spacePanels")` with zero `localStorage`.
- **Session-Scoped Multi-Repo File Tree & Search Everywhere (`mods/files-search`):**
  - Anchors the tree root to `space.folder`, discovers repositories (including parent siblings and extra pane `cwd`s), runs lock-free `git status --untracked-files=normal`, and exposes only session-attributed touched repositories via `mesh.services`.
  - Uses debounced `watchFolder` (ignoring `target/`, `node_modules/`, internal `.git/` lock churn), cached repo discovery (`REPO_CACHE_TTL_MS = 60000`), incremental dirty-folder reloads, hidden-panel polling throttling, and native `fs/promises` local scans on Windows/Linux/macOS.
  - Multi-tab floating Search Everywhere overlay (`All`, `Files`, `Text`) with normalized ripgrep paths (`--path-separator /`), fixed-string `-F` retry on regex characters, exit-code-aware fallback, and clamped live code preview.
- **Microservice-by-Microservice Review & Repo Checks (`mods/changes-review`):**
  - Consumes `mesh.services` (`sig`-gated, `BUS_MAX_AGE_MS = 90000`) to avoid duplicate scanning, displaying per-service Git branches, JetBrains Mono diffs, `git diff -U99999` hunk context expansion, and inline multi-line review notes.
  - Maintains a tab-scoped per-service checklist (`pending | has_notes | approved`) in `mesh.flows[tabId].reviewedServices`; `Approve Service ✓` marks the current service approved and advances to the next unreviewed dirty microservice.
  - Includes a `Checks` drawer that inspects `AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, and `Makefile`, executes lint/test/check commands per microservice (`cmd /c` for `.cmd` shims/chains on Windows, `sh -c` on POSIX), and dispatches failures directly to `leadTerminal`.
- **Workspace Telemetry Status Bar (`mods/mesh-status`):**
  - Upgrades `#status` (`28px`) to display active host/machine, multi-service/dirty counts, active branch, live agent activity counters, and `app.palette` shortcut hint.
- **Lock-Free & Native GPUI Guarantees:**
  - All read-only Git queries enforce `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`, and all 4 active mods run purely on `gpui-kit` / `gpui-base` with zero `localStorage`, pure `render()` frames (no synchronous `cx.notify()`/`setShared()` during render), and dynamic `theme()` colors.

---

## Spec-Graph & Architecture Overview

Herdr Mesh is structured using the **Fractal Spec-Graph** paired with **OpenSpec**:

- [`goal-and-requirements.md`](file:///home/nmr/Projects/herdr-mesh/goal-and-requirements.md): Product vision, user personas, value drivers, principles, capabilities, and non-goals.
- [`architecture.md`](file:///home/nmr/Projects/herdr-mesh/architecture.md): Top-level system topology, 4-mod catalog, cross-mod shared state bus contracts, and repo-wide invariants.
- [`openspec/specs/lifecycle/spec.md`](file:///home/nmr/Projects/herdr-mesh/openspec/specs/lifecycle/spec.md): Authoritative Agent IDE domain specification (`spec-lifecycle`).
- [`AGENTS.md`](file:///home/nmr/Projects/herdr-mesh/AGENTS.md): Repository instructions and boundary rules for AI execution workers.
- [`openspec/config.yaml`](file:///home/nmr/Projects/herdr-mesh/openspec/config.yaml): OpenSpec SDD configuration for proposed architectural changes and delta specs.
- [`.atl/skill-registry.md`](file:///home/nmr/Projects/herdr-mesh/.atl/skill-registry.md): Skill registry indexing Spec-Graph and OpenSpec conventions.

```text
goal-and-requirements.md (Root requirements)
   └── architecture.md (System topology, shared bus & invariants)
         ├── openspec/specs/lifecycle/spec.md (Agent IDE spec)
         ├── layouts/SPEC.md (Layout module & layouts/mesh.json)
         └── mods/SPEC.md (4-mod active suite catalog)
               ├── mods/files-search/SPEC.md (Search Everywhere & session file tree)
               ├── mods/changes-review/SPEC.md (Per-service diff review, checklist & Checks)
               ├── mods/mesh-tabs/SPEC.md (Organic auto-naming & mesh.spacePanels)
               └── mods/mesh-status/SPEC.md (Workspace status telemetry bar)
```

---

## Keyboard Shortcuts

| Shortcut | Context | Action |
|---|---|---|
| `Ctrl+P` | Global | Open Search Everywhere dialog |
| `Alt+F` | Global | Open Search Everywhere dialog |
| Double `Shift` | Files panel | Open Search Everywhere dialog (within 400ms) |
| `Tab` / `Shift+Tab` | Search overlay | Cycle search tabs (**All** → **Files** → **Text**) |
| `Alt+P` / `Ctrl+P` | Search overlay | Toggle live code preview pane |
| `↑` / `↓` / `PageUp` / `PageDown` | Search overlay | Navigate search results list |
| `Enter` | Search overlay | Jump to file in file tree and close dialog |
| `Esc` | Search overlay | Close active overlay dialog |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Search overlay | Enlarge, shrink, or reset search window size |

---

## Installation

### Automated Installer

Run the included installer to install the 4 active mods (`files-search`, `changes-review`, `mesh-tabs`, `mesh-status`), clean up legacy `mesh-flow` / `mesh-test` / `mesh-ship` directories if present, copy `layouts/mesh.json`, validate each mod with `herdr-app check`, register global keyboard shortcuts safely, and activate the `mesh` layout:

```bash
# Install Herdr Mesh layout, 4 mods, and shortcuts
./install.sh

# Target a custom Herdr config directory or custom binary
./install.sh --home ~/.config/herdr-app --app-bin ~/.local/bin/herdr-app

# Uninstall, revert to 'main' layout, clean shortcuts, and remove installed mods
./install.sh --uninstall
```

### Manual Installation

1. Copy the 4 active mod directories (`files-search`, `changes-review`, `mesh-tabs`, `mesh-status`) from `mods/` into `~/.config/herdr-app/mods/` (excluding `SPEC.md`, `jsconfig.json`, and `gpui-kit.d.ts` if you want minimal runtime directories).
2. Copy `layouts/mesh.json` to `~/.config/herdr-app/layouts/mesh.json` and remove any cached `~/.config/herdr-app/layouts/.state/mesh.json`.
3. Merge keybindings from `keys.json` into `~/.config/herdr-app/keys.json` without overwriting existing user bindings:
   ```json
   {
     "global": {
       "ctrl-p": "mod.open:files-search",
       "alt-f": "mod.open:files-search"
     }
   }
   ```
4. Activate the **Mesh** layout in Herdr:
   ```bash
   herdr-app do layout.switch '{"name":"mesh"}'
   ```

---

## Development & Verification

Herdr Mesh views are written in native JavaScript using `gpui-kit` and `gpui-base`. Verify all mods, scripts, JSON files, and runtime invariants before delivery:

```bash
# Check GPUI view materialization and manifests
for d in mods/*/; do herdr-app check "$d" || exit 1; done

# Check JavaScript syntax across all mod entrypoints
for f in mods/*/main.js; do node --check "$f" || exit 1; done

# Verify JSON schema integrity
node -e 'JSON.parse(require("fs").readFileSync("layouts/mesh.json","utf8")); JSON.parse(require("fs").readFileSync("keys.json","utf8"));'

# Verify zero localStorage usage across all mod implementations
! rg -n "localStorage" mods/*/main.js

# Check installer syntax and CLI help
bash -n install.sh && ./install.sh --help
```

---

## License

This project is licensed under the Apache License 2.0. See [LICENSE](file:///home/nmr/Projects/herdr-mesh/LICENSE) for details.
