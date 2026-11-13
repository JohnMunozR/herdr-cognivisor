# Design: Agent IDE Lifecycle (`agent-ide-lifecycle`)

## Architecture Overview

The Agent IDE Lifecycle elevates Herdr Mesh from a passive file/diff sidebar into a tab-scoped, multi-microservice orchestration harness (`Plan → Build → Review → Test → PR → dev → CI → main`). Every feature tab acts as an isolated work unit with its own derived title, lead AI agent (`leadTerminal`), active pipeline stage, per-service review checklist, zero-pollution test plan, and cross-service promotion status.

```text
Developer opens tab ─▶ Launches agent (claude/gemini/codex/opencode/pi/antigravity)
                           │
                           ▼ (first message / Jira key / branch)
   [mesh-tabs] + [mesh-flow] auto-name tab via hc get/read + run("tab.rename")
                           │ (preserves manual renames; Auto button re-syncs)
                           ▼
   [mesh-flow (#flow, 38px)] ── Stage Click ──▶ updates shared("mesh.flows")[tabId].stage
     1. Plan | 2. Build | 3. Review | 4. Test | 5. PR → dev | 6. CI → main
                                 │          │             │
            layout.select + show ▼          ▼             ▼
                         [#changes]     [#test]       [#ship]
                      (changes-review) (mesh-test)  (mesh-ship)
                           │                │             │
                           ├─ Per-svc branch├─ JSON plan  ├─ Chain: development→ci→main
                           ├─ Checklist     │  under      ├─ PR template ({{ticket}},...)
                           ├─ Approve ✓     │  appHome()  ├─ gh PR/CI/review threads
                           └─ Checks        ├─ ss -tln    └─ Batch/single promote +
                              (leadTerminal)├─ +Runner       Send Review Comments
                                            └─ image() E2E
```

### Layout Topology (`layouts/mesh.json`)

```text
root (row, titlebar: "none")
├── sidebar (column, 268px)
│   ├── brand (46px, workspace-chrome, window_drag: true)
│   ├── sidebar-lists (spaces + agents)
│   └── sidebar-footer (69px, workspace-chrome)
└── work (column, flex)
    ├── tabs (42px, mod: "mesh-tabs", window_drag: true)
    ├── flow (38px, mod: "mesh-flow")
    ├── work-body (row, flex, padding: 8, gap: 8)
    │   ├── main (block, flex, tab: active, pane header)
    │   └── panel (column, 368px [280..900], hidden: true)
    │       └── panel-body (stack, active: "files")
    │           ├── files (block, mod: "files-search")
    │           ├── changes (block, mod: "changes-review")
    │           ├── test (block, mod: "mesh-test")
    │           └── ship (block, mod: "mesh-ship")
    └── status (28px, mod: "mesh-status")
```

---

## GPUI-Kit View Hierarchies

All UI views MUST be composed purely with `gpui-kit` (`View`, `div`, `svg`, `image`, `list`) and `gpui-base` (`h_flex`, `v_flex`, `Input`, `InputState`, `Textarea`, `TextareaState`, `Scrollbar`, `ScrollHandle`). No DOM, HTML, CSS classes, `.font_mono()`, hardcoded hex colors, or `localStorage` calls are permitted.

### 1. `mods/mesh-tabs` (`Tabs` View)

```text
h_flex (size_full, chrome bg, border_b)
├── h_flex#tab-scroll (flex_1, overflow_x_scrollbar)
│   └── [per tab c]: h_flex#tab-{c.id}
│       ├── [if c.id === editingTabId]: Input(renameState)
│       └── [else]: program icon (svg/image) + truncated title + status dot/spinner
│                   + inline rename trigger (on double-click or pencil button) + close icon
├── button#tab-new ("+", opens new-menu overlay)
├── panelButton("files", "Files", ...)
├── panelButton("changes", "Changes", ...)
├── panelButton("test", "Test", ...)
├── panelButton("ship", "Ship", ...)
└── [when window().buttons]: minimize / maximize / close
```

