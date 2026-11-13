---
id: module-mods
type: module-design
status: active
title: Herdr Mesh Mods Suite
parent: architecture
references: [module-layouts, spec-lifecycle]
covers: [gpui-kit-views, mod-manifests, shared-state-contracts, agent-ide-lifecycle, zero-localstorage, zero-repo-pollution]
tags: [mods, gpui-kit, herdr, lifecycle]
---

## Responsibility

The `module-mods` encapsulates the suite of interactive GPUI extensions operating within the Herdr desktop application runtime (`gpui-shell 0.7.x`). Together with `[[module-layouts]]` and `[[spec-lifecycle]]`, the mods suite transforms Herdr's terminal workspace into a complete multi-microservice Agent IDE: organic tab auto-naming (`mesh-tabs`), tab-scoped 6-stage pipeline orchestration (`mesh-flow`), workspace-wide navigation (`files-search`), microservice-by-microservice review and repo checks (`changes-review`), zero-pollution live testing and Playwright E2E visualization (`mesh-test`), templated GitHub PR promotion (`mesh-ship`), and bottom lifecycle telemetry (`mesh-status`).

Mods run as QuickJS JavaScript modules utilizing `gpui-kit` and `gpui-base` declarative components and interface with Herdr's native Rust core via the `herdr` host module.

## Boundary

- **Owns:**
  - Mod packages under `mods/*`.
  - Manifest definitions (`mod.json`) and mod registration schemas.
  - Mod view components implemented in `main.js`.
  - Shared state event namespaces (`mesh.*`, `files-search.*`, `changes-review.*`) and cross-mod protocol contracts.
