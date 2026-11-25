// Interactive #main File Viewer tab controller (role: "viewer").
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, ScrollHandle } from "gpui-base";
import * as fsPromises from "fs/promises";
import {
  spaces, panes, focused, readTextFile,
  theme, settings, window, props,
  shared, setShared, run,
} from "herdr";
import {
  normPathStr,
  isSameOrChildPath,
} from "./indexer.js";
import {
  resolveEditorLanguage,
  getEditorSyntaxConfig,
  resolveFileIcon,
  resolveViewerFilePath,
  formatFileTabTitle,
  pruneOpenFileTabs,
  resolveViewerMarkdownToggleOnLoad,
  selectViewerRawText,
  buildViewerMarkdownCacheKey,
  buildViewerMarkdownViewIds,
  resolveRelativeMarkdownTarget,
  buildWrappedViewerDocument,
  computeWindowedViewerSlice,
  computeTargetCenterScrollRow,
  isNavModifierActive,
  buildViewerNavigationNotice,
  shouldOpenNavInNewTab,
  computeLocalAnchorRect,
  shouldAllowUnderlyingScroll,
} from "./search-logic.js";
import {
  createNavHistoryState,
  pushNavHistory,
  canStepNavBack,
  canStepNavForward,
  stepNavBack,
  stepNavForward,
} from "./code-nav-logic.js";
import {
  getNavLanguageAnalyzer,
  resolveCrossFileNavigation,
  warmAllServiceSymbolIndices,
  peekCachedSourceText,
  isServiceIndexWarmed,
  warmFileImports,
} from "./symbol-index.js";
import {
  CODE_VIEWER_LINE_HEIGHT,
  renderInteractiveTokenSegments,
  renderViewerNavToolbar,
  renderCodeViewerBody,
  renderNavToastBanner,
  renderNavDisambiguationPopover,
  computeCodeGutterWidth,
} from "./code-viewer.js";
import { isMarkdownFile } from "./markdown-view-logic.js";
import {
  createMarkdownRenderCache,
  renderMarkdownToggleButton,
  renderMarkdownViewer,
} from "./markdown-view.js";
import { computeWrapColumns } from "./code-wrap.js";
import {
  asPlainObject,
  ACTIVE_VIEWER_CLAIMS,
  PENDING_VIEWER_OPENS,
  nextViewerId,
  countTextLinesFast,
  extractLineAtFast,
  syncSpaceAgentTabs,
  resolveServiceForFile,
  collectRegisteredServices,
  collectIndexedFilesByRoot,
  hasMatchingOpenTabInSpace,
  openFileInTab,
  getSafeAppHome,
} from "./workspace-io.js";

export class ViewerController {
  constructor(cx) {
    this.initViewer(cx);
  }

  render(cx) {
    return this.renderViewer(cx);
  }

  clearError() {
    this.viewerError = null;
  }

  close() {
    this.closeViewer();
  }

  initViewer(cx) {
    const p = asPlainObject(props());
    this._viewerClosed = false;
    this.viewerId = typeof p.viewerId === "string" && p.viewerId
      ? p.viewerId
      : nextViewerId("fv-inst");
    this.viewerSpaceId = typeof p.spaceId === "string" && p.spaceId ? p.spaceId : null;
    this.viewerRoot = normPathStr(p.root || "");
    this.viewerPath = normPathStr(p.path || "");
    this.viewerAbsPath = normPathStr(p.absPath || "");
    this.viewerTargetPath = resolveViewerFilePath(this.viewerRoot, this.viewerAbsPath || this.viewerPath);
    this.viewerDisplayPath = normPathStr(p.displayPath || "") || this.viewerPath || this.viewerTargetPath;
    this.viewerOn = p.on ?? null;
    this.viewerLine = p.line ? Number(p.line) : null;
    this.viewerColumn = p.column ? Number(p.column) : null;
    this.viewerHighlightSymbol = typeof p.highlightSymbol === "string" && p.highlightSymbol ? p.highlightSymbol : null;
    this.viewerServiceId = p.serviceId || null;
    this.viewerServiceName = p.serviceName || null;
    this.viewerTabTitle = typeof p.tabTitle === "string" && p.tabTitle
      ? p.tabTitle
      : formatFileTabTitle(this.viewerTargetPath || this.viewerPath || "", this.viewerServiceName);

    this.viewerCode = null;
    this.viewerSyntaxSig = null;
    this.viewerSelectTextMode = false;
    this.viewerCtrlHeld = false;
    this.viewerHoveredTokenKey = null;
    this.viewerViewportWidth = 0;
    this.viewerViewportHeight = 0;
    this.viewerApproxLineCount = 0;
    this.viewerGutterWidth = null;
    this.viewerMaxCols = null;
    this.viewerDoc = null;
    this.viewerDocKey = null;
    this._viewerTokenizedDoc = null;
    this._pendingViewerSize = null;
    this.viewerNavHistory = createNavHistoryState(50);
    if (p.navOrigin && p.navOrigin.path && this.viewerTargetPath) {
      this.viewerNavHistory = pushNavHistory(this.viewerNavHistory, p.navOrigin, {
        root: this.viewerRoot,
        path: this.viewerTargetPath,
        on: this.viewerOn ?? null,
        serviceId: this.viewerServiceId || null,
        serviceName: this.viewerServiceName || null,
        line: this.viewerLine || 1,
        column: this.viewerColumn || 1,
        symbol: this.viewerHighlightSymbol || "",
      });
    }
    this.viewerNavDisambig = null;
    this.viewerNavNotice = null;
    this.viewerCopiedFile = false;
    this.viewerCopiedLineNum = null;
    this.viewerResizeTask = null;
    this.viewerCopyTask = null;
    this.viewerNoticeTask = null;
    this.viewerFocusHandle = cx.focus_handle();
    this.viewerNavDropdownScroll = ScrollHandle.new();
    this.viewerScrollTop = 0;
    this.viewerPendingScrollLine = this.viewerLine || null;

    this.viewerRawText = null;
    this.viewerMarkdownRendered = false;
    this.viewerMarkdownCache = createMarkdownRenderCache(12);
    this.viewerLoadedTargetPath = null;
    this.viewerContentSeq = 0;
    this.viewerNavSeq = 0;
    this.viewerLoading = Boolean(this.viewerTargetPath);
    this.viewerError = this.viewerTargetPath ? null : "No file path specified";
    this.viewerTabId = null;
    this.viewerSyncTask = null;
    this.viewerClaimRetries = 0;
    this.viewerLoadSeq = 0;
    this.viewerSeenActiveState = false;
    this.viewerWasActive = false;
    this.viewerHasLoadedOnce = false;
    this.viewerLastSyncedUpdatedAt = 0;
    this.viewerLastSyncedNavSeq = 0;
    this.viewerLastWarmedSig = null;

    this.scheduleViewerSync(cx, 0);
    if (this.viewerTargetPath) {
      const prefetched = peekCachedSourceText(this.viewerTargetPath, this.viewerOn ?? null);
      if (typeof prefetched === "string" && !prefetched.includes("\0")) {
        this.viewerLoading = false;
        this.viewerHasLoadedOnce = true;
        this.applyViewerText(this.viewerTargetPath, prefetched, ++this.viewerLoadSeq, { cx });
        this.loadViewerFile(cx, { silent: true });
      } else {
        this.loadViewerFile(cx);
      }
    }
  }

  scheduleViewerSync(cx, delayMs = 0) {
    if (this._viewerClosed || this.viewerSyncTask || !cx?.timer) return;
    this.viewerSyncTask = cx.timer.after(delayMs, cx => {
      this.viewerSyncTask = null;
      this.syncViewerFromRender(cx);
    });
  }

