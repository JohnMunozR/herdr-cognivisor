# mesh

A unified **Multi-Microservice Agent IDE** layout recipe and 7-mod distribution package for the Herdr desktop app. It bundles `layouts/mesh.json`, all 7 lifecycle mods (`files-search`, `changes-review`, `mesh-tabs`, `mesh-flow`, `mesh-test`, `mesh-ship`, `mesh-status`), and global keyboard shortcuts (`keys.json`) into a cohesive, terminal-first developer workspace covering the complete 6-stage engineering pipeline (`Plan → Build → Review → Test → PR → dev → CI → main`).

## What you see

- **Left Navigation Sidebar (`#sidebar`, `268px`):**
  - `#brand` (`46px`, `workspace-chrome`, `window_drag: true`), `#spaces`, `#agents`, and `#sidebar-footer` (`69px`, `workspace-chrome`).
  - Displays active workspace spaces, remote SSH hosts, running AI coding agents, and layout preferences.
- **Header & Organic Workspace Tabs Bar (`#tabs`, `42px`, `mod: "mesh-tabs"`, `window_drag: true`):**
  - Renders workspace tabs with agent/program icons, concise auto-derived or user-edited titles, stage mini-badges (`Plan`, `Build`, `Rev`, `Test`, `PR`, `CI`), live activity spinners/dots, `+` new-tab menu, 4 drawer toggle buttons (`Files`, `Review`, `Test`, `Ship`), and platform window controls.
- **Tab-Scoped 6-Stage Pipeline Bar (`#flow`, `38px`, `mod: "mesh-flow"`):**
  - Mounted directly above `#work-body` inside `#work`.
  - Left zone: Jira ticket badge (`[A-Z][A-Z0-9]{1,9}-\d+`), 1-click inline editable title, and `Auto` re-sync button.
  - Center zone: Interactive 6-stage stepper (`1. Plan` → `2. Build` → `3. Review` → `4. Test` → `5. PR → dev` → `6. CI → main`).
  - Right zone: Live `mesh.testAlert` pill, subagent counter (`N sub`), `leadTerminal` badge, and `+ Shell` microservice split-pane launcher overlay.
