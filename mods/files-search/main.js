// FilesSearch: File browser with search button + floating IntelliJ-style Search Everywhere dialog.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, Scrollbar, ScrollHandle, VirtualListScrollHandle, v_virtual_list } from "gpui-base";
import * as fsPromises from "fs/promises";
const { readdir, exists } = fsPromises;
import { join } from "path";
import {
  spaces, panes, focused, agents, terminals, hc, exec, appHome, readTextFile, watchFolder,
  theme, settings, window, layout, props, openOverlay, closeOverlay,
  shared, setShared, run,
} from "herdr";
import {
  DISCOVER_SKIP_DIRS,
  COMMON_IGNORE_GLOBS,
  MAX_OVERLAY_FILES,
  INDEX_REBUILD_DEBOUNCE_MS,
  AGENT_PREWARM_DEBOUNCE_MS,
  RG_AVAILABLE_CACHE,
  normPathStr,
  normCmpStr,
  isSameOrChildPath,
  joinSubPath,
  isSupportedDirentList,
  direntIsDir,
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
  ownsRootWatcher,
  hasActiveRootWatcher,
  releaseRootWatcher,
  setIndexWatching,
} from "./indexer.js";
import {
  MAX_FILE_RESULTS,
  MAX_TEXT_RESULTS,
  FILE_SEARCH_CHUNK,
  FILE_SEARCH_BUDGET_MS,
  parsePorcelainHeader,
  parseSearchOutputLines,
  fuzzy,
  prepareSearchQuery,
  scoreIndexEntry,
  buildTopFileItems,
  getSyntaxExt,
  resolveEditorLanguage,
  getSyntaxPalette,
  getEditorSyntaxConfig,
  resolveFileIcon,
  expandCodeTabs,
  resolveViewerFilePath,
  buildFileViewerKey,
  formatFileTabTitle,
  pruneOpenFileTabs,
  findMatchingOpenFileTab,
  resolveViewerMarkdownToggleOnLoad,
  selectViewerRawText,
  shouldReuseInFlightPendingViewerOpen,
  buildViewerMarkdownCacheKey,
  buildViewerMarkdownViewIds,
  resolveRelativeMarkdownTarget,
  shouldResetPreviewMarkdown,
  shouldLoadFullMarkdownPreview,
  buildPreviewMarkdownViewIds,
  MAX_PREVIEW_RENDER_LINE_CHARS,
  buildWrappedViewerDocument,
  computeWindowedViewerSlice,
  computeTargetCenterScrollRow,
  isNavModifierActive,
  buildViewerNavigationNotice,
  applyTabNavMeta,
  shouldOpenNavInNewTab,
  computeLocalAnchorRect,
  shouldAllowUnderlyingScroll,
} from "./search-logic.js";
import {
  tokenizeInteractiveCodeLine,
  createCodeSyntaxState,
  advanceSyntaxState,
  cloneSyntaxState,
  getSyntaxStateTag,
} from "./code-syntax.js";
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
  invalidateIndexedFiles,
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
import { computeWrapColumns, wrapStyledSpans } from "./code-wrap.js";
import {
  isMarkdownExt,
  tokenizeMarkdownLine,
} from "./markdown-syntax.js";
import {
  resolveCachedCascade,
  MAX_CASCADE_DEPTH,
  POSIX_CASCADE_SCRIPT,
  sortDirectoryEntries,
  matchesServiceFilter,
  getCascadeChildPath,
  collectSubtreePaths,
  parseCascadeStdout,
  runStagedCascade,
} from "./tree-logic.js";
import {
  normalizeGitStatusMark,
  normalizeSessionBaseline,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  terminalHasResumeCommand,
  statFileEntry,
  filterSessionDirtyEntries,
  resolveWorkspaceRoot,
} from "./session-baseline.js";

function asPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function shallowEqualStringMap(a, b) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

const ACTIVE_VIEWER_CLAIMS = new Map();
const PENDING_VIEWER_OPENS = new Map();
let VIEWER_ID_SEQ = 0;

function countTextLinesFast(text) {
  if (typeof text !== "string" || text.length === 0) return 1;
  let count = 1;
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf("\n", idx + 1);
  }
  return count;
}

function extractLineAtFast(text, lineNum) {
  if (typeof text !== "string" || !lineNum || lineNum < 1) return "";
  let curLine = 1;
  let start = 0;
  while (curLine < lineNum) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) return "";
    start = nl + 1;
    curLine += 1;
  }
  const endNl = text.indexOf("\n", start);
  let end = endNl === -1 ? text.length : endNl;
  if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
  return text.slice(start, end);
}

const MAX_PREVIEW_WRAP_CACHE = 400;
const previewWrapCache = new Map();

function getCachedPreviewRows(text, ext, maxCols, mdState = null) {
  const strText = String(text || "");
  const clippedText = strText.length > MAX_PREVIEW_RENDER_LINE_CHARS
    ? `${strText.slice(0, MAX_PREVIEW_RENDER_LINE_CHARS)} …`
    : strText;
  const mdTag = mdState ? getSyntaxStateTag(mdState) : "";
  const key = `${clippedText}\0${ext || ""}\0${mdTag}\0${maxCols}`;
  let hit = previewWrapCache.get(key);
  if (hit) {
    previewWrapCache.delete(key);
    previewWrapCache.set(key, hit);
    return hit;
  }

  const expanded = expandCodeTabs(clippedText);
  if (!expanded) {
    hit = { mode: "empty", rows: null };
  } else {
    const tokens = tokenizeInteractiveCodeLine(clippedText, ext, mdState ? cloneSyntaxState(mdState) : null);
    if (!tokens || tokens.length === 0) {
      const plainText = expanded.length > MAX_PREVIEW_RENDER_LINE_CHARS
        ? `${expanded.slice(0, MAX_PREVIEW_RENDER_LINE_CHARS)} …`
        : expanded;
      hit = { mode: "plain", rows: wrapStyledSpans([["plain", plainText, { col: 1, nav: false }]], maxCols, { toNbsp: true }) };
    } else {
      hit = { mode: "tokens", rows: wrapStyledSpans(tokens, maxCols, { toNbsp: true }) };
    }
  }

  if (previewWrapCache.size >= MAX_PREVIEW_WRAP_CACHE) {
    const firstKey = previewWrapCache.keys().next().value;
    if (firstKey !== undefined) previewWrapCache.delete(firstKey);
  }
  previewWrapCache.set(key, hit);
  return hit;
}

function syncSpaceAgentTabs() {
  const allSpaces = spaces() || [];
  if (!allSpaces.length) return;
  const allPanes = panes() || [];
  const prev = asPlainObject(shared("cognivisor.spaceAgentTabs"));
  const next = {};

  for (const space of allSpaces) {
    if (!space?.id) continue;
    const spaceTabs = space.tabs || [];
    const spaceTabIds = new Set(spaceTabs.map(t => t?.id).filter(Boolean));
    const tabHasTerminal = tabId => Boolean(tabId && allPanes.some(p => p.tab === tabId && Boolean(p.terminal)));
    const activeTab = spaceTabs.find(t => t?.active) || null;

    if (activeTab && tabHasTerminal(activeTab.id)) {
      next[space.id] = activeTab.id;
    } else if (prev[space.id] && spaceTabIds.has(prev[space.id]) && tabHasTerminal(prev[space.id])) {
      next[space.id] = prev[space.id];
    } else {
      const agentPane = allPanes.find(p => spaceTabIds.has(p.tab) && Boolean(p.terminal) && p.program?.agent);
      const termPane = agentPane || allPanes.find(p => spaceTabIds.has(p.tab) && Boolean(p.terminal));
      if (termPane?.tab) {
        next[space.id] = termPane.tab;
      }
    }
  }

  if (!shallowEqualStringMap(prev, next)) {
    setShared("cognivisor.spaceAgentTabs", next);
  }
}

