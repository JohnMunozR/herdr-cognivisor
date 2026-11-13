# Tasks: Agent IDE Lifecycle (`agent-ide-lifecycle`)

## Phase 1: Layout & Shared State Bus Foundation

- [x] 1.1 Update `layouts/mesh.json` to mount `#flow` (`38px`, `mod: "mesh-flow"`) inside `#work` directly above `#work-body`, upgrade `#tabs` (`42px`) to `mod: "mesh-tabs"`, expand `#panel-body` stack with `#test` (`mod: "mesh-test"`) and `#ship` (`mod: "mesh-ship"`) alongside `#files` and `#changes`, and upgrade `#status` (`28px`) to `mod: "mesh-status"`.
  - Verify: `node -e 'const l=JSON.parse(require("fs").readFileSync("layouts/mesh.json","utf8")); console.log(JSON.stringify({id:l.id}))'`
- [x] 1.2 Create `mods/mesh-tabs/mod.json` and `mods/mesh-tabs/main.js` cloned from Herdr's `tabs` structure, replacing all `localStorage` panel persistence with `shared("mesh.spacePanels")` / `setShared("mesh.spacePanels", ...)`, enabling panel toggle buttons for `files`, `changes`, `test`, and `ship`, and preserving `window_drag` + traffic lights padding.
  - Verify: `herdr-app check mods/mesh-tabs && node --check mods/mesh-tabs/main.js`
- [x] 1.3 Create `mods/mesh-status/mod.json` and `mods/mesh-status/main.js` to render machine, workspace/service dirty counts, active pipeline stage from `mesh.flows`, live `mesh.testAlert` indicator (click opens `#test`), PR/review alert indicator (click opens `#ship`), agent status counters, and `app.palette` trigger.
  - Verify: `herdr-app check mods/mesh-status && node --check mods/mesh-status/main.js`

## Phase 2: Organic Tab Auto-Naming & Six-Stage Pipeline (`mesh-flow`)

- [x] 2.1 Implement organic tab auto-naming helper shared across `mods/mesh-tabs/main.js` and `mods/mesh-flow/main.js`: detect generic/unnamed tabs (`^tb\d+$`, numeric index, `!tab.named`, bare program title), query `hc get <t> --json` and `hc read <t>` to extract Jira keys (`[A-Z][A-Z0-9]{1,9}-\d+`) and summarize `first_message` (falling back to lock-free `git rev-parse --abbrev-ref HEAD`), and call `run("tab.rename", { id, name })` without overwriting manual user renames.
  - Verify: `node --check mods/mesh-tabs/main.js && node --check mods/mesh-flow/main.js`
- [x] 2.2 Implement 1-click inline rename in `mesh-tabs` (`InputState` on tab) and `mesh-flow` (inline title editor + `manualTitle` flag in `mesh.flows[tabId]`), plus the `Auto` re-sync button in `#flow` to recompute derived tab names on demand.
  - Verify: `herdr-app check mods/mesh-tabs && herdr-app check mods/mesh-flow`
- [x] 2.3 Create `mods/mesh-flow/mod.json` and `mods/mesh-flow/main.js` (`38px` bar) rendering the 6 tab-scoped pipeline stages (`plan` / `1. Plan`, `build` / `2. Build`, `review` / `3. Review`, `test` / `4. Test`, `pr_dev` / `5. PR → dev`, `promote` / `6. CI → main`), persisting `mesh.flows[tabId].stage`, resolving/displaying `leadTerminal`, and auto-selecting `#panel-body` (`changes` for `review`, `test` for `test`, `ship` for `pr_dev`/`promote`) with `layout.show` on `#panel`.
  - Verify: `herdr-app check mods/mesh-flow && node --check mods/mesh-flow/main.js`

## Phase 3: Microservice Review Checklist, Repo Checks & `leadTerminal` (`changes-review`)

- [x] 3.1 Update `mods/changes-review/main.js` to capture and display each microservice's current Git branch on service filter pills and review headers using lock-free Git read flags.
  - Verify: `node --check mods/changes-review/main.js`
- [x] 3.2 Implement per-tab, per-service review checklist (`pending | has_notes | approved`) persisted in `shared("mesh.flows")[tabId].reviewedServices`, automatically marking `has_notes` when comments exist and adding `Approve Service ✓` to mark the active service `approved` and jump to the next unreviewed dirty microservice.
  - Verify: `node --check mods/changes-review/main.js`