- **Main Agent & Runner Terminal Area (`#main`):**
  - Primary execution pane (`tab: "active"`, `pane` header `30px`, `lone: true`, `radius: 10`) hosting AI coding agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`) alongside optional `+ Shell` / `+ Service Runner` split panes (`meshRunner=true`) managed by `herdr-core` (`hc`).
- **Collapsible 4-Panel Stack (`#panel`, `420px` [300–960], `hidden: true` by default / `#panel-body` stack):**
  - **`#files` (`files-search`):** Docked multi-repo file tree with folder modification badges, `repo` markers, synchronized service filter pills, and the floating **Search Everywhere** modal (`files-search-win`) with `All` / `Files` / `Text` tabs, ripgrep streaming, live code preview, and corner resize grip.
  - **`#changes` (`changes-review`):** Per-service Git branch pills, working-tree/commit diff viewer in JetBrains Mono (`11px`), `Expand context` (`git diff -U99999`), inline comment cards, per-tab `reviewedServices` checklist (`Approve Service ✓`), repository standards `Checks` drawer (`AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, `Makefile`), `→ Go to Test` transition, and `leadTerminal`-prioritized feedback / multi-repo commit footer.
  - **`#test` (`mesh-test`):** Zero-pollution test orchestrator (`Ask Agent for Test Plan`, `Approve Plan`, `Send Failures to Agent`, `Scan Terminal Curls`), `Headless | Headed` browser toggle, local TCP port probes (`ss -tln`), `+ Runner` service split panes, live `curl` and Playwright `e2e` case rows, and inline PNG thumbnails via GPUI `image(absPath)` with click-to-zoom modal overlay (`openOverlay`).
  - **`#ship` (`mesh-ship`):** Configurable workspace promotion chain (default `["development", "ci", "main"]`) with per-repo overrides, shared PR template editor (`{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, `{{testSummary}}` mirrored to `${appHome()}/mesh/pr-template.md`), stage switcher, live `gh` PR/CI/review-thread cards, `Ask Agent to Create PRs`, `Send Review Comments to Agent`, and single/batch promotion actions.
- **Lifecycle Telemetry Status Bar (`#status`, `28px`, `mod: "mesh-status"`):**
  - Displays active host (`This computer` / SSH machine), multi-service & dirty counts (`N services · M dirty`), active branch, active tab pipeline stage, clickable `mesh.testAlert` pill (`→ #test`), clickable PR/CI/review alert pill (`→ #ship`), live agent counter (`N agents · M needs you`), and `app.palette` shortcut hint.

## How it behaves

- **Organic Tab Auto-Naming & Manual Protection:**
  - Newly opened generic tabs (`^tb\d+$`, numeric indices, `!tab.named`, bare program names) are inspected via `hc get <t> --json` and `hc read <t> --lines 40` (with lock-free `git rev-parse --abbrev-ref HEAD` fallback) to derive concise Jira-key + summary titles via `run("tab.rename")`.
  - User-edited tabs (`tab.named === true` or double-click / 1-click inline rename setting `manualTitle: true`) are never overwritten automatically; clicking `Auto` in `#flow` recomputes the name on demand.
- **Six-Stage Pipeline & Space Panel Sync:**
  - Selecting `3. Review`, `4. Test`, or `5. PR → dev` / `6. CI → main` in `#flow` updates `mesh.flows[tabId].stage` and opens `#panel-body` to `changes`, `test`, or `ship` automatically.
  - `mesh-tabs` stores each space's open panel choice in `shared("mesh.spacePanels")` (zero `localStorage`) so switching spaces restores `#panel` cleanly.
- **Microservice Review, Checks & Lead Agent Targeting:**
  - Adding inline diff notes marks `reviewedServices[serviceId]` as `"has_notes"`; clicking `Approve Service ✓` marks it `"approved"` and advances `mesh.activeService` to the next unreviewed dirty microservice.
  - `changes-review`, `mesh-test`, and `mesh-ship` resolve `findActiveAgent()` with `mesh.flows[tabId].leadTerminal` first so auxiliary `+ Shell` / `+ Runner` split panes never intercept agent prompts.
- **Zero-Pollution Testing & Playwright E2E:**
  - `Ask Agent for Test Plan` sends the exact `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json` path, `screenshots/<tabId>/` directory, browser mode, and schema to `leadTerminal`.
  - `Approve Plan` performs an optimistic compare-and-swap `writeTextFile` flip (`approved: true`) and instructs the agent to start services and execute tests while `watchFolder` + `1500ms` visible-only polling renders live `curl` metrics and `image()` Playwright PNGs.
- **Templated PRs & Multi-Service GitHub Promotion:**
  - Rendered PR templates inject identical `{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, and `{{testSummary}}` payloads into both direct `gh pr create` commands and `Ask Agent to Create PRs` prompts.
  - Live `gh pr list` + GraphQL `reviewThreads` (with REST fallback) monitor CI `statusCheckRollup` and unresolved comments across services, dispatching unresolved threads to `leadTerminal` on click.
- **Global Search Everywhere:**
  - `Ctrl+P`, `Alt+F`, or double-tapping `Shift` in `#files` opens `files-search-win`; `Tab` / `Shift+Tab` cycles `All`, `Files`, and `Text`, and `Enter` expands the target file path in the tree.

## Built from

- **Layout Definition (`layouts/mesh.json`):**
  - `#sidebar` (`brand`, `spaces`, `agents`, `sidebar-footer`) + `#work` (`#tabs` `42px` → `#flow` `38px` → `#work-body` [`#main` + collapsible `#panel` → `#panel-body` stack with `#files`, `#changes`, `#test`, `#ship`] → `#status` `28px`).
- **7 Extension Mods (`mods/`):**
  - `mods/files-search/main.js` & `mod.json`: Docked multi-repo file tree + `files-search-win` Search Everywhere overlay.
  - `mods/changes-review/main.js` & `mod.json`: Per-service branch diffs, inline notes, `reviewedServices` checklist, `Checks` runner, and `leadTerminal` dispatch.
  - `mods/mesh-tabs/main.js` & `mod.json`: Tab strip, organic auto-naming, double-click inline rename, 4-panel toggles, and `mesh.spacePanels`.
  - `mods/mesh-flow/main.js` & `mod.json`: `#flow` 6-stage pipeline stepper, 1-click inline rename, `Auto` re-sync, `leadTerminal` pinning, and `+ Shell` `openOverlay` popup.
  - `mods/mesh-test/main.js` & `mod.json`: Zero-pollution test plan lifecycle, `watchFolder` + visible polling, `ss -tln` probes, `+ Runner` splits, `curl` runner, and Playwright PNG `image()` + zoom dialog.
  - `mods/mesh-ship/main.js` & `mod.json`: Configurable branch promotion chain, `${appHome()}/mesh/pr-template.md` sync, live `gh` PR/CI/review monitoring, and single/batch promotion.
  - `mods/mesh-status/main.js` & `mod.json`: `#status` bar telemetry for machine, service/dirty counts, active stage, `mesh.testAlert`, PR alerts, agents, and command palette trigger.
- **Keybindings (`keys.json`):**
  - Global bindings: `"ctrl-p": "mod.open:files-search"` and `"alt-f": "mod.open:files-search"`.
- **Herdr APIs Used:**
  - `spaces()`, `panes()`, `focused()`, `agents()`, `terminals()`, `exec()`, `hc()`, `run()`, `readTextFile()`, `writeTextFile()`, `watchFolder()`, `appHome()`, `theme()`, `settings()`, `layout()`, `shared()`, `setShared()`, `props()`, `notify()`, `openOverlay()`, `closeOverlay()`, `window()`, `keys()`.

## Shared state bus

All cross-mod communication flows strictly through Herdr's persisted reactive bus (`shared()` / `setShared()`):

| Bus Key | Producer(s) | Consumer(s) | Contract / Purpose |
|---|---|---|---|
| `mesh.services` | `changes-review`, `files-search` | All 7 mesh mods | `{ workspaceRoot, on, services: [{ id, name, relPath, root, branch? }], ts }` — emitted on root/branch topology signature change. |
| `mesh.activeService` | `changes-review`, `files-search`, `mesh-ship` | `changes-review`, `files-search`, `mesh-test`, `mesh-ship`, `mesh-status` | `{ workspaceRoot, serviceId, ts }` — monotonic timestamp-gated service filter (`"all"` or `serviceId`). |
| `mesh.flows` | `mesh-flow`, `mesh-tabs`, `changes-review`, `mesh-test`, `mesh-ship` | All lifecycle mods | `Record<tabId, { tabId, workspaceRoot, stage, shipPhase?, ticket, derivedTitle, autoNamed?, manualTitle, leadTerminal, reviewedServices, testPlanPath?, prs?, updatedAt }>`. |
| `mesh.pipelineConfig` | `mesh-ship`, `mesh-test` | `mesh-ship`, `mesh-test` | `{ defaultChain, defaultPrTemplate, workspaces: { [root]: { chain, repoOverrides?, prTemplate, prTemplatePath, browserMode, updatedAt } } }`. |
| `mesh.spacePanels` | `mesh-tabs` | `mesh-tabs` | `Record<spaceId, "files" \| "changes" \| "test" \| "ship" \| null>` — zero-`localStorage` per-space drawer memory. |
| `mesh.testAlert` | `mesh-test` | `mesh-status`, `mesh-flow`, `mesh-ship` | `{ tabId, workspaceRoot, status: "plan_ready" \| "running" \| "passed" \| "failed", total, passed, failed, running, summary?, ts }`. |
| `files-search.select` | `files-search` | `files-search` | `{ root, path, line, ts }` — expands and highlights matched file in tree. |
| `files-search.customSize` | `files-search` | `files-search` | `{ w, h }` — persists custom Search Everywhere dialog dimensions. |
| `changes-review.focus` | `changes-review` | `changes-review` | `{ path, line? }` — jumps to a line in the diff viewer. |

## Watch out

- **Shipped Layout & Core Mod Immutability:**
  Herdr's built-in layouts (`main.json`, `terminals.json`, `win98.json`) and core mods are read-only and restored automatically. Customizations live exclusively in `layouts/mesh.json` and the 7 `mods/*` directories.
- **Lock-Free Git Invariant:**
  Every read-only Git invocation (`rev-parse`, `status`, `diff`, `ls-files`, `log`, `grep`, `rev-list`, `branch`) MUST include:
  ```bash
  --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false
  ```
  Omitting these flags risks `.git/index.lock` contention with coding agents and triggers watch loops.
- **Zero `localStorage` & Zero Browser DOM:**
  Mods run in GPUI's embedded QuickJS host (`gpui-shell 0.7.x`) using `gpui-kit` and `gpui-base` builders (`div()`, `h_flex()`, `v_flex()`, `image()`, `svg()`, `list()`). `localStorage`, DOM APIs, and `.font_mono()` do not belong in any mod.
- **Zero Repository Pollution:**
  Runtime test plans (`test-plans/<tabId>.json`), Playwright PNGs (`screenshots/<tabId>/`), and `pr-template.md` MUST be written exclusively under `${appHome()}/mesh/`, never inside microservice working trees.
- **Safe `image()` Materialization & Optimistic CAS Writes:**
  Verify `exists(absPath)` before calling GPUI `image(absPath)`, and use compare-and-swap `writeTextFile(path, nextJson, expectedText)` when mutating test plans so agent updates are never clobbered.
- **Lead Agent Preservation & Runner Isolation:**
  Auxiliary service terminals spawned via `+ Shell` or `+ Runner` MUST carry `--label meshRunner=true` and must never replace `mesh.flows[tabId].leadTerminal`.
- **Stack Child ID Preservation & Top-Level Overlays:**
  `#panel-body` must remain `type: "stack"` with child IDs `"files"`, `"changes"`, `"test"`, and `"ship"`, and `#brand` / `#tabs` must retain `"window_drag": true`. Floating menus from fixed-height bars (such as `#flow`'s `+ Shell` menu) must open via `openOverlay()`.
- **Dynamic Theme Color Inheritance:**
  Never hardcode hex color literals; derive all surface, border, diff, and alert colors dynamically from `theme()`, `settings().colors`, and `layout().colors`.
- **GPUI Mouse Tracking Buffer:**
  Fast corner-grip resizing on `files-search-win` relies on `#resize-card-cover` to retain continuous `mouse_move` and `mouse_up` events above terminal panes.

## Done when

1. All 7 mods pass Herdr component materialization checks:
   ```bash
   for m in files-search changes-review mesh-tabs mesh-flow mesh-test mesh-ship mesh-status; do
     herdr-app check "mods/$m" || exit 1
   done
   ```
2. All mod entrypoints pass `node --check mods/*/main.js`, and `layouts/mesh.json` and `keys.json` parse as valid JSON.
3. `rg -n "localStorage" mods/*/main.js` returns zero matches, and all read-only Git queries include lock-free flags.
4. Launching Herdr with `layouts/mesh.json` mounts `#sidebar`, `#tabs` (`mesh-tabs`), `#flow` (`mesh-flow`), `#main`, `#panel-body` (`files`, `changes`, `test`, `ship`), and `#status` (`mesh-status`).
5. Opening an agent tab auto-derives a concise Jira/prompt/branch title without overwriting manual renames, and `Auto` in `#flow` re-syncs on demand.
6. Selecting stages in `#flow` updates `mesh.flows[tabId].stage` and switches `#panel-body` cleanly (`review -> changes`, `test -> test`, `pr_dev`/`promote -> ship`), persisted per space in `mesh.spacePanels`.
7. In `changes-review`, per-service branches, `Approve Service ✓` checklist progression, `Checks` execution, and inline notes dispatch directly to `leadTerminal`.
8. In `mesh-test`, test plans and Playwright PNGs write strictly under `${appHome()}/mesh/`, update live via `watchFolder`, probe ports via `ss -tln`, render inline `image()` thumbnails with click-to-zoom, and send failures to `leadTerminal`.
9. In `mesh-ship`, configurable promotion chains and `${appHome()}/mesh/pr-template.md` inject identical bodies into `gh pr create` and `Ask Agent to Create PRs`, while live `gh` CI/review-thread monitoring and `Send Review Comments to Agent` target `leadTerminal`.
