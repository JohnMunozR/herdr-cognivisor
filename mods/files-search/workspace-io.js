// Shared workspace, host, repository discovery, and cross-platform directory I/O utilities for files-search.
import * as fsPromises from "fs/promises";
const { readdir, exists } = fsPromises;
import { join } from "path";
import {
  spaces, panes, focused, exec, appHome, readTextFile,
  theme, window, layout, shared, setShared, run,
} from "herdr";
import {
  DISCOVER_SKIP_DIRS,
  normPathStr,
  normCmpStr,
  isSameOrChildPath,
  joinSubPath,
  isSupportedDirentList,
  direntIsDir,
  runInBatches,
  makeIndexKey,
  getCachedIndex,
} from "./indexer.js";
import {
  resolveFileIcon,
  expandCodeTabs,
  resolveViewerFilePath,
  buildFileViewerKey,
  formatFileTabTitle,
  pruneOpenFileTabs,
  findMatchingOpenFileTab,
  shouldReuseInFlightPendingViewerOpen,
  MAX_PREVIEW_RENDER_LINE_CHARS,
  applyTabNavMeta,
} from "./search-logic.js";
import {
  tokenizeInteractiveCodeLine,
  cloneSyntaxState,
  getSyntaxStateTag,
} from "./code-syntax.js";
import { wrapStyledSpans } from "./code-wrap.js";
import {
  MAX_CASCADE_DEPTH,
  POSIX_LIST_SCRIPT,
  POSIX_CASCADE_SCRIPT,
  computeWorkspaceContextKey,
  getCascadeChildPath,
  parseCascadeStdout,
} from "./tree-logic.js";
import {
  createFileSigCache,
  resolveWorkspaceRoot,
} from "./session-baseline.js";

export function asPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

export function shallowEqualStringMap(a, b) {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export const ACTIVE_VIEWER_CLAIMS = new Map();
export const PENDING_VIEWER_OPENS = new Map();
let VIEWER_ID_SEQ = 0;

export function nextViewerId(prefix = "fv", now = Date.now()) {
  return `${prefix}-${now.toString(36)}-${(++VIEWER_ID_SEQ).toString(36)}`;
}

export function countTextLinesFast(text) {
  if (typeof text !== "string" || text.length === 0) return 1;
  let count = 1;
  let idx = text.indexOf("\n");
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf("\n", idx + 1);
  }
  return count;
}

