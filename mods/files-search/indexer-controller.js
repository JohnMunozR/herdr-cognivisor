// Headless background indexer mode controller (role: "indexer").
import { div } from "gpui-kit";
import { watchFolder, window } from "herdr";
import {
  INDEX_REBUILD_DEBOUNCE_MS,
  AGENT_PREWARM_DEBOUNCE_MS,
  analyzeWatchBatch,
  makeIndexKey,
  getCachedIndex,
  isIndexInFlight,
  hasOpenTerminalInSpace,
  restoreDiskIndex,
  shouldRefreshIndex,
  handleWatchForIndex,
  ensureWorkspaceIndex,
  claimRootWatcher,
  ownsRootWatcher,
  hasActiveRootWatcher,
  releaseRootWatcher,
  setIndexWatching,
} from "./indexer.js";
import {
  warmAllServiceSymbolIndices,
  invalidateIndexedFiles,
} from "./symbol-index.js";
import {
  syncSpaceAgentTabs,
  location,
  collectRegisteredServices,
  collectIndexedFilesByRoot,
  getSafeAppHome,
  discoverRepos,
} from "./workspace-io.js";

export class IndexerController {
  constructor(cx) {
    this._indexerClosed = false;
    this.indexerSyncTask = null;
    this.indexerPrewarmTask = null;
    this.indexerReindexTask = null;
    this.indexerWatchToken = null;
    this.indexerWatchKey = null;
    this.indexerWatchHandle = null;
    this.indexerWatchSeq = 0;
    this.indexerBuildKey = null;
    this.scheduleIndexerSync(cx, 50);
  }

  scheduleIndexerSync(cx, delayMs = AGENT_PREWARM_DEBOUNCE_MS) {
    if (this._indexerClosed || this.indexerSyncTask || !cx?.timer) return;
    this.indexerSyncTask = cx.timer.after(delayMs, cx => {
      this.indexerSyncTask = null;
      this.syncIndexer(cx);
    });
  }

  stopIndexerWatching() {
    if (this.indexerWatchHandle) {
      try { this.indexerWatchHandle.cancel(); } catch {}
      this.indexerWatchHandle = null;
    }
    if (this.indexerWatchKey && this.indexerWatchToken) {
      const prevKey = this.indexerWatchKey;
      releaseRootWatcher(prevKey, this.indexerWatchToken);
      setIndexWatching(prevKey, hasActiveRootWatcher(prevKey));
    }
    this.indexerWatchKey = null;
    this.indexerWatchToken = null;
  }

  watchForIndex(root, on, isWindows, indexKey, cx) {
    if (on || this._indexerClosed || hasActiveRootWatcher(indexKey)) return;
    const token = `idx-${++this.indexerWatchSeq}`;
    if (!claimRootWatcher(indexKey, token, false)) return;
    if (this.indexerWatchKey && this.indexerWatchKey !== indexKey) {
      this.stopIndexerWatching();
      if (!claimRootWatcher(indexKey, token, false)) return;
    }
    this.indexerWatchKey = indexKey;
    this.indexerWatchToken = token;
    setIndexWatching(indexKey, true);

    cx.spawn(async cx => {
      try {
        while (!this._indexerClosed && ownsRootWatcher(indexKey, token)) {
          try {
            const handle = watchFolder(root);
            this.indexerWatchHandle = handle;
            const changed = await handle;
            if (this.indexerWatchHandle === handle) this.indexerWatchHandle = null;
            if (this._indexerClosed || !ownsRootWatcher(indexKey, token)) break;
            if (!hasOpenTerminalInSpace()) break;
            if (!Array.isArray(changed) || changed.length === 0) continue;
            const info = analyzeWatchBatch(changed, root, null);
            if (!info.hasNonIgnored) continue;
            invalidateIndexedFiles(root, changed, on);
            const dirty = await handleWatchForIndex(root, on, isWindows, info, changed);
            if (dirty && !this._indexerClosed && ownsRootWatcher(indexKey, token) && hasOpenTerminalInSpace()) {
              this.scheduleIndexerReindex(root, on, isWindows, indexKey, cx);
            }
          } catch {
            if (this._indexerClosed || !ownsRootWatcher(indexKey, token)) break;
            await cx.sleep(3000);
          }
        }
      } finally {
        releaseRootWatcher(indexKey, token);
        setIndexWatching(indexKey, hasActiveRootWatcher(indexKey));
        if (this.indexerWatchToken === token) {
          this.indexerWatchToken = null;
          this.indexerWatchKey = null;
        }
      }
    });
  }

