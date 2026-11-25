// Shared runtime diagnostic logger, JSON report exporter, and GPUI error fallback card.
// Synced across all 5 active mods via scripts/sync-shared.mjs & install.sh.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as fsPromises from "fs/promises";
import { join } from "path";
import { appHome, window as herdrWindow, spaces, shared, setShared, notify } from "herdr";
import {
  DIAGNOSTICS_SCHEMA_VERSION,
  DEFAULT_MAX_RING_ENTRIES,
  DEFAULT_MAX_REPORT_FILES,
  DEFAULT_REPORT_MAX_AGE_MS,
  createRingBuffer,
  normalizeLogEntry,
  serializeError,
  sanitizeLogPayload,
  mergeModLogEntries,
  buildDiagnosticReport,
  formatReportFilename,
  selectReportsToPrune,
} from "./diagnostics-logic.js";

const DEFAULT_FLUSH_DEBOUNCE_MS = 2000;
const RENDER_ERROR_DEDUPE_MS = 1500;
const COGNIVISOR_VERSION = "1.0.0";

function safeAppHome(getAppHomeFn) {
  try {
    const fn = typeof getAppHomeFn === "function" ? getAppHomeFn : appHome;
    return typeof fn === "function" ? String(fn() || "") : "";
  } catch {
    return "";
  }
}

function safeModSlug(modName) {
  return String(modName || "mod")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "mod";
}

function readPlainObj(val) {
  return val && typeof val === "object" && !Array.isArray(val) ? val : {};
}

function buildDefaultStateSnapshot(sharedFn, spacesFn) {
  const getShared = typeof sharedFn === "function" ? sharedFn : shared;
  const getSpaces = typeof spacesFn === "function" ? spacesFn : spaces;
  let allSpaces = [];
  try {
    allSpaces = getSpaces() || [];
  } catch {
    allSpaces = [];
  }
  const activeSpace = allSpaces.find((s) => s?.active) || null;
  const activeTab = (activeSpace?.tabs || []).find((t) => t?.active) || null;

  let servicesBus = null;
  let flowsBus = null;
  let panelsBus = null;
  let diagBus = null;
  try {
    servicesBus = getShared("cognivisor.services");
    flowsBus = getShared("cognivisor.flows");
    panelsBus = getShared("cognivisor.spacePanels");
    diagBus = getShared("cognivisor.diagnostics");
  } catch {
    // non-fatal
  }

  const services = Array.isArray(servicesBus?.services)
    ? servicesBus.services.slice(0, 20).map((s) => ({
        id: s?.id || "",
        name: s?.name || "",
        branch: s?.branch || "",
        workingCount: Number(s?.workingCount) || 0,
        aheadCount: Number(s?.aheadCount) || 0,
      }))
    : [];

  const activeFlow = activeTab?.id ? readPlainObj(readPlainObj(flowsBus)[activeTab.id]) : {};
  const baseline = activeFlow?.sessionBaseline && typeof activeFlow.sessionBaseline === "object"
    ? activeFlow.sessionBaseline
    : null;
  const baselineRepos = baseline?.repos && typeof baseline.repos === "object" ? Object.values(baseline.repos) : [];
  let baselineDirtyCount = 0;
  for (const r of baselineRepos) {
    if (r?.dirtyFiles && typeof r.dirtyFiles === "object") {
      baselineDirtyCount += Object.keys(r.dirtyFiles).length;
    }
  }

  return {
    environment: {
      platform: (() => {
        try {
          return herdrWindow()?.platform || "unknown";
        } catch {
          return "unknown";
        }
      })(),
      cognivisorVersion: COGNIVISOR_VERSION,
      activeSpaceId: activeSpace?.id || null,
      activeTabId: activeTab?.id || null,
      workspaceRoot: servicesBus?.workspaceRoot || activeSpace?.folder || null,
      activePanel: activeSpace?.id ? (readPlainObj(panelsBus)[activeSpace.id] ?? null) : null,
    },
    stateSnapshot: {
      servicesCount: services.length,
      services,
      baselineSummary: baseline
        ? {
            startedAt: baseline.startedAt || 0,
            repoCount: baselineRepos.length,
            dirtyFilesCount: baselineDirtyCount,
          }
        : (activeFlow.sessionStartedAt || activeFlow.baselineRev || Array.isArray(activeFlow.sessionRepos))
          ? {
              startedAt: Number(activeFlow.sessionStartedAt) || 0,
              baselineRev: Number(activeFlow.baselineRev) || 0,
              sessionReposCount: Array.isArray(activeFlow.sessionRepos) ? activeFlow.sessionRepos.length : 0,
              storage: "disk",
            }
          : null,
      diagnostics: diagBus ? {
        errorCount: Number(diagBus.errorCount) || 0,
        lastErrorMod: diagBus.lastErrorMod || null,
        lastErrorEvent: diagBus.lastErrorEvent || null,
        ...(diagBus.lastErrorSummary ? { lastErrorSummary: String(diagBus.lastErrorSummary) } : {}),
        ...(Number(diagBus.lastErrorAt) > 0 ? { lastErrorAt: Number(diagBus.lastErrorAt) } : {}),
      } : null,
    },
  };
}