export function extractLineAtFast(text, lineNum) {
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
export const previewWrapCache = new Map();

export function clearPreviewWrapCache() {
  previewWrapCache.clear();
}

export function getCachedPreviewRows(text, ext, maxCols, mdState = null) {
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

export function syncSpaceAgentTabs() {
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

export function location() {
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

export function workspaceContextKey(loc = location()) {
  return computeWorkspaceContextKey(loc);
}

export function resolveServiceForFile(root, relOrPath, absPath, isWin = false, localServices = null) {
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

export function collectRegisteredServices(localServices = null) {
  const bus = asPlainObject(shared("cognivisor.services"));
  const merged = [];
  const seen = new Set();
  const addList = list => {
    for (const s of list || []) {
      if (!s || !s.root) continue;
      const k = `${s.root}::${s.id || s.name || ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(s);
    }
  };
  addList(localServices);
  addList(bus.services);
  addList(bus.candidates);
  return merged;
}

const INDEXED_FILES_SET_CACHE = new WeakMap();

export function collectIndexedFilesByRoot(services, fallbackRoot = "", fallbackOn = null) {
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

export function hasMatchingOpenTabInSpace(spaceId, root, absPath, isWin, excludeTabId = null) {
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

export function openFileInTab({
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
  const viewerId = nextViewerId("fv", now);
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

export const BASE_BRANCHES = new Set(["main", "master", "development", "develop", "ci", "HEAD", ""]);
export const REPO_CACHE_TTL_MS = 60000;
export const WATCH_DEBOUNCE_MS = 750;
export const TRANSCRIPT_THROTTLE_MS = 4000;

export const PER_FOLDER = 500;
export const TOTAL = 5000;
export const MAX_CACHED_FOLDERS = 400;
export const MAX_CACHED_ENTRIES = 25000;
export const FOLDER_PREWARM_LIMIT = 16;
export const FOLDER_PREWARM_CONCURRENCY = 2;
export const FOLDER_RELOAD_CONCURRENCY = 8;
export const PREWARM_SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt", ".gradle",
  ".venv", "venv", "vendor", "__pycache__", ".cache", "coverage", ".pnpm-store", ".turbo", "out",
]);

const REPO_SCAN_SKIP_EXTRA = new Set([
  ".vscode", ".github", ".idea", ".claude", ".gemini", ".cursor", ".agent", ".agents",
  ".codex", ".opencode", ".husky", ".devcontainer", ".gradle", ".pnpm-store", ".turbo",
]);

export const CHUNK_SIZE = 120;
export const SHOWN = 9;
export const ROW_H = 34;
export const LIST_H = SHOWN * ROW_H;

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

export function isFilesVisible() {
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

export function getSafeAppHome() {
  try {
    return typeof appHome === "function" ? appHome() : "";
  } catch {
    return "";
  }
}

export function recordDirtyMarksAndCounts(cwd, isWindows, normCwd, service, entries, marks, dirCounts, serviceCounts, serviceFiles) {
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

export async function repoAheadCount(root, on, branchHint = "") {
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

async function safeExists(p) {
  try {
    return Boolean(await exists(p));
  } catch {
    return false;
  }
}

async function safeReaddir(p, opts) {
  try {
    return await readdir(p, opts);
  } catch {
    return null;
  }
}

export const SESSION_BASELINE_CACHE = new Map();
const MAX_BASELINE_CACHE_ENTRIES = 32;
export const FILE_SIG_CACHE = createFileSigCache(4000);

export function cacheSessionBaseline(tabId, baseline) {
  if (!tabId || !baseline) return;
  if (SESSION_BASELINE_CACHE.size >= MAX_BASELINE_CACHE_ENTRIES && !SESSION_BASELINE_CACHE.has(tabId)) {
    const oldest = SESSION_BASELINE_CACHE.keys().next().value;
    if (oldest !== undefined) SESSION_BASELINE_CACHE.delete(oldest);
  }
  SESSION_BASELINE_CACHE.set(tabId, baseline);
}

export function safeReadFlows() {
  try {
    return asPlainObject(shared("cognivisor.flows"));
  } catch {
    return {};
  }
}

async function fsScanRepos(targetRoot, depth2 = true) {
  if (!targetRoot) return [];
  const level1 = await safeReaddir(targetRoot, { withFileTypes: true });
  if (!level1 || !isSupportedDirentList(level1)) return null;
  const found = [];
  if (await safeExists(join(targetRoot, ".git"))) {
    found.push(targetRoot);
  }
  const level1Dirs = [];
  for (const e1 of level1) {
    if (!direntIsDir(e1) || !e1.name || DISCOVER_SKIP_DIRS.has(e1.name) || REPO_SCAN_SKIP_EXTRA.has(e1.name)) continue;
    level1Dirs.push(e1);
  }

  await runInBatches(level1Dirs, 8, async e1 => {
    const p1 = join(targetRoot, e1.name);
    if (await safeExists(join(p1, ".git"))) {
      found.push(p1);
      return;
    }
    if (!depth2) return;
    const level2 = await safeReaddir(p1, { withFileTypes: true });
    if (!level2 || !isSupportedDirentList(level2)) return;
    const level2Dirs = [];
    for (const e2 of level2) {
      if (!direntIsDir(e2) || !e2.name || DISCOVER_SKIP_DIRS.has(e2.name) || REPO_SCAN_SKIP_EXTRA.has(e2.name)) continue;
      level2Dirs.push(e2);
    }
    await runInBatches(level2Dirs, 8, async e2 => {
      const p2 = join(p1, e2.name);
      if (await safeExists(join(p2, ".git"))) {
        found.push(p2);
      }
    });
  });
  return found;
}

async function findLocalGitRoot(startDir, maxDepth = 6) {
  let cur = normPathStr(startDir);
  for (let i = 0; i < maxDepth && cur; i++) {
    if (await safeExists(join(cur, ".git"))) return cur;
    const idx = cur.lastIndexOf("/");
    if (idx <= 0) break;
    const parent = cur.slice(0, idx);
    if (!parent || parent === cur || /^[A-Za-z]:$/.test(parent)) break;
    cur = parent;
  }
  return null;
}

export async function discoverRepos(workspaceRoot, on, isWindows = false, extraCwds = []) {
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

export async function directory(path, on, isWindows = false) {
  if (!on) {
    try {
      const dirents = await readdir(path, { withFileTypes: true });
      if (isSupportedDirentList(dirents)) {
        const out = [];
        for (const d of dirents) {
          if (!d?.name || d.name === ".git") continue;
          out.push({ name: d.name, dir: direntIsDir(d) });
          if (out.length > PER_FOLDER) break;
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
  let r;
  try { r = await exec("sh", ["-c", POSIX_LIST_SCRIPT, "files", path], { on }); }
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

export async function directoryCascade(root, startPath, context, maxDepth = MAX_CASCADE_DEPTH, filterRel = null, isCancelled = null) {
  const { on, isWindows } = context;
  if (on) return posixDirectoryCascade(root, startPath, on, maxDepth);

  // Try native async fs/promises readdir first on ALL local platforms (Linux, macOS, Windows)
  // before falling back to POSIX sh or Windows PowerShell.
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
        const fallback = isWindows
          ? await windowsDirectoryCascade(root, curRel, on, remMax)
          : await posixDirectoryCascade(root, curRel, on, remMax);
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

// Cross-platform lazy line range reader (Linux, macOS, Windows)
export async function readFileChunk(fullPath, startLine, count, on, isWindows = false) {
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
