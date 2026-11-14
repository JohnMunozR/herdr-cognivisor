import { View, div, svg, PathBuilder, Background } from "gpui-kit";
import {
  v_flex,
  h_flex,
  v_resizable,
  resizable_panel,
  v_virtual_list,
  VirtualListScrollHandle,
  Scrollbar,
  ScrollHandle,
  InputState,
  Input,
} from "gpui-base";
import { readdir, exists } from "fs/promises";
import { join } from "path";
import {
  spaces,
  panes,
  focused,
  exec,
  watchFolder,
  theme,
  settings,
  run,
  layout,
  props,
  shared,
  setShared,
  window as herdrWindow,
  appHome,
} from "herdr";
import {
  LOG_FIELD_SEP,
  LOG_RECORD_SEP,
  parseGitLogOutput,
  computeCommitGraphLayout,
  filterCommits,
  formatRelativeTime,
} from "./graph-logic.js";
import {
  MAX_VIEWER_DIFF_LINES,
  DEFAULT_SBS_PAGE_ROWS,
  MAX_RENDER_TOKENS_PER_LINE,
  DIFF_ROW_HEIGHT,
  DIFF_HUNK_HEIGHT,
  DIFF_WAVE_GUTTER_WIDTH,
  parseCommitFiles,
  buildSideBySideRows,
  buildUnifiedRows,
  buildWaveDiffLayout,
  buildWaveDiffBlocks,
  computeUnifiedRowHeights,
  prepareWrappedRenderLines,
  getFileExt,
  getDiffSyntaxPalette,
  toNbspString,
  tokenizeDeferredRow,
  tokenizeSideBySidePage,
  resolveGitFileIcon,
  computeViewerLoadedKey,
  formatGitTabTitle,
  expandCodeTabs,
  paginateDiffRows,
} from "./diff-logic.js";
import { computeWrapColumns, wrapPlainText } from "./code-wrap.js";
import {
  READ_GIT,
  DISCOVER_SKIP_DIRS,
  isHomeDirectoryRoot,
  resolveWorkspaceRoot,
  parseBranchesOutput,
  mergeDiscoveredWithServices,
  resolveSelectedRepo,
  shouldIgnoreGitWatchEvent,
  resolveSessionAgentTabId,
} from "./repo-logic.js";

const ROW_HEIGHT = 30;
const FILE_ROW_HEIGHT = 26;
const Y_MID = ROW_HEIGHT / 2;
const LANE_WIDTH = 16;
const LANE_PAD_LEFT = 10;
const COMMIT_PAGE_SIZE = 200;
const WATCH_DEBOUNCE_MS = 800;
const REPO_CACHE_TTL_MS = 60000;
const SEARCH_DEBOUNCE_MS = 60;
const MAX_COMMIT_FILES_CACHE = 32;
const MAX_VIEWER_PATCH_CACHE = 24;
const GIT_EXEC_TIMEOUT_MS = 15000;
const EXPANDED_VIEWER_DIFF_LINES = 4000;
const GIT_LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";
const GIT_BRANCH_FORMAT = "%(HEAD)%x1f%(refname:short)%x1f%(refname)%x1f%(objectname:short)";

const viewerHostsById = new Map();
let nextViewerHostId = 1;
const lineBakeCache = new WeakMap();
const waveGutterPathCache = new WeakMap();
const graphRowPathCache = new WeakMap();

function lruGet(map, key) {
  if (!map || !map.has(key)) return undefined;
  const val = map.get(key);
  map.delete(key);
  map.set(key, val);
  return val;
}