/**
 * Create a per-mod bounded diagnostic logger with debounced async disk persistence,
 * non-reentrant render error capture, and one-click merged JSON report export.
 */
export function createModLogger(modName, opts = {}) {
  const mod = safeModSlug(modName);
  const fsDeps = opts.fsDeps || fsPromises;
  const getAppHomeFn = opts.getAppHome || appHome;
  const sharedFn = opts.sharedFn || shared;
  const setSharedFn = opts.setSharedFn || setShared;
  const notifyFn = opts.notifyFn || notify;
  const spacesFn = opts.spacesFn || spaces;
  const flushDebounceMs = Number.isFinite(Number(opts.flushDebounceMs))
    ? Math.max(0, Number(opts.flushDebounceMs))
    : DEFAULT_FLUSH_DEBOUNCE_MS;

  const ring = createRingBuffer(opts.maxEntries || DEFAULT_MAX_RING_ENTRIES);
  let seq = 0;
  let dirty = false;
  let flushing = false;
  let disposed = false;
  let flushTimer = null;
  let lastRenderErrKey = "";
  let lastRenderErrTs = 0;

  function getLogsDir() {
    const home = safeAppHome(getAppHomeFn);
    if (!home) return "";
    return join(home, "cognivisor", "logs");
  }

  function getModLogPath() {
    const dir = getLogsDir();
    return dir ? join(dir, `mod-${mod}.json`) : "";
  }

  function cancelFlushTimer() {
    if (flushTimer) {
      try {
        if (typeof flushTimer.cancel === "function") flushTimer.cancel();
        else clearTimeout(flushTimer);
      } catch {
        // non-fatal
      }
      flushTimer = null;
    }
  }

  async function flushNow() {
    if (disposed || flushing || !dirty) return false;
    const logPath = getModLogPath();
    const logsDir = getLogsDir();
    if (!logPath || !logsDir) return false;
    flushing = true;
    const maxEntries = ring.capacity || DEFAULT_MAX_RING_ENTRIES;
    let wroteAny = false;
    try {
      const mk = typeof fsDeps?.mkdir === "function" ? fsDeps.mkdir : fsPromises.mkdir;
      const rf = typeof fsDeps?.readFile === "function" ? fsDeps.readFile : fsPromises.readFile;
      const wr = typeof fsDeps?.writeFile === "function" ? fsDeps.writeFile : fsPromises.writeFile;
      await mk(logsDir, { recursive: true });
      // Up to 2 passes so an error recorded mid-flush is never left unflushed.
      for (let pass = 0; pass < 2 && dirty && !disposed; pass += 1) {
        dirty = false;
        let existingEntries = [];
        if (typeof rf === "function") {
          try {
            const rawText = await rf(logPath, "utf8");
            const parsed = JSON.parse(rawText);
            if (parsed && Array.isArray(parsed.entries)) {
              existingEntries = parsed.entries;
            }
          } catch {
            // file may not exist yet or be unreadable
          }
        }
        const mergedEntries = mergeModLogEntries(existingEntries, ring.toArray(), {
          mod,
          maxEntries,
        });
        const payload = {
          schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
          mod,
          updatedAt: Date.now(),
          entries: mergedEntries,
        };
        await wr(logPath, JSON.stringify(payload), "utf8");
        wroteAny = true;
      }
      return wroteAny;
    } catch {
      return false;
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush(immediate = false, cx = null) {
    if (disposed) return;
    if (immediate) {
      cancelFlushTimer();
      if (cx?.timer?.after) {
        flushTimer = cx.timer.after(0, () => {
          flushTimer = null;
          flushNow().catch(() => {});
        });
      } else {
        flushNow().catch(() => {});
      }
      return;
    }
    if (flushTimer) return;
    if (cx?.timer?.after) {
      flushTimer = cx.timer.after(flushDebounceMs, () => {
        flushTimer = null;
        flushNow().catch(() => {});
      });
    } else if (typeof setTimeout === "function") {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushNow().catch(() => {});
      }, flushDebounceMs);
    } else {
      flushNow().catch(() => {});
    }
  }

  function publishErrorBadge(event, errSummary) {
    try {
      const prev = readPlainObj(sharedFn("cognivisor.diagnostics"));
      setSharedFn("cognivisor.diagnostics", {
        ...prev,
        errorCount: (Number(prev.errorCount) || 0) + 1,
        lastErrorAt: Date.now(),
        lastErrorMod: mod,
        lastErrorEvent: String(event || "error"),
        lastErrorSummary: String(errSummary || ""),
        ts: Date.now(),
      });
    } catch {
      // non-fatal
    }
  }

  function record(level, event, data = undefined, err = undefined, durationMs = undefined, cx = null, deferBadge = false) {
    if (disposed) return null;
    seq += 1;
    const entry = normalizeLogEntry(
      {
        ts: Date.now(),
        seq,
        mod,
        level,
        event,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(data !== undefined ? { data } : {}),
        ...(err !== undefined ? { error: serializeError(err) } : {}),
      },
      mod,
    );
    if (!entry) return null;
    ring.push(entry);
    dirty = true;
    const isErr = level === "error";
    scheduleFlush(isErr, cx);
    if (isErr) {
      const summary = entry.error ? `${entry.error.name}: ${entry.error.message}` : event;
      if (deferBadge && cx?.timer?.after) {
        cx.timer.after(0, () => publishErrorBadge(event, summary));
      } else if (!deferBadge) {
        publishErrorBadge(event, summary);
      }
    }
    return entry;
  }

  async function readAllModStreams() {
    const logsDir = getLogsDir();
    const streams = [{ mod, entries: ring.toArray() }];
    if (!logsDir) return streams;
    const rd = typeof fsDeps?.readdir === "function" ? fsDeps.readdir : fsPromises.readdir;
    const rf = typeof fsDeps?.readFile === "function" ? fsDeps.readFile : fsPromises.readFile;
    let names = [];
    try {
      names = await rd(logsDir);
    } catch {
      return streams;
    }
    for (const rawName of Array.isArray(names) ? names : []) {
      const name = typeof rawName === "string" ? rawName : rawName?.name;
      if (!name || !name.startsWith("mod-") || !name.endsWith(".json")) continue;
      const streamMod = name.slice("mod-".length, -".json".length);
      if (streamMod === mod) continue;
      try {
        const text = await rf(join(logsDir, name), "utf8");
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.entries)) {
          streams.push({ mod: parsed.mod || streamMod, entries: parsed.entries });
        }
      } catch {
        // skip unreadable/corrupt stream
      }
    }
    return streams;
  }

  async function pruneOldDiagnostics(diagDir) {
    const rd = typeof fsDeps?.readdir === "function" ? fsDeps.readdir : fsPromises.readdir;
    const st = typeof fsDeps?.stat === "function" ? fsDeps.stat : fsPromises.stat;
    const ul = typeof fsDeps?.unlink === "function" ? fsDeps.unlink : fsPromises.unlink;
    if (typeof rd !== "function" || typeof ul !== "function") return;
    let names = [];
    try {
      names = await rd(diagDir);
    } catch {
      return;
    }
    const entries = [];
    for (const rawName of Array.isArray(names) ? names : []) {
      const name = typeof rawName === "string" ? rawName : rawName?.name;
      if (!name || !name.endsWith(".json")) continue;
      let mtimeMs = 0;
      if (typeof st === "function") {
        try {
          const info = await st(join(diagDir, name));
          mtimeMs = Number(info?.mtimeMs) || 0;
        } catch {
          mtimeMs = 0;
        }
      }
      entries.push({ name, mtimeMs });
    }
    const toDelete = selectReportsToPrune(entries, {
      maxFiles: DEFAULT_MAX_REPORT_FILES,
      maxAgeMs: DEFAULT_REPORT_MAX_AGE_MS,
    });
    for (const name of toDelete) {
      try {
        await ul(join(diagDir, name));
      } catch {
        // non-fatal
      }
    }
  }

  async function exportReport({ trigger = "manual", extraState = null } = {}) {
    await flushNow();
    const logsDir = getLogsDir();
    if (!logsDir) {
      try {
        notifyFn({ title: "Diagnostic export unavailable", body: "Herdr appHome directory is not available.", level: "warning" });
      } catch {}
      return null;
    }
    const diagDir = join(logsDir, "diagnostics");
    const mk = typeof fsDeps?.mkdir === "function" ? fsDeps.mkdir : fsPromises.mkdir;
    const wr = typeof fsDeps?.writeFile === "function" ? fsDeps.writeFile : fsPromises.writeFile;

    const streams = await readAllModStreams();
    const baseSnap = buildDefaultStateSnapshot(sharedFn, spacesFn);
    const mergedState = extraState
      ? { ...baseSnap.stateSnapshot, modState: sanitizeLogPayload(extraState) }
      : baseSnap.stateSnapshot;

    const report = buildDiagnosticReport({
      trigger,
      environment: baseSnap.environment,
      stateSnapshot: mergedState,
      streams,
      maskHomeDir: true,
    });

    const filename = formatReportFilename(new Date());
    const reportPath = join(diagDir, filename);
    try {
      await mk(diagDir, { recursive: true });
      await wr(reportPath, JSON.stringify(report, null, 2), "utf8");
      await pruneOldDiagnostics(diagDir);
    } catch (err) {
      try {
        notifyFn({ title: "Failed to export diagnostics", body: String(err?.message || err || "Write error"), level: "error" });
      } catch {}
      return null;
    }

    try {
      const prev = readPlainObj(sharedFn("cognivisor.diagnostics"));
      setSharedFn("cognivisor.diagnostics", {
        ...prev,
        errorCount: 0,
        lastExportPath: reportPath,
        lastExportAt: Date.now(),
        ts: Date.now(),
      });
    } catch {
      // non-fatal
    }

    try {
      notifyFn({
        title: "Diagnostic report exported",
        body: reportPath,
        level: "success",
      });
    } catch {}
    return { reportPath, report };
  }

  return {
    mod,
    action(event, data, cx = null) {
      return record("action", event, data, undefined, undefined, cx, false);
    },
    lifecycle(event, data, cx = null) {
      return record("lifecycle", event, data, undefined, undefined, cx, false);
    },
    info(event, data, cx = null) {
      return record("info", event, data, undefined, undefined, cx, false);
    },
    warn(event, data, cx = null) {
      return record("warn", event, data, undefined, undefined, cx, false);
    },
    error(event, err, data, cx = null) {
      return record("error", event, data, err, undefined, cx, false);
    },
    perf(event, durationMs, data, cx = null) {
      return record("perf", event, data, undefined, durationMs, cx, false);
    },
    recordRenderError(err, data, cx = null) {
      const ser = serializeError(err);
      const dedupeKey = `${ser.type}:${ser.name}:${ser.message}`;
      const now = Date.now();
      if (dedupeKey === lastRenderErrKey && (now - lastRenderErrTs) < RENDER_ERROR_DEDUPE_MS) {
        return ser;
      }
      lastRenderErrKey = dedupeKey;
      lastRenderErrTs = now;
      record("error", "render.failed", data, err, undefined, cx, true);
      return ser;
    },
    getEntries() {
      return ring.toArray();
    },
    flush: flushNow,
    exportReport,
    dispose() {
      disposed = true;
      cancelFlushTimer();
    },
  };
}

