---
id: goal-and-requirements
type: goal-and-requirements
status: active
title: Herdr Mesh — Goal and Requirements
covers: [multi-service-agent-ide, organic-tab-auto-naming, cross-repo-changes-review, workspace-files-search, git-history-comparison, session-scoped-repo-attribution, unified-layout]
tags: [root, requirements, herdr, microservices, agent-ide]
---

## Goal

Herdr Mesh transforms the Herdr desktop application into a focused **Multi-Microservice Agent Workspace**. In modern cloud-native systems, a single Jira ticket or feature frequently requires simultaneous edits across multiple independent services, frontend apps, and worker daemons—or an agent started inside one microservice ends up editing sibling repositories. Herdr Mesh creates an organic, terminal-first environment where developers start directly with an AI coding agent in a tab and get representative automatic tab names, session-scoped microservice visibility in the file tree and change reviewer, per-service diff inspection and approval tracking, and instant workspace search.

This document serves as the root requirement specification for the Herdr Mesh ecosystem, establishing product goals, user personas, core architectural principles, and required functional capabilities that govern the entire Fractal Spec-Graph (`[[architecture]]`, `[[spec-lifecycle]]`).

## Problem

Software engineering teams building distributed microservices face severe friction when adopting AI coding agents:

- **Repository Fragmentation & Noise Across Multi-Repo Workspaces:** Opening Herdr in a parent directory containing dozens of projects creates visual clutter if unrelated clean repos are shown, while opening in a single microservice obscures sibling repositories touched by the agent during the same session.
- **Agent Terminal Friction & Generic Tab Chaos:** Developers open terminal tabs and immediately launch CLI agents (`claude`, `gemini`, `codex`, `opencode`, `pi`, `antigravity`), leaving tabs named generically (`tb1`, `tb2`) instead of reflecting the ticket/prompt being worked on.
- **Fragmented Code Review & Approval Tracking:** In multi-repo environments, git status, diffs, and branch verification are scattered across distinct repositories. Reviewers need microservice-by-microservice inspection, per-service approval tracking, and direct dispatch back to the tab's lead agent.
- **Cross-Platform Performance Overhead:** Un-debounced `watchFolder` cascades, repeated repository scans across mods, uncached `git status --untracked-files=all`, or redundant `powershell` invocations degrade responsiveness on Windows, Linux, and macOS.

## Who it's for

Herdr Mesh is designed for software engineers, tech leads, and autonomous AI coding agents working within multi-service architectures:

1. **Multi-Service Full-Stack Developers:** Engineers implementing end-to-end features spanning frontend web apps (e.g., Angular), API gateways, backend microservices (Java/Node.js/Go/Rust), and shared libraries.
2. **AI Coding Agents (In-IDE Agents):** CLI agents operating inside Herdr terminal panes that benefit from direct feedback dispatch of code review notes.
3. **Engineering Leads & Reviewers:** Reviewers who inspect holistic diffs service by service, approve per-service modifications, and feed review notes directly to the tab's lead agent.

## Value

- **Organic Terminal-First Auto-Naming:** Developers open a terminal tab, launch any agent, and describe their ticket—`mesh-tabs` (`[[submodule-mod-mesh-tabs]]`) automatically extracts Jira keys (`[A-Z][A-Z0-9]{1,9}-\d+`) and summarizes the first prompt or branch into representative tab names without overwriting manual renames.
- **Session-Scoped Multi-Repo Discovery:** `files-search` (`[[submodule-mod-files-search]]`) and `changes-review` (`[[submodule-mod-changes-review]]`) show only the repositories touched/created during the current tab's session (including sibling repos outside the starting service), filtering out unrelated clean projects under `/Projects`.
- **Microservice-by-Microservice Review:** `changes-review` shows per-service branches, tracks per-service review checklists (`pending | has_notes | approved`), and advances through dirty microservices with `Approve Service ✓`.
- **Instant Global Navigation & Cross-Platform Performance:** `files-search` delivers cross-service fuzzy search and ripgrep preview while enforcing debounced watches, cached repo discovery, `mesh.services` bus sharing, native `fs/promises` scans on local OS, and lock-free Git inspection with zero `localStorage`.