  syncViewerFromRender(cx) {
    if (this._viewerClosed) return;
    syncSpaceAgentTabs();

    const allSpaces = spaces() || [];
    const allPanes = panes() || [];
    const allLiveTabIds = new Set();
    for (const s of allSpaces) {
      for (const t of s.tabs || []) {
        if (t?.id) allLiveTabIds.add(t.id);
      }
    }
    const filePaneTabIds = new Set(
      allPanes.filter(p => p?.mod === "files-search" && p?.tab).map(p => p.tab)
    );

    const rawOpenTabs = asPlainObject(shared("cognivisor.openFileTabs"));
    const { tabs: nextTabs, changed: prunedChanged } = pruneOpenFileTabs(rawOpenTabs, allLiveTabIds, filePaneTabIds);
    let sharedChanged = prunedChanged;
    let dirty = false;

    if (this.viewerTabId && (!allLiveTabIds.has(this.viewerTabId) || !filePaneTabIds.has(this.viewerTabId))) {
      if (ACTIVE_VIEWER_CLAIMS.get(this.viewerTabId) === this.viewerId) {
        ACTIVE_VIEWER_CLAIMS.delete(this.viewerTabId);
      }
      this.viewerTabId = null;
    }

    if (!this.viewerTabId) {
      const byViewerId = Object.values(nextTabs).find(
        e => e?.viewerId === this.viewerId && allLiveTabIds.has(e.tabId) && filePaneTabIds.has(e.tabId)
      );
      if (byViewerId?.tabId) {
        this.viewerTabId = byViewerId.tabId;
      } else {
        const preferredSpace = this.viewerSpaceId ? allSpaces.find(s => s.id === this.viewerSpaceId) : null;
        const activeSpace = allSpaces.find(s => s.active) || null;
        const searchOrder = [];
        if (preferredSpace) searchOrder.push(preferredSpace);
        if (activeSpace && activeSpace !== preferredSpace) searchOrder.push(activeSpace);
        for (const s of allSpaces) {
          if (s !== preferredSpace && s !== activeSpace) searchOrder.push(s);
        }

        const fTabId = focused()?.tab || null;
        for (const s of searchOrder) {
          const candidates = (s?.tabs || []).filter(t => {
            if (!t?.id || !filePaneTabIds.has(t.id)) return false;
            const claimedEntry = nextTabs[t.id];
            if (claimedEntry?.viewerId && claimedEntry.viewerId !== this.viewerId) return false;
            const memClaim = ACTIVE_VIEWER_CLAIMS.get(t.id);
            if (memClaim && memClaim !== this.viewerId) return false;
            return true;
          });
          if (!candidates.length) continue;
          const expectedTitle = this.viewerTabTitle || "";
          const picked = (expectedTitle ? candidates.find(t => t.name === expectedTitle && t.active) : null)
            || (expectedTitle ? candidates.find(t => t.name === expectedTitle) : null)
            || candidates.find(t => t.active && candidates.length === 1)
            || candidates[0];
          if (picked?.id) {
            this.viewerTabId = picked.id;
            break;
          }
        }
      }
    }

    if (!this.viewerTabId) {
      if (sharedChanged) setShared("cognivisor.openFileTabs", nextTabs);
      if (this.viewerClaimRetries < 12) {
        this.viewerClaimRetries++;
        this.scheduleViewerSync(cx, 35);
      }
      return;
    }

    this.viewerClaimRetries = 0;
    ACTIVE_VIEWER_CLAIMS.set(this.viewerTabId, this.viewerId);
    for (const [k, pending] of PENDING_VIEWER_OPENS) {
      if (pending?.viewerId === this.viewerId) {
        PENDING_VIEWER_OPENS.delete(k);
      }
    }

    const ownerSpace = allSpaces.find(s => (s.tabs || []).some(t => t.id === this.viewerTabId)) || null;
    const ownerSpaceId = ownerSpace?.id || this.viewerSpaceId || null;
    if (ownerSpaceId && !this.viewerSpaceId) {
      this.viewerSpaceId = ownerSpaceId;
    }

    const existingEntry = nextTabs[this.viewerTabId];
    if (existingEntry && existingEntry.viewerId === this.viewerId) {
      const entryNavSeq = Number(existingEntry.navSeq) || 0;
      const hasNewNavUpdate = entryNavSeq > (this.viewerLastSyncedNavSeq || 0)
        || (existingEntry.updatedAt && existingEntry.updatedAt > this.viewerLastSyncedUpdatedAt);
      if (hasNewNavUpdate) {
        if (existingEntry.updatedAt && existingEntry.updatedAt > this.viewerLastSyncedUpdatedAt) {
          this.viewerLastSyncedUpdatedAt = existingEntry.updatedAt;
        }
        if (entryNavSeq > (this.viewerLastSyncedNavSeq || 0)) {
          this.viewerLastSyncedNavSeq = entryNavSeq;
        }
        const nextLine = existingEntry.line ? Number(existingEntry.line) : null;
        const nextCol = existingEntry.column ? Number(existingEntry.column) : null;
        const nextSym = typeof existingEntry.highlightSymbol === "string" && existingEntry.highlightSymbol
          ? existingEntry.highlightSymbol
          : null;
        if (existingEntry.navOrigin && existingEntry.navOrigin.path && this.viewerTargetPath) {
          this.viewerNavHistory = pushNavHistory(this.viewerNavHistory, existingEntry.navOrigin, {
            root: this.viewerRoot,
            path: this.viewerTargetPath,
            on: this.viewerOn ?? null,
            serviceId: this.viewerServiceId || null,
            serviceName: this.viewerServiceName || null,
            line: nextLine || 1,
            column: nextCol || 1,
            symbol: nextSym || "",
          });
        }
        if (nextLine !== (this.viewerLine || null)) {
          this.viewerLine = nextLine;
          dirty = true;
        }
        if (nextCol !== (this.viewerColumn || null)) {
          this.viewerColumn = nextCol;
          dirty = true;
        }
        if (nextSym !== (this.viewerHighlightSymbol || null)) {
          this.viewerHighlightSymbol = nextSym;
          dirty = true;
        }
        if (nextLine) {
          if (this.viewerSelectTextMode) {
            this.viewerSelectTextMode = false;
            try { this.viewerCode?.release(); } catch {}
            this.viewerCode = null;
            this.viewerSyntaxSig = null;
          }
          this.viewerPendingScrollLine = nextLine;
          this.scrollViewerToLine(nextLine);
          dirty = true;
        }
      } else {
        if (!this.viewerLastSyncedUpdatedAt) {
          this.viewerLastSyncedUpdatedAt = existingEntry.updatedAt || Date.now();
        }
        if (entryNavSeq > (this.viewerLastSyncedNavSeq || 0)) {
          this.viewerLastSyncedNavSeq = entryNavSeq;
        }
      }
    }

    const t = theme();
    const resolvedIcon = resolveFileIcon(this.viewerTargetPath || this.viewerPath, t);
    const iconPath = resolvedIcon.path;
    const iconColor = resolvedIcon.color;
    const updatedAt = this.viewerLastSyncedUpdatedAt || existingEntry?.updatedAt || Date.now();
    if (!this.viewerLastSyncedUpdatedAt) this.viewerLastSyncedUpdatedAt = updatedAt;

    const desiredEntry = {
      tabId: this.viewerTabId,
      spaceId: ownerSpaceId,
      viewerId: this.viewerId,
      root: this.viewerRoot,
      path: this.viewerPath,
      absPath: this.viewerTargetPath,
      displayPath: this.viewerDisplayPath,
      iconPath,
      iconColor,
      line: this.viewerLine || null,
      column: this.viewerColumn || null,
      highlightSymbol: this.viewerHighlightSymbol || null,
      navSeq: this.viewerLastSyncedNavSeq || existingEntry?.navSeq || 0,
      serviceId: this.viewerServiceId || null,
      serviceName: this.viewerServiceName || null,
      updatedAt,
    };

    const needsRegister = !existingEntry ||
      existingEntry.tabId !== desiredEntry.tabId ||
      existingEntry.spaceId !== desiredEntry.spaceId ||
      existingEntry.viewerId !== desiredEntry.viewerId ||
      existingEntry.absPath !== desiredEntry.absPath ||
      existingEntry.iconPath !== desiredEntry.iconPath ||
      existingEntry.iconColor !== desiredEntry.iconColor ||
      (existingEntry.line || null) !== desiredEntry.line ||
      (existingEntry.column || null) !== desiredEntry.column ||
      (existingEntry.highlightSymbol || null) !== desiredEntry.highlightSymbol ||
      (existingEntry.navSeq || 0) !== (desiredEntry.navSeq || 0) ||
      (existingEntry.serviceId || null) !== desiredEntry.serviceId ||
      (existingEntry.serviceName || null) !== desiredEntry.serviceName ||
      Boolean(existingEntry.navOrigin);

    if (needsRegister) {
      nextTabs[this.viewerTabId] = desiredEntry;
      sharedChanged = true;
    }
    if (sharedChanged) {
      setShared("cognivisor.openFileTabs", nextTabs);
    }

    const syntaxCfg = getEditorSyntaxConfig(t);
    const fontFamily = settings()?.font_family || "";
    const nextSyntaxSig = `${JSON.stringify(syntaxCfg)}|${fontFamily}`;
    if (this.viewerSelectTextMode && this.viewerCode && this.viewerSyntaxSig && this.viewerSyntaxSig !== nextSyntaxSig && !this.viewerLoading && this.viewerTargetPath) {
      const currentValue = this.viewerCode.value();
      this.viewerCode.release();
      this.viewerCode = EditorState.new({
        language: resolveEditorLanguage(this.viewerTargetPath),
        readonly: true,
        soft_wrap: true,
        line_numbers: true,
        folding: true,
        value: currentValue,
        font_family: settings()?.font_family,
        font_size: 12.5,
        syntax: syntaxCfg,
      });
      this.viewerSyntaxSig = nextSyntaxSig;
      dirty = true;
    }

    const isActiveNow = Boolean(ownerSpace?.active && (ownerSpace.tabs || []).some(tab => tab.id === this.viewerTabId && tab.active));
    if (!this.viewerSeenActiveState) {
      this.viewerSeenActiveState = true;
      this.viewerWasActive = isActiveNow;
      if (isActiveNow && !this.viewerSelectTextMode && this.viewerFocusHandle) {
        try { cx.focus(this.viewerFocusHandle); } catch {}
      }
    } else if (isActiveNow !== this.viewerWasActive) {
      this.viewerWasActive = isActiveNow;
      dirty = true;
      if (!isActiveNow) {
        this.viewerCtrlHeld = false;
        this.viewerHoveredTokenKey = null;
      }
      if (isActiveNow && !this.viewerSelectTextMode && this.viewerFocusHandle) {
        try { cx.focus(this.viewerFocusHandle); } catch {}
      }
      if (isActiveNow && this.viewerHasLoadedOnce && this.viewerTargetPath) {
        this.loadViewerFile(cx, { silent: true });
      }
    }

    if (dirty) cx.notify();
  }