- **Panel Persistence (`mesh.spacePanels`)**: Replaces `localStorage.getItem("panels")`/`setItem` with `shared("mesh.spacePanels") ?? {}` and `setShared("mesh.spacePanels", nextMap)` using the existing `pending` transition timer (`1000ms`) so space switching restores each space's open panel without flicker.
- **Auto-Naming Detector**: Scans active space tabs whose names are generic (`/^tb\d+$/`, `/^\d+$/`, `!tab.named`, or equal to the bare `program.name` / `"Terminal"`). Never modifies tabs where `tab.named === true` or `mesh.flows[tab.id]?.manualTitle === true`.

### 2. `mods/mesh-flow` (`MeshFlow` View, `#flow` 38px)

```text
h_flex (size_full, h: 38, chrome/surface bg, border_b, px: 10, gap: 8, items_center)
├── h_flex#flow-identity (gap: 6, items_center)
│   ├── ticket pill (when ticket extracted, e.g. "PROJ-412", accent tint)
│   ├── [if inlineRenaming]: Input(titleState) (Enter saves via run("tab.rename"))
│   ├── [else]: clickable title label (1-click inline rename)
│   └── button#flow-auto ("Auto", re-derives & syncs tab name via hc/git)
├── h_flex#flow-stages (flex_1, gap: 4, overflow_x_scrollbar)
│   └── [for stage in 6 stages]: pill button
│       ("1. Plan", "2. Build", "3. Review", "4. Test", "5. PR → dev", "6. CI → main")
└── h_flex#flow-meta (gap: 6, items_center)
    ├── leadTerminal badge (e.g. "Lead: claude (t1)" — clickable to cycle/pin leadTerminal)
    └── dirty service / testAlert summary indicator
```

- **Stage-to-Panel Mapping**:
  - `plan`, `build`: update `mesh.flows[tabId].stage`; leave `#panel` untouched so terminal focus remains unobstructed.
  - `review`: set stage `"review"`, invoke `run("layout.select", { stack: "panel-body", child: "changes" })` + `run("layout.show", { id: "panel" })`.
  - `test`: set stage `"test"`, invoke `run("layout.select", { stack: "panel-body", child: "test" })` + `run("layout.show", { id: "panel" })`.
  - `pr_dev`, `promote`: set stage, invoke `run("layout.select", { stack: "panel-body", child: "ship" })` + `run("layout.show", { id: "panel" })`.

### 3. `mods/changes-review` Enhancements (`Changes` View, `#changes`)

```text
v_flex (size_full)
├── Header (workspace branch summary + mode toggle Working/Commits + [Checks] button)
├── Service Filter Bar (horizontal pills)
│   └── [per service]: name + branch badge (e.g. feat/PROJ-412) + count + review status glyph (○ / ✎ / ✓)
├── [when activeService !== "all"]: Microservice Review Bar
│   ├── branch label + status ("pending" | "has_notes" | "approved")
│   └── button ("Approve Service ✓") -> marks approved & jumps to next unreviewed dirty service
├── [when checksOpen]: Repo Checks Drawer
│   ├── discovered commands (from AGENTS.md, CLAUDE.md, SPEC.md, package.json, pom.xml, Cargo.toml, Makefile)
│   ├── per-service check status + scrollable output
│   └── button ("Send Failures to Agent") -> dispatches via findActiveAgent()
├── Changed Files List + Virtual Diff Viewer + Inline Comment Cards
└── Review Summary / Commit Footer (uses leadTerminal-prioritized findActiveAgent())
```

### 4. `mods/mesh-test` (`MeshTest` View, `#test`)

```text
v_flex (size_full)
├── Header (title, plan summary, [Headless | Headed] mode toggle)
├── Action Bar
│   ├── button ("Ask Agent for Test Plan")
│   ├── [when plan && !plan.approved]: button ("Approve Plan")
│   ├── [when failedCount > 0]: button ("Send Failures to Agent")
│   └── refresh indicator (watchFolder + live polling status)
├── Services Runner Section (servicesToStart[])
│   └── [per svc]: serviceName + port probe badge via ss -tln ("UP :8080" | "DOWN :8080")
│                + button ("+ Service Runner") -> opens split pane in active tab
├── Cases List (list() virtualized over plan.cases[])
│   └── [per testCase]:
│       ├── status badge (pending | running | passed | failed) + kind tag (curl | e2e) + name
│       ├── metrics row: httpCode (e.g. "200") + durationMs (e.g. "184ms") + [Re-run curl] button
│       ├── summary / error text
│       └── [when screenshot/screenshots]: GPUI image(absPath) thumbnail(s)
│           └── on_click -> openOverlay({ mod: "mesh-test", kind: "dialog", props: { zoomImage: absPath } })
└── [when props().zoomImage]: Screenshot Zoom Modal Viewer (full-resolution image() + close button)
```