/**
 * Render a themed GPUI-kit error fallback card when a view's render() catches an exception,
 * letting the user retry or export a merged JSON diagnostic report with one click.
 */
export function renderErrorFallbackCard({ modName = "mod", errorSummary = "Unexpected render error", t = {}, onRetry = null, onExport = null } = {}) {
  const errColor = t.blocked || t.ansi1 || t.foreground;
  return v_flex()
    .id(`diag-fallback-${safeModSlug(modName)}`)
    .size_full()
    .p(14)
    .gap(8)
    .items_start()
    .justify_center()
    .bg(t.background)
    .text_color(t.foreground)
    .child(
      v_flex()
        .w_full()
        .p(12)
        .gap(8)
        .rounded(8)
        .border_1()
        .border_color(t.border)
        .bg(t.raised || t.background)
        .child(
          div()
            .text_size(12)
            .font_semibold()
            .text_color(errColor)
            .child(`View render error (${modName})`),
        )
        .child(
          div()
            .w_full()
            .text_size(11)
            .text_color(t.muted || t.foreground)
            .child(String(errorSummary || "Unexpected render error")),
        )
        .child(
          h_flex()
            .gap(8)
            .pt(2)
            .items_center()
            .when(typeof onRetry === "function", (el) => el.child(
              div()
                .id(`diag-retry-${safeModSlug(modName)}`)
                .px(8)
                .py(4)
                .rounded(5)
                .border_1()
                .border_color(t.border)
                .bg(t.background)
                .text_size(11)
                .font_medium()
                .text_color(t.foreground)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover || t.raised))
                .on_click((_e, cx) => onRetry(cx))
                .child("Retry"),
            ))
            .when(typeof onExport === "function", (el) => el.child(
              div()
                .id(`diag-export-${safeModSlug(modName)}`)
                .px(8)
                .py(4)
                .rounded(5)
                .bg(t.solid || t.accent || t.raised)
                .text_size(11)
                .font_medium()
                .text_color(t.solid_foreground || t.foreground)
                .cursor_pointer()
                .on_click((_e, cx) => onExport(cx))
                .child("Export diagnostic JSON"),
            )),
        ),
    );
}