function location() {
  const allSpaces = spaces() || [];
  const space = allSpaces.find(s => s.active) || null;
  const f = focused();
  const allPanes = panes() || [];
  const spaceTabs = space?.tabs || [];
  const spaceTabIds = new Set(spaceTabs.map(t => t.id));
  const activeTab = spaceTabs.find(t => t.active) || null;
  const spacePanes = allPanes.filter(p => spaceTabIds.has(p.tab));
  const focusedPane = f?.pane ? allPanes.find(p => p.pane === f.pane) : null;
  const activeTabPanes = activeTab ? spacePanes.filter(p => p.tab === activeTab.id) : [];
  const activePane = (focusedPane && (!activeTab || focusedPane.tab === activeTab.id) ? focusedPane : null)
    || activeTabPanes.find(p => p.focused)
    || activeTabPanes[0]
    || focusedPane
    || null;

  const tabHasTerminal = tabId => Boolean(tabId && spacePanes.some(p => p.tab === tabId && Boolean(p.terminal)));
  const openFileTabs = asPlainObject(shared("cognivisor.openFileTabs"));
  const isFileViewerTab = tabId => Boolean(
    tabId && (
      openFileTabs[tabId] ||
      (spacePanes.some(p => p.tab === tabId && (p.mod === "files-search" || p.mod === "changes-review")) && !tabHasTerminal(tabId))
    )
  );
  const isNonTerminalActive = Boolean(
    activeTab && (isFileViewerTab(activeTab.id) || (!activePane?.cwd && activeTabPanes.length > 0 && !tabHasTerminal(activeTab.id)))
  );

  let anchoredTabId = null;
  if (activeTab && !isNonTerminalActive) {
    anchoredTabId = activeTab.id;
  } else {
    const storedAgentTabId = space?.id ? asPlainObject(shared("cognivisor.spaceAgentTabs"))[space.id] : null;
    if (storedAgentTabId && spaceTabIds.has(storedAgentTabId) && tabHasTerminal(storedAgentTabId)) {
      anchoredTabId = storedAgentTabId;
    } else {
      const fallbackTermPane = spacePanes.find(p => Boolean(p.terminal) && Boolean(p.cwd))
        || spacePanes.find(p => Boolean(p.terminal));
      anchoredTabId = fallbackTermPane?.tab || null;
    }
  }

  const anchoredPanes = anchoredTabId ? spacePanes.filter(p => p.tab === anchoredTabId) : [];
  const fallbackPane = anchoredPanes.find(p => Boolean(p.cwd))
    || spacePanes.find(p => Boolean(p.terminal) && Boolean(p.cwd))
    || spacePanes.find(p => Boolean(p.cwd))
    || null;

  const on = f?.pane === null && f?.terminal
    ? (f.terminal.includes("/") ? f.terminal.split("/")[0] : null)
    : space?.machine ?? null;
  const isWin = !on && window()?.platform === "windows";
  const spaceFolder = space?.folder;
  const paneCwd = activePane?.cwd || (!activePane?.cwd ? fallbackPane?.cwd : null) || null;
  let cwd = resolveWorkspaceRoot({
    spaceFolder,
    paneCwd,
    fallbackCwd: f?.cwd || null,
    on,
    isWindows: isWin,
    appHomeDir: getSafeAppHome(),
  });
  if (!cwd && activeTab && openFileTabs[activeTab.id]?.root) {
    cwd = openFileTabs[activeTab.id].root;
  }

  return {
    cwd,
    on,
    space: space?.id,
    tabId: anchoredTabId ?? (isNonTerminalActive ? null : activeTab?.id ?? null),
  };
}

