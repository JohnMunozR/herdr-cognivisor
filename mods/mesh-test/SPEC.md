---
id: submodule-mod-mesh-test
type: submodule-design
status: active
title: Mesh Test & E2E Runner Mod (mods/mesh-test)
parent: module-mods
references: [module-layouts, submodule-mod-mesh-flow, submodule-mod-mesh-status]
covers: [zero-pollution-test-plans, live-agent-test-status, plan-approval-gate, local-service-runners, port-probing, curl-execution, playwright-e2e-screenshots]
tags: [mod, testing, curl, playwright, e2e, screenshots]
---

## Responsibility

The `submodule-mod-mesh-test` implements the live test-plan orchestrator, local microservice runner panel, `curl` executor, and Playwright E2E screenshot viewer docked inside `#test` of `#panel-body` in `layouts/mesh.json` (`[[module-layouts]]`, `[[module-mods]]`, `[[spec-lifecycle]]`). It enables developers and AI agents to design, approve, execute, inspect, and iteratively fix cross-service API (`curl`) and frontend E2E (`playwright`) test suites without polluting any microservice Git repository with untracked test plans or screenshot files.

## Boundary

- **Owns:**
  - Manifest file: `mods/mesh-test/mod.json` (`{ "place": "none", "title": "Mesh Test" }`).
  - Main GPUI component and screenshot zoom modal view: `mods/mesh-test/main.js` (`MeshTest` extending `View`).
  - Self-contained icon assets under `mods/mesh-test/icons/*.svg` (`play.svg`, `check.svg`, `x.svg`, `spinner.svg`, `terminal.svg`, `bot.svg`, `send.svg`, `refresh.svg`, `camera.svg`, `close.svg`, `globe.svg`).
- **Public surface:**
  - Registered mod identifier: `mesh-test`.
  - Layout slot: `#panel-body` child `test` in `layouts/mesh.json`.
  - Zoom modal overlay role: `openOverlay({ mod: "mesh-test", kind: "dialog", width: 920, height: 680, props: { zoomImage, title, summary, ... } })`.
  - Shared state bus interactions:
    - Reads `mesh.services`, `mesh.flows`, `mesh.pipelineConfig`, and `mesh.activeService`.
    - Publishes `mesh.testAlert` (`{ tabId, workspaceRoot, status, total, passed, failed, running, summary, ts }`) strictly when the status signature changes (`${tabId}|${status}|${total}|${passed}|${failed}|${running}`).
    - Updates `mesh.pipelineConfig.workspaces[workspaceRoot].browserMode` (`"headless" | "headed"`) on user toggle while preserving sibling pipeline fields.
    - Updates `mesh.flows[tabId].testPlanPath` when requesting, approving, or scanning test plans while preserving sibling tab flow state.
  - Zero-pollution storage surface:
    - Test plan JSON: `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json` (with read-only legacy fallback at `<workspaceRoot>/.herdr/test-plans/<tabId>.json`).
    - Screenshots directory: `${appHome()}/mesh/workspaces/<workspaceHash>/screenshots/<tabId>/`.
  - Host IPC and subprocess surface:
    - `hc(["send", agentAddress, prompt])` for test-plan generation, approval execution handoff, and failure-fix dispatch targeting `leadTerminal`.
    - `hc(["read", "--lines", "120", agentAddress])` for fallback `Scan Terminal Curls` discovery.
    - `hc(["run", "--bg", "--keep", ..., "--label", "meshRunner=true", ...])` for spawning `+ Runner` service shells in the active tab without hijacking `leadTerminal`.
    - `exec("ss", ["-tln"], { on, timeout: 5000 })` (with `lsof` fallback) for throttled (`>= 3000ms`) TCP port probing.
    - `exec("sh", ["-c", ...], { cwd, on, timeout: 30000 })` for individual `curl` case execution.
    - `watchFolder(plansDir)` + visible-only `1500ms` fallback polling and optimistic compare-and-swap `writeTextFile(planPath, nextJson, expectedText)`.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`, `image`.
  - `gpui-base`: `h_flex`, `v_flex`, `ScrollHandle`.
  - `herdr`: `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `hc`, `appHome`, `readTextFile`, `writeTextFile`, `watchFolder`, `theme`, `settings`, `notify`, `layout`, `shared`, `setShared`, `props`, `openOverlay`, `closeOverlay`, `window`.
  - Runtime built-ins: `"fs/promises"` (`mkdir`, `exists`), `"path"` (`join`, `dirname`, `basename`).