  getOrBuildViewerDoc() {
    if (this.viewerError || typeof this.viewerRawText !== "string") return null;
    const targetPath = this.viewerTargetPath || "";
    const vpWidth = this.viewerViewportWidth || 760;
    const totalLinesApprox = this.viewerApproxLineCount || 1;
    let maxCols = this.viewerMaxCols;
    if (
      !maxCols ||
      this._viewerColsWidth !== vpWidth ||
      this._viewerColsLines !== totalLinesApprox
    ) {
      const gutterW = computeCodeGutterWidth(totalLinesApprox);
      maxCols = computeWrapColumns({
        viewportWidth: vpWidth,
        gutterWidth: gutterW,
        rightPadding: 28,
        fontSize: 11.5,
        minCols: 28,
        fallbackCols: 88,
      });
      this.viewerGutterWidth = gutterW;
      this.viewerMaxCols = maxCols;
      this._viewerColsWidth = vpWidth;
      this._viewerColsLines = totalLinesApprox;
    }
    const docKey = `${this.viewerContentSeq}::${targetPath}::${maxCols}`;
    if (this.viewerDocKey !== docKey || !this.viewerDoc) {
      const tokCache =
        this._viewerTokenizedDoc &&
        this._viewerTokenizedDoc.contentSeq === this.viewerContentSeq &&
        this._viewerTokenizedDoc.path === targetPath
          ? this._viewerTokenizedDoc
          : null;
      const doc = buildWrappedViewerDocument(
        this.viewerRawText,
        targetPath,
        maxCols,
        tokCache
          ? { tokenizedLines: tokCache.tokenizedLines, truncated: tokCache.truncated }
          : undefined
      );
      if (doc && Array.isArray(doc.tokenizedLines)) {
        this._viewerTokenizedDoc = {
          contentSeq: this.viewerContentSeq,
          path: targetPath,
          tokenizedLines: doc.tokenizedLines,
          truncated: Boolean(doc.truncated),
        };
      }
      this.viewerDoc = doc;
      this.viewerDocKey = docKey;
    }
    return this.viewerDoc;
  }

  scrollViewerToLine(line, doc = null) {
    if (this._viewerClosed || !line) return;
    const targetDoc = doc || this.getOrBuildViewerDoc();
    if (!targetDoc || !Array.isArray(targetDoc.rows) || targetDoc.rows.length === 0) return;
    const targetLineNum = Math.max(1, Math.min(targetDoc.totalLines || 1, Math.floor(Number(line) || 1)));
    const hasViewportSize = (this.viewerViewportWidth || 0) > 0 && (this.viewerViewportHeight || 0) > 0;
    const vpH = Math.max(120, Number(this.viewerViewportHeight) || 560);
    this.viewerScrollTop = computeTargetCenterScrollRow(targetDoc, targetLineNum, vpH - 8, CODE_VIEWER_LINE_HEIGHT);
    if (hasViewportSize) {
      this.viewerPendingScrollLine = null;
    }
  }

  scrollViewerBy(deltaRows, cx = null) {
    if (!shouldAllowUnderlyingScroll({
      closed: this._viewerClosed,
      selectTextMode: this.viewerSelectTextMode,
      hasDisambiguationPopover: Boolean(this.viewerNavDisambig),
    })) return;
    const doc = this.getOrBuildViewerDoc();
    if (!doc || !Array.isArray(doc.rows) || doc.rows.length === 0) {
      if (this.viewerScrollTop !== 0) {
        this.viewerScrollTop = 0;
        cx?.notify?.();
      }
      return;
    }
    this.viewerPendingScrollLine = null;
    const vpH = Math.max(120, Number(this.viewerViewportHeight) || 560);
    const slice = computeWindowedViewerSlice(
      doc.rows.length,
      (this.viewerScrollTop || 0) + Math.trunc(Number(deltaRows) || 0),
      vpH - 8,
      CODE_VIEWER_LINE_HEIGHT,
    );
    if (slice.scrollTop !== this.viewerScrollTop) {
      this.viewerScrollTop = slice.scrollTop;
      cx?.notify?.();
    }
  }

  scrollViewerToBoundary(end = false, cx = null) {
    if (!shouldAllowUnderlyingScroll({
      closed: this._viewerClosed,
      selectTextMode: this.viewerSelectTextMode,
      hasDisambiguationPopover: Boolean(this.viewerNavDisambig),
    })) return;
    this.viewerPendingScrollLine = null;
    if (!end) {
      if (this.viewerScrollTop !== 0) {
        this.viewerScrollTop = 0;
        cx?.notify?.();
      }
      return;
    }
    const doc = this.getOrBuildViewerDoc();
    const vpH = Math.max(120, Number(this.viewerViewportHeight) || 560);
    const slice = computeWindowedViewerSlice(doc?.rows?.length || 0, 0, vpH - 8, CODE_VIEWER_LINE_HEIGHT);
    if (this.viewerScrollTop !== slice.maxScrollTop) {
      this.viewerScrollTop = slice.maxScrollTop;
      cx?.notify?.();
    }
  }

  scheduleViewerResizeReflow(width, height, cx) {
    const w = Math.floor(Number(width) || 0);
    const h = Math.floor(Number(height) || 0);
    if (w <= 0) return;
    if (Math.abs(w - (this.viewerViewportWidth || 0)) <= 4 && Math.abs(h - (this.viewerViewportHeight || 0)) <= 4) {
      return;
    }
    this._pendingViewerSize = { w, h };
    if (this.viewerResizeTask || !cx?.timer) return;
    this.viewerResizeTask = cx.timer.after(16, timerCx => {
      this.viewerResizeTask = null;
      if (this._viewerClosed) return;
      const next = this._pendingViewerSize;
      this._pendingViewerSize = null;
      if (!next) return;
      const widthChanged = Math.abs(next.w - (this.viewerViewportWidth || 0)) > 4;
      this.viewerViewportWidth = next.w;
      this.viewerViewportHeight = next.h;
      if (widthChanged) {
        this.viewerDoc = null;
        this.viewerDocKey = null;
      }
      const doc = this.getOrBuildViewerDoc();
      if (doc && Array.isArray(doc.rows) && doc.rows.length > 0) {
        if (this.viewerPendingScrollLine) {
          this.scrollViewerToLine(this.viewerPendingScrollLine, doc);
        } else {
          const vpH = Math.max(120, next.h || 560);
          this.viewerScrollTop = computeWindowedViewerSlice(
            doc.rows.length,
            this.viewerScrollTop || 0,
            vpH - 8,
            CODE_VIEWER_LINE_HEIGHT,
          ).scrollTop;
        }
      } else {
        this.viewerScrollTop = 0;
      }
      timerCx.notify();
    });
  }