function resolveServiceForFile(root, relOrPath, absPath, isWin = false, localServices = null) {
  const bus = asPlainObject(shared("cognivisor.services"));
  const merged = [];
  const seenKeys = new Set();
  const addList = list => {
    for (const s of list || []) {
      if (!s) continue;
      const k = normCmpStr(s.root || s.id || s.name, isWin);
      if (!k || seenKeys.has(k)) continue;
      seenKeys.add(k);
      merged.push(s);
    }
  };
  addList(localServices);
  addList(bus.services);
  addList(bus.candidates);
  if (!merged.length) return { serviceId: null, serviceName: null };

  const normRel = normPathStr(relOrPath).replace(/^\.\//, "");
  let best = null;
  let bestScore = -1;
  for (const s of merged) {
    const sRel = normPathStr(s.relPath || "");
    if (sRel && normRel && (normRel === sRel || normRel.startsWith(sRel + "/"))) {
      const score = 1000 + sRel.length;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
      continue;
    }
    if (s.root && absPath && isSameOrChildPath(absPath, s.root, isWin)) {
      const score = normPathStr(s.root).length;
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
    }
  }
  if (!best) return { serviceId: null, serviceName: null };
  if (merged.length <= 1 && !best.relPath && !best.isSibling) {
    return { serviceId: null, serviceName: null };
  }
  return { serviceId: best.id || null, serviceName: best.name || null };
}

function collectRegisteredServices(localServices = null) {
  const bus = asPlainObject(shared("cognivisor.services"));
  const merged = [];
  const seen = new Set();
  const addList = list => {
    for (const s of list || []) {
      if (!s || !s.root) continue;
      const key = `${s.root}::${s.id || s.name || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(s);
    }
  };
  addList(localServices);
  addList(bus.services);
  addList(bus.candidates);
  return merged;
}

const INDEXED_FILES_SET_CACHE = new WeakMap();

function collectIndexedFilesByRoot(services, fallbackRoot = "", fallbackOn = null) {
  const map = new Map();
  const roots = new Set();
  if (fallbackRoot) roots.add(normPathStr(fallbackRoot));
  for (const s of services || []) {
    if (s?.root) roots.add(normPathStr(s.root));
  }
  const isWinDefault = !fallbackOn && window()?.platform === "windows";
  for (const r of roots) {
    const cached = getCachedIndex(makeIndexKey(r, fallbackOn ?? null, isWinDefault));
    if (cached && Array.isArray(cached.entries) && cached.entries.length > 0) {
      let files = INDEXED_FILES_SET_CACHE.get(cached.entries);
      if (!files) {
        files = new Set();
        const entries = cached.entries;
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i];
          if (e && e.kind === "file" && e.path) {
            let rel = normPathStr(e.path);
            if (rel.startsWith("./")) rel = rel.slice(2);
            if (rel) files.add(rel);
          }
        }
        INDEXED_FILES_SET_CACHE.set(cached.entries, files);
      }
      if (files.size > 0) map.set(r, files);
    }
  }
  return map;
}

function hasMatchingOpenTabInSpace(spaceId, root, absPath, isWin, excludeTabId = null) {
  const allSpaces = spaces() || [];
  const targetSpace = (spaceId ? allSpaces.find(s => s.id === spaceId) : null) || allSpaces.find(s => s.active) || null;
  if (!targetSpace?.id) return false;
  const allLiveTabIds = new Set();
  for (const s of allSpaces) {
    for (const t of s.tabs || []) {
      if (t?.id) allLiveTabIds.add(t.id);
    }
  }
  const filePaneTabIds = new Set(
    (panes() || []).filter(p => p?.mod === "files-search" && p?.tab).map(p => p.tab)
  );
  const spaceTabIds = new Set((targetSpace.tabs || []).map(t => t?.id).filter(Boolean));
  const { tabs: prunedTabs } = pruneOpenFileTabs(asPlainObject(shared("cognivisor.openFileTabs")), allLiveTabIds, filePaneTabIds);
  const match = findMatchingOpenFileTab(prunedTabs, spaceTabIds, filePaneTabIds, normPathStr(root || targetSpace.folder || ""), absPath, isWin);
  return Boolean(match && match.tabId !== excludeTabId);
}

function openFileInTab({
  spaceId = null,
  root = "",
  path = "",
  on = null,
  line = null,
  column = null,
  highlightSymbol = null,
  navOrigin = null,
  serviceId = null,
  serviceName = null,
  localServices = null,
} = {}) {
  const allSpaces = spaces() || [];
  const targetSpace = (spaceId ? allSpaces.find(s => s.id === spaceId) : null) || allSpaces.find(s => s.active) || null;
  if (!targetSpace?.id) return null;

  const resolvedSpaceId = targetSpace.id;
  const resolvedOn = on ?? targetSpace.machine ?? null;
  const isWin = !resolvedOn && window()?.platform === "windows";
  const normRoot = normPathStr(root || targetSpace.folder || "");
  const absPath = resolveViewerFilePath(normRoot, path);
  if (!absPath) return null;

  let relPath = normPathStr(path).replace(/^\.\//, "");
  if (normRoot && isSameOrChildPath(absPath, normRoot, isWin)) {
    if (normRoot === "/") {
      relPath = absPath.slice(1) || relPath;
    } else if (absPath.length > normRoot.length) {
      relPath = absPath.slice(normRoot.length + 1);
    }
  } else if (!relPath) {
    relPath = absPath;
  }
  const displayPath = (normRoot && isSameOrChildPath(absPath, normRoot, isWin) && relPath) ? relPath : absPath;
  const resolvedLine = line ? Number(line) : null;

  let resolvedServiceId = serviceId || null;
  let resolvedServiceName = serviceName || null;
  if (!resolvedServiceId && !resolvedServiceName) {
    const svc = resolveServiceForFile(normRoot, relPath, absPath, isWin, localServices);
    resolvedServiceId = svc.serviceId;
    resolvedServiceName = svc.serviceName;
  }

  // Anchor the current space's terminal/agent tab before switching to a file viewer tab.
  syncSpaceAgentTabs();

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
  const spaceTabIds = new Set((targetSpace.tabs || []).map(t => t?.id).filter(Boolean));

  const rawOpenTabs = asPlainObject(shared("cognivisor.openFileTabs"));
  const { tabs: prunedTabs, changed: prunedChanged } = pruneOpenFileTabs(rawOpenTabs, allLiveTabIds, filePaneTabIds);
  const resolvedIcon = resolveFileIcon(absPath, theme());
  const iconPath = resolvedIcon.path;
  const iconColor = resolvedIcon.color;
  const match = findMatchingOpenFileTab(prunedTabs, spaceTabIds, filePaneTabIds, normRoot, absPath, isWin);

  if (match) {
    const nextEntry = applyTabNavMeta({
      ...match.entry,
      tabId: match.tabId,
      spaceId: resolvedSpaceId,
      root: normRoot || match.entry.root || "",
      path: relPath || match.entry.path || "",
      absPath,
      displayPath: displayPath || match.entry.displayPath || relPath || absPath,
      iconPath: iconPath || match.entry.iconPath || "",
      iconColor: iconColor || match.entry.iconColor || "",
      line: resolvedLine,
      navOrigin: navOrigin || null,
      serviceId: resolvedServiceId ?? match.entry.serviceId ?? null,
      serviceName: resolvedServiceName ?? match.entry.serviceName ?? null,
      updatedAt: Date.now(),
    }, {
      column,
      highlightSymbol,
      navSeq: (Number(match.entry?.navSeq) || 0) + 1,
    });
    const nextTabs = {
      ...prunedTabs,
      [match.tabId]: nextEntry,
    };
    setShared("cognivisor.openFileTabs", nextTabs);
    run("tab.select", { id: match.tabId });
    return { reused: true, tabId: match.tabId, absPath };
  }

  const viewerKey = buildFileViewerKey(normRoot, absPath, isWin);
  const pendingKey = `${resolvedSpaceId}::${viewerKey}`;
  const now = Date.now();
  for (const [k, pending] of PENDING_VIEWER_OPENS) {
    if (!pending || (now - pending.ts) > 1500) {
      PENDING_VIEWER_OPENS.delete(k);
    }
  }
  const pendingEntry = PENDING_VIEWER_OPENS.get(pendingKey);
  if (pendingEntry) {
    const unclaimedTab = (targetSpace.tabs || []).find(
      t => t?.id && filePaneTabIds.has(t.id) && !prunedTabs[t.id] && (!ACTIVE_VIEWER_CLAIMS.has(t.id) || ACTIVE_VIEWER_CLAIMS.get(t.id) === pendingEntry.viewerId)
    );
    if (unclaimedTab) {
      if (prunedChanged) {
        setShared("cognivisor.openFileTabs", prunedTabs);
      }
      run("tab.select", { id: unclaimedTab.id });
      return { reused: true, tabId: unclaimedTab.id, absPath };
    }
    if (shouldReuseInFlightPendingViewerOpen(pendingEntry, now)) {
      if (prunedChanged) {
        setShared("cognivisor.openFileTabs", prunedTabs);
      }
      return { reused: true, pending: true, absPath };
    }
  }

  if (prunedChanged) {
    setShared("cognivisor.openFileTabs", prunedTabs);
  }

  const existingTitles = new Set();
  for (const t of targetSpace.tabs || []) {
    if (t?.name) existingTitles.add(t.name);
  }
  const tabTitle = formatFileTabTitle(absPath || relPath, resolvedServiceName, existingTitles);
  const viewerId = `fv-${now.toString(36)}-${(++VIEWER_ID_SEQ).toString(36)}`;
  const colNum = Number(column);
  const resolvedColumn = Number.isFinite(colNum) && colNum >= 1 ? Math.floor(colNum) : null;
  const resolvedHighlight = typeof highlightSymbol === "string" && highlightSymbol ? highlightSymbol : null;

  PENDING_VIEWER_OPENS.set(pendingKey, {
    viewerId,
    spaceId: resolvedSpaceId,
    key: viewerKey,
    line: resolvedLine,
    column: resolvedColumn,
    highlightSymbol: resolvedHighlight,
    ts: now,
  });

  run("tab.new", {
    space: resolvedSpaceId,
    name: tabTitle,
    mod: "files-search",
    props: {
      role: "viewer",
      viewerId,
      tabTitle,
      spaceId: resolvedSpaceId,
      root: normRoot,
      path: relPath,
      absPath,
      displayPath,
      on: resolvedOn ?? null,
      line: resolvedLine,
      column: resolvedColumn,
      highlightSymbol: resolvedHighlight,
      navOrigin: navOrigin || null,
      serviceId: resolvedServiceId,
      serviceName: resolvedServiceName,
    },
  });
  return { reused: false, viewerId, absPath };
}

const BASE_BRANCHES = new Set(["main", "master", "development", "develop", "ci", "HEAD", ""]);
const REPO_CACHE_TTL_MS = 60000;
const WATCH_DEBOUNCE_MS = 750;
const TRANSCRIPT_THROTTLE_MS = 4000;

function findLayoutNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findLayoutNode(child, id);
    if (found) return found;
  }
  return null;
}

function findFilesBlock(node) {
  if (!node || typeof node !== "object") return null;
  if (
    node.content?.mod === "files-search" &&
    !node.content?.props?.overlay &&
    node.content?.props?.role !== "indexer" &&
    node.content?.props?.role !== "viewer"
  ) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findFilesBlock(child);
    if (found) return found;
  }
  return null;
}

function isFilesVisible() {
  const root = layout();
  if (!root || typeof root !== "object") return true;
  const panel = findLayoutNode(root, "panel");
  const body = findLayoutNode(root, "panel-body");
  if (panel && body) {
    return !panel.hidden && body.active === "files";
  }
  const block = findFilesBlock(root);
  return block ? !block.hidden : true;
}

function getSafeAppHome() {
  try {
    return typeof appHome === "function" ? appHome() : "";
  } catch {
    return "";
  }
}

function recordDirtyMarksAndCounts(cwd, isWindows, normCwd, service, entries, marks, dirCounts, serviceCounts, serviceFiles) {
  const touchedList = [];
  const cmpCwd = normCmpStr(cwd, isWindows);
  for (const item of entries) {
    const { relFile, fullPath, mark } = item;
    const cmpFile = normCmpStr(fullPath, isWindows);
    marks[fullPath] = mark;
    marks[cmpFile] = mark;
    touchedList.push({ name: relFile, fullPath, mark });

    if (cmpFile.startsWith(cmpCwd + "/")) {
      const relToWorkspace = fullPath.replace(/\\/g, "/").slice(normCwd.length + 1);
      const segs = relToWorkspace.split("/");
      let accum = "";
      for (let i = 0; i < segs.length - 1; i++) {
        accum = accum ? `${accum}/${segs[i]}` : segs[i];
        const dirFullPath = `${cwd}/${accum}`;
        const cmpDir = normCmpStr(dirFullPath, isWindows);
        dirCounts[dirFullPath] = (dirCounts[dirFullPath] || 0) + 1;
        if (cmpDir !== dirFullPath) dirCounts[cmpDir] = (dirCounts[cmpDir] || 0) + 1;
      }
    }
  }
  serviceCounts[service.id] = entries.length;
  serviceFiles[service.id] = touchedList;
}

function getParentDir(normPath) {
  const parts = String(normPath || "").split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const prefix = normPath.startsWith("/") ? "/" : "";
  return prefix + parts.slice(0, -1).join("/");
}

async function repoAheadCount(root, on, branchHint = "") {
  const flags = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
  let branch = branchHint;
  if (!branch) {
    const br = await exec("git", [...flags, "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, on }).catch(() => null);
    branch = br?.code === 0 ? (br.stdout || "").trim() : "";
  }
  if (BASE_BRANCHES.has(branch)) return 0;
  const refs = await exec(
    "git",
    [...flags, "for-each-ref", "--format=%(refname:short)", "refs/heads/development", "refs/heads/main", "refs/heads/master", "refs/heads/ci"],
    { cwd: root, on }
  ).catch(() => null);
  const avail = new Set((refs?.code === 0 ? refs.stdout : "").split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  for (const base of ["development", "main", "master", "ci"]) {
    if (!avail.has(base)) continue;
    const check = await exec("git", [...flags, "rev-list", "--count", `${base}..HEAD`], { cwd: root, on }).catch(() => null);
    if (check && check.code === 0) {
      const n = parseInt((check.stdout || "").trim(), 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

async function fsScanRepos(targetRoot, depth2 = true) {
  if (!targetRoot) return [];
  let level1;
  try {
    level1 = await readdir(targetRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  if (!isSupportedDirentList(level1)) return null;
  const found = [];
  if (await exists(join(targetRoot, ".git")).catch(() => false)) {
    found.push(targetRoot);
  }
  await Promise.all(
    level1.map(async e1 => {
      if (!direntIsDir(e1) || !e1.name || DISCOVER_SKIP_DIRS.has(e1.name)) return;
      const p1 = join(targetRoot, e1.name);
      if (await exists(join(p1, ".git")).catch(() => false)) {
        found.push(p1);
        return;
      }
      if (!depth2) return;
      const level2 = await readdir(p1, { withFileTypes: true }).catch(() => []);
      if (!isSupportedDirentList(level2)) return;
      await Promise.all(
        level2.map(async e2 => {
          if (!direntIsDir(e2) || !e2.name || DISCOVER_SKIP_DIRS.has(e2.name)) return;
          const p2 = join(p1, e2.name);
          if (await exists(join(p2, ".git")).catch(() => false)) {
            found.push(p2);
          }
        })
      );
    })
  );
  return found;
}

async function findLocalGitRoot(startDir, maxDepth = 6) {
  let cur = normPathStr(startDir);
  for (let i = 0; i < maxDepth && cur; i++) {
    if (await exists(join(cur, ".git")).catch(() => false)) return cur;
    const idx = cur.lastIndexOf("/");
    if (idx <= 0) break;
    const parent = cur.slice(0, idx);
    if (!parent || parent === cur || /^[A-Za-z]:$/.test(parent)) break;
    cur = parent;
  }
  return null;
}

async function discoverRepos(workspaceRoot, on, isWindows = false, extraCwds = []) {
  if (!workspaceRoot) return [];
  const normWorkspace = normPathStr(workspaceRoot);

  const scanRoot = async (targetRoot, depth2 = true) => {
    if (!targetRoot) return [];
    if (!on) {
      const fsResult = await fsScanRepos(targetRoot, depth2);
      if (fsResult !== null) return fsResult;
    }

    const windowsDiscover = async () => {
      const escaped = targetRoot.replace(/['‘’‚‛]/g, "$&$&");
      const depthFlag = depth2 ? "-Depth 2" : "-Depth 1";
      const cmd = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) $dirs = [System.Collections.Generic.List[string]]::new(); if (Test-Path -LiteralPath (Join-Path $p '.git')) { $dirs.Add($p) }; Get-ChildItem -LiteralPath $p -Directory ${depthFlag} -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('.git','node_modules','target','dist','build','vendor','.venv') } | ForEach-Object { if (Test-Path -LiteralPath (Join-Path $_.FullName '.git')) { $dirs.Add($_.FullName) } }; $dirs } '${escaped}'`;
      const r = await exec("powershell", ["-NoProfile", "-Command", cmd], { on }).catch(() => null);
      if (r?.code === 0 && r.stdout) {
        return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
      return [];
    };

    if (isWindows) return windowsDiscover();

    const script = depth2
      ? 'root="$1"; if [ -e "$root/.git" ]; then printf "%s\\n" "$root"; fi; for d in "$root"/* "$root"/*/*; do [ -e "$d/.git" ] || continue; case "$d" in */node_modules/*|*/target/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.venv/*) continue ;; esac; printf "%s\\n" "$d"; done'
      : 'root="$1"; for d in "$root"/*; do [ -e "$d/.git" ] || continue; case "$d" in */node_modules/*|*/target/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.venv/*) continue ;; esac; printf "%s\\n" "$d"; done';
    try {
      const r = await exec("sh", ["-c", script, "repos", targetRoot], { on });
      if (r?.code === 0 && r.stdout) {
        return r.stdout.split("\n").map(s => s.trim()).filter(Boolean);
      }
    } catch (e) {
      if (on && String(e).includes("cannot start sh: program not found")) {
        return windowsDiscover();
      }
    }
    return [];
  };

  let rawRoots = await scanRoot(workspaceRoot, true);

  // Deduplicate discovered roots
  const foundRoots = [...new Set(rawRoots.map(r => normPathStr(r)).filter(Boolean))];

  // If no .git found under workspaceRoot, fall back to git rev-parse --show-toplevel on workspaceRoot
  if (foundRoots.length === 0) {
    const localTop = !on ? await findLocalGitRoot(workspaceRoot) : null;
    if (localTop) {
      foundRoots.push(localTop);
    } else {
      const rev = await exec(
        "git",
        ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "rev-parse", "--show-toplevel"],
        { cwd: workspaceRoot, on }
      ).catch(() => null);
      if (rev?.code === 0 && rev.stdout.trim()) {
        foundRoots.push(normPathStr(rev.stdout.trim()));
      }
    }
  }

  // If workspaceRoot is a single repo (or inside one), also scan immediate sibling repos in parentDir
  const isSingleRepoRoot =
    foundRoots.length === 1 &&
    isSameOrChildPath(normWorkspace, foundRoots[0], isWindows);
  if (isSingleRepoRoot) {
    const parentDir = getParentDir(foundRoots[0]);
    if (parentDir) {
      const siblings = await scanRoot(parentDir, false);
      for (const s of siblings) {
        const normS = normPathStr(s);
        if (normS && !foundRoots.some(r => normCmpStr(r, isWindows) === normCmpStr(normS, isWindows))) {
          foundRoots.push(normS);
        }
      }
    }
  }

  // Also inspect extra pane cwds in the active space
  for (const extra of extraCwds || []) {
    if (!extra) continue;
    const normExtra = normPathStr(extra);
    if (!normExtra || foundRoots.some(r => isSameOrChildPath(normExtra, r, isWindows))) continue;
    const localTop = !on ? await findLocalGitRoot(extra) : null;
    if (localTop) {
      if (!foundRoots.some(r => normCmpStr(r, isWindows) === normCmpStr(localTop, isWindows))) foundRoots.push(localTop);
      continue;
    }
    const rev = await exec(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "rev-parse", "--show-toplevel"],
      { cwd: extra, on }
    ).catch(() => null);
    if (rev?.code === 0 && rev.stdout.trim()) {
      const normTop = normPathStr(rev.stdout.trim());
      if (normTop && !foundRoots.some(r => normCmpStr(r, isWindows) === normCmpStr(normTop, isWindows))) foundRoots.push(normTop);
    }
  }

  const services = [];
  const seenRoots = new Set();
  for (const repoRoot of foundRoots) {
    const normRepo = normPathStr(repoRoot);
    const cmpRepo = normCmpStr(normRepo, isWindows);
    if (seenRoots.has(cmpRepo)) continue;
    seenRoots.add(cmpRepo);

    const isInsideWorkspace = isSameOrChildPath(normRepo, normWorkspace, isWindows);
    let relPath = "";
    if (cmpRepo !== normCmpStr(normWorkspace, isWindows) && isInsideWorkspace) {
      relPath = normRepo.slice(normWorkspace.length + 1);
    }

    const name = repoRoot.split(/[\\/]/).filter(Boolean).pop() || "root";
    const id = relPath || (cmpRepo === normCmpStr(normWorkspace, isWindows) ? "." : (isInsideWorkspace ? name : `../${name}`));
    services.push({
      id,
      name,
      relPath,
      root: repoRoot,
      isSibling: !isInsideWorkspace,
    });
  }

  // Stable sort: root/inside services first, then alphabetically by name
  services.sort((a, b) => {
    if (Boolean(a.isSibling) !== Boolean(b.isSibling)) return a.isSibling ? 1 : -1;
    if (a.relPath === "" && b.relPath !== "") return -1;
    if (b.relPath === "" && a.relPath !== "") return 1;
    return a.name.localeCompare(b.name);
  });

  return services;
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;
const MAX_CACHED_FOLDERS = 400, MAX_CACHED_ENTRIES = 25000;
const FOLDER_PREWARM_LIMIT = 24, FOLDER_PREWARM_CONCURRENCY = 4, FOLDER_RELOAD_CONCURRENCY = 8;
const PREWARM_SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".next", ".gradle"]);