  scheduleIndexerReindex(root, on, isWindows, indexKey, cx) {
    if (this._indexerClosed) return;
    if (this.indexerReindexTask) {
      try { this.indexerReindexTask.cancel(); } catch {}
      this.indexerReindexTask = null;
    }
    this.indexerReindexTask = cx.timer.after(INDEX_REBUILD_DEBOUNCE_MS, cx => {
      this.indexerReindexTask = null;
      if (this._indexerClosed || !hasOpenTerminalInSpace()) return;
      const curLoc = location();
      const curIsWin = !curLoc.on && window()?.platform === "windows";
      if (!curLoc.cwd || makeIndexKey(curLoc.cwd, curLoc.on, curIsWin) !== indexKey) return;
      this.runAgentPrewarm(root, on, isWindows, indexKey, cx);
    });
  }

  runAgentPrewarm(root, on, isWindows, indexKey, cx) {
    if (this._indexerClosed || !root || this.indexerBuildKey === indexKey) return;
    this.indexerBuildKey = indexKey;
    cx.spawn(async cx => {
      try {
        if (!getCachedIndex(indexKey)) {
          await restoreDiskIndex(root, on, isWindows, cx);
        }
        if (this._indexerClosed || !hasOpenTerminalInSpace()) return;
        const curLoc = location();
        const curIsWin = !curLoc.on && window()?.platform === "windows";
        if (!curLoc.cwd || makeIndexKey(curLoc.cwd, curLoc.on, curIsWin) !== indexKey) return;

        const cached = getCachedIndex(indexKey);
        if (shouldRefreshIndex(cached, on)) {
          await ensureWorkspaceIndex({ root, on, isWindows, discoverRepos, cx });
        }
        // Skip eager background symbol indexing over SSH; Ctrl+Click resolves on demand via readTextFile/git grep.
        if (!this._indexerClosed && !on && hasOpenTerminalInSpace()) {
          const svcs = collectRegisteredServices();
          const indexedByRoot = collectIndexedFilesByRoot(svcs, root, on);
          warmAllServiceSymbolIndices({
            services: svcs,
            currentRoot: root,
            on,
            maxServices: 2,
            indexedFilesByRoot: indexedByRoot,
            appHomeDir: getSafeAppHome(),
            skipIfFreshMs: 15000,
            yieldFn: () => cx.sleep(0),
          }).catch(() => {});
        }
      } catch {
        // Prewarm failures remain silent and retry on next agent/watch trigger or manual overlay open.
      } finally {
        if (this.indexerBuildKey === indexKey) {
          this.indexerBuildKey = null;
        }
      }
    });
  }

  syncIndexer(cx) {
    if (this._indexerClosed) return;
    syncSpaceAgentTabs();
    const { cwd, on } = location();
    const isWindows = !on && window()?.platform === "windows";
    const agentOpen = Boolean(cwd && hasOpenTerminalInSpace());

    if (!agentOpen) {
      try { this.indexerPrewarmTask?.cancel(); } catch {}
      this.indexerPrewarmTask = null;
      try { this.indexerReindexTask?.cancel(); } catch {}
      this.indexerReindexTask = null;
      this.stopIndexerWatching();
      return;
    }

    const indexKey = makeIndexKey(cwd, on, isWindows);
    if (!on && !hasActiveRootWatcher(indexKey)) {
      this.watchForIndex(cwd, on, isWindows, indexKey, cx);
    }

    const cached = getCachedIndex(indexKey);
    if (shouldRefreshIndex(cached, on) && !isIndexInFlight(indexKey) && this.indexerBuildKey !== indexKey) {
      this.runAgentPrewarm(cwd, on, isWindows, indexKey, cx);
    }
  }

  render(cx) {
    this.scheduleIndexerSync(cx);
    return div().h(0).w(0);
  }

  close() {
    this._indexerClosed = true;
    try { this.indexerSyncTask?.cancel(); } catch {}
    this.indexerSyncTask = null;
    try { this.indexerPrewarmTask?.cancel(); } catch {}
    this.indexerPrewarmTask = null;
    try { this.indexerReindexTask?.cancel(); } catch {}
    this.indexerReindexTask = null;
    this.stopIndexerWatching();
  }
}
