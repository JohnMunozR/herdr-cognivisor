# Proposal: Agent IDE Lifecycle (`agent-ide-lifecycle`)

## Intent

Herdr Mesh currently delivers workspace-wide navigation (`files-search`) and multi-repo diff review (`changes-review`), but stops short of orchestrating the full multi-microservice engineering lifecycle. Developers using autonomous CLI agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`) still manually rename generic tabs, track workflow stages mentally, write ad-hoc test artifacts inside repository working trees, poll local service ports and GitHub PRs in separate terminals, and lose track of which terminal is the tab's lead agent versus auxiliary service runners.

This change introduces the complete **Agent IDE Lifecycle** across `layouts/mesh.json`, five new GPUI-kit mods (`mesh-tabs`, `mesh-flow`, `mesh-test`, `mesh-ship`, `mesh-status`), and targeted enhancements to `changes-review`, anchored on an organic terminal-first workflow and strict zero-pollution persistence.

## Scope

### In Scope

1. **Organic Terminal-First Workflow & Auto-Naming (`mods/mesh-tabs`, `mods/mesh-flow`)**:
   - Auto-detect generic tab names (`^tb\d+$`, unnamed/index labels, program titles) and derive representative names by extracting Jira keys (`[A-Z][A-Z0-9]{1,9}-\d+`) and summarizing `first_message` via `hc get <t> --json` / `hc read <t>` or falling back to active git branch.
   - Rename tabs via `run("tab.rename", { id, name })` without overwriting manual user renames.
   - Provide 1-click inline tab rename and an explicit `Auto` re-sync trigger in `#flow`.

2. **Six-Stage Tab-Scoped Pipeline & Layout Upgrade (`mods/mesh-flow`, `layouts/mesh.json`)**:
   - Track per-tab stages (`plan` → `build` → `review` → `test` → `pr_dev` → `promote`) in `shared("mesh.flows")[tabId].stage`.
   - Couple stage selection with `#panel-body` (`review` → `changes`, `test` → `test`, `pr_dev` / `promote` → `ship`).
   - Update `layouts/mesh.json` to mount `#flow` (`38px`, `mod: "mesh-flow"`), upgrade `#tabs` (`mesh-tabs`) and `#status` (`mesh-status`), and expand `#panel-body` with `#test` (`mesh-test`) and `#ship` (`mesh-ship`).