### 5. `mods/mesh-ship` (`MeshShip` View, `#ship`)

```text
v_flex (size_full)
├── Header ("Ship & Promote", Refresh PRs button, Config/Template toggle)
├── [when configOpen]: Pipeline & PR Template Drawer
│   ├── Promotion chain editor (default: "development → ci → main") + per-repo override inputs
│   └── PR Template editor (backed by shared + ${appHome()}/mesh/pr-template.md)
│       showing supported placeholders: {{ticket}}, {{title}}, {{services}}, {{summary}}, {{testSummary}}
├── Action Toolbar
│   ├── button ("Ask Agent to Create PRs") (injects rendered PR template)
│   ├── button ("Promote All → <nextStage>") (batch promotion PRs)
│   └── [when unresolvedThreads > 0]: button ("Send Review Comments to Agent")
└── Microservices PR List (v_flex / Scrollbar)
    └── [per service]:
        ├── service name + current branch + promotion chain pills
        ├── PR status row (#123, state, base ← head, CI statusCheckRollup badge, reviewDecision badge)
        ├── unresolved review threads count + expandable thread preview
        └── per-service actions: [Create PR (gh)] | [Promote → <next>] | [Send Comments]
```

### 6. `mods/mesh-status` (`MeshStatus` View, `#status` 28px)

```text
h_flex (size_full, h: 28, px: 14, gap: 14, chrome bg, border_t)
├── machine indicator ("This computer" / space.machine)
├── branch / services summary (e.g. "4 services · 2 dirty" or active branch)
├── active stage pill (from mesh.flows[tabId].stage, e.g. "4. Test")
├── [when mesh.testAlert]: test status pill (passed/failed/running count, clicks -> #test)
├── [when unresolved PR comments / failing CI]: ship alert pill (clicks -> #ship)
├── agent counter ("N agents · M needs you")
├── flex_1 spacer
└── keybinding palette button (app.palette)
```

---

## Shared State Contracts & Data Schemas

### Shared Bus Keys (`shared()` / `setShared()`)

```typescript
// 1. Discovered workspace microservice repositories (published on topology signature change)
// Key: "mesh.services"
interface MeshServicesPayload {
  workspaceRoot: string;
  on: string | null;
  services: Array<{
    id: string;
    name: string;
    relPath: string;
    root: string;
    branch?: string;
  }>;
  ts: number;
}

// 2. Active service filter across files-search, changes-review, mesh-test, mesh-ship
// Key: "mesh.activeService"
interface MeshActiveServicePayload {
  workspaceRoot: string;
  serviceId: string; // "all" or service.id
  ts: number;
}

// 3. Per-tab lifecycle orchestration state
// Key: "mesh.flows"
type FlowStage = "plan" | "build" | "review" | "test" | "pr_dev" | "promote";
type ServiceReviewStatus = "pending" | "has_notes" | "approved";

interface MeshFlowTabState {
  tabId: string;
  workspaceRoot: string;
  stage: FlowStage;
  ticket: string | null;           // Extracted Jira key matching /[A-Z][A-Z0-9]{1,9}-\d+/
  derivedTitle: string | null;     // Last auto-derived name
  manualTitle: boolean;            // True if user explicitly renamed tab
  leadTerminal: string | null;     // Preferred agent terminal address (e.g. "t1" or "vps/t1")
  reviewedServices: Record<string, {
    status: ServiceReviewStatus;
    branch?: string;
    updatedAt: number;
  }>;
  testPlanPath?: string;
  prs?: Record<string, {
    number?: number;
    url?: string;
    state?: "OPEN" | "CLOSED" | "MERGED";
    head?: string;
    base?: string;
    checksStatus?: "PASSING" | "FAILING" | "PENDING" | "NONE";
    reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
    unresolvedCount?: number;
    updatedAt: number;
  }>;
  updatedAt: number;
}
type MeshFlowsMap = Record<string, MeshFlowTabState>;

// 4. Promotion pipeline & PR template configuration
// Key: "mesh.pipelineConfig"
interface WorkspacePipelineConfig {
  chain: string[];                          // Default: ["development", "ci", "main"]
  repoOverrides?: Record<string, string[]>; // serviceId -> custom branch chain
  prTemplate: string;                       // Markdown template with {{placeholders}}
  prTemplatePath: string;                   // Default: `${appHome()}/mesh/pr-template.md`
  browserMode: "headless" | "headed";       // Default: "headless"
  updatedAt: number;
}
interface MeshPipelineConfigState {
  defaultChain: string[];
  defaultPrTemplate: string;
  workspaces: Record<string, WorkspacePipelineConfig>;
}

// 5. Per-space panel selection persistence (replaces localStorage in mesh-tabs)
// Key: "mesh.spacePanels"
type MeshSpacePanelsMap = Record<string, "files" | "changes" | "test" | "ship" | null>;

// 6. Live test alert surfaced by mesh-test to mesh-status & mesh-flow
// Key: "mesh.testAlert"
interface MeshTestAlertPayload {
  tabId: string;
  workspaceRoot: string;
  status: "plan_ready" | "running" | "passed" | "failed";
  total: number;
  passed: number;
  failed: number;
  running: number;
  summary?: string;
  ts: number;
}
```

