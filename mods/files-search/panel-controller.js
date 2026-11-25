// Docked #files explorer panel controller.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import * as fsPromises from "fs/promises";
import {
  spaces, panes, agents, hc, exec, watchFolder,
  theme, window, openOverlay, shared, setShared,
} from "herdr";
import {
  INDEX_REBUILD_DEBOUNCE_MS,
  AGENT_PREWARM_DEBOUNCE_MS,
  normPathStr,
  normCmpStr,
  isSameOrChildPath,
  joinSubPath,
  analyzeWatchBatch,
  runInBatches,
  makeIndexKey,
  getCachedIndex,
  isIndexInFlight,
  hasOpenTerminalInSpace,
  restoreDiskIndex,
  shouldRefreshIndex,
  handleWatchForIndex,
  ensureWorkspaceIndex,
  claimRootWatcher,
  hasActiveRootWatcher,
  releaseRootWatcher,
  setIndexWatching,
} from "./indexer.js";
import {
  parsePorcelainHeader,
  resolveFileIcon,
  resolveViewerFilePath,
  buildFileViewerKey,
} from "./search-logic.js";
import { invalidateIndexedFiles } from "./symbol-index.js";
import {
  resolveCachedCascade,
  MAX_CASCADE_DEPTH,
  sortDirectoryEntries,
  matchesServiceFilter,
  collectSubtreePaths,
  collectMissingAncestorPaths,
  buildTreeRows,
  runStagedCascade,
} from "./tree-logic.js";
import {
  normalizeGitStatusMark,
  normalizeSessionBaseline,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  resolveSessionStartTime,
  findRecentFlowWorkspaceBaseline,
  findRecentWorkspaceBaseline,
  pruneDiskSessionBaselines,
  compactFlowsMap,
  terminalHasResumeCommand,
  batchStatLocalPaths,
  resolveFileSigCached,
  filterSessionDirtyEntries,
} from "./session-baseline.js";
import {
  asPlainObject,
  syncSpaceAgentTabs,
  location,
  workspaceContextKey,
  resolveServiceForFile,
  openFileInTab,
  BASE_BRANCHES,
  REPO_CACHE_TTL_MS,
  WATCH_DEBOUNCE_MS,
  PER_FOLDER,
  TOTAL,
  MAX_CACHED_FOLDERS,
  MAX_CACHED_ENTRIES,
  FOLDER_PREWARM_LIMIT,
  FOLDER_PREWARM_CONCURRENCY,
  FOLDER_RELOAD_CONCURRENCY,
  PREWARM_SKIP_DIRS,
  isFilesVisible,
  getSafeAppHome,
  recordDirtyMarksAndCounts,
  repoAheadCount,
  SESSION_BASELINE_CACHE,
  FILE_SIG_CACHE,
  cacheSessionBaseline,
  safeReadFlows,
  discoverRepos,
  directory,
  directoryCascade,
} from "./workspace-io.js";

const BASELINE_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const GIT_STATUS_CONCURRENCY = 4;
const REPO_EVAL_CONCURRENCY = 3;
const SIG_HASH_BATCH_CONCURRENCY = 4;

export class PanelController {
  constructor(cx) {
    this._panelClosed = false;
    this.saved = new Map();
    this.entries = new Map();
    this.truncatedFolders = new Set();
    this.cachedEntryCount = 0;
    this.folders = new Set();
    this.pending = new Set();
    this.pendingTokens = new Map();
    this.pendingSeq = 0;
    this.prewarmTask = null;
    this.prewarmSeq = 0;
    this.treeScrollHandle = VirtualListScrollHandle.new();
    this.pendingScrollPath = null;
    this.selectedFile = null;
    this.lastSyncedViewerTabId = null;
    this.marks = {};
    this.dirCounts = {};
    this.dirMarks = {};
    this.serviceCounts = {};
    this.serviceFiles = {};
    this.services = [];
    this.repoRoots = new Set();
    this.serviceFilter = "all";
    this.lastPublishedServicesSig = null;
    this.lastSelectedTs = 0;
    this.lastActiveServiceTs = 0;
    this.lastShiftPress = 0;
    this.candidateCache = null;
    this.dirtyFolders = new Set();
    this.watchDebounceTask = null;
    this.watchReindexTask = null;
    this.agentPrewarmTask = null;
    this.panelWatchSeq = 0;
    this.panelWatchToken = null;
    this.panelWatchKey = null;
    this.panelWatchHandle = null;
    this.pendingRefreshOpts = null;
    this.pendingPanelSyncTask = null;
    this.pollTimerTask = null;
    this.wasVisible = isFilesVisible();
    this.needsFolderReloadOnShow = false;
    this.lastBgPollAt = Date.now();
    this.lastBaselinePruneAt = 0;
    this.recentBaselineMisses = new Set();
    this.activeSessionTabId = null;
    this.context = null;
    this.root = null;
    this.on = null;
    this.watched = null;
    this.error = null;
    this.limited = false;
    this.loading = false;
    this.treeVersion = 1;
    this._treeRowsCache = null;
    this._treeRowsCacheVersion = 0;
    this.visibleRowByKey = null;
    this.panelHandle = cx.focus_handle();

    this.refresh(cx);
    this.pollTimerTask = cx.timer.every(30000, cx => {
      if (this._panelClosed) return;
      const now = Date.now();
      if (!isFilesVisible() && (now - this.lastBgPollAt) < 60000) return;
      this.lastBgPollAt = now;
      this.refresh(cx, { fromTimer: true });
    });
  }

  markTreeDirty() {
    this.treeVersion += 1;
  }

  clearError() {
    this.error = null;
  }

  stopPanelWatching() {
    if (this.panelWatchHandle) {
      try { this.panelWatchHandle.cancel(); } catch {}
      this.panelWatchHandle = null;
    }
    if (this.panelWatchKey && this.panelWatchToken) {
      releaseRootWatcher(this.panelWatchKey, this.panelWatchToken);
      setIndexWatching(this.panelWatchKey, hasActiveRootWatcher(this.panelWatchKey));
      this.panelWatchKey = null;
      this.panelWatchToken = null;
    }
    this.watched = null;
  }

  schedulePanelSync(cx) {
    if (this._panelClosed || this.pendingPanelSyncTask || !cx?.timer) return;
    this.pendingPanelSyncTask = cx.timer.after(0, cx => {
      this.pendingPanelSyncTask = null;
      if (this._panelClosed) return;
      this.syncPanelFromRender(cx);
    });
  }

