# Tasks: Agent IDE Lifecycle (`agent-ide-lifecycle`)

## Phase 1: Layout & Shared State Bus Foundation

- [x] 1.1 Update `layouts/cognivisor.json` to mount `#flow` (`38px`, `mod: "cognivisor-flow"`) inside `#work` directly above `#work-body`, upgrade `#tabs` (`42px`) to `mod: "cognivisor-tabs"`, expand `#panel-body` stack with `#test` (`mod: "cognivisor-test"`) and `#ship` (`mod: "cognivisor-ship"`) alongside `#files` and `#changes`, and upgrade `#status` (`28px`) to `mod: "cognivisor-status"`.
  - Verify: `node -e 'const l=JSON.parse(require("fs").readFileSync("layouts/cognivisor.json","utf8")); console.log(JSON.stringify({id:l.id}))'`
- [x] 1.2 Create `mods/cognivisor-tabs/mod.json` and `mods/cognivisor-tabs/main.js` cloned from Herdr's `tabs` structure, replacing all `localStorage` panel persistence with `shared("cognivisor.spacePanels")` / `setShared("cognivisor.spacePanels", ...)`, enabling panel toggle buttons for `files`, `changes`, `test`, and `ship`, and preserving `window_drag` + traffic lights padding.
  - Verify: `herdr-app check mods/cognivisor-tabs && node --check mods/cognivisor-tabs/main.js`
- [x] 1.3 Create `mods/cognivisor-status/mod.json` and `mods/cognivisor-status/main.js` to render machine, workspace/service dirty counts, active pipeline stage from `cognivisor.flows`, live `cognivisor.testAlert` indicator (click opens `#test`), PR/review alert indicator (click opens `#ship`), agent status counters, and `app.palette` trigger.
  - Verify: `herdr-app check mods/cognivisor-status && node --check mods/cognivisor-status/main.js`

## Phase 2: Organic Tab Auto-Naming & Six-Stage Pipeline (`cognivisor-flow`)

- [x] 2.1 Implement organic tab auto-naming helper shared across `mods/cognivisor-tabs/main.js` and `mods/cognivisor-flow/main.js`: detect generic/unnamed tabs (`^tb\d+$`, numeric index, `!tab.named`, bare program title), query `hc get <t> --json` and `hc read <t>` to extract Jira keys (`[A-Z][A-Z0-9]{1,9}-\d+`) and summarize `first_message` (falling back to lock-free `git rev-parse --abbrev-ref HEAD`), and call `run("tab.rename", { id, name })` without overwriting manual user renames.
  - Verify: `node --check mods/cognivisor-tabs/main.js && node --check mods/cognivisor-flow/main.js`
- [x] 2.2 Implement 1-click inline rename in `cognivisor-tabs` (`InputState` on tab) and `cognivisor-flow` (inline title editor + `manualTitle` flag in `cognivisor.flows[tabId]`), plus the `Auto` re-sync button in `#flow` to recompute derived tab names on demand.
  - Verify: `herdr-app check mods/cognivisor-tabs && herdr-app check mods/cognivisor-flow`
- [x] 2.3 Create `mods/cognivisor-flow/mod.json` and `mods/cognivisor-flow/main.js` (`38px` bar) rendering the 6 tab-scoped pipeline stages (`plan` / `1. Plan`, `build` / `2. Build`, `review` / `3. Review`, `test` / `4. Test`, `pr_dev` / `5. PR → dev`, `promote` / `6. CI → main`), persisting `cognivisor.flows[tabId].stage`, resolving/displaying `leadTerminal`, and auto-selecting `#panel-body` (`changes` for `review`, `test` for `test`, `ship` for `pr_dev`/`promote`) with `layout.show` on `#panel`.
  - Verify: `herdr-app check mods/cognivisor-flow && node --check mods/cognivisor-flow/main.js`

## Phase 3: Microservice Review Checklist, Repo Checks & `leadTerminal` (`changes-review`)

- [x] 3.1 Update `mods/changes-review/main.js` to capture and display each microservice's current Git branch on service filter pills and review headers using lock-free Git read flags.
  - Verify: `node --check mods/changes-review/main.js`
- [x] 3.2 Implement per-tab, per-service review checklist (`pending | has_notes | approved`) persisted in `shared("cognivisor.flows")[tabId].reviewedServices`, automatically marking `has_notes` when comments exist and adding `Approve Service ✓` to mark the active service `approved` and jump to the next unreviewed dirty microservice.
  - Verify: `node --check mods/changes-review/main.js`