## Principles

1. **Organic Terminal-First, Session-Scoped:** Developers start naturally in a terminal with an agent; tab naming, repository filtering, review checklists, and agent feedback adapt to that tab's specific session without rigid setup forms.
2. **Low-Overhead Cross-Platform Performance:** Mods MUST minimize subprocess spawning across Windows, Linux, and macOS by debouncing filesystem events, ignoring build/dependency artifacts (`target/`, `node_modules/`, `.git/`), sharing discovered services over `mesh.services`, throttling hidden views, and using native async filesystem APIs where applicable.
3. **Declarative Spec-Driven Governance:** Every architectural decision, module boundary, and state contract is declared in the Fractal Spec-Graph and OpenSpec (`[[spec-lifecycle]]`). Code never diverges from documented specs.
4. **Lock-Free Non-Interference & Native Persistence:** Background mods never collide with agent Git commands (strict lock-free flags) and never depend on browser `localStorage`; all persistence flows through Herdr `shared()`/`setShared()`.
5. **Native GPUI Performance & Decoupled Mods:** Fast startup, zero Electron overhead, 60fps scrolling, pure `render()` frames (zero synchronous `cx.notify()`/`setShared()` during `render()`), and decoupled mods communicating strictly via documented `mesh.*` shared state keys.

## Capabilities

- **Unified Multi-Service Layout (`[[module-layouts]]`):**
  - Top tab bar (`mesh-tabs`) with automatic Jira/prompt naming, double-click inline rename, `Files`/`Review`/`Git` toggles, and `mesh.spacePanels` persistence.
  - Expandable `#panel-body` stack hosting `files` (`files-search`), `changes` (`changes-review`), and `git` (`git-history`).
  - Bottom telemetry bar (`mesh-status`) summarizing host, session service/dirty counts, branch, agents, and palette hint.
- **Microservice Code Review (`[[submodule-mod-changes-review]]`):**
  - Per-service branch visibility, working-tree/commit diffs, expandable context (`git diff -U99999`), and inline notes.
  - Tab-scoped `reviewedServices` checklist (`pending | has_notes | approved`) and `Approve Service ✓` auto-advance across dirty services.
  - Direct review feedback dispatch to `leadTerminal` and multi-repo commit execution.
- **Workspace Search Everywhere & Multi-Repo Tree (`[[submodule-mod-files-search]]`):**
  - Multi-tab floating overlay (`All`, `Files`, `Text`) with ripgrep streaming, fixed-string fallback on invalid regex, clamped multi-pane preview, and docked session-scoped multi-repo file tree.
- **Git History & Before/After Commit Comparison (`[[submodule-mod-git-history]]`):**
  - Docked `#git` panel across all workspace repositories (clean and dirty) with branch/search filters, a GitKraken-style topological commit graph, and per-commit modified file inspection.
  - Single reusable `#main` comparison tab (`role: "viewer"`) rendering **Side-by-Side (`Before | After`)** and **Unified** commit diffs with in-place commit/file switching, lock-free read-only Git execution, and zero duplicate tabs.
- **Shared State Orchestration (`[[architecture]]`):**
  - Reactive `shared()` / `setShared()` bus using namespaced keys (`mesh.*`, `files-search.*`, `changes-review.*`, `git-history.*`) with zero `localStorage`.

## Non-Goals

- **Full Text Editor Replacement:** Herdr Mesh is a terminal-first Agent Workspace and orchestration platform; it does not attempt to embed an LSP text editor.
- **In-IDE E2E Test Orchestration or PR Management UI:** Dedicated `mesh-test`, `mesh-ship`, and `#flow` chrome modules are intentionally omitted; agents and developers run tests and GitHub PR workflows directly in terminals.
- **Direct Unregulated Subprocess Daemons:** Mods interact through standard Herdr interfaces (`hc`, `exec`, `run`, `shared()`) rather than spawning hidden unmanaged daemon processes.
- **Bypassing Herdr Shipped Layout Protections:** Modifying or overwriting Herdr's built-in `main.json`, `terminals.json`, `win98.json`, or core shipped mods is explicitly out of scope; Herdr Mesh distributes its own owned `layouts/mesh.json` and active mods.