3. **Microservice-by-Microservice Review & Checks (`mods/changes-review`)**:
   - Display current Git branch per microservice.
   - Maintain per-tab, per-service review state (`pending | has_notes | approved`) in `mesh.flows[tabId].reviewedServices`.
   - Add `Approve Service ✓` (marks service approved and jumps to next unreviewed dirty microservice) and `Checks` (discovers `AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, `Makefile`, executes lint/test/check commands, and dispatches failures to the active agent).
   - Prioritize `mesh.flows[tabId].leadTerminal` in `findActiveAgent()`.

4. **Live Agent-Driven Testing & Playwright E2E (`mods/mesh-test`)**:
   - Zero-pollution runtime storage under `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json` and `screenshots/<tabId>/`.
   - `Ask Agent for Test Plan`, live `watchFolder` + visible polling rendering (`curl` & `e2e` cases), headed/headless browser mode toggle, inline PNG rendering via `image(absPath)` with click-to-zoom overlay, `Approve Plan`, TCP port probing via `ss -tln`, 1-click `+ Service Runner` split panes, optional manual `curl` re-run, and `Send Failures to Agent`.

5. **PR Template & Multi-Service GitHub Promotion (`mods/mesh-ship`)**:
   - Configurable branch promotion chain (`["development", "ci", "main"]` default) in `shared("mesh.pipelineConfig")` with workspace editing and per-repo overrides.
   - Configurable PR template (`shared("mesh.pipelineConfig").prTemplate` / `${appHome()}/mesh/pr-template.md`) with `{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, and `{{testSummary}}` injected into both `gh pr create` and `Ask Agent to Create PRs`.
   - Live `gh` PR monitoring (`statusCheckRollup`, `reviewDecision`, unresolved comments/threads), 1-click `Send Review Comments to Agent`, and single-service or batch promotion PRs.

6. **Status Telemetry & Persistence Hygiene (`mods/mesh-status`, `mods/mesh-tabs`)**:
   - Replace `tabs`'s `localStorage` `"panels"` store with `shared("mesh.spacePanels")`.
   - Standardize all `mesh.*` shared bus keys (`mesh.services`, `mesh.activeService`, `mesh.flows`, `mesh.pipelineConfig`, `mesh.spacePanels`, `mesh.testAlert`).
   - Surface active stage, service status, `mesh.testAlert`, and PR review telemetry in `#status` (`mesh-status`).

### Out of Scope

- Full LSP source-code editing inside Herdr Mesh (remains out of scope per `[[goal-and-requirements]]`).
- Modifying Herdr's shipped built-in layouts (`main.json`, `terminals.json`, `win98.json`) or built-in mods inside Herdr's core distribution.
- Automated force-push, interactive rebase, or automated conflict merging from UI panels.

---

## Impact Analysis

### Layout Blocks (`layouts/mesh.json`)

| Block ID | Current State | Proposed Change | Impact & Compatibility |
|---|---|---|---|
| `#tabs` | `42px`, `mod: "tabs"`, `window_drag: true` | `42px`, `mod: "mesh-tabs"`, `window_drag: true` | Replaces built-in `tabs` only inside `layouts/mesh.json`; adds `test`/`ship` panel buttons, auto-naming, inline rename, and replaces `localStorage` with `mesh.spacePanels`. |
| `#flow` | Absent | New `38px` block (`mod: "mesh-flow"`) in `#work` above `#work-body` | Reduces `#work-body` vertical viewport by `38px` while providing immediate tab-scoped stage controls and `Auto` re-sync without cluttering `#tabs` or `#main`. |
| `#panel-body` | Stack with `#files` (`files-search`) and `#changes` (`changes-review`) | Stack with `#files`, `#changes`, `#test` (`mesh-test`), `#ship` (`mesh-ship`) | Preserves `"files"` and `"changes"` child IDs verbatim and keeps `type: "stack"` mutual exclusion; only mounts 1 active child per frame. |
| `#status` | `28px`, `mod: "workspace-status"` | `28px`, `mod: "mesh-status"` | Preserves machine, branch, agent count, and `app.palette` hint while adding stage, `mesh.testAlert`, and PR review alerts. |

### Shared State Keys (`shared()` / `setShared()`)

| Key | Status | Impact |
|---|---|---|
| `mesh.services` | Existing (extended) | Optionally carries `branch` per service; signature check preserves loop-free discovery between `files-search` and `changes-review`, consumed by `mesh-flow`, `mesh-test`, `mesh-ship`, `mesh-status`. |
| `mesh.activeService` | Existing | Unchanged payload; consumed and updated by `changes-review`, `files-search`, `mesh-test`, and `mesh-ship`. |
| `mesh.flows` | New | Stores per-tab `stage`, derived/locked title metadata, `leadTerminal`, `reviewedServices`, and PR cache keyed by `tabId`. |
| `mesh.pipelineConfig` | New | Stores workspace promotion chain (default `["development", "ci", "main"]`), per-repo overrides, PR template string/path, and Playwright browser mode. |
| `mesh.spacePanels` | New | Replaces `localStorage.getItem("panels")` / `setItem("panels")` in `mesh-tabs`, enforcing zero-`localStorage` invariant across all `herdr-mesh` mods. |
| `mesh.testAlert` | New | Broadcasts active tab's live test status (`running`, `passed`, `failed`, `plan_ready`) from `mesh-test` to `mesh-status` and `mesh-flow`. |
| `workspace.panels` | Existing Herdr key | `mesh-tabs` honors `shared("workspace.panels")` fallback `["files", "changes", "test", "ship"]` inside `mesh` layout while avoiding interference with built-in `tabs`. |
| `files-search.*`, `changes-review.*` | Existing | Unchanged; isolated mod-private namespaces remain intact. |

---

## Backwards-Compatibility

1. **Default Herdr Layouts (`main.json`, `terminals.json`, `win98.json`)**:
   - `herdr-mesh` never mutates or shadows Herdr's shipped `tabs` or `workspace-status` mod directories; the new mods carry distinct `mesh-*` IDs (`mesh-tabs`, `mesh-flow`, `mesh-test`, `mesh-ship`, `mesh-status`) and are bound exclusively inside `layouts/mesh.json`.
   - Switching back to `main`, `terminals`, or `win98` continues using stock Herdr mods unaffected.
2. **Existing `keys.json` Bindings**:
   - Existing `ctrl-p` and `alt-f` (`mod.open:files-search`) bindings remain unchanged.
   - Any new lifecycle shortcuts added in `install.sh` (if desired) MUST use `setdefault` so existing user bindings in `~/.config/herdr-app/keys.json` are never overwritten.
3. **Panel Stack Identifiers**:
   - Keeping `#files` and `#changes` inside `#panel-body` preserves compatibility with existing `layout.select --stack panel-body --child files|changes` commands and `install.sh` activation steps.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `hc get`/`hc read` polling spikes CPU on busy tabs | Debounce and throttle `hc` auto-naming queries; skip already-named (`tab.named === true`) and cached `tabId` sessions unless `Auto` is clicked. |
| Test artifacts or Playwright screenshots dirty microservice repos | Enforce `${appHome()}/mesh/workspaces/<workspaceHash>/...` paths in prompts and UI writes; never emit files under `space.folder`. |
| `watchFolder` hits Linux directory limit or misses rapid writes | Watch only the small `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans` folder and pair `watchFolder` with a bounded visible-only polling fallback (`1500ms`). |
| `gh` CLI unauthenticated or rate-limited | Degrade gracefully in `mesh-ship` with explicit auth/error banners and on-demand refresh rather than aggressive background polling. |
| Auxiliary service runner splits steal `findActiveAgent()` focus | Persist `leadTerminal` per tab in `mesh.flows[tabId]` and prioritize it across `changes-review`, `mesh-test`, and `mesh-ship`. |