  ensureViewerEditorState(targetPath, text, { forceRecreate = false } = {}) {
    const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
    const t = theme();
    const syntaxCfg = getEditorSyntaxConfig(t);
    const fontFamily = settings()?.font_family;
    const syntaxSig = `${JSON.stringify(syntaxCfg)}|${fontFamily || ""}`;

    if (!forceRecreate && this.viewerCode && this.viewerSyntaxSig === syntaxSig) {
      if (this.viewerCode.value() !== value) {
        this.viewerCode.set_value(value);
      }
    } else {
      this.viewerCode?.release();
      this.viewerCode = EditorState.new({
        language: resolveEditorLanguage(targetPath),
        readonly: true,
        soft_wrap: true,
        line_numbers: true,
        folding: true,
        value,
        font_family: fontFamily,
        font_size: 12.5,
        syntax: syntaxCfg,
      });
      this.viewerSyntaxSig = syntaxSig;
    }
  }

  toggleViewerSelectText(cx) {
    if (this._viewerClosed) return;
    this.viewerSelectTextMode = !this.viewerSelectTextMode;
    if (this.viewerSelectTextMode) {
      if (typeof this.viewerRawText === "string" && !this.viewerError && this.viewerTargetPath) {
        this.ensureViewerEditorState(this.viewerTargetPath, this.viewerRawText, { forceRecreate: true });
      }
    } else {
      try { this.viewerCode?.release(); } catch {}
      this.viewerCode = null;
      this.viewerSyntaxSig = null;
      if (this.viewerFocusHandle) {
        try { cx.focus(this.viewerFocusHandle); } catch {}
      }
      if (this.viewerLine) {
        this.viewerPendingScrollLine = this.viewerLine;
        this.scrollViewerToLine(this.viewerLine);
      }
    }
    cx.notify();
  }

  copyViewerText(text, lineNum, cx) {
    if (this._viewerClosed || typeof text !== "string") return;
    try { cx.write_to_clipboard(text); } catch {}
    try { this.viewerCopyTask?.cancel(); } catch {}
    this.viewerCopyTask = null;
    if (lineNum != null) {
      this.viewerCopiedLineNum = lineNum;
      this.viewerCopiedFile = false;
    } else {
      this.viewerCopiedFile = true;
      this.viewerCopiedLineNum = null;
    }
    if (cx?.timer) {
      this.viewerCopyTask = cx.timer.after(1500, timerCx => {
        this.viewerCopyTask = null;
        if (this._viewerClosed) return;
        this.viewerCopiedFile = false;
        this.viewerCopiedLineNum = null;
        timerCx.notify();
      });
    }
    cx.notify();
  }

  setViewerNavNotice(notice, cx) {
    try { this.viewerNoticeTask?.cancel(); } catch {}
    this.viewerNoticeTask = null;
    this.viewerNavNotice = notice || null;
    if (notice && cx?.timer) {
      this.viewerNoticeTask = cx.timer.after(3200, timerCx => {
        this.viewerNoticeTask = null;
        if (this._viewerClosed) return;
        this.viewerNavNotice = null;
        timerCx.notify();
      });
    }
    cx?.notify?.();
  }

  handleViewerTokenHover(nextKey, _tokenKey, cx) {
    if (this._viewerClosed) return;
    const prev = this.viewerHoveredTokenKey || null;
    if (nextKey) {
      if (prev === nextKey) return;
      this.viewerHoveredTokenKey = nextKey;
    } else {
      if (!prev || (_tokenKey && prev !== _tokenKey)) return;
      this.viewerHoveredTokenKey = null;
    }
    if (this.viewerCtrlHeld) {
      cx.notify();
    }
  }

  navigateViewerToLocation(loc, { recordOrigin = null, cx } = {}) {
    if (this._viewerClosed || !loc) return;
    const targetPath = loc.filePath || loc.path;
    if (!targetPath) return;

    this.viewerNavDisambig = null;
    this.viewerNavNotice = null;

    const targetOn = loc.on ?? this.viewerOn ?? null;
    const isWin = !targetOn && window()?.platform === "windows";
    const resolvedTarget = resolveViewerFilePath(loc.root || loc.serviceRoot || this.viewerRoot, targetPath) || targetPath;
    const targetLine = Math.max(1, Number(loc.line) || 1);
    const targetCol = Math.max(1, Number(loc.column) || 1);
    const targetSym = loc.symbol || loc.name || loc.highlightSymbol || null;

    const services = collectRegisteredServices();
    const matchedSvc = services.find(s => (loc.serviceId && s.id === loc.serviceId) || (s.root && isSameOrChildPath(resolvedTarget, s.root, isWin))) || null;
    const targetRoot = normPathStr(loc.root || loc.serviceRoot || matchedSvc?.root || this.viewerRoot || "");

    const targetNavEntry = {
      root: targetRoot,
      path: resolvedTarget,
      on: targetOn,
      serviceId: loc.serviceId ?? matchedSvc?.id ?? null,
      serviceName: loc.serviceName ?? matchedSvc?.name ?? null,
      line: targetLine,
      column: targetCol,
      symbol: targetSym || "",
    };

    if (recordOrigin && recordOrigin.path) {
      this.viewerNavHistory = pushNavHistory(this.viewerNavHistory, recordOrigin, targetNavEntry);
    }

    const sameFile = resolvedTarget === this.viewerTargetPath && (targetOn ?? null) === (this.viewerOn ?? null);
    if (sameFile && typeof this.viewerRawText === "string" && !this.viewerError) {
      this.viewerLine = targetLine;
      this.viewerColumn = targetCol;
      this.viewerHighlightSymbol = targetSym;
      this.viewerPendingScrollLine = targetLine;
      this.scrollViewerToLine(targetLine);
      this.scheduleViewerSync(cx, 0);
      cx.notify();
      return;
    }

    this.viewerRoot = targetRoot || this.viewerRoot;
    this.viewerOn = targetOn;
    this.viewerLine = targetLine;
    this.viewerColumn = targetCol;
    this.viewerHighlightSymbol = targetSym;
    this.viewerPendingScrollLine = targetLine;

    if (typeof loc.prefetchedText === "string") {
      this.switchViewerTarget(resolvedTarget, loc.prefetchedText, cx, {
        targetRoot,
        on: targetOn,
        line: targetLine,
        column: targetCol,
        highlightSymbol: targetSym,
        serviceId: targetNavEntry.serviceId,
        serviceName: targetNavEntry.serviceName,
      });
      return;
    }

    const navSeq = ++this.viewerNavSeq;
    const spawnCx = typeof cx?.spawn === "function" ? cx : null;
    if (!spawnCx) return;
    this.viewerLoading = true;
    this.viewerError = null;
    cx.notify();

    spawnCx.spawn(async innerCx => {
      try {
        const text = await readTextFile(resolvedTarget, { on: targetOn }).catch(() => null);
        if (this._viewerClosed || navSeq !== this.viewerNavSeq) return;
        if (typeof text !== "string" || text.includes("\0")) {
          this.viewerLoading = false;
          this.setViewerNavNotice(buildViewerNavigationNotice({ status: "not-found" }, { symbol: targetSym || resolvedTarget }), innerCx);
          return;
        }
        this.switchViewerTarget(resolvedTarget, text, innerCx, {
          targetRoot,
          on: targetOn,
          line: targetLine,
          column: targetCol,
          highlightSymbol: targetSym,
          serviceId: targetNavEntry.serviceId,
          serviceName: targetNavEntry.serviceName,
        });
      } catch {
        if (!this._viewerClosed && navSeq === this.viewerNavSeq) {
          this.viewerLoading = false;
          this.setViewerNavNotice(buildViewerNavigationNotice({ status: "not-found" }, { symbol: targetSym || resolvedTarget }), innerCx);
        }
      }
    });
  }

  openNavTarget(loc, originEntry = null, cx = null) {
    if (this._viewerClosed || !loc) return;
    const targetPath = loc.filePath || loc.path;
    if (!targetPath) return;

    const targetOn = loc.on ?? this.viewerOn ?? null;
    const isWin = !targetOn && window()?.platform === "windows";
    const resolvedTarget = resolveViewerFilePath(loc.root || loc.serviceRoot || this.viewerRoot, targetPath) || targetPath;

    if (!shouldOpenNavInNewTab(resolvedTarget, this.viewerTargetPath, targetOn, this.viewerOn ?? null, isWin)) {
      this.navigateViewerToLocation(loc, { recordOrigin: originEntry, cx });
      return;
    }

    this.viewerNavDisambig = null;
    this.viewerNavNotice = null;
    this.viewerCtrlHeld = false;
    this.viewerHoveredTokenKey = null;
    cx?.notify?.();

    const targetLine = Math.max(1, Number(loc.line) || 1);
    const targetCol = Math.max(1, Number(loc.column) || 1);
    const targetSym = loc.symbol || loc.name || loc.highlightSymbol || null;
    const services = collectRegisteredServices();
    const matchedSvc = services.find(
      s => (loc.serviceId && s.id === loc.serviceId) || (s.root && isSameOrChildPath(resolvedTarget, s.root, isWin))
    ) || null;
    const targetRoot = normPathStr(loc.root || loc.serviceRoot || matchedSvc?.root || this.viewerRoot || "");
    const serviceId = loc.serviceId ?? matchedSvc?.id ?? null;
    const serviceName = loc.serviceName ?? matchedSvc?.name ?? null;
    const navOrigin = originEntry && originEntry.path
      ? {
          ...originEntry,
          tabId: originEntry.tabId || this.viewerTabId || null,
          spaceId: originEntry.spaceId || this.viewerSpaceId || null,
        }
      : null;

    openFileInTab({
      spaceId: this.viewerSpaceId || null,
      root: targetRoot,
      path: resolvedTarget,
      on: targetOn,
      line: targetLine,
      column: targetCol,
      highlightSymbol: targetSym,
      navOrigin,
      serviceId,
      serviceName,
      localServices: services,
    });
  }