### Runtime Test Plan JSON Schema (Zero-Pollution Storage)

- **Workspace Hash**: Deterministic non-cryptographic FNV-1a / DJB2 hex slug (e.g. `<basename>-<8hex>`) computed from normalized `workspaceRoot` so directories remain human-inspectable and collision-resistant.
- **Paths**:
  - Test plan: `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans/<tabId>.json`
  - Screenshots: `${appHome()}/mesh/workspaces/<workspaceHash>/screenshots/<tabId>/<caseId>.png`
  - Global default PR template mirror: `${appHome()}/mesh/pr-template.md`

```typescript
interface MeshTestPlan {
  title: string;
  approved: boolean;
  browserMode?: "headless" | "headed";
  servicesToStart: Array<{
    serviceId: string;
    name: string;
    cwd: string;
    command: string;
    port: number;
    healthUrl?: string;
  }>;
  cases: Array<{
    id: string;
    kind: "curl" | "e2e";
    name: string;
    serviceId?: string;
    command?: string;
    method?: string;
    url?: string;
    expectedStatus?: number;
    status: "pending" | "running" | "passed" | "failed";
    httpCode?: number;
    durationMs?: number;
    summary?: string;
    error?: string;
    screenshot?: string;     // Absolute path under ${appHome()}/mesh/.../screenshots/<tabId>/
    screenshots?: string[];  // Optional multiple screenshot paths for multi-step E2E flows
  }>;
}
```

---

## Key Algorithmic & Operational Flows

### 1. Tab Auto-Naming Algorithm (`mesh-tabs` & `mesh-flow`)

1. **Eligibility Check**: Skip tab if `tab.named === true` or `mesh.flows[tab.id]?.manualTitle === true`, unless invoked via the `#flow` `Auto` trigger. Consider a tab generic when `!tab.named` AND (`/^tb\d+$/.test(tab.name)`, `/^\d+$/.test(tab.name)`, or `tab.name === program?.name || tab.name === "Terminal"`).
2. **Signal Gathering**:
   - Locate tab's primary agent terminal (`mesh.flows[tab.id]?.leadTerminal` or first agent pane in `panes().filter(p => p.tab === tab.id)`).
   - Run `hc(["get", terminalId, "--json"])` to inspect `first_message`, `title`, `labels`, and `name`. If `first_message` is absent, run `hc(["read", terminalId, "--lines", "40"])` and parse the first non-boilerplate user prompt line.
   - Read current Git branch on the active microservice / workspace root using lock-free Git (`git --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false rev-parse --abbrev-ref HEAD`).
3. **Derivation Rules**:
   - Extract Jira key via `/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/` from `first_message`, terminal `title`, or `branch`.
   - Summarize `first_message` (strip markdown punctuation, filler verbs like `"please"`, `"can you"`, collapse whitespace, cap summary around ~28–36 chars).
   - Compose `name`: `${ticket} ${summary}` if both exist; else `${ticket} ${branchSlug}` or `${summary}` or clean branch slug (`feat/foo` → `foo`).
