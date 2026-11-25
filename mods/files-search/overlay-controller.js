// Floating IntelliJ-style Search Everywhere overlay controller (overlay: true).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, ScrollHandle } from "gpui-base";
import { join } from "path";
import {
  spaces, exec, readTextFile,
  theme, settings, window, layout, props, closeOverlay,
  shared, setShared, run,
} from "herdr";
import {
  COMMON_IGNORE_GLOBS,
  RG_AVAILABLE_CACHE,
  normPathStr,
  isSameOrChildPath,
  joinSubPath,
  runInBatches,
  makeIndexKey,
  getCachedIndex,
  restoreDiskIndex,
  shouldRefreshIndex,
  ensureWorkspaceIndex,
} from "./indexer.js";
import {
  MAX_FILE_RESULTS,
  MAX_TEXT_RESULTS,
  FILE_SEARCH_CHUNK,
  FILE_SEARCH_BUDGET_MS,
  parseSearchOutputLines,
  prepareSearchQuery,
  scoreIndexEntry,
  buildTopFileItems,
  getSyntaxExt,
  getSyntaxPalette,
  resolveFileIcon,
  resolveViewerFilePath,
  shouldResetPreviewMarkdown,
  shouldLoadFullMarkdownPreview,
  buildPreviewMarkdownViewIds,
  isNavModifierActive,
  buildViewerNavigationNotice,
  computeLocalAnchorRect,
  shouldAllowUnderlyingScroll,
} from "./search-logic.js";
import {
  createCodeSyntaxState,
  advanceSyntaxState,
  cloneSyntaxState,
} from "./code-syntax.js";
import { resolveCrossFileNavigation } from "./symbol-index.js";
import {
  renderInteractiveTokenSegments,
  renderNavToastBanner,
  renderNavDisambiguationPopover,
} from "./code-viewer.js";
import { isMarkdownFile } from "./markdown-view-logic.js";
import {
  createMarkdownRenderCache,
  renderMarkdownToggleButton,
  renderMarkdownViewer,
} from "./markdown-view.js";
import { computeWrapColumns } from "./code-wrap.js";
import { isMarkdownExt } from "./markdown-syntax.js";
import { sortDirectoryEntries } from "./tree-logic.js";
import {
  previewWrapCache,
  clearPreviewWrapCache,
  getCachedPreviewRows,
  syncSpaceAgentTabs,
  location,
  resolveServiceForFile,
  collectRegisteredServices,
  collectIndexedFilesByRoot,
  openFileInTab,
  isFilesVisible,
  getSafeAppHome,
  discoverRepos,
  directory,
  PER_FOLDER,
  CHUNK_SIZE,
  readFileChunk,
  SHOWN,
  ROW_H,
  LIST_H,
} from "./workspace-io.js";

export class OverlayController {
  constructor(cx) {
    this.initOverlay(cx);
  }

  render(cx) {
    return this.renderOverlay(cx);
  }

  clearError() {
    this.previewError = null;
  }

  close() {
    this._overlayClosed = true;
    try { this.focusInputTask?.cancel(); } catch {}
    this.focusInputTask = null;
    try { this.fileSearchTask?.cancel(); } catch {}
    this.fileSearchTask = null;
    try { this.textSearchTask?.cancel(); } catch {}
    this.textSearchTask = null;
    try { this.previewDebounceTask?.cancel(); } catch {}
    this.previewDebounceTask = null;
    try { this.previewNoticeTask?.cancel(); } catch {}
    this.previewNoticeTask = null;
    try { this._resizeNotifyTask?.cancel(); } catch {}
    this._resizeNotifyTask = null;
    try { this._pendingPreviewScheduleTask?.cancel(); } catch {}
    this._pendingPreviewScheduleTask = null;
    this._pendingPreviewScheduleKey = null;
    this._previewMdCheckpoints = null;
    this.previewNavSeq = (this.previewNavSeq || 0) + 1;
    this.previewDisambig = null;
    this.previewNavNotice = null;
    this.previewHoveredTokenKey = null;
    this.previewCtrlHeld = false;
    this._overlayContainerBounds = null;
    this._overlayLastPointer = null;
    this.previewFullTextCache?.clear();
    this.previewFullTextCache = null;
    this.previewCache?.clear();
    this._fileQueryCache?.clear();
    this._narrowHistory = [];
    this.textQueryCache?.clear();
    this.textResults = [];
    this.fileResults = [];
    this.fileEntries = [];
    this.fileList = [];
    this._combinedResults = [];
    this._combinedCacheKey = null;
    this.previewLines = [];
    this.previewDirEntries = [];
    clearPreviewWrapCache();
    try { this.previewNavDropdownScroll?.release(); } catch {}
    this.previewNavDropdownScroll = null;
    this.resetPreviewMarkdownState({ clearCache: true });
    this.previewMarkdownCache = null;
    try { this.input?.release(); } catch {}
    this.input = null;
  }

  initOverlay(cx) {
    const p = props();
    syncSpaceAgentTabs();
    const loc = location();
    this.searchSpaceId = p?.spaceId || loc.space || spaces().find(s => s.active)?.id || null;
    this.searchRoot = p?.root || loc.cwd || shared("cognivisor.services")?.workspaceRoot;
    this.searchOn = p?.on ?? loc.on ?? null;
    this.searchIsWindows = !this.searchOn && window()?.platform === "windows";
    this._overlayClosed = false;
    this.tab = "all"; // "all" | "files" | "text"
    this.query = "";

    const indexKey = makeIndexKey(this.searchRoot, this.searchOn, this.searchIsWindows);
    const cachedIndex = getCachedIndex(indexKey);
    const hasCachedIndex = Boolean(cachedIndex && Array.isArray(cachedIndex.entries) && cachedIndex.entries.length > 0);
    this.fileList = hasCachedIndex ? (cachedIndex.files || cachedIndex.list || []) : [];
    this.fileEntries = hasCachedIndex ? cachedIndex.entries : [];
    this.fileResults = [];

    this.textResults = [];
    this.isSearchingText = false;
    this.isSearchingFiles = false;
    this.isIndexingFiles = false;
    this.searchSeq = 0;
    this.fileSearchSeq = 0;
    this.previewReqSeq = 0;
    this.textSearchTask = null;
    this.fileSearchTask = null;
    this.previewDebounceTask = null;
    this._fileResultsVer = 0;
    this._textResultsVer = 0;
    this._combinedCacheKey = null;
    this._combinedResults = [];
    this._fileQueryCache = new Map();
    this._narrowHistory = [];
    this.textQueryCache = new Map();
    this._currentPreviewKey = null;
    this.at = 0;
    this.scroll = 0;
    this.handle = cx.focus_handle();

    // Preview state (default enabled, remembers user preference)
    const savedPreview = shared("files-search.preview");
    this.showPreview = savedPreview !== null && savedPreview !== undefined ? Boolean(savedPreview) : true;
    this.previewItem = null;
    this.previewIsDir = false;
    this.previewDirEntries = [];
    this.previewLines = [];
    this.previewStartLine = 1;
    this.previewHasMore = false;
    this.previewLoading = false;
    this.previewLoadingMore = false;
    this.previewError = null;
    this.previewScroll = 0;
    this.previewCache = new Map();
    this.previewMarkdownRendered = false;
    this.previewMarkdownSeq = 0;
    this.previewMarkdownLoading = false;
    this.previewMarkdownError = null;
    this.previewMarkdownFullText = null;
    this.previewMarkdownFullPath = null;
    this.previewMarkdownCache = createMarkdownRenderCache(12);
    this.previewCtrlHeld = false;
    this.previewHoveredTokenKey = null;
    this.previewDisambig = null;
    this.previewNavNotice = null;
    this.previewNoticeTask = null;
    this.previewNavDropdownScroll = ScrollHandle.new();
    this.previewNavSeq = 0;
    this.previewFullTextCache = new Map();

    // Resize state (remembers user size preference)
    const savedSize = shared("files-search.customSize");
    this.customWidth = savedSize?.w || null;
    this.customListHeight = savedSize?.h || null;
    this.resizing = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;

    this.input = InputState.new({ placeholder: "Search everywhere by name or text (Tab to switch)..." });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      this.at = 0;
      this.scroll = 0;
      this._combinedCacheKey = null;
      this.triggerFileSearch(cx);
      this.triggerTextSearch(cx);
      if (this.showPreview) {
        const items = this.searchResults();
        this.schedulePreview(items[0], cx, false);
      }
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => {
      const items = this.searchResults();
      if (items[this.at]) this.selectResult(items[this.at], cx);
    });

    this.input.focus();
    this.focusInputTask = cx.timer.after(200, () => {
      this.focusInputTask = null;
      try { this.input?.focus(); } catch {}
    });