  scheduleViewerNavWarmup(targetPath, sourceText, cx = null) {
    if (this._viewerClosed || this.viewerOn || !targetPath || typeof sourceText !== "string") return;
    if (!getNavLanguageAnalyzer(targetPath)) return;
    const sig = `${targetPath}:${sourceText.length}`;
    if (this.viewerLastWarmedSig === sig) return;
    this.viewerLastWarmedSig = sig;
    const spawnCx = typeof cx?.spawn === "function" ? cx : null;
    if (!spawnCx) return;
    spawnCx.spawn(async cx => {
      try {
        if (this._viewerClosed) return;
        const services = collectRegisteredServices();
        const root = normPathStr(this.viewerRoot || services[0]?.root || "");
        const appHomeDir = getSafeAppHome();
        const indexedFilesByRoot = collectIndexedFilesByRoot(services, root, null);
        await warmFileImports({
          filePath: targetPath,
          sourceText,
          currentRoot: root,
          services,
          on: null,
          indexedFilesByRoot,
          appHomeDir,
        });
        if (!this._viewerClosed && root && !isServiceIndexWarmed(root, null)) {
          warmAllServiceSymbolIndices({
            services,
            currentRoot: root,
            on: null,
            indexedFilesByRoot,
            appHomeDir,
            skipIfFreshMs: 15000,
            yieldFn: () => cx.sleep(0),
          }).catch(() => {});
        }
      } catch {}
    });
  }

  stepViewerHistory(dir, cx) {
    if (this._viewerClosed) return;
    const step = dir === "back"
      ? stepNavBack(this.viewerNavHistory)
      : stepNavForward(this.viewerNavHistory);
    if (!step?.entry) return;
    this.viewerNavHistory = step.state;
    const targetOn = step.entry.on ?? this.viewerOn ?? null;
    const isWin = !targetOn && window()?.platform === "windows";
    const resolvedStepPath = resolveViewerFilePath(step.entry.root || this.viewerRoot, step.entry.path) || step.entry.path;
    const stepRoot = normPathStr(step.entry.root || this.viewerRoot || "");
    if (
      shouldOpenNavInNewTab(resolvedStepPath, this.viewerTargetPath, targetOn, this.viewerOn ?? null, isWin) &&
      hasMatchingOpenTabInSpace(this.viewerSpaceId || step.entry.spaceId || null, stepRoot, resolvedStepPath, isWin, this.viewerTabId)
    ) {
      openFileInTab({
        spaceId: this.viewerSpaceId || step.entry.spaceId || null,
        root: stepRoot,
        path: resolvedStepPath,
        on: targetOn,
        line: Math.max(1, Number(step.entry.line) || 1),
        column: Math.max(1, Number(step.entry.column) || 1),
        highlightSymbol: step.entry.symbol || null,
        navOrigin: null,
        serviceId: step.entry.serviceId || null,
        serviceName: step.entry.serviceName || null,
      });
      cx?.notify?.();
      return;
    }
    this.navigateViewerToLocation(step.entry, { recordOrigin: null, cx });
  }

  handleViewerTokenClick(tokenInfo, cx) {
    if (this._viewerClosed || !tokenInfo || !this.viewerTargetPath || typeof this.viewerRawText !== "string") return;
    const navSeq = ++this.viewerNavSeq;
    const originPath = this.viewerTargetPath;
    const originRoot = this.viewerRoot;
    const originOn = this.viewerOn ?? null;
    const originEntry = {
      root: originRoot,
      path: originPath,
      on: originOn,
      serviceId: this.viewerServiceId || null,
      serviceName: this.viewerServiceName || null,
      line: tokenInfo.line,
      column: tokenInfo.col,
      symbol: tokenInfo.symbol,
    };

    cx.spawn(async innerCx => {
      try {
        const services = collectRegisteredServices();
        const indexedFilesByRoot = collectIndexedFilesByRoot(services, originRoot, originOn);
        const openFilesTextMap = new Map([[originPath, this.viewerRawText]]);
        const result = await resolveCrossFileNavigation({
          sourceText: this.viewerRawText,
          filePath: originPath,
          line: tokenInfo.line,
          col: tokenInfo.col,
          currentRoot: originRoot,
          on: originOn,
          services,
          openFilesTextMap,
          indexedFilesByRoot,
          appHomeDir: getSafeAppHome(),
        });
        if (this._viewerClosed || navSeq !== this.viewerNavSeq || this.viewerTargetPath !== originPath) return;

        if (result?.status === "ok" && result.best) {
          const target = result.best;
          const sameLine = target.filePath === originPath && Number(target.line) === Number(tokenInfo.line);
          const sameCol = !target.column || Math.abs(Number(target.column) - Number(tokenInfo.col)) <= 1;
          if (sameLine && sameCol) {
            this.setViewerNavNotice(
              buildViewerNavigationNotice({ status: "already-there" }, result.context || { symbol: tokenInfo.symbol }, result.context?.intent),
              innerCx,
            );
            return;
          }
          this.openNavTarget(target, originEntry, innerCx);
          return;
        }
        if (result?.status === "ambiguous" && Array.isArray(result.candidates) && result.candidates.length > 0) {
          this.viewerNavNotice = null;
          if (!this.viewerSelectTextMode && this.viewerFocusHandle) {
            try { innerCx.focus(this.viewerFocusHandle); } catch {}
          }
          this.viewerNavDisambig = {
            candidates: result.candidates,
            selectedIndex: 0,
            origin: originEntry,
            root: originRoot,
            serviceName: this.viewerServiceName || "",
            mode: result.mode || result?.context?.intent || null,
            symbol: tokenInfo.symbol || "",
            anchorRect: computeLocalAnchorRect(tokenInfo, this._viewerContainerBounds, this._viewerLastPointer),
          };
          innerCx.notify();
          return;
        }
        this.setViewerNavNotice(
          buildViewerNavigationNotice(result, result?.context || { symbol: tokenInfo.symbol }, result?.context?.intent),
          innerCx,
        );
      } catch {
        if (!this._viewerClosed && navSeq === this.viewerNavSeq) {
          this.setViewerNavNotice(buildViewerNavigationNotice({ status: "not-found" }, { symbol: tokenInfo.symbol }), innerCx);
        }
      }
    });
  }

