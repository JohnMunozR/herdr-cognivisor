---
id: change-diagnostic-logging
type: task-spec
status: active
title: Diagnostic Logging Policy & JSON Report Export
parent: architecture
covers: [diagnostic-logging, user-action-breadcrumbs, render-error-boundary, json-report-export]
tags: [openspec, diagnostics, logging, shared, observability]
---

## Summary

Add a cross-mod, privacy-safe diagnostic logging policy and one-click JSON report export across all 5 active Herdr Cognivisor mods (`changes-review`, `files-search`, `git-history`, `cognivisor-tabs`, `cognivisor-status`).

## Impact Analysis

- **Shared Modules (`[[module-shared]]`):** Adds `shared/diagnostics-logic.js` (zero-dependency pure engine) and `shared/diagnostics.js` (thin runtime + GPUI fallback adapter), synced to all 5 active mods via `scripts/sync-shared.mjs` and `install.sh`.
- **Shared Bus (`[[architecture]]`):** Adds `cognivisor.diagnostics` (`{ errorCount, lastErrorAt, lastErrorMod, lastErrorEvent, lastExportPath, ts }`) produced asynchronously by any mod encountering an error and consumed by `cognivisor-status`.
- **Layouts & Shortcuts:** Zero changes to `layouts/cognivisor.json`, Herdr shipped layouts (`main.json`, `terminals.json`, `win98.json`), or `keys.json`. Full backwards-compatibility preserved.
- **Persistence:** Per-mod rolling JSON logs under `${appHome()}/cognivisor/logs/mod-<mod>.json` and merged user-exportable reports under `${appHome()}/cognivisor/logs/diagnostics/cognivisor-report-YYYYMMDD-HHmmss.json` (auto-pruned).

## Acceptance Criteria

1. Pure logic in `shared/diagnostics-logic.js` handles `Error`, `null`, `undefined`, and primitive exceptions without throwing, redacts secrets and home-directory prefixes, enforces bounded ring buffers, and merges multi-mod timelines chronologically.
2. Normal `render()` frames incur zero logging allocations, zero filesystem I/O, and zero synchronous `setShared()`/`cx.notify()` calls.
3. Render exceptions in instrumented mods are caught by a non-reentrant boundary that schedules async persistence/bus notification and displays a themed fallback card with **Retry** and **Export diagnostic JSON** actions.
4. `cognivisor-status` displays a compact diagnostic export control (highlighting `⚠ N` when unread errors exist) that writes a merged `.json` report and notifies the user with the file path.
5. `npm test`, `node scripts/sync-shared.mjs --check`, and `herdr-app check` pass across all mods.