    // Restore disk cache if cold in RAM, then refresh in background only when stale/dirty/unwatched
    if (!hasCachedIndex || shouldRefreshIndex(cachedIndex, this.searchOn)) {
      this.loadWorkspaceFiles(cx);
    }
  }


  closeOverlay() {
    if (this._overlayClosed) return;
    this._overlayClosed = true;
    this.focusInputTask?.cancel();
    this.focusInputTask = null;
    this.fileSearchTask?.cancel();
    this.fileSearchTask = null;
    this.textSearchTask?.cancel();
    this.textSearchTask = null;
    this.previewDebounceTask?.cancel();
    this.previewDebounceTask = null;
    try { this._resizeNotifyTask?.cancel(); } catch {}
    this._resizeNotifyTask = null;
    try { this._pendingPreviewScheduleTask?.cancel(); } catch {}
    this._pendingPreviewScheduleTask = null;
    this._pendingPreviewScheduleKey = null;
    try { this.previewNoticeTask?.cancel(); } catch {}
    this.previewNoticeTask = null;
    this._previewMdCheckpoints = null;
    this.previewNavSeq = (this.previewNavSeq || 0) + 1;
    this.previewDisambig = null;
    this.previewNavNotice = null;
    this.previewHoveredTokenKey = null;
    this.previewCtrlHeld = false;
    this._overlayContainerBounds = null;
    this._overlayLastPointer = null;
    this.previewFullTextCache?.clear();
    this.previewCache?.clear();
    this._fileQueryCache?.clear();
    this._narrowHistory = [];
    this.textQueryCache?.clear();
    this.textResults = [];
    this.fileResults = [];
    this.fileEntries = [];
    this.fileList = [];
    this._combinedResults = [];
    this._combinedCacheKey = null;
    this.previewLines = [];
    this.previewDirEntries = [];
    previewWrapCache.clear();
    try { this.previewNavDropdownScroll?.release(); } catch {}
    this.previewNavDropdownScroll = null;
    this.resetPreviewMarkdownState({ clearCache: true });
    this.previewItem = null;
    this._currentPreviewKey = null;
    closeOverlay(props().overlay);
  }

  adjustWindowSize(deltaW, deltaH, cx) {
    const defaultW = this.showPreview ? 1050 : 680;
    const minW = this.showPreview ? 860 : 540;
    const minH = 220;
    const maxW = 1900;
    const maxH = 900;

    const currentW = this.customWidth || defaultW;
    const currentH = this.customListHeight || LIST_H;

    this.customWidth = Math.max(minW, Math.min(maxW, currentW + deltaW));
    this.customListHeight = Math.max(minH, Math.min(maxH, currentH + deltaH));
    setShared("files-search.customSize", { w: this.customWidth, h: this.customListHeight });
    cx.notify();
  }

  startResize(e, defaultW, cx) {
    this.resizing = true;
    this.resizeStartX = e.position.x;
    this.resizeStartY = e.position.y;
    this.resizeStartW = this.customWidth || defaultW;
    this.resizeStartH = this.customListHeight || LIST_H;
    try { this._resizeNotifyTask?.cancel(); } catch {}
    this._resizeNotifyTask = null;
    cx.stop_propagation();
    cx.notify();
  }

  handleResizeMove(e, minW, maxW, minH, maxH, cx) {
    if (!this.resizing) return;
    const totalDx = e.position.x - this.resizeStartX;
    const totalDy = e.position.y - this.resizeStartY;
    const nextW = Math.max(minW, Math.min(maxW, Math.round(this.resizeStartW + totalDx)));
    const nextH = Math.max(minH, Math.min(maxH, Math.round(this.resizeStartH + totalDy)));
    if (nextW === this.customWidth && nextH === this.customListHeight) return;
    this.customWidth = nextW;
    this.customListHeight = nextH;
    if (this._resizeNotifyTask || !cx?.timer) {
      if (!cx?.timer) cx.notify();
      return;
    }
    this._resizeNotifyTask = cx.timer.after(16, timerCx => {
      this._resizeNotifyTask = null;
      if (!this._overlayClosed) timerCx.notify();
    });
  }

  handleResizeEnd(cx) {
    if (!this.resizing) return;
    this.resizing = false;
    try { this._resizeNotifyTask?.cancel(); } catch {}
    this._resizeNotifyTask = null;
    setShared("files-search.customSize", { w: this.customWidth, h: this.customListHeight });
    cx.notify();
  }

  selectResult(item, cx) {
    if (!item) return;
    if (item.kind === "dir") {
      if (!isFilesVisible()) {
        run("layout.select", { stack: "panel-body", child: "files" });
        run("layout.show", { id: "panel" });
      }
      setShared("files-search.select", {
        root: this.searchRoot,
        path: item.path,
        kind: "dir",
        line: null,
        ts: Date.now(),
      });
      this.closeOverlay();
      cx.notify();
      return;
    }

    const line = item.line ? Number(item.line) : null;
    const absPath = resolveViewerFilePath(this.searchRoot, item.path);
    const svc = resolveServiceForFile(this.searchRoot, item.path, absPath, this.searchIsWindows);
    openFileInTab({
      spaceId: this.searchSpaceId || spaces().find(s => s.active)?.id || null,
      root: this.searchRoot,
      path: item.path,
      on: this.searchOn ?? null,
      line,
      serviceId: svc.serviceId,
      serviceName: svc.serviceName,
    });
    setShared("files-search.select", {
      root: this.searchRoot,
      path: item.path,
      kind: "reveal",
      line,
      ts: Date.now(),
    });
    this.closeOverlay();
    cx.notify();
  }

  resetPreviewMarkdownState({ clearCache = false } = {}) {
    this.previewMarkdownRendered = false;
    this.previewMarkdownSeq = (this.previewMarkdownSeq || 0) + 1;
    this.previewMarkdownLoading = false;
    this.previewMarkdownError = null;
    this.previewMarkdownFullText = null;
    this.previewMarkdownFullPath = null;
    this.previewDisambig = null;
    this.previewNavNotice = null;
    this.previewHoveredTokenKey = null;
    if (clearCache) {
      this.previewMarkdownCache?.clear();
    }
  }

  setPreviewNavNotice(notice, cx) {
    try { this.previewNoticeTask?.cancel(); } catch {}
    this.previewNoticeTask = null;
    this.previewNavNotice = notice || null;
    if (notice && cx?.timer) {
      this.previewNoticeTask = cx.timer.after(3200, timerCx => {
        this.previewNoticeTask = null;
        if (this._overlayClosed) return;
        this.previewNavNotice = null;
        timerCx.notify();
      });
    }
    cx?.notify?.();
  }

  handlePreviewTokenHover(nextKey, _tokenKey, cx) {
    if (this._overlayClosed) return;
    const prev = this.previewHoveredTokenKey || null;
    if (nextKey) {
      if (prev === nextKey) return;
      this.previewHoveredTokenKey = nextKey;
    } else {
      if (!prev || (_tokenKey && prev !== _tokenKey)) return;
      this.previewHoveredTokenKey = null;
    }
    if (this.previewCtrlHeld) {
      cx.notify();
    }
  }

  openPreviewDisambigCandidate(cand, originEntry, cx) {
    if (this._overlayClosed || !cand || !cand.filePath) return;
    this.previewDisambig = null;
    openFileInTab({
      spaceId: this.searchSpaceId || spaces().find(s => s.active)?.id || null,
      root: cand.root || cand.serviceRoot || this.searchRoot || "",
      path: cand.filePath,
      on: cand.on ?? this.searchOn ?? null,
      line: cand.line || 1,
      column: cand.column || 1,
      highlightSymbol: cand.name || cand.symbol || originEntry?.symbol || null,
      navOrigin: originEntry || null,
      serviceId: cand.serviceId || null,
      serviceName: cand.serviceName || null,
    });
    this.closeOverlay();
    cx?.notify?.();
  }

  handlePreviewTokenClick(item, tokenInfo, cx) {
    if (this._overlayClosed || !item || !item.path || !tokenInfo) return;
    const navSeq = ++this.previewNavSeq;
    const isWin = this.searchIsWindows;
    const on = this.searchOn ?? null;
    const absPath = resolveViewerFilePath(this.searchRoot, item.path);
    if (!absPath) return;

    const itemSvc = resolveServiceForFile(this.searchRoot, item.path, absPath, isWin);
    const services = collectRegisteredServices();
    const matchedSvc = services.find(s => s.id && s.id === itemSvc.serviceId)
      || services.find(s => s.root && isSameOrChildPath(absPath, s.root, isWin))
      || null;
    const svcRoot = matchedSvc?.root || this.searchRoot || "";

    const originEntry = {
      root: svcRoot,
      path: absPath,
      on,
      serviceId: matchedSvc?.id || itemSvc.serviceId || null,
      serviceName: matchedSvc?.name || itemSvc.serviceName || null,
      line: tokenInfo.line,
      column: tokenInfo.col,
      symbol: tokenInfo.symbol,
    };

    cx.spawn(async spawnCx => {
      try {
        const previewCacheKey = `${on || ""}::${absPath}`;
        let sourceText = null;
        if (!this.previewHasMore && (this.previewStartLine || 1) === 1 && this.previewLines.length > 0) {
          sourceText = this.previewLines.join("\n");
        } else if (this.previewFullTextCache?.has(previewCacheKey)) {
          sourceText = this.previewFullTextCache.get(previewCacheKey);
          this.previewFullTextCache.delete(previewCacheKey);
          this.previewFullTextCache.set(previewCacheKey, sourceText);
        } else {
          sourceText = await readTextFile(absPath, { on });
          if (typeof sourceText === "string" && this.previewFullTextCache) {
            if (this.previewFullTextCache.size >= 20) {
              const oldestKey = this.previewFullTextCache.keys().next().value;
              if (oldestKey !== undefined) this.previewFullTextCache.delete(oldestKey);
            }
            this.previewFullTextCache.set(previewCacheKey, sourceText);
          }
        }
        if (this._overlayClosed || navSeq !== this.previewNavSeq) return;
        if (typeof sourceText !== "string") {
          this.setPreviewNavNotice(buildViewerNavigationNotice({ status: "not-found" }, { symbol: tokenInfo.symbol }), spawnCx);
          return;
        }

        const indexedFilesByRoot = collectIndexedFilesByRoot(services, this.searchRoot, on);
        const result = await resolveCrossFileNavigation({
          sourceText,
          filePath: absPath,
          line: tokenInfo.line,
          col: tokenInfo.col,
          currentRoot: svcRoot,
          on,
          services,
          indexedFilesByRoot,
          appHomeDir: getSafeAppHome(),
        });
        if (this._overlayClosed || navSeq !== this.previewNavSeq) return;

        if (result?.status === "ok" && result.best) {
          this.openPreviewDisambigCandidate(result.best, originEntry, spawnCx);
          return;
        }
        if (result?.status === "ambiguous" && Array.isArray(result.candidates) && result.candidates.length > 0) {
          this.previewNavNotice = null;
          this.previewDisambig = {
            candidates: result.candidates,
            selectedIndex: 0,
            origin: originEntry,
            root: svcRoot,
            serviceName: originEntry.serviceName || "",
            symbol: tokenInfo.symbol || "",
            mode: result.mode || result?.context?.intent || null,
            anchorRect: computeLocalAnchorRect(tokenInfo, this._overlayContainerBounds, this._overlayLastPointer),
          };
          spawnCx.notify();
          return;
        }
        this.setPreviewNavNotice(
          buildViewerNavigationNotice(result, result?.context || { symbol: tokenInfo.symbol }, result?.context?.intent),
          spawnCx,
        );
      } catch {
        if (!this._overlayClosed && navSeq === this.previewNavSeq) {
          this.setPreviewNavNotice(buildViewerNavigationNotice({ status: "not-found" }, { symbol: tokenInfo.symbol }), spawnCx);
        }
      }
    });
  }

  togglePreviewMarkdown(item, cx) {
    if (!item || item.kind === "dir" || !isMarkdownFile(item.path) || this.previewError) return;
    if (this.previewLoading && this.previewLines.length === 0) return;

    const nextRendered = !this.previewMarkdownRendered;
    this.previewMarkdownRendered = nextRendered;

    if (!nextRendered) {
      this.previewMarkdownSeq = (this.previewMarkdownSeq || 0) + 1;
      this.previewMarkdownLoading = false;
      this.previewMarkdownError = null;
      cx.notify();
      return;
    }

    this.previewMarkdownError = null;
    if (
      this.previewMarkdownFullPath === item.path &&
      typeof this.previewMarkdownFullText === "string"
    ) {
      this.previewMarkdownLoading = false;
      cx.notify();
      return;
    }

    if (!shouldLoadFullMarkdownPreview(this.previewStartLine, this.previewHasMore)) {
      this.previewMarkdownLoading = false;
      cx.notify();
      return;
    }

    this.loadPreviewMarkdownFull(item, cx, { notifyOnStart: true });
  }

  loadPreviewMarkdownFull(item, cx, { notifyOnStart = true } = {}) {
    if (this._overlayClosed || !item || item.kind === "dir" || !isMarkdownFile(item.path)) return;
    const root = this.searchRoot;
    const on = this.searchOn ?? null;
    const targetPath = item.path;
    const fullPath = resolveViewerFilePath(root, targetPath);
    if (!fullPath) {
      this.previewMarkdownError = "Cannot resolve Markdown file path";
      this.previewMarkdownLoading = false;
      if (notifyOnStart) cx.notify();
      return;
    }

    const mdSeq = ++this.previewMarkdownSeq;
    const reqSeq = this.previewReqSeq;
    this.previewMarkdownLoading = true;
    this.previewMarkdownError = null;
    if (notifyOnStart) cx.notify();

    cx.spawn(async innerCx => {
      try {
        const text = await readTextFile(fullPath, { on });
        if (
          this._overlayClosed ||
          mdSeq !== this.previewMarkdownSeq ||
          reqSeq !== this.previewReqSeq ||
          this.previewItem?.path !== targetPath ||
          !this.previewMarkdownRendered
        ) {
          return;
        }
        if (text === null || typeof text !== "string") {
          this.previewMarkdownError = "File not found or unreadable";
          return;
        }
        if (text.includes("\0")) {
          this.previewMarkdownError = "Binary file · no text preview";
          return;
        }
        this.previewMarkdownFullPath = targetPath;
        this.previewMarkdownFullText = text;
        this.previewMarkdownError = null;
      } catch {
        if (
          !this._overlayClosed &&
          mdSeq === this.previewMarkdownSeq &&
          reqSeq === this.previewReqSeq &&
          this.previewItem?.path === targetPath
        ) {
          this.previewMarkdownError = "Cannot preview this Markdown file";
        }
      } finally {
        if (
          !this._overlayClosed &&
          mdSeq === this.previewMarkdownSeq &&
          reqSeq === this.previewReqSeq &&
          this.previewItem?.path === targetPath
        ) {
          this.previewMarkdownLoading = false;
          innerCx.notify();
        }
      }
    });
  }

  renderPreviewMarkdown(t, item) {
    const isLoading = Boolean(this.previewMarkdownLoading || (this.previewLoading && this.previewLines.length === 0));
    const hasFullSnapshot = Boolean(
      this.previewMarkdownFullPath === item.path && typeof this.previewMarkdownFullText === "string"
    );
    const needsFullFetch = !hasFullSnapshot && shouldLoadFullMarkdownPreview(this.previewStartLine, this.previewHasMore);
    const sourceTag = hasFullSnapshot ? "full" : `chunk-${this.previewLines.length}`;
    const mdIds = buildPreviewMarkdownViewIds(item.path, this.previewMarkdownSeq, sourceTag);
    const monoFont = settings()?.font_family || "monospace";

    if (this.previewMarkdownError) {
      return renderMarkdownViewer({
        id: mdIds.id,
        scrollId: mdIds.scrollId,
        error: this.previewMarkdownError,
        monoFont,
        paddingX: 14,
        paddingY: 10,
        t,
      });
    }

    if (isLoading || needsFullFetch) {
      return renderMarkdownViewer({
        id: mdIds.id,
        scrollId: mdIds.scrollId,
        loading: true,
        monoFont,
        paddingX: 14,
        paddingY: 10,
        t,
      });
    }

    const rawText = hasFullSnapshot ? this.previewMarkdownFullText : this.previewLines.join("\n");
    const cacheKey = hasFullSnapshot ? `full:${item.path}` : `chunk:${item.path}:${this.previewLines.length}`;
    if (!this.previewMarkdownCache) {
      this.previewMarkdownCache = createMarkdownRenderCache(12);
    }
    const prepared = this.previewMarkdownCache.getOrPrepare(cacheKey, rawText, { filePath: item.path });

    return renderMarkdownViewer({
      id: mdIds.id,
      scrollId: mdIds.scrollId,
      prepared,
      filePath: item.path,
      monoFont,
      paddingX: 14,
      paddingY: 10,
      t,
    });
  }

  schedulePreview(item, cx, immediate = false) {
    try { this._pendingPreviewScheduleTask?.cancel(); } catch {}
    this._pendingPreviewScheduleTask = null;
    this._pendingPreviewScheduleKey = null;
    if (!item) {
      this.previewDebounceTask?.cancel();
      this.previewDebounceTask = null;
      this.previewReqSeq++;
      this.resetPreviewMarkdownState();
      this.previewItem = null;
      this.previewIsDir = false;
      this.previewDirEntries = [];
      this.previewLines = [];
      this.previewStartLine = 1;
      this.previewHasMore = false;
      this.previewLoading = false;
      this.previewLoadingMore = false;
      this.previewError = null;
      this._currentPreviewKey = null;
      return;
    }

    const itemKey = `${item.kind || "file"}:${item.path}:${item.line || 0}`;
    if (
      this._currentPreviewKey === itemKey &&
      (this.previewLines.length > 0 || this.previewDirEntries.length > 0 || this.previewError || this.previewIsDir)
    ) {
      return;
    }
    if (shouldResetPreviewMarkdown(this.previewItem, item)) {
      this.resetPreviewMarkdownState();
    }
    this._currentPreviewKey = itemKey;
    this.previewItem = item;
    this.previewIsDir = item.kind === "dir";

    // Check memory cache first
    const cached = this.previewCache.get(itemKey);
    if (cached) {
      this.previewCache.delete(itemKey);
      this.previewCache.set(itemKey, cached);
      this.previewDebounceTask?.cancel();
      this.previewDebounceTask = null;
      if (cached.kind === "dir") {
        this.previewIsDir = true;
        this.previewDirEntries = cached.dirEntries;
        this.previewLines = [];
        this.previewStartLine = 1;
        this.previewHasMore = false;
        this.previewScroll = 0;
      } else {
        this.previewIsDir = false;
        this.previewDirEntries = [];
        this.previewLines = cached.lines;
        this.previewStartLine = cached.startLine;
        this.previewHasMore = cached.hasMore;
        this.previewScroll = cached.scroll;
      }
      this.previewError = null;
      this.previewLoading = false;
      this.previewLoadingMore = false;
      if (
        this.previewMarkdownRendered &&
        !this.previewIsDir &&
        isMarkdownFile(item.path) &&
        this.previewMarkdownFullPath !== item.path &&
        shouldLoadFullMarkdownPreview(this.previewStartLine, this.previewHasMore)
      ) {
        this.loadPreviewMarkdownFull(item, cx, { notifyOnStart: immediate });
      }
      return;
    }

    this.previewLoading = true;
    this.previewError = null;
    if (this.previewIsDir) {
      this.previewDirEntries = [];
      this.previewLines = [];
    }

    if (this.previewDebounceTask) {
      this.previewDebounceTask.cancel();
      this.previewDebounceTask = null;
    }

    const reqSeq = ++this.previewReqSeq;
    const root = this.searchRoot;
    const on = this.searchOn;
    const isWindows = this.searchIsWindows ?? (!on && window()?.platform === "windows");
    const targetPath = item.path;
    const isDir = item.kind === "dir";
    const targetLine = item.kind === "text" && item.line ? item.line : null;
    const startLine = targetLine ? Math.max(1, targetLine - 20) : 1;

    const fetchAction = (asyncCx) => {
      asyncCx.spawn(async cx => {
        try {
          if (isDir) {
            const rawEntries = await directory(joinSubPath(root, targetPath), on, isWindows);
            if (reqSeq !== this.previewReqSeq) return;
            const trimmed = Array.isArray(rawEntries) && rawEntries.length > PER_FOLDER
              ? rawEntries.slice(0, PER_FOLDER)
              : (rawEntries || []);
            const sorted = sortDirectoryEntries(trimmed);
            this.previewIsDir = true;
            this.previewDirEntries = sorted;
            this.previewLines = [];
            this.previewHasMore = false;
            this.previewScroll = 0;

            if (this.previewCache.size > 80) {
              const firstKey = this.previewCache.keys().next().value;
              this.previewCache.delete(firstKey);
            }
            this.previewCache.set(itemKey, { kind: "dir", dirEntries: sorted });
            return;
          }

          const fullPath = `${root}/${targetPath}`;
          const lines = await readFileChunk(fullPath, startLine, CHUNK_SIZE, on, isWindows);
          if (reqSeq !== this.previewReqSeq) return;
          if (lines === null) {
            this.previewError = "File not found or unreadable";
            this.previewLines = [];
            return;
          }
          if (lines === "binary") {
            this.previewError = "Binary file · no text preview";
            this.previewLines = [];
            return;
          }

          this.previewIsDir = false;
          this.previewDirEntries = [];
          this.previewLines = lines;
          this.previewStartLine = startLine;
          this.previewHasMore = lines.length >= CHUNK_SIZE;
          if (targetLine) {
            this.previewScroll = Math.max(0, targetLine - startLine - 6);
          } else {
            this.previewScroll = 0;
          }

          if (this.previewCache.size > 80) {
            const firstKey = this.previewCache.keys().next().value;
            this.previewCache.delete(firstKey);
          }
          this.previewCache.set(itemKey, {
            kind: "file",
            lines: [...lines],
            startLine,
            hasMore: this.previewHasMore,
            scroll: this.previewScroll,
          });
          if (
            this.previewMarkdownRendered &&
            isMarkdownFile(targetPath) &&
            this.previewMarkdownFullPath !== targetPath &&
            shouldLoadFullMarkdownPreview(this.previewStartLine, this.previewHasMore)
          ) {
            this.loadPreviewMarkdownFull(item, cx, { notifyOnStart: false });
          }
        } catch {
          if (reqSeq === this.previewReqSeq) {
            this.previewError = isDir ? "Cannot list this folder" : "Cannot preview this file";
            this.previewLines = [];
            this.previewDirEntries = [];
          }
        } finally {
          if (reqSeq === this.previewReqSeq) {
            this.previewLoading = false;
            cx.notify();
          }
        }
      });
    };

    if (immediate) {
      fetchAction(cx);
    } else {
      this.previewDebounceTask = cx.timer.after(90, cx => fetchAction(cx));
    }
  }

  loadNextPreviewChunk(cx) {
    if (!this.previewItem || this.previewIsDir || this.previewItem.kind === "dir" || !this.previewHasMore || this.previewLoadingMore || this.previewLoading) return;
    this.previewLoadingMore = true;

    const reqSeq = this.previewReqSeq;
    const root = this.searchRoot;
    const on = this.searchOn;
    const isWindows = this.searchIsWindows ?? (!on && window()?.platform === "windows");
    const targetPath = this.previewItem.path;
    const itemKey = `${this.previewItem.kind || "file"}:${this.previewItem.path}:${this.previewItem.line || 0}`;
    const nextStartLine = this.previewStartLine + this.previewLines.length;

    cx.spawn(async cx => {
      try {
        const fullPath = `${root}/${targetPath}`;
        const newLines = await readFileChunk(fullPath, nextStartLine, CHUNK_SIZE, on, isWindows);
        if (reqSeq !== this.previewReqSeq) return;
        if (Array.isArray(newLines) && newLines.length > 0) {
          this.previewLines = this.previewLines.concat(newLines);
          this.previewHasMore = newLines.length >= CHUNK_SIZE;
          const cached = this.previewCache.get(itemKey);
          if (cached) {
            cached.lines = this.previewLines;
            cached.hasMore = this.previewHasMore;
            this.previewCache.delete(itemKey);
            this.previewCache.set(itemKey, cached);
          }
        } else {
          this.previewHasMore = false;
        }
      } catch {
        this.previewHasMore = false;
      } finally {
        if (reqSeq === this.previewReqSeq) {
          this.previewLoadingMore = false;
          cx.notify();
        }
      }
    });
  }

  updatePreview(item, cx, immediate = false) {
    this.schedulePreview(item, cx, immediate);
  }

  async loadWorkspaceFiles(cx) {
    const root = this.searchRoot;
    const on = this.searchOn;
    const isWindows = this.searchIsWindows ?? (!on && window()?.platform === "windows");
    if (!root) return;
    const indexKey = makeIndexKey(root, on, isWindows);
    this.isIndexingFiles = true;

    cx.spawn(async cx => {
      try {
        if (!this.fileEntries.length) {
          const diskCached = await restoreDiskIndex(root, on, isWindows, cx);
          if (this._overlayClosed) return;
          if (diskCached && Array.isArray(diskCached.entries) && diskCached.entries.length > 0) {
            this.fileList = diskCached.files || diskCached.list || [];
            this.fileEntries = diskCached.entries;
            this._fileQueryCache.clear();
            this._narrowHistory = [];
            this._combinedCacheKey = null;
            if (this.tab !== "text") {
              this.triggerFileSearch(cx);
            }
            cx.notify();
          }
        }

        const latestCached = getCachedIndex(indexKey);
        if (!latestCached || shouldRefreshIndex(latestCached, on)) {
          const record = await ensureWorkspaceIndex({ root, on, isWindows, discoverRepos, cx });
          if (this._overlayClosed) return;
          if (record && Array.isArray(record.entries)) {
            this.fileList = record.files || record.list || [];
            this.fileEntries = record.entries;
            this._fileQueryCache.clear();
            this._narrowHistory = [];
            this._combinedCacheKey = null;
            if (this.tab !== "text") {
              this.triggerFileSearch(cx);
            }
          }
        }
      } catch {
        if (!this._overlayClosed && !this.fileEntries.length) {
          this.fileList = [];
          this.fileEntries = [];
          this.fileResults = [];
          this._fileResultsVer++;
          this._combinedCacheKey = null;
        }
      } finally {
        if (!this._overlayClosed) {
          this.isIndexingFiles = false;
          cx.notify();
        }
      }
    });
  }

  triggerFileSearch(cx) {
    this.fileSearchTask?.cancel();
    this.fileSearchTask = null;
    const seq = ++this.fileSearchSeq;

    if (this._overlayClosed || this.tab === "text") {
      this.isSearchingFiles = false;
      if (this.tab === "text") {
        this.fileResults = [];
        this._fileResultsVer++;
        this._combinedCacheKey = null;
      }
      return;
    }

    const qs = prepareSearchQuery(this.query);
    if (!qs) {
      this.isSearchingFiles = false;
      this.fileResults = [];
      this._fileResultsVer++;
      this._combinedCacheKey = null;
      return;
    }
    const { q } = qs;

    const cached = this._fileQueryCache.get(q);
    if (cached) {
      this.isSearchingFiles = false;
      this.fileResults = cached;
      this._fileResultsVer++;
      this._combinedCacheKey = null;
      return;
    }

    let source = this.fileEntries;
    for (let i = this._narrowHistory.length - 1; i >= 0; i--) {
      const prev = this._narrowHistory[i];
      if (q.startsWith(prev.q) && prev.matchedEntries.length < source.length) {
        source = prev.matchedEntries;
      }
    }

    if (!source.length) {
      this.isSearchingFiles = false;
      this.fileResults = [];
      this._fileResultsVer++;
      this._combinedCacheKey = null;
      return;
    }

    const matchedEntries = [];
    const top = [];
    let minTopScore = -Infinity;
    let minTopIdx = 0;
    let cursor = 0;

    const scanBatch = () => {
      const batchStart = Date.now();
      let count = 0;
      const len = source.length;
      while (cursor < len) {
        const entry = source[cursor++];
        const { score, fromName } = scoreIndexEntry(entry, qs);

        if (score > -Infinity) {
          matchedEntries.push(entry);
          if (top.length < MAX_FILE_RESULTS) {
            top.push({ entry, score, fromName });
            if (top.length === MAX_FILE_RESULTS) {
              minTopScore = top[0].score;
              minTopIdx = 0;
              for (let k = 1; k < top.length; k++) {
                if (top[k].score < minTopScore) {
                  minTopScore = top[k].score;
                  minTopIdx = k;
                }
              }
            }
          } else if (score > minTopScore) {
            top[minTopIdx] = { entry, score, fromName };
            minTopScore = top[0].score;
            minTopIdx = 0;
            for (let k = 1; k < top.length; k++) {
              if (top[k].score < minTopScore) {
                minTopScore = top[k].score;
                minTopIdx = k;
              }
            }
          }
        }

        count++;
        if (count >= FILE_SEARCH_CHUNK && cursor < len) {
          if (count >= FILE_SEARCH_CHUNK * 2 || (Date.now() - batchStart) >= FILE_SEARCH_BUDGET_MS) {
            return false;
          }
        }
        if ((count & 255) === 0 && cursor < len && (Date.now() - batchStart) >= FILE_SEARCH_BUDGET_MS) {
          return false;
        }
      }
      return true;
    };

    const finishScan = (stepCx, shouldNotify) => {
      const finalResults = buildTopFileItems(top, qs.matchKey, true);
      if (this._fileQueryCache.size > 40) this._fileQueryCache.clear();
      this._fileQueryCache.set(q, finalResults);
      if (this._narrowHistory.length >= 8) this._narrowHistory.shift();
      this._narrowHistory.push({ q, matchedEntries });

      this.fileResults = finalResults;
      this.isSearchingFiles = false;
      this._fileResultsVer++;
      this._combinedCacheKey = null;
      if (this.showPreview) {
        const items = this.searchResults();
        this.schedulePreview(items[0], stepCx, false);
      }
      if (shouldNotify) stepCx.notify();
    };

    // Execute first bounded batch right away; yield across chunks if source is large
    if (scanBatch()) {
      finishScan(cx, false);
      return;
    }

    if (top.length > 0) {
      this.fileResults = buildTopFileItems(top, qs.matchKey, false);
      this._fileResultsVer++;
      this._combinedCacheKey = null;
    }
    this.isSearchingFiles = true;

    const scheduleNext = (timerCx) => {
      this.fileSearchTask = timerCx.timer.after(0, nextCx => {
        this.fileSearchTask = null;
        if (this._overlayClosed || seq !== this.fileSearchSeq) return;
        if (scanBatch()) {
          finishScan(nextCx, true);
        } else {
          scheduleNext(nextCx);
        }
      });
    };
    scheduleNext(cx);
  }

  triggerTextSearch(cx) {
    const q = this.query.trim();
    if (this._overlayClosed || this.tab === "files" || !q || q.length < 2) {
      this.textResults = [];
      this.isSearchingText = false;
      this._textResultsVer++;
      this._combinedCacheKey = null;
      if (this.textSearchTask) {
        this.textSearchTask.cancel();
        this.textSearchTask = null;
      }
      return;
    }

    if (this.textQueryCache.has(q)) {
      if (this.textSearchTask) {
        this.textSearchTask.cancel();
        this.textSearchTask = null;
      }
      this.searchSeq++;
      this.textResults = this.textQueryCache.get(q);
      this.isSearchingText = false;
      this._textResultsVer++;
      this._combinedCacheKey = null;
      return;
    }

    const seq = ++this.searchSeq;
    const root = this.searchRoot;
    const on = this.searchOn;
    const onKey = on || "local";
    const isWindows = this.searchIsWindows ?? (!on && window()?.platform === "windows");
    this.isSearchingText = true;

    if (this.textSearchTask) {
      this.textSearchTask.cancel();
      this.textSearchTask = null;
    }

    const delay = q.length <= 2 ? 260 : 160;
    this.textSearchTask = cx.timer.after(delay, cx => {
      this.textSearchTask = null;
      if (this._overlayClosed || seq !== this.searchSeq) return;
      cx.spawn(async cx => {
        try {
          const results = [];
          const rgBaseArgs = [
            "--vimgrep", "--no-heading", "--color=never", "--smart-case",
            "--path-separator", "/", "--max-count=2", "--max-columns=200",
            "--max-filesize", "256K", "--threads", "4",
            ...COMMON_IGNORE_GLOBS,
            "--glob", "!*.min.js", "--glob", "!*.min.css", "--glob", "!*.map",
          ];
          const rgPipeScript = 'command -v rg >/dev/null 2>&1 || exit 127; rg "$@" 2>/dev/null | head -n 320';
          const runRg = async (args) => {
            if (!isWindows) {
              const r = await exec("sh", ["-c", rgPipeScript, "sh", ...args], { cwd: root, on, timeout: 8000 }).catch(() => null);
              if (r && r.code === 127) {
                RG_AVAILABLE_CACHE.set(onKey, false);
                return null;
              }
              return r;
            }
            return exec("rg", args, { cwd: root, on, timeout: 8000 }).catch(() => null);
          };

          let res = null;
          let rgChecked = false;
          if (RG_AVAILABLE_CACHE.get(onKey) !== false) {
            rgChecked = true;
            res = await runRg([...rgBaseArgs, "--", q]);
            if (this._overlayClosed || seq !== this.searchSeq) return;
            if (
              res &&
              (res.code === 2 || (!isWindows && res.code === 0 && !res.stdout && /[.*+?^${}()|[\]\\]/.test(q)))
            ) {
              // Query contains unescaped regex characters; retry as literal fixed string.
              res = await runRg([...rgBaseArgs, "-F", "--", q]);
              if (this._overlayClosed || seq !== this.searchSeq) return;
            }
            if (res) {
              RG_AVAILABLE_CACHE.set(onKey, true);
            } else if (RG_AVAILABLE_CACHE.get(onKey) !== false) {
              const probe = await exec("rg", ["--version"], { on, timeout: 2500 }).catch(() => null);
              if (this._overlayClosed || seq !== this.searchSeq) return;
              RG_AVAILABLE_CACHE.set(onKey, Boolean(probe && probe.code === 0));
            }
          }

          if (res && res.code === 0) {
            if (res.stdout) parseSearchOutputLines(res.stdout, q, "", MAX_TEXT_RESULTS, results);
          } else if (res && res.code === 1) {
            // Ripgrep exit code 1 means zero matches (not missing ripgrep).
          } else if (!rgChecked || !res) {
            // Fallback when rg is unavailable or failed unexpectedly
            const rev = await exec(
              "git",
              ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "rev-parse", "--show-toplevel"],
              { cwd: root, on, timeout: 4000 }
            ).catch(() => null);
            if (this._overlayClosed || seq !== this.searchSeq) return;

            const runGitGrep = async (cwd) => {
              const gitArgs = [
                "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false",
                "grep", "-nI", "-F", "-i", "-m", "2", "--", q,
              ];
              if (!isWindows) {
                return exec(
                  "sh",
                  ["-c", 'git "$@" 2>/dev/null | head -n 320', "sh", ...gitArgs],
                  { cwd, on, timeout: 6000 }
                ).catch(() => null);
              }
              return exec("git", gitArgs, { cwd, on, timeout: 6000 }).catch(() => null);
            };

            if (rev?.code === 0) {
              const gitRes = await runGitGrep(root);
              if (this._overlayClosed || seq !== this.searchSeq) return;
              if (gitRes && gitRes.stdout) {
                parseSearchOutputLines(gitRes.stdout, q, "", MAX_TEXT_RESULTS, results);
              }
            } else {
              const bus = shared("cognivisor.services");
              const hasBusCandidates = Boolean(
                bus &&
                normPathStr(bus.workspaceRoot) === normPathStr(root) &&
                (bus.on || null) === (on || null) &&
                Array.isArray(bus.candidates) &&
                bus.candidates.length > 0
              );
              const services = hasBusCandidates ? bus.candidates : await discoverRepos(root, on, isWindows);
              if (this._overlayClosed || seq !== this.searchSeq) return;
              if (services && services.length > 0) {
                const activeId = shared("cognivisor.activeService")?.serviceId;
                const ordered = activeId
                  ? [...services].sort((a, b) => (b.id === activeId ? 1 : 0) - (a.id === activeId ? 1 : 0))
                  : services;
                await runInBatches(
                  ordered,
                  4,
                  async s => {
                    const sRes = await runGitGrep(s.root);
                    if (this._overlayClosed || seq !== this.searchSeq || !sRes || !sRes.stdout) return;
                    const prefix = s.relPath ? `${s.relPath}/` : "";
                    parseSearchOutputLines(sRes.stdout, q, prefix, MAX_TEXT_RESULTS, results);
                  },
                  () => this._overlayClosed || seq !== this.searchSeq || results.length >= MAX_TEXT_RESULTS
                );
              }
            }
          }

          if (this._overlayClosed || seq !== this.searchSeq) return;
          if (this.textQueryCache.size >= 24) {
            const oldestQ = this.textQueryCache.keys().next().value;
            if (oldestQ !== undefined) this.textQueryCache.delete(oldestQ);
          }
          this.textQueryCache.set(q, results);
          this.textResults = results;
          this._textResultsVer++;
          this._combinedCacheKey = null;
        } catch {
          if (!this._overlayClosed && seq === this.searchSeq) {
            this.textResults = [];
            this._textResultsVer++;
            this._combinedCacheKey = null;
          }
        } finally {
          if (!this._overlayClosed && seq === this.searchSeq) {
            this.isSearchingText = false;
            if (this.showPreview) {
              const items = this.searchResults();
              this.schedulePreview(items[0], cx, false);
            }
            cx.notify();
          }
        }
      });
    });
  }

  setTab(tab, cx) {
    if (this.tab === tab) return;
    this.tab = tab;
    this.at = 0;
    this.scroll = 0;
    this._combinedCacheKey = null;
    if (tab === "all" || tab === "files") {
      this.triggerFileSearch(cx);
    } else {
      this.fileSearchTask?.cancel();
      this.fileSearchTask = null;
      this.isSearchingFiles = false;
    }
    if (tab === "text" || tab === "all") {
      this.triggerTextSearch(cx);
    } else {
      this.textSearchTask?.cancel();
      this.textSearchTask = null;
      this.isSearchingText = false;
    }
    if (this.showPreview) {
      const items = this.searchResults();
      this.updatePreview(items[0], cx, true);
    }
    cx.notify();
  }

  cycleTab(direction, cx) {
    const tabs = ["all", "files", "text"];
    const idx = tabs.indexOf(this.tab);
    const nextIdx = (idx + direction + tabs.length) % tabs.length;
    this.setTab(tabs[nextIdx], cx);
  }

  // O(1) combiner returning cached precomputed file and text results
  searchResults() {
    const rawQ = this.query.trim().toLowerCase();
    if (!rawQ) return [];
    const cacheKey = `${this.tab}:${this._fileResultsVer}:${this._textResultsVer}:${rawQ}`;
    if (this._combinedCacheKey === cacheKey && this._combinedResults) {
      return this._combinedResults;
    }

    let out = [];
    if (this.tab === "files") {
      out = this.fileResults;
    } else if (this.tab === "text") {
      out = this.textResults;
    } else {
      out = [...this.fileResults.slice(0, 25), ...this.textResults.slice(0, 25)];
    }

    this._combinedCacheKey = cacheKey;
    this._combinedResults = out;
    return out;
  }

  renderHighlightedTitle(t, text, hits, isSelected) {
    const safeText = typeof text === "string" ? text : String(text ?? "");
    if (!hits || !hits.length) {
      return div().text_color(isSelected ? t.foreground : t.muted).child(safeText);
    }
    const parts = [];
    let cur = "";
    let lit = false;
    [...safeText].forEach((ch, i) => {
      const h = hits.includes(i);
      if (h !== lit && cur) {
        parts.push([cur, lit]);
        cur = "";
      }
      lit = h;
      cur += ch;
    });
    if (cur) parts.push([cur, lit]);

    return h_flex().children(
      parts.map(([s, h]) =>
        div()
          .text_color(h ? t.ansi4 : isSelected ? t.foreground : t.muted)
          .when(h, d => d.font_semibold())
          .child(String(s).replace(/ /g, "\u00a0"))
      )
    );
  }

  renderTextSnippet(t, content, query, isSelected) {
    const safeContent = typeof content === "string" ? content : String(content ?? "");
    const safeQuery = typeof query === "string" ? query : String(query ?? "");
    if (!safeContent || !safeQuery) return div().text_color(t.dim).child(safeContent);
    const lowerContent = safeContent.toLowerCase();
    const lowerQuery = safeQuery.toLowerCase();
    const idx = lowerContent.indexOf(lowerQuery);
    if (idx < 0) {
      return div().text_size(11.5).truncate().text_color(t.dim).child(safeContent);
    }

    const before = safeContent.slice(0, idx);
    const match = safeContent.slice(idx, idx + safeQuery.length);
    const after = safeContent.slice(idx + safeQuery.length);

    return h_flex()
      .text_size(11.5)
      .truncate()
      .child(div().text_color(t.dim).child(before.replace(/ /g, "\u00a0")))
      .child(div().text_color(t.ansi4).font_semibold().child(match.replace(/ /g, "\u00a0")))
      .child(div().text_color(t.dim).child(after.replace(/ /g, "\u00a0")));
  }

  renderWrappedSyntaxSegments(t, text, ext, query, isTarget, maxCols, resolvedFont = null, fillWidth = false, mdState = null, navOpts = null) {
    const fontFamily = resolvedFont || settings()?.font_family || "monospace";
    const applyWrapBox = (el) => (fillWidth ? el.flex_1().min_w(0).overflow_hidden() : el.flex_none());
    const cached = getCachedPreviewRows(text, ext, maxCols, mdState);

    if (cached.mode === "empty") {
      return [
        applyWrapBox(div())
          .whitespace_nowrap()
          .text_size(11.5)
          .font_family(fontFamily)
          .text_color(t.foreground)
          .child("\u00a0"),
      ];
    }

    return cached.rows.map((rowToks, wrapIdx) => {
      if (!rowToks.length) {
        return applyWrapBox(div()).text_size(11.5).font_family(fontFamily).text_color(t.muted).child("\u00a0");
      }
      return renderInteractiveTokenSegments({
        t,
        segments: rowToks,
        query: isTarget ? query : "",
        isTargetLine: isTarget,
        baseTarget: isTarget,
        monoFont: fontFamily,
        ctrlHeld: Boolean(navOpts?.ctrlHeld),
        hoveredTokenKey: navOpts?.hoveredTokenKey || null,
        idPrefix: navOpts?.idPrefix || "prev",
        lineNum: navOpts?.lineNum || 1,
        wrapIdx,
        fillWidth,
        onTokenHover: navOpts?.onTokenHover || null,
        onTokenClick: navOpts?.onTokenClick || null,
      });
    });
  }

  renderPreviewPane(t, item, cx, listH = LIST_H, previewW = 520) {
    if (!item) {
      return v_flex()
        .w(previewW)
        .h(listH + 46)
        .rounded(8)
        .border_1()
        .border_color(t.border)
        .bg(t.background)
        .justify_center()
        .items_center()
        .child(div().text_size(12).text_color(t.dim).child("Select an item to preview"));
    }

    const isDirItem = item.kind === "dir";
    const isTextMatch = item.kind === "text" && item.line;
    const targetLine = isTextMatch ? item.line : null;
    const fileName = item.path.split("/").pop() || item.path;
    const dirPath = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
    const ext = getSyntaxExt(item.path);

    const LINE_H = 21;
    const VISIBLE_ROWS = Math.max(5, Math.floor((listH - 6) / LINE_H));

    if (isDirItem) {
      const dirTotal = this.previewDirEntries.length;
      const maxDirScroll = Math.max(0, dirTotal - VISIBLE_ROWS);
      this.previewScroll = Math.max(0, Math.min(this.previewScroll, maxDirScroll));
      const startIdx = this.previewScroll;
      const endIdx = Math.min(dirTotal, startIdx + VISIBLE_ROWS);
      const visibleDirRows = [];
      for (let i = startIdx; i < endIdx; i++) {
        const child = this.previewDirEntries[i];
        const childPath = `${item.path}/${child.name}`.replace(/^\/+/, "");
        const childIcon = child.dir ? null : resolveFileIcon(childPath, t);
        visibleDirRows.push(
          h_flex()
            .id(`dir-prev-${i}`)
            .h(LINE_H)
            .flex_none()
            .items_center()
            .px(10)
            .gap(8)
            .cursor_pointer()
            .hover(s => s.bg(t.hover))
            .on_click(() => this.selectResult({ kind: child.dir ? "dir" : "file", path: childPath, name: child.name }, cx))
            .child(svg(child.dir ? "mods/files-search/folder.svg" : childIcon.path).size(13).flex_none().text_color(child.dir ? t.ansi4 : childIcon.color))
            .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(child.dir ? `${child.name}/` : child.name))
        );
      }

      return v_flex()
        .w(previewW)
        .h(listH + 46)
        .flex_none()
        .rounded(8)
        .border_1()
        .border_color(t.border)
        .bg(t.background)
        .overflow_hidden()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(
          h_flex()
            .h(34)
            .flex_none()
            .px(10)
            .gap(7)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .child(svg("mods/files-search/folder.svg").size(13).flex_none().text_color(t.ansi4))
            .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`${fileName}/`))
            .when(Boolean(dirPath), el =>
              el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dirPath))
            )
            .when(!dirPath, el => el.child(div().flex_1()))
            .when(dirTotal > 0, el =>
              el.child(div().text_size(11).text_color(t.dim).child(`${dirTotal} item${dirTotal === 1 ? "" : "s"}`))
            )
            .child(
              div()
                .px(7)
                .py(1.5)
                .rounded(4)
                .bg(t.background)
                .border_1()
                .border_color(t.border)
                .text_size(11)
                .text_color(t.dim)
                .cursor_pointer()
                .hover(s => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => this.selectResult(item, cx))
                .child("Open ↵")
            )
        )
        .child(
          v_flex()
            .flex_1()
            .min_h(0)
            .overflow_hidden()
            .when(this.previewLoading && dirTotal === 0, el =>
              el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child("Loading folder…"))
            )
            .when(!this.previewLoading && Boolean(this.previewError) && dirTotal === 0, el =>
              el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child(this.previewError))
            )
            .when(dirTotal > 0, el =>
              el
                .py(4)
                .on_scroll_wheel((e, cx) => {
                  if (!shouldAllowUnderlyingScroll({ hasDisambiguationPopover: Boolean(this.previewDisambig) })) return;
                  const delta = e.delta.y > 0 ? -3 : 3;
                  this.previewScroll = Math.max(0, Math.min(this.previewScroll + delta, maxDirScroll));
                  cx.notify();
                })
                .children(visibleDirRows)
            )
            .when(!this.previewLoading && !this.previewError && dirTotal === 0, el =>
              el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child("Empty folder"))
            )
        );
    }

    const isMd = isMarkdownFile(item.path);
    const showRenderedMd = Boolean(isMd && this.previewMarkdownRendered && !this.previewError);
    const monoFont = settings()?.font_family || "monospace";
    const visibleLines = [];

    if (!showRenderedMd) {
      const previewCols = computeWrapColumns({
        viewportWidth: previewW,
        gutterWidth: 53,
        rightPadding: 20,
        fontSize: 11.5,
        minCols: 12,
      });
      const maxScroll = Math.max(0, this.previewLines.length - VISIBLE_ROWS);
      this.previewScroll = Math.max(0, Math.min(this.previewScroll, maxScroll));

      const syntaxPal = getSyntaxPalette(t);
      const targetGutterColor = syntaxPal.type;
      const dimGutterColor = syntaxPal.comment;
      const startIdx = this.previewScroll;
      const endIdx = Math.min(this.previewLines.length, startIdx + VISIBLE_ROWS);
      let renderedVisualRows = 0;

      let mdState = createCodeSyntaxState(ext);
      if (mdState) {
        const baseLine = Math.max(0, (this.previewStartLine || 1) - 1);
        const linesArr = this.previewLines;
        let cache = this._previewMdCheckpoints;
        if (!cache || cache.linesRef !== linesArr || cache.baseLine !== baseLine || cache.ext !== ext) {
          mdState.lineIndex = baseLine;
          if (baseLine > 0 && isMarkdownExt(ext)) mdState.frontmatterClosed = true;
          cache = {
            linesRef: linesArr,
            baseLine,
            ext,
            checkpoints: [cloneSyntaxState(mdState)],
          };
          this._previewMdCheckpoints = cache;
        }
        const cpIdx = Math.min(Math.floor(startIdx / 32), cache.checkpoints.length - 1);
        mdState = cloneSyntaxState(cache.checkpoints[cpIdx]);
        for (let i = cpIdx * 32; i < startIdx; i++) {
          advanceSyntaxState(linesArr[i] ?? "", mdState, ext);
          if ((i + 1) % 32 === 0 && Math.floor((i + 1) / 32) === cache.checkpoints.length) {
            cache.checkpoints.push(cloneSyntaxState(mdState));
          }
        }
      }

      for (let i = startIdx; i < endIdx && renderedVisualRows < VISIBLE_ROWS; i++) {
        const lineNum = (this.previewStartLine || 1) + i;
        const isTarget = lineNum === targetLine;
        const gutterLineColor = isTarget ? targetGutterColor : dimGutterColor;
        const lineContent = this.previewLines[i] ?? "";
        const wrappedSegments = this.renderWrappedSyntaxSegments(
          t,
          lineContent,
          ext,
          isTarget ? item.matchedQuery : null,
          isTarget,
          previewCols,
          monoFont,
          true,
          mdState,
          {
            lineNum,
            idPrefix: "prev-cv",
            ctrlHeld: Boolean(this.previewCtrlHeld),
            hoveredTokenKey: this.previewHoveredTokenKey,
            onTokenHover: (nextKey, tokenKey, hoverCx) => this.handlePreviewTokenHover(nextKey, tokenKey, hoverCx),
            onTokenClick: (tokenInfo, _clickEv, clickCx) => this.handlePreviewTokenClick(item, tokenInfo, clickCx),
          }
        );
        if (mdState) {
          advanceSyntaxState(lineContent, mdState, ext);
        }

        for (let s = 0; s < wrappedSegments.length && renderedVisualRows < VISIBLE_ROWS; s++) {
          const isFirstSeg = s === 0;
          renderedVisualRows += 1;
          visibleLines.push(
            h_flex()
              .w_full()
              .h(LINE_H)
              .flex_none()
              .items_center()
              .pl(4)
              .pr(16)
              .gap(8)
              .cursor_pointer()
              .hover(st => st.bg(t.hover))
              .on_click(() => this.selectResult({ ...item, line: lineNum }, cx))
              .when(isTarget, el => el.bg(t.selected).border_l(3).border_color(t.accent))
              .when(!isTarget, el => el.border_l(3).border_color(t.background))
              // Line Number Gutter (blank on wrapped continuation rows)
              .child(
                div()
                  .w(38)
                  .flex_none()
                  .text_right()
                  .text_size(11)
                  .font_family(monoFont)
                  .text_color(gutterLineColor)
                  .when(isTarget, el => el.font_semibold())
                  .child(isFirstSeg ? String(lineNum) : "\u00a0")
              )
              // Soft-wrapped Line Content
              .child(wrappedSegments[s])
          );
        }
      }
    }

    return v_flex()
      .w(previewW)
      .h(listH + 46)
      .flex_none()
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.background)
      .overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      // Preview Header
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(10)
          .gap(7)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.raised)
          .child((() => {
            const previewIcon = resolveFileIcon(item.path, t);
            return svg(previewIcon.path).size(13).flex_none().text_color(previewIcon.color);
          })())
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child(fileName))
          .when(Boolean(dirPath), el =>
            el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dirPath))
          )
          .when(!dirPath, el => el.child(div().flex_1()))
          .when(Boolean(targetLine), el =>
            el.child(
              div()
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.selected)
                .border_1()
                .border_color(t.accent)
                .text_size(11)
                .font_family(monoFont)
                .font_semibold()
                .text_color(t.ansi3)
                .child(`line ${targetLine}`)
            )
          )
          .when(!targetLine && this.previewLines.length > 0, el =>
            el.child(
              div()
                .text_size(11)
                .text_color(t.dim)
                .child(`${this.previewLines.length}${this.previewHasMore ? "+" : ""} lines`)
            )
          )
          .when(!showRenderedMd && Boolean(this.previewLoadingMore), el =>
            el.child(
              div()
                .px(5)
                .py(1)
                .rounded(3)
                .bg(t.selected)
                .text_size(10.5)
                .font_medium()
                .text_color(t.ansi4)
                .child("loading more…")
            )
          )
          .when(isMd && !this.previewError, el =>
            el.child(
              renderMarkdownToggleButton({
                id: "preview-markdown-toggle",
                active: Boolean(this.previewMarkdownRendered),
                compact: true,
                disabled: Boolean(this.previewLoading && this.previewLines.length === 0),
                height: 22,
                px: 7,
                rounded: 4,
                icon: "mods/files-search/icons/file-types/markdown.svg",
                t,
                onClick: (_e, cx) => this.togglePreviewMarkdown(item, cx),
              })
            )
          )
          .child(
            div()
              .px(7)
              .py(1.5)
              .rounded(4)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .text_size(11)
              .text_color(t.dim)
              .cursor_pointer()
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.selectResult(item, cx))
              .child("Open ↵")
          )
      )
      // Preview Body
      .child(
        v_flex()
          .relative()
          .flex_1()
          .min_h(0)
          .overflow_hidden()
          .when(showRenderedMd, el => el.child(this.renderPreviewMarkdown(t, item)))
          .when(!showRenderedMd && this.previewLoading && this.previewLines.length === 0, el =>
            el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child("Loading preview…"))
          )
          .when(!showRenderedMd && !this.previewLoading && Boolean(this.previewError) && this.previewLines.length === 0, el =>
            el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child(this.previewError))
          )
          .when(!showRenderedMd && this.previewLines.length > 0, el =>
            el
              .on_scroll_wheel((e, cx) => {
                if (!shouldAllowUnderlyingScroll({ hasDisambiguationPopover: Boolean(this.previewDisambig) })) return;
                const dx = Math.abs(e.delta?.x || 0);
                const dy = Math.abs(e.delta?.y || 0);
                if (dy > 0 && dy >= dx && !e.modifiers?.shift) {
                  const delta = e.delta.y > 0 ? -3 : 3;
                  const max = Math.max(0, this.previewLines.length - VISIBLE_ROWS);
                  this.previewScroll = Math.max(0, Math.min(this.previewScroll + delta, max));
                  if (this.previewHasMore && !this.previewLoadingMore) {
                    if (this.previewScroll + VISIBLE_ROWS >= this.previewLines.length - 15) {
                      this.loadNextPreviewChunk(cx);
                    }
                  }
                  cx.notify();
                }
              })
              .child(
                v_flex()
                  .id("files-preview-x")
                  .size_full()
                  .min_w(0)
                  .overflow_hidden()
                  .pt(4)
                  .pb(12)
                  .children(visibleLines)
              )
          )
          .when(!showRenderedMd && !this.previewLoading && !this.previewError && this.previewLines.length === 0, el =>
            el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child("Empty file"))
          )
          .when(Boolean(this.previewNavNotice), el =>
            el.child(
              div()
                .absolute()
                .bottom(10)
                .left(14)
                .right(14)
                .child(
                  renderNavToastBanner({
                    id: "preview-nav-toast",
                    t,
                    notice: this.previewNavNotice,
                    onDismiss: dismissCx => {
                      this.previewNavNotice = null;
                      dismissCx.notify();
                    },
                  })
                )
            )
          )
      );
  }

  renderOverlay(cx) {
    if (this._overlayClosed || !this.input) {
      return div();
    }
    const t = theme();
    const results = this.searchResults();
    this.at = Math.min(this.at, Math.max(0, results.length - 1));
    const currentItem = results[this.at];
    if (this.showPreview && currentItem) {
      const itemKey = `${currentItem.kind || "file"}:${currentItem.path}:${currentItem.line || 0}`;
      if (this._currentPreviewKey !== itemKey && this._pendingPreviewScheduleKey !== itemKey && cx?.timer) {
        this._pendingPreviewScheduleKey = itemKey;
        try { this._pendingPreviewScheduleTask?.cancel(); } catch {}
        this._pendingPreviewScheduleTask = cx.timer.after(0, nextCx => {
          this._pendingPreviewScheduleTask = null;
          if (this._overlayClosed) return;
          this._pendingPreviewScheduleKey = null;
          const nextResults = this.searchResults();
          const nextItem = nextResults[this.at];
          if (this.showPreview && nextItem) {
            this.schedulePreview(nextItem, nextCx, false);
            nextCx.notify();
          }
        });
      }
    }

    // Dynamic width & height calculation with minimum and maximum bounds
    const defaultW = this.showPreview ? 1050 : 680;
    const minW = this.showPreview ? 860 : 540;
    const minH = 220;
    const maxW = 1900;
    const maxH = 900;

    let winW = this.customWidth || defaultW;
    winW = Math.max(minW, Math.min(maxW, winW));

    let listH = this.customListHeight || LIST_H;
    listH = Math.max(minH, Math.min(maxH, listH));

    const availableContentW = winW - 36;
    let leftW = 644;
    let previewW = 520;
    if (this.showPreview) {
      const remainingW = Math.max(300, availableContentW - 12);
      const minLeft = Math.min(360, Math.floor(remainingW * 0.44));
      leftW = Math.max(minLeft, Math.min(620, Math.round(remainingW * 0.44)));
      previewW = Math.max(240, remainingW - leftW);
    } else {
      leftW = availableContentW;
    }

    const total = results.length * ROW_H;
    const fixed = total > listH;
    this.maxScroll = Math.max(0, total - listH);

    const selRow = this.at * ROW_H;
    if (selRow < this.scroll) this.scroll = selRow;
    if (selRow + ROW_H > this.scroll + listH) this.scroll = selRow + ROW_H - listH;
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));

    const place = (el, start, end) =>
      fixed
        ? el.absolute().left(0).right(0).top(start - this.scroll).bottom(listH - (end - this.scroll))
        : el.flex_none().h(end - start);

    const visible = (start, end) => !fixed || (end > this.scroll && start < this.scroll + listH);

    const cognivisorInfo = shared("cognivisor.services");
    const cognivisorServices = cognivisorInfo?.services || [];
    const hasMultipleServices = cognivisorServices.length > 1;

    const findServiceForPath = (filePath) => {
      if (!hasMultipleServices || !filePath) return null;
      let best = null;
      for (const s of cognivisorServices) {
        if (s.relPath && (filePath === s.relPath || filePath.startsWith(s.relPath + "/"))) {
          if (!best || s.relPath.length > best.relPath.length) {
            best = s;
          }
        }
      }
      return best;
    };

    const list = [];
    results.forEach((item, i) => {
      const rowStart = i * ROW_H;
      const rowEnd = rowStart + ROW_H;
      if (!visible(rowStart, rowEnd)) return;

      const on = i === this.at;
      const isText = item.kind === "text";
      const isDir = item.kind === "dir";
      const isFile = !isText && !isDir;
      const matchedService = findServiceForPath(item.path);
      const rowIcon = isDir ? null : resolveFileIcon(item.path, t);

      list.push(
        place(h_flex(), rowStart, rowEnd)
          .id(`search-row-${i}`)
          .mx(6)
          .px(10)
          .gap(9)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .text_size(12.5)
          .when(on, el => el.bg(t.selected))
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => {
            if (this.showPreview && i !== this.at) {
              this.at = i;
              this.updatePreview(item, cx, true);
              cx.notify();
            } else {
              this.selectResult(item, cx);
            }
          })
          .child(
            svg(isDir ? "mods/files-search/folder.svg" : rowIcon.path)
              .size(13)
              .flex_none()
              .text_color(isDir ? t.ansi4 : rowIcon.color)
          )
          .when(isFile || isDir, el =>
            el
              .child(
                h_flex()
                  .min_w(0)
                  .gap(5)
                  .items_center()
                  .when(Boolean(matchedService), badgeEl =>
                    badgeEl.child(
                      div()
                        .flex_none()
                        .px(4)
                        .py(0.5)
                        .rounded(3)
                        .bg(t.raised)
                        .border_1()
                        .border_color(t.border)
                        .text_size(9.5)
                        .font_medium()
                        .text_color(t.accent)
                        .child(matchedService.name)
                    )
                  )
                  .child(div().min_w(0).child(this.renderHighlightedTitle(t, isDir ? `${item.name}/` : item.name, item.hits, on)))
              )
              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(item.path.includes("/") ? item.path : (isDir ? "folder" : "")))
          )
          .when(isText, el =>
            el
              .child(
                h_flex()
                  .min_w(0)
                  .gap(5)
                  .items_center()
                  .when(Boolean(matchedService), badgeEl =>
                    badgeEl.child(
                      div()
                        .flex_none()
                        .px(4)
                        .py(0.5)
                        .rounded(3)
                        .bg(t.raised)
                        .border_1()
                        .border_color(t.border)
                        .text_size(9.5)
                        .font_medium()
                        .text_color(t.accent)
                        .child(matchedService.name)
                    )
                  )
                  .child(div().min_w(0).text_color(on ? t.foreground : t.muted).child(item.path.split("/").pop() || item.path))
              )
              .child(div().text_size(11).text_color(t.ansi3).child(`:${item.line}`))
              .child(div().flex_1().min_w(0).child(this.renderTextSnippet(t, item.content, item.matchedQuery, on)))
          )
      );
    });

    return div()
      .id("files-search-overlay-root")
      .relative()
      // Generous invisible tracking buffer that activates during dragging so fast swipes never escape
      .when(Boolean(this.resizing), el =>
        el.pr(400)
          .pb(400)
          .cursor_nwse_resize()
          .on_mouse_move((e, cx) => this.handleResizeMove(e, minW, maxW, minH, maxH, cx))
          .on_mouse_up("left", (_e, cx) => this.handleResizeEnd(cx))
      )
      .on_mouse_down_out((_e, cx) => {
        if (this.resizing) {
          this.handleResizeEnd(cx);
        }
        this.closeOverlay();
      })
      .child(
        v_flex()
          .id("files-search-overlay")
          .track_focus(this.handle)
          .relative()
          .w(winW)
          .min_h(0)
          .p(18)
          .gap(10)
          .rounded(10)
          .border_1()
          .border_color(t.border)
          .bg(t.popover)
          .shadow_lg()
          .on_mouse_up("left", (_e, cx) => this.handleResizeEnd(cx))
          .on_mouse_down("left", (e, _cx) => {
            if (e?.bounds) this._overlayContainerBounds = e.bounds;
            if (e?.local_position) this._overlayLastPointer = e.local_position;
          })
          .on_mouse_move((e, moveCx) => {
            if (e?.bounds) this._overlayContainerBounds = e.bounds;
            if (e?.local_position) this._overlayLastPointer = e.local_position;
            const nextCtrl = isNavModifierActive(e?.modifiers);
            if (nextCtrl !== this.previewCtrlHeld) {
              this.previewCtrlHeld = nextCtrl;
              moveCx.notify();
            }
          })
          .on_modifiers_changed((e, cx) => {
            const nextCtrl = isNavModifierActive(e?.modifiers);
            if (nextCtrl !== this.previewCtrlHeld) {
              this.previewCtrlHeld = nextCtrl;
              cx.notify();
            }
          })
          .on_key_down((e, cx) => {
        const k = e.key;
        if (this.previewDisambig) {
          const cands = this.previewDisambig.candidates || [];
          const count = cands.length;
          if (k === "escape") {
            this.previewDisambig = null;
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if ((k === "down" || k === "arrowdown") && count > 0) {
            const nextIdx = ((this.previewDisambig.selectedIndex || 0) + 1) % count;
            this.previewDisambig.selectedIndex = nextIdx;
            try { this.previewNavDropdownScroll?.scroll_to_item(nextIdx); } catch {}
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if ((k === "up" || k === "arrowup") && count > 0) {
            const nextIdx = ((this.previewDisambig.selectedIndex || 0) - 1 + count) % count;
            this.previewDisambig.selectedIndex = nextIdx;
            try { this.previewNavDropdownScroll?.scroll_to_item(nextIdx); } catch {}
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (k === "enter" && count > 0) {
            const picked = cands[this.previewDisambig.selectedIndex || 0] || cands[0];
            this.openPreviewDisambigCandidate(picked, this.previewDisambig.origin, cx);
            cx.stop_propagation();
            return;
          }
        }
        if (k === "escape") return this.closeOverlay();
        if (k === "tab") {
          this.cycleTab(e.shift ? -1 : 1, cx);
          cx.stop_propagation();
          return;
        }
        if (k === "down") {
          this.at = Math.min(this.at + 1, results.length - 1);
          if (this.showPreview && results[this.at]) this.updatePreview(results[this.at], cx, false);
        } else if (k === "up") {
          this.at = Math.max(this.at - 1, 0);
          if (this.showPreview && results[this.at]) this.updatePreview(results[this.at], cx, false);
        } else if (k === "pagedown") {
          this.at = Math.min(this.at + SHOWN, results.length - 1);
          if (this.showPreview && results[this.at]) this.updatePreview(results[this.at], cx, false);
        } else if (k === "pageup") {
          this.at = Math.max(this.at - SHOWN, 0);
          if (this.showPreview && results[this.at]) this.updatePreview(results[this.at], cx, false);
        } else if ((e.alt && k === "p") || (e.control && k === "p")) {
          this.showPreview = !this.showPreview;
          setShared("files-search.preview", this.showPreview);
          if (this.showPreview && results[this.at]) this.updatePreview(results[this.at], cx, true);
        } else if ((e.control || e.alt) && (k === "=" || k === "+")) {
          this.adjustWindowSize(120, 50, cx);
          cx.stop_propagation();
          return;
        } else if ((e.control || e.alt) && (k === "-" || k === "_")) {
          this.adjustWindowSize(-120, -50, cx);
          cx.stop_propagation();
          return;
        } else if ((e.control || e.alt) && k === "0") {
          this.customWidth = null;
          this.customListHeight = null;
          setShared("files-search.customSize", null);
          cx.stop_propagation();
          cx.notify();
          return;
        } else if (k === "enter") {
          if (results[this.at]) this.selectResult(results[this.at], cx);
        } else return;
        cx.stop_propagation();
        cx.notify();
      })
      // Header: IntelliJ style segmented tabs (All | Files | Text) & Draggable Title Bar
      .child(
        h_flex()
          .h(30)
          .flex_none()
          .gap(6)
          .items_center()
          .cursor_grab()
          .child(
            h_flex()
              .gap(2)
              .p(2)
              .rounded(6)
              .bg(t.raised)
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(
                div()
                  .px(9)
                  .py(2)
                  .rounded(4)
                  .cursor_pointer()
                  .text_size(11.5)
                  .font_medium()
                  .when(this.tab === "all", el => el.bg(t.background).text_color(t.foreground))
                  .when(this.tab !== "all", el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
                  .on_click((_e, cx) => this.setTab("all", cx))
                  .child("All")
              )
              .child(
                div()
                  .px(9)
                  .py(2)
                  .rounded(4)
                  .cursor_pointer()
                  .text_size(11.5)
                  .font_medium()
                  .when(this.tab === "files", el => el.bg(t.background).text_color(t.foreground))
                  .when(this.tab !== "files", el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
                  .on_click((_e, cx) => this.setTab("files", cx))
                  .child("Files")
              )
              .child(
                div()
                  .px(9)
                  .py(2)
                  .rounded(4)
                  .cursor_pointer()
                  .text_size(11.5)
                  .font_medium()
                  .when(this.tab === "text", el => el.bg(t.background).text_color(t.foreground))
                  .when(this.tab !== "text", el => el.text_color(t.muted).hover(s => s.text_color(t.foreground)))
                  .on_click((_e, cx) => this.setTab("text", cx))
                  .child("Text")
              )
          )
          .child(div().flex_1())
          .when(this.isSearchingFiles || this.isSearchingText || this.isIndexingFiles, el =>
            el.child(
              div()
                .text_size(11)
                .text_color(t.dim)
                .child(this.isSearchingText ? "Searching text…" : this.isSearchingFiles ? "Searching files…" : "Indexing…")
            )
          )
          // Preview Toggle Button
          .child(
            h_flex()
              .id("files-search-preview-toggle")
              .gap(5)
              .items_center()
              .px(8)
              .h(24)
              .rounded(5)
              .cursor_pointer()
              .border_1()
              .border_color(this.showPreview ? t.accent : t.border)
              .bg(this.showPreview ? t.selected : t.raised)
              .text_color(this.showPreview ? t.foreground : t.muted)
              .hover(s => s.text_color(t.foreground))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => {
                this.showPreview = !this.showPreview;
                setShared("files-search.preview", this.showPreview);
                if (this.showPreview && results[this.at]) {
                  this.updatePreview(results[this.at], cx, true);
                }
                cx.notify();
              })
              .child(svg("mods/files-search/preview.svg").size(12))
              .child(div().text_size(11).font_medium().child("Preview"))
          )
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(div().text_size(11).text_color(t.dim).child("Tab to switch"))
              .child(
                div()
                  .px(5)
                  .rounded(4)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_size(11)
                  .text_color(t.dim)
                  .child("⇥")
              )
          )
      )
      // Content body: left column (Input + Results) and right column (Preview pane when enabled)
      .child(
        h_flex()
          .gap(12)
          .items_start()
          // Left column
          .child(
            v_flex()
              .w(leftW)
              .flex_none()
              .gap(10)
              .child(
                // Search Input
                h_flex()
                  .h(36)
                  .flex_none()
                  .px(10)
                  .gap(10)
                  .items_center()
                  .rounded(9)
                  .border_1()
                  .border_color(t.accent)
                  .bg(t.background)
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(svg("mods/files-search/search.svg").size(15).text_color(t.dim))
                  .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
                  .child(
                    div()
                      .px(5)
                      .rounded(4)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.raised)
                      .text_size(11)
                      .text_color(t.dim)
                      .cursor_pointer()
                      .hover(s => s.text_color(t.foreground))
                      .on_click(() => this.closeOverlay())
                      .child("Esc")
                  )
              )
              .child(
                results.length
                  ? div()
                      .id("search-rows")
                      .relative()
                      .mb(4)
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .when(fixed, el => el.h(listH).overflow_hidden())
                      .on_scroll_wheel((e, cx) => {
                        if (!shouldAllowUnderlyingScroll({ hasDisambiguationPopover: Boolean(this.previewDisambig) })) return;
                        this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, this.maxScroll));
                        while (this.at < results.length - 1 && this.at * ROW_H < this.scroll) this.at++;
                        while (this.at > 0 && (this.at + 1) * ROW_H > this.scroll + listH) this.at--;
                        if (this.showPreview && results[this.at]) this.updatePreview(results[this.at], cx, false);
                        cx.notify();
                      })
                      .children(fixed ? list : [v_flex().children(list)])
                  : div()
                      .px(16)
                      .py(16)
                      .text_size(12.5)
                      .text_color(t.dim)
                      .child(
                        this.query.trim()
                          ? (this.isSearchingFiles || (this.tab !== "files" && this.isSearchingText)
                              ? `Searching for "${this.query}"…`
                              : this.isIndexingFiles && !this.fileEntries.length
                                ? "Indexing workspace files & folders…"
                                : `No matches found for "${this.query}".`)
                          : (this.isIndexingFiles
                              ? "Indexing workspace files & folders…"
                              : "Type to search files, folders, or text…")
                      )
              )
          )
          // Right column: Preview pane
          .when(this.showPreview, el =>
            el.child(this.renderPreviewPane(t, results[this.at], cx, listH, previewW))
          )
      )
      // Bottom-right discrete size bar with [-] [+] [ ▢ ] and Grip handle
      .child(
        h_flex()
          .id("files-search-size-bar")
          .absolute()
          .right(8)
          .bottom(6)
          .h(22)
          .px(4)
          .gap(3)
          .items_center()
          .rounded(5)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          // Shrink [-]
          .child(
            div()
              .id("btn-resize-minus")
              .size(16)
              .rounded(3)
              .cursor_pointer()
              .flex()
              .items_center()
              .justify_center()
              .text_color(t.dim)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.adjustWindowSize(-120, -50, cx))
              .child(svg("mods/files-search/minus.svg").size(9))
          )
          // Enlarge [+]
          .child(
            div()
              .id("btn-resize-plus")
              .size(16)
              .rounded(3)
              .cursor_pointer()
              .flex()
              .items_center()
              .justify_center()
              .text_color(t.dim)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.adjustWindowSize(120, 50, cx))
              .child(svg("mods/files-search/plus.svg").size(9))
          )
          // Maximize / Restore [ ▢ ]
          .child(
            div()
              .id("btn-resize-max")
              .size(16)
              .rounded(3)
              .cursor_pointer()
              .flex()
              .items_center()
              .justify_center()
              .text_color(t.dim)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                const isExpanded = Boolean(this.customWidth && this.customWidth >= 1350);
                if (isExpanded) {
                  this.customWidth = this.showPreview ? 1050 : 680;
                  this.customListHeight = LIST_H;
                } else {
                  this.customWidth = this.showPreview ? 1420 : 920;
                  this.customListHeight = 520;
                }
                setShared("files-search.customSize", { w: this.customWidth, h: this.customListHeight });
                cx.notify();
              })
              .child(svg(this.customWidth && this.customWidth >= 1350 ? "mods/files-search/restore.svg" : "mods/files-search/maximize.svg").size(10))
          )
          // Subtle separator
          .child(div().w(1).h(12).bg(t.border))
          // Corner Grip Handle
          .child(
            div()
              .id("resize-corner-grip")
              .size(18)
              .rounded(3)
              .cursor_nwse_resize()
              .flex()
              .items_center()
              .justify_center()
              .text_color(this.resizing ? t.accent : t.dim)
              .hover(s => s.text_color(t.foreground))
              .on_mouse_down("left", (e, cx) => this.startResize(e, defaultW, cx))
              .child(svg("mods/files-search/grip.svg").size(10))
          )
      )
      .when(Boolean(this.previewDisambig), el =>
        el.child(
          renderNavDisambiguationPopover({
            overlayId: "preview-nav-disambig-overlay",
            menuId: "preview-nav-disambig-menu",
            t,
            monoFont: settings()?.font_family || "monospace",
            disambig: this.previewDisambig,
            currentRoot: this.previewDisambig?.root || this.searchRoot || "",
            currentServiceName: this.previewDisambig?.serviceName || "",
            scrollHandle: this.previewNavDropdownScroll,
            anchorRect: this.previewDisambig?.anchorRect || null,
            containerWidth: Number(this._overlayContainerBounds?.width) || winW,
            containerHeight: Number(this._overlayContainerBounds?.height) || (listH + 148),
            minWidth: 300,
            maxWidth: 460,
            maxHeight: Math.max(200, listH - 20),
            marginX: 14,
            marginTop: 14,
            marginBottom: 14,
            onSelectCandidate: (cand, pickCx) =>
              this.openPreviewDisambigCandidate(cand, this.previewDisambig?.origin, pickCx),
            onClose: closeCx => {
              this.previewDisambig = null;
              closeCx.notify();
            },
          })
        )
      )
      // When actively resizing, cover the entire card so moving fast over preview/input/rows
      // never loses the nwse-resize cursor, never triggers child hover states, and never breaks dragging
      .when(Boolean(this.resizing), el =>
        el.child(
          div()
            .id("resize-card-cover")
            .absolute()
            .top(0)
            .left(0)
            .size_full()
            .cursor_nwse_resize()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_mouse_move((e, cx) => this.handleResizeMove(e, minW, maxW, minH, maxH, cx))
            .on_mouse_up("left", (_e, cx) => this.handleResizeEnd(cx))
        )
      )
    );
  }

}
