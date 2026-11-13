# mesh

A unified **Multi-Microservice Agent Workspace** layout recipe and 4-mod distribution package for the Herdr desktop app. It bundles `layouts/mesh.json`, the 4 active workspace mods (`files-search`, `changes-review`, `mesh-tabs`, `mesh-status`), and global keyboard shortcuts (`keys.json`) into a cohesive, terminal-first developer workspace.

## What you see

- **Left Navigation Sidebar (`#sidebar`, `268px`):**
  - `#brand` (`46px`, `workspace-chrome`, `window_drag: true`), `#spaces`, `#agents`, and `#sidebar-footer` (`69px`, `workspace-chrome`).
  - Displays active workspace spaces, remote SSH hosts, running AI coding agents, and layout preferences.
- **Header & Organic Workspace Tabs Bar (`#tabs`, `42px`, `mod: "mesh-tabs"`, `window_drag: true`):**
  - Renders workspace tabs with agent/program icons, concise auto-derived or user-edited titles, live activity spinners/dots, `+` new-tab menu, 2 drawer toggle buttons (`Files`, `Review`), and platform window controls.
- **Main Agent Terminal Area (`#main`):**
  - Primary execution pane (`tab: "active"`, `pane` header `30px`, `lone: true`, `radius: 10`) hosting AI coding agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`).
- **Collapsible 2-Panel Stack (`#panel`, `420px` [300–960], `hidden: true` by default / `#panel-body` stack):**
  - **`#files` (`files-search`):** Docked session-scoped multi-repo file tree with folder modification badges, `repo` markers, synchronized service filter pills, and the floating **Search Everywhere** modal (`files-search-win`) with `All` / `Files` / `Text` tabs, normalized ripgrep streaming, live code preview, and corner resize grip.
  - **`#changes` (`changes-review`):** Per-service Git branch pills, working-tree/commit diff viewer in JetBrains Mono (`11px`), `Expand context` (`git diff -U99999`), inline comment cards, per-tab `reviewedServices` checklist (`Approve Service ✓`), repository standards `Checks` drawer (`AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, `Makefile`), and `leadTerminal`-prioritized feedback / multi-repo commit footer.
- **Telemetry Status Bar (`#status`, `28px`, `mod: "mesh-status"`):**
  - Displays active host (`This computer` / SSH machine), multi-service & dirty counts (`N services · M dirty`), active branch, live agent counter (`N agents · M needs you`), and `app.palette` shortcut hint.

## How it behaves

- **Organic Tab Auto-Naming & Manual Protection:**
  - Newly opened generic tabs (`^tb\d+$`, numeric indices, `!tab.named`, bare program names) are inspected via `hc get <t> --json` and `hc read <t> --lines 40` (with lock-free `git rev-parse --abbrev-ref HEAD` fallback) to derive concise Jira-key + summary titles via `run("tab.rename")`.
  - User-edited tabs (`tab.named === true` or double-click inline rename setting `manualTitle: true`) are never overwritten automatically.
- **Session-Scoped Multi-Repo Discovery & Bus Sharing:**
  - `files-search` discovers repositories under `space.folder` (plus sibling repos and active-tab pane `cwd`s), runs `git status --untracked-files=normal`, attributes repositories modified/visited by that tab's agent session in `mesh.flows[tabId].sessionRepos`, and publishes `mesh.services` with a `sig` change key.
  - `changes-review` consumes fresh `mesh.services` entries (`BUS_MAX_AGE_MS = 90000`) and wakes only when `bus.sig` changes, eliminating duplicate polling and Windows PowerShell storms.
- **Space Panel Memory & Pure Render Frames:**
  - `mesh-tabs` stores each space's open panel choice in `shared("mesh.spacePanels")` (zero `localStorage`) using deferred `cx.timer.after(0, ...)` syncs so `render()` stays pure across all mods.
- **Microservice Review, Checks & Lead Agent Targeting:**
  - Adding inline diff notes marks `reviewedServices[serviceId]` as `"has_notes"`; clicking `Approve Service ✓` marks it `"approved"` and advances `mesh.activeService` to the next unreviewed dirty microservice.
  - `changes-review` resolves `findActiveAgent()` with `mesh.flows[tabId].leadTerminal` first, and executes Windows `.cmd` shims (`npm`/`pnpm`/`yarn`/`npx`/`bun`/`ng`/`mvnw`/`gradlew`) or chained checks via `cmd /c` on Windows and `sh -c` on POSIX.
- **Global Search Everywhere:**
  - `Ctrl+P`, `Alt+F`, or double-tapping `Shift` in `#files` opens `files-search-win`; `Tab` / `Shift+Tab` cycles `All`, `Files`, and `Text`, and `Enter` expands the target file path in the tree.

## Built from

- **Layout Definition (`layouts/mesh.json`):**
  - `#sidebar` (`brand`, `spaces`, `agents`, `sidebar-footer`) + `#work` (`#tabs` `42px` → `#work-body` [`#main` + collapsible `#panel` → `#panel-body` stack with `#files`, `#changes`] → `#status` `28px`).
- **4 Active Extension Mods (`mods/`):**
  - `mods/files-search/main.js` & `mod.json`: Docked session-scoped multi-repo file tree + `files-search-win` Search Everywhere overlay.
  - `mods/changes-review/main.js` & `mod.json`: Per-service branch diffs, inline notes, `reviewedServices` checklist, `Checks` runner, and `leadTerminal` dispatch.
  - `mods/mesh-tabs/main.js` & `mod.json`: Tab strip, organic auto-naming, double-click inline rename, 2-panel toggles (`Files`, `Review`), and `mesh.spacePanels`.
  - `mods/mesh-status/main.js` & `mod.json`: `#status` bar telemetry for machine, service/dirty counts, active branch, agents, and command palette trigger.
- **Keybindings (`keys.json`):**
  - Global bindings: `"ctrl-p": "mod.open:files-search"` and `"alt-f": "mod.open:files-search"`.
- **Herdr APIs Used:**
  - `spaces()`, `panes()`, `focused()`, `agents()`, `terminals()`, `exec()`, `hc()`, `run()`, `readTextFile()`, `watchFolder()`, `theme()`, `settings()`, `layout()`, `shared()`, `setShared()`, `props()`, `notify()`, `openOverlay()`, `closeOverlay()`, `window()`, `keys()`.

## Shared state bus

All cross-mod communication flows strictly through Herdr's persisted reactive bus (`shared()` / `setShared()`):

| Bus Key | Producer(s) | Consumer(s) | Contract / Purpose |
|---|---|---|---|
| `mesh.services` | `files-search`, `changes-review` | `files-search`, `changes-review`, `mesh-status` | `{ tabId, workspaceRoot, on, services, candidates, sig, ts }` — emitted on topology/branch/dirty `sig` change or heartbeat. |
| `mesh.activeService` | `changes-review`, `files-search` | `changes-review`, `files-search` | `{ workspaceRoot, serviceId, ts }` — monotonic timestamp-gated service filter (`"all"` or `serviceId`). |
| `mesh.flows` | `mesh-tabs`, `changes-review` | `mesh-tabs`, `changes-review`, `files-search` | `Record<tabId, { tabId?, ticket?, derivedTitle?, autoNamed?, manualTitle?, leadTerminal?, reviewedServices?, sessionRepos?, updatedAt }>`. |
| `mesh.spacePanels` | `mesh-tabs` | `mesh-tabs` | `Record<spaceId, "files" \| "changes" \| null>` — zero-`localStorage` per-space drawer memory. |
| `files-search.select` | `files-search` | `files-search` | `{ root, path, line, ts }` — expands and highlights matched file in tree. |
| `files-search.customSize` | `files-search` | `files-search` | `{ w, h }` — persists custom Search Everywhere dialog dimensions. |
| `changes-review.focus` | `changes-review` | `changes-review` | `{ path, line? }` — jumps to a line in the diff viewer. |

## Watch out

- **Shipped Layout & Core Mod Immutability:**
  Herdr's built-in layouts (`main.json`, `terminals.json`, `win98.json`) and core mods are read-only and restored automatically. Customizations live exclusively in `layouts/mesh.json` and the `mods/*` directories.
- **Lock-Free Git Invariant:**
  Every read-only Git invocation (`rev-parse`, `status`, `diff`, `ls-files`, `log`, `grep`, `for-each-ref`, `rev-list`) MUST include:
  ```bash
  --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false
  ```
  Omitting these flags risks `.git/index.lock` contention with coding agents and triggers watch loops.
- **Zero `localStorage`, Zero Browser DOM & Pure Render:**
  Mods run in GPUI's embedded QuickJS host (`gpui-shell 0.7.x`) using `gpui-kit` and `gpui-base` builders (`div()`, `h_flex()`, `v_flex()`, `svg()`, `list()`). `localStorage`, DOM APIs, `.font_mono()`, and synchronous `cx.notify()` / `setShared()` inside `render()` do not belong in any mod.
- **Stack Child ID Preservation:**
  `#panel-body` must remain `type: "stack"` with child IDs `"files"` and `"changes"`, and `#brand` / `#tabs` must retain `"window_drag": true`.
- **Dynamic Theme Color Inheritance:**
  Never hardcode hex color literals; derive all surface, border, diff, and alert colors dynamically from `theme()`, `settings().colors`, and `layout().colors`.
- **GPUI Mouse Tracking Buffer:**
  Fast corner-grip resizing on `files-search-win` relies on `#resize-card-cover` to retain continuous `mouse_move` and `mouse_up` events above terminal panes.

## Done when

1. All mods pass Herdr component materialization checks:
   ```bash
   for d in mods/*/; do herdr-app check "$d" || exit 1; done
   ```
2. All mod entrypoints pass `node --check mods/*/main.js`, and `layouts/mesh.json` and `keys.json` parse as valid JSON.
3. `rg -n "localStorage|\.key\(" mods/*/main.js` returns zero matches, and all read-only Git queries include lock-free flags.
4. Launching Herdr with `layouts/mesh.json` mounts `#sidebar`, `#tabs` (`mesh-tabs`), `#main`, `#panel-body` (`files`, `changes`), and `#status` (`mesh-status`).
5. Opening an agent tab auto-derives a concise Jira/prompt/branch title without overwriting manual renames, and space panels persist in `mesh.spacePanels`.
6. In `files-search` and `changes-review`, only session-attributed touched repositories render, `Approve Service ✓` progresses across dirty services, and `Checks` / inline review notes dispatch directly to `leadTerminal`.
