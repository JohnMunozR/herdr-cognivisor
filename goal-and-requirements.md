---
id: goal-and-requirements
type: goal-and-requirements
status: active
title: Herdr Mesh — Goal and Requirements
covers: [multi-service-agent-ide, organic-tab-auto-naming, six-stage-lifecycle-pipeline, cross-repo-changes-review, live-agent-testing, multi-service-pr-promotion, workspace-files-search, feature-scoped-agent-terminals, unified-layout]
tags: [root, requirements, herdr, microservices, agent-ide, lifecycle]
---

## Goal

Herdr Mesh transforms the Herdr desktop application into a specialized **Multi-Microservice Agent IDE** covering the entire engineering lifecycle (`Plan → Build → Review → Test → PR → dev → CI → main`). In modern cloud-native systems, a single Jira ticket or feature frequently requires simultaneous edits across multiple independent services, frontend apps, and worker daemons. Herdr Mesh creates an organic, terminal-first environment where developers start directly with an AI coding agent in a tab and progress seamlessly through multi-repo implementation, service-by-service review, automated API and Playwright E2E verification, and templated multi-service GitHub Pull Request promotion.

This document serves as the root requirement specification for the Herdr Mesh ecosystem, establishing product goals, user personas, core architectural principles, and required functional capabilities that govern the entire Fractal Spec-Graph (`[[architecture]]`, `[[spec-lifecycle]]`).

## Problem

Software engineering teams building distributed microservices face severe friction when adopting AI coding agents:

- **Repository Fragmentation Across Multi-Repo Workspaces:** Features routinely touch backend APIs, frontend clients, shared contract libraries, and infrastructure scripts. Traditional IDEs force developers into siloed single-repository windows or awkward multi-root workspaces where agents lose holistic context.
- **Agent Terminal Friction & Generic Tab Chaos:** Developers open terminal tabs and immediately launch CLI agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`), leaving tabs named generically (`tb1`, `tb2`) and obscuring which terminal owns the feature (`leadTerminal`) versus auxiliary service runners.
- **Fragmented Code Review & Repo Standard Verification:** In multi-repo environments, git status, diffs, branch verification, and build/lint checks are scattered across distinct repositories. Reviewers need microservice-by-microservice inspection, per-service approval tracking, automated checks, and direct dispatch back to the tab's lead agent.
- **Polluted Working Trees & Blind Local Testing:** Ad-hoc curl scripts, test plans, and Playwright E2E screenshots frequently litter microservice Git working trees, while developers lack live visibility into running local ports (`ss -tln`), service runner panes, and E2E visual results.
- **Inconsistent Multi-Service PRs & Branch Promotion:** Raising coordinated Pull Requests across 3–5 repositories (`feature → development → ci → main`), enforcing consistent PR templates, and feeding GitHub PR review threads back to coding agents are tedious manual chores.

## Who it's for

Herdr Mesh is designed for software engineers, tech leads, and autonomous AI coding agents working within multi-service architectures:

1. **Multi-Service Full-Stack Developers:** Engineers implementing end-to-end features spanning frontend web apps (e.g., Angular), API gateways, backend microservices (Java/Node.js/Go/Rust), and database migrations.
2. **AI Coding Agents (In-IDE Agents):** CLI agents operating inside Herdr terminal panes that require coordinated cross-service task execution, zero-pollution test-plan workspaces, and automated review/test/PR feedback loops.
3. **Engineering Leads & Reviewers:** Reviewers who inspect holistic diffs service by service, run repository standard checks, approve test plans and visual E2E screenshots, and dispatch review or PR comments directly to the lead agent.
4. **Platform & DevOps Engineers:** Engineers maintaining microservice fleet workspaces, branch promotion pipelines (`development → ci → main`), shared PR templates, and developer experience tooling.

## Value

- **Organic Terminal-First Workflow & Auto-Naming:** Developers open a terminal tab, launch any agent, and describe their ticket—`mesh-tabs` (`[[submodule-mod-mesh-tabs]]`) and `mesh-flow` (`[[submodule-mod-mesh-flow]]`) automatically extract Jira keys (`[A-Z][A-Z0-9]{1,9}-\d+`) and summarize the first prompt or branch into representative tab names without overwriting manual renames.
- **Tab-Scoped Six-Stage Lifecycle:** `#flow` (`1. Plan` → `2. Build` → `3. Review` → `4. Test` → `5. PR → dev` → `6. CI → main`) tracks each feature tab's progress and automatically opens the corresponding IDE drawer (`changes`, `test`, `ship`).
- **Microservice-by-Microservice Review & Checks:** `changes-review` (`[[submodule-mod-changes-review]]`) shows per-service branches, tracks per-service review checklists (`pending | has_notes | approved`), advances through dirty microservices with `Approve Service ✓`, and runs repo standard `Checks`.
- **Zero-Pollution Live Testing & Playwright E2E:** `mesh-test` (`[[submodule-mod-mesh-test]]`) stores test plans and screenshots under `${appHome()}/mesh/`, monitors live test execution, detects local ports (`ss -tln`), launches `+ Service Runner` split panes, renders Playwright PNGs inline with click-to-zoom, and feeds failures back to the agent.
- **Templated Multi-Service PRs & Promotion:** `mesh-ship` (`[[submodule-mod-mesh-ship]]`) enforces unified PR templates across services, tracks live GitHub PR CI/review threads via `gh`, sends unresolved review comments to the agent, and supports single or batch branch promotion (`development → ci → main`).
- **Instant Global Navigation & Zero Lock Contention:** `files-search` (`[[submodule-mod-files-search]]`) delivers cross-service fuzzy search and ripgrep preview while all mods enforce strict lock-free Git inspection and zero `localStorage` usage.

