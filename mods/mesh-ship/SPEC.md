---
id: submodule-mod-mesh-ship
type: submodule-design
status: active
title: Mesh Ship & PR Promotion Mod (mods/mesh-ship)
parent: module-mods
references: [module-layouts, submodule-mod-mesh-flow, submodule-mod-mesh-status]
covers: [configurable-promotion-chain, standardized-pr-template, github-pr-monitoring, unresolved-review-threads, agent-pr-fixes, batch-branch-promotion]
tags: [mod, github, gh, pull-requests, ci-cd, microservices]
---

## Responsibility

The `submodule-mod-mesh-ship` manages multi-microservice Pull Request creation, standardized PR template enforcement, live GitHub PR/CI/review-thread monitoring via `gh`, and branch-chain promotion inside the `#ship` child block of `#panel-body` in `layouts/mesh.json` (`[[module-layouts]]`). Serving stages `5. PR → dev` (`pr_dev`) and `6. CI → main` (`promote`) from `[[submodule-mod-mesh-flow]]` (`[[spec-lifecycle]]`), it synchronizes open PR health (`checksStatus`, `reviewDecision`, `unresolvedCount`) into `mesh.flows[tabId].prs` for `[[submodule-mod-mesh-status]]` and dispatches structured PR creation or review-comment remediation prompts to the active tab's `leadTerminal`.

## Boundary

- **Owns:**
  - Manifest file: `mods/mesh-ship/mod.json` (`{ "place": "none", "title": "Mesh Ship" }`).
  - Main GPUI component: `mods/mesh-ship/main.js` (`MeshShip` extending `View`).
  - Self-contained SVG icon assets: `mods/mesh-ship/icons/{git-pr,git-branch,settings,refresh,send,check,x,spinner,comment,external,bot}.svg`.
  - Mirror artifact under app home: `${appHome()}/mesh/pr-template.md`.