- **Forbidden:**
  - Any usage of browser `localStorage` or DOM globals.
  - Writing test plan JSONs, E2E scripts, or screenshots inside microservice Git repositories (`space.folder` or `workspaceRoot`).
  - Calling `image(absPath)` without verifying file existence via `exists(absPath)` first.
  - Mutating `setShared(...)` inside `render()` or emitting redundant `mesh.testAlert` updates when the signature has not changed.
  - Allowing `+ Runner` split panes (`meshRunner=true`) to overwrite `leadTerminal`.
  - Hardcoded color hex literals ignoring `theme()`.

## Architecture & Interaction Flow

```text
+------------------------------------------------------------------------------------------------------+
| #test (mesh-test)                                                                                    |
+------------------------------------------------------------------------------------------------------+
| Header: Tests [Needs Approval / Approved]   [Headless | Headed]   [Refresh]                          |
| Plan Title · 2 passed · 1 failed · 1 running / 5 · Lead: claude (t1)                                |
+------------------------------------------------------------------------------------------------------+
| Actions: [Ask Agent for Test Plan]  [Approve Plan]  [Send Failures to Agent]  [Scan Terminal Curls]  |
+------------------------------------------------------------------------------------------------------+
| Services & Ports (ss -tln, >=3000ms throttle):                                                       |
|   auth-service   [UP :8081]   [+ Runner]                                                             |
|   web-client     [DOWN :4200] [+ Runner]                                                             |
+------------------------------------------------------------------------------------------------------+
| Test Cases (scroll container):                                                                       |
|   [✓ PASSED] [CURL] [auth-service] POST /api/login                200 · 42ms    [▶ Run]              |
|   [✗ FAILED] [E2E]  [web-client]   Checkout renders receipt       500 · 1.4s                         |
|     Error: Expected HTTP 200, got 500                                                                |
|     [image(absPath) h(96) thumbnail]  ──on_click──▶ openOverlay(mod:"mesh-test", kind:"dialog",      |
|                                                       props:{ zoomImage: absPath })                  |
+------------------------------------------------------------------------------------------------------+
```

### Core Operational Flows

1. **Zero-Pollution Workspace Hashing & Paths:**
   - Normalizes `workspaceRoot` (anchored to `space.folder`, matching `[[submodule-mod-mesh-flow]]`) and computes `workspaceHash = <basename>-<fnv1a8hex>`.
   - Sanitizes `tabId` into a flat filename segment (`safeTabId`) so remote machine-prefixed tab IDs remain flat files inside `test-plans/` without creating nested directories.
   - Resolves primary storage to `${appHome()}/mesh/workspaces/${workspaceHash}/test-plans/${safeTabId}.json` and screenshots to `${appHome()}/mesh/workspaces/${workspaceHash}/screenshots/${safeTabId}/`, ensuring directories exist via `mkdir(..., { recursive: true })` before dispatching prompts or saving plans.
   - Falls back read-only to `<workspaceRoot>/.herdr/test-plans/${safeTabId}.json` when the primary path does not yet exist.

2. **Lead Agent Resolution (`findActiveAgent`) & Plan Prompting:**
   - Resolves the target terminal via strict priority: `mesh.flows[tabId]?.leadTerminal` (matching live `agents()` or `terminals()`) -> focused pane's non-runner agent -> non-runner agent pane in `tabId` -> first non-runner agent in `tabId` -> global `agents()[0]` (never targeting `labels.meshRunner === "true"` terminals).
   - **`Ask Agent for Test Plan`**: Ensures `test-plans/` and `screenshots/<tabId>/` exist, reads discovered services from `mesh.services` and browser mode (`headless | headed`), records `testPlanPath` in `mesh.flows[tabId]`, and sends a structured prompt via `hc send` specifying the exact JSON path, screenshot directory, JSON schema (`title`, `approved: false`, `browserMode`, `servicesToStart[]`, `cases[]`), Playwright requirements, and instruction to wait for approval before running.