## Principles

1. **Organic Terminal-First, Feature-Scoped:** Developers start naturally in a terminal with an agent; IDE stages, auto-naming, review checklists, test plans, and PR tracking adapt to the tab's work unit without rigid pre-setup forms.
2. **Zero Repository Pollution:** Runtime test plans, temporary screenshots, and IDE metadata MUST live under Herdr's application directory (`${appHome()}/mesh/`) or shared state bus (`shared()`), never dirtying microservice Git working trees.
3. **Declarative Spec-Driven Governance:** Every architectural decision, module boundary, and state contract is declared in the Fractal Spec-Graph and OpenSpec (`[[spec-lifecycle]]`). Code never diverges from documented specs.
4. **Lock-Free Non-Interference & Native Persistence:** Background mods never collide with agent Git commands (strict lock-free flags) and never depend on browser `localStorage`; all persistence flows through Herdr `shared()`/`setShared()` and atomic `writeTextFile()`.
5. **Native GPUI Performance & Decoupled Mods:** Fast startup, zero Electron overhead, 60fps scrolling, native GPUI `image()` screenshot rendering, and decoupled mods communicating strictly via documented `mesh.*` shared state keys.

## Capabilities

- **Unified Multi-Service Lifecycle Layout (`[[module-layouts]]`):**
  - Top tab bar (`mesh-tabs`) with automatic Jira/prompt naming, 1-click inline rename, panel toggles, and `mesh.spacePanels` persistence.
  - Tab-scoped 6-stage pipeline bar (`mesh-flow` at `#flow`, `38px`) with `Auto` name re-sync and `leadTerminal` targeting.
  - Expandable `#panel-body` stack hosting `files` (`files-search`), `changes` (`changes-review`), `test` (`mesh-test`), and `ship` (`mesh-ship`).
  - Bottom telemetry bar (`mesh-status`) summarizing stage, service status, live test alerts, and PR review status.
- **Microservice Code Review & Repo Checks (`[[submodule-mod-changes-review]]`):**
  - Per-service branch visibility, working-tree/commit diffs, expandable context (`git diff -U99999`), and inline notes.
  - Tab-scoped `reviewedServices` checklist (`pending | has_notes | approved`) and `Approve Service ✓` auto-advance across dirty services.
  - Repository standards `Checks` inspector (`AGENTS.md`, `CLAUDE.md`, `SPEC.md`, `package.json`, `pom.xml`, `Cargo.toml`, `Makefile`) with failure dispatch to `leadTerminal`.
- **Live Agent-Driven Testing & Playwright E2E (`[[spec-lifecycle]]`):**
  - `Ask Agent for Test Plan`, human `Approve Plan`, live `watchFolder` + polling updates for `curl` and Playwright `e2e` cases (`headed` / `headless`), `ss -tln` port detection, `+ Service Runner` split panes, manual `curl` re-run, inline GPUI `image()` PNGs with zoom overlay, and `Send Failures to Agent`.
- **Multi-Service GitHub Promotion & PR Templates (`[[spec-lifecycle]]`):**
  - Configurable promotion chain (`["development", "ci", "main"]` default) with per-repo overrides, shared PR template (`{{ticket}}`, `{{title}}`, `{{services}}`, `{{summary}}`, `{{testSummary}}`), live `gh` PR/CI/review-thread monitoring, `Send Review Comments to Agent`, and single/batch promotion PRs.
- **Workspace Search Everywhere (`[[submodule-mod-files-search]]`):**
  - Multi-tab floating overlay (`All`, `Files`, `Text`) with ripgrep streaming, syntax preview, and docked multi-repo file tree.
- **Shared State Orchestration (`[[architecture]]`):**
  - Reactive `shared()` / `setShared()` bus using namespaced keys (`mesh.*`, `files-search.*`, `changes-review.*`) with zero `localStorage`.

## Non-Goals

- **Full Text Editor Replacement:** Herdr Mesh is an Agent IDE and terminal orchestration platform; it does not attempt to embed a heavy language server protocol (LSP) text editor (developers use their preferred editor or terminal agent).
- **Interactive Git History Rewriting from UI:** While `changes-review` supports working-tree commits and `mesh-ship` orchestrates PR creation and branch promotion via `gh`, destructive or complex Git history operations (interactive rebases, force-pushes, merge conflict resolution) remain in terminal CLI sessions.
- **Direct Unregulated Subprocess Daemons:** Mods communicate with agents through standard Herdr interfaces (`hc`, `exec`, `run`, `shared()`) rather than spawning hidden unmanaged daemon processes outside Herdr's terminal/pane lifecycle.
- **Bypassing Herdr Shipped Layout Protections:** Modifying or overwriting Herdr's built-in `main.json`, `terminals.json`, `win98.json`, or core shipped mods is explicitly out of scope; Herdr Mesh distributes its own owned `layouts/mesh.json` and `mesh-*` mods.