  applyViewerText(targetPath, text, reqSeq, { forceRecreate = false, cx = null } = {}) {
    const isWin = !this.viewerOn && window()?.platform === "windows";
    const targetChanged = Boolean(this.viewerLoadedTargetPath && this.viewerLoadedTargetPath !== targetPath);
    if (
      !forceRecreate &&
      !targetChanged &&
      typeof text === "string" &&
      !text.includes("\0") &&
      !this.viewerError &&
      !this.viewerSelectTextMode &&
      this.viewerDoc &&
      selectViewerRawText(text, false) === this.viewerRawText
    ) {
      this.viewerLoadedTargetPath = targetPath;
      this.viewerContentSeq = reqSeq;
      if (this.viewerPendingScrollLine) {
        this.scrollViewerToLine(this.viewerPendingScrollLine, this.viewerDoc);
      }
      this.scheduleViewerNavWarmup(targetPath, this.viewerRawText, cx);
      return;
    }
    if (targetChanged) {
      this.viewerScrollTop = 0;
    }
    this.viewerMarkdownRendered = resolveViewerMarkdownToggleOnLoad(
      this.viewerLoadedTargetPath,
      targetPath,
      this.viewerMarkdownRendered,
      isWin
    );
    this.viewerLoadedTargetPath = targetPath;
    this.viewerContentSeq = reqSeq;
    this.viewerDoc = null;
    this.viewerDocKey = null;
    this._viewerTokenizedDoc = null;

    if (text === null) {
      this.viewerCode?.release();
      this.viewerCode = null;
      this.viewerRawText = null;
      this.viewerApproxLineCount = 0;
      this.viewerScrollTop = 0;
      this.viewerError = "This file is no longer available";
      return;
    }
    if (text.includes("\0")) {
      this.viewerCode?.release();
      this.viewerCode = null;
      this.viewerRawText = null;
      this.viewerApproxLineCount = 0;
      this.viewerScrollTop = 0;
      this.viewerError = "Binary file · no text preview";
      return;
    }

    this.viewerError = null;
    this.viewerRawText = selectViewerRawText(text, false);
    this.viewerApproxLineCount = countTextLinesFast(this.viewerRawText);

    if (this.viewerSelectTextMode) {
      this.ensureViewerEditorState(targetPath, this.viewerRawText, { forceRecreate });
    } else {
      this.viewerCode?.release();
      this.viewerCode = null;
      this.viewerSyntaxSig = null;
      const doc = this.getOrBuildViewerDoc();
      if (this.viewerPendingScrollLine) {
        this.scrollViewerToLine(this.viewerPendingScrollLine, doc);
      } else if (doc && Array.isArray(doc.rows)) {
        const vpH = Math.max(120, Number(this.viewerViewportHeight) || 560);
        this.viewerScrollTop = computeWindowedViewerSlice(
          doc.rows.length,
          targetChanged ? 0 : (this.viewerScrollTop || 0),
          vpH - 8,
          CODE_VIEWER_LINE_HEIGHT,
        ).scrollTop;
      }
    }
    this.scheduleViewerNavWarmup(targetPath, this.viewerRawText, cx);
  }

  switchViewerTarget(resolvedPath, prefetchedText, cx, navMeta = {}) {
    if (this._viewerClosed || !resolvedPath) return;
    const isWin = !(navMeta.on ?? this.viewerOn) && window()?.platform === "windows";
    const effectiveRoot = normPathStr(navMeta.targetRoot || this.viewerRoot || "");
    let relPath = resolvedPath;
    if (effectiveRoot && isSameOrChildPath(resolvedPath, effectiveRoot, isWin)) {
      if (effectiveRoot === "/") {
        relPath = resolvedPath.slice(1) || resolvedPath;
      } else if (resolvedPath.length > effectiveRoot.length) {
        relPath = resolvedPath.slice(effectiveRoot.length + 1);
      }
    }
    const displayPath = (effectiveRoot && isSameOrChildPath(resolvedPath, effectiveRoot, isWin) && relPath)
      ? relPath
      : resolvedPath;
    const svc = navMeta.serviceName
      ? { serviceId: navMeta.serviceId || null, serviceName: navMeta.serviceName }
      : resolveServiceForFile(effectiveRoot, relPath, resolvedPath, isWin);

    const allSpaces = spaces() || [];
    const ownerSpace = (this.viewerSpaceId ? allSpaces.find(s => s.id === this.viewerSpaceId) : null)
      || allSpaces.find(s => (s.tabs || []).some(t => t.id === this.viewerTabId))
      || null;
    const existingTitles = new Set(
      (ownerSpace?.tabs || [])
        .filter(t => t?.id && t.id !== this.viewerTabId && t?.name)
        .map(t => t.name)
    );
    const nextTitle = formatFileTabTitle(resolvedPath, svc.serviceName, existingTitles);

    this.viewerRoot = effectiveRoot || this.viewerRoot;
    if ("on" in navMeta) this.viewerOn = navMeta.on ?? null;
    this.viewerPath = relPath;
    this.viewerAbsPath = resolvedPath;
    this.viewerTargetPath = resolvedPath;
    this.viewerDisplayPath = displayPath;
    this.viewerLine = navMeta.line ? Number(navMeta.line) : null;
    this.viewerColumn = navMeta.column ? Number(navMeta.column) : null;
    this.viewerHighlightSymbol = navMeta.highlightSymbol || null;
    this.viewerPendingScrollLine = this.viewerLine || 1;
    this.viewerServiceId = svc.serviceId;
    this.viewerServiceName = svc.serviceName;
    this.viewerTabTitle = nextTitle;
    this.viewerHoveredTokenKey = null;

    try {
      if (this.viewerTabId && nextTitle) {
        run("tab.rename", { id: this.viewerTabId, name: nextTitle });
      }
    } catch {}

    const reqSeq = ++this.viewerLoadSeq;
    this.viewerLoading = false;
    this.applyViewerText(resolvedPath, prefetchedText, reqSeq, { forceRecreate: true });
    this.viewerHasLoadedOnce = true;
    this.scheduleViewerSync(cx, 0);
    cx.notify();
  }

  openViewerRelativeLink(href, cx) {
    if (this._viewerClosed || !this.viewerTargetPath || typeof href !== "string") return;
    const isWin = !this.viewerOn && window()?.platform === "windows";
    const resolvedPath = resolveRelativeMarkdownTarget(this.viewerTargetPath, href, isWin);
    if (!resolvedPath) return;

    const navSeq = ++this.viewerNavSeq;
    const originPath = this.viewerTargetPath;
    const originLoadSeq = this.viewerLoadSeq;
    const on = this.viewerOn ?? null;
    const spawnCx = typeof cx?.spawn === "function" ? cx : null;
    if (!spawnCx) return;

    spawnCx.spawn(async innerCx => {
      try {
        if (!on && typeof fsPromises.stat === "function") {
          const st = await fsPromises.stat(resolvedPath).catch(() => null);
          if (!st || (typeof st.isDirectory === "function" && st.isDirectory())) {
            return;
          }
        }
        const text = await readTextFile(resolvedPath, { on }).catch(() => null);
        if (
          this._viewerClosed ||
          navSeq !== this.viewerNavSeq ||
          this.viewerTargetPath !== originPath ||
          this.viewerLoadSeq !== originLoadSeq
        ) {
          return;
        }
        if (typeof text !== "string" || text.includes("\0")) {
          return;
        }
        const originEntry = {
          root: this.viewerRoot,
          path: originPath,
          on,
          serviceId: this.viewerServiceId || null,
          serviceName: this.viewerServiceName || null,
          line: this.viewerLine || 1,
          column: this.viewerColumn || 1,
          symbol: this.viewerHighlightSymbol || "",
        };
        this.viewerNavHistory = pushNavHistory(this.viewerNavHistory, originEntry, {
          root: this.viewerRoot,
          path: resolvedPath,
          on,
          serviceId: this.viewerServiceId || null,
          serviceName: this.viewerServiceName || null,
          line: 1,
          column: 1,
          symbol: "",
        });
        this.switchViewerTarget(resolvedPath, text, innerCx);
      } catch {
        // Ignore missing or unreadable relative link targets without clobbering current viewer state.
      }
    });
  }

  loadViewerFile(cx, { silent = false, forceRecreate = false } = {}) {
    if (this._viewerClosed || !this.viewerTargetPath) return;
    const reqSeq = ++this.viewerLoadSeq;
    const targetPath = this.viewerTargetPath;
    const on = this.viewerOn ?? null;

    if (!silent) {
      this.viewerLoading = true;
      this.viewerError = null;
      cx.notify();
    }

    cx.spawn(async cx => {
      try {
        const text = await readTextFile(targetPath, { on });
        if (this._viewerClosed || reqSeq !== this.viewerLoadSeq) return;
        this.applyViewerText(targetPath, text, reqSeq, { forceRecreate, cx });
      } catch {
        if (!this._viewerClosed && reqSeq === this.viewerLoadSeq) {
          this.viewerCode?.release();
          this.viewerCode = null;
          this.viewerRawText = null;
          this.viewerApproxLineCount = 0;
          this._viewerTokenizedDoc = null;
          this.viewerContentSeq = reqSeq;
          this.viewerError = "Cannot open this file (binary, too large, or unreadable)";
        }
      } finally {
        if (!this._viewerClosed && reqSeq === this.viewerLoadSeq) {
          this.viewerLoading = false;
          this.viewerHasLoadedOnce = true;
          cx.notify();
        }
      }
    });
  }