function lruSet(map, key, val, limit) {
  if (!map) return;
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function readPlainObject(val) {
  return val && typeof val === "object" && !Array.isArray(val) ? val : {};
}

function getSafeAppHome() {
  try {
    return typeof appHome === "function" ? appHome() : "";
  } catch {
    return "";
  }
}

function normPathStr(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function normCmpStr(p, isWindows = false) {
  const n = normPathStr(p);
  return isWindows ? n.toLowerCase() : n;
}

function isSameOrChildPath(candidate, parent, isWindows = false) {
  const c = normCmpStr(candidate, isWindows);
  const p = normCmpStr(parent, isWindows);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + "/");
}

function getParentDir(p) {
  const norm = normPathStr(p);
  const idx = norm.lastIndexOf("/");
  if (idx <= 0) return null;
  const parent = norm.slice(0, idx);
  if (!parent || /^[A-Za-z]:$/.test(parent)) return null;
  return parent;
}

function hexWithAlpha(color, alphaHex) {
  if (!color || typeof color !== "string") return color;
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 6) return `#${hex}${alphaHex}`;
    if (hex.length === 8) return `#${hex.slice(0, 6)}${alphaHex}`;
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${alphaHex}`;
    }
  }
  return color;
}

let cachedThemeBundleSig = "";
let cachedThemeBundle = null;

function getThemeColorsSignature(t, sColors, lColors) {
  return [
    t?.is_dark, t?.appearance, t?.background, t?.foreground, t?.border, t?.chrome, t?.raised,
    t?.hover, t?.selected, t?.dim, t?.muted, t?.accent, t?.done, t?.working, t?.blocked,
    t?.ansi1, t?.ansi2, t?.ansi3, t?.ansi4, t?.ansi5, t?.ansi6,
    t?.ansi10, t?.ansi11, t?.ansi12, t?.ansi13, t?.ansi14,
    sColors?.diff_add, sColors?.added, sColors?.addition, sColors?.diff_del, sColors?.diff_remove, sColors?.removed, sColors?.deletion,
    sColors?.accent, sColors?.ansi1, sColors?.ansi2, sColors?.ansi3, sColors?.ansi4, sColors?.ansi5, sColors?.ansi6,
    lColors?.diff_add, lColors?.added, lColors?.addition, lColors?.diff_del, lColors?.diff_remove, lColors?.removed, lColors?.deletion,
    lColors?.accent,
  ].join("|");
}

function getThemeBundle(t) {
  const sColors = typeof settings === "function" ? settings()?.colors : null;
  const lColors = typeof layout === "function" ? layout()?.colors : null;
  const sig = getThemeColorsSignature(t, sColors, lColors);
  if (cachedThemeBundle && sig === cachedThemeBundleSig) {
    return cachedThemeBundle;
  }
  const colors = {
    ...(t || {}),
    ...(sColors || {}),
    ...(lColors || {}),
  };
  const add = colors.diff_add || colors.added || colors.addition || colors.ansi2 || colors.done || colors.accent || colors.foreground;
  const del = colors.diff_del || colors.diff_remove || colors.removed || colors.deletion || colors.ansi1 || colors.blocked || colors.foreground;
  const dt = {
    add,
    del,
    addBg: hexWithAlpha(add, "22"),
    delBg: hexWithAlpha(del, "22"),
    addHover: hexWithAlpha(add, "35"),
    delHover: hexWithAlpha(del, "35"),
  };

  const candidates = [
    colors.accent, colors.ansi4, colors.ansi2, colors.ansi5, colors.ansi3, colors.ansi6,
    colors.ansi1, colors.ansi12, colors.ansi10, colors.ansi13, colors.ansi14, colors.ansi11,
  ];
  const lanePalette = [];
  for (const col of candidates) {
    if (typeof col === "string" && col.trim() && !lanePalette.includes(col)) {
      lanePalette.push(col);
    }
  }
  if (lanePalette.length === 0) {
    for (const fb of [t?.accent, t?.foreground, t?.muted]) {
      if (typeof fb === "string" && fb.trim() && !lanePalette.includes(fb)) {
        lanePalette.push(fb);
      }
    }
  }

  const syntaxPalette = getDiffSyntaxPalette(t);
  const waveBrushes = {
    centerDividerCol: hexWithAlpha(t?.border, "18"),
    modFill: Background.linear_gradient(90, dt.delBg, dt.addBg),
    modEdge: Background.linear_gradient(90, hexWithAlpha(dt.del, "28"), hexWithAlpha(dt.add, "28")),
    addFill: Background.linear_gradient(90, hexWithAlpha(dt.add, "0c"), dt.addBg),
    addEdge: hexWithAlpha(dt.add, "28"),
    delFill: Background.linear_gradient(90, dt.delBg, hexWithAlpha(dt.del, "0c")),
    delEdge: hexWithAlpha(dt.del, "28"),
  };

  cachedThemeBundleSig = sig;
  cachedThemeBundle = { dt, lanePalette, syntaxPalette, waveBrushes };
  return cachedThemeBundle;
}

function getDiffTheme(t) {
  return getThemeBundle(t).dt;
}

function getLanePalette(t) {
  return getThemeBundle(t).lanePalette;
}

function laneColor(colorIndex, palette) {
  if (!palette || palette.length === 0) return undefined;
  const idx = Math.abs(Number(colorIndex) || 0) % palette.length;
  return palette[idx];
}

function findLayoutNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findLayoutNode(child, id);
    if (found) return found;
  }
  return null;
}

function findGitBlock(node) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === "git-history") return node;
  for (const child of node.children ?? []) {
    const found = findGitBlock(child);
    if (found) return found;
  }
  return null;
}

function isGitPanelVisible() {
  const root = layout();
  if (!root || typeof root !== "object") return false;
  const panel = findLayoutNode(root, "panel");
  const body = findLayoutNode(root, "panel-body");
  if (panel && body) {
    return !panel.hidden && body.active === "git";
  }
  const block = findGitBlock(root);
  return block ? !block.hidden : false;
}

function readAllActiveDiffs() {
  return readPlainObject(shared("git-history.activeDiff"));
}

function readActiveDiff(spaceId) {
  if (!spaceId) return null;
  const all = readAllActiveDiffs();
  const entry = all[spaceId];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

function writeActiveDiff(spaceId, state) {
  if (!spaceId) return null;
  const all = readAllActiveDiffs();
  setShared("git-history.activeDiff", { ...all, [spaceId]: state });
  return state;
}

function readSelectedRepoEntry(spaceId) {
  if (!spaceId) return null;
  const all = readPlainObject(shared("git-history.selectedRepo"));
  const entry = all[spaceId];
  return entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
}

function writeSelectedRepoEntry(spaceId, repoRoot) {
  if (!spaceId || !repoRoot) return null;
  const all = readPlainObject(shared("git-history.selectedRepo"));
  const next = { repoRoot, ts: Date.now() };
  setShared("git-history.selectedRepo", { ...all, [spaceId]: next });
  return next;
}

function findGitDiffTabInSpace(spaceId, allSpaces = null, allPanesList = null) {
  if (!spaceId) return null;
  const sList = allSpaces || spaces() || [];
  const pList = allPanesList || panes() || [];
  const space = sList.find((s) => s.id === spaceId) || null;
  if (!space) return null;
  const spaceTabIds = new Set((space.tabs || []).map((t) => t.id));
  const pane = pList.find((p) => p && spaceTabIds.has(p.tab) && p.mod === "git-history") || null;
  return pane ? { tabId: pane.tab, paneId: pane.pane, space } : null;
}

function isSupportedDirentList(entries) {
  return Array.isArray(entries) && entries.every((e) => e && typeof e === "object" && typeof e.name === "string");
}

function direntIsDir(entry) {
  try {
    return typeof entry?.isDirectory === "function" && entry.isDirectory();
  } catch {
    return false;
  }
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
    level1.map(async (e1) => {
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
        level2.map(async (e2) => {
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
    const parent = getParentDir(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return null;
}

async function discoverRepoRoots(workspaceRoot, on, isWindows = false, extraCwds = []) {
  if (!workspaceRoot && (!extraCwds || extraCwds.length === 0)) return [];
  const normWorkspace = normPathStr(workspaceRoot);
  const skipHomeScan = isHomeDirectoryRoot(workspaceRoot, on, getSafeAppHome(), isWindows);

  const scanRoot = async (targetRoot, depth2 = true) => {
    if (!targetRoot) return [];
    if (!on) {
      const fsResult = await fsScanRepos(targetRoot, depth2);
      if (fsResult !== null) return fsResult;
    }
    if (isWindows) {
      try {
        const escaped = targetRoot.replace(/'/g, "''");
        const depthFlag = depth2 ? "-Depth 2" : "-Depth 1";
        const psScript = `
          $root = '${escaped}';
          $res = @();
          if (Test-Path -LiteralPath (Join-Path $root '.git')) { $res += $root };
          Get-ChildItem -LiteralPath $root -Directory ${depthFlag} -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.FullName -notmatch '[\\\\/](node_modules|target|dist|build|\\.git|vendor|\\.venv)[\\\\/]' -and (Test-Path -LiteralPath (Join-Path $_.FullName '.git'))
          } | ForEach-Object { $res += $_.FullName };
          $res | Select-Object -Unique
        `.trim();
        const r = await exec("powershell", ["-NoProfile", "-Command", psScript], { on }).catch(() => null);
        if (r && r.code === 0 && r.stdout) {
          return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        }
      } catch {}
      return [];
    }
    const script = depth2
      ? 'root="$1"; if [ -e "$root/.git" ]; then printf "%s\\n" "$root"; fi; for d in "$root"/* "$root"/*/*; do [ -e "$d/.git" ] || continue; case "$d" in */node_modules/*|*/target/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.venv/*) continue ;; esac; printf "%s\\n" "$d"; done'
      : 'root="$1"; for d in "$root"/*; do [ -e "$d/.git" ] || continue; case "$d" in */node_modules/*|*/target/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.venv/*) continue ;; esac; printf "%s\\n" "$d"; done';
    try {
      const r = await exec("sh", ["-c", script, "repos", targetRoot], { on }).catch(() => null);
      if (r && r.code === 0 && r.stdout) {
        return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
    } catch {}
    return [];
  };

  let discovered = workspaceRoot && !skipHomeScan ? await scanRoot(workspaceRoot, true) : [];
  let repoPaths = [];
  const addUnique = (p) => {
    const norm = normPathStr(p);
    if (norm && !repoPaths.some((r) => normCmpStr(r, isWindows) === normCmpStr(norm, isWindows))) {
      repoPaths.push(norm);
    }
  };
  for (const p of discovered) addUnique(p);

  if (repoPaths.length === 0 && workspaceRoot && !skipHomeScan) {
    const localTop = !on ? await findLocalGitRoot(workspaceRoot) : null;
    if (localTop) {
      addUnique(localTop);
    } else {
      const top = await exec("git", [...READ_GIT, "rev-parse", "--show-toplevel"], { cwd: workspaceRoot, on }).catch(() => null);
      if (top && top.code === 0 && top.stdout.trim()) {
        addUnique(top.stdout.trim());
      }
    }
  }

  const isSingleRepoRoot =
    repoPaths.length === 1 &&
    normWorkspace &&
    isSameOrChildPath(normWorkspace, repoPaths[0], isWindows);
  if (isSingleRepoRoot) {
    const parentDir = getParentDir(repoPaths[0]);
    if (parentDir && !isHomeDirectoryRoot(parentDir, on, getSafeAppHome(), isWindows)) {
      const siblings = await scanRoot(parentDir, false);
      for (const s of siblings) addUnique(s);
    }
  }

  const pendingExtras = [];
  for (const extra of extraCwds || []) {
    if (!extra) continue;
    const normExtra = normPathStr(extra);
    if (!normExtra || repoPaths.some((r) => isSameOrChildPath(normExtra, r, isWindows))) continue;
    pendingExtras.push(extra);
  }
  if (pendingExtras.length > 0) {
    const extraResults = await Promise.all(
      pendingExtras.map(async (extra) => {
        const localTop = !on ? await findLocalGitRoot(extra) : null;
        if (localTop) return localTop;
        const top = await exec("git", [...READ_GIT, "rev-parse", "--show-toplevel"], {
          cwd: extra,
          on,
          timeout: GIT_EXEC_TIMEOUT_MS,
        }).catch(() => null);
        return top && top.code === 0 && top.stdout.trim() ? top.stdout.trim() : null;
      })
    );
    for (const root of extraResults) {
      if (root) addUnique(root);
    }
  }

  return repoPaths;
}

function getLocationContext() {
  const allSpaces = spaces() || [];
  const allPanes = panes() || [];
  const space = allSpaces.find((s) => s.active) || null;
  const f = focused();
  const storedAgentTabs = readPlainObject(shared("mesh.spaceAgentTabs"));
  const sessionTabId = resolveSessionAgentTabId(space, allPanes, storedAgentTabs);
  const spaceTabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const spacePanes = allPanes.filter((p) => spaceTabs.has(p.tab));
  const activeTab = (space?.tabs ?? []).find((t) => t.active) || null;
  const focusedPane = f?.pane ? spacePanes.find((p) => p.pane === f.pane) : null;
  const activeTabPane = activeTab ? spacePanes.find((p) => p.tab === activeTab.id && p.cwd) : null;
  const pane =
    (focusedPane?.cwd ? focusedPane : null) ||
    activeTabPane ||
    (sessionTabId ? spacePanes.find((p) => p.tab === sessionTabId && p.cwd) : null) ||
    spacePanes.find((p) => p.cwd) ||
    focusedPane ||
    null;
  const on = pane?.machine || space?.machine || null;
  const isWin = !on && herdrWindow()?.platform === "windows";
  const workspaceRoot = resolveWorkspaceRoot({
    spaceFolder: space?.folder,
    paneCwd: pane?.cwd,
    on,
    isWindows: isWin,
    appHomeDir: getSafeAppHome(),
  });
  return {
    space,
    spaceId: space?.id ?? null,
    tabId: sessionTabId,
    activeTabId: activeTab?.id ?? null,
    cwd: workspaceRoot || "",
    paneCwd: pane?.cwd || null,
    on,
    isWindows: isWin,
  };
}

function buildContextKey() {
  const loc = getLocationContext();
  return JSON.stringify({
    cwd: loc.cwd,
    on: loc.on,
    spaceId: loc.spaceId,
    tabId: loc.tabId,
  });
}

function makeCommitFileKey(commit, file) {
  const h = commit?.hash || commit?.commitHash || "";
  const p = file?.path || "";
  return `${h}::${p}`;
}

function buildFileDescriptor(repo, commit, file) {
  if (!file) return null;
  const key = makeCommitFileKey(commit, file);
  return {
    key,
    path: file.path,
    oldPath: file.oldPath || null,
    displayPath: file.displayPath || (file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path),
    status: file.status || "M",
    added: Number(file.added) || 0,
    deleted: Number(file.deleted) || 0,
    binary: Boolean(file.binary),
    repoRoot: repo?.root || "",
    repoName: repo?.name || "",
  };
}

function parseStatusColor(status, t, dt) {
  if (status === "A") return dt.add;
  if (status === "D") return dt.del;
  if (status === "R" || status === "C") return t.ansi4 || t.accent || t.muted;
  return t.blocked || t.ansi3 || t.foreground;
}

function buildRefBadgeColors(ref, t) {
  const accent = t.accent || t.foreground;
  if (ref.kind === "head") {
    return {
      bg: hexWithAlpha(accent, "28"),
      border: hexWithAlpha(accent, "88"),
      text: accent,
    };
  }
  if (ref.kind === "local") {
    const c = ref.isHeadBranch ? accent : (t.ansi2 || t.done || accent);
    return {
      bg: hexWithAlpha(c, "22"),
      border: hexWithAlpha(c, "66"),
      text: c,
    };
  }
  if (ref.kind === "remote") {
    const c = t.ansi6 || t.ansi4 || t.muted;
    return {
      bg: hexWithAlpha(c, "1e"),
      border: hexWithAlpha(c, "55"),
      text: c,
    };
  }
  const tagColor = t.ansi3 || t.working || t.muted;
  return {
    bg: hexWithAlpha(tagColor, "20"),
    border: hexWithAlpha(tagColor, "60"),
    text: tagColor,
  };
}

class GitDiffUnifiedView extends View {
  init(initProps) {
    this.hostId = initProps?.hostId || "";
  }

  update(nextProps) {
    if (nextProps?.hostId) this.hostId = nextProps.hostId;
  }

  render() {
    const host = viewerHostsById.get(this.hostId);
    return host ? host.renderUnifiedPaneContent() : div();
  }
}

export default class GitHistory extends View {
  init(initProps, cx) {
    const p = initProps ?? props();
    this.viewerProps = p || null;
    this.isViewer = p?.role === "viewer";

    this.hostCx = cx || null;
    this.handle = cx.focus_handle();
    this.hostIsWindows = herdrWindow()?.platform === "windows";
    this.isWindows = this.hostIsWindows;

    // Panel state
    this.context = "";
    this.workspaceRoot = "";
    this.on = null;
    this.repos = [];
    this.selectedRepo = null;
    this.branches = [];
    this.selectedBranch = "__all__";
    this.commits = [];
    this.graphLayout = { rows: [], maxLaneCount: 1 };
    this.hasMore = false;
    this.loadingCommits = false;
    this.loadingMore = false;
    this.loadingCommitFiles = false;
    this.error = null;
    this.selectedCommitHash = null;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.selectedFileKey = null;
    this.showRepoMenu = false;
    this.showBranchMenu = false;
    this.searchQuery = "";
    this.typingSearch = false;
    this.panelWidth = 420;
    this.viewerWidth = 960;

    // Async generation counters & caches
    this.repoDiscoverGen = 0;
    this.logGen = 0;
    this.commitFilesGen = 0;
    this.viewerLoadGen = 0;
    this.lastRequestSeq = 0;
    this.lastActiveServiceTs = 0;
    this.lastConsumedBusSig = "";
    this.lastRefSigKey = "";
    this.lastRefSig = "";
    this.repoCache = null;
    this.commitFilesCache = new Map();
    this.viewerPatchCache = new Map();
    this._cachedFilterState = null;
    this._cachedRowMapState = null;
    this._cachedBranchState = null;

    // Viewer state
    this.diffMode = "side-by-side"; // "side-by-side" | "unified"
    this.expandedFiles = new Set();
    this.viewerLoadedKey = "";
    this.viewerScheduledKey = "";
    this.viewerLoading = false;
    this.viewerError = null;
    this.isBinaryDiff = false;
    this.diffTruncated = false;
    this.diffTotalLines = 0;
    this.loadedPatchSource = null;
    this.loadedFileExt = "";
    this.sbsBuilt = false;
    this.uniBuilt = false;
    this.sbsRows = [];
    this.sbsPage = 0;
    this.sbsPageInfo = paginateDiffRows([], 0, DEFAULT_SBS_PAGE_ROWS);
    this.sbsWaveLayout = null;
    this.uniRows = [];
    this.uniRowHeights = [];
    this.leftViewportW = 0;
    this.rightViewportW = 0;
    this.unifiedViewportW = 0;
    this._lastSbsWrapSig = "";
    this._lastUniWrapSig = "";
    this.open = null;

    // Watchers & timers
    this.watchedGitDirs = new Map();
    this.watchDebounceTask = null;
    this.searchDebounceTask = null;
    this.renderRefreshTask = null;
    this.agentTabSyncTask = null;
    this.sharedSyncTask = null;
    this.viewerLoadTask = null;
    this.diffResizeTask = null;
    this.pollTask = null;
    this.wasVisible = !this.isViewer && isGitPanelVisible();
    this.hasLoadedOnce = false;
    this.needsRefreshOnShow = false;

    // Retained UI handles & child sub-views
    if (this.isViewer) {
      this.viewerHostId = `vh-${nextViewerHostId++}`;
      viewerHostsById.set(this.viewerHostId, this);
      this.uniScroll = VirtualListScrollHandle.new();
      this.diffScroll = VirtualListScrollHandle.new();
      this.unifiedDiffPane = cx.new(GitDiffUnifiedView, { hostId: this.viewerHostId });
    } else {
      this.commitsScroll = VirtualListScrollHandle.new();
      this.filesScroll = VirtualListScrollHandle.new();
      this.repoDropdownScroll = ScrollHandle.new();
      this.branchDropdownScroll = ScrollHandle.new();
      this.searchInput = InputState.new({ placeholder: "Filter message, author, SHA..." });
      this.searchInput.on("change", (_e, cx) => {
        const next = this.searchInput.value() ?? "";
        if (next === this.searchQuery) return;
        if (this.searchDebounceTask) {
          try { this.searchDebounceTask.cancel(); } catch {}
          this.searchDebounceTask = null;
        }
        if (!next.trim() || !cx?.timer) {
          this.searchQuery = next;
          cx.notify();
          return;
        }
        this.searchDebounceTask = cx.timer.after(SEARCH_DEBOUNCE_MS, (cx) => {
          this.searchDebounceTask = null;
          const latest = this.searchInput.value() ?? "";
          if (latest !== this.searchQuery) {
            this.searchQuery = latest;
            cx.notify();
          }
        });
      });
      this.searchInput.on("focus", (_e, cx) => {
        this.typingSearch = true;
        cx.notify();
      });
      this.searchInput.on("blur", (_e, cx) => {
        this.typingSearch = false;
        cx.notify();
      });

      if (this.wasVisible) {
        this.refresh(cx);
      }
      this.pollTask = cx.timer.every(30000, (cx) => {
        if (isGitPanelVisible()) {
          this.refresh(cx, { fromPoll: true, backgroundRefresh: true });
        }
      });
    }
  }

  close() {
    this.hostCx = null;
    this.repoDiscoverGen += 1;
    this.logGen += 1;
    this.commitFilesGen += 1;
    this.viewerLoadGen += 1;

    if (this.viewerHostId) {
      viewerHostsById.delete(this.viewerHostId);
      this.viewerHostId = null;
    }

    try { this.renderRefreshTask?.cancel?.(); } catch {}
    this.renderRefreshTask = null;
    try { this.watchDebounceTask?.cancel?.(); } catch {}
    this.watchDebounceTask = null;
    try { this.searchDebounceTask?.cancel?.(); } catch {}
    this.searchDebounceTask = null;
    try { this.agentTabSyncTask?.cancel?.(); } catch {}
    this.agentTabSyncTask = null;
    try { this.sharedSyncTask?.cancel?.(); } catch {}
    this.sharedSyncTask = null;
    try { this.viewerLoadTask?.cancel?.(); } catch {}
    this.viewerLoadTask = null;
    try { this.diffResizeTask?.cancel?.(); } catch {}
    this.diffResizeTask = null;
    try { this.pollTask?.cancel?.(); } catch {}
    this.pollTask = null;

    this.stopAllWatchers();

    try { this.unifiedDiffPane?.release?.(); } catch {}
    try { this.searchInput?.release?.(); } catch {}
    try { this.commitsScroll?.release?.(); } catch {}
    try { this.filesScroll?.release?.(); } catch {}
    try { this.uniScroll?.release?.(); } catch {}
    try { this.diffScroll?.release?.(); } catch {}
    try { this.repoDropdownScroll?.release?.(); } catch {}
    try { this.branchDropdownScroll?.release?.(); } catch {}
    try { this.handle?.release?.(); } catch {}
  }

  isViewerMode() {
    const p = props() || this.viewerProps;
    return p?.role === "viewer" || this.isViewer;
  }

  getSessionContext() {
    const vp = props() || this.viewerProps || {};
    const allSpaces = spaces() || [];
    const allPanes = panes() || [];
    const storedAgentTabs = readPlainObject(shared("mesh.spaceAgentTabs"));

    if (this.isViewerMode()) {
      const targetSpaceId = vp.spaceId || null;
      const space =
        (targetSpaceId && allSpaces.find((s) => s.id === targetSpaceId)) ||
        allSpaces.find((s) => s.active) ||
        null;
      const spaceId = space?.id || targetSpaceId || "default";
      const diff = readActiveDiff(spaceId);
      const sourceTabId =
        diff?.sourceTabId ||
        vp.sourceTabId ||
        resolveSessionAgentTabId(space, allPanes, storedAgentTabs) ||
        null;
      return {
        space,
        spaceId,
        sourceTabId,
        workspaceRoot: diff?.workspaceRoot || space?.folder || this.workspaceRoot || "",
      };
    }

    const loc = getLocationContext();
    return {
      space: loc.space,
      spaceId: loc.spaceId || "default",
      sourceTabId: loc.tabId || null,
      workspaceRoot: this.workspaceRoot || loc.cwd || "",
    };
  }

  recordActiveTerminalTabNow() {
    const allSpaces = spaces() || [];
    const allPanes = panes() || [];
    const activeSpace = allSpaces.find((s) => s.active);
    if (!activeSpace?.id) return;
    const activeTab = (activeSpace.tabs || []).find((t) => t.active);
    if (!activeTab?.id) return;
    const hasTerminal = allPanes.some((p) => p.tab === activeTab.id && Boolean(p.terminal));
    if (!hasTerminal) return;
    const prev = readPlainObject(shared("mesh.spaceAgentTabs"));
    if (prev[activeSpace.id] === activeTab.id) return;
    setShared("mesh.spaceAgentTabs", { ...prev, [activeSpace.id]: activeTab.id });
  }

  scheduleAgentTabSync(cx) {
    if (this.agentTabSyncTask || !cx?.timer) return;
    this.agentTabSyncTask = cx.timer.after(0, () => {
      this.agentTabSyncTask = null;
      this.recordActiveTerminalTabNow();
    });
  }

  scheduleRenderRefresh(cx, isBg = false) {
    if (this.isViewerMode() || !cx?.timer) return;
    if (!isBg) this.renderRefreshBg = false;
    if (this.renderRefreshTask) return;
    this.renderRefreshBg = Boolean(isBg);
    this.renderRefreshTask = cx.timer.after(0, (cx) => {
      this.renderRefreshTask = null;
      const bg = Boolean(this.renderRefreshBg);
      this.renderRefreshBg = false;
      if (isGitPanelVisible()) {
        this.refresh(cx, { backgroundRefresh: bg });
      }
    });
  }

  scheduleSharedSync(cx) {
    if (this.sharedSyncTask || !cx?.timer || this.isViewerMode()) return;
    this.sharedSyncTask = cx.timer.after(0, (cx) => {
      this.sharedSyncTask = null;
      const sharedActive = shared("mesh.activeService");
      if (
        sharedActive &&
        normPathStr(sharedActive.workspaceRoot) === normPathStr(this.workspaceRoot) &&
        typeof sharedActive.ts === "number" &&
        sharedActive.ts > (this.lastActiveServiceTs || 0)
      ) {
        this.lastActiveServiceTs = sharedActive.ts;
        if (sharedActive.serviceId && sharedActive.serviceId !== "all") {
          const matched = this.repos.find((r) => r.id === sharedActive.serviceId);
          if (matched && normPathStr(matched.root) !== normPathStr(this.selectedRepo?.root)) {
            this.selectRepo(matched, cx, { syncActiveService: false });
            return;
          }
        }
      }

      const ctx = this.getSessionContext();
      const diff = readActiveDiff(ctx.spaceId);
      const tab = findGitDiffTabInSpace(ctx.spaceId);
      let changed = false;
      if (tab && diff && diff.commitHash === this.selectedCommitHash) {
        if (diff.openFileKey && diff.openFileKey !== this.selectedFileKey) {
          this.selectedFileKey = diff.openFileKey;
          changed = true;
        }
      }
      if (changed) cx.notify();
    });
  }

  stopAllWatchers() {
    if (this.watchedGitDirs) this.watchedGitDirs.clear();
    if (this.watchDebounceTask) {
      try { this.watchDebounceTask.cancel(); } catch {}
      this.watchDebounceTask = null;
    }
  }

  scheduleWatchRefresh(cx, delayMs = WATCH_DEBOUNCE_MS) {
    if (this.isViewerMode()) return;
    if (this.watchDebounceTask) {
      try { this.watchDebounceTask.cancel(); } catch {}
      this.watchDebounceTask = null;
    }
    const ctxKey = this.context;
    const watchedRepoRoot = normPathStr(this.selectedRepo?.root);
    this.watchDebounceTask = cx.timer.after(delayMs, (cx) => {
      this.watchDebounceTask = null;
      if (buildContextKey() !== ctxKey) return;
      if (normPathStr(this.selectedRepo?.root) !== watchedRepoRoot) return;
      if (!isGitPanelVisible()) {
        this.needsRefreshOnShow = true;
        return;
      }
      if (this.selectedRepo) {
        this.loadBranchesAndCommits(this.selectedRepo, cx, {
          preserveSelection: true,
          backgroundRefresh: true,
        });
      }
    });
  }

  async watchSelectedRepoGitDir(repo, cx) {
    if (this.isViewerMode() || this.on || !repo?.root) {
      this.stopAllWatchers();
      return;
    }
    const repoRoot = normPathStr(repo.root);
    let gitDir = join(repo.root, ".git");
    try {
      const hasHeadInside = await exists(join(gitDir, "HEAD")).catch(() => false);
      if (!hasHeadInside) {
        const res = await exec("git", [...READ_GIT, "rev-parse", "--git-dir"], {
          cwd: repo.root,
          on: null,
          timeout: GIT_EXEC_TIMEOUT_MS,
        }).catch(() => null);
        if (res && res.code === 0 && res.stdout.trim()) {
          const rawDir = res.stdout.trim();
          gitDir = rawDir.startsWith("/") || /^[A-Za-z]:/.test(rawDir) ? rawDir : join(repo.root, rawDir);
        }
      }
    } catch {}

    const normGitDir = normPathStr(gitDir);
    if (!normGitDir || this.watchedGitDirs.has(normGitDir)) {
      for (const existing of [...this.watchedGitDirs.keys()]) {
        if (existing !== normGitDir) this.watchedGitDirs.delete(existing);
      }
      return;
    }

    this.stopAllWatchers();
    const token = Symbol(normGitDir);
    this.watchedGitDirs.set(normGitDir, token);
    const ctxKey = this.context;

    cx.spawn(async (cx) => {
      while (this.watchedGitDirs.get(normGitDir) === token && this.context === ctxKey) {
        try {
          const changed = await watchFolder(gitDir);
          if (this.watchedGitDirs.get(normGitDir) !== token || this.context !== ctxKey) break;
          if (normPathStr(this.selectedRepo?.root) !== repoRoot) break;
          const paths = Array.isArray(changed) ? changed : (changed ? [changed] : []);
          const hasRelevant = paths.length === 0 || paths.some((p) => !shouldIgnoreGitWatchEvent(p));
          if (!hasRelevant) continue;
          if (!isGitPanelVisible()) {
            this.needsRefreshOnShow = true;
            continue;
          }
          this.scheduleWatchRefresh(cx, WATCH_DEBOUNCE_MS);
        } catch {
          if (this.watchedGitDirs.get(normGitDir) !== token || this.context !== ctxKey) break;
          await cx.sleep(5000);
        }
      }
    });
  }

  refresh(cx, opts = {}) {
    if (this.isViewerMode()) return;
    this.recordActiveTerminalTabNow();
    const loc = getLocationContext();
    const ctxKey = JSON.stringify({
      cwd: loc.cwd,
      on: loc.on,
      spaceId: loc.spaceId,
      tabId: loc.tabId,
    });
    const force = Boolean(opts.force);
    if (force) {
      this.repoCache = null;
      this.commitFilesCache?.clear();
      this.viewerPatchCache?.clear();
      this.lastRefSigKey = "";
      this.lastRefSig = "";
    }

    if (ctxKey !== this.context) {
      this.context = ctxKey;
      this.workspaceRoot = loc.cwd;
      this.on = loc.on;
      this.isWindows = loc.isWindows;
      this.repos = [];
      this.selectedRepo = null;
      this.branches = [];
      this.selectedBranch = "__all__";
      this.commits = [];
      this.graphLayout = { rows: [], maxLaneCount: 1 };
      this.hasMore = false;
      this.selectedCommitHash = null;
      this.selectedCommit = null;
      this.commitFiles = [];
      this.selectedFileKey = null;
      this.showRepoMenu = false;
      this.showBranchMenu = false;
      this.error = null;
      this.repoCache = null;
      this.stopAllWatchers();
      this.hasLoadedOnce = false;
      this.needsRefreshOnShow = false;
    }

    this.isWindows = !loc.on && this.hostIsWindows;
    if (!loc.cwd && !loc.paneCwd) {
      this.error = "No workspace folder";
      cx.notify();
      return;
    }

    this.hasLoadedOnce = true;
    const gen = ++this.repoDiscoverGen;
    const allPanesList = panes() || [];
    const spaceTabs = new Set((loc.space?.tabs || []).map((t) => t.id));
    const extraCwds = Array.from(
      new Set(
        [
          loc.paneCwd,
          ...allPanesList.filter((p) => p?.cwd && spaceTabs.has(p.tab)).map((p) => p.cwd),
        ].filter(Boolean)
      )
    );

    const bus = shared("mesh.services");
    const busSigVal = bus?.sig || (typeof bus?.ts === "number" ? String(bus.ts) : "");
    if (busSigVal) this.lastConsumedBusSig = busSigVal;

    cx.spawn(async (cx) => {
      try {
        const cacheKey = `${loc.cwd}|${loc.on || ""}|${extraCwds.slice().sort().join(",")}`;
        const now = Date.now();
        let discoveredRoots;
        if (
          !force &&
          this.repoCache &&
          this.repoCache.key === cacheKey &&
          now - this.repoCache.ts < REPO_CACHE_TTL_MS
        ) {
          discoveredRoots = this.repoCache.roots.slice();
        } else {
          discoveredRoots = await discoverRepoRoots(loc.cwd, loc.on, this.isWindows, extraCwds);
          if (gen !== this.repoDiscoverGen || buildContextKey() !== ctxKey) return;
          this.repoCache = { key: cacheKey, roots: discoveredRoots.slice(), ts: Date.now() };
        }

        // Also include any candidate roots already discovered by mesh.services for the same workspace
        const freshBus = shared("mesh.services");
        if (
          freshBus &&
          normPathStr(freshBus.workspaceRoot) === normPathStr(loc.cwd) &&
          Array.isArray(freshBus.candidates)
        ) {
          for (const cand of freshBus.candidates) {
            const normCand = normPathStr(cand?.root);
            if (
              normCand &&
              !discoveredRoots.some((r) => normCmpStr(r, this.isWindows) === normCmpStr(normCand, this.isWindows))
            ) {
              discoveredRoots.push(normCand);
            }
          }
        }

        const mergedRepos = mergeDiscoveredWithServices(discoveredRoots, freshBus, loc.spaceId || "default");
        if (gen !== this.repoDiscoverGen || buildContextKey() !== ctxKey) return;

        this.repos = mergedRepos;
        if (mergedRepos.length === 0) {
          this.selectedRepo = null;
          this.branches = [];
          this.commits = [];
          this.graphLayout = { rows: [], maxLaneCount: 1 };
          this.selectedCommitHash = null;
          this.selectedCommit = null;
          this.commitFiles = [];
          this.stopAllWatchers();
          this.error = "No git repositories found";
          cx.notify();
          return;
        }

        this.error = null;
        const selectedRepoState = readSelectedRepoEntry(loc.spaceId || "default");
        const activeServiceState = shared("mesh.activeService");
        const picked =
          resolveSelectedRepo(mergedRepos, selectedRepoState, activeServiceState) ||
          mergedRepos[0];
        const repoChanged = normPathStr(picked?.root) !== normPathStr(this.selectedRepo?.root);
        this.selectedRepo = picked;

        if (picked) {
          this.watchSelectedRepoGitDir(picked, cx);
          await this.loadBranchesAndCommits(picked, cx, {
            preserveSelection: !repoChanged && !opts.fromBranchChange,
            backgroundRefresh: Boolean(opts.backgroundRefresh && !force && !repoChanged && !opts.fromBranchChange),
          });
        }
      } catch (e) {
        if (gen === this.repoDiscoverGen && buildContextKey() === ctxKey) {
          this.error = String(e?.message || e);
          cx.notify();
        }
      }
    });
  }

  selectRepo(repo, cx, opts = {}) {
    if (!repo?.root) return;
    this.showRepoMenu = false;
    this.showBranchMenu = false;
    const changed = normPathStr(repo.root) !== normPathStr(this.selectedRepo?.root);
    this.selectedRepo = repo;
    if (changed) {
      this.selectedBranch = "__all__";
      this.commits = [];
      this.graphLayout = { rows: [], maxLaneCount: 1 };
      this.selectedCommitHash = null;
      this.selectedCommit = null;
      this.commitFiles = [];
      this.selectedFileKey = null;
      this.hasMore = false;
    }

    const spaceId = this.getSessionContext().spaceId;
    writeSelectedRepoEntry(spaceId, repo.root);

    // Only broadcast mesh.activeService when the selected repo is in mesh.services (so clean repos don't blank changes-review)
    if (opts.syncActiveService !== false && this.workspaceRoot) {
      const bus = shared("mesh.services");
      const busServices = Array.isArray(bus?.services) ? bus.services : [];
      const matchingSvc = busServices.find(
        (s) => normPathStr(s?.root) === normPathStr(repo.root) || (repo.id && s?.id === repo.id)
      );
      if (matchingSvc?.id) {
        const ts = Date.now();
        this.lastActiveServiceTs = ts;
        setShared("mesh.activeService", {
          workspaceRoot: this.workspaceRoot,
          serviceId: matchingSvc.id,
          ts,
        });
      }
    }

    this.watchSelectedRepoGitDir(repo, cx);
    this.loadBranchesAndCommits(repo, cx, { preserveSelection: !changed });
    cx.notify();
  }

  selectBranch(branchName, cx) {
    this.showBranchMenu = false;
    this.showRepoMenu = false;
    const next = branchName || "__all__";
    if (this.selectedBranch === next) {
      cx.notify();
      return;
    }
    this.selectedBranch = next;
    this.commits = [];
    this.graphLayout = { rows: [], maxLaneCount: 1 };
    this.selectedCommitHash = null;
    this.selectedCommit = null;
    this.commitFiles = [];
    this.selectedFileKey = null;
    this.hasMore = false;
    if (this.selectedRepo) {
      this.loadBranchesAndCommits(this.selectedRepo, cx, { preserveSelection: false });
    }
    cx.notify();
  }

  async loadBranchesAndCommits(repo, cx, opts = {}) {
    if (!repo?.root) return;
    const gen = ++this.logGen;
    const repoRoot = repo.root;
    const on = this.on;
    const targetBranch = this.selectedBranch || "__all__";
    const refSigKey = `${normPathStr(repoRoot)}|${on || ""}|${targetBranch}`;
    let prefetchedRefSig = null;

    if (
      opts.backgroundRefresh &&
      this.commits.length > 0 &&
      !this.error &&
      this.lastRefSigKey === refSigKey &&
      this.lastRefSig
    ) {
      const sigRes = await exec("git", [...READ_GIT, "show-ref", "--head"], {
        cwd: repoRoot,
        on,
        timeout: 10000,
      }).catch(() => null);
      if (gen !== this.logGen) return;
      if (sigRes && sigRes.code === 0) {
        if (sigRes.stdout === this.lastRefSig) {
          return;
        }
        prefetchedRefSig = sigRes.stdout;
      }
    }

    this.error = null;
    if (this.commits.length === 0) {
      this.loadingCommits = true;
      cx?.notify();
    } else {
      this.loadingCommits = true;
    }

    try {
      const branchPromise = exec(
        "git",
        [...READ_GIT, "for-each-ref", `--format=${GIT_BRANCH_FORMAT}`, "refs/heads", "refs/remotes"],
        { cwd: repoRoot, on, timeout: GIT_EXEC_TIMEOUT_MS }
      ).catch(() => null);

      const refArgs =
        this.selectedBranch && this.selectedBranch !== "__all__"
          ? [this.selectedBranch]
          : ["--all", "HEAD"];
      const logArgs = [
        ...READ_GIT,
        "log",
        ...refArgs,
        "--topo-order",
        "--decorate=short",
        "--date=unix",
        "-n",
        String(COMMIT_PAGE_SIZE),
        "--skip=0",
        `--format=${GIT_LOG_FORMAT}`,
      ];
      const logPromise = exec("git", logArgs, {
        cwd: repoRoot,
        on,
        timeout: GIT_EXEC_TIMEOUT_MS,
      }).catch((e) => ({ code: 1, stderr: String(e?.message || e), stdout: "" }));
      const sigPromise =
        prefetchedRefSig !== null
          ? Promise.resolve({ code: 0, stdout: prefetchedRefSig })
          : exec("git", [...READ_GIT, "show-ref", "--head"], {
              cwd: repoRoot,
              on,
              timeout: 10000,
            }).catch(() => null);

      const [branchRes, logRes, freshSigRes] = await Promise.all([branchPromise, logPromise, sigPromise]);
      if (gen !== this.logGen) return;

      if (freshSigRes && freshSigRes.code === 0) {
        this.lastRefSigKey = refSigKey;
        this.lastRefSig = freshSigRes.stdout || "";
      }

      if (branchRes && branchRes.code === 0) {
        this.branches = parseBranchesOutput(branchRes.stdout || "");
      } else {
        this.branches = [];
      }

      if (!logRes || logRes.code !== 0) {
        const stderr = (logRes?.stderr || "").toLowerCase();
        if (stderr.includes("does not have any commits yet") || stderr.includes("bad default revision")) {
          this.commits = [];
          this.graphLayout = { rows: [], maxLaneCount: 1 };
          this.hasMore = false;
          this.error = null;
          return;
        }
        throw new Error(logRes?.stderr || "Failed to load git log");
      }

      const parsed = parseGitLogOutput(logRes.stdout || "");
      this.commits = parsed;
      this.graphLayout = computeCommitGraphLayout(parsed);
      this.hasMore = parsed.length >= COMMIT_PAGE_SIZE;

      if (opts.preserveSelection && this.selectedCommitHash) {
        const found = parsed.find((c) => c.hash === this.selectedCommitHash);
        if (found) {
          this.selectedCommit = found;
        } else if (parsed.length > 0) {
          this.selectedCommitHash = parsed[0].hash;
          this.selectedCommit = parsed[0];
          this.loadCommitFiles(parsed[0], cx, { openViewer: false });
        } else {
          this.selectedCommitHash = null;
          this.selectedCommit = null;
          this.commitFiles = [];
        }
      } else if (parsed.length > 0 && !this.selectedCommitHash) {
        this.selectedCommitHash = parsed[0].hash;
        this.selectedCommit = parsed[0];
        this.loadCommitFiles(parsed[0], cx, { openViewer: false });
      }
    } catch (e) {
      if (gen === this.logGen) {
        this.error = String(e?.message || e);
      }
    } finally {
      if (gen === this.logGen) {
        this.loadingCommits = false;
        cx?.notify();
      }
    }
  }

  async loadMoreCommits(cx) {
    if (!this.selectedRepo?.root || this.loadingMore || this.loadingCommits || !this.hasMore) return;
    const gen = this.logGen;
    const repoRoot = this.selectedRepo.root;
    const on = this.on;
    const skip = this.commits.length;
    this.loadingMore = true;
    cx.notify();

    try {
      const refArgs =
        this.selectedBranch && this.selectedBranch !== "__all__"
          ? [this.selectedBranch]
          : ["--all", "HEAD"];
      const logArgs = [
        ...READ_GIT,
        "log",
        ...refArgs,
        "--topo-order",
        "--decorate=short",
        "--date=unix",
        "-n",
        String(COMMIT_PAGE_SIZE),
        `--skip=${skip}`,
        `--format=${GIT_LOG_FORMAT}`,
      ];
      const res = await exec("git", logArgs, { cwd: repoRoot, on, timeout: GIT_EXEC_TIMEOUT_MS });
      if (gen !== this.logGen) return;
      if (res.code !== 0) {
        throw new Error(res.stderr || "Failed to load older commits");
      }
      const nextChunk = parseGitLogOutput(res.stdout || "");
      const seen = new Set(this.commits.map((c) => c.hash));
      const merged = [...this.commits];
      for (const c of nextChunk) {
        if (!seen.has(c.hash)) {
          seen.add(c.hash);
          merged.push(c);
        }
      }
      this.commits = merged;
      this.graphLayout = computeCommitGraphLayout(merged);
      this.hasMore = nextChunk.length >= COMMIT_PAGE_SIZE;
    } catch (e) {
      if (gen === this.logGen) {
        this.error = String(e?.message || e);
      }
    } finally {
      if (gen === this.logGen) {
        this.loadingMore = false;
        cx.notify();
      }
    }
  }

  async loadCommitFiles(commit, cx, opts = {}) {
    if (!commit?.hash || !this.selectedRepo?.root) return;
    const gen = ++this.commitFilesGen;
    const repo = this.selectedRepo;
    const on = this.on;
    const cacheKey = `${normPathStr(repo.root)}|${on || ""}|${commit.hash}`;
    const cachedFiles = !opts.force ? lruGet(this.commitFilesCache, cacheKey) : undefined;
    if (cachedFiles) {
      this.loadingCommitFiles = false;
      this.commitFiles = cachedFiles;
      const firstFile = cachedFiles[0] || null;
      this.selectedFileKey = firstFile ? makeCommitFileKey(commit, firstFile) : null;
      if (opts.openViewer) {
        this.openGitDiffTabForCommit(repo, commit, firstFile, cachedFiles, {
          create: true,
          select: true,
        });
      }
      cx?.notify();
      return;
    }

    this.loadingCommitFiles = true;
    try {
      const numArgs = [
        ...READ_GIT,
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--root",
        "--first-parent",
        "-M",
        "--numstat",
        "-z",
        commit.hash,
      ];
      const statArgs = [
        ...READ_GIT,
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--root",
        "--first-parent",
        "-M",
        "--name-status",
        "-z",
        commit.hash,
      ];
      const [numRes, statRes] = await Promise.all([
        exec("git", numArgs, { cwd: repo.root, on, timeout: GIT_EXEC_TIMEOUT_MS }),
        exec("git", statArgs, { cwd: repo.root, on, timeout: GIT_EXEC_TIMEOUT_MS }),
      ]);
      if (gen !== this.commitFilesGen) return;
      if (numRes.code !== 0) {
        throw new Error(numRes.stderr || "Failed to inspect commit files");
      }
      const parsedFiles = parseCommitFiles(numRes.stdout || "", statRes?.stdout || "");
      lruSet(this.commitFilesCache, cacheKey, parsedFiles, MAX_COMMIT_FILES_CACHE);
      this.commitFiles = parsedFiles;
      const firstFile = parsedFiles[0] || null;
      this.selectedFileKey = firstFile ? makeCommitFileKey(commit, firstFile) : null;

      if (opts.openViewer) {
        this.openGitDiffTabForCommit(repo, commit, firstFile, parsedFiles, {
          create: true,
          select: true,
        });
      }
    } catch (e) {
      if (gen === this.commitFilesGen) {
        this.commitFiles = [];
        this.error = String(e?.message || e);
      }
    } finally {
      if (gen === this.commitFilesGen) {
        this.loadingCommitFiles = false;
        cx?.notify();
      }
    }
  }

  buildActiveDiffPayload(repo, commit, file, files, overrides = {}) {
    const ctx = this.getSessionContext();
    const prev = readActiveDiff(ctx.spaceId);
    const descriptors = (files || []).map((f) => buildFileDescriptor(repo, commit, f)).filter(Boolean);
    const openDesc = file ? buildFileDescriptor(repo, commit, file) : null;
    const bumpSeq = overrides.bumpSeq !== false;
    const nextSeq = bumpSeq
      ? Math.max(prev?.requestSeq || 0, this.lastRequestSeq || 0) + 1
      : (prev?.requestSeq || this.lastRequestSeq || 1);
    this.lastRequestSeq = nextSeq;

    return {
      spaceId: ctx.spaceId,
      sourceTabId: ctx.sourceTabId,
      workspaceRoot: ctx.workspaceRoot || prev?.workspaceRoot || "",
      repoRoot: repo?.root || prev?.repoRoot || "",
      repoName: repo?.name || prev?.repoName || "",
      on: overrides.on !== undefined ? overrides.on : (this.on ?? prev?.on ?? null),
      commitHash: commit?.hash || "",
      shortHash: commit?.shortHash || (commit?.hash ? commit.hash.slice(0, 7) : ""),
      parentHashes: Array.isArray(commit?.parents) ? commit.parents.slice() : [],
      commitSubject: commit?.subject || "",
      commitAuthor: commit?.author || "",
      commitTimestamp: Number(commit?.timestamp) || 0,
      diffMode: overrides.diffMode ?? prev?.diffMode ?? this.diffMode ?? "side-by-side",
      openFileKey: openDesc ? openDesc.key : null,
      openFile: openDesc,
      files: descriptors,
      expanded: Boolean(overrides.expanded ?? (openDesc ? this.expandedFiles?.has(openDesc.key) : false)),
      requestSeq: nextSeq,
      ts: Date.now(),
    };
  }

  openGitDiffTabForCommit(repo, commit, file, files, opts = {}) {
    this.recordActiveTerminalTabNow();
    const ctx = this.getSessionContext();
    if (!ctx.spaceId) return null;

    const existing = findGitDiffTabInSpace(ctx.spaceId);
    if (!existing && opts.create === false) return null;

    const payload = this.buildActiveDiffPayload(repo, commit, file, files, {
      bumpSeq: opts.bumpSeq !== false,
    });
    writeActiveDiff(ctx.spaceId, payload);

    const title = formatGitTabTitle(commit, file);
    if (existing) {
      run("tab.rename", { id: existing.tabId, name: title });
      if (opts.select !== false) {
        run("tab.select", { id: existing.tabId });
      }
    } else if (opts.create !== false) {
      run("tab.new", {
        space: ctx.spaceId,
        name: title,
        mod: "git-history",
        props: {
          role: "viewer",
          spaceId: ctx.spaceId,
          sourceTabId: ctx.sourceTabId,
        },
      });
    }
    return payload;
  }

  selectCommitFileInPlace(file, cx) {
    if (!file || !this.selectedCommit || !this.selectedRepo) return;
    this.selectedFileKey = makeCommitFileKey(this.selectedCommit, file);
    this.openGitDiffTabForCommit(this.selectedRepo, this.selectedCommit, file, this.commitFiles, {
      create: true,
      select: true,
      bumpSeq: true,
    });
    cx.notify();
  }

  handleCommitListClick(itemKey, cx) {
    if (itemKey === "__load_more__") {
      this.loadMoreCommits(cx);
      return;
    }
    const commit = this.commits.find((c) => c.hash === itemKey);
    if (!commit) return;
    this.selectedCommitHash = commit.hash;
    this.selectedCommit = commit;
    this.loadCommitFiles(commit, cx, { openViewer: true });
  }

  handleCommitFileClick(itemKey, cx) {
    if (!this.selectedCommit) return;
    const file = this.commitFiles.find((f) => makeCommitFileKey(this.selectedCommit, f) === itemKey);
    if (file) {
      this.selectCommitFileInPlace(file, cx);
    }
  }

  // ==========================================
  // VIEWER MODE (role === "viewer")
  // ==========================================
  scheduleViewerLoad(diff, cx) {
    const targetKey = computeViewerLoadedKey(diff);
    if (targetKey === this.viewerLoadedKey || targetKey === this.viewerScheduledKey || !cx?.timer) return;
    if (this.viewerLoadTask) {
      try { this.viewerLoadTask.cancel(); } catch {}
      this.viewerLoadTask = null;
    }
    this.viewerScheduledKey = targetKey;
    const spaceId = diff?.spaceId || this.getSessionContext().spaceId;
    this.viewerLoadTask = cx.timer.after(0, (cx) => {
      this.viewerLoadTask = null;
      this.viewerScheduledKey = "";
      this.loadViewerDiffNow(readActiveDiff(spaceId) || diff, cx);
    });
  }

  makeViewerPatchCacheKey(diff, openFile, isExpanded) {
    const repoRoot = normPathStr(diff?.repoRoot || openFile?.repoRoot);
    const commitHash = diff?.commitHash || "";
    const on = diff?.on ?? "";
    return `${repoRoot}|${on}|${commitHash}|${openFile?.key || openFile?.path || ""}|${isExpanded ? 1 : 0}`;
  }

  notifyViewerChildren(cx, targets = "all") {
    if (!this.isViewerMode()) return;
    const primaryCx = cx || this.hostCx;
    const targetSet = targets === "all" ? null : (Array.isArray(targets) ? targets : [targets]);
    const want = (name) => !targetSet || targetSet.includes(name);
    const ping = (entity) => {
      if (!entity) return;
      try {
        primaryCx?.notify(entity);
      } catch {
        if (this.hostCx && this.hostCx !== primaryCx) {
          try {
            this.hostCx.notify(entity);
          } catch {}
        }
      }
    };
    if (want("unified")) ping(this.unifiedDiffPane);
  }

  async fetchCommitFilePatch(diff, openFile, isExpanded, opts = {}) {
    const repoRoot = diff?.repoRoot || openFile?.repoRoot;
    const commitHash = diff?.commitHash;
    const on = diff?.on ?? null;
    if (!repoRoot || !commitHash || !openFile?.path) {
      return { patchText: "", isBinary: false };
    }
    if (openFile.binary) {
      return { patchText: "", isBinary: true };
    }

    const cacheKey = this.makeViewerPatchCacheKey(diff, openFile, isExpanded);
    if (!opts.forceReload) {
      const cached = lruGet(this.viewerPatchCache, cacheKey);
      if (cached) return cached;
    }

    const ctxFlag = isExpanded ? "-U99999" : "-U3";
    const commonFlags = ["--no-ext-diff", "--no-textconv", "--no-color", "-M", ctxFlag];
    const parents = Array.isArray(diff?.parentHashes) ? diff.parentHashes.filter(Boolean) : [];
    const pathArgs =
      openFile.oldPath && (openFile.status === "R" || openFile.status === "C")
        ? [openFile.oldPath, openFile.path]
        : [openFile.path];

    let args;
    if (parents.length === 0) {
      args = [...READ_GIT, "show", "--root", "--format=", ...commonFlags, commitHash, "--", ...pathArgs];
    } else {
      args = [...READ_GIT, "diff", ...commonFlags, parents[0], commitHash, "--", ...pathArgs];
    }

    const res = await exec("git", args, { cwd: repoRoot, on, timeout: GIT_EXEC_TIMEOUT_MS });
    if (res.code !== 0) {
      throw new Error(res.stderr || "git diff failed");
    }
    const patchText = res.stdout || "";
    const isBinary =
      /^(?:Binary files .* differ|GIT binary patch)$/m.test(patchText);
    const result = { patchText, isBinary };
    lruSet(this.viewerPatchCache, cacheKey, result, MAX_VIEWER_PATCH_CACHE);
    return result;
  }

  getSbsWrapMetrics() {
    const estColW = Math.max(180, Math.floor(((this.viewerWidth || 960) - DIFF_WAVE_GUTTER_WIDTH - 4) / 2));
    const leftVpW = this.leftViewportW > 0 ? this.leftViewportW : estColW;
    const rightVpW = this.rightViewportW > 0 ? this.rightViewportW : estColW;
    const leftCols = computeWrapColumns({
      viewportWidth: leftVpW,
      gutterWidth: 60,
      rightPadding: 14,
      fontSize: 11.5,
      minCols: 10,
    });
    const rightCols = computeWrapColumns({
      viewportWidth: rightVpW,
      gutterWidth: 62,
      rightPadding: 22,
      fontSize: 11.5,
      minCols: 10,
    });
    const hunkCols = computeWrapColumns({
      viewportWidth: Math.min(leftVpW, rightVpW),
      gutterWidth: 20,
      rightPadding: 14,
      fontSize: 11,
      minCols: 12,
    });
    return { leftCols, rightCols, hunkCols, sig: `${leftCols}|${rightCols}|${hunkCols}` };
  }

  getUnifiedWrapMetrics() {
    const uniVpW = this.unifiedViewportW > 0
      ? this.unifiedViewportW
      : Math.max(260, (this.viewerWidth || 960) - 4);
    const uniCols = computeWrapColumns({
      viewportWidth: uniVpW,
      gutterWidth: 98,
      rightPadding: 22,
      fontSize: 11.5,
      minCols: 10,
    });
    const uniHunkCols = computeWrapColumns({
      viewportWidth: uniVpW,
      gutterWidth: 24,
      rightPadding: 22,
      fontSize: 11,
      minCols: 12,
    });
    return { uniCols, uniHunkCols, sig: `${uniCols}|${uniHunkCols}` };
  }

  recomputeUnifiedRowHeights() {
    const metrics = this.getUnifiedWrapMetrics();
    this._lastUniWrapSig = metrics.sig;
    this.uniRowHeights = computeUnifiedRowHeights(this.uniRows, metrics.uniCols, {
      rowHeight: DIFF_ROW_HEIGHT,
      hunkHeight: DIFF_HUNK_HEIGHT,
      hunkWrapCols: metrics.uniHunkCols,
    });
  }

  buildActiveDiffModeData() {
    const src = this.loadedPatchSource;
    if (!src) return;
    const { patchText, filePath, maxLines } = src;
    if (this.diffMode === "unified") {
      if (this.uniBuilt) return;
      const uni = buildUnifiedRows(patchText, filePath, { maxLines, deferTokens: true });
      this.isBinaryDiff = Boolean(this.isBinaryDiff || uni.isBinary);
      this.uniRows = uni.rows || [];
      this.recomputeUnifiedRowHeights();
      this.diffTruncated = Boolean(this.diffTruncated || uni.truncated);
      this.diffTotalLines = Number(uni.totalLines || this.diffTotalLines || 0);
      this.uniBuilt = true;
    } else {
      if (this.sbsBuilt) return;
      const sbs = buildSideBySideRows(patchText, filePath, { maxLines, deferTokens: true });
      this.isBinaryDiff = Boolean(this.isBinaryDiff || sbs.isBinary);
      this.sbsRows = sbs.rows || [];
      this.diffTruncated = Boolean(this.diffTruncated || sbs.truncated);
      this.diffTotalLines = Number(sbs.totalLines || this.diffTotalLines || 0);
      this.rebuildSbsPageCache();
      this.sbsBuilt = true;
    }
  }

  async loadViewerDiffNow(diff, cx, opts = {}) {
    if (this.viewerLoadTask) {
      try { this.viewerLoadTask.cancel(); } catch {}
      this.viewerLoadTask = null;
    }
    this.viewerScheduledKey = "";

    const gen = ++this.viewerLoadGen;
    const prevOpenKey = this.open;
    const loadKey = computeViewerLoadedKey(diff);
    this.viewerLoadedKey = loadKey;

    const vp = props() || this.viewerProps;
    const requestedMode =
      !this._userSetDiffMode && (vp?.diffMode === "unified" || vp?.diffMode === "side-by-side")
        ? vp.diffMode
        : diff?.diffMode;
    if (requestedMode === "unified" || requestedMode === "side-by-side") {
      if (opts.preserveLocalDiffMode !== true && !this._userSetDiffMode) {
        this.diffMode = requestedMode;
      }
    }

    const files = diff?.files || [];
    const openFile = diff?.openFile || files.find((f) => f.key === diff?.openFileKey) || null;
    this.open = openFile ? openFile.key : null;
    this.viewerError = null;

    if (!openFile) {
      this.loadedPatchSource = null;
      this.loadedFileExt = "";
      this.sbsBuilt = false;
      this.uniBuilt = false;
      this.sbsRows = [];
      this.sbsPage = 0;
      this.sbsPageInfo = paginateDiffRows([], 0, DEFAULT_SBS_PAGE_ROWS);
      this.sbsWaveLayout = null;
      this.sbsBlocks = null;
      this.uniRows = [];
      this.uniRowHeights = [];
      this.isBinaryDiff = false;
      this.diffTruncated = false;
      this.diffTotalLines = 0;
      this.viewerLoading = false;
      cx?.notify();
      this.notifyViewerChildren(cx, "all");
      return;
    }

    const isExpanded = Boolean(diff?.expanded || this.expandedFiles.has(openFile.key));
    if (diff?.expanded && !this.expandedFiles.has(openFile.key)) {
      this.expandedFiles.add(openFile.key);
    }

    if (prevOpenKey !== openFile.key || opts.forceScrollTop) {
      this.sbsPage = 0;
    }

    const maxLines = isExpanded ? EXPANDED_VIEWER_DIFF_LINES : MAX_VIEWER_DIFF_LINES;
    const cacheKey = this.makeViewerPatchCacheKey(diff, openFile, isExpanded);
    const cachedPatch = !opts.forceReload && !openFile.binary ? lruGet(this.viewerPatchCache, cacheKey) : undefined;

    if (openFile.binary || cachedPatch) {
      try {
        const { patchText, isBinary } = openFile.binary
          ? { patchText: "", isBinary: true }
          : cachedPatch;
        if (isBinary || openFile.binary) {
          this.loadedPatchSource = null;
          this.loadedFileExt = "";
          this.sbsBuilt = false;
          this.uniBuilt = false;
          this.isBinaryDiff = true;
          this.sbsRows = [];
          this.sbsPage = 0;
          this.sbsPageInfo = paginateDiffRows([], 0, DEFAULT_SBS_PAGE_ROWS);
          this.sbsWaveLayout = null;
          this.sbsBlocks = null;
          this.uniRows = [];
          this.uniRowHeights = [];
          this.diffTruncated = false;
          this.diffTotalLines = 0;
        } else {
          this.sbsBuilt = false;
          this.uniBuilt = false;
          this.sbsRows = [];
          this.sbsWaveLayout = null;
          this.sbsBlocks = null;
          this.uniRows = [];
          this.uniRowHeights = [];
          this.isBinaryDiff = false;
          this.diffTruncated = false;
          this.diffTotalLines = 0;
          this.loadedPatchSource = { patchText, filePath: openFile.path, maxLines };
          this.loadedFileExt = getFileExt(openFile.path);
          this.buildActiveDiffModeData();
        }
        if (prevOpenKey !== openFile.key || opts.forceScrollTop) {
          try { this.diffScroll?.scroll_to_item(0); } catch {}
          try { this.uniScroll?.scroll_to_item(0); } catch {}
        }
      } catch (e) {
        this.loadedPatchSource = null;
        this.loadedFileExt = "";
        this.sbsBuilt = false;
        this.uniBuilt = false;
        this.sbsRows = [];
        this.sbsPage = 0;
        this.sbsPageInfo = paginateDiffRows([], 0, DEFAULT_SBS_PAGE_ROWS);
        this.sbsWaveLayout = null;
        this.sbsBlocks = null;
        this.uniRows = [];
        this.uniRowHeights = [];
        this.viewerError = `Cannot load diff: ${e?.message || e}`;
      } finally {
        this.viewerLoading = false;
        cx?.notify();
        this.notifyViewerChildren(cx, "all");
      }
      return;
    }

    this.viewerLoading = true;
    cx?.notify();

    try {
      const { patchText, isBinary } = await this.fetchCommitFilePatch(diff, openFile, isExpanded, opts);
      if (gen !== this.viewerLoadGen) return;

      if (isBinary || openFile.binary) {
        this.loadedPatchSource = null;
        this.loadedFileExt = "";
        this.sbsBuilt = false;
        this.uniBuilt = false;
        this.isBinaryDiff = true;
        this.sbsRows = [];
        this.sbsPage = 0;
        this.sbsPageInfo = paginateDiffRows([], 0, DEFAULT_SBS_PAGE_ROWS);
        this.sbsWaveLayout = null;
        this.sbsBlocks = null;
        this.uniRows = [];
        this.uniRowHeights = [];
        this.diffTruncated = false;
        this.diffTotalLines = 0;
      } else {
        this.sbsBuilt = false;
        this.uniBuilt = false;
        this.sbsRows = [];
        this.sbsWaveLayout = null;
        this.uniRows = [];
        this.uniRowHeights = [];
        this.isBinaryDiff = false;
        this.diffTruncated = false;
        this.diffTotalLines = 0;
        this.loadedPatchSource = { patchText, filePath: openFile.path, maxLines };
        this.loadedFileExt = getFileExt(openFile.path);
        this.buildActiveDiffModeData();
      }

      if (prevOpenKey !== openFile.key || opts.forceScrollTop) {
        try { this.diffScroll?.scroll_to_item(0); } catch {}
        try { this.uniScroll?.scroll_to_item(0); } catch {}
      }
    } catch (e) {
      if (gen !== this.viewerLoadGen) return;
      this.loadedPatchSource = null;
      this.loadedFileExt = "";
      this.sbsBuilt = false;
      this.uniBuilt = false;
      this.sbsRows = [];
      this.sbsPage = 0;
      this.sbsPageInfo = paginateDiffRows([], 0, DEFAULT_SBS_PAGE_ROWS);
      this.sbsWaveLayout = null;
      this.sbsBlocks = null;
      this.uniRows = [];
      this.uniRowHeights = [];
      this.viewerError = `Cannot load diff: ${e?.message || e}`;
    } finally {
      if (gen === this.viewerLoadGen) {
        this.viewerLoading = false;
        cx?.notify();
        this.notifyViewerChildren(cx, "all");
      }
    }
  }

  rebuildSbsPageCache() {
    const pageInfo = paginateDiffRows(this.sbsRows, this.sbsPage, DEFAULT_SBS_PAGE_ROWS);
    this.sbsPage = pageInfo.pageIndex;
    this.sbsPageInfo = pageInfo;
    tokenizeSideBySidePage(pageInfo.rows, this.loadedFileExt);
    const wrapMetrics = this.getSbsWrapMetrics();
    this._lastSbsWrapSig = wrapMetrics.sig;
    this.sbsWaveLayout = buildWaveDiffLayout(pageInfo.rows, {
      rowHeight: DIFF_ROW_HEIGHT,
      hunkHeight: DIFF_HUNK_HEIGHT,
      leftCols: wrapMetrics.leftCols,
      rightCols: wrapMetrics.rightCols,
      hunkCols: wrapMetrics.hunkCols,
    });
    this.sbsBlocks = buildWaveDiffBlocks(this.sbsWaveLayout);
  }

  setSbsPage(nextPage, cx) {
    this.sbsPage = nextPage;
    this.rebuildSbsPageCache();
    try { this.diffScroll?.scroll_to_item(0); } catch {}
    cx?.notify();
  }

  openViewerFileInPlace(nextFile, diff, ctx, cx, overrides = {}) {
    if (!nextFile) return null;
    const files = diff?.files || [];
    const nextSeq = Math.max(diff?.requestSeq || 0, this.lastRequestSeq || 0) + 1;
    this.lastRequestSeq = nextSeq;
    const expanded = overrides.expanded !== undefined
      ? Boolean(overrides.expanded)
      : this.expandedFiles.has(nextFile.key);

    const nextPayload = {
      ...diff,
      spaceId: ctx.spaceId,
      sourceTabId: ctx.sourceTabId || diff?.sourceTabId || null,
      diffMode: overrides.diffMode ?? this.diffMode ?? diff?.diffMode ?? "side-by-side",
      openFileKey: nextFile.key,
      openFile: nextFile,
      files,
      expanded,
      requestSeq: nextSeq,
      ts: Date.now(),
    };
    writeActiveDiff(ctx.spaceId, nextPayload);
    const existing = findGitDiffTabInSpace(ctx.spaceId);
    if (existing) {
      const title = formatGitTabTitle(
        { shortHash: diff?.shortHash, hash: diff?.commitHash },
        nextFile
      );
      run("tab.rename", { id: existing.tabId, name: title });
    }
    this.loadViewerDiffNow(nextPayload, cx, { forceScrollTop: true, preserveLocalDiffMode: true });
    return nextPayload;
  }

  stepViewerFile(delta, cx) {
    const ctx = this.getSessionContext();
    const diff = readActiveDiff(ctx.spaceId);
    const files = diff?.files || [];
    if (files.length <= 1) return;
    const curIdx = files.findIndex((f) => f.key === diff?.openFileKey);
    const nextIdx = curIdx >= 0 ? (curIdx + delta + files.length) % files.length : 0;
    const nextFile = files[nextIdx];
    if (nextFile) {
      this.openViewerFileInPlace(nextFile, diff, ctx, cx);
    }
  }

  toggleViewerExpand(diff, openFile, cx) {
    if (!openFile || this.viewerLoading) return;
    const key = openFile.key;
    const nextExpanded = !this.expandedFiles.has(key);
    if (nextExpanded) this.expandedFiles.add(key);
    else this.expandedFiles.delete(key);

    const ctx = this.getSessionContext();
    const nextSeq = Math.max(diff?.requestSeq || 0, this.lastRequestSeq || 0) + 1;
    this.lastRequestSeq = nextSeq;
    const nextPayload = {
      ...diff,
      expanded: nextExpanded,
      requestSeq: nextSeq,
      ts: Date.now(),
    };
    writeActiveDiff(ctx.spaceId, nextPayload);
    this.loadViewerDiffNow(nextPayload, cx, { preserveLocalDiffMode: true });
  }

  setViewerDiffMode(mode, diff, cx) {
    if (mode !== "side-by-side" && mode !== "unified") return;
    this._userSetDiffMode = true;
    this.diffMode = mode;
    this.buildActiveDiffModeData();
    const ctx = this.getSessionContext();
    if (diff) {
      writeActiveDiff(ctx.spaceId, {
        ...diff,
        diffMode: mode,
        ts: Date.now(),
      });
    }
    try { this.diffScroll?.scroll_to_item(0); } catch {}
    try { this.uniScroll?.scroll_to_item(0); } catch {}
    cx.notify();
    this.notifyViewerChildren(cx, "all");
  }

  scheduleDiffResizeReflow(cx) {
    const runReflow = (cxRef) => {
      this.diffResizeTask = null;
      if (this.diffMode === "unified") {
        if (this.uniBuilt && this.getUnifiedWrapMetrics().sig !== this._lastUniWrapSig) {
          this.recomputeUnifiedRowHeights();
          try { cxRef?.notify(); } catch {}
          this.notifyViewerChildren(cxRef, ["unified"]);
        }
        return;
      }
      if (this.sbsBuilt && this.getSbsWrapMetrics().sig !== this._lastSbsWrapSig) {
        this.rebuildSbsPageCache();
        try { cxRef?.notify(); } catch {}
      }
    };

    if (this.diffResizeTask) {
      try { this.diffResizeTask.cancel(); } catch {}
      this.diffResizeTask = null;
    }
    const timer = cx?.timer || this.hostCx?.timer;
    if (timer) {
      this.diffResizeTask = timer.after(16, (timerCx) => runReflow(timerCx || cx || this.hostCx));
    } else {
      runReflow(cx || this.hostCx);
    }
  }

  updateDiffViewportWidth(side, size, cx) {
    const nextW = Math.round(Number(size?.width) || 0);
    if (nextW <= 0) return;

    if (side === "unified") {
      if (Math.abs(nextW - (this.unifiedViewportW || 0)) <= 4) return;
      this.unifiedViewportW = nextW;
      if (this.uniBuilt && this.getUnifiedWrapMetrics().sig !== this._lastUniWrapSig) {
        this.scheduleDiffResizeReflow(cx);
      }
      return;
    }

    const key = side === "right" ? "rightViewportW" : "leftViewportW";
    if (Math.abs(nextW - (this[key] || 0)) <= 4) return;
    this[key] = nextW;
    if (this.sbsBuilt && this.getSbsWrapMetrics().sig !== this._lastSbsWrapSig) {
      this.scheduleDiffResizeReflow(cx);
    }
  }

  getWrappedCodeData(cacheKeyObj, tokens, plainText, syntaxPalette, fallbackColor, wrapCols) {
    const pal = syntaxPalette && syntaxPalette._isSyntaxPalette
      ? syntaxPalette
      : getDiffSyntaxPalette(syntaxPalette);
    const cols = Number.isFinite(Number(wrapCols)) && Number(wrapCols) > 0 ? Math.floor(Number(wrapCols)) : 0;
    const bakeKey = `${pal._sig || ""}|${fallbackColor}|${cols}`;
    const cacheable = cacheKeyObj && typeof cacheKeyObj === "object";
    let baked = cacheable ? lineBakeCache.get(cacheKeyObj) : null;
    if (!baked || baked.key !== bakeKey) {
      const segments = prepareWrappedRenderLines(
        tokens,
        plainText,
        pal,
        fallbackColor,
        cols,
        MAX_RENDER_TOKENS_PER_LINE
      );
      baked = { key: bakeKey, segments };
      if (cacheable) {
        lineBakeCache.set(cacheKeyObj, baked);
      }
    }
    return baked.segments;
  }

  renderSegmentData(data, fillWidth = false) {
    if (!data || data.kind === "single") {
      const el = div()
        .whitespace_nowrap()
        .text_color(data?.color)
        .child(data?.text || "\u00a0");
      return fillWidth ? el.flex_1().min_w(0).overflow_hidden() : el.flex_none();
    }
    const spans = data.spans;
    const spanEls = new Array(spans.length);
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i];
      spanEls[i] = div()
        .flex_none()
        .whitespace_nowrap()
        .text_color(sp[0])
        .child(sp[1]);
    }
    const el = h_flex().items_center().children(spanEls);
    return fillWidth ? el.flex_1().min_w(0).overflow_hidden() : el.flex_none().whitespace_nowrap();
  }

  renderWaveSideItem(item, side, t, dt, syntaxPalette, wrapCols, hunkCols) {
    if (item.type === "hunk") {
      const effectiveHunkCols = item.wrapCols || hunkCols || 72;
      let headerLines = ["\u00a0"];
      if (side === "left" && item.header) {
        const hKey = `${item.header}|${effectiveHunkCols}`;
        let cached = lineBakeCache.get(item);
        if (!cached || cached.key !== hKey) {
          const expanded = expandCodeTabs(item.header);
          const wrapped = wrapPlainText(expanded, effectiveHunkCols, { toNbsp: true });
          cached = { key: hKey, lines: wrapped.map((s) => s || "\u00a0") };
          lineBakeCache.set(item, cached);
        }
        headerLines = cached.lines;
      }
      return v_flex()
        .w_full()
        .h(item.height)
        .flex_none()
        .px(10)
        .py(2)
        .justify_center()
        .overflow_hidden()
        .bg(t.raised)
        .border_t(1)
        .border_b(1)
        .border_color(t.border)
        .children(
          headerLines.map((lineText) =>
            div()
              .w_full()
              .min_w(0)
              .text_size(11)
              .text_color(t.dim)
              .whitespace_nowrap()
              .child(lineText)
          )
        );
    }

    if (item.type === "spacer") {
      const seamCol = item.markerKind === "add" ? dt.add : item.markerKind === "del" ? dt.del : null;
      let spacer = div()
        .w_full()
        .h(item.height)
        .flex_none()
        .relative()
        .bg(t.background);
      if (item.markerOffsetY != null && seamCol) {
        spacer = spacer.child(
          div()
            .absolute()
            .left_0()
            .right_0()
            .top(Math.max(0, item.markerOffsetY))
            .h(1)
            .bg(hexWithAlpha(seamCol, "28"))
        );
      }
      return spacer;
    }

    const cell = item.cell;
    const kind = cell?.kind || "ctx";
    const isAdd = kind === "add";
    const isDel = kind === "del";
    const diffColor = isAdd ? dt.add : isDel ? dt.del : null;
    const rowBg = isAdd ? dt.addBg : isDel ? dt.delBg : null;
    const gutterSign = isAdd ? "+" : isDel ? "-" : " ";
    const segments = this.getWrappedCodeData(
      cell,
      cell?.tokens,
      cell?.text || "",
      syntaxPalette,
      diffColor || t.foreground,
      wrapCols
    );

    const buildSubRow = (segData, isFirstSeg, attachOuterDecor) => {
      let rowEl = h_flex()
        .w_full()
        .h(DIFF_ROW_HEIGHT)
        .flex_none()
        .items_center()
        .gap(6)
        .pr(side === "right" ? 14 : 10);
      if (attachOuterDecor) {
        if (side === "left") {
          rowEl = rowEl.border_l(2).border_color(diffColor || t.background);
        } else {
          rowEl = rowEl.pl(4);
        }
        if (rowBg) rowEl = rowEl.bg(rowBg);
      }
      return rowEl
        .child(
          div()
            .w(36)
            .flex_none()
            .text_right()
            .text_color(diffColor || t.dim)
            .child(isFirstSeg && cell?.lineNo != null ? String(cell.lineNo) : "\u00a0")
        )
        .child(
          div()
            .w(10)
            .flex_none()
            .text_center()
            .font_semibold()
            .text_color(diffColor || t.dim)
            .child(isFirstSeg ? gutterSign : "\u00a0")
        )
        .child(this.renderSegmentData(segData, true));
    };

    if (segments.length <= 1 && item.height === DIFF_ROW_HEIGHT) {
      return buildSubRow(segments[0], true, true);
    }

    let wrapper = v_flex()
      .w_full()
      .h(item.height)
      .flex_none()
      .overflow_hidden();
    if (side === "left") {
      wrapper = wrapper.border_l(2).border_color(diffColor || t.background);
    } else {
      wrapper = wrapper.pl(4);
    }
    if (rowBg) {
      wrapper = wrapper.bg(rowBg);
    }
    const subRows = new Array(segments.length);
    for (let i = 0; i < segments.length; i++) {
      subRows[i] = buildSubRow(segments[i], i === 0, false);
    }
    return wrapper.children(subRows);
  }

  renderWaveGutterBlock(item, t, waveBrushes) {
    const W = DIFF_WAVE_GUTTER_WIDTH;
    const midX = W * 0.5;
    const centerLineX = Math.floor(W / 2);

    if (!item || item.type === "hunk") {
      return div()
        .w(W)
        .h(item?.height || DIFF_HUNK_HEIGHT)
        .flex_none()
        .bg(t.raised)
        .border_t(1)
        .border_b(1)
        .border_color(t.border);
    }

    if (item.type === "ctx") {
      return div()
        .w(W)
        .h(item.height)
        .flex_none()
        .relative()
        .bg(t.background)
        .child(div().absolute().left(centerLineX).top_0().bottom_0().w(1).bg(waveBrushes.centerDividerCol));
    }

    let cachedPaths = waveGutterPathCache.get(item);
    if (!cachedPaths) {
      const fillPath = PathBuilder.fill()
        .move_to(0, item.leftTop)
        .cubic_bezier_to(W, item.rightTop, midX, item.leftTop, midX, item.rightTop)
        .line_to(W, item.rightBot)
        .cubic_bezier_to(0, item.leftBot, midX, item.rightBot, midX, item.leftBot)
        .close()
        .build();

      let strokePath = null;
      const isCurved = item.leftTop !== item.rightTop || item.leftBot !== item.rightBot;
      if (isCurved) {
        if (item.leftTop === item.leftBot) {
          strokePath = PathBuilder.stroke(1)
            .move_to(W, item.rightTop)
            .cubic_bezier_to(0, item.leftTop, midX, item.rightTop, midX, item.leftTop)
            .cubic_bezier_to(W, item.rightBot, midX, item.leftBot, midX, item.rightBot)
            .build();
        } else if (item.rightTop === item.rightBot) {
          strokePath = PathBuilder.stroke(1)
            .move_to(0, item.leftTop)
            .cubic_bezier_to(W, item.rightTop, midX, item.leftTop, midX, item.rightTop)
            .cubic_bezier_to(0, item.leftBot, midX, item.rightBot, midX, item.rightBot)
            .build();
        } else {
          strokePath = PathBuilder.stroke(1)
            .move_to(0, item.leftTop)
            .cubic_bezier_to(W, item.rightTop, midX, item.leftTop, midX, item.rightTop)
            .move_to(0, item.leftBot)
            .cubic_bezier_to(W, item.rightBot, midX, item.leftBot, midX, item.rightBot)
            .build();
        }
      }
      cachedPaths = { fillPath, strokePath };
      waveGutterPathCache.set(item, cachedPaths);
    }

    let fillBg;
    let edgeBg;
    if (item.kind === "mod") {
      fillBg = waveBrushes.modFill;
      edgeBg = waveBrushes.modEdge;
    } else if (item.kind === "add") {
      fillBg = waveBrushes.addFill;
      edgeBg = waveBrushes.addEdge;
    } else {
      fillBg = waveBrushes.delFill;
      edgeBg = waveBrushes.delEdge;
    }

    let waveEl = div()
      .w(W)
      .h(item.height)
      .flex_none()
      .relative()
      .overflow_hidden()
      .bg(t.background)
      .child(window.paint_path(cachedPaths.fillPath, fillBg).absolute().inset_0());
    if (cachedPaths.strokePath) {
      waveEl = waveEl.child(window.paint_path(cachedPaths.strokePath, edgeBg).absolute().inset_0());
    }
    return waveEl;
  }

  renderSbsSideSlice(items, side, t, dt, syntaxPalette, wrapCols, hunkCols) {
    if (!items || items.length === 0) {
      return div().flex_1().min_w(0).h_full().bg(t.background);
    }
    if (items.length === 1) {
      return div()
        .flex_1()
        .min_w(0)
        .h_full()
        .overflow_hidden()
        .child(this.renderWaveSideItem(items[0], side, t, dt, syntaxPalette, wrapCols, hunkCols));
    }
    const children = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      children[i] = this.renderWaveSideItem(items[i], side, t, dt, syntaxPalette, wrapCols, hunkCols);
    }
    return v_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .overflow_hidden()
      .children(children);
  }

  renderSbsBlock(block, t, dt, syntaxPalette, waveBrushes, wrapMetrics) {
    return h_flex()
      .w_full()
      .h(block.height)
      .min_w(0)
      .items_start()
      .child(this.renderSbsSideSlice(block.leftItems, "left", t, dt, syntaxPalette, wrapMetrics.leftCols, wrapMetrics.hunkCols))
      .child(this.renderWaveGutterBlock(block.gutter, t, waveBrushes))
      .child(this.renderSbsSideSlice(block.rightItems, "right", t, dt, syntaxPalette, wrapMetrics.rightCols, wrapMetrics.hunkCols));
  }

  renderUnifiedPaneContent() {
    if (!this.uniRows || this.uniRows.length === 0) {
      return div().size_full();
    }
    const t = theme();
    const { dt, syntaxPalette } = getThemeBundle(t);
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const { uniCols, uniHunkCols } = this.getUnifiedWrapMetrics();
    const ext = this.loadedFileExt || "";
    return div()
      .id("git-diff-unified-pane")
      .size_full()
      .min_w(0)
      .relative()
      .font_family(mono)
      .text_size(11.5)
      .child(
        v_virtual_list(
          "git-diff-unified-y",
          this.uniRows.length,
          this.uniRowHeights,
          (index) => `u-${index}`,
          (range) => {
            const rows = [];
            for (let i = range.start; i < range.end; i++) {
              rows.push(
                this.renderUnifiedRow(
                  this.uniRows[i],
                  t,
                  dt,
                  syntaxPalette,
                  ext,
                  uniCols,
                  uniHunkCols,
                  this.uniRowHeights[i]
                )
              );
            }
            return rows;
          }
        )
          .size_full()
          .track_scroll(this.uniScroll)
      )
      .child(Scrollbar.vertical("git-diff-unified-y").viewport_from_layout().absolute().inset_0());
  }

  renderUnifiedRow(row, t, dt, syntaxPalette, ext, uniCols, uniHunkCols, expectedH) {
    if (row.kind === "hunk" || row.kind === "@") {
      const rawHeader = row.header ?? row.text ?? "";
      const hCols = uniHunkCols || 72;
      const hKey = `${rawHeader}|${hCols}`;
      let cached = lineBakeCache.get(row);
      if (!cached || cached.key !== hKey) {
        const expanded = expandCodeTabs(rawHeader);
        const wrapped = wrapPlainText(expanded, hCols, { toNbsp: true });
        cached = { key: hKey, lines: wrapped.map((s) => s || "\u00a0") };
        lineBakeCache.set(row, cached);
      }
      const boxH = expectedH || Math.max(DIFF_HUNK_HEIGHT, cached.lines.length * DIFF_ROW_HEIGHT);
      return v_flex()
        .w_full()
        .h(boxH)
        .flex_none()
        .px(12)
        .py(2)
        .justify_center()
        .overflow_hidden()
        .bg(t.raised)
        .border_t(1)
        .border_b(1)
        .border_color(t.border)
        .children(
          cached.lines.map((lineText) =>
            div()
              .w_full()
              .min_w(0)
              .text_size(11)
              .text_color(t.dim)
              .whitespace_nowrap()
              .child(lineText)
          )
        );
    }

    tokenizeDeferredRow(row, ext);
    const isAdd = row.kind === "add" || row.kind === "+";
    const isDel = row.kind === "del" || row.kind === "-";
    const diffColor = isAdd ? dt.add : isDel ? dt.del : null;
    const rowBg = isAdd ? dt.addBg : isDel ? dt.delBg : null;
    const gutterSign = isAdd ? "+" : isDel ? "-" : " ";
    const oldNo = row.oldLineNo !== undefined ? row.oldLineNo : (isAdd ? null : (row.lineNo ?? row.number ?? null));
    const newNo = row.newLineNo !== undefined ? row.newLineNo : (isDel ? null : (row.lineNo ?? row.number ?? null));
    const segments = this.getWrappedCodeData(
      row,
      row.tokens,
      row.text || "",
      syntaxPalette,
      diffColor || t.foreground,
      uniCols
    );

    const buildSubRow = (segData, isFirstSeg, attachOuterDecor) => {
      let rowEl = h_flex()
        .w_full()
        .h(DIFF_ROW_HEIGHT)
        .flex_none()
        .items_center()
        .gap(6)
        .pr(14);
      if (attachOuterDecor) {
        rowEl = rowEl.border_l(2).border_color(diffColor || t.background);
        if (rowBg) rowEl = rowEl.bg(rowBg);
      }
      return rowEl
        .child(
          div()
            .w(34)
            .flex_none()
            .text_right()
            .text_color(isDel ? dt.del : t.dim)
            .child(isFirstSeg && oldNo != null ? String(oldNo) : "\u00a0")
        )
        .child(
          div()
            .w(34)
            .flex_none()
            .text_right()
            .text_color(isAdd ? dt.add : t.dim)
            .child(isFirstSeg && newNo != null ? String(newNo) : "\u00a0")
        )
        .child(
          div()
            .w(10)
            .flex_none()
            .text_center()
            .font_semibold()
            .text_color(diffColor || t.dim)
            .child(isFirstSeg ? gutterSign : "\u00a0")
        )
        .child(this.renderSegmentData(segData, true));
    };

    const totalH = expectedH || segments.length * DIFF_ROW_HEIGHT;
    if (segments.length <= 1 && totalH === DIFF_ROW_HEIGHT) {
      return buildSubRow(segments[0], true, true);
    }

    let wrapper = v_flex()
      .w_full()
      .h(totalH)
      .flex_none()
      .overflow_hidden()
      .border_l(2)
      .border_color(diffColor || t.background);
    if (rowBg) {
      wrapper = wrapper.bg(rowBg);
    }
    const subRows = new Array(segments.length);
    for (let i = 0; i < segments.length; i++) {
      subRows[i] = buildSubRow(segments[i], i === 0, false);
    }
    return wrapper.children(subRows);
  }

  renderViewer(cx) {
    const t = theme();
    const { dt, syntaxPalette, waveBrushes } = getThemeBundle(t);
    const mono = settings()?.font_family ?? "JetBrains Mono";

    const ctx = this.getSessionContext();
    const diff = readActiveDiff(ctx.spaceId);
    const desiredKey = computeViewerLoadedKey(diff);
    if (desiredKey !== this.viewerLoadedKey && desiredKey !== this.viewerScheduledKey) {
      this.scheduleViewerLoad(diff, cx);
    }

    const files = diff?.files || [];
    const openFile = diff?.openFile || files.find((f) => f.key === diff?.openFileKey) || null;
    const openKey = openFile?.key || diff?.openFileKey || null;
    const fileIdx = openKey ? files.findIndex((f) => f.key === openKey) : -1;
    const canStep = files.length > 1;
    const isExpanded = Boolean(openKey && (diff?.expanded || this.expandedFiles.has(openKey)));
    const fileIcon = openFile ? resolveGitFileIcon(openFile.path || openFile.displayPath, t) : null;
    const shortHash = diff?.shortHash || (diff?.commitHash ? diff.commitHash.slice(0, 7) : "");
    const parents = Array.isArray(diff?.parentHashes) ? diff.parentHashes.filter(Boolean) : [];
    const parentLabel =
      parents.length === 0
        ? "root / empty"
        : parents.length > 1
          ? `${parents[0].slice(0, 7)} (1st parent)`
          : parents[0].slice(0, 7);
    const beforeLabel = openFile?.status === "A" || parents.length === 0 ? "empty" : parentLabel;
    const compactViewer = (this.viewerWidth || 960) < 700;
    const relTime = diff?.commitTimestamp ? formatRelativeTime(diff.commitTimestamp) : "";

    return v_flex()
      .id("git-diff-tab-viewer")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .relative()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const w = Math.round(size?.width || 0);
        if (w <= 0) return;
        const prevW = this.viewerWidth || 960;
        if (Math.abs(w - prevW) > 12) {
          const compactChanged = (prevW < 700) !== (w < 700);
          const unmeasured =
            this.diffMode === "unified"
              ? !this.unifiedViewportW
              : (!this.leftViewportW || !this.rightViewportW);
          this.viewerWidth = w;
          if (compactChanged || unmeasured) {
            cx.notify();
          }
        }
      })
      // Toolbar
      .child(
        (compactViewer ? v_flex() : h_flex().flex_wrap())
          .id("git-diff-toolbar")
          .min_h(40)
          .flex_none()
          .px(12)
          .py(6)
          .gap(8)
          .when(!compactViewer, (b) => b.items_center().justify_between())
          .border_b(1)
          .border_color(t.border)
          .bg(t.raised)
          .child(
            h_flex()
              .when(!compactViewer, (b) => b.flex_1().min_w(180))
              .when(compactViewer, (b) => b.w_full().min_w(0))
              .gap(6)
              .items_center()
              .when(Boolean(diff?.repoName), (b) =>
                b.child(
                  div()
                    .flex_none()
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .bg(t.background)
                    .border_1()
                    .border_color(t.border)
                    .text_size(10)
                    .font_medium()
                    .text_color(t.muted)
                    .child(diff.repoName)
                )
              )
              .when(Boolean(shortHash), (b) =>
                b.child(
                  div()
                    .flex_none()
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .bg(t.background)
                    .border_1()
                    .border_color(t.border)
                    .font_family(mono)
                    .text_size(10)
                    .text_color(t.accent || t.foreground)
                    .child(shortHash)
                )
              )
              .when(Boolean(openFile), (b) =>
                b
                  .child(
                    div()
                      .flex_none()
                      .w(14)
                      .text_center()
                      .text_size(11)
                      .font_semibold()
                      .text_color(parseStatusColor(openFile.status, t, dt))
                      .child(openFile.status || "M")
                  )
                  .when(Boolean(fileIcon), (el) =>
                    el.child(svg(fileIcon.path).size(14).flex_none().text_color(fileIcon.color))
                  )
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(12)
                      .font_medium()
                      .text_color(t.foreground)
                      .child(openFile.displayPath || openFile.path || "")
                  )
                  .when(openFile.binary, (el) =>
                    el.child(
                      div()
                        .flex_none()
                        .px(4)
                        .py(0.5)
                        .rounded(3)
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_size(9.5)
                        .text_color(t.muted)
                        .child("BIN")
                    )
                  )
                  .when(!openFile.binary && (openFile.added || 0) > 0, (el) =>
                    el.child(div().flex_none().text_size(11).text_color(dt.add).child(`+${openFile.added}`))
                  )
                  .when(!openFile.binary && (openFile.deleted || 0) > 0, (el) =>
                    el.child(div().flex_none().text_size(11).text_color(dt.del).child(`−${openFile.deleted}`))
                  )
              )
              .when(!openFile, (b) =>
                b.child(div().text_size(12).text_color(t.muted).child("Git Commit Comparison"))
              )
          )
          .child(
            h_flex()
              .flex_none()
              .flex_wrap()
              .gap(6)
              .items_center()
              .when(files.length > 0, (b) =>
                b.child(
                  h_flex()
                    .flex_none()
                    .gap(4)
                    .items_center()
                    .child(
                      h_flex()
                        .id("git-diff-prev")
                        .h(24)
                        .w(24)
                        .items_center()
                        .justify_center()
                        .rounded(5)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .text_size(11.5)
                        .text_color(canStep ? t.foreground : t.dim)
                        .when(canStep, (p) =>
                          p
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => this.stepViewerFile(-1, cx))
                        )
                        .tooltip("Previous file in commit")
                        .child("←")
                    )
                    .when(fileIdx >= 0, (p) =>
                      p.child(
                        div()
                          .flex_none()
                          .px(3)
                          .text_size(10.5)
                          .text_color(t.muted)
                          .child(`${fileIdx + 1}/${files.length}`)
                      )
                    )
                    .child(
                      h_flex()
                        .id("git-diff-next")
                        .h(24)
                        .w(24)
                        .items_center()
                        .justify_center()
                        .rounded(5)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.background)
                        .text_size(11.5)
                        .text_color(canStep ? t.foreground : t.dim)
                        .when(canStep, (p) =>
                          p
                            .cursor_pointer()
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => this.stepViewerFile(1, cx))
                        )
                        .tooltip("Next file in commit")
                        .child("→")
                    )
                )
              )
              .when(Boolean(openFile) && !openFile?.binary && !this.isBinaryDiff, (b) =>
                b.child(
                  h_flex()
                    .id("git-diff-expand")
                    .h(24)
                    .px(8)
                    .items_center()
                    .rounded(5)
                    .border_1()
                    .border_color(isExpanded ? (t.accent || t.border) : t.border)
                    .bg(isExpanded ? t.selected : t.background)
                    .text_size(11)
                    .text_color(isExpanded ? t.foreground : t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .tooltip(isExpanded ? "Show standard 3-line diff context" : "Expand full file context")
                    .on_click((_e, cx) => this.toggleViewerExpand(diff, openFile, cx))
                    .child(isExpanded ? "Collapse" : "Expand")
                )
              )
              .child(
                h_flex()
                  .h(24)
                  .rounded(5)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .overflow_hidden()
                  .items_center()
                  .child(
                    h_flex()
                      .id("git-mode-sbs")
                      .h_full()
                      .px(8)
                      .items_center()
                      .cursor_pointer()
                      .text_size(11)
                      .when(this.diffMode === "side-by-side", (el) =>
                        el.bg(t.selected).text_color(t.foreground).font_medium()
                      )
                      .when(this.diffMode !== "side-by-side", (el) =>
                        el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
                      )
                      .on_click((_e, cx) => this.setViewerDiffMode("side-by-side", diff, cx))
                      .child("Side-by-Side")
                  )
                  .child(div().w(1).h_full().bg(t.border))
                  .child(
                    h_flex()
                      .id("git-mode-unified")
                      .h_full()
                      .px(8)
                      .items_center()
                      .cursor_pointer()
                      .text_size(11)
                      .when(this.diffMode === "unified", (el) =>
                        el.bg(t.selected).text_color(t.foreground).font_medium()
                      )
                      .when(this.diffMode !== "unified", (el) =>
                        el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
                      )
                      .on_click((_e, cx) => this.setViewerDiffMode("unified", diff, cx))
                      .child("Unified")
                  )
              )
              .child(
                h_flex()
                  .id("git-diff-refresh")
                  .h(24)
                  .w(24)
                  .items_center()
                  .justify_center()
                  .rounded(5)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .text_size(12)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Reload diff")
                  .on_click((_e, cx) => this.loadViewerDiffNow(diff, cx, { preserveLocalDiffMode: true, forceReload: true }))
                  .child("↻")
              )
          )
      )
      // Commit summary strip
      .when(Boolean(diff?.commitHash), (el) =>
        el.child(
          h_flex()
            .id("git-diff-commit-bar")
            .flex_none()
            .px(12)
            .py(5)
            .gap(8)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .bg(t.chrome)
            .text_size(11)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_color(t.foreground)
                .child(diff.commitSubject || "(no commit message)")
            )
            .when(Boolean(diff?.commitAuthor), (b) =>
              b.child(div().flex_none().text_color(t.muted).child(diff.commitAuthor))
            )
            .when(Boolean(relTime), (b) =>
              b.child(div().flex_none().text_color(t.dim).child(relTime))
            )
            .child(
              div()
                .flex_none()
                .font_family(mono)
                .text_size(10.5)
                .text_color(t.dim)
                .child(parents.length > 0 ? `parent ${parents.map((p) => p.slice(0, 7)).join(" ")}` : "root commit")
            )
        )
      )
      .when(Boolean(this.viewerError), (el) =>
        el.child(
          div()
            .flex_none()
            .px(12)
            .py(6)
            .border_b(1)
            .border_color(t.border)
            .text_size(11)
            .text_color(dt.del)
            .child(this.viewerError)
        )
      )
      .when(this.diffTruncated, (el) =>
        el.child(
          div()
            .flex_none()
            .px(12)
            .py(4)
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .text_size(11)
            .text_color(t.dim)
            .child(`Diff output truncated (${this.diffTotalLines} total lines shown up to limit)`)
        )
      )
      // Main comparison body
      .when(!openFile, (el) =>
        el.child(
          h_flex()
            .flex_1()
            .min_h(0)
            .items_center()
            .justify_center()
            .child(
              div()
                .text_size(12)
                .text_color(t.dim)
                .child(
                  diff?.commitHash && files.length === 0
                    ? "No file changes in this commit"
                    : "Select a commit and file in the Git panel to compare Before | After"
                )
            )
        )
      )
      .when(Boolean(openFile) && this.viewerLoading && this.sbsRows.length === 0 && this.uniRows.length === 0, (el) =>
        el.child(
          h_flex()
            .flex_1()
            .min_h(0)
            .items_center()
            .justify_center()
            .child(div().text_size(12).text_color(t.dim).child("Loading diff…"))
        )
      )
      .when(Boolean(openFile) && !this.viewerLoading && (this.isBinaryDiff || openFile.binary), (el) =>
        el.child(
          v_flex()
            .flex_1()
            .min_h(0)
            .items_center()
            .justify_center()
            .gap(8)
            .when(Boolean(fileIcon), (b) => b.child(svg(fileIcon.path).size(28).text_color(fileIcon.color)))
            .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(openFile.displayPath || openFile.path))
            .child(
              div()
                .text_size(11.5)
                .text_color(t.dim)
                .child(`Binary file (${openFile.status || "M"}) — no text diff available`)
            )
        )
      )
      .when(
        Boolean(openFile) &&
          !this.isBinaryDiff &&
          !openFile.binary &&
          this.diffMode === "side-by-side" &&
          !(this.viewerLoading && this.sbsRows.length === 0),
        (el) => {
          const sbsPageInfo =
            this.sbsPageInfo && this.sbsPageInfo.totalRows === this.sbsRows.length && this.sbsPageInfo.pageIndex === this.sbsPage
              ? this.sbsPageInfo
              : paginateDiffRows(this.sbsRows, this.sbsPage, DEFAULT_SBS_PAGE_ROWS);
          const pageRows = sbsPageInfo.rows;
          return el
            .when(sbsPageInfo.totalPages > 1, (p) =>
              p.child(
                h_flex()
                  .id("git-diff-sbs-pager")
                  .h(28)
                  .flex_none()
                  .px(12)
                  .gap(8)
                  .items_center()
                  .justify_between()
                  .border_b(1)
                  .border_color(t.border)
                  .bg(t.raised)
                  .text_size(11)
                  .child(
                    div()
                      .text_color(t.muted)
                      .child(`Rows ${sbsPageInfo.startRow}–${sbsPageInfo.endRow} of ${sbsPageInfo.totalRows} (page ${sbsPageInfo.pageIndex + 1}/${sbsPageInfo.totalPages})`)
                  )
                  .child(
                    h_flex()
                      .gap(6)
                      .items_center()
                      .child(
                        h_flex()
                          .id("git-diff-page-prev")
                          .h(20)
                          .px(8)
                          .items_center()
                          .rounded(4)
                          .border_1()
                          .border_color(t.border)
                          .bg(t.background)
                          .text_size(10.5)
                          .text_color(sbsPageInfo.hasPrev ? t.foreground : t.dim)
                          .when(sbsPageInfo.hasPrev, (btn) =>
                            btn
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover))
                              .on_click((_e, cx) => this.setSbsPage(sbsPageInfo.pageIndex - 1, cx))
                          )
                          .child(`← Prev ${DEFAULT_SBS_PAGE_ROWS}`)
                      )
                      .child(
                        h_flex()
                          .id("git-diff-page-next")
                          .h(20)
                          .px(8)
                          .items_center()
                          .rounded(4)
                          .border_1()
                          .border_color(t.border)
                          .bg(t.background)
                          .text_size(10.5)
                          .text_color(sbsPageInfo.hasNext ? t.foreground : t.dim)
                          .when(sbsPageInfo.hasNext, (btn) =>
                            btn
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover))
                              .on_click((_e, cx) => this.setSbsPage(sbsPageInfo.pageIndex + 1, cx))
                          )
                          .child(`Next ${DEFAULT_SBS_PAGE_ROWS} →`)
                      )
                  )
              )
            )
            .child(
              h_flex()
                .id("git-diff-col-headers")
                .h(24)
                .flex_none()
                .border_b(1)
                .border_color(t.border)
                .bg(t.chrome)
                .text_size(11)
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .px(10)
                    .items_center()
                    .on_size_change((size, cx) => this.updateDiffViewportWidth("left", size, cx))
                    .child(div().truncate().font_medium().text_color(t.muted).child(`Before (${beforeLabel})`))
                )
                .child(
                  h_flex()
                    .w(DIFF_WAVE_GUTTER_WIDTH)
                    .h_full()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .child(svg("mods/git-history/icons/git-compare.svg").size(11).text_color(t.dim))
                )
                .child(
                  h_flex()
                    .flex_1()
                    .min_w(0)
                    .px(10)
                    .items_center()
                    .on_size_change((size, cx) => this.updateDiffViewportWidth("right", size, cx))
                    .child(div().truncate().font_medium().text_color(t.muted).child(`After (${shortHash || "commit"})`))
                )
            )
            .child(
              div()
                .flex_1()
                .min_h(0)
                .relative()
                .font_family(mono)
                .text_size(11.5)
                .when(pageRows.length > 0 && (this.sbsBlocks?.blocks?.length || 0) > 0, (el) => {
                  const blocksData = this.sbsBlocks;
                  const wrapMetrics = this.getSbsWrapMetrics();
                  return el
                    .child(
                      v_virtual_list(
                        "git-diff-y",
                        blocksData.blocks.length,
                        blocksData.blockHeights,
                        (index) => `b-${index}`,
                        (range) => {
                          const out = [];
                          for (let i = range.start; i < range.end; i++) {
                            out.push(
                              this.renderSbsBlock(
                                blocksData.blocks[i],
                                t,
                                dt,
                                syntaxPalette,
                                waveBrushes,
                                wrapMetrics
                              )
                            );
                          }
                          return out;
                        }
                      )
                        .size_full()
                        .track_scroll(this.diffScroll)
                    )
                    .child(Scrollbar.vertical("git-diff-y").viewport_from_layout().absolute().inset_0());
                })
                .when(pageRows.length === 0 && !this.viewerError, (el) =>
                  el.child(
                    h_flex()
                      .size_full()
                      .items_center()
                      .justify_center()
                      .child(
                        div()
                          .text_size(12)
                          .text_color(t.dim)
                          .child(
                            openFile.status === "R"
                              ? `Renamed with no content changes (${openFile.oldPath} → ${openFile.path})`
                              : "No text changes in this file"
                          )
                      )
                  )
                )
            );
        }
      )
      .when(
        Boolean(openFile) &&
          !this.isBinaryDiff &&
          !openFile.binary &&
          this.diffMode === "unified" &&
          !(this.viewerLoading && this.uniRows.length === 0),
        (el) => {
          return el.child(
            div()
              .flex_1()
              .min_h(0)
              .relative()
              .font_family(mono)
              .text_size(11.5)
              .when(this.uniRows.length > 0, (u) =>
                u.child(
                  div()
                    .id("git-diff-unified-x")
                    .size_full()
                    .min_w(0)
                    .overflow_hidden()
                    .on_size_change((size, cx) => this.updateDiffViewportWidth("unified", size, cx))
                    .child(this.unifiedDiffPane)
                )
              )
              .when(this.uniRows.length === 0 && !this.viewerError, (u) =>
                u.child(
                  h_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .child(
                      div()
                        .text_size(12)
                        .text_color(t.dim)
                        .child(
                          openFile.status === "R"
                            ? `Renamed with no content changes (${openFile.oldPath} → ${openFile.path})`
                            : "No text changes in this file"
                        )
                    )
                )
              )
          );
        }
      );
  }

  // ==========================================
  // DOCKED PANEL MODE (#git)
  // ==========================================
  renderGraphCanvas(commit, rowLayout, graphWidth, lanePalette, t, isSelected) {
    const laneX = (lane) => LANE_PAD_LEFT + lane * LANE_WIDTH;
    const rowBg = isSelected ? t.selected : t.background;
    const paths = [];

    if (rowLayout) {
      let cached = graphRowPathCache.get(rowLayout);
      if (!cached || cached.width !== graphWidth) {
        const buildersByColor = new Map();
        const getBuilder = (colorIndex) => {
          const idx = colorIndex ?? 0;
          let pb = buildersByColor.get(idx);
          if (!pb) {
            pb = PathBuilder.stroke(2);
            buildersByColor.set(idx, pb);
          }
          return pb;
        };

        for (const pass of rowLayout.passThroughLanes || []) {
          const x = laneX(pass.lane);
          if (x > graphWidth + 4) continue;
          getBuilder(pass.colorIndex).move_to(x, 0).line_to(x, ROW_HEIGHT);
        }

        for (const edge of rowLayout.incomingEdges || []) {
          const x0 = laneX(edge.fromLane);
          const x1 = laneX(edge.toLane);
          if (x0 > graphWidth + 4 && x1 > graphWidth + 4) continue;
          const pb = getBuilder(edge.colorIndex).move_to(x0, 0);
          if (edge.fromLane === edge.toLane) {
            pb.line_to(x1, Y_MID);
          } else {
            pb.cubic_bezier_to(x1, Y_MID, x0, Y_MID * 0.55, x1, Y_MID * 0.45);
          }
        }

        for (const edge of rowLayout.outgoingEdges || []) {
          const x0 = laneX(edge.fromLane);
          const x1 = laneX(edge.toLane);
          if (x0 > graphWidth + 4 && x1 > graphWidth + 4) continue;
          const pb = getBuilder(edge.colorIndex).move_to(x0, Y_MID);
          if (edge.fromLane === edge.toLane) {
            pb.line_to(x1, ROW_HEIGHT);
          } else {
            pb.cubic_bezier_to(x1, ROW_HEIGHT, x0, Y_MID + Y_MID * 0.55, x1, Y_MID + Y_MID * 0.45);
          }
        }

        const entries = [];
        for (const [colorIndex, pb] of buildersByColor.entries()) {
          entries.push({ colorIndex, path: pb.build() });
        }
        cached = { width: graphWidth, entries };
        graphRowPathCache.set(rowLayout, cached);
      }

      for (let i = 0; i < cached.entries.length; i++) {
        const entry = cached.entries[i];
        const col = laneColor(entry.colorIndex, lanePalette) || t.foreground;
        paths.push(window.paint_path(entry.path, col).absolute().inset_0());
      }
    }

    const nodeLane = rowLayout?.lane ?? 0;
    const nodeColor = laneColor(rowLayout?.colorIndex ?? 0, lanePalette) || t.foreground;
    const nodeX = laneX(nodeLane);
    const isHead = (commit.refs || []).some((r) => r.kind === "head" || r.isHeadBranch);
    const isMerge = Boolean(rowLayout?.isMerge);
    const dotSize = isHead || isMerge ? 10 : 8;
    const half = dotSize / 2;

    let nodeDot = div()
      .absolute()
      .left(Math.max(1, nodeX - half))
      .top(Y_MID - half)
      .w(dotSize)
      .h(dotSize)
      .rounded_full();
    if (isHead) {
      nodeDot = nodeDot.bg(nodeColor).border(2).border_color(t.foreground);
    } else if (isMerge) {
      nodeDot = nodeDot.bg(rowBg).border(2).border_color(nodeColor);
    } else {
      nodeDot = nodeDot.bg(nodeColor).border(1.5).border_color(rowBg);
    }

    return div()
      .id(`git-lane-${commit.shortHash}`)
      .w(graphWidth)
      .h(ROW_HEIGHT)
      .relative()
      .flex_none()
      .overflow_hidden()
      .children(paths)
      .child(nodeDot);
  }

  renderCommitRow(commit, rowLayout, graphWidth, lanePalette, t, mono, isSelected, isCompact) {
    const refs = Array.isArray(commit.refs) ? commit.refs : [];
    const shownRefs = refs.slice(0, 2);
    const extraRefs = refs.length - shownRefs.length;
    const relTime = formatRelativeTime(commit.timestamp);

    return h_flex()
      .id(`git-commit-${commit.hash}`)
      .w_full()
      .h(ROW_HEIGHT)
      .px(8)
      .gap(6)
      .items_center()
      .cursor_pointer()
      .bg(isSelected ? t.selected : t.background)
      .hover((s) => s.bg(isSelected ? t.selected : t.hover))
      .child(this.renderGraphCanvas(commit, rowLayout, graphWidth, lanePalette, t, isSelected))
      .when(shownRefs.length > 0, (el) =>
        el.child(
          h_flex()
            .flex_none()
            .gap(3)
            .items_center()
            .children(
              shownRefs.map((ref) => {
                const rc = buildRefBadgeColors(ref, t);
                return div()
                  .flex_none()
                  .max_w(88)
                  .truncate()
                  .px(5)
                  .py(0.5)
                  .rounded(4)
                  .bg(rc.bg)
                  .border_1()
                  .border_color(rc.border)
                  .text_size(9.5)
                  .font_medium()
                  .text_color(rc.text)
                  .child(ref.label);
              })
            )
            .when(extraRefs > 0, (b) =>
              b.child(
                div()
                  .flex_none()
                  .px(4)
                  .py(0.5)
                  .rounded(4)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .text_size(9)
                  .text_color(t.muted)
                  .child(`+${extraRefs}`)
              )
            )
        )
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .font_medium()
          .text_color(t.foreground)
          .child(commit.subject || "(no message)")
      )
      .child(
        h_flex()
          .flex_none()
          .gap(5)
          .items_center()
          .text_size(10)
          .text_color(t.dim)
          .when(!isCompact && Boolean(commit.author), (b) =>
            b.child(div().max_w(72).truncate().child(commit.author))
          )
          .when(Boolean(relTime), (b) => b.child(div().flex_none().child(relTime)))
          .child(div().flex_none().font_family(mono).text_color(isSelected ? t.muted : t.dim).child(commit.shortHash))
      );
  }

  renderCommitFileRow(file, idx, commit, t, dt, isSelected) {
    const fileIcon = resolveGitFileIcon(file.path || file.displayPath, t);
    const label = file.displayPath || (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
    return h_flex()
      .id(`git-file-${idx}`)
      .w_full()
      .h(FILE_ROW_HEIGHT)
      .px(10)
      .gap(6)
      .items_center()
      .cursor_pointer()
      .bg(isSelected ? t.selected : t.background)
      .hover((s) => s.bg(isSelected ? t.selected : t.hover))
      .child(
        div()
          .w(13)
          .flex_none()
          .text_center()
          .text_size(10.5)
          .font_semibold()
          .text_color(parseStatusColor(file.status, t, dt))
          .child(file.status || "M")
      )
      .child(svg(fileIcon.path).size(13).flex_none().text_color(fileIcon.color))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(11.5)
          .text_color(t.foreground)
          .child(label)
      )
      .when(file.binary, (b) =>
        b.child(
          div()
            .flex_none()
            .px(4)
            .py(0.5)
            .rounded(3)
            .bg(t.raised)
            .border_1()
            .border_color(t.border)
            .text_size(9)
            .text_color(t.muted)
            .child("BIN")
        )
      )
      .when(!file.binary && (file.added || 0) > 0, (b) =>
        b.child(div().flex_none().text_size(10.5).text_color(dt.add).child(`+${file.added}`))
      )
      .when(!file.binary && (file.deleted || 0) > 0, (b) =>
        b.child(div().flex_none().text_size(10.5).text_color(dt.del).child(`−${file.deleted}`))
      );
  }

  renderPanel(cx) {
    const visible = isGitPanelVisible();
    const bus = shared("mesh.services");
    const busSig = bus?.sig || (typeof bus?.ts === "number" ? String(bus.ts) : "");
    const busChanged = Boolean(busSig && busSig !== this.lastConsumedBusSig);
    const becameVisible = visible && !this.wasVisible;
    this.wasVisible = visible;

    if (!visible) {
      if (busChanged) {
        this.needsRefreshOnShow = true;
      }
      return div().id("git-history").size_full();
    }

    const ctxKey = buildContextKey();
    const needsRefresh = ctxKey !== this.context || becameVisible || this.needsRefreshOnShow || !this.hasLoadedOnce || busChanged;
    if (needsRefresh) {
      const isBusOnly = ctxKey === this.context && !becameVisible && !this.needsRefreshOnShow && this.hasLoadedOnce && busChanged;
      this.needsRefreshOnShow = false;
      this.scheduleRenderRefresh(cx, isBusOnly);
    }

    const allSpaces = spaces() || [];
    const allPanes = panes() || [];
    const curSpace = allSpaces.find((s) => s.active);
    const curTab = (curSpace?.tabs || []).find((t) => t.active);
    if (curSpace?.id && curTab?.id && allPanes.some((p) => p.tab === curTab.id && Boolean(p.terminal))) {
      const storedAgentTabs = readPlainObject(shared("mesh.spaceAgentTabs"));
      if (storedAgentTabs[curSpace.id] !== curTab.id) {
        this.scheduleAgentTabSync(cx);
      }
    }

    const sharedActive = shared("mesh.activeService");
    const extServiceChanged = Boolean(
      sharedActive &&
      normPathStr(sharedActive.workspaceRoot) === normPathStr(this.workspaceRoot) &&
      typeof sharedActive.ts === "number" &&
      sharedActive.ts > (this.lastActiveServiceTs || 0) &&
      sharedActive.serviceId &&
      sharedActive.serviceId !== "all" &&
      this.repos.some((r) => r.id === sharedActive.serviceId && normPathStr(r.root) !== normPathStr(this.selectedRepo?.root))
    );
    const ctx = this.getSessionContext();
    const activeDiff = readActiveDiff(ctx.spaceId);
    const gitTab = findGitDiffTabInSpace(ctx.spaceId, allSpaces, allPanes);
    const diffSyncedFromViewer = Boolean(
      gitTab &&
      activeDiff &&
      activeDiff.commitHash === this.selectedCommitHash &&
      activeDiff.openFileKey &&
      activeDiff.openFileKey !== this.selectedFileKey
    );
    if (extServiceChanged || diffSyncedFromViewer) {
      this.scheduleSharedSync(cx);
    }

    const t = theme();
    const { dt, lanePalette } = getThemeBundle(t);
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const isCompact = (this.panelWidth || 420) < 380;

    if (!this._cachedFilterState || this._cachedFilterState.commits !== this.commits || this._cachedFilterState.query !== this.searchQuery) {
      this._cachedFilterState = {
        commits: this.commits,
        query: this.searchQuery,
        result: filterCommits(this.commits, this.searchQuery),
      };
    }
    const filteredCommits = this._cachedFilterState.result;

    if (!this._cachedRowMapState || this._cachedRowMapState.layout !== this.graphLayout) {
      const rowByHash = new Map();
      for (const row of this.graphLayout?.rows || []) {
        if (row?.hash) rowByHash.set(row.hash, row);
      }
      const maxLaneCount = Math.max(1, this.graphLayout?.maxLaneCount || 1);
      const graphWidth = Math.min(180, LANE_PAD_LEFT * 2 + Math.max(0, maxLaneCount - 1) * LANE_WIDTH + 6);
      this._cachedRowMapState = { layout: this.graphLayout, rowByHash, graphWidth };
    }
    const { rowByHash, graphWidth } = this._cachedRowMapState;

    const showLoadMoreRow = Boolean(this.hasMore && !this.searchQuery.trim() && filteredCommits.length > 0);
    const listCount = filteredCommits.length + (showLoadMoreRow ? 1 : 0);

    const activeRepo = this.selectedRepo;
    const branchDisplay = this.selectedBranch === "__all__" ? "All Branches" : this.selectedBranch;
    if (!this._cachedBranchState || this._cachedBranchState.branches !== this.branches) {
      const localBranches = [];
      const remoteBranches = [];
      for (const b of this.branches || []) {
        if (b.kind === "local") localBranches.push(b);
        else if (b.kind === "remote") remoteBranches.push(b);
      }
      this._cachedBranchState = { branches: this.branches, localBranches, remoteBranches };
    }
    const { localBranches, remoteBranches } = this._cachedBranchState;

    return v_flex()
      .id("git-history")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .relative()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const w = Math.round(size?.width || 0);
        const prevW = this.panelWidth || 420;
        if (w > 0 && Math.abs(w - prevW) > 12) {
          const compactChanged = (prevW < 380) !== (w < 380);
          this.panelWidth = w;
          if (compactChanged) {
            cx.notify();
          }
        }
      })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && (this.showRepoMenu || this.showBranchMenu)) {
          this.showRepoMenu = false;
          this.showBranchMenu = false;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      // Header bar
      .child(
        h_flex()
          .id("git-header")
          .h(36)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(svg("mods/git-history/icons/git-branch.svg").size(13).flex_none().text_color(t.muted))
              .child(
                h_flex()
                  .id("git-repo-btn")
                  .h(24)
                  .px(7)
                  .gap(5)
                  .min_w(0)
                  .max_w(160)
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(this.showRepoMenu ? (t.accent || t.border) : t.border)
                  .bg(this.showRepoMenu ? t.selected : t.background)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.showRepoMenu = !this.showRepoMenu;
                    this.showBranchMenu = false;
                    cx.notify();
                  })
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(11)
                      .font_medium()
                      .text_color(t.foreground)
                      .child(activeRepo ? activeRepo.name : "No repo")
                  )
                  .when(Boolean(activeRepo?.isDirty), (b) =>
                    b.child(div().w(6).h(6).rounded_full().flex_none().bg(t.working || t.accent || t.foreground))
                  )
                  .child(svg("mods/git-history/icons/chevron-down.svg").size(9).flex_none().text_color(t.dim))
              )
              .child(
                h_flex()
                  .id("git-branch-btn")
                  .h(24)
                  .px(7)
                  .gap(5)
                  .min_w(0)
                  .max_w(140)
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .border_color(this.showBranchMenu ? (t.accent || t.border) : t.border)
                  .bg(this.showBranchMenu ? t.selected : t.background)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.showBranchMenu = !this.showBranchMenu;
                    this.showRepoMenu = false;
                    cx.notify();
                  })
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_size(11)
                      .text_color(this.selectedBranch === "__all__" ? t.muted : t.foreground)
                      .child(branchDisplay)
                  )
                  .child(svg("mods/git-history/icons/chevron-down.svg").size(9).flex_none().text_color(t.dim))
              )
          )
          .child(
            h_flex()
              .id("git-refresh-btn")
              .h(24)
              .w(24)
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(5)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .text_size(12)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Refresh git history")
              .on_click((_e, cx) => this.refresh(cx, { force: true }))
              .child("↻")
          )
      )
      // Search bar
      .child(
        h_flex()
          .id("git-search-bar")
          .flex_none()
          .px(8)
          .py(6)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.background)
          .child(
            div()
              .flex_1()
              .min_w(0)
              .h(26)
              .px(8)
              .flex()
              .items_center()
              .rounded(6)
              .border_1()
              .border_color(this.typingSearch ? (t.accent || t.border) : t.border)
              .bg(t.raised)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.searchInput).h_full().text_size(11.5).text_color(t.foreground))
          )
          .when(Boolean(this.searchQuery), (el) =>
            el.child(
              h_flex()
                .id("git-search-clear")
                .h(26)
                .w(26)
                .flex_none()
                .items_center()
                .justify_center()
                .rounded(6)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .text_size(13)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip("Clear search filter")
                .on_click((_e, cx) => {
                  if (this.searchDebounceTask) {
                    try { this.searchDebounceTask.cancel(); } catch {}
                    this.searchDebounceTask = null;
                  }
                  this.searchQuery = "";
                  this.searchInput.set_value("");
                  cx.notify();
                })
                .child("×")
            )
          )
      )
      // Vertical split: Commit Graph (top) + Selected Commit Details & Files (bottom)
      .child(
        v_resizable("git-panel-split")
          .flex_1()
          .min_h(0)
          .w_full()
          .child(
            resizable_panel()
              .size(380)
              .size_range(160, 900)
              .child(
                div()
                  .id("git-graph-wrap")
                  .size_full()
                  .relative()
                  .bg(t.background)
                  .when(listCount > 0, (wrap) =>
                    wrap
                      .child(
                        v_virtual_list(
                          "git-commits-list",
                          listCount,
                          ROW_HEIGHT,
                          (index) => (index < filteredCommits.length ? filteredCommits[index].hash : "__load_more__"),
                          (range) => {
                            const items = [];
                            for (let i = range.start; i < range.end; i++) {
                              if (i < filteredCommits.length) {
                                const c = filteredCommits[i];
                                const rowLayout = rowByHash.get(c.hash) || null;
                                const isSel = c.hash === this.selectedCommitHash;
                                items.push(
                                  this.renderCommitRow(c, rowLayout, graphWidth, lanePalette, t, mono, isSel, isCompact)
                                );
                              } else {
                                items.push(
                                  h_flex()
                                    .id("git-load-more-row")
                                    .w_full()
                                    .h(ROW_HEIGHT)
                                    .px(12)
                                    .items_center()
                                    .justify_center()
                                    .bg(t.raised)
                                    .border_t(1)
                                    .border_color(t.border)
                                    .cursor_pointer()
                                    .hover((s) => s.bg(t.hover))
                                    .text_size(11)
                                    .font_medium()
                                    .text_color(t.accent || t.foreground)
                                    .child(this.loadingMore ? "Loading older commits…" : `Load older commits (+${COMMIT_PAGE_SIZE})`)
                                );
                              }
                            }
                            return items;
                          }
                        )
                          .size_full()
                          .track_scroll(this.commitsScroll)
                          .on_item_click((itemKey, cx) => this.handleCommitListClick(itemKey, cx))
                      )
                      .child(Scrollbar.vertical("git-commits-list").viewport_from_layout().absolute().inset_0())
                  )
                  .when(listCount === 0, (wrap) =>
                    wrap.child(
                      h_flex()
                        .size_full()
                        .items_center()
                        .justify_center()
                        .p(12)
                        .child(
                          div()
                            .text_size(11.5)
                            .text_color(this.error ? dt.del : t.dim)
                            .child(
                              this.error
                                ? this.error
                                : this.loadingCommits
                                  ? "Loading commit history…"
                                  : this.searchQuery.trim()
                                    ? "No commits match filter"
                                    : "No commits yet"
                            )
                        )
                    )
                  )
              )
          )
          .child(
            resizable_panel()
              .size(220)
              .size_range(120, 600)
              .child(
                v_flex()
                  .id("git-commit-detail")
                  .size_full()
                  .min_h(0)
                  .border_t(1)
                  .border_color(t.border)
                  .bg(t.background)
                  .when(Boolean(this.selectedCommit), (det) => {
                    const c = this.selectedCommit;
                    const pLabels = (c.parents || []).map((p) => p.slice(0, 7));
                    return det
                      .child(
                        v_flex()
                          .id("git-commit-meta")
                          .flex_none()
                          .px(10)
                          .py(6)
                          .gap(3)
                          .border_b(1)
                          .border_color(t.border)
                          .bg(t.raised)
                          .child(
                            h_flex()
                              .w_full()
                              .gap(6)
                              .items_center()
                              .justify_between()
                              .child(
                                h_flex()
                                  .flex_1()
                                  .min_w(0)
                                  .gap(6)
                                  .items_center()
                                  .child(
                                    div()
                                      .flex_none()
                                      .px(5)
                                      .py(0.5)
                                      .rounded(4)
                                      .bg(t.background)
                                      .border_1()
                                      .border_color(t.border)
                                      .font_family(mono)
                                      .text_size(10)
                                      .text_color(t.accent || t.foreground)
                                      .child(c.shortHash)
                                  )
                                  .child(
                                    div()
                                      .flex_1()
                                      .min_w(0)
                                      .truncate()
                                      .text_size(10)
                                      .text_color(t.dim)
                                      .child(
                                        `${c.author || "unknown"} · ${formatRelativeTime(c.timestamp)} · ${
                                          pLabels.length > 0 ? `parent ${pLabels.join(" ")}` : "root"
                                        }`
                                      )
                                  )
                              )
                              .child(
                                div()
                                  .flex_none()
                                  .px(5)
                                  .py(0.5)
                                  .rounded(4)
                                  .bg(t.background)
                                  .border_1()
                                  .border_color(t.border)
                                  .text_size(9.5)
                                  .text_color(t.muted)
                                  .child(`${this.commitFiles.length} files`)
                              )
                          )
                          .child(
                            div()
                              .w_full()
                              .truncate()
                              .text_size(11.5)
                              .font_semibold()
                              .text_color(t.foreground)
                              .child(c.subject || "(no message)")
                          )
                      )
                      .child(
                        div()
                          .id("git-commit-files-wrap")
                          .flex_1()
                          .min_h(0)
                          .w_full()
                          .relative()
                          .when(this.commitFiles.length > 0, (fw) =>
                            fw
                              .child(
                                v_virtual_list(
                                  "git-commit-files",
                                  this.commitFiles.length,
                                  FILE_ROW_HEIGHT,
                                  (index) => makeCommitFileKey(c, this.commitFiles[index]),
                                  (range) => {
                                    const rows = [];
                                    for (let i = range.start; i < range.end; i++) {
                                      const f = this.commitFiles[i];
                                      const fk = makeCommitFileKey(c, f);
                                      rows.push(
                                        this.renderCommitFileRow(f, i, c, t, dt, fk === this.selectedFileKey)
                                      );
                                    }
                                    return rows;
                                  }
                                )
                                  .size_full()
                                  .track_scroll(this.filesScroll)
                                  .on_item_click((itemKey, cx) => this.handleCommitFileClick(itemKey, cx))
                              )
                              .child(Scrollbar.vertical("git-commit-files").viewport_from_layout().absolute().inset_0())
                          )
                          .when(this.commitFiles.length === 0, (fw) =>
                            fw.child(
                              div()
                                .p(10)
                                .text_size(11.5)
                                .text_color(t.dim)
                                .child(
                                  this.loadingCommitFiles
                                    ? "Loading changed files…"
                                    : "No files modified in this commit"
                                )
                            )
                          )
                      );
                  })
                  .when(!this.selectedCommit, (det) =>
                    det.child(
                      h_flex()
                        .size_full()
                        .items_center()
                        .justify_center()
                        .child(
                          div()
                            .text_size(11.5)
                            .text_color(t.dim)
                            .child("Select a commit above to inspect modified files")
                        )
                    )
                  )
              )
          )
      )
      // Floating dropdowns
      .when(this.showRepoMenu || this.showBranchMenu, (el) =>
        el.child(
          div()
            .id("git-dropdown-overlay")
            .absolute()
            .inset_0()
            .on_mouse_down("left", (_e, cx) => {
              this.showRepoMenu = false;
              this.showBranchMenu = false;
              cx.notify();
            })
            .when(this.showRepoMenu, (ov) =>
              ov.child(
                v_flex()
                  .id("git-repo-dropdown")
                  .absolute()
                  .top(38)
                  .left(10)
                  .w(280)
                  .max_h(300)
                  .rounded(8)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .shadow_xl()
                  .p(4)
                  .gap(2)
                  .overflow_y_scrollbar()
                  .track_scroll(this.repoDropdownScroll)
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .children(
                    this.repos.map((r) => {
                      const isCur = normPathStr(r.root) === normPathStr(activeRepo?.root);
                      return h_flex()
                        .id(`git-repo-opt-${r.id || r.root}`)
                        .min_h(30)
                        .px(8)
                        .py(4)
                        .gap(6)
                        .items_center()
                        .rounded(5)
                        .cursor_pointer()
                        .when(isCur, (s) => s.bg(t.selected))
                        .hover((s) => s.bg(t.hover))
                        .on_click((_e, cx) => this.selectRepo(r, cx))
                        .child(
                          div()
                            .w(6)
                            .h(6)
                            .rounded_full()
                            .flex_none()
                            .bg(r.isDirty ? (t.working || t.accent || t.foreground) : (t.done || t.ansi2 || t.muted))
                        )
                        .child(
                          v_flex()
                            .flex_1()
                            .min_w(0)
                            .gap(1)
                            .child(div().truncate().text_size(11.5).font_medium().text_color(t.foreground).child(r.name))
                            .when(Boolean(r.branch), (b) =>
                              b.child(div().truncate().text_size(9.5).text_color(t.dim).child(r.branch))
                            )
                        )
                        .when((r.dirtyCount || 0) > 0, (b) =>
                          b.child(
                            div()
                              .flex_none()
                              .px(5)
                              .py(0.5)
                              .rounded(3)
                              .bg(t.background)
                              .text_size(9.5)
                              .text_color(t.muted)
                              .child(String(r.dirtyCount))
                          )
                        );
                    })
                  )
              )
            )
            .when(this.showBranchMenu, (ov) =>
              ov.child(
                v_flex()
                  .id("git-branch-dropdown")
                  .absolute()
                  .top(38)
                  .left(90)
                  .right(10)
                  .max_w(300)
                  .max_h(320)
                  .rounded(8)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .shadow_xl()
                  .p(4)
                  .gap(2)
                  .overflow_y_scrollbar()
                  .track_scroll(this.branchDropdownScroll)
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(
                    h_flex()
                      .id("git-branch-opt-all")
                      .min_h(28)
                      .px(8)
                      .gap(6)
                      .items_center()
                      .rounded(5)
                      .cursor_pointer()
                      .when(this.selectedBranch === "__all__", (s) => s.bg(t.selected))
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => this.selectBranch("__all__", cx))
                      .child(div().text_size(11.5).font_medium().text_color(t.foreground).child("All Branches"))
                      .child(div().flex_1())
                      .child(div().text_size(9.5).text_color(t.dim).child("--all"))
                  )
                  .when(localBranches.length > 0, (b) =>
                    b
                      .child(div().h(1).w_full().bg(t.border).my(2).flex_none())
                      .child(div().px(8).py(2).text_size(9.5).font_semibold().text_color(t.dim).child("LOCAL"))
                      .children(
                        localBranches.map((br) => {
                          const isCur = this.selectedBranch === br.name;
                          return h_flex()
                            .id(`git-branch-local-${br.name}`)
                            .min_h(26)
                            .px(8)
                            .gap(6)
                            .items_center()
                            .rounded(5)
                            .cursor_pointer()
                            .when(isCur, (s) => s.bg(t.selected))
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => this.selectBranch(br.name, cx))
                            .child(
                              div()
                                .flex_1()
                                .min_w(0)
                                .truncate()
                                .text_size(11.5)
                                .text_color(br.isCurrent ? (t.accent || t.foreground) : t.foreground)
                                .child(br.isCurrent ? `● ${br.name}` : br.name)
                            )
                            .child(div().flex_none().font_family(mono).text_size(9.5).text_color(t.dim).child(br.shortHash));
                        })
                      )
                  )
                  .when(remoteBranches.length > 0, (b) =>
                    b
                      .child(div().h(1).w_full().bg(t.border).my(2).flex_none())
                      .child(div().px(8).py(2).text_size(9.5).font_semibold().text_color(t.dim).child("REMOTE"))
                      .children(
                        remoteBranches.map((br) => {
                          const isCur = this.selectedBranch === br.name;
                          return h_flex()
                            .id(`git-branch-remote-${br.name}`)
                            .min_h(26)
                            .px(8)
                            .gap(6)
                            .items_center()
                            .rounded(5)
                            .cursor_pointer()
                            .when(isCur, (s) => s.bg(t.selected))
                            .hover((s) => s.bg(t.hover))
                            .on_click((_e, cx) => this.selectBranch(br.name, cx))
                            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(br.name))
                            .child(div().flex_none().font_family(mono).text_size(9.5).text_color(t.dim).child(br.shortHash));
                        })
                      )
                  )
              )
            )
        )
      );
  }

  render(cx) {
    if (this.isViewerMode()) {
      return this.renderViewer(cx);
    }
    return this.renderPanel(cx);
  }
}