  syncPanelFromRender(cx) {
    if (this._panelClosed) return;
    let dirty = false;
    syncSpaceAgentTabs();

    const locNow = location();
    const wsKeyNow = workspaceContextKey(locNow);
    const tabIdNow = locNow.tabId || null;
    const sameWorkspace = wsKeyNow === this.context?.key;
    const tabSwitchedInSameWorkspace = sameWorkspace && tabIdNow !== this.activeSessionTabId;
    const needsVisibleRecovery = isFilesVisible() && (
      !this.entries.has("") ||
      Boolean(this.error) ||
      this.needsFolderReloadOnShow ||
      this.dirtyFolders.size > 0
    );

    if (!sameWorkspace) {
      this.refresh(cx);
      dirty = true;
    } else if (needsVisibleRecovery) {
      const fromWatchOnly = this.dirtyFolders.size > 0 && this.entries.has("") && !this.error && !this.needsFolderReloadOnShow;
      this.refresh(cx, { fromWatch: fromWatchOnly });
      dirty = true;
    } else if (tabSwitchedInSameWorkspace) {
      this.refresh(cx, { gitOnly: true });
    }

    const activeReq = shared("cognivisor.activeService");
    if (activeReq && activeReq.ts && activeReq.ts > (this.lastActiveServiceTs || 0)) {
      this.lastActiveServiceTs = activeReq.ts;
      const isWin = Boolean(this.context?.isWindows);
      const normWorkspace = normCmpStr(activeReq.workspaceRoot, isWin);
      const normRoot = normCmpStr(this.root, isWin);
      if (!normWorkspace || normWorkspace === normRoot) {
        const nextFilter = activeReq.serviceId || "all";
        if (this.serviceFilter !== nextFilter) {
          this.serviceFilter = nextFilter;
          this.markTreeDirty();
          dirty = true;
          if (nextFilter !== "all") {
            const s = this.services?.find(x => x.id === nextFilter);
            if (s?.relPath) {
              this.expandAncestorFolders(s.relPath, cx, true);
            }
          }
        }
      }
    }

    const selectReq = shared("files-search.select");
    if (selectReq && selectReq.ts && selectReq.ts > (this.lastSelectedTs || 0)) {
      this.lastSelectedTs = selectReq.ts;
      if (selectReq.path) {
        let filePath = selectReq.path;
        const normSelectRoot = normPathStr(selectReq.root);
        const normPanelRoot = normPathStr(this.root);
        if (normSelectRoot && normPanelRoot && normSelectRoot !== normPanelRoot && normSelectRoot.startsWith(normPanelRoot + "/")) {
          const relPrefix = normSelectRoot.slice(normPanelRoot.length + 1);
          filePath = relPrefix ? `${relPrefix}/${filePath}` : filePath;
        }
        if (this.serviceFilter && this.serviceFilter !== "all") {
          const curService = this.services?.find(s => s.id === this.serviceFilter);
          if (curService?.relPath) {
            if (filePath !== curService.relPath && !filePath.startsWith(curService.relPath + "/")) {
              this.serviceFilter = "all";
              this.markTreeDirty();
            }
          }
        }
        this.openFromSearch(filePath, cx, selectReq.kind || "reveal");
        return;
      }
    }

    if (isFilesVisible()) {
      const activeSpace = (spaces() || []).find(s => s.active) || null;
      const activeTab = (activeSpace?.tabs || []).find(t => t.active) || null;
      const openFileTabs = asPlainObject(shared("cognivisor.openFileTabs"));
      const activeViewerEntry = activeTab?.id ? openFileTabs[activeTab.id] : null;
      if (activeViewerEntry && activeViewerEntry.tabId !== this.lastSyncedViewerTabId) {
        this.lastSyncedViewerTabId = activeViewerEntry.tabId;
        const nextSelected = resolveViewerFilePath(activeViewerEntry.root || this.root, activeViewerEntry.absPath || activeViewerEntry.path);
        if (nextSelected && nextSelected !== this.selectedFile) {
          this.selectedFile = nextSelected;
          dirty = true;
        }
      } else if (!activeViewerEntry && this.lastSyncedViewerTabId) {
        this.lastSyncedViewerTabId = null;
      }
    }

    if (dirty) cx.notify();
  }