- [x] 3.3 Implement `Checks` discovery and execution in `mods/changes-review/main.js`: inspect `AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, and `Makefile`, execute discovered lint/test/check commands per microservice via `exec`, display pass/fail logs, and dispatch failures to the active feature agent.
  - Verify: `node --check mods/changes-review/main.js`
- [x] 3.4 Upgrade `findActiveAgent()` in `mods/changes-review/main.js` to prioritize `mesh.flows[tabId]?.leadTerminal` ahead of focused pane, tab, and global fallbacks.
  - Verify: `herdr-app check mods/changes-review && node --check mods/changes-review/main.js`

## Phase 4: Zero-Pollution Live Testing & Playwright E2E Screenshots (`mesh-test`)

- [x] 4.1 Create `mods/mesh-test/mod.json` and `mods/mesh-test/main.js` with deterministic `workspaceHash` resolution and zero-pollution runtime paths under `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json` and `screenshots/<tabId>/`.
  - Verify: `herdr-app check mods/mesh-test && node --check mods/mesh-test/main.js`
- [x] 4.2 Implement `Ask Agent for Test Plan` (sending exact JSON path, screenshot directory, browser mode `headed | headless`, and `title`/`approved`/`servicesToStart`/`cases[]` schema via `hc send` to `leadTerminal`) and `Approve Plan` (atomic `writeTextFile` flip `approved: true` + `hc send` start/execute notification).
  - Verify: `node --check mods/mesh-test/main.js`
- [x] 4.3 Implement live test status rendering via `watchFolder` (on `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans`) + visible polling fallback (`1500ms`), displaying `curl` & `e2e` cases (`pending | running | passed | failed`, `httpCode`, `durationMs`, `summary`), publishing `mesh.testAlert`, rendering Playwright PNGs via GPUI `image(absPath)`, and mounting a click-to-zoom screenshot overlay (`openOverlay`).
  - Verify: `node --check mods/mesh-test/main.js`
- [x] 4.4 Implement local TCP port probing (`ss -tln`), 1-click `+ Service Runner` split pane launcher in the active tab (without overriding `leadTerminal`), optional manual re-run of `curl` test cases, and `Send Failures to Agent` fix-and-retest prompt dispatch.
  - Verify: `herdr-app check mods/mesh-test && node --check mods/mesh-test/main.js`

## Phase 5: PR Template & Multi-Service GitHub Promotion (`mesh-ship`)

- [x] 5.1 Create `mods/mesh-ship/mod.json` and `mods/mesh-ship/main.js` with `shared("mesh.pipelineConfig")` persistence for the configurable branch promotion chain (default `["development", "ci", "main"]`), workspace UI editor, and optional per-repo chain overrides.
  - Verify: `herdr-app check mods/mesh-ship && node --check mods/mesh-ship/main.js`
- [x] 5.2 Implement configurable PR template persistence (`shared("mesh.pipelineConfig").prTemplate` synced with `${appHome()}/mesh/pr-template.md`) and template interpolation for `{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, and `{{testSummary}}` injected into both direct `gh pr create` and `Ask Agent to Create PRs`.
  - Verify: `node --check mods/mesh-ship/main.js`
- [x] 5.3 Implement live `gh` PR monitoring (`gh pr list` / `gh pr view` / review threads API) displaying PR status, CI `statusCheckRollup`, `reviewDecision`, and unresolved review comments per microservice, plus 1-click `Send Review Comments to Agent` and single-service / batch promotion PRs (`development -> ci`, `ci -> main`).
  - Verify: `herdr-app check mods/mesh-ship && node --check mods/mesh-ship/main.js`

## Phase 6: Installer, Keybindings & Per-Mod Spec Synchronization

- [x] 6.1 Create per-mod `SPEC.md` documents (`mods/mesh-tabs/SPEC.md`, `mods/mesh-flow/SPEC.md`, `mods/mesh-test/SPEC.md`, `mods/mesh-ship/SPEC.md`, `mods/mesh-status/SPEC.md`) and update `mods/changes-review/SPEC.md` to match the implemented surfaces and contracts.
  - Verify: Confirm all `id`, `parent`, `references`, and cross-spec wikilink references resolve cleanly.
- [x] 6.2 Update `install.sh` and `keys.json` (using `setdefault` for user keybindings) to install, validate (`herdr-app check`), and uninstall all 7 `herdr-mesh` mods (`files-search`, `changes-review`, `mesh-tabs`, `mesh-flow`, `mesh-test`, `mesh-ship`, `mesh-status`) and `layouts/mesh.json`.
  - Verify: `bash -n install.sh && node -e 'JSON.parse(require("fs").readFileSync("keys.json","utf8"))'`

## Phase 7: End-to-End Verification

- [x] 7.1 Run GPUI component materialization checks across all mods:
  - `herdr-app check mods/files-search && herdr-app check mods/changes-review && herdr-app check mods/mesh-tabs && herdr-app check mods/mesh-flow && herdr-app check mods/mesh-test && herdr-app check mods/mesh-ship && herdr-app check mods/mesh-status`
- [x] 7.2 Run JS syntax checks on all mod entrypoints:
  - `for f in mods/*/main.js; do node --check "$f" || exit 1; done`
- [x] 7.3 Validate JSON syntax and verify zero `localStorage` usage across all mods:
  - `node -e 'JSON.parse(require("fs").readFileSync("layouts/mesh.json","utf8")); JSON.parse(require("fs").readFileSync("keys.json","utf8"));'`
  - `! rg -n "localStorage" mods/` (must return 0 matches)
- [x] 7.4 Validate lock-free Git flags across all read-only Git invocations in `mods/` and verify Fractal Spec-Graph link integrity across all `SPEC.md` and root spec files.
