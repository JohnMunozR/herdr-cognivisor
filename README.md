# Herdr Mesh

> A unified **Multi-Microservice Agent IDE** layout and 7-mod lifecycle suite for the [Herdr](https://github.com/herdr-app) desktop application.

Herdr Mesh re-architects Herdr for modern microservice engineering (`Plan -> Build -> Review -> Test -> PR -> dev -> CI -> main`). Instead of siloing developers and autonomous AI coding agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`) inside isolated single-repository windows or requiring manual tab management, Herdr Mesh turns each workspace tab into an organic, feature-scoped work unit spanning multiple repositories—from prompt-driven auto-naming and cross-service diff review to zero-pollution Playwright E2E testing and templated GitHub promotion chains.

---

## 6-Stage Agent IDE Lifecycle

Each tab tracks its progress through an ordered 6-stage pipeline in `#flow` (`mods/mesh-flow`) and synchronizes the workspace drawer stack (`#panel-body`):

| Stage | ID | UI Label | Coupled `#panel-body` Slot | Primary Mods |
|---|---|---|---|---|
| 1 | `plan` | `1. Plan` | Terminal-focused (`#main`) | `mesh-tabs`, `mesh-flow` |
| 2 | `build` | `2. Build` | Terminal-focused / `files` | `mesh-flow`, `files-search` |
| 3 | `review` | `3. Review` | `changes` | `changes-review`, `mesh-flow` |
| 4 | `test` | `4. Test` | `test` | `mesh-test`, `mesh-flow`, `mesh-status` |
| 5 | `pr_dev` | `5. PR → dev` | `ship` | `mesh-ship`, `mesh-flow`, `mesh-status` |
| 6 | `promote` | `6. CI → main` | `ship` | `mesh-ship`, `mesh-flow`, `mesh-status` |

---

## Key Features & 7-Mod Suite

- **Organic Tab Auto-Naming & Space Panel Memory (`mods/mesh-tabs`):**
  - Automatically detects generic or unnamed tabs (`^tb\d+$`, numeric indices, `!tab.named`, bare program titles) and inspects `hc get <t> --json` / `hc read <t>` to extract Jira ticket keys (`[A-Z][A-Z0-9]{1,9}-\d+`) and summarize `first_message` (falling back to lock-free `git rev-parse --abbrev-ref HEAD`).
  - Applies concise titles via `run("tab.rename")` while strictly protecting manual user renames (`tab.named === true` or `manualTitle: true`).
  - Supports double-click inline `InputState` tab renaming, stage mini-badges (`Plan`, `Build`, `Rev`, `Test`, `PR`, `CI`), 4-panel drawer toggles (`Files`, `Review`, `Test`, `Ship`), and per-space panel persistence via `shared("mesh.spacePanels")` with zero `localStorage`.
- **Tab-Scoped Pipeline & Lead Agent Orchestration (`mods/mesh-flow`):**
  - Renders the `38px` `#flow` bar above `#work-body` with extracted Jira ticket badge, 1-click inline editable flow title, `Auto` re-sync trigger, interactive 6-stage stepper, live test alerts, and subagent telemetry (`terminal.peek`).
  - Pins and cycles `leadTerminal` per tab so auxiliary `+ Shell` split runners (`meshRunner=true`) never hijack review, check, test, or PR prompts.
- **Microservice-by-Microservice Review & Repo Checks (`mods/changes-review`):**
  - Displays current Git branch per discovered microservice using lock-free flags, JetBrains Mono diffs, `git diff -U99999` hunk context expansion, and inline multi-line review notes.
  - Maintains a tab-scoped per-service checklist (`pending | has_notes | approved`) in `mesh.flows[tabId].reviewedServices`; `Approve Service ✓` marks the current service approved and advances to the next unreviewed dirty microservice.
  - Includes a `Checks` drawer that inspects `AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, and `Makefile`, executes lint/test/check commands per microservice, and dispatches failures directly to `leadTerminal` (with `→ Go to Test` transition).
- **Zero-Pollution Live Testing & Playwright E2E Screenshots (`mods/mesh-test`):**
  - Stores all test-plan JSON files and Playwright PNG screenshots exclusively under `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json` and `screenshots/<tabId>/`, keeping microservice Git repositories clean.
  - Supports `Ask Agent for Test Plan`, atomic compare-and-swap `Approve Plan`, live `watchFolder` + visible-only `1500ms` polling for `curl` and `e2e` test cases, `Headless` / `Headed` Playwright mode toggling, TCP listening port probing (`ss -tln`), 1-click `+ Service Runner` split panes, manual `curl` re-runs, `Scan Terminal Curls`, and `Send Failures to Agent`.
  - Renders Playwright PNG screenshots inline via native GPUI `image(absPath)` (guarded by `exists(absPath)`) with a click-to-zoom modal overlay (`openOverlay`).
- **Configurable PR Templates & GitHub Promotion Chains (`mods/mesh-ship`):**
  - Configures workspace branch promotion chains (default `["development", "ci", "main"]`) with optional per-repo overrides persisted in `shared("mesh.pipelineConfig")`.
  - Manages a shared PR template synced with `${appHome()}/mesh/pr-template.md` supporting `{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, and `{{testSummary}}`, injected identically into direct `gh pr create` calls and `Ask Agent to Create PRs`.
  - Queries `gh` asynchronously per microservice to monitor PR state, CI `statusCheckRollup`, `reviewDecision`, and unresolved review threads, offering 1-click `Send Review Comments to Agent` and single-service or batch promotion PRs.
- **Lifecycle Telemetry Status Bar (`mods/mesh-status`):**
  - Upgrades `#status` (`28px`) to display active host/machine, multi-service/dirty counts, active tab stage, clickable live `mesh.testAlert` status, clickable PR/CI/review comment alerts, agent activity counters, and `app.palette` shortcut hint.
- **IntelliJ-Style Search Everywhere & Multi-Repo File Tree (`mods/files-search`):**
  - Docked multi-repo file tree with folder git-change counters, `repo` pills, and synchronized `mesh.activeService` filters.
  - Multi-tab floating Search Everywhere overlay (`All`, `Files`, `Text`) with asynchronous ripgrep search, live code preview, and draggable/resizable window chrome.
- **Lock-Free & Native GPUI Guarantees:**
  - All read-only Git queries enforce `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`, and all 7 mods run purely on `gpui-kit` / `gpui-base` with zero `localStorage` and dynamic `theme()` colors.

---

## Spec-Graph & Architecture Overview

Herdr Mesh is structured using the **Fractal Spec-Graph** paired with **OpenSpec**:

- [`goal-and-requirements.md`](file:///home/nmr/Projects/herdr-mesh/goal-and-requirements.md): Product vision, user personas, value drivers, principles, capabilities, and non-goals.
- [`architecture.md`](file:///home/nmr/Projects/herdr-mesh/architecture.md): Top-level system topology, 7-mod catalog, cross-mod shared state bus contracts, runtime storage boundary, and repo-wide invariants.
- [`openspec/specs/lifecycle/spec.md`](file:///home/nmr/Projects/herdr-mesh/openspec/specs/lifecycle/spec.md): Authoritative Agent IDE Lifecycle domain specification (`spec-lifecycle`).
- [`AGENTS.md`](file:///home/nmr/Projects/herdr-mesh/AGENTS.md): Repository instructions and boundary rules for AI execution workers.
- [`openspec/config.yaml`](file:///home/nmr/Projects/herdr-mesh/openspec/config.yaml): OpenSpec SDD configuration for proposed architectural changes and delta specs.
- [`openspec/changes/agent-ide-lifecycle/tasks.md`](file:///home/nmr/Projects/herdr-mesh/openspec/changes/agent-ide-lifecycle/tasks.md): Implementation and verification checklist for the Agent IDE Lifecycle release.
- [`.atl/skill-registry.md`](file:///home/nmr/Projects/herdr-mesh/.atl/skill-registry.md): Skill registry indexing Spec-Graph and OpenSpec conventions.

```text
goal-and-requirements.md (Root requirements)
   └── architecture.md (System topology, shared bus & invariants)
         ├── openspec/specs/lifecycle/spec.md (Agent IDE Lifecycle spec)
         ├── layouts/SPEC.md (Layout module & layouts/mesh.json)
         └── mods/SPEC.md (7-mod suite catalog)
               ├── mods/files-search/SPEC.md (Search Everywhere & file tree)
               ├── mods/changes-review/SPEC.md (Per-service diff review, checklist & Checks)
               ├── mods/mesh-tabs/SPEC.md (Organic auto-naming & mesh.spacePanels)
               ├── mods/mesh-flow/SPEC.md (6-stage pipeline & leadTerminal bar)
               ├── mods/mesh-test/SPEC.md (Zero-pollution curl & Playwright E2E testing)
               ├── mods/mesh-ship/SPEC.md (PR templates & GitHub promotion pipeline)
               └── mods/mesh-status/SPEC.md (Lifecycle status telemetry bar)
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
| `Esc` | Search / Zoom overlay | Close active overlay dialog |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Search overlay | Enlarge, shrink, or reset search window size |

---

## Installation

### Automated Installer

Run the included installer to install all 7 mods (`files-search`, `changes-review`, `mesh-tabs`, `mesh-flow`, `mesh-test`, `mesh-ship`, `mesh-status`), copy `layouts/mesh.json`, validate each mod with `herdr-app check`, register global keyboard shortcuts safely, and activate the `mesh` layout:

```bash
# Install Herdr Mesh layout, all 7 mods, and shortcuts
./install.sh

# Target a custom Herdr config directory or custom binary
./install.sh --home ~/.config/herdr-app --app-bin ~/.local/bin/herdr-app

# Uninstall, revert to 'main' layout, clean shortcuts, and remove all 7 mods
./install.sh --uninstall
```

### Manual Installation

1. Copy all 7 mod directories (`files-search`, `changes-review`, `mesh-tabs`, `mesh-flow`, `mesh-test`, `mesh-ship`, `mesh-status`) from `mods/` into `~/.config/herdr-app/mods/` (excluding `SPEC.md`, `jsconfig.json`, and `gpui-kit.d.ts` if you want minimal runtime directories).
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

Herdr Mesh views are written in native JavaScript using `gpui-kit` and `gpui-base`. Verify all 7 mods, scripts, JSON files, and runtime invariants before delivery:

```bash
# Check GPUI view materialization and manifests across all 7 mods
herdr-app check mods/files-search && \
herdr-app check mods/changes-review && \
herdr-app check mods/mesh-tabs && \
herdr-app check mods/mesh-flow && \
herdr-app check mods/mesh-test && \
herdr-app check mods/mesh-ship && \
herdr-app check mods/mesh-status

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