- **Public surface:**
  - Registered mod identifier: `mesh-ship`.
  - Layout slot: `#panel-body` child `"ship"` (`#ship`) in `layouts/mesh.json`.
  - Shared state bus interactions:
    - Reads `mesh.services` (with lock-free `discoverRepos` fallback) and reads/updates `mesh.activeService`.
    - Reads `mesh.flows[tabId]` (`stage`, `shipPhase`, `ticket`, `derivedTitle`, `leadTerminal`, `testPlanPath`, `prs`) and publishes normalized `mesh.flows[tabId].prs` snapshots (comparing stripped payloads before calling `setShared` to prevent re-render loops).
    - Reads and persists `mesh.pipelineConfig` (`workspaces[workspaceRoot].chain`, `repoOverrides`, `prTemplate`, `prTemplatePath`, preserving `browserMode` and sibling workspaces).
    - Reads `mesh.testAlert` to populate `{{testSummary}}` in rendered PR descriptions.
  - External CLI & Host IPC:
    - Lock-free Git inspection (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`) for current branch, dirty file count, ahead commit counts, and commit log summaries.
    - GitHub CLI (`gh`) queries (`gh pr list`, `gh api graphql`, `gh api repos/{owner}/{repo}/pulls/<n>/comments`, `gh pr create`, `gh pr view --web`) executed asynchronously per microservice with bounded `15000ms` query timeouts.
    - Agent dispatch via `hc(["send", agent.address, message])` targeting `findActiveAgent()` (`leadTerminal` priority).
    - Browser launch via `cx.open_url(url)` with `xdg-open` / `gh pr view --web` fallback.
- **Allowed deps:**
  - `gpui-kit`: `View`, `div`, `svg`.
  - `gpui-base`: `v_flex`, `h_flex`, `InputState`, `Input`, `TextareaState`, `Textarea`, `ScrollHandle`.
  - `fs/promises`: `mkdir`, `writeFile`.
  - `path`: `join`, `dirname`.
  - `herdr`: `spaces`, `panes`, `focused`, `agents`, `terminals`, `exec`, `readTextFile`, `writeTextFile`, `appHome`, `theme`, `settings`, `notify`, `hc`, `shared`, `setShared`, `window`.
- **Forbidden:**
  - Any usage of `localStorage` or browser DOM globals.
  - Writing PR templates or test/promotion metadata inside microservice Git working trees (only `${appHome()}/mesh/pr-template.md` and `shared()`).
  - Running read-only `git` commands without lock-free flags (`--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`).
  - Calling `setShared(...)` unconditionally during `render()` or without deep/serialized equality comparison.
  - Using hardcoded hex color literals outside dynamic alpha derivations from `theme()` tokens.
  - Passing bare strings to `notify(...)` (must pass `{ title, body?, level? }`).

## Architecture & Interaction Flow

```text
+-----------------------------------------------------------------------------------+
| #ship (MeshShip View)                                                             |
+-----------------------------------------------------------------------------------+
| Header: [git-pr] Ship & Promote   (N open · M comments)    [Refresh] [⚙ Config]   |
+-----------------------------------------------------------------------------------+
| [Collapsible: ⚙ Config & PR Template]                                             |
|   Workspace Chain: [ development, ci, main                                      ] |
|   Per-Repo Overrides:  auth-service: [                 ]  web-client: [         ] |
|   PR Template (mirrors ${appHome()}/mesh/pr-template.md):                         |
|     Placeholders: {{ticket}} {{title}} {{services}} {{summary}} {{testSummary}}   |
|     [TextareaState: Markdown template editor...]             [Reset] [Save]       |
+-----------------------------------------------------------------------------------+
| Stage Switcher (derived from chain):                                              |
|   [ 1. Feature → development ]  [ 2. development → ci ]  [ 3. ci → main ]         |
+-----------------------------------------------------------------------------------+
| Service Filter (when >1 service): [All] [auth-service] [web-client]               |
+-----------------------------------------------------------------------------------+
| Batch Toolbar: [Ask Agent to Create PRs] [Create/Promote All] [Send Comments (N)] |
+-----------------------------------------------------------------------------------+
| Microservice Cards (scrollable):                                                  |
|   auth-service  [feat/PROJ-412]  2 ahead · clean     feat/PROJ-412 → development  |
|   PR #142 OPEN  [CI: PASSING]  [CHANGES_REQUESTED]   [▾ 2 unresolved comments]    |
|     @reviewer · src/jwt.ts:48 — Handle expired refresh token rotation             |
|   Actions: [Open PR] [Send Comments] [Promote → ci]   (or [Create PR (gh)])       |
+-----------------------------------------------------------------------------------+
```

### Shared Bus & Persistence Contracts

1. **Promotion Pipeline Config (`shared("mesh.pipelineConfig")`)**:
   - Workspace configuration under `workspaces[workspaceRoot]` stores:
     - `chain`: Ordered promotion target branches (default `["development", "ci", "main"]`).
     - `repoOverrides`: Optional `Record<serviceId, string[]>` allowing individual microservices to override the workspace branch chain.
     - `prTemplate`: Markdown template string mirrored atomically to `${appHome()}/mesh/pr-template.md`.
     - `prTemplatePath`: Always `${appHome()}/mesh/pr-template.md`.
     - `browserMode`: Preserved from sibling `mesh-test` configuration (`"headless" | "headed"`).
     - `updatedAt`: Millisecond timestamp.
2. **Stage Switcher & `mesh.flows[tabId].shipPhase` Coupling**:
   - Phases are derived dynamically from the workspace chain `[b0, b1, ..., bk]`:
     - Phase `0`: `Feature → <b0>` (`headBranch = currentBranch`, `baseBranch = b0`).
     - Phase `i` (`1..k`): `<b_{i-1}> → <b_i>` (`headBranch = b_{i-1}`, `baseBranch = b_i`).
   - Observing `mesh.flows[activeTabId].shipPhase` synchronizes `"dev"` → Phase `0` and `"promote"` → Phase `1` (or active promotion phase `>= 1`) when `mesh-flow` stage pills `5. PR → dev` or `6. CI → main` are clicked.
3. **Normalized PR Telemetry (`mesh.flows[tabId].prs`)**:
   - Per-service PR state is published to `mesh.flows[tabId].prs[service.id]` with `{ number, url, state, head, base, checksStatus, reviewDecision, unresolvedCount, updatedAt }`, enabling `[[submodule-mod-mesh-status]]` to surface failing CI checks and unresolved comment alerts across the bottom bar.
   - Before writing `mesh.flows`, `mesh-ship` strips `updatedAt` and compares JSON serializations so unchanged refreshes never emit redundant bus updates.

### Operational Flows

1. **Template Interpolation (`renderPrTemplate(service)`)**:
   - `{{ticket}}`: Active tab's Jira key (`flow.ticket` or extracted via `/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/` from tab title, branch, or commits).
   - `{{title}}`: Active tab's `derivedTitle`, `activeTab.name`, or clean branch slug.
   - `{{services}}`: Affected microservices list with repository path and `<head> → <base>` mapping.
   - `{{summary}}`: Lock-free `git log` commit subjects between `<base>` and `<head>` for the service.
   - `{{testSummary}}`: Status and pass/fail breakdown from `mesh.testAlert` (plus cached `flow.testPlanPath` evidence if available).
2. **Live GitHub Monitoring (`refresh(cx)`)**:
   - Inspects every microservice in parallel using lock-free Git (`rev-parse --abbrev-ref HEAD`, `status --porcelain=v1`, `rev-list --count`, `log`) and `gh pr list --state all --head <head> --base <base> --json number,title,state,url,headRefName,baseRefName,reviewDecision,statusCheckRollup,comments,reviews --limit 5` (`timeout: 15000`).
   - For `OPEN` PRs, fetches unresolved review threads via `gh api graphql` (`reviewThreads(first: 50)` checking `isResolved`, `path`, `line`, `comments`), falling back to `gh api repos/{owner}/{repo}/pulls/<number>/comments` and `reviews`/`comments` if GraphQL threads are unavailable.
3. **Direct `gh` PR Creation, Batch Promotion & Agent Dispatch**:
   - **`Create PR (gh)` / `Promote → <nextBranch>`**: Pushes `headBranch` if needed and executes `gh pr create --base <base> --head <head> --title ... --body <renderedTemplate>` in `svc.root`.
   - **`Ask Agent to Create PRs`**: Sends a structured prompt to `findActiveAgent()` (`leadTerminal`-prioritized) containing target branches, affected microservices, and the **verbatim PR Template** plus rendered context so all agent-created PRs match the configured standard.
   - **`Send Review Comments to Agent`**: Compiles unresolved review threads (`### Service: <name> (PR #<num>)\n- path:line (@author): comment`) across one service or all services and transmits via `hc(["send", agent.address, msg])`.

## Invariants

1. **Zero `localStorage` Invariant:**
   `mods/mesh-ship` contains zero `localStorage` references; all pipeline configuration and template state persist via `shared("mesh.pipelineConfig")` and `${appHome()}/mesh/pr-template.md`.
2. **Lock-Free Git Inspection:**
   Every read-only `git` invocation prepends `["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"]`.
3. **Non-Reentrant Shared Bus Updates:**
   `mesh.flows` and `mesh.pipelineConfig` writes happen only on explicit actions or changed normalized PR payloads, never inside `render()` and never without diffing serialized state first.
4. **Input & Notification Safety:**
   `Input` and `Textarea` components handling `Escape` are wrapped in `div().on_key_down(...)`, all `InputState`/`TextareaState` instances are constructed outside `render()`, and all `notify(...)` calls pass `{ title, body?, level? }` objects.
5. **Dynamic Theme Compliance:**
   All visual colors derive from `theme()` tokens (with dynamic alpha suffixes via `withAlpha`) and font styling uses `.font_family(...)`.