3. **Plan Approval Gate (`Approve Plan`) & Optimistic CAS:**
   - Visible whenever a loaded plan has `approved !== true`.
   - Uses `writeTextFile(planPath, nextJson, expectedText)` compare-and-swap (re-reading and merging `approved: true` + `browserMode` on conflict) to flip `approved` atomically without overwriting concurrent agent edits, then sends `"Test plan approved. Please start any required local services and execute the test plan, updating live status and screenshots in <planPath>."` to `leadTerminal` via `hc send`.

4. **Live Folder Watching, Visible Polling Fallback & `mesh.testAlert`:**
   - Continuously watches `${appHome()}/mesh/workspaces/${workspaceHash}/test-plans` via `watchFolder(plansDir)` with a `150ms` coalescing debounce window before reloading `<tabId>.json`.
   - Runs a `1500ms` timer exclusively when `#test` is visible in `layout()` (`!panel.hidden && panel-body.active === "test"`); pauses/cancels automatically when `#test` is hidden.
   - Publishes `setShared("mesh.testAlert", ...)` strictly when `${tabId}|${status}|${total}|${passed}|${failed}|${running}` changes, driving live alert pills in `[[submodule-mod-mesh-flow]]` and `[[submodule-mod-mesh-status]]`.

5. **Port Probing (`ss -tln`) & `+ Runner` Service Splits:**
   - Probes listening TCP ports via `exec("ss", ["-tln"], { on, timeout: 5000 })` with `lsof -nP -iTCP -sTCP:LISTEN` fallback, throttled to `>= 3000ms`, rendering `UP :port` (`t.ansi2`) or `DOWN :port` (`t.dim`).
   - Clicking `+ Runner` executes `hc(["run", "--bg", "--keep", ..., "--label", "herdr.space=...", "--label", "herdr.tab=...", "--label", "meshRunner=true", ...])` (stripping machine prefixes for remote spaces and appending `"bash", "-lc", "${cmd}; exec bash"` when a command is configured), keeping `leadTerminal` untouched.

6. **Direct `curl` Execution, Terminal Curl Scan, E2E Screenshots & Fix Loop:**
   - **`▶ Run`** on any `curl` case transitions the case to `running`, executes `curl` via `exec("sh", ["-c", ...])` capturing HTTP status code and timing (`__HERDR_META__:%{http_code}:%{time_total}`), and writes only that case's updated result back via `writeTextFile` CAS.
   - **`Scan Terminal Curls`** reads the last 120 lines from `leadTerminal` via `hc(["read", "--lines", "120", addr])`, parses ad-hoc `curl` invocations, and merges them into the tab's zero-pollution test plan.
   - **Screenshot Gallery & Zoom Modal**: Verifies every `case.screenshot` / `case.screenshots[]` file with `exists(absPath)` before passing it to `image(absPath)`. Clicking any `h(96)` thumbnail opens `openOverlay({ mod: "mesh-test", kind: "dialog", width: 920, height: 680, props: { zoomImage: absPath, title, summary } })`; inside zoom mode, `Escape` or the Close button invokes `closeOverlay(props().overlay)`.
   - **`Send Failures to Agent`**: Appears whenever `failedCount > 0`, compiling every failed test's name, kind, command, expected vs. actual HTTP code, error, summary, and screenshot paths and sending a fix-and-retest prompt to `leadTerminal`.

## Invariants

1. **Zero Repository Pollution:** Test plan JSON files and Playwright PNG screenshots MUST be written strictly under `${appHome()}/mesh/workspaces/<workspaceHash>/`, never inside microservice working trees.
2. **Safe Image Materialization:** `image(absPath)` MUST NEVER be called unless `exists(absPath)` from `"fs/promises"` has resolved `true`, preventing broken-image host failures.
3. **Optimistic Atomic Plan Mutations:** Plan approval and individual `curl` case updates MUST use `writeTextFile(path, nextText, expectedText)` compare-and-swap with conflict re-read/merge rather than blind overwrites.
4. **Bounded Watching & Throttled Probing:** `watchFolder` targets only the flat `test-plans` folder with `150ms` coalescing, the `1500ms` polling timer runs only while `#test` is visible in `layout()`, `ss -tln` probing is throttled to `>= 3000ms`, and `mesh.testAlert` publishes only on signature change.
5. **Lead Agent Preservation & Zero `localStorage`:** `+ Runner` terminals always carry `meshRunner=true` and never replace `leadTerminal`; no `localStorage` or hardcoded color hex literals ignoring `theme()` are permitted.