  expandAncestorFolders(relPath, cx, includeSelf = true, loadIfVisible = true) {
    const clean = String(relPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    const segments = clean.split("/").filter(Boolean);
    const limit = includeSelf ? segments.length : Math.max(0, segments.length - 1);
    let accum = "";
    for (let i = 0; i < limit; i++) {
      accum = accum ? `${accum}/${segments[i]}` : segments[i];
      this.folders.add(accum);
    }
    this.markTreeDirty();

    const missing = collectMissingAncestorPaths(clean, this.entries, includeSelf);
    if (missing.length === 0) return;
    if (loadIfVisible && isFilesVisible()) {
      this.loadFoldersBatch(missing, cx);
    } else {
      this.needsFolderReloadOnShow = true;
    }
  }

  selectService(serviceId, cx) {
    this.serviceFilter = (this.serviceFilter === serviceId ? "all" : serviceId);
    this.markTreeDirty();
    if (this.serviceFilter !== "all") {
      const s = this.services?.find(x => x.id === this.serviceFilter);
      if (s?.relPath) {
        this.expandAncestorFolders(s.relPath, cx, true);
      }
    }
    this.lastActiveServiceTs = Date.now();
    setShared("cognivisor.activeService", {
      workspaceRoot: this.root,
      serviceId: this.serviceFilter,
      ts: this.lastActiveServiceTs,
    });
    cx.notify();
  }

  resetServiceFilter(cx) {
    this.serviceFilter = "all";
    this.markTreeDirty();
    this.lastActiveServiceTs = Date.now();
    setShared("cognivisor.activeService", {
      workspaceRoot: this.root,
      serviceId: "all",
      ts: this.lastActiveServiceTs,
    });
    cx.notify();
  }

  scheduleWatchRefresh(cx) {
    if (this._panelClosed) return;
    if (this.watchDebounceTask) {
      try { this.watchDebounceTask.cancel(); } catch {}
      this.watchDebounceTask = null;
    }
    const context = this.context;
    this.watchDebounceTask = cx.timer.after(WATCH_DEBOUNCE_MS, cx => {
      this.watchDebounceTask = null;
      if (this._panelClosed || !this.current(context)) return;
      this.refresh(cx, { fromWatch: true });
    });
  }

  scheduleWatchReindex(cx, delayMs = INDEX_REBUILD_DEBOUNCE_MS) {
    if (this._panelClosed) return;
    if (this.watchReindexTask) {
      try { this.watchReindexTask.cancel(); } catch {}
      this.watchReindexTask = null;
    }
    const context = this.context;
    this.watchReindexTask = cx.timer.after(delayMs, cx => {
      this.watchReindexTask = null;
      if (this._panelClosed || !this.current(context) || !hasOpenTerminalInSpace()) return;
      const { cwd, on, isWindows } = context;
      if (!cwd) return;
      cx.spawn(async cx => {
        try {
          if (!getCachedIndex(makeIndexKey(cwd, on, isWindows))) {
            await restoreDiskIndex(cwd, on, isWindows, cx);
          }
          if (this._panelClosed || !this.current(context) || !hasOpenTerminalInSpace()) return;
          const cached = getCachedIndex(makeIndexKey(cwd, on, isWindows));
          if (shouldRefreshIndex(cached, on)) {
            await ensureWorkspaceIndex({ root: cwd, on, isWindows, discoverRepos, cx });
          }
        } catch {}
      });
    });
  }

  watch(root, cx) {
    if (this._panelClosed || this.on || this.watched === root) return;
    this.stopPanelWatching();
    this.watched = root;
    const context = this.context;
    const isWindows = Boolean(context?.isWindows);
    const indexKey = makeIndexKey(root, this.on, isWindows);
    const token = `panel-${++this.panelWatchSeq}`;
    this.panelWatchKey = indexKey;
    this.panelWatchToken = token;
    claimRootWatcher(indexKey, token, true);
    setIndexWatching(indexKey, true);

    cx.spawn(async cx => {
      try {
        while (!this._panelClosed && this.context === context) {
          try {
            const handle = watchFolder(root);
            this.panelWatchHandle = handle;
            const changed = await handle;
            if (this.panelWatchHandle === handle) this.panelWatchHandle = null;
            if (this._panelClosed || !this.current(context)) break;
            if (!Array.isArray(changed) || changed.length === 0) continue;
            const info = analyzeWatchBatch(changed, root, this.folders);
            if (!info.hasNonIgnored) continue;
            invalidateIndexedFiles(root, changed, null);
            const hadCachedIndex = Boolean(getCachedIndex(indexKey));
            const indexDirty = await handleWatchForIndex(root, null, isWindows, info, changed);
            // Invalidate repo discovery only on Git ref changes or actual structural additions/deletions,
            // never on routine saves to existing depth<=2 source files.
            if (info.hasGitRefChange || (info.invalidateRepos && (indexDirty || !hadCachedIndex))) {
              this.candidateCache = null;
            }
            if (info.dirtyDirs.has("*")) {
              this.dirtyFolders.add("*");
            } else {
              for (const d of info.dirtyDirs) this.dirtyFolders.add(d);
              if (info.hasNonGitChange && info.dirtyDirs.has("")) this.dirtyFolders.add("");
            }
            this.scheduleWatchRefresh(cx);
            if (indexDirty && this.current(context) && hasOpenTerminalInSpace()) {
              this.scheduleWatchReindex(cx);
            }
          } catch {
            if (this._panelClosed || !this.current(context)) break;
            await cx.sleep(3000);
          }
        }
      } finally {
        if (this.watched === root && (!this.current(context) || this._panelClosed)) {
          this.watched = null;
        }
        releaseRootWatcher(indexKey, token);
        setIndexWatching(indexKey, hasActiveRootWatcher(indexKey));
        if (this.panelWatchToken === token) {
          this.panelWatchToken = null;
          this.panelWatchKey = null;
        }
      }
    });
  }

  current(context) {
    return !this._panelClosed && Boolean(context) && this.context === context && workspaceContextKey() === context.key;
  }

  hasTruncatedOpenFolder() {
    for (const folder of this.truncatedFolders) {
      if (!folder || this.folders.has(folder)) return true;
    }
    return false;
  }

  touchCachedEntries(path) {
    const existing = this.entries.get(path);
    if (!existing) return undefined;
    this.entries.delete(path);
    this.entries.set(path, existing);
    return existing;
  }

  setCachedFolderEntries(path, rawEntries) {
    if (!Array.isArray(rawEntries)) return;
    const truncated = rawEntries.length > PER_FOLDER;
    const trimmed = truncated ? rawEntries.slice(0, PER_FOLDER) : rawEntries;
    const sorted = sortDirectoryEntries(trimmed);

    if (truncated) this.truncatedFolders.add(path);
    else this.truncatedFolders.delete(path);

    const prev = this.entries.get(path);
    if (prev) {
      this.cachedEntryCount -= prev.length;
      this.entries.delete(path);
    }
    this.entries.set(path, sorted);
    this.cachedEntryCount += sorted.length;

    if (this.entries.size > MAX_CACHED_FOLDERS || this.cachedEntryCount > MAX_CACHED_ENTRIES) {
      this.pruneEntryCache(path);
    }
    this.markTreeDirty();
  }

  pruneEntryCache(protectedPath = null) {
    let removed = false;
    for (const [k, list] of this.entries) {
      if (this.entries.size <= MAX_CACHED_FOLDERS && this.cachedEntryCount <= MAX_CACHED_ENTRIES) break;
      if (!k || k === protectedPath || this.folders.has(k) || this.pending.has(k)) continue;
      this.entries.delete(k);
      this.truncatedFolders.delete(k);
      this.cachedEntryCount -= list.length;
      removed = true;
    }
    if (removed) this.markTreeDirty();
  }

  evictCollapsedEntries() {
    let removed = false;
    for (const [k, list] of [...this.entries]) {
      if (!k || this.folders.has(k) || this.pending.has(k)) continue;
      this.entries.delete(k);
      this.truncatedFolders.delete(k);
      this.cachedEntryCount -= list.length;
      removed = true;
    }
    if (removed) this.markTreeDirty();
  }

  evictDirtyCollapsedEntries(dirtyDirs) {
    if (!dirtyDirs?.size) return;
    let removed = false;
    for (const dir of dirtyDirs) {
      if (!dir || this.folders.has(dir) || this.pending.has(dir)) continue;
      const prev = this.entries.get(dir);
      if (!prev) continue;
      this.entries.delete(dir);
      this.truncatedFolders.delete(dir);
      this.cachedEntryCount -= prev.length;
      removed = true;
    }
    if (removed) this.markTreeDirty();
  }

  collectPrewarmTargets(filterRel) {
    const targets = [];
    const seen = new Set();
    const expandedParents = ["", ...this.folders];
    for (const parentPath of expandedParents) {
      if (parentPath && filterRel && !matchesServiceFilter(parentPath, filterRel)) continue;
      const children = this.entries.get(parentPath);
      if (!children?.length) continue;
      for (const entry of children) {
        if (!entry.dir || PREWARM_SKIP_DIRS.has(entry.name)) continue;
        const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        if (filterRel && !matchesServiceFilter(childPath, filterRel)) continue;
        if (this.folders.has(childPath) || this.entries.has(childPath) || this.pending.has(childPath) || seen.has(childPath)) {
          continue;
        }
        seen.add(childPath);
        targets.push(childPath);
        if (targets.length >= FOLDER_PREWARM_LIMIT) return targets;
      }
    }
    return targets;
  }

  schedulePrewarm(cx, context = this.context, delayMs = 120) {
    if (this._panelClosed || !cx?.timer || !cx?.spawn || !context || !this.current(context)) return;
    if (context.on || !isFilesVisible()) return;
    this.prewarmTask?.cancel();
    const token = ++this.prewarmSeq;
    this.prewarmTask = cx.timer.after(delayMs, cx => {
      this.prewarmTask = null;
      if (this._panelClosed || token !== this.prewarmSeq || !this.current(context) || !isFilesVisible()) return;
      // Yield priority to active user folder clicks or workspace refreshes.
      if (this.pending.size > 0 || this.loading) {
        this.schedulePrewarm(cx, context, 350);
        return;
      }
      const filterRel = this.activeServiceRelPath();
      const targets = this.collectPrewarmTargets(filterRel);
      if (!targets.length) return;
      const isCancelled = () =>
        this._panelClosed ||
        token !== this.prewarmSeq ||
        !this.current(context) ||
        !isFilesVisible() ||
        this.pending.size > 0;
      cx.spawn(async () => {
        await runInBatches(targets, FOLDER_PREWARM_CONCURRENCY, async targetPath => {
          if (isCancelled() || this.entries.has(targetPath)) return;
          try {
            const batch = await directoryCascade(
              context.cwd,
              targetPath,
              context,
              Math.min(MAX_CASCADE_DEPTH, 8),
              filterRel,
              isCancelled,
            );
            if (isCancelled() || !batch?.size) return;
            for (const [relPath, rawEntries] of batch) {
              if (!this.entries.has(relPath)) {
                this.setCachedFolderEntries(relPath, rawEntries);
              }
            }
          } catch {}
        }, isCancelled);
      });
    });
  }

  async loadFolder(path, context) {
    const { on, cwd: root, isWindows } = context;
    const entries = await directory(joinSubPath(root, path), on, isWindows);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    this.setCachedFolderEntries(path, entries);
    if (this.hasTruncatedOpenFolder()) this.limited = true;
  }

  refresh(cx, opts = {}) {
    if (this._panelClosed) return;
    syncSpaceAgentTabs();
    const loc = location();
    const { cwd, on } = loc;
    const nextKey = workspaceContextKey(loc);
    const isWindows = !on && window()?.platform === "windows";
    let workspaceChanged = false;

    if (nextKey !== this.context?.key) {
      workspaceChanged = true;
      if (this.context) {
        this.saved.set(this.context.key, {
          folders: this.folders,
          selectedFile: this.selectedFile,
          serviceFilter: this.serviceFilter,
        });
      }
      const saved = this.saved.get(nextKey);
      this.stopPanelWatching();
      this.context = { key: nextKey, cwd, on, space: loc.space || null, isWindows };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.truncatedFolders = new Set();
      this.cachedEntryCount = 0;
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.pendingTokens = new Map();
      this.prewarmTask?.cancel();
      this.prewarmTask = null;
      this.prewarmSeq = (this.prewarmSeq || 0) + 1;
      this.pendingScrollPath = null;
      this.selectedFile = saved?.selectedFile || null;
      this.marks = {};
      this.dirCounts = {};
      this.dirMarks = {};
      this.serviceCounts = {};
      this.serviceFiles = {};
      this.services = [];
      this.repoRoots = new Set();
      this.serviceFilter = saved?.serviceFilter || "all";
      this.error = null;
      this.limited = false;
      this.loading = false;
      this.candidateCache = null;
      this.dirtyFolders = new Set();
      this.pendingRefreshOpts = null;
      this.needsFolderReloadOnShow = false;
      this.recentBaselineMisses.clear();
      if (this.watchDebounceTask) {
        try { this.watchDebounceTask.cancel(); } catch {}
        this.watchDebounceTask = null;
      }
      if (this.watchReindexTask) {
        try { this.watchReindexTask.cancel(); } catch {}
        this.watchReindexTask = null;
      }
      this.markTreeDirty();
    } else if (this.context) {
      if (this.context.isWindows !== isWindows) {
        this.context.isWindows = isWindows;
        this.markTreeDirty();
      }
    }

    const activeTabId = loc.tabId || null;
    this.activeSessionTabId = activeTabId;

    if (!cwd) return;
    if (this.loading) {
      const prev = this.pendingRefreshOpts;
      this.pendingRefreshOpts = {
        fromWatch: Boolean((opts?.fromWatch || prev?.fromWatch) && !opts?.force && !prev?.force && prev?.fromWatch !== false),
        fromTimer: Boolean(opts?.fromTimer && (!prev || prev.fromTimer)),
        gitOnly: Boolean(opts?.gitOnly && (!prev || prev.gitOnly)),
        force: Boolean(opts?.force || prev?.force),
      };
      return;
    }

    const context = this.context;
    const fromWatch = Boolean(opts?.fromWatch);
    const fromTimer = Boolean(opts?.fromTimer);
    const force = Boolean(opts?.force);
    const gitOnly = Boolean(opts?.gitOnly) && !workspaceChanged && !force && !fromWatch;
    const watchDirty = new Set(this.dirtyFolders);
    this.dirtyFolders.clear();
    this.loading = true;
    this.limited = false;

    const allPanesList = panes() || [];
    const extraCwds = activeTabId
      ? Array.from(new Set(allPanesList.filter(p => p?.cwd && p.tab === activeTabId).map(p => p.cwd)))
      : [];
    const tabFlowObj = activeTabId && safeReadFlows()[activeTabId];
    const tabTermAddrs = activeTabId
      ? Array.from(
          new Set([
            ...(tabFlowObj?.leadTerminal ? [tabFlowObj.leadTerminal] : []),
            ...allPanesList.filter(p => p.tab === activeTabId && p.terminal && p.labels?.cognivisorRunner !== "true").map(p => p.terminal),
            ...(agents() || []).filter(a => a.tab === activeTabId).map(a => a.address),
          ])
        )
      : [];

    cx.spawn(async cx => {
      try {
        const visibleNow = isFilesVisible();
        const indexKey = makeIndexKey(cwd, on, isWindows);
        const liveLocalWatch = !on && this.watched === cwd && hasActiveRootWatcher(indexKey);
        const skipFoldersForGitOnly = gitOnly && this.entries.has("") && !this.error && !this.needsFolderReloadOnShow && watchDirty.size === 0;

        if (!skipFoldersForGitOnly) {
          if (!visibleNow && this.entries.has("") && !this.error) {
            if (!fromTimer || watchDirty.size > 0 || force) {
              this.needsFolderReloadOnShow = true;
            }
          } else {
            const forceReloadFolders = this.needsFolderReloadOnShow;
            this.needsFolderReloadOnShow = false;
            const skipFolderWorkOnTimer = fromTimer && !force && !this.error && this.entries.has("") && !forceReloadFolders && watchDirty.size === 0 && liveLocalWatch;

            if (!skipFolderWorkOnTimer) {
              const shouldEvictCollapsed = force || watchDirty.has("*") || Boolean(this.error) || !this.entries.has("");
              const shouldReloadAll = shouldEvictCollapsed || forceReloadFolders || (!fromWatch && !fromTimer);

              if (shouldEvictCollapsed) {
                this.prewarmTask?.cancel();
                this.prewarmTask = null;
                this.prewarmSeq = (this.prewarmSeq || 0) + 1;
                this.evictCollapsedEntries();
              } else if (watchDirty.size > 0) {
                this.evictDirtyCollapsedEntries(watchDirty);
              }

              const foldersToLoad = (shouldReloadAll || fromTimer)
                ? ["", ...this.folders]
                : [...new Set(["", ...this.folders].filter(f => watchDirty.has(f)))];

              if (foldersToLoad.length > 0) {
                await runInBatches(foldersToLoad, FOLDER_RELOAD_CONCURRENCY, async path => {
                  if (!this.current(context)) return;
                  await this.loadFolder(path, context);
                }, () => !this.current(context));
              }
              if (!this.current(context)) return;
              this.error = null;
              if (foldersToLoad.length > 0) {
                cx.notify();
              }
              if (this.current(context) && (!fromTimer || !liveLocalWatch)) {
                this.schedulePrewarm(cx, context);
              }
            }
          }
        }

        const now = Date.now();
        const cacheKey = `${cwd}|${on || ""}|${extraCwds.slice().sort().join(",")}`;
        let candidateServices;
        if (!force && this.candidateCache && this.candidateCache.key === cacheKey && (now - this.candidateCache.ts) < REPO_CACHE_TTL_MS) {
          candidateServices = this.candidateCache.services;
        } else {
          candidateServices = await discoverRepos(cwd, on, isWindows, extraCwds);
          if (!this.current(context)) return;
          this.candidateCache = { key: cacheKey, services: candidateServices, ts: Date.now() };
        }

        const marks = {};
        const dirCounts = {};
        const serviceCounts = {};
        const serviceFiles = {};
        const serviceAhead = {};
        const serviceBranches = {};

        const statusResults = await runInBatches(candidateServices, GIT_STATUS_CONCURRENCY, async s => {
          if (!this.current(context)) return null;
          const res = await exec(
            "git",
            ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=normal"],
            { cwd: s.root, on }
          ).catch(() => null);
          let branch = "";
          let ahead = 0;
          const fileEntries = [];
          if (res && res.code === 0 && typeof res.stdout === "string") {
            const records = res.stdout.split("\0").filter(Boolean);
            for (const rec of records) {
              if (rec.startsWith("## ")) {
                const parsed = parsePorcelainHeader(rec);
                branch = parsed.branch;
                if (parsed.ahead !== null) {
                  ahead = parsed.ahead;
                } else if (branch && !BASE_BRANCHES.has(branch)) {
                  ahead = await repoAheadCount(s.root, on, branch);
                }
              } else {
                fileEntries.push(rec);
              }
            }
          }
          return { service: s, branch, fileEntries, ahead };
        }, () => !this.current(context));

        if (!this.current(context)) return;
        const validStatusResults = statusResults.filter(Boolean);

        const normCwd = normPathStr(cwd);
        const prevBus = shared("cognivisor.services");
        const normBusRoot = prevBus?.workspaceRoot ? normPathStr(prevBus.workspaceRoot) : "";
        const prevByRoot = new Map();
        if (prevBus && normBusRoot === normCwd && Array.isArray(prevBus.services)) {
          for (const ps of prevBus.services) {
            if (ps?.root) {
              prevByRoot.set(normPathStr(ps.root), ps);
            }
          }
        }

        let enrichedServices = [];

        if (activeTabId) {
          const appHomeDir = getSafeAppHome();
          const primaryStatus = validStatusResults.find(r => normPathStr(r.service.root) === normCwd)
            || validStatusResults.find(r => r.branch)
            || null;
          const primaryBranch = primaryStatus?.branch || "";

          const allFlowsNow = safeReadFlows();
          const freshFlowObj = allFlowsNow[activeTabId];
          const flowBaselineRev = Number(freshFlowObj?.baselineRev) || 0;
          let sessionBaseline = normalizeSessionBaseline(SESSION_BASELINE_CACHE.get(activeTabId))
            || normalizeSessionBaseline(freshFlowObj?.sessionBaseline);
          if (sessionBaseline && (Number(sessionBaseline.rev) || 0) < flowBaselineRev) {
            SESSION_BASELINE_CACHE.delete(activeTabId);
            sessionBaseline = null;
          }
          if (sessionBaseline && sessionBaseline.workspaceRoot && normCwd && sessionBaseline.workspaceRoot !== normCwd) {
            sessionBaseline = null;
          }
          let isFreshBaseline = false;
          let isAnchoredFresh = false;
          let baselineDirtyChanged = false;

          if (!sessionBaseline && appHomeDir) {
            sessionBaseline = await readDiskSessionBaseline(appHomeDir, activeTabId, cwd, primaryBranch, false);
            if (!this.current(context)) return;
            if (sessionBaseline) baselineDirtyChanged = true;
          }
          if (!sessionBaseline && appHomeDir && (tabTermAddrs || []).length > 0) {
            const reads = await Promise.all(
              (tabTermAddrs || []).map(addr => hc(["read", "--lines", "100", addr]).catch(() => ""))
            );
            if (!this.current(context)) return;
            const transcript = reads.filter(Boolean).join("\n");
            if (terminalHasResumeCommand(transcript)) {
              sessionBaseline = await readDiskSessionBaseline(appHomeDir, activeTabId, cwd, primaryBranch, true);
              if (!this.current(context)) return;
              if (sessionBaseline) baselineDirtyChanged = true;
            }
          }
          if (!sessionBaseline) {
            const liveTabIds = new Set();
            for (const sp of spaces() || []) {
              for (const tb of sp?.tabs || []) {
                if (tb?.id) liveTabIds.add(tb.id);
              }
            }
            const recentFlow = findRecentFlowWorkspaceBaseline(allFlowsNow, cwd, {
              excludeTabId: activeTabId,
              liveTabIds,
            });
            if (recentFlow) {
              sessionBaseline = recentFlow;
              baselineDirtyChanged = true;
            } else if (appHomeDir) {
              const missKey = `${activeTabId}::${normCwd}`;
              if (!this.recentBaselineMisses.has(missKey)) {
                const recentDisk = await findRecentWorkspaceBaseline(appHomeDir, cwd, {
                  excludeTabId: activeTabId,
                  liveTabIds,
                  fsDeps: fsPromises,
                });
                if (!this.current(context)) return;
                if (recentDisk) {
                  sessionBaseline = recentDisk;
                  baselineDirtyChanged = true;
                } else {
                  this.recentBaselineMisses.add(missKey);
                }
              }
            }
          }
          if (!sessionBaseline) {
            const { startedAt, anchored } = resolveSessionStartTime(freshFlowObj);
            sessionBaseline = {
              version: 1,
              startedAt,
              workspaceRoot: normCwd,
              repos: {},
            };
            isFreshBaseline = true;
            isAnchoredFresh = anchored;
            baselineDirtyChanged = true;
          }

          const sinceSec = Math.floor(sessionBaseline.startedAt / 1000);
          const repoEvaluations = await runInBatches(validStatusResults, REPO_EVAL_CONCURRENCY, async ({ service, branch, fileEntries, ahead }) => {
            if (!this.current(context)) return null;
            serviceAhead[service.id] = ahead || 0;
            serviceBranches[service.id] = branch || "";

            const dirEntries = [];
            const expandedItems = [];
            for (const entry of fileEntries.slice(0, TOTAL)) {
              const xy = entry.slice(0, 2);
              const rawRel = entry.slice(3);
              const relFile = rawRel.replace(/\/+$/, "");
              if (!relFile) continue;
              if (xy === "??" && rawRel.endsWith("/")) {
                dirEntries.push(relFile);
              } else {
                expandedItems.push({ xy, relFile });
              }
            }
            if (dirEntries.length > 0 && expandedItems.length < TOTAL) {
              const ls = await exec(
                "git",
                ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "ls-files", "--others", "--exclude-standard", "-z", "--", ...dirEntries],
                { cwd: service.root, on }
              ).catch(() => null);
              if (ls?.code === 0 && ls.stdout) {
                for (const expandedPath of ls.stdout.split("\0").filter(Boolean)) {
                  const cleanExp = expandedPath.replace(/\/+$/, "");
                  if (!cleanExp) continue;
                  expandedItems.push({ xy: "??", relFile: cleanExp });
                  if (expandedItems.length >= TOTAL) break;
                }
              }
            }

            const parsedRaw = expandedItems.map(({ xy, relFile }) => {
              const fullPath = `${service.root}/${relFile}`;
              const mark = normalizeGitStatusMark(xy);
              return { relFile, fullPath, status: mark, mark };
            });

            const resolveRepoEntries = async () => {
              if (parsedRaw.length === 0) return [];
              if (on) {
                return parsedRaw.map(item => ({ ...item, sig: String(item.status || ""), mtimeMs: 0 }));
              }
              const existingRelPaths = parsedRaw.filter(item => item.status !== "D").map(item => item.relFile);
              const statMap = existingRelPaths.length > 0
                ? await batchStatLocalPaths(
                    service.root,
                    existingRelPaths,
                    { execFn: exec, isWindows, fsDeps: fsPromises },
                  )
                : new Map();
              if (!this.current(context)) return [];
              const resolved = [];
              for (let i = 0; i < parsedRaw.length; i += SIG_HASH_BATCH_CONCURRENCY) {
                if (!this.current(context)) return [];
                const slice = parsedRaw.slice(i, i + SIG_HASH_BATCH_CONCURRENCY);
                let anyHashed = false;
                const batchOut = await Promise.all(
                  slice.map(async item => {
                    const st = statMap.get(item.relFile) || null;
                    const res = await resolveFileSigCached(item.fullPath, item.status, {
                      on,
                      statMeta: st,
                      cache: FILE_SIG_CACHE,
                      fsDeps: fsPromises,
                    });
                    if (res.hashed) anyHashed = true;
                    return { ...item, sig: res.sig, mtimeMs: res.mtimeMs };
                  })
                );
                resolved.push(...batchOut);
                if (anyHashed && i + SIG_HASH_BATCH_CONCURRENCY < parsedRaw.length) {
                  await cx.sleep(0);
                }
              }
              return resolved;
            };

            const [parsedEntries, logRes] = await Promise.all([
              resolveRepoEntries(),
              (isFreshBaseline && !isAnchoredFresh)
                ? Promise.resolve(null)
                : exec(
                    "git",
                    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "log", "-n", "1", `--since=${sinceSec}`, "--format=%ct"],
                    { cwd: service.root, on }
                  ).catch(() => null),
            ]);

            const sessionCommitCount = !(isFreshBaseline && !isAnchoredFresh) && logRes?.code === 0 && Boolean((logRes.stdout || "").trim()) ? 1 : 0;
            return { service, branch, ahead, parsedEntries, sessionCommitCount };
          }, () => !this.current(context));

          if (!this.current(context)) return;

          for (const evalItem of repoEvaluations) {
            if (!evalItem) continue;
            const { service, branch, ahead, parsedEntries, sessionCommitCount } = evalItem;
            const normRoot = normPathStr(service.root);
            const sigMap = new Map();
            for (const item of parsedEntries) sigMap.set(item.relFile, item.sig);

            const existingBaselineRepo = sessionBaseline.repos[normRoot] || null;
            let sessionWorkingFiles = [];

            if (isFreshBaseline) {
              const dirtyFiles = {};
              for (const item of parsedEntries) {
                if (isAnchoredFresh && item.mtimeMs > 0 && item.mtimeMs >= sessionBaseline.startedAt) {
                  continue;
                }
                dirtyFiles[item.relFile] = { status: item.status, sig: item.sig };
              }
              sessionBaseline.repos[normRoot] = { dirtyFiles };
              baselineDirtyChanged = true;
              sessionWorkingFiles = isAnchoredFresh
                ? filterSessionDirtyEntries(parsedEntries, sessionBaseline.repos[normRoot], sessionBaseline.startedAt, sigMap)
                : [];
            } else if (!existingBaselineRepo) {
              sessionWorkingFiles = filterSessionDirtyEntries(parsedEntries, null, sessionBaseline.startedAt, sigMap);
              const dirtyFiles = {};
              for (const item of parsedEntries) {
                if (!item.mtimeMs || item.mtimeMs < sessionBaseline.startedAt) {
                  dirtyFiles[item.relFile] = { status: item.status, sig: item.sig };
                }
              }
              sessionBaseline.repos[normRoot] = { dirtyFiles };
              baselineDirtyChanged = true;
            } else {
              sessionWorkingFiles = filterSessionDirtyEntries(parsedEntries, existingBaselineRepo, sessionBaseline.startedAt, sigMap);
            }

            if (sessionWorkingFiles.length > 0 || sessionCommitCount > 0) {
              if (sessionWorkingFiles.length > 0) {
                recordDirtyMarksAndCounts(
                  cwd,
                  isWindows,
                  normCwd,
                  service,
                  sessionWorkingFiles,
                  marks,
                  dirCounts,
                  serviceCounts,
                  serviceFiles
                );
              } else {
                serviceCounts[service.id] = 0;
                serviceFiles[service.id] = [];
              }
              const existing = prevByRoot.get(normRoot);
              enrichedServices.push({
                ...service,
                branch: branch || existing?.branch || service.branch || "",
                workingCount: sessionWorkingFiles.length,
                aheadCount: ahead ?? existing?.aheadCount ?? 0,
                sessionCommitCount,
              });
            }
          }

          cacheSessionBaseline(activeTabId, sessionBaseline);
          const sessionRepos = enrichedServices.map(s => normPathStr(s.root)).filter(Boolean);
          const rawLatestFlows = safeReadFlows();
          const liveTabIdsForCompact = new Set();
          for (const sp of spaces() || []) {
            for (const tb of sp?.tabs || []) {
              if (tb?.id) liveTabIdsForCompact.add(tb.id);
            }
          }
          const latestFlows = compactFlowsMap(rawLatestFlows, liveTabIdsForCompact);
          const hadLegacyBaseline = Object.values(rawLatestFlows).some(f => f && typeof f === "object" && Boolean(f.sessionBaseline));
          const prunedTabs = Object.keys(rawLatestFlows).length !== Object.keys(latestFlows).length;
          const curFlow = asPlainObject(latestFlows[activeTabId]);
          const prevRepos = Array.isArray(curFlow.sessionRepos) ? curFlow.sessionRepos.map(r => normPathStr(r)) : [];
          const reposChanged = prevRepos.length !== sessionRepos.length || prevRepos.some((r, idx) => r !== sessionRepos[idx]);

          if (hadLegacyBaseline || prunedTabs || reposChanged || curFlow.sessionStartedAt !== sessionBaseline.startedAt) {
            setShared("cognivisor.flows", {
              ...latestFlows,
              [activeTabId]: {
                ...curFlow,
                sessionStartedAt: sessionBaseline.startedAt,
                sessionRepos,
                updatedAt: Date.now(),
              },
            });
          }
          if (appHomeDir && (baselineDirtyChanged || reposChanged)) {
            await writeDiskSessionBaseline(appHomeDir, activeTabId, cwd, primaryBranch, sessionBaseline);
            if (!this.current(context)) return;
            const pruneNow = Date.now();
            if ((pruneNow - this.lastBaselinePruneAt) >= BASELINE_PRUNE_INTERVAL_MS) {
              this.lastBaselinePruneAt = pruneNow;
              pruneDiskSessionBaselines(appHomeDir, {
                liveTabIds: liveTabIdsForCompact,
                fsDeps: fsPromises,
              }).catch(() => {});
            }
          }
        } else {
          for (const { service, branch, ahead } of validStatusResults) {
            serviceAhead[service.id] = ahead || 0;
            serviceBranches[service.id] = branch || "";
          }
          enrichedServices = [];
        }

        this.services = enrichedServices;
        this.repoRoots = new Set(enrichedServices.map(s => normCmpStr(s.root, isWindows)));
        enrichedServices.forEach(s => {
          this.repoRoots.add(normPathStr(s.root));
          this.repoRoots.add(s.root);
        });

        if (this.serviceFilter !== "all" && !enrichedServices.some(s => s.id === this.serviceFilter)) {
          this.serviceFilter = "all";
        }

        const candidateMeta = candidateServices.map(s => ({
          id: s.id,
          name: s.name,
          relPath: s.relPath || "",
          root: s.root,
          isSibling: Boolean(s.isSibling),
          branch: serviceBranches[s.id] || s.branch || "",
        }));

        const busSig = prevBus && (!prevBus.tabId || prevBus.tabId === activeTabId) && normBusRoot === normCwd && Array.isArray(prevBus.services)
          ? (prevBus.sig || ((activeTabId || "") + "::" + normBusRoot + "::" + (prevBus.candidates?.length ?? -1) + "::" + prevBus.services.map(s => `${normPathStr(s.root)}@${s.branch || ""}:${s.workingCount ?? 0}:${s.aheadCount ?? 0}`).join(",")))
          : null;
        const servicesSig = (activeTabId || "") + "::" + normCwd + "::" + candidateMeta.length + "::" + enrichedServices.map(s => `${normPathStr(s.root)}@${s.branch || ""}:${s.workingCount ?? 0}:${s.aheadCount ?? 0}`).join(",");
        const busStale = !prevBus || !prevBus.ts || (Date.now() - prevBus.ts) >= 45000;
        if (servicesSig !== this.lastPublishedServicesSig || servicesSig !== busSig || busStale) {
          this.lastPublishedServicesSig = servicesSig;
          setShared("cognivisor.services", {
            tabId: activeTabId || null,
            workspaceRoot: cwd,
            on: on || null,
            services: enrichedServices,
            candidates: candidateMeta,
            sig: servicesSig,
            ts: Date.now(),
          });
        } else {
          this.lastPublishedServicesSig = servicesSig;
        }

        this.marks = marks;
        this.dirCounts = dirCounts;
        this.dirMarks = dirCounts;
        this.serviceCounts = serviceCounts;
        this.serviceFiles = serviceFiles;
        this.error = null;
        this.markTreeDirty();
        this.watch(cwd, cx);
        if (hasOpenTerminalInSpace()) {
          const cached = getCachedIndex(indexKey);
          if (shouldRefreshIndex(cached, on) && !isIndexInFlight(indexKey) && !this.watchReindexTask) {
            this.scheduleWatchReindex(cx, AGENT_PREWARM_DEBOUNCE_MS);
          }
        }
      } catch (e) {
        if (this.current(context) && !this.entries.has("")) this.error = String(e);
      } finally {
        if (this.context === context) this.loading = false;
        cx.notify();
        if (!this._panelClosed && this.context === context && this.pendingRefreshOpts) {
          const pending = this.pendingRefreshOpts;
          this.pendingRefreshOpts = null;
          cx.timer.after(150, cx => {
            if (this.current(context)) this.refresh(cx, pending);
          });
        }
      }
    });
  }

  activeServiceRelPath() {
    if (!this.serviceFilter || this.serviceFilter === "all") return null;
    const selectedService = this.services?.find(s => s.id === this.serviceFilter);
    return selectedService?.relPath || null;
  }

  acquireFolderPending(path, token = ++this.pendingSeq) {
    if (this.pending.has(path)) {
      return this.pendingTokens.get(path) === token;
    }
    this.pending.add(path);
    this.pendingTokens.set(path, token);
    this.markTreeDirty();
    return true;
  }

  clearFolderPending(path, token, context) {
    if (this.context !== context) return;
    if (this.pendingTokens.get(path) === token) {
      this.pending.delete(path);
      this.pendingTokens.delete(path);
      this.markTreeDirty();
    }
  }

  loadFoldersBatch(paths, cx) {
    const context = this.context;
    if (!context || !Array.isArray(paths) || paths.length === 0) return;
    const toLoad = [];
    for (const p of paths) {
      if (!p || this.entries.has(p) || this.pending.has(p)) continue;
      const token = ++this.pendingSeq;
      this.acquireFolderPending(p, token);
      toLoad.push({ path: p, token });
    }
    if (toLoad.length === 0) return;
    cx.spawn(async cx => {
      try {
        await runInBatches(toLoad, 4, async ({ path, token }) => {
          try {
            if (!this.current(context)) return;
            await this.loadFolder(path, context);
          } catch {
          } finally {
            this.clearFolderPending(path, token, context);
          }
        }, () => !this.current(context));
      } finally {
        for (const { path, token } of toLoad) {
          this.clearFolderPending(path, token, context);
        }
        if (this.current(context)) {
          this.schedulePrewarm(cx, context);
          cx.notify();
        }
      }
    });
  }

  collapseFolderSubtree(path) {
    let changed = false;
    for (const folder of collectSubtreePaths(this.folders, path)) {
      this.folders.delete(folder);
      changed = true;
    }
    for (const pendingPath of collectSubtreePaths(this.pending, path)) {
      this.pending.delete(pendingPath);
      changed = true;
    }
    for (const tokenPath of collectSubtreePaths(this.pendingTokens.keys(), path)) {
      this.pendingTokens.delete(tokenPath);
    }
    if (changed) this.markTreeDirty();
  }

  commitStagedCascade({ stagedEntries, stagedFolders }) {
    for (const [relPath, rawEntries] of stagedEntries) {
      if (this.entries.has(relPath)) {
        this.touchCachedEntries(relPath);
        continue;
      }
      this.setCachedFolderEntries(relPath, rawEntries);
    }

    for (const folderPath of stagedFolders) {
      this.folders.add(folderPath);
    }
    if (this.hasTruncatedOpenFolder()) this.limited = true;
    this.markTreeDirty();
  }

  toggle(path, cx) {
    if (this.pending.has(path)) {
      this.pending.delete(path);
      this.pendingTokens.delete(path);
      this.markTreeDirty();
      cx.notify();
      return;
    }
    if (this.folders.has(path)) {
      this.collapseFolderSubtree(path);
      cx.notify();
      return;
    }

    const context = this.context;
    const filterRel = this.current(context) ? this.activeServiceRelPath() : null;
    const cachedCascade = resolveCachedCascade({
      startPath: path,
      maxDepth: MAX_CASCADE_DEPTH,
      getFilterRel: () => filterRel,
      getCachedEntries: p => this.touchCachedEntries(p),
    });
    if (cachedCascade?.complete) {
      this.commitStagedCascade(cachedCascade);
      this.schedulePrewarm(cx, context);
      cx.notify();
      return;
    }

    // Cancel background prewarm immediately so this explicit user click gets exclusive I/O priority.
    this.prewarmTask?.cancel();
    this.prewarmTask = null;
    this.prewarmSeq = (this.prewarmSeq || 0) + 1;

    const cascadeToken = ++this.pendingSeq;
    const isCancelled = () => !this.current(context) || this.pendingTokens.get(path) !== cascadeToken;

    this.acquireFolderPending(path, cascadeToken);
    cx.notify();

    cx.spawn(async cx => {
      try {
        const result = await runStagedCascade({
          startPath: path,
          maxDepth: MAX_CASCADE_DEPTH,
          getFilterRel: () => (this.current(context) ? this.activeServiceRelPath() : null),
          isCancelled,
          getCachedEntries: p => this.touchCachedEntries(p),
          fetchCascadeBatch: (curPath, remDepth) =>
            directoryCascade(
              context.cwd,
              curPath,
              context,
              remDepth,
              this.current(context) ? this.activeServiceRelPath() : null,
              isCancelled,
            ),
          fetchSingleEntries: curPath => directory(joinSubPath(context.cwd, curPath), context.on, context.isWindows),
        });
        if (!result || isCancelled()) return;

        this.commitStagedCascade(result);
        this.schedulePrewarm(cx, context);
      } catch (e) {
        if (!isCancelled()) this.error = String(e);
      } finally {
        this.clearFolderPending(path, cascadeToken, context);
        cx.notify();
      }
    });
  }

  // Expand a file or directory from external/search selection inside the docked #files tree without opening an inline editor
  openFromSearch(path, cx, kind = "reveal") {
    if (!path) return;
    const isWin = Boolean(this.context?.isWindows);

    if (kind === "dir") {
      this.expandAncestorFolders(path, cx, true);
      this.pendingScrollPath = path;
      this.selectedFile = null;
      cx.notify();
      return;
    }

    const resolvedAbs = resolveViewerFilePath(this.root, path);
    this.selectedFile = resolvedAbs || path;

    const normPanelRoot = normPathStr(this.root);
    let relPath = normPathStr(path).replace(/^\.\//, "");
    if (normPanelRoot && resolvedAbs && isSameOrChildPath(resolvedAbs, normPanelRoot, isWin)) {
      relPath = normPanelRoot === "/" ? resolvedAbs.slice(1) : resolvedAbs.slice(normPanelRoot.length + 1);
    } else if (resolvedAbs && (resolvedAbs.startsWith("/") || /^[A-Za-z]:\//.test(resolvedAbs))) {
      relPath = "";
    }

    if (relPath) {
      this.expandAncestorFolders(relPath, cx, false);
      this.pendingScrollPath = relPath;
    }
    cx.notify();
  }

  openSearchOverlay() {
    const currentLoc = location();
    openOverlay({
      mod: "files-search",
      kind: "window",
      key: "files-search-win",
      frame: "none",
      props: {
        role: "search",
        spaceId: currentLoc.space || null,
        root: this.root || currentLoc.cwd,
        on: this.on ?? currentLoc.on ?? null,
      },
    });
  }

  button(id, icon, action) {
    const t = theme();
    return div()
      .id(id)
      .size(26)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .cursor_pointer()
      .text_color(t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(icon);
  }

  collectTreeRows() {
    if (this._treeRowsCache && this._treeRowsCacheVersion === this.treeVersion) {
      return this._treeRowsCache;
    }
    const built = buildTreeRows({
      entries: this.entries,
      folders: this.folders,
      pending: this.pending,
      root: this.root,
      isWindows: Boolean(this.context?.isWindows),
      serviceFilter: this.serviceFilter,
      services: this.services,
      serviceFiles: this.serviceFiles,
      repoRoots: this.repoRoots,
      dirCounts: this.dirCounts,
      marks: this.marks,
      maxTotal: TOTAL,
    });
    this._treeRowsCache = built;
    this._treeRowsCacheVersion = this.treeVersion;
    return built;
  }

  handleTreeItemClick(itemKey, cx) {
    const row = this.visibleRowByKey?.get(itemKey);
    if (!row) return;
    if (row.kind === "sibling" || row.kind === "file") {
      const clickedPath = row.kind === "sibling" ? row.fullPath : row.path;
      const isWin = Boolean(this.context?.isWindows);
      const resolvedAbs = resolveViewerFilePath(this.root, clickedPath);
      this.selectedFile = resolvedAbs || clickedPath;
      const activeSpaceId = this.context?.space || spaces().find(s => s.active)?.id || null;
      const selectedService = (this.serviceFilter && this.serviceFilter !== "all")
        ? this.services?.find(s => s.id === this.serviceFilter)
        : null;
      const svc = selectedService?.isSibling && row.kind === "sibling"
        ? { serviceId: selectedService.id || null, serviceName: selectedService.name || null }
        : resolveServiceForFile(this.root, clickedPath, resolvedAbs, isWin, this.services);

      openFileInTab({
        spaceId: activeSpaceId,
        root: this.root,
        path: clickedPath,
        on: this.on ?? null,
        line: null,
        serviceId: svc.serviceId,
        serviceName: svc.serviceName,
        localServices: this.services,
      });
      cx.notify();
      return;
    }
    this.toggle(row.path, cx);
  }

  renderTreeRow(row, t, selectedKey = "") {
    const isWin = Boolean(this.context?.isWindows);
    if (row.kind === "sibling") {
      const siblingIcon = resolveFileIcon(row.path || row.name, t);
      const rowKey = selectedKey ? buildFileViewerKey(this.root, row.fullPath, isWin) : "";
      const isSelected = Boolean(selectedKey && rowKey && rowKey === selectedKey);
      return h_flex()
        .id(row.key)
        .h(28)
        .w_full()
        .min_w(0)
        .pl(8)
        .pr(12)
        .gap(7)
        .items_center()
        .rounded(7)
        .cursor_pointer()
        .when(isSelected, el => el.bg(t.selected))
        .hover(s => s.bg(isSelected ? t.selected : t.hover))
        .child(div().w(12).flex_none())
        .child(svg(siblingIcon.path).size(14).flex_none().text_color(siblingIcon.color))
        .child(div().flex_1().min_w(0).truncate().child(row.name))
        .child(div().flex_none().text_size(11).font_medium().text_color(t.blocked).child(row.mark));
    }

    const { path, depth, entry, open, isLoadingFolder, isRepo, dirCount, mark } = row;
    const entryIcon = entry.dir ? null : resolveFileIcon(path || entry.name, t);
    const rowKey = (!entry.dir && selectedKey) ? buildFileViewerKey(this.root, path, isWin) : "";
    const isSelected = Boolean(!entry.dir && selectedKey && rowKey && rowKey === selectedKey);
    return h_flex()
      .id(`file-${path}`)
      .h(28)
      .w_full()
      .min_w(0)
      .pl(8 + depth * 18)
      .pr(12)
      .gap(7)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(isSelected, el => el.bg(t.selected))
      .hover(s => s.bg(isSelected ? t.selected : t.hover))
      .child(entry.dir ? svg(`mods/files-search/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(entry.dir ? "mods/files-search/folder.svg" : entryIcon.path).size(14).flex_none().text_color(entry.dir ? t.muted : entryIcon.color))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .overflow_hidden()
          .gap(6)
          .items_center()
          .child(div().min_w(0).truncate().child(entry.name))
          .when(isRepo, el =>
            el.child(
              div()
                .flex_none()
                .px(4)
                .py(0.5)
                .rounded(3)
                .bg(t.selected)
                .border_1()
                .border_color(t.accent)
                .text_size(9)
                .font_medium()
                .text_color(t.accent)
                .child("repo")
            )
          )
      )
      .when(entry.dir && dirCount > 0, el =>
        el.child(
          div()
            .flex_none()
            .px(4)
            .py(0.5)
            .rounded(3)
            .bg(t.raised)
            .text_size(9.5)
            .text_color(t.blocked)
            .child(String(dirCount))
        )
      )
      .when(!entry.dir && Boolean(mark), el =>
        el.child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked)
            .child(mark)
        )
      )
      .when(isLoadingFolder, el =>
        el.child(
          svg("mods/files-search/spinner.svg")
            .size(12)
            .flex_none()
            .text_color(t.working || t.accent || t.muted)
            .spin(900)
        )
      );
  }

  render(cx) {
    const visible = isFilesVisible();
    const becameVisible = visible && !this.wasVisible;
    this.wasVisible = visible;

    const activeReq = shared("cognivisor.activeService");
    const hasActiveReq = Boolean(activeReq && activeReq.ts && activeReq.ts > (this.lastActiveServiceTs || 0));
    const selectReq = shared("files-search.select");
    const hasSelectReq = Boolean(selectReq && selectReq.ts && selectReq.ts > (this.lastSelectedTs || 0));

    const locNow = location();
    const wsKeyNow = workspaceContextKey(locNow);
    const tabChanged = (locNow.tabId || null) !== this.activeSessionTabId;

    let needsAgentAnchorSync = false;
    let needsViewerSelectionSync = false;

    const activeSpace = (spaces() || []).find(s => s.active) || null;
    const activeTab = (activeSpace?.tabs || []).find(t => t.active) || null;
    if (activeSpace?.id && activeTab?.id) {
      const storedAgentTab = asPlainObject(shared("cognivisor.spaceAgentTabs"))[activeSpace.id];
      if (storedAgentTab !== activeTab.id) {
        const activeTabHasTerminal = (panes() || []).some(p => p.tab === activeTab.id && Boolean(p.terminal));
        needsAgentAnchorSync = activeTabHasTerminal;
      }
      if (visible) {
        const openFileTabs = asPlainObject(shared("cognivisor.openFileTabs"));
        const activeViewerEntry = openFileTabs[activeTab.id] || null;
        needsViewerSelectionSync = Boolean(
          (activeViewerEntry && activeViewerEntry.tabId !== this.lastSyncedViewerTabId) ||
          (!activeViewerEntry && this.lastSyncedViewerTabId)
        );
      }
    }

    if (
      wsKeyNow !== this.context?.key ||
      tabChanged ||
      (becameVisible && (!this.entries.has("") || Boolean(this.error) || this.needsFolderReloadOnShow || this.dirtyFolders.size > 0)) ||
      hasActiveReq ||
      hasSelectReq ||
      needsAgentAnchorSync ||
      needsViewerSelectionSync
    ) {
      this.schedulePanelSync(cx);
    }

    if (!visible) {
      this.visibleRowByKey = null;
      return div().id("files");
    }

    const t = theme();
    const isWin = Boolean(this.context?.isWindows);
    const selectedKey = this.selectedFile ? buildFileViewerKey(this.root, this.selectedFile, isWin) : "";
    const { rows: visibleRows, hitVisibleCap, byKey } = this.collectTreeRows();
    this.visibleRowByKey = byKey;
    const isLimited = hitVisibleCap || this.hasTruncatedOpenFolder();
    this.limited = isLimited;
    if (this.pendingScrollPath && this.treeScrollHandle) {
      const targetIdx = visibleRows.findIndex(r => r.path === this.pendingScrollPath);
      if (targetIdx >= 0) {
        this.treeScrollHandle.scroll_to_item(targetIdx, "center");
        this.pendingScrollPath = null;
      }
    }

    return v_flex()
      .id("files")
      .track_focus(this.panelHandle)
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .on_key_down((e, cx) => {
        // IntelliJ double Shift shortcut detection
        // Ignore key repeat when Shift is held down
        if (e.is_held) return;
        const now = Date.now();
        if (e.key === "shift" || e.keystroke === "shift" || e.keystroke === "shift-shift") {
          // Double shift press must be between 60ms (not a bounce/repeat) and 450ms
          const diff = now - this.lastShiftPress;
          if (diff >= 60 && diff <= 450) {
            this.lastShiftPress = 0;
            this.openSearchOverlay();
            cx.stop_propagation();
            return;
          }
          this.lastShiftPress = now;
        } else {
          this.lastShiftPress = 0;
        }
      })
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .pl(14)
          .pr(10)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Files"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).filter(Boolean).pop() || this.root || ""))
          .child(this.button("files-search-btn", svg("mods/files-search/search.svg").size(14), () => this.openSearchOverlay()))
      )
      // Compact horizontal scrollable service quick-filter bar
      .when(Boolean(this.services?.length > 1 || (this.serviceFilter && this.serviceFilter !== "all")), el =>
        el.child(
          h_flex()
            .h(30)
            .px(10)
            .gap(6)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .overflow_x_scroll()
            // Pill 'All'
            .child(
              h_flex()
                .flex_none()
                .px(8)
                .py(2)
                .rounded(4)
                .cursor_pointer()
                .text_size(11)
                .font_medium()
                .when(this.serviceFilter === "all" || !this.serviceFilter, p =>
                  p.bg(t.background).text_color(t.foreground).border_1().border_color(t.border)
                )
                .when(this.serviceFilter !== "all" && Boolean(this.serviceFilter), p =>
                  p.text_color(t.muted).hover(s => s.text_color(t.foreground))
                )
                .on_click((_e, cx) => this.resetServiceFilter(cx))
                .child("All")
            )
            // Pill for each discovered service
            .children(
              (this.services || []).map(s => {
                const isSelected = this.serviceFilter === s.id;
                const count = this.serviceCounts?.[s.id] || 0;
                return h_flex()
                  .id(`svc-pill-${s.id}`)
                  .flex_none()
                  .px(8)
                  .py(2)
                  .gap(5)
                  .items_center()
                  .rounded(4)
                  .cursor_pointer()
                  .text_size(11)
                  .font_medium()
                  .when(isSelected, p =>
                    p.bg(t.background).text_color(t.foreground).border_1().border_color(t.border)
                  )
                  .when(!isSelected, p =>
                    p.text_color(t.muted).hover(s => s.text_color(t.foreground))
                  )
                  .on_click((_e, cx) => this.selectService(s.id, cx))
                  .child(div().child(s.name))
                  .when(count > 0, p =>
                    p.child(
                      div()
                        .px(4)
                        .py(0.5)
                        .rounded(3)
                        .bg(t.raised)
                        .text_size(9.5)
                        .text_color(t.blocked)
                        .child(String(count))
                    )
                  );
              })
            )
        )
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .w_full()
          .min_w(0)
          .px(6)
          .py(4)
          .when(visibleRows.length > 0, treeWrap =>
            treeWrap.child(
              div()
                .flex_1()
                .min_h(0)
                .w_full()
                .min_w(0)
                .relative()
                .child(
                  v_virtual_list(
                    "files-tree",
                    visibleRows.length,
                    28,
                    index => visibleRows[index].key,
                    range => {
                      const items = [];
                      for (let i = range.start; i < range.end; i++) {
                        items.push(this.renderTreeRow(visibleRows[i], t, selectedKey));
                      }
                      return items;
                    },
                  )
                    .size_full()
                    .track_scroll(this.treeScrollHandle)
                    .on_item_click((itemKey, cx) => this.handleTreeItemClick(itemKey, cx))
                )
                .child(Scrollbar.vertical("files-tree").absolute().inset_0())
            )
          )
          .when(Boolean(this.error) || visibleRows.length === 0, emptyWrap =>
            emptyWrap.child(
              div()
                .p(8)
                .flex_none()
                .text_size(12)
                .text_color(t.dim)
                .child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))
            )
          )
          .when(isLimited, limWrap =>
            limWrap.child(
              div()
                .p(8)
                .flex_none()
                .text_size(11)
                .text_color(t.dim)
                .child("File list limited to 500 entries per folder and 5,000 total")
            )
          )
      );
  }

  close() {
    this._panelClosed = true;
    try { this.pollTimerTask?.cancel(); } catch {}
    this.pollTimerTask = null;
    try { this.watchDebounceTask?.cancel(); } catch {}
    this.watchDebounceTask = null;
    try { this.watchReindexTask?.cancel(); } catch {}
    this.watchReindexTask = null;
    try { this.agentPrewarmTask?.cancel(); } catch {}
    this.agentPrewarmTask = null;
    try { this.pendingPanelSyncTask?.cancel(); } catch {}
    this.pendingPanelSyncTask = null;
    try { this.prewarmTask?.cancel(); } catch {}
    this.prewarmTask = null;
    this.stopPanelWatching();
    this.pending?.clear();
    this.pendingTokens?.clear();
    this.entries?.clear();
    this.truncatedFolders?.clear();
    this.dirtyFolders?.clear();
    this.folders?.clear();
    this.recentBaselineMisses?.clear();
    this.context = null;
    this._treeRowsCache = null;
    this.visibleRowByKey = null;
    try { this.treeScrollHandle?.release(); } catch {}
    this.treeScrollHandle = null;
  }
}