async function directory(path, on, isWindows = false) {
  if (!on) {
    try {
      const dirents = await readdir(path, { withFileTypes: true });
      if (isSupportedDirentList(dirents)) {
        const out = [];
        for (const d of dirents) {
          if (!d?.name || d.name === ".git") continue;
          out.push({ name: d.name, dir: direntIsDir(d) });
          if (out.length > 500) break;
        }
        return out;
      }
    } catch {}
  }
  const windowsDirectory = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (isWindows) return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

async function windowsDirectoryCascade(root, startPath, on, maxDepth = MAX_CASCADE_DEPTH) {
  const targetAbs = joinSubPath(root, startPath);
  const escaped = targetAbs.replace(/['‘’‚‛]/g, "$&$&");
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p, $max) $cur=$p; $rel=''; $levels=@(); for ($d=0; $d -le $max; $d++) { $items=@(Get-ChildItem -LiteralPath $cur -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }); $levels += @{ rel=$rel; entries=$items }; if ($items.Count -ne 1 -or -not $items[0].dir -or $d -ge $max) { break }; $only=$items[0].name; $rel = if ($rel) { "$rel/$only" } else { $only }; $cur = Join-Path $cur $only }; $levels | ConvertTo-Json -Compress -Depth 4 } '${escaped}' ${maxDepth}`;
  const r = await exec("powershell", ["-NoProfile", "-Command", script], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const raw = JSON.parse(r.stdout || "[]");
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Map();
  for (const lvl of list) {
    if (!lvl) continue;
    const fullRel = lvl.rel ? (startPath ? `${startPath}/${lvl.rel}` : lvl.rel) : startPath;
    const rawEntries = Array.isArray(lvl.entries) ? lvl.entries : (lvl.entries ? [lvl.entries] : []);
    out.set(fullRel, rawEntries);
  }
  return out;
}

async function posixDirectoryCascade(root, startPath, on, maxDepth = MAX_CASCADE_DEPTH) {
  const targetAbs = joinSubPath(root, startPath);
  let r;
  try {
    r = await exec("sh", ["-c", POSIX_CASCADE_SCRIPT, "files", targetAbs, String(maxDepth)], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) {
      return windowsDirectoryCascade(root, startPath, on, maxDepth);
    }
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  return parseCascadeStdout(r.stdout, startPath);
}

async function directoryCascade(root, startPath, context, maxDepth = MAX_CASCADE_DEPTH, filterRel = null, isCancelled = null) {
  const { on, isWindows } = context;
  if (isWindows) return windowsDirectoryCascade(root, startPath, on, maxDepth);
  if (on) return posixDirectoryCascade(root, startPath, on, maxDepth);

  const out = new Map();
  const seen = new Set([startPath]);
  let curRel = startPath;

  for (let depth = 0; depth <= maxDepth; depth++) {
    if (isCancelled?.()) return out;
    let dirents;
    let supported = false;
    try {
      dirents = await readdir(joinSubPath(root, curRel), { withFileTypes: true });
      supported = isSupportedDirentList(dirents);
    } catch {
      supported = false;
    }

    if (!supported) {
      const remMax = Math.max(0, maxDepth - depth);
      try {
        const fallback = await posixDirectoryCascade(root, curRel, on, remMax);
        for (const [k, v] of fallback) out.set(k, v);
        return out;
      } catch (err) {
        if (depth === 0) throw err;
        return out;
      }
    }

    const list = [];
    for (const d of dirents) {
      if (!d?.name || d.name === ".git") continue;
      list.push({ name: d.name, dir: direntIsDir(d) });
      if (list.length > PER_FOLDER) break;
    }
    out.set(curRel, list);

    if (depth >= maxDepth) break;
    const nextChild = getCascadeChildPath(curRel, list, filterRel);
    if (!nextChild || seen.has(nextChild)) break;
    seen.add(nextChild);
    curRel = nextChild;
  }

  return out;
}

const CHUNK_SIZE = 120;

// Cross-platform lazy line range reader (Linux, macOS, Windows)
async function readFileChunk(fullPath, startLine, count, on, isWindows = false) {
  // Fast native local read via readTextFile (up to 1 MiB, 0 subprocesses)
  if (!on) {
    try {
      const text = await readTextFile(fullPath, { on }).catch(() => null);
      if (typeof text === "string") {
        if (text.includes("\0")) return "binary";
        const allLines = text.replace(/\r\n/g, "\n").split("\n");
        if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
        return allLines.slice(Math.max(0, startLine - 1), Math.max(0, startLine - 1) + count);
      }
    } catch {}
  }

  if (!on && isWindows) {
    try {
      const escaped = fullPath.replace(/'/g, "''");
      const cmd = startLine <= 1
        ? `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Content -LiteralPath '${escaped}' -TotalCount ${count}`
        : `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Content -LiteralPath '${escaped}' | Select-Object -Skip ${startLine - 1} -First ${count}`;
      const res = await exec("powershell", ["-NoProfile", "-Command", cmd], { on }).catch(() => null);
      if (res && res.code === 0 && typeof res.stdout === "string") {
        if (res.stdout.includes("\0")) return "binary";
        const raw = res.stdout.replace(/\r\n/g, "\n");
        const lines = raw.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        return lines;
      }
    } catch {}
  } else {
    // Linux, macOS, and remote SSH hosts
    try {
      let res;
      if (startLine <= 1) {
        res = await exec("head", ["-n", String(count), fullPath], { on }).catch(() => null);
      } else {
        const endLine = startLine + count - 1;
        res = await exec("sed", ["-n", `${startLine},${endLine}p`, fullPath], { on }).catch(() => null);
      }
      if (res && res.code === 0 && typeof res.stdout === "string") {
        if (res.stdout.includes("\0")) return "binary";
        const lines = res.stdout.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        return lines;
      }
    } catch {}
  }

  // Universal fallback via readTextFile (covers remote Windows or fallback)
  try {
    const text = await readTextFile(fullPath, { on }).catch(() => null);
    if (text === null) return null;
    if (text.includes("\0")) return "binary";
    const allLines = text.replace(/\r\n/g, "\n").split("\n");
    return allLines.slice(Math.max(0, startLine - 1), Math.max(0, startLine - 1) + count);
  } catch {
    return null;
  }
}

const SHOWN = 9;
const ROW_H = 34;
const LIST_H = SHOWN * ROW_H;

export default class FilesSearch extends View {
  init(_props, cx) {
    const roleProps = props() || {};
    this.isOverlay = Boolean(roleProps.overlay);
    this.isIndexer = !this.isOverlay && roleProps.role === "indexer";
    this.isViewer = !this.isOverlay && !this.isIndexer && roleProps.role === "viewer";
    if (this.isOverlay) {
      this.initOverlay(cx);
    } else if (this.isIndexer) {
      this.initIndexer(cx);
    } else if (this.isViewer) {
      this.initViewer(cx);
    } else {
      this.initPanel(cx);
    }
  }

  // ==========================================
  // HEADLESS AGENT-TRIGGERED INDEXER MODE
  // ==========================================
  initIndexer(cx) {
    this._indexerClosed = false;
    this.indexerSyncTask = null;
    this.indexerPrewarmTask = null;
    this.indexerReindexTask = null;
    this.indexerWatchToken = null;
    this.indexerWatchKey = null;
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
            const changed = await watchFolder(root);
            if (this._indexerClosed || !ownsRootWatcher(indexKey, token)) break;
            if (!hasOpenTerminalInSpace()) break;
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
            indexedFilesByRoot: indexedByRoot,
            appHomeDir: getSafeAppHome(),
            skipIfFreshMs: 15000,
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

  renderIndexer(cx) {
    this.scheduleIndexerSync(cx);
    return div().h(0).w(0);
  }

  // ==========================================
  // PANEL MODE (Files tab with Search Icon)
  // ==========================================
  initPanel(cx) {
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
    this.pendingRefreshOpts = null;
    this.pendingPanelSyncTask = null;
    this.focusInputTask = null;
    this.wasVisible = isFilesVisible();
    this.needsFolderReloadOnShow = false;
    this.lastBgPollAt = Date.now();
    this.lastTranscriptScan = { ts: 0, sig: "", text: "" };
    this.panelHandle = cx.focus_handle();
    this.refresh(cx);
    cx.timer.every(30000, cx => {
      const now = Date.now();
      if (!isFilesVisible() && (now - this.lastBgPollAt) < 60000) return;
      this.lastBgPollAt = now;
      this.refresh(cx);
    });
  }

  schedulePanelSync(cx) {
    if (this.pendingPanelSyncTask || !cx?.timer) return;
    this.pendingPanelSyncTask = cx.timer.after(0, cx => {
      this.pendingPanelSyncTask = null;
      this.syncPanelFromRender(cx);
    });
  }

  syncPanelFromRender(cx) {
    let dirty = false;
    syncSpaceAgentTabs();
    if (
      key() !== this.context?.key ||
      (isFilesVisible() && (!this.entries.has("") || Boolean(this.error) || this.needsFolderReloadOnShow || this.dirtyFolders.size > 0))
    ) {
      this.refresh(cx, { fromWatch: this.dirtyFolders.size > 0 && key() === this.context?.key && this.entries.has("") && !this.error && !this.needsFolderReloadOnShow });
      dirty = true;
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
          dirty = true;
          if (nextFilter !== "all") {
            const s = this.services?.find(x => x.id === nextFilter);
            if (s?.relPath) {
              const parts = s.relPath.split("/");
              let accum = "";
              for (const p of parts) {
                accum = accum ? `${accum}/${p}` : p;
                this.folders.add(accum);
                this.loadSingleFolderPending(accum, cx);
              }
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
            }
          }
        }
        this.openFromSearch(filePath, cx, selectReq.kind || "reveal");
        return;
      }
    }

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

    if (dirty) cx.notify();
  }

  selectService(serviceId, cx) {
    this.serviceFilter = (this.serviceFilter === serviceId ? "all" : serviceId);
    if (this.serviceFilter !== "all") {
      const s = this.services?.find(x => x.id === this.serviceFilter);
      if (s?.relPath) {
        const parts = s.relPath.split("/");
        let accum = "";
        for (const p of parts) {
          accum = accum ? `${accum}/${p}` : p;
          this.folders.add(accum);
          this.loadSingleFolderPending(accum, cx);
        }
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
    this.lastActiveServiceTs = Date.now();
    setShared("cognivisor.activeService", {
      workspaceRoot: this.root,
      serviceId: "all",
      ts: this.lastActiveServiceTs,
    });
    cx.notify();
  }

  scheduleWatchRefresh(cx) {
    if (this.watchDebounceTask) {
      try { this.watchDebounceTask.cancel(); } catch {}
      this.watchDebounceTask = null;
    }
    const context = this.context;
    this.watchDebounceTask = cx.timer.after(WATCH_DEBOUNCE_MS, cx => {
      this.watchDebounceTask = null;
      if (!this.current(context)) return;
      this.refresh(cx, { fromWatch: true });
    });
  }

  scheduleWatchReindex(cx, delayMs = INDEX_REBUILD_DEBOUNCE_MS) {
    if (this.watchReindexTask) {
      try { this.watchReindexTask.cancel(); } catch {}
      this.watchReindexTask = null;
    }
    const context = this.context;
    this.watchReindexTask = cx.timer.after(delayMs, cx => {
      this.watchReindexTask = null;
      if (!this.current(context) || !hasOpenTerminalInSpace()) return;
      const { cwd, on, isWindows } = context;
      if (!cwd) return;
      cx.spawn(async cx => {
        try {
          if (!getCachedIndex(makeIndexKey(cwd, on, isWindows))) {
            await restoreDiskIndex(cwd, on, isWindows, cx);
          }
          if (!this.current(context) || !hasOpenTerminalInSpace()) return;
          const cached = getCachedIndex(makeIndexKey(cwd, on, isWindows));
          if (shouldRefreshIndex(cached, on)) {
            await ensureWorkspaceIndex({ root: cwd, on, isWindows, discoverRepos, cx });
          }
        } catch {}
      });
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    const isWindows = Boolean(context?.isWindows);
    const indexKey = makeIndexKey(root, this.on, isWindows);
    if (this.panelWatchKey && this.panelWatchToken) {
      releaseRootWatcher(this.panelWatchKey, this.panelWatchToken);
      setIndexWatching(this.panelWatchKey, hasActiveRootWatcher(this.panelWatchKey));
    }
    const token = `panel-${++this.panelWatchSeq}`;
    this.panelWatchKey = indexKey;
    this.panelWatchToken = token;
    claimRootWatcher(indexKey, token, true);
    setIndexWatching(indexKey, true);

    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          try {
            const changed = await watchFolder(root);
            if (!this.current(context)) break;
            const info = analyzeWatchBatch(changed, root, this.folders);
            if (!info.hasNonIgnored) continue;
            invalidateIndexedFiles(root, changed, null);
            if (info.invalidateRepos) this.candidateCache = null;
            if (info.dirtyDirs.has("*")) {
              this.dirtyFolders.add("*");
            } else {
              for (const d of info.dirtyDirs) this.dirtyFolders.add(d);
              if (info.hasNonGitChange && info.dirtyDirs.has("")) this.dirtyFolders.add("");
            }
            this.scheduleWatchRefresh(cx);
            const indexDirty = await handleWatchForIndex(root, null, isWindows, info, changed);
            if (indexDirty && this.current(context) && hasOpenTerminalInSpace()) {
              this.scheduleWatchReindex(cx);
            }
          } catch {
            if (!this.current(context)) break;
            await cx.sleep(3000);
          }
        }
      } finally {
        if (this.watched === root && !this.current(context)) {
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
    return this.context === context && key() === context.key;
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
  }

  pruneEntryCache(protectedPath = null) {
    for (const [k, list] of this.entries) {
      if (this.entries.size <= MAX_CACHED_FOLDERS && this.cachedEntryCount <= MAX_CACHED_ENTRIES) break;
      if (!k || k === protectedPath || this.folders.has(k) || this.pending.has(k)) continue;
      this.entries.delete(k);
      this.truncatedFolders.delete(k);
      this.cachedEntryCount -= list.length;
    }
  }

  evictCollapsedEntries() {
    for (const [k, list] of [...this.entries]) {
      if (!k || this.folders.has(k) || this.pending.has(k)) continue;
      this.entries.delete(k);
      this.truncatedFolders.delete(k);
      this.cachedEntryCount -= list.length;
    }
  }

  evictDirtyCollapsedEntries(dirtyDirs) {
    if (!dirtyDirs?.size) return;
    for (const dir of dirtyDirs) {
      if (!dir || this.folders.has(dir) || this.pending.has(dir)) continue;
      const prev = this.entries.get(dir);
      if (!prev) continue;
      this.entries.delete(dir);
      this.truncatedFolders.delete(dir);
      this.cachedEntryCount -= prev.length;
    }
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

  schedulePrewarm(cx, context = this.context) {
    if (!cx?.timer || !cx?.spawn || !context || !this.current(context)) return;
    if (context.on || !isFilesVisible()) return;
    this.prewarmTask?.cancel();
    const token = ++this.prewarmSeq;
    this.prewarmTask = cx.timer.after(40, cx => {
      this.prewarmTask = null;
      if (token !== this.prewarmSeq || !this.current(context) || !isFilesVisible()) return;
      const filterRel = this.activeServiceRelPath();
      const targets = this.collectPrewarmTargets(filterRel);
      if (!targets.length) return;
      const isCancelled = () => token !== this.prewarmSeq || !this.current(context) || !isFilesVisible();
      cx.spawn(async () => {
        await runInBatches(targets, FOLDER_PREWARM_CONCURRENCY, async targetPath => {
          if (isCancelled() || this.entries.has(targetPath)) return;
          try {
            const batch = await directoryCascade(
              context.cwd,
              targetPath,
              context,
              Math.min(MAX_CASCADE_DEPTH, 12),
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
        });
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
    syncSpaceAgentTabs();
    const loc = location();
    const { cwd, on } = loc, next = JSON.stringify(loc);
    const isWindows = !on && window()?.platform === "windows";
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, selectedFile: this.selectedFile, serviceFilter: this.serviceFilter });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, isWindows };
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
      this.watched = null;
      this.error = null;
      this.limited = false;
      this.loading = false;
      this.candidateCache = null;
      this.dirtyFolders = new Set();
      this.pendingRefreshOpts = null;
      this.needsFolderReloadOnShow = false;
      this.lastTranscriptScan = { ts: 0, sig: "", text: "" };
      if (this.watchDebounceTask) {
        try { this.watchDebounceTask.cancel(); } catch {}
        this.watchDebounceTask = null;
      }
      if (this.watchReindexTask) {
        try { this.watchReindexTask.cancel(); } catch {}
        this.watchReindexTask = null;
      }
      if (this.panelWatchKey && this.panelWatchToken) {
        releaseRootWatcher(this.panelWatchKey, this.panelWatchToken);
        setIndexWatching(this.panelWatchKey, hasActiveRootWatcher(this.panelWatchKey));
        this.panelWatchKey = null;
        this.panelWatchToken = null;
      }
    } else if (this.context) {
      this.context.isWindows = isWindows;
    }
    if (!cwd) return;
    if (this.loading) {
      this.pendingRefreshOpts = {
        fromWatch: Boolean(opts?.fromWatch && !this.pendingRefreshOpts?.force && this.pendingRefreshOpts?.fromWatch !== false),
        force: Boolean(opts?.force || this.pendingRefreshOpts?.force),
      };
      return;
    }
    const context = this.context;
    const fromWatch = Boolean(opts?.fromWatch);
    const force = Boolean(opts?.force);
    const watchDirty = new Set(this.dirtyFolders);
    this.dirtyFolders.clear();
    this.loading = true;
    this.limited = false;
    const activeSpace = spaces().find(s => s.active);
    const activeTab = (activeSpace?.tabs || []).find(t => t.active) || null;
    const activeTabId = loc.tabId || activeTab?.id || null;
    const allPanesList = panes() || [];
    const extraCwds = activeTabId
      ? Array.from(new Set(allPanesList.filter(p => p?.cwd && p.tab === activeTabId).map(p => p.cwd)))
      : [];
    const tabPaneCwds = activeTabId
      ? Array.from(new Set(allPanesList.filter(p => p.tab === activeTabId && p.cwd).map(p => p.cwd)))
      : [];
    const tabFlowObj = activeTabId && shared("cognivisor.flows")?.[activeTabId];
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
        if (!visibleNow && this.entries.has("") && !this.error) {
          this.needsFolderReloadOnShow = true;
        } else {
          const forceReloadFolders = this.needsFolderReloadOnShow;
          this.needsFolderReloadOnShow = false;
          const shouldReloadAll = !fromWatch || !this.entries.has("") || Boolean(this.error) || watchDirty.has("*") || forceReloadFolders;
          if (shouldReloadAll) {
            this.prewarmTask?.cancel();
            this.prewarmTask = null;
            this.prewarmSeq = (this.prewarmSeq || 0) + 1;
            this.evictCollapsedEntries();
          } else {
            this.evictDirtyCollapsedEntries(watchDirty);
          }
          const foldersToLoad = shouldReloadAll
            ? ["", ...this.folders]
            : [...new Set(["", ...this.folders].filter(f => watchDirty.has(f)))];
          await runInBatches(foldersToLoad, FOLDER_RELOAD_CONCURRENCY, async path => {
            if (!this.current(context)) return;
            await this.loadFolder(path, context);
          });
          if (this.current(context)) this.schedulePrewarm(cx, context);
          if (!this.current(context)) return;
          this.error = null;
          if (foldersToLoad.length > 0) cx.notify();
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

        const statusPromises = candidateServices.map(async s => {
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
        });

        const statusResults = await Promise.all(statusPromises);
        if (!this.current(context)) return;

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
          const primaryStatus = statusResults.find(r => normPathStr(r.service.root) === normCwd)
            || statusResults.find(r => r.branch)
            || null;
          const primaryBranch = primaryStatus?.branch || "";

          const freshFlowObj = asPlainObject(shared("cognivisor.flows"))[activeTabId];
          let sessionBaseline = normalizeSessionBaseline(freshFlowObj?.sessionBaseline);
          if (sessionBaseline && sessionBaseline.workspaceRoot && normCwd && sessionBaseline.workspaceRoot !== normCwd) {
            sessionBaseline = null;
          }
          let isFreshBaseline = false;
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
            sessionBaseline = {
              version: 1,
              startedAt: Date.now(),
              workspaceRoot: normCwd,
              repos: {},
            };
            isFreshBaseline = true;
            baselineDirtyChanged = true;
          }

          const sinceSec = Math.floor(sessionBaseline.startedAt / 1000);
          const repoEvaluations = await Promise.all(
            statusResults.map(async ({ service, branch, fileEntries, ahead }) => {
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

              const [parsedEntries, logRes] = await Promise.all([
                Promise.all(
                  parsedRaw.map(async item => {
                    const { sig, mtimeMs } = await statFileEntry(item.fullPath, item.status, on);
                    return { ...item, sig, mtimeMs };
                  })
                ),
                isFreshBaseline
                  ? Promise.resolve(null)
                  : exec(
                      "git",
                      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "log", "-n", "1", `--since=${sinceSec}`, "--format=%ct"],
                      { cwd: service.root, on }
                    ).catch(() => null),
              ]);

              const sessionCommitCount = !isFreshBaseline && logRes?.code === 0 && Boolean((logRes.stdout || "").trim()) ? 1 : 0;
              return { service, branch, ahead, parsedEntries, sessionCommitCount };
            })
          );
          if (!this.current(context)) return;

          for (const { service, branch, ahead, parsedEntries, sessionCommitCount } of repoEvaluations) {
            const normRoot = normPathStr(service.root);
            const sigMap = new Map();
            for (const item of parsedEntries) sigMap.set(item.relFile, item.sig);

            const existingBaselineRepo = sessionBaseline.repos[normRoot] || null;
            let sessionWorkingFiles = [];

            if (isFreshBaseline) {
              const dirtyFiles = {};
              for (const item of parsedEntries) {
                dirtyFiles[item.relFile] = { status: item.status, sig: item.sig };
              }
              sessionBaseline.repos[normRoot] = { dirtyFiles };
              baselineDirtyChanged = true;
              sessionWorkingFiles = [];
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

          const sessionRepos = enrichedServices.map(s => normPathStr(s.root)).filter(Boolean);
          const latestFlows = asPlainObject(shared("cognivisor.flows"));
          const curFlow = asPlainObject(latestFlows[activeTabId]);
          const prevRepos = Array.isArray(curFlow.sessionRepos) ? curFlow.sessionRepos.map(r => normPathStr(r)) : [];
          const reposChanged = prevRepos.length !== sessionRepos.length || prevRepos.some((r, idx) => r !== sessionRepos[idx]);

          if (baselineDirtyChanged || reposChanged || !curFlow.sessionBaseline || curFlow.sessionStartedAt !== sessionBaseline.startedAt) {
            setShared("cognivisor.flows", {
              ...latestFlows,
              [activeTabId]: {
                ...curFlow,
                sessionBaseline,
                sessionStartedAt: sessionBaseline.startedAt,
                sessionRepos,
                updatedAt: Date.now(),
              },
            });
          }
          if (appHomeDir && (baselineDirtyChanged || reposChanged)) {
            await writeDiskSessionBaseline(appHomeDir, activeTabId, cwd, primaryBranch, sessionBaseline);
            if (!this.current(context)) return;
          }
        } else {
          for (const { service, branch, ahead } of statusResults) {
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
        this.watch(cwd, cx);
        if (hasOpenTerminalInSpace()) {
          const indexKey = makeIndexKey(cwd, on, isWindows);
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
        if (this.context === context && this.pendingRefreshOpts) {
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
    return true;
  }

  clearFolderPending(path, token, context) {
    if (this.context !== context) return;
    if (this.pendingTokens.get(path) === token) {
      this.pending.delete(path);
      this.pendingTokens.delete(path);
    }
  }

  loadSingleFolderPending(path, cx) {
    if (this.entries.has(path) || this.pending.has(path)) return;
    const context = this.context;
    const token = ++this.pendingSeq;
    this.acquireFolderPending(path, token);
    cx.spawn(async cx => {
      try {
        await this.loadFolder(path, context);
      } catch {
      } finally {
        this.clearFolderPending(path, token, context);
        cx.notify();
      }
    });
  }

  collapseFolderSubtree(path) {
    for (const folder of collectSubtreePaths(this.folders, path)) {
      this.folders.delete(folder);
    }
    for (const pendingPath of collectSubtreePaths(this.pending, path)) {
      this.pending.delete(pendingPath);
    }
    for (const tokenPath of collectSubtreePaths(this.pendingTokens.keys(), path)) {
      this.pendingTokens.delete(tokenPath);
    }
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
  }

  toggle(path, cx) {
    if (this.pending.has(path)) {
      this.pending.delete(path);
      this.pendingTokens.delete(path);
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
    const visibleNow = isFilesVisible();
    const isWin = Boolean(this.context?.isWindows);

    if (kind === "dir") {
      const segments = path.split("/").filter(Boolean);
      let accum = "";
      for (let i = 0; i < segments.length; i++) {
        accum = accum ? `${accum}/${segments[i]}` : segments[i];
        this.folders.add(accum);
        if (visibleNow) {
          this.loadSingleFolderPending(accum, cx);
        } else {
          this.needsFolderReloadOnShow = true;
        }
      }
      this.pendingScrollPath = path;
      this.selectedFile = null;
      if (visibleNow) this.schedulePrewarm(cx, this.context);
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
      const segments = relPath.split("/").filter(Boolean);
      const expandLimit = Math.max(0, segments.length - 1);
      let accum = "";
      for (let i = 0; i < expandLimit; i++) {
        accum = accum ? `${accum}/${segments[i]}` : segments[i];
        this.folders.add(accum);
        if (visibleNow) {
          this.loadSingleFolderPending(accum, cx);
        } else {
          this.needsFolderReloadOnShow = true;
        }
      }
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
    const selectedService = (this.serviceFilter && this.serviceFilter !== "all")
      ? this.services?.find(s => s.id === this.serviceFilter)
      : null;
    const out = [];
    const byKey = new Map();

    if (selectedService?.isSibling) {
      const siblingFiles = this.serviceFiles?.[selectedService.id] ?? [];
      const capped = siblingFiles.slice(0, TOTAL);
      for (const sf of capped) {
        const key = `sibling:${sf.fullPath}`;
        const row = {
          key,
          kind: "sibling",
          fullPath: sf.fullPath,
          path: sf.fullPath,
          name: sf.name,
          mark: sf.mark,
        };
        out.push(row);
        byKey.set(key, row);
      }
      return { rows: out, hitVisibleCap: siblingFiles.length > TOTAL, byKey };
    }

    const state = {
      filterRel: selectedService?.relPath || null,
      isWin: Boolean(this.context?.isWindows),
      hitVisibleCap: false,
    };
    this.appendTreeRows("", 0, out, byKey, state);
    return { rows: out, hitVisibleCap: state.hitVisibleCap, byKey };
  }

  appendTreeRows(prefix, depth, out, byKey, state) {
    if (out.length >= TOTAL) {
      state.hitVisibleCap = true;
      return;
    }
    if (depth > 40) return;

    const list = this.entries.get(prefix);
    if (!list?.length) return;

    const { filterRel, isWin } = state;
    const hasRepos = Boolean(this.repoRoots?.size);
    const hasDirCounts = Boolean(this.dirCounts);
    const hasMarks = Boolean(this.marks);

    for (const entry of list) {
      if (out.length >= TOTAL) {
        state.hitVisibleCap = true;
        return;
      }
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (filterRel && !matchesServiceFilter(path, filterRel)) continue;

      const open = Boolean(entry.dir && this.folders.has(path));
      const isLoadingFolder = Boolean(entry.dir && this.pending.has(path));

      let isRepo = false;
      let dirCount = 0;
      let mark = null;
      if ((entry.dir && (hasRepos || hasDirCounts)) || (!entry.dir && hasMarks)) {
        const fullPath = joinSubPath(this.root, path);
        const normFullPath = normPathStr(fullPath);
        const cmpFullPath = normCmpStr(fullPath, isWin);
        if (entry.dir) {
          if (hasRepos) {
            isRepo = Boolean(this.repoRoots.has(fullPath) || this.repoRoots.has(normFullPath) || this.repoRoots.has(cmpFullPath));
          }
          if (hasDirCounts) {
            dirCount = this.dirCounts[fullPath] || this.dirCounts[normFullPath] || this.dirCounts[cmpFullPath] || 0;
          }
        } else if (hasMarks) {
          mark = this.marks[fullPath] || this.marks[normFullPath] || this.marks[cmpFullPath] || null;
        }
      }

      const row = {
        key: path,
        kind: entry.dir ? "dir" : "file",
        path,
        depth,
        entry,
        open,
        isLoadingFolder,
        isRepo,
        dirCount,
        mark,
      };
      out.push(row);
      byKey.set(path, row);

      if (open) this.appendTreeRows(path, depth + 1, out, byKey, state);
    }
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

  renderPanel(cx) {
    const visible = isFilesVisible();
    const becameVisible = visible && !this.wasVisible;
    this.wasVisible = visible;

    const activeReq = shared("cognivisor.activeService");
    const hasActiveReq = Boolean(activeReq && activeReq.ts && activeReq.ts > (this.lastActiveServiceTs || 0));
    const selectReq = shared("files-search.select");
    const hasSelectReq = Boolean(selectReq && selectReq.ts && selectReq.ts > (this.lastSelectedTs || 0));

    const activeSpace = (spaces() || []).find(s => s.active) || null;
    const activeTab = (activeSpace?.tabs || []).find(t => t.active) || null;
    const activeTabHasTerminal = Boolean(
      activeTab?.id && (panes() || []).some(p => p.tab === activeTab.id && Boolean(p.terminal))
    );
    const needsAgentAnchorSync = Boolean(
      activeSpace?.id && activeTab?.id && activeTabHasTerminal &&
      asPlainObject(shared("cognivisor.spaceAgentTabs"))[activeSpace.id] !== activeTab.id
    );
    const openFileTabs = asPlainObject(shared("cognivisor.openFileTabs"));
    const activeViewerEntry = activeTab?.id ? openFileTabs[activeTab.id] : null;
    const needsViewerSelectionSync = Boolean(
      (activeViewerEntry && activeViewerEntry.tabId !== this.lastSyncedViewerTabId) ||
      (!activeViewerEntry && this.lastSyncedViewerTabId)
    );

    if (
      key() !== this.context?.key ||
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

  // ==========================================
  // OVERLAY MODE (IntelliJ-style Search Everywhere)
  // ==========================================
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

  close(cx) {
    this._overlayClosed = true;
    this._indexerClosed = true;
    this.focusInputTask?.cancel();
    this.focusInputTask = null;
    this.watchDebounceTask?.cancel();
    this.watchDebounceTask = null;
    this.watchReindexTask?.cancel();
    this.watchReindexTask = null;
    this.agentPrewarmTask?.cancel();
    this.agentPrewarmTask = null;
    this.pendingPanelSyncTask?.cancel();
    this.pendingPanelSyncTask = null;
    this.prewarmTask?.cancel();
    this.prewarmTask = null;
    this.indexerSyncTask?.cancel();
    this.indexerSyncTask = null;
    this.indexerPrewarmTask?.cancel();
    this.indexerPrewarmTask = null;
    this.indexerReindexTask?.cancel();
    this.indexerReindexTask = null;
    this.fileSearchTask?.cancel();
    this.fileSearchTask = null;
    this.textSearchTask?.cancel();
    this.textSearchTask = null;
    this.previewDebounceTask?.cancel();
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
    previewWrapCache.clear();
    try { this.previewNavDropdownScroll?.release(); } catch {}
    this.previewNavDropdownScroll = null;
    if (this.indexerWatchKey && this.indexerWatchToken) {
      this.stopIndexerWatching();
    }
    if (this.panelWatchKey && this.panelWatchToken) {
      releaseRootWatcher(this.panelWatchKey, this.panelWatchToken);
      setIndexWatching(this.panelWatchKey, hasActiveRootWatcher(this.panelWatchKey));
      this.panelWatchKey = null;
      this.panelWatchToken = null;
    }
    this.pending?.clear();
    this.pendingTokens?.clear();
    this.entries?.clear();
    this.dirtyFolders?.clear();
    this.folders?.clear();
    this.expanded?.clear();
    this.context = null;
    this.visibleRowByKey = null;
    this.resetPreviewMarkdownState({ clearCache: true });
    this.previewMarkdownCache = null;
    try { this.treeScrollHandle?.release(); } catch {}
    this.treeScrollHandle = null;
    try { this.input?.release(); } catch {}
    this.input = null;
    this.closeViewer();
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
      setShared("files-search.select", {
        root: this.searchRoot,
        path: item.path,
        kind: "dir",
        line: null,
        ts: Date.now(),
      });
      if (!isFilesVisible()) {
        run("layout.select", { stack: "panel-body", child: "files" });
        run("layout.show", { id: "panel" });
      }
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
            const sorted = (rawEntries || [])
              .slice()
              .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
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
    if (!this.isOverlay || this._overlayClosed || !this.input) {
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

  // ==========================================
  // FILE VIEWER TAB MODE (IDE Non-Terminal Tab)
  // ==========================================
  initViewer(cx) {
    const p = asPlainObject(props());
    this._viewerClosed = false;
    this.viewerId = typeof p.viewerId === "string" && p.viewerId
      ? p.viewerId
      : `fv-inst-${Date.now().toString(36)}-${(++VIEWER_ID_SEQ).toString(36)}`;
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
    spawnCx.spawn(async () => {
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

  render(cx) {
    if (this.isOverlay) {
      return this.renderOverlay(cx);
    }
    if (this.isIndexer) {
      return this.renderIndexer(cx);
    }
    if (this.isViewer) {
      return this.renderViewer(cx);
    }
    return this.renderPanel(cx);
  }
}