  closeViewer() {
    this._viewerClosed = true;
    this.viewerLoadSeq = (this.viewerLoadSeq || 0) + 1;
    this.viewerNavSeq = (this.viewerNavSeq || 0) + 1;
    try { this.viewerSyncTask?.cancel(); } catch {}
    this.viewerSyncTask = null;
    try { this.viewerResizeTask?.cancel(); } catch {}
    this.viewerResizeTask = null;
    try { this.viewerCopyTask?.cancel(); } catch {}
    this.viewerCopyTask = null;
    try { this.viewerNoticeTask?.cancel(); } catch {}
    this.viewerNoticeTask = null;
    this.viewerScrollTop = 0;
    try { this.viewerNavDropdownScroll?.release(); } catch {}
    this.viewerNavDropdownScroll = null;
    try { this.viewerCode?.release(); } catch {}
    this.viewerCode = null;
    this.viewerSyntaxSig = null;
    this.viewerDoc = null;
    this.viewerDocKey = null;
    this._viewerTokenizedDoc = null;
    this._pendingViewerSize = null;
    this._viewerContainerBounds = null;
    this._viewerLastPointer = null;
    this.viewerApproxLineCount = 0;
    this.viewerGutterWidth = null;
    this.viewerMaxCols = null;
    this.viewerHoveredTokenKey = null;
    this.viewerCtrlHeld = false;
    this.viewerNavDisambig = null;
    this.viewerNavNotice = null;
    this.viewerTargetPath = "";
    this.viewerLoadedTargetPath = null;
    this.viewerRawText = null;
    this.viewerMarkdownRendered = false;
    this.viewerMarkdownCache?.clear();
    this.viewerMarkdownCache = null;
    if (this.viewerTabId && ACTIVE_VIEWER_CLAIMS.get(this.viewerTabId) === this.viewerId) {
      ACTIVE_VIEWER_CLAIMS.delete(this.viewerTabId);
    }
  }

  renderViewerMarkdown(t) {
    const cacheKey = buildViewerMarkdownCacheKey(this.viewerTargetPath, this.viewerContentSeq);
    if (!this.viewerMarkdownCache) {
      this.viewerMarkdownCache = createMarkdownRenderCache(12);
    }
    const prepared = this.viewerMarkdownCache.getOrPrepare(cacheKey, this.viewerRawText, {
      filePath: this.viewerTargetPath,
    });
    const mdIds = buildViewerMarkdownViewIds(this.viewerId, this.viewerTargetPath, this.viewerContentSeq);
    const monoFont = settings()?.font_family || "monospace";

    return renderMarkdownViewer({
      id: mdIds.id,
      scrollId: mdIds.scrollId,
      prepared,
      filePath: this.viewerTargetPath,
      monoFont,
      t,
      onRelativeLink: (href, linkCx) => this.openViewerRelativeLink(href, linkCx),
    });
  }