4. **Application**: Call `run("tab.rename", { id: tab.id, name })` only when derived `name` differs from current `tab.name` and avoid repeating failed/unchanged attempts via per-tab derivation cache.

### 2. `findActiveAgent()` Priority Resolution (`changes-review`, `mesh-test`, `mesh-ship`)

```text
1. mesh.flows[activeTabId]?.leadTerminal -> match in agents() or terminals()
2. focused()?.agent                     -> match in agents()
3. panes() in activeTabId with agent    -> prefer non-runner agent (excluding panes labeled meshRunner=true)
4. agents() in activeTabId              -> first agent in tab
5. agents()[0]                          -> global fallback
```

- When a user spawns `+ Service Runner` in `mesh-test`, the runner terminal is tagged (e.g., via `hc run --label meshRunner=true` or tracked in tab state) and NEVER replaces `mesh.flows[tabId].leadTerminal`.

### 3. `Checks` Discovery in `changes-review`

For each target microservice (`activeService === "all"` → dirty services or all services; else selected service), inspect root files in priority order via `readTextFile`:
1. `AGENTS.md`, `CLAUDE.md`, `SPEC.md`: parse fenced shell commands or explicit `Checks:` / `Verification:` / `Test:` commands (`npm test`, `npm run lint`, `mvn test`, `cargo test`, `go test ./...`, etc.).
2. `package.json`: detect `scripts.lint`, `scripts.typecheck`, `scripts.test`, `scripts.build`.
3. `pom.xml`: detect Maven (`./mvnw test` or `mvn test`).
4. `Cargo.toml`: detect Cargo (`cargo check`, `cargo test`).
5. `Makefile`: detect standard targets (`lint`, `test`, `check`).
Execute selected commands via `exec(cmd, args, { cwd: service.root, on, timeout: 120000 })`, capture stdout/stderr tail and exit code, and allow dispatching failing output to `leadTerminal`.

---

## Concurrency, Watcher Debouncing, and Lock-Free Safeguards

1. **Lock-Free Git Invariant**:
   Every read-only `git` invocation across `mesh-flow`, `changes-review`, `mesh-ship`, and `mesh-status` MUST prepend:
   ```javascript
   const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
   ```
2. **Bounded `watchFolder` + Visible Polling Fallback**:
   - `mesh-test` watches ONLY `${appHome()}/mesh/workspaces/<workspaceHash>/test-plans` (a flat folder containing only `<tabId>.json` files, safely staying far below Linux's 4096-directory `watchFolder` cap).
   - Debounces burst filesystem events (`150ms` coalescing window) before re-reading `<tabId>.json`.
   - When the `#test` panel is visible, runs a lightweight `1500ms` fallback timer (required for remote SSH spaces where `watchFolder` does not fire and as a safety net against coalesced writes); pauses/cancels the timer when `#test` is hidden or closed.
3. **Optimistic Atomic Writes (`writeTextFile`)**:
   - Updating `approved: true`, manual `curl` re-run results, or `pr-template.md` MUST use Herdr's `writeTextFile(path, nextText, expectedText)` compare-and-swap API. On stale snapshot rejection, re-read the file, merge the field-level mutation (`approved` or specific `case` entry), and retry once without clobbering concurrent agent test status updates.
4. **Non-Reentrant Shared Bus Updates**:
   - Readers updating `mesh.flows`, `mesh.pipelineConfig`, `mesh.spacePanels`, or `mesh.testAlert` MUST compare serialized/timestamp values before calling `setShared(...)` to prevent infinite render loops.
   - `mesh-tabs` preserves `pending = { want, until: Date.now() + 1000 }` when transitioning spaces so stale `layout()` reads do not overwrite `mesh.spacePanels[spaceId]`.
5. **Subprocess Cancellation & Timeouts**:
   - Auto-naming `hc` probes cache per `(tabId, terminalId)` with cooldown (`>= 3000ms` while unnamed; stops once named or `manualTitle` is set).
   - `ss -tln` TCP port checks run at most once every `3000ms` while `#test` is active and use bounded `exec` timeouts (`5000ms`).
   - `gh` queries in `mesh-ship` run in parallel per microservice with `15000ms` timeout and rate-limited manual/tab-switch refresh rather than tight background loops.