- [x] 3.3 Implement `Checks` discovery and execution in `mods/changes-review/main.js`: inspect `AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, and `Makefile`, execute discovered lint/test/check commands per microservice via `exec`, display pass/fail logs, and dispatch failures to the active feature agent.
  - Verify: `node --check mods/changes-review/main.js`
- [x] 3.4 Upgrade `findActiveAgent()` in `mods/changes-review/main.js` to prioritize `cognivisor.flows[tabId]?.leadTerminal` ahead of focused pane, tab, and global fallbacks.
  - Verify: `herdr-app check mods/changes-review && node --check mods/changes-review/main.js`

## Phase 4: Zero-Pollution Live Testing & Playwright E2E Screenshots (`cognivisor-test`)

- [x] 4.1 Create `mods/cognivisor-test/mod.json` and `mods/cognivisor-test/main.js` with deterministic `workspaceHash` resolution and zero-pollution runtime paths under `${appHome()}/cognivisor/workspaces/<workspaceHash>/test-plans/<tabId>.json` and `screenshots/<tabId>/`.
  - Verify: `herdr-app check mods/cognivisor-test && node --check mods/cognivisor-test/main.js`
- [x] 4.2 Implement `Ask Agent for Test Plan` (sending exact JSON path, screenshot directory, browser mode `headed | headless`, and `title`/`approved`/`servicesToStart`/`cases[]` schema via `hc send` to `leadTerminal`) and `Approve Plan` (atomic `writeTextFile` flip `approved: true` + `hc send` start/execute notification).
  - Verify: `node --check mods/cognivisor-test/main.js`
- [x] 4.3 Implement live test status rendering via `watchFolder` (on `${appHome()}/cognivisor/workspaces/<workspaceHash>/test-plans`) + visible polling fallback (`1500ms`), displaying `curl` & `e2e` cases (`pending | running | passed | failed`, `httpCode`, `durationMs`, `summary`), publishing `cognivisor.testAlert`, rendering Playwright PNGs via GPUI `image(absPath)`, and mounting a click-to-zoom screenshot overlay (`openOverlay`).
  - Verify: `node --check mods/cognivisor-test/main.js`
- [x] 4.4 Implement local TCP port probing (`ss -tln`), 1-click `+ Service Runner` split pane launcher in the active tab (without overriding `leadTerminal`), optional manual re-run of `curl` test cases, and `Send Failures to Agent` fix-and-retest prompt dispatch.
  - Verify: `herdr-app check mods/cognivisor-test && node --check mods/cognivisor-test/main.js`

## Phase 5: PR Template & Multi-Service GitHub Promotion (`cognivisor-ship`)

- [x] 5.1 Create `mods/cognivisor-ship/mod.json` and `mods/cognivisor-ship/main.js` with `shared("cognivisor.pipelineConfig")` persistence for the configurable branch promotion chain (default `["development", "ci", "main"]`), workspace UI editor, and optional per-repo chain overrides.
  - Verify: `herdr-app check mods/cognivisor-ship && node --check mods/cognivisor-ship/main.js`
- [x] 5.2 Implement configurable PR template persistence (`shared("cognivisor.pipelineConfig").prTemplate` synced with `${appHome()}/cognivisor/pr-template.md`) and template interpolation for `{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, and `{{testSummary}}` injected into both direct `gh pr create` and `Ask Agent to Create PRs`.
  - Verify: `node --check mods/cognivisor-ship/main.js`
- [x] 5.3 Implement live `gh` PR monitoring (`gh pr list` / `gh pr view` / review threads API) displaying PR status, CI `statusCheckRollup`, `reviewDecision`, and unresolved review comments per microservice, plus 1-click `Send Review Comments to Agent` and single-service / batch promotion PRs (`development -> ci`, `ci -> main`).
  - Verify: `herdr-app check mods/cognivisor-ship && node --check mods/cognivisor-ship/main.js`

## Phase 6: Installer, Keybindings & Per-Mod Spec Synchronization

- [x] 6.1 Create per-mod `SPEC.md` documents (`mods/cognivisor-tabs/SPEC.md`, `mods/cognivisor-flow/SPEC.md`, `mods/cognivisor-test/SPEC.md`, `mods/cognivisor-ship/SPEC.md`, `mods/cognivisor-status/SPEC.md`) and update `mods/changes-review/SPEC.md` to match the implemented surfaces and contracts.
  - Verify: Confirm all `id`, `parent`, `references`, and cross-spec wikilink references resolve cleanly.
- [x] 6.2 Update `install.sh` and `keys.json` (using `setdefault` for user keybindings) to install, validate (`herdr-app check`), and uninstall all 7 `herdr-cognivisor` mods (`files-search`, `changes-review`, `cognivisor-tabs`, `cognivisor-flow`, `cognivisor-test`, `cognivisor-ship`, `cognivisor-status`) and `layouts/cognivisor.json`.
  - Verify: `bash -n install.sh && node -e 'JSON.parse(require("fs").readFileSync("keys.json","utf8"))'`

## Phase 7: End-to-End Verification

- [x] 7.1 Run GPUI component materialization checks across all mods:
  - `herdr-app check mods/files-search && herdr-app check mods/changes-review && herdr-app check mods/cognivisor-tabs && herdr-app check mods/cognivisor-flow && herdr-app check mods/cognivisor-test && herdr-app check mods/cognivisor-ship && herdr-app check mods/cognivisor-status`
- [x] 7.2 Run JS syntax checks on all mod entrypoints:
  - `for f in mods/*/main.js; do node --check "$f" || exit 1; done`
- [x] 7.3 Validate JSON syntax and verify zero `localStorage` usage across all mods:
  - `node -e 'JSON.parse(require("fs").readFileSync("layouts/cognivisor.json","utf8")); JSON.parse(require("fs").readFileSync("keys.json","utf8"));'`
  - `! rg -n "localStorage" mods/` (must return 0 matches)
- [x] 7.4 Validate lock-free Git flags across all read-only Git invocations in `mods/` and verify Fractal Spec-Graph link integrity across all `SPEC.md` and root spec files.