  renderViewer(cx) {
    const t = theme();
    const allSpaces = spaces() || [];
    const activeSpace = allSpaces.find(s => s.active) || null;
    const openTabs = asPlainObject(shared("cognivisor.openFileTabs"));
    const sharedEntry = this.viewerTabId ? openTabs[this.viewerTabId] : null;
    const isActiveNow = Boolean(
      this.viewerTabId && activeSpace && (activeSpace.tabs || []).some(tab => tab.id === this.viewerTabId && tab.active)
    );
    const sharedNavSeq = Number(sharedEntry?.navSeq) || 0;
    const hasNewSharedUpdate = Boolean(
      sharedEntry && (
        sharedNavSeq > (this.viewerLastSyncedNavSeq || 0) ||
        (sharedEntry.updatedAt && sharedEntry.updatedAt > this.viewerLastSyncedUpdatedAt)
      )
    );
    const needsSyntaxUpdate = Boolean(
      this.viewerSelectTextMode &&
      this.viewerCode &&
      this.viewerSyntaxSig &&
      this.viewerSyntaxSig !== `${JSON.stringify(getEditorSyntaxConfig(t))}|${settings()?.font_family || ""}`
    );
    const isMd = isMarkdownFile(this.viewerTargetPath);
    const showRenderedMd = Boolean(
      isMd &&
      this.viewerMarkdownRendered &&
      !this.viewerError &&
      typeof this.viewerRawText === "string"
    );

    if (
      !this.viewerTabId ||
      !sharedEntry ||
      sharedEntry.absPath !== this.viewerTargetPath ||
      hasNewSharedUpdate ||
      needsSyntaxUpdate ||
      (this.viewerSeenActiveState && isActiveNow !== this.viewerWasActive)
    ) {
      this.scheduleViewerSync(cx, 0);
    }

    const activeLine = (sharedEntry && hasNewSharedUpdate ? sharedEntry.line : null) ?? this.viewerLine;
    const activeCol = (sharedEntry && hasNewSharedUpdate ? sharedEntry.column : null) ?? this.viewerColumn;
    const activeSym = (sharedEntry && hasNewSharedUpdate ? sharedEntry.highlightSymbol : null) ?? this.viewerHighlightSymbol;
    const monoFont = settings()?.font_family || "monospace";
    const fileIcon = resolveFileIcon(this.viewerTargetPath || this.viewerPath || "file", t);
    const normDisplay = normPathStr(this.viewerDisplayPath || this.viewerPath || this.viewerTargetPath || "");
    const slashIdx = normDisplay.lastIndexOf("/");
    const fileName = slashIdx >= 0 ? normDisplay.slice(slashIdx + 1) : (normDisplay || "Untitled");
    const parentDir = slashIdx >= 0 ? normDisplay.slice(0, slashIdx) : "";
    const viewerDoc = (!showRenderedMd && !this.viewerSelectTextMode) ? this.getOrBuildViewerDoc() : null;
    const canBack = canStepNavBack(this.viewerNavHistory);
    const canForward = canStepNavForward(this.viewerNavHistory);

    return v_flex()
      .id("file-viewer")
      .relative()
      .when(Boolean(this.viewerFocusHandle), el => el.track_focus(this.viewerFocusHandle))
      .size_full()
      .min_h(0)
      .min_w(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .on_mouse_down("left", (e, mouseCx) => {
        if (e?.bounds) this._viewerContainerBounds = e.bounds;
        if (e?.local_position) this._viewerLastPointer = e.local_position;
        if (!this.viewerSelectTextMode && this.viewerFocusHandle) {
          try { mouseCx.focus(this.viewerFocusHandle); } catch {}
        }
      })
      .on_mouse_move((e, moveCx) => {
        if (e?.bounds) this._viewerContainerBounds = e.bounds;
        if (e?.local_position) this._viewerLastPointer = e.local_position;
        const nextCtrl = isNavModifierActive(e?.modifiers);
        if (nextCtrl !== this.viewerCtrlHeld) {
          this.viewerCtrlHeld = nextCtrl;
          moveCx.notify();
        }
      })
      .on_modifiers_changed((e, modCx) => {
        const nextCtrl = isNavModifierActive(e?.modifiers);
        if (nextCtrl !== this.viewerCtrlHeld) {
          this.viewerCtrlHeld = nextCtrl;
          modCx.notify();
        }
      })
      .on_key_down((e, keyCx) => {
        const k = e.key;
        if (this.viewerNavDisambig) {
          const cands = this.viewerNavDisambig.candidates || [];
          const count = cands.length;
          if (k === "escape") {
            this.viewerNavDisambig = null;
            keyCx.stop_propagation();
            keyCx.notify();
            return;
          }
          if ((k === "down" || k === "arrowdown") && count > 0) {
            const nextIdx = ((this.viewerNavDisambig.selectedIndex || 0) + 1) % count;
            this.viewerNavDisambig.selectedIndex = nextIdx;
            try { this.viewerNavDropdownScroll?.scroll_to_item(nextIdx); } catch {}
            keyCx.stop_propagation();
            keyCx.notify();
            return;
          }
          if ((k === "up" || k === "arrowup") && count > 0) {
            const nextIdx = ((this.viewerNavDisambig.selectedIndex || 0) - 1 + count) % count;
            this.viewerNavDisambig.selectedIndex = nextIdx;
            try { this.viewerNavDropdownScroll?.scroll_to_item(nextIdx); } catch {}
            keyCx.stop_propagation();
            keyCx.notify();
            return;
          }
          if (k === "enter" && count > 0) {
            const picked = cands[this.viewerNavDisambig.selectedIndex || 0] || cands[0];
            this.openNavTarget(picked, this.viewerNavDisambig.origin, keyCx);
            keyCx.stop_propagation();
            return;
          }
        }
        if (e.modifiers?.alt && (k === "left" || k === "arrowleft")) {
          this.stepViewerHistory("back", keyCx);
          keyCx.stop_propagation();
        } else if (e.modifiers?.alt && (k === "right" || k === "arrowright")) {
          this.stepViewerHistory("forward", keyCx);
          keyCx.stop_propagation();
        } else if (!this.viewerSelectTextMode && !this.viewerNavDisambig && !e.modifiers?.alt && !e.modifiers?.control && !e.modifiers?.platform) {
          const vpH = Math.max(120, Number(this.viewerViewportHeight) || 560);
          const pageStep = Math.max(1, Math.floor((vpH - 8) / CODE_VIEWER_LINE_HEIGHT) - 2);
          if (k === "down" || k === "arrowdown") {
            this.scrollViewerBy(1, keyCx);
            keyCx.stop_propagation();
          } else if (k === "up" || k === "arrowup") {
            this.scrollViewerBy(-1, keyCx);
            keyCx.stop_propagation();
          } else if (k === "pagedown") {
            this.scrollViewerBy(pageStep, keyCx);
            keyCx.stop_propagation();
          } else if (k === "pageup") {
            this.scrollViewerBy(-pageStep, keyCx);
            keyCx.stop_propagation();
          } else if (k === "home") {
            this.scrollViewerToBoundary(false, keyCx);
            keyCx.stop_propagation();
          } else if (k === "end") {
            this.scrollViewerToBoundary(true, keyCx);
            keyCx.stop_propagation();
          }
        }
      })
      .child(
        h_flex()
          .h(40)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(svg(fileIcon.path).size(14).flex_none().text_color(fileIcon.color))
          .when(Boolean(this.viewerServiceName), el =>
            el.child(
              div()
                .flex_none()
                .px(5)
                .py(1)
                .rounded(4)
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(10)
                .font_medium()
                .text_color(t.accent)
                .child(this.viewerServiceName)
            )
          )
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .overflow_hidden()
              .gap(6)
              .items_center()
              .child(
                div()
                  .min_w(0)
                  .when(!parentDir, el => el.flex_1())
                  .truncate()
                  .font_semibold()
                  .text_size(12.5)
                  .text_color(t.foreground)
                  .child(fileName)
              )
              .when(Boolean(parentDir), el =>
                el.child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11.5)
                    .text_color(t.dim)
                    .child(parentDir)
                )
              )
          )
          .when(Boolean(activeLine), el =>
            el.child(
              div()
                .flex_none()
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.selected)
                .border_1()
                .border_color(t.border)
                .text_size(10.5)
                .font_medium()
                .text_color(t.ansi3 || t.accent || t.foreground)
                .child(`Ln ${activeLine}`)
            )
          )
          .child(
            renderViewerNavToolbar({
              t,
              canBack,
              canForward,
              selectTextMode: Boolean(this.viewerSelectTextMode),
              copiedFile: Boolean(this.viewerCopiedFile),
              hasFile: Boolean(!this.viewerError && typeof this.viewerRawText === "string"),
              onBack: backCx => this.stepViewerHistory("back", backCx),
              onForward: fwdCx => this.stepViewerHistory("forward", fwdCx),
              onCopyFile: copyCx => {
                if (typeof this.viewerRawText === "string") {
                  this.copyViewerText(this.viewerRawText, null, copyCx);
                }
              },
              onToggleSelectText: toggleCx => this.toggleViewerSelectText(toggleCx),
            })
          )
          .when(isMd, el =>
            el.child(
              renderMarkdownToggleButton({
                id: "viewer-markdown-toggle",
                active: Boolean(this.viewerMarkdownRendered),
                disabled: Boolean(this.viewerError || (this.viewerLoading && typeof this.viewerRawText !== "string")),
                height: 26,
                rounded: 6,
                icon: "mods/files-search/icons/file-types/markdown.svg",
                t,
                onClick: (_e, cx) => {
                  if (this.viewerError || typeof this.viewerRawText !== "string") return;
                  this.viewerMarkdownRendered = !this.viewerMarkdownRendered;
                  cx.notify();
                },
              })
            )
          )
          .child(
            h_flex()
              .id("viewer-reload")
              .h(26)
              .px(8)
              .gap(4)
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(6)
              .cursor_pointer()
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .text_size(11.5)
              .text_color(t.muted)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => this.loadViewerFile(cx, { silent: false, forceRecreate: true }))
              .child(this.viewerLoading ? svg("mods/files-search/spinner.svg").size(11).spin(900) : div().child("↻"))
              .child(div().child("Reload"))
          )
      )
      .child(
        showRenderedMd
          ? this.renderViewerMarkdown(t)
          : this.viewerError
            ? v_flex()
                .flex_1()
                .min_h(0)
                .w_full()
                .p(20)
                .gap(10)
                .items_start()
                .child(div().text_size(12.5).text_color(t.dim).child(this.viewerError))
                .when(Boolean(this.viewerTargetPath), el =>
                  el.child(
                    div()
                      .id("viewer-retry")
                      .px(10)
                      .py(5)
                      .rounded(6)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.raised)
                      .text_size(12)
                      .text_color(t.foreground)
                      .cursor_pointer()
                      .hover(s => s.bg(t.hover))
                      .on_click((_e, cx) => this.loadViewerFile(cx, { silent: false, forceRecreate: true }))
                      .child("Retry")
                  )
                )
            : this.viewerSelectTextMode && this.viewerCode
              ? Editor.new(this.viewerCode).flex_1().min_h(0).w_full().min_w(0)
              : viewerDoc
                ? renderCodeViewerBody({
                    listId: "viewer-code-lines",
                    idPrefix: "main-cv",
                    t,
                    monoFont,
                    doc: viewerDoc,
                    scrollTop: this.viewerScrollTop || 0,
                    viewportHeight: this.viewerViewportHeight || 560,
                    targetLine: activeLine,
                    targetCol: activeCol,
                    highlightSymbol: activeSym || "",
                    hoveredTokenKey: this.viewerHoveredTokenKey,
                    ctrlHeld: Boolean(this.viewerCtrlHeld),
                    copiedLineNum: this.viewerCopiedLineNum,
                    onTokenHover: (nextKey, tokenKey, hoverCx) => this.handleViewerTokenHover(nextKey, tokenKey, hoverCx),
                    onTokenClick: (tokenInfo, _ev, clickCx) => this.handleViewerTokenClick(tokenInfo, clickCx),
                    onCopyLine: (lineNum, lineCx) => {
                      const lineText = extractLineAtFast(this.viewerRawText, lineNum);
                      this.copyViewerText(lineText, lineNum, lineCx);
                    },
                    onScrollDelta: shouldAllowUnderlyingScroll({
                      closed: this._viewerClosed,
                      selectTextMode: this.viewerSelectTextMode,
                      hasDisambiguationPopover: Boolean(this.viewerNavDisambig),
                    })
                      ? (deltaRows, wheelCx) => this.scrollViewerBy(deltaRows, wheelCx)
                      : null,
                    onSizeChange: (w, h, sizeCx) => this.scheduleViewerResizeReflow(w, h, sizeCx),
                  })
                : h_flex()
                    .flex_1()
                    .min_h(0)
                    .w_full()
                    .p(20)
                    .gap(8)
                    .items_start()
                    .text_size(12.5)
                    .text_color(t.dim)
                    .child(svg("mods/files-search/spinner.svg").size(13).flex_none().spin(900))
                    .child("Loading file…")
      )
      .when(Boolean(this.viewerNavNotice), el =>
        el.child(
          div()
            .absolute()
            .bottom(14)
            .right(18)
            .max_w(440)
            .child(
              renderNavToastBanner({
                id: "viewer-nav-toast",
                t,
                notice: this.viewerNavNotice,
                onDismiss: dismissCx => {
                  this.viewerNavNotice = null;
                  dismissCx.notify();
                },
              })
            )
        )
      )
      .when(Boolean(this.viewerNavDisambig), el =>
        el.child(
          renderNavDisambiguationPopover({
            overlayId: "viewer-nav-disambig-overlay",
            menuId: "viewer-nav-disambig-menu",
            t,
            monoFont,
            disambig: this.viewerNavDisambig,
            currentRoot: this.viewerNavDisambig?.root || this.viewerRoot || "",
            currentServiceName: this.viewerNavDisambig?.serviceName || "",
            scrollHandle: this.viewerNavDropdownScroll,
            anchorRect: this.viewerNavDisambig?.anchorRect || null,
            containerWidth: Math.max(220, Number(this._viewerContainerBounds?.width) || Number(this.viewerViewportWidth) || 760),
            containerHeight: Math.max(180, Number(this._viewerContainerBounds?.height) || ((Number(this.viewerViewportHeight) || 560) + 40)),
            minWidth: 280,
            maxWidth: 460,
            maxHeight: Math.max(180, Math.min(300, (Number(this.viewerViewportHeight) || 560) - 60)),
            marginX: 12,
            marginTop: 46,
            marginBottom: 14,
            onSelectCandidate: (cand, pickCx) =>
              this.openNavTarget(cand, this.viewerNavDisambig?.origin, pickCx),
            onClose: closeCx => {
              this.viewerNavDisambig = null;
              closeCx.notify();
            },
          })
        )
      );
  }

}