- **Public surface:**
  - Mod directories installed into `$HERDR_APP_HOME/mods/`:
    - `mods/files-search`: Docked multi-repo file tree and floating Search Everywhere overlay.
    - `mods/changes-review`: Per-service Git branch/diff inspector, tab-scoped review checklist (`Approve Service ✓`), `Checks` runner, and `leadTerminal`-prioritized agent dispatch.
    - `mods/mesh-tabs`: Workspace tab strip with organic Jira/prompt auto-naming, 1-click inline rename, 4-panel drawer toggles, and `mesh.spacePanels` persistence.
    - `mods/mesh-flow`: 38px tab-scoped 6-stage pipeline bar (`plan`, `build`, `review`, `test`, `pr_dev`, `promote`), `Auto` re-sync, and `leadTerminal` targeting.
    - `mods/mesh-test`: Zero-pollution test plan lifecycle, `watchFolder` + live polling, `ss -tln` TCP port detection, `+ Service Runner` split panes, manual `curl` re-run, and Playwright PNG `image()` + click-to-zoom viewer.
    - `mods/mesh-ship`: Configurable branch promotion chain (`["development", "ci", "main"]`), shared PR template (`{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, `{{testSummary}}`), live `gh` PR/CI/review monitoring, and single/batch promotion.
    - `mods/mesh-status`: Bottom status bar displaying active stage, service/dirty counts, `mesh.testAlert`, PR alerts, and agent activity.
  - Mod command endpoints:
    - `mod.open:files-search` (bound to `Ctrl+P` / `Alt+F`).
    - `layout.select --stack panel-body --child files|changes|test|ship`.
    - Screenshot zoom overlay via `openOverlay({ mod: "mesh-test", kind: "dialog", ... })`.
  - Reactive shared state channels:
    - `files-search.select`, `files-search.customSize`
    - `changes-review.focus`
    - `mesh.services`, `mesh.activeService`, `mesh.flows`, `mesh.pipelineConfig`, `mesh.spacePanels`, `mesh.testAlert`
- **Allowed deps:**
  - `gpui-kit` primitives: `View`, `div`, `svg`, `image`, `list`.
  - `gpui-base` widgets: `v_flex`, `h_flex`, `Input`, `InputState`, `Textarea`, `TextareaState`, `Scrollbar`, `ScrollHandle`.
  - `herdr` host APIs: `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `appHome`, `theme`, `settings`, `notify`, `hc`, `run`, `layout`, `shared`, `setShared`, `props`, `openOverlay`, `closeOverlay`, `window`, `keys`.
- **Forbidden:**
  - Any usage of browser `localStorage` across `herdr-mesh` mods (persist via `shared()`/`setShared()` or `${appHome()}/mesh/`).
  - Writing test plans, E2E scripts, or screenshots inside microservice Git repositories (`space.folder`).
  - Spawning blocking synchronous loops in the JS thread or uncancelled `rg` / `exec` polling loops.
  - Invoking read-only Git operations without lock-free flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
  - Hardcoded color hex strings ignoring `theme()`, `settings()`, or `layout()`.

## Internal & Planned Submodules

| Submodule | Owns | Status / Spec |
| :--- | :--- | :--- |
| `submodule-mod-files-search` | Dual-mode file tree panel and floating Search Everywhere overlay (`files-search-win`) with ripgrep live search and shared file selection | Active (`[[submodule-mod-files-search]]`) |
| `submodule-mod-changes-review` | Multi-repo Git diff viewer, per-service branch/checklist (`Approve Service ✓`), repo standard `Checks`, inline notes, and `leadTerminal` dispatch | Active (`[[submodule-mod-changes-review]]`, extended by `[[spec-lifecycle]]`) |
| `submodule-mod-mesh-tabs` | Tab strip, generic-name detection, Jira/prompt/branch auto-naming, 1-click inline rename, panel toggles, and `mesh.spacePanels` sync | Specified in `[[spec-lifecycle]]` (`[[submodule-mod-mesh-tabs]]`) |
| `submodule-mod-mesh-flow` | 38px `#flow` bar, 6-stage tab-scoped pipeline, `Auto` re-sync trigger, stage-to-panel coupling, and `leadTerminal` resolution | Specified in `[[spec-lifecycle]]` (`[[submodule-mod-mesh-flow]]`) |
| `submodule-mod-mesh-test` | Zero-pollution test plans (`${appHome()}/mesh/...`), `watchFolder` + live polling, `ss -tln` port probes, `+ Service Runner` splits, `image()` E2E PNGs + zoom overlay, `Send Failures to Agent` | Specified in `[[spec-lifecycle]]` (`[[submodule-mod-mesh-test]]`) |
| `submodule-mod-mesh-ship` | Configurable promotion chain (`development → ci → main`), per-repo overrides, PR template interpolation, live `gh` PR/CI/review threads, `Send Review Comments to Agent`, batch promote | Specified in `[[spec-lifecycle]]` (`[[submodule-mod-mesh-ship]]`) |
| `submodule-mod-mesh-status` | 28px `#status` telemetry bar rendering machine, service/dirty count, active stage, `mesh.testAlert`, PR alerts, and palette hint | Specified in `[[spec-lifecycle]]` (`[[submodule-mod-mesh-status]]`) |

## Inter-Mod Communication & Shared State

All mods communicate solely through Herdr's persisted reactive bus (`shared()` / `setShared()`) without cross-mod closure mutation (`[[architecture]]`, `[[spec-lifecycle]]`):

```text
+--------------------+     mesh.flows[tabId]      +---------------------+
| mesh-tabs /        | -------------------------> | changes-review      |
| mesh-flow (#flow)  |   stage, leadTerminal,     | mesh-test           |
|                    |   reviewedServices, ticket | mesh-ship           |
+--------------------+                            +---------------------+
         ^                                                  |
         | mesh.spacePanels (zero localStorage)             | mesh.testAlert
         v                                                  v
+--------------------+     mesh.services /        +---------------------+
| layouts/mesh.json  |     mesh.activeService     | mesh-status         |
| (#panel-body)      | <------------------------> | (#status 28px)      |
+--------------------+                            +---------------------+
```

### Bus Channels Summary

- **`files-search.select` & `files-search.customSize`**: File jump coordination `{ root, path, line, ts }` and overlay geometry persistence `{ w, h }`.
- **`changes-review.focus`**: Diff viewer line navigation `{ path, line? }`.
- **`mesh.services` & `mesh.activeService`**: Discovered microservice repository list (published on topology signature change) and synchronized active filter (`"all"` or `serviceId` with monotonic `ts`).
- **`mesh.flows`**: Tab-scoped lifecycle state keyed by `tabId` holding `stage` (`plan | build | review | test | pr_dev | promote`), `ticket`, `derivedTitle`, `manualTitle`, `leadTerminal`, `reviewedServices` (`pending | has_notes | approved`), `testPlanPath`, and `prs` metadata.
- **`mesh.pipelineConfig`**: Workspace promotion chain (default `["development", "ci", "main"]`), optional per-repo overrides, PR template string (`{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, `{{testSummary}}`) backed by `${appHome()}/mesh/pr-template.md`, and Playwright browser mode (`headless | headed`).
- **`mesh.spacePanels`**: Persisted `Record<spaceId, "files" | "changes" | "test" | "ship" | null>` replacing `localStorage` in `mesh-tabs`.
- **`mesh.testAlert`**: Active tab's live test status (`plan_ready | running | passed | failed`, counts, summary, `ts`) emitted by `mesh-test` and surfaced in `mesh-status` and `mesh-flow`.

### Zero-Pollution Storage & Agent Dispatch

- **Runtime Artifacts under `appHome()`:** Test plans (`${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json`), Playwright screenshots (`.../screenshots/<tabId>/<case>.png` rendered via GPUI `image(absPath)`), and PR templates (`${appHome()}/mesh/pr-template.md`) remain strictly isolated from microservice working trees.
- **Lead Agent Priority (`hc send`):** `changes-review`, `mesh-test`, and `mesh-ship` target `mesh.flows[tabId].leadTerminal` first via `await hc(["send", agentAddress, message])` so auxiliary `+ Service Runner` split panes never intercept agent prompts; failures surface via `notify()`.
