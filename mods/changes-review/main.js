import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, ScrollHandle } from "gpui-base";
import * as fsPromises from "fs/promises";
import { readdir, exists } from "fs/promises";
import { join } from "path";
import {
  spaces, panes, focused, agents, terminals, exec, readTextFile, watchFolder,
  theme, settings, notify, hc, run, layout, props, shared, setShared, window, appHome,
} from "herdr";
import {
  DISCOVER_SKIP_DIRS,
  diffRows,
  diffSyntaxTokenColor,
  resolveDiffFileIcon,
  computeDiffContentWidth,
  normPathStr,
  normCmpStr,
  isSameOrChildPath,
  isSupportedDirentList,
  direntIsDir,
  hasRelevantWatchChange,
  getParentDir,
  formatReviewTabTitle,
  getSessionNotesKey,
  resolveSessionAgentTabId,
  pickNextUnreviewedFile,
  normalizeCommentSide,
  buildCommentKey,
  buildReviewedFileKey,
  partitionSessionUnifiedEntries,
  collectActiveFeatureBranches,
  isMatchingFeatureBranch,
  changedFilesMatchTranscript,
  evaluateRepoSessionActivity,
  findBaselineRepoEntry,
  normalizeSessionBaseline,
  getDiskSessionBaselinePath,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  resolveSessionStartTime,
  buildFreshSessionBaseline,
  createResetSessionBaseline,
  compactFlowsMap,
  extractResumeKeyFromTranscript,
  filterUnbaselinedRepoEntries,
  resolveWorkspaceRoot,
  READ_GIT_FLAGS,
  mergeBusCandidateServices,
  collectServiceSessionSnapshot,
  computeFileReviewFingerprint,
  parseReviewedFileRecord,
  reconcileReviewedFiles,
  resolveReviewMarkdownSourceSpec,
  computeViewerMarkdownFileId,
  computeReviewMarkdownLoadToken,
  buildReviewMarkdownCacheKey,
  validateMarkdownTextContent,
  formatGitShowMarkdownError,
  buildVariableRowLayout,
  computeVariableWindowSlice,
  computeDiffScrollOffsetForRow,
  computeDiffScrollbarMetrics,
  resolveDiffWheelDeltaPx,
  resolveDiffScrollbarDragPx,
  DEFAULT_CONTEXT_EXPAND_STEP,
  splitSourceFileLines,
  annotateDiffGaps,
  syncBottomGapWithTotalLines,
  expandDiffGapInRows,
  computeAnchorPreservedScrollPx,
  formatReviewAgentMessage,
  parseHcJsonOutput,
  formatHcErrorMessage,
  decideSendSubmitAction,
  computeReviewCommentWrapCols,
  extractHcReadText,
  selectPathsToStageForCommit,
} from "./review-logic.js";
import { computeWrapColumns, countWrappedLines, wrapPlainText, wrapStyledSpans } from "./code-wrap.js";
import { isMarkdownFile, resolveRelativeMarkdownPath } from "./markdown-view-logic.js";
import { createMarkdownRenderCache, renderMarkdownToggleButton, renderMarkdownViewer } from "./markdown-view.js";
import { createModLogger, renderErrorFallbackCard } from "./diagnostics.js";

const reviewWrapCache = new WeakMap();
const REVIEW_ROW_HEIGHT = 20;
const REVIEW_HUNK_ROW_HEIGHT = 26;
const REVIEW_COMPOSER_EST_HEIGHT = 156;

function readPlainObject(val) {
  return val && typeof val === "object" && !Array.isArray(val) ? val : {};
}

function safeShared(key, fallback = null) {
  try {
    const val = shared(key);
    return val === undefined ? fallback : val;
  } catch {
    return fallback;
  }
}

function getSafeAppHome() {
  try {
    return typeof appHome === "function" ? appHome() : "";
  } catch {
    return "";
  }
}

const SESSION_BASELINE_CACHE = new Map(); // tabId -> { baseline, mtimeMs }
const MAX_BASELINE_CACHE_ENTRIES = 32;
let flowsBusOomDetected = false;

function cacheSessionBaseline(tabId, baseline, mtimeMs = 0) {
  if (!tabId || !baseline) return;
  if (SESSION_BASELINE_CACHE.size >= MAX_BASELINE_CACHE_ENTRIES && !SESSION_BASELINE_CACHE.has(tabId)) {
    const oldest = SESSION_BASELINE_CACHE.keys().next().value;
    if (oldest !== undefined) SESSION_BASELINE_CACHE.delete(oldest);
  }
  const prev = SESSION_BASELINE_CACHE.get(tabId);
  const nextMtime = Number(mtimeMs) > 0 ? Number(mtimeMs) : (Number(prev?.mtimeMs) || 0);
  SESSION_BASELINE_CACHE.set(tabId, { baseline, mtimeMs: nextMtime });
}

function getCachedSessionBaselineEntry(tabId) {
  const entry = SESSION_BASELINE_CACHE.get(tabId);
  if (!entry) return null;
  if (entry.baseline) return entry;
  return { baseline: entry, mtimeMs: 0 };
}

async function getDiskBaselineMtimeMs(appHomeDir, tabId) {
  const diskPath = getDiskSessionBaselinePath(appHomeDir, tabId);
  if (!diskPath || typeof fsPromises?.stat !== "function") return 0;
  try {
    const st = await fsPromises.stat(diskPath);
    return Number.isFinite(st?.mtimeMs) ? st.mtimeMs : 0;
  } catch {
    return 0;
  }
}

function safeReadFlows() {
  try {
    return readPlainObject(shared("cognivisor.flows"));
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (!err || /out of memory/i.test(msg)) {
      flowsBusOomDetected = true;
    }
    return {};
  }
}

function mergeSessionBaselineIntoFlow(tabId, baseline, sessionRepos = null, force = false, diskMtimeMs = 0) {
  if (!tabId) return;
  const normalized = normalizeSessionBaseline(baseline);
  if (!normalized) return;
  cacheSessionBaseline(tabId, normalized, diskMtimeMs);
  const rawFlows = safeReadFlows();
  const liveTabIds = getLiveTabIdsSet();
  const flows = compactFlowsMap(rawFlows, liveTabIds);
  const hadLegacyBaseline = Object.values(rawFlows).some((f) => f && typeof f === "object" && Boolean(f.sessionBaseline));
  const prunedCount = Object.keys(rawFlows).length !== Object.keys(flows).length;
  const cur = flows[tabId] && typeof flows[tabId] === "object" ? flows[tabId] : {};
  const prevRepos = Array.isArray(cur.sessionRepos) ? cur.sessionRepos.map((r) => normPathStr(r)) : [];
  const nextRepos = Array.isArray(sessionRepos) ? sessionRepos.map((r) => normPathStr(r)).filter(Boolean) : null;
  const reposChanged = Boolean(nextRepos && (prevRepos.length !== nextRepos.length || prevRepos.some((r, idx) => r !== nextRepos[idx])));
  const nextRev = Number(normalized.rev) || 0;
  const metaChanged =
    force ||
    flowsBusOomDetected ||
    hadLegacyBaseline ||
    prunedCount ||
    cur.sessionStartedAt !== normalized.startedAt ||
    (Number(cur.baselineRev) || 0) !== nextRev;
  if (!metaChanged && !reposChanged) return;
  flowsBusOomDetected = false;
  setShared("cognivisor.flows", {
    ...flows,
    [tabId]: {
      ...cur,
      sessionStartedAt: normalized.startedAt,
      baselineRev: nextRev,
      ...(nextRepos ? { sessionRepos: nextRepos } : {}),
      updatedAt: Date.now(),
    },
  });
}

function getLiveTabIdsSet() {
  const allSpaces = spaces() || [];
  const ids = new Set();
  for (const s of allSpaces) {
    for (const t of s?.tabs || []) {
      if (t?.id) ids.add(t.id);
    }
  }
  return ids;
}

async function peekExistingSessionBaseline(sessionTabId, workspaceRoot, tabTermAddrs = []) {
  if (!sessionTabId) return null;
  const normWs = normPathStr(workspaceRoot || "");
  const flows = safeReadFlows();
  const curFlow = readPlainObject(flows[sessionTabId]);
  const flowRev = Number(curFlow.baselineRev) || 0;
  const appHomeDir = getSafeAppHome();
  const diskMtime = appHomeDir ? await getDiskBaselineMtimeMs(appHomeDir, sessionTabId) : 0;

  const isWinWs = /^[a-zA-Z]:\//.test(normWs) || /^[a-zA-Z]:$/.test(normWs);
  const wsMatches = (a, b) => !a || !b || normCmpStr(a, isWinWs) === normCmpStr(b, isWinWs);

  const cachedEntry = getCachedSessionBaselineEntry(sessionTabId);
  const cached = normalizeSessionBaseline(cachedEntry?.baseline);
  if (
    cached &&
    wsMatches(cached.workspaceRoot, normWs) &&
    (cached.rev || 0) >= flowRev &&
    (!diskMtime || !cachedEntry?.mtimeMs || diskMtime <= cachedEntry.mtimeMs)
  ) {
    return { baseline: cached, dirtyChanged: false };
  }

  const rawExisting = curFlow.sessionBaseline;
  const existing = normalizeSessionBaseline(rawExisting);
  if (
    existing &&
    wsMatches(existing.workspaceRoot, normWs) &&
    (existing.rev || 0) >= flowRev &&
    !diskMtime
  ) {
    cacheSessionBaseline(sessionTabId, existing, 0);
    return { baseline: existing, dirtyChanged: true };
  }

  if (appHomeDir) {
    const fromTab = await readDiskSessionBaseline(appHomeDir, sessionTabId, workspaceRoot, [], false, fsPromises);
    if (fromTab) {
      cacheSessionBaseline(sessionTabId, fromTab, diskMtime);
      return { baseline: fromTab, dirtyChanged: false };
    }
    if (Array.isArray(tabTermAddrs) && tabTermAddrs.length > 0) {
      const reads = await Promise.all(
        tabTermAddrs.slice(0, 2).map((addr) => hc(["read", "--lines", "100", addr]).catch(() => null))
      );
      const transcript = reads.map(extractHcReadText).filter(Boolean).join("\n");
      const resumeKey = extractResumeKeyFromTranscript(transcript, workspaceRoot);
      if (resumeKey) {
        const fromResume = await readDiskSessionBaseline(
          appHomeDir,
          sessionTabId,
          workspaceRoot,
          [],
          { resumeKey, hasResumeCommand: true },
          fsPromises
        );
        if (fromResume) {
          cacheSessionBaseline(sessionTabId, fromResume, 0);
          return { baseline: fromResume, dirtyChanged: true, resumeKey };
        }
      }
    }
  }

  return null;
}

async function resolveOrInitSessionBaseline(sessionTabId, serviceResults, tabTermAddrs, workspaceRoot, preloaded = null) {
  if (!sessionTabId) return { baseline: null, isFresh: false, anchored: false, dirtyChanged: false, primaryBranch: "" };
  const normWs = normPathStr(workspaceRoot || "");
  const isWinWs = /^[a-zA-Z]:\//.test(normWs) || /^[a-zA-Z]:$/.test(normWs);
  const primaryService = (serviceResults || []).find((r) => normCmpStr(r.service?.root, isWinWs) === normCmpStr(normWs, isWinWs))
    || (serviceResults || []).find((r) => r.branch)
    || null;
  const primaryBranch = String(primaryService?.branch || "").trim();
  const candidateBranches = Array.from(
    new Set((serviceResults || []).map((r) => String(r.branch || r.service?.branch || "").trim()).filter(Boolean))
  );

  const existingHit = preloaded || await peekExistingSessionBaseline(sessionTabId, workspaceRoot, tabTermAddrs);
  if (existingHit?.baseline) {
    return {
      baseline: existingHit.baseline,
      isFresh: false,
      anchored: false,
      dirtyChanged: Boolean(existingHit.dirtyChanged),
      primaryBranch,
      resumeKey: existingHit.resumeKey || "",
    };
  }

  const appHomeDir = getSafeAppHome();
  let resumeKey = "";
  if (appHomeDir && Array.isArray(tabTermAddrs) && tabTermAddrs.length > 0) {
    const reads = await Promise.all(
      tabTermAddrs.slice(0, 2).map((addr) => hc(["read", "--lines", "100", addr]).catch(() => null))
    );
    const transcript = reads.map(extractHcReadText).filter(Boolean).join("\n");
    resumeKey = extractResumeKeyFromTranscript(transcript, workspaceRoot);
    if (resumeKey) {
      const fromResume = await readDiskSessionBaseline(
        appHomeDir,
        sessionTabId,
        workspaceRoot,
        candidateBranches,
        { resumeKey, hasResumeCommand: true },
        fsPromises
      );
      if (fromResume) {
        cacheSessionBaseline(sessionTabId, fromResume, 0);
        return { baseline: fromResume, isFresh: false, anchored: false, dirtyChanged: true, primaryBranch, resumeKey };
      }
    }
  }

  const flows = safeReadFlows();
  const curFlow = readPlainObject(flows[sessionTabId]);
  const { startedAt, anchored } = resolveSessionStartTime(curFlow);
  const baseline = buildFreshSessionBaseline(serviceResults, {
    workspaceRoot: normWs,
    startedAt,
    anchored,
    rev: Number(curFlow.baselineRev) || 0,
  });
  cacheSessionBaseline(sessionTabId, baseline, 0);
  return { baseline, isFresh: true, anchored, dirtyChanged: true, primaryBranch, resumeKey };
}

function location() {
  const space = (spaces() || []).find((s) => s.active) || null;
  const f = focused();
  const allPanes = panes() || [];
  const storedAgentTabs = readPlainObject(safeShared("cognivisor.spaceAgentTabs", {}));
  const sessionTabId = resolveSessionAgentTabId(space, allPanes, storedAgentTabs);
  const spaceTabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const spacePanes = allPanes.filter((p) => spaceTabs.has(p.tab));
  const focusedPane = f?.pane ? spacePanes.find((p) => p.pane === f.pane) : null;
  // Anchor to sessionTabId's primary pane before focused split-pane cwd so focusing an auxiliary
  // split terminal in another directory never flips key() and wipes review state.
  const sessionTabPane = sessionTabId ? spacePanes.find((p) => p.tab === sessionTabId && p.cwd) : null;
  const pane =
    sessionTabPane ||
    (focusedPane?.cwd ? focusedPane : null) ||
    spacePanes.find((p) => p.cwd) ||
    focusedPane ||
    null;
  const on = pane?.machine || space?.machine || null;
  const isWin = !on && window()?.platform === "windows";
  const workspaceRoot = resolveWorkspaceRoot({
    spaceFolder: space?.folder,
    paneCwd: pane?.cwd,
    on,
    isWindows: isWin,
    appHomeDir: getSafeAppHome(),
  });

  return { cwd: workspaceRoot, paneCwd: pane?.cwd || null, on, spaceId: space?.id ?? null, tabId: sessionTabId };
}

const key = () => {
  const loc = location();
  return JSON.stringify({ cwd: loc.cwd, on: loc.on, spaceId: loc.spaceId, tabId: loc.tabId });
};

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = READ_GIT_FLAGS;
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

function getDiffColors(t) {
  const s = typeof settings === "function" ? settings() : {};
  const l = typeof layout === "function" ? layout() : {};
  const colors = {
    ...(t || {}),
    ...(s?.colors || {}),
    ...(l?.colors || {}),
  };
  const add = colors.diff_add || colors.added || colors.addition || colors.ansi2 || "#a6bd91";
  const del = colors.diff_del || colors.diff_remove || colors.removed || colors.deletion || colors.ansi1 || "#dc8c95";
  return { add, del };
}

function hexWithAlpha(color, alphaHex) {
  if (!color || typeof color !== "string") return color;
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 6) return `#${hex}${alphaHex}`;
    if (hex.length === 8) return `#${hex.slice(0, 6)}${alphaHex}`;
    if (hex.length === 3) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${alphaHex}`;
  }
  return color;
}

function getDiffTheme(t) {
  const { add, del } = getDiffColors(t);
  return {
    add,
    del,
    addBg: hexWithAlpha(add, "22"),
    delBg: hexWithAlpha(del, "22"),
    addHover: hexWithAlpha(add, "35"),
    delHover: hexWithAlpha(del, "35"),
  };
}

function syntaxTokenColor(kind, t) {
  return diffSyntaxTokenColor(kind, t);
}

const REPO_CACHE_TTL_MS = 60000;
const BUS_MAX_AGE_MS = 90000;
const WATCH_DEBOUNCE_MS = 800;
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

function findChangesBlock(node) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === "changes-review") return node;
  for (const child of node.children ?? []) {
    const found = findChangesBlock(child);
    if (found) return found;
  }
  return null;
}

function isChangesVisible() {
  const root = layout();
  if (!root || typeof root !== "object") return false;
  const panel = findLayoutNode(root, "panel");
  const body = findLayoutNode(root, "panel-body");
  if (panel && body) {
    return !panel.hidden && body.active === "changes";
  }
  const block = findChangesBlock(root);
  return block ? !block.hidden : false;
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

async function fsScanRepos(targetRoot, depth2 = true) {
  if (!targetRoot) return [];
  const level1 = await safeReaddir(targetRoot, { withFileTypes: true });
  if (!level1 || !isSupportedDirentList(level1)) return null;
  const found = [];
  if (await safeExists(join(targetRoot, ".git"))) {
    found.push(targetRoot);
  }
  await Promise.all(
    level1.map(async (e1) => {
      if (!direntIsDir(e1) || !e1.name || DISCOVER_SKIP_DIRS.has(e1.name)) return;
      const p1 = join(targetRoot, e1.name);
      if (await safeExists(join(p1, ".git"))) {
        found.push(p1);
        return;
      }
      if (!depth2) return;
      const level2 = await safeReaddir(p1, { withFileTypes: true });
      if (!level2 || !isSupportedDirentList(level2)) return;
      await Promise.all(
        level2.map(async (e2) => {
          if (!direntIsDir(e2) || !e2.name || DISCOVER_SKIP_DIRS.has(e2.name)) return;
          const p2 = join(p1, e2.name);
          if (await safeExists(join(p2, ".git"))) {
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
    if (await safeExists(join(cur, ".git"))) return cur;
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

  let discovered = [];
  const normWorkspace = normPathStr(workspaceRoot);

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
          return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
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
        return r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
    } catch {}
    return [];
  };

  discovered = await scanRoot(workspaceRoot, true);

  let repoPaths = [];
  for (const p of discovered) {
    const norm = normPathStr(p);
    if (norm && !repoPaths.some(r => normCmpStr(r, isWindows) === normCmpStr(norm, isWindows))) {
      repoPaths.push(norm);
    }
  }

  if (repoPaths.length === 0) {
    const localTop = !on ? await findLocalGitRoot(workspaceRoot) : null;
    if (localTop) {
      repoPaths = [localTop];
    } else {
      const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd: workspaceRoot, on }).catch(() => null);
      if (top && top.code === 0 && top.stdout.trim()) {
        repoPaths = [normPathStr(top.stdout.trim())];
      }
    }
  }

  // If workspaceRoot itself is a single repo (or inside one), also check sibling repos in its parent folder
  const isSingleRepoRoot =
    repoPaths.length === 1 &&
    isSameOrChildPath(normWorkspace, repoPaths[0], isWindows);
  if (isSingleRepoRoot) {
    const parentDir = getParentDir(repoPaths[0]);
    if (parentDir) {
      const siblings = await scanRoot(parentDir, false);
      for (const s of siblings) {
        const normS = normPathStr(s);
        if (normS && !repoPaths.some(r => normCmpStr(r, isWindows) === normCmpStr(normS, isWindows))) {
          repoPaths.push(normS);
        }
      }
    }
  }

  // Also check any extra pane cwds in the active space that may point to other modified repos
  for (const extra of extraCwds || []) {
    if (!extra) continue;
    const normExtra = normPathStr(extra);
    if (!normExtra || repoPaths.some(r => isSameOrChildPath(normExtra, r, isWindows))) continue;
    const localTop = !on ? await findLocalGitRoot(extra) : null;
    if (localTop) {
      if (!repoPaths.some(r => normCmpStr(r, isWindows) === normCmpStr(localTop, isWindows))) repoPaths.push(localTop);
      continue;
    }
    const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], { cwd: extra, on }).catch(() => null);
    if (top && top.code === 0 && top.stdout.trim()) {
      const normTop = normPathStr(top.stdout.trim());
      if (normTop && !repoPaths.some(r => normCmpStr(r, isWindows) === normCmpStr(normTop, isWindows))) repoPaths.push(normTop);
    }
  }

  const services = repoPaths.map(repoRoot => {
    const isInsideWorkspace = isSameOrChildPath(repoRoot, normWorkspace, isWindows);
    let relPath = "";
    if (normCmpStr(repoRoot, isWindows) !== normCmpStr(normWorkspace, isWindows) && isInsideWorkspace) {
      relPath = repoRoot.slice(normWorkspace.length + 1);
    }
    const name = repoRoot.split("/").filter(Boolean).pop() || "root";
    const id = relPath || (normCmpStr(repoRoot, isWindows) === normCmpStr(normWorkspace, isWindows) ? "." : (isInsideWorkspace ? name : `../${name}`));
    return {
      id,
      name,
      relPath,
      root: repoRoot,
      isSibling: !isInsideWorkspace,
    };
  });

  return services;
}

function escapeRegexStr(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function repoMatchesTranscript(service, files, transcript) {
  if (!transcript) return false;
  const normRoot = String(service.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (normRoot && transcript.includes(normRoot)) return true;
  if (service.relPath && service.relPath.length >= 2) {
    const relRe = new RegExp(`(?:^|[\\s"'\`(:\\/])${escapeRegexStr(service.relPath)}/`);
    if (relRe.test(transcript)) return true;
  }
  if (service.name && service.name.length >= 3) {
    const nameRe = new RegExp(`(?:^|[\\s"'\`(:\\/])${escapeRegexStr(service.name)}/`);
    if (nameRe.test(transcript)) return true;
  }
  for (const f of files || []) {
    if (f?.path && f.path.length >= 5 && transcript.includes(f.path)) return true;
  }
  return false;
}

async function loadServiceSessionSnapshot(service, on, opts = {}) {
  return collectServiceSessionSnapshot(service, on, opts, { exec, fsPromises });
}

function readFlows() {
  return safeReadFlows();
}

function readAllActiveDiffs() {
  return readPlainObject(safeShared("changes-review.activeDiff", {}));
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
  setShared("changes-review.activeDiff", { ...all, [spaceId]: state });
  return state;
}

function buildFileDescriptor(f) {
  if (!f) return null;
  return {
    key: f.key,
    path: f.path,
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    displayPath: f.displayPath || f.path,
    repoRoot: f.repoRoot || "",
    serviceId: f.serviceId || ".",
    serviceName: f.serviceName || "root",
    relPrefix: f.relPrefix || "",
    status: f.status || "M",
    workingStatus: f.workingStatus || "",
    inWorkingTree: Boolean(f.inWorkingTree),
    hasHead: Boolean(f.hasHead),
    headHash: f.headHash || "",
    baseRef: f.baseRef || "",
    baseHash: f.baseHash || "",
    baseSource: f.baseSource || "",
    fresh: Boolean(f.fresh),
    binary: Boolean(f.binary),
    add: Number(f.add) || 0,
    del: Number(f.del) || 0,
    sig: f.sig || "",
    mtimeMs: Number(f.mtimeMs) || 0,
  };
}

function buildServiceSummary(s) {
  if (!s) return null;
  const workingCount = Number(s.workingCount) || 0;
  return {
    id: s.id,
    name: s.name,
    relPath: s.relPath || "",
    root: s.root || "",
    isSibling: Boolean(s.isSibling),
    branch: s.branch || "",
    baseRef: s.baseRef || "",
    baseHash: s.baseHash || "",
    workingCount,
    aheadCount: Number(s.aheadCount) || 0,
    dirty: workingCount > 0,
  };
}

function findReviewTabInSpace(spaceId, allSpaces = null, allPanesList = null) {
  if (!spaceId) return null;
  const sList = allSpaces || spaces() || [];
  const pList = allPanesList || panes() || [];
  const space = sList.find((s) => s.id === spaceId) || null;
  if (!space) return null;
  const spaceTabIds = new Set((space.tabs || []).map((t) => t.id));
  const pane = pList.find((p) => p && spaceTabIds.has(p.tab) && p.mod === "changes-review") || null;
  return pane ? { tabId: pane.tab, paneId: pane.pane, space } : null;
}

function getActiveSpaceAndTab() {
  const allSpaces = spaces() || [];
  const allPanes = panes() || [];
  const activeSpace = allSpaces.find((s) => s.active) || null;
  const activeTab = activeSpace?.tabs?.find((t) => t.active) || null;
  const storedAgentTabs = readPlainObject(safeShared("cognivisor.spaceAgentTabs", {}));
  const sessionTabId = resolveSessionAgentTabId(activeSpace, allPanes, storedAgentTabs);
  return { activeSpace, activeTab, activeTabId: activeTab?.id || null, sessionTabId };
}

function updateTabFlow(tabId, mutator, workspaceRoot = "") {
  if (!tabId) return null;
  const flows = readFlows();
  const prev = flows[tabId] || {
    tabId,
    workspaceRoot: workspaceRoot || "",
    stage: "plan",
    ticket: null,
    derivedTitle: null,
    manualTitle: false,
    leadTerminal: null,
    reviewedFiles: {},
    updatedAt: 0,
  };
  const patch = typeof mutator === "function" ? mutator(prev) : mutator;
  if (!patch || typeof patch !== "object") return prev;
  const nextFlow = {
    ...prev,
    ...patch,
    tabId,
    workspaceRoot: prev.workspaceRoot || workspaceRoot || "",
    updatedAt: Date.now(),
  };
  setShared("cognivisor.flows", { ...flows, [tabId]: nextFlow });
  return nextFlow;
}

export default class ChangesReview extends View {
  init(initProps, cx) {
    const p = initProps ?? props();
    this.viewerProps = p || null;
    this.isViewer = p?.role === "viewer";
    this.logger = createModLogger("changes-review");
    this.logger.lifecycle("mod.init", { mode: this.isViewer ? "viewer" : "panel" }, cx);
    safeReadFlows();
    if (flowsBusOomDetected && cx?.timer?.after) {
      cx.timer.after(0, () => {
        if (!flowsBusOomDetected) return;
        flowsBusOomDetected = false;
        try {
          setShared("cognivisor.flows", {});
        } catch {}
      });
    }

    this.files = [];
    this.allSessionFiles = [];
    this.rows = [];
    this.diffWidth = 300;
    this.panelWidth = 420;
    this.viewerWidth = 900;
    this.diffViewportWidth = 0;
    this.diffViewportHeight = 0;
    this.diffScrollPx = 0;
    this.diffScrollbarDrag = null;
    this.focusCommentTask = null;
    this.handle = cx.focus_handle();
    this.bottomTab = "review"; // "review" | "commit"
    this.reviews = []; // Cached mirror of shared("cognivisor.reviewNotes")[sessionKey]
    this.activeComment = null; // { fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, side, baseRef, snippet }
    this.commentText = "";
    this.sendingReview = false;
    this.busy = false;
    this.pendingRefresh = false;
    this.pendingRefreshForce = false;
    this.viewerSourceLines = null;
    this.viewerSourceKey = "";
    this.viewerSourceFilePath = "";
    this.viewerExpandingGapId = null;
    this.localReviewedFiles = new Set();
    this.localReviewedMeta = {};

    // Multi-repository & Git inspection state
    this.workspaceRoot = null;
    this.services = [];
    this.lastPublishedServicesSig = null;
    this.hostIsWindows = window()?.platform === "windows";
    this.watchedRoots = new Map();
    this.watchDebounceTask = null;
    this.candidateCache = null;
    this.lastTranscriptScan = { ts: 0, sig: "", text: "" };
    this.lastConsumedBusTs = 0;
    this.lastConsumedBusSig = "";
    this.renderRefreshTask = null;
    this.agentTabSyncTask = null;
    this.sharedSyncTask = null;
    this.viewerLoadTask = null;
    this.pollTask = null;
    this.viewerLoadedKey = "";
    this.viewerScheduledKey = "";
    this.viewerLoading = false;
    this._viewerClosed = false;
    this.viewerMarkdownRendered = false;
    this.viewerMarkdownFileId = "";
    this.viewerMarkdownLoadedKey = "";
    this.viewerMarkdownLoadedToken = "";
    this.viewerMarkdownLoading = false;
    this.viewerMarkdownError = "";
    this.viewerMarkdownNotice = "";
    this.viewerMarkdownPrepared = null;
    this.viewerMarkdownLoadGen = 0;
    this.viewerMarkdownRawCache = new Map();
    this.viewerMarkdownRenderCache = createMarkdownRenderCache(16);
    this.viewerMarkdownReloadNonces = new Map();
    this.viewerMarkdownLastKeyByFileId = new Map();
    this.lastRequestSeq = 0;
    this.lastHandledSeq = 0;
    this.panelNote = null;
    this.viewerNote = null;
    this.wasVisible = !this.isViewer && isChangesVisible();
    this.hasLoadedOnce = false;
    this.needsRefreshOnShow = false;
    this.diffResizeTask = null;
    this.showAllWorkingChanges = false;
    this.hiddenPreExistingCount = 0;
    this.lastCandidateRoots = [];
    this.lastPrimaryBranch = "";
    this.lastRefreshSummarySig = "";

    // Git commit input
    this.message = "";
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typingCommit = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typingCommit = false; cx.notify(); });

    // Inline review comment textarea (fixed box height for virtual list stability)
    this.commentInput = TextareaState.new({ placeholder: "Add a review note…", rows: 3 });
    this.commentInput.set_soft_wrap(true);
    this.commentInput.on("change", (_e, cx) => {
      const hadText = Boolean(this.commentText.trim());
      this.commentText = this.commentInput.value();
      if (hadText !== Boolean(this.commentText.trim())) cx.notify();
    });
    this.commentInput.on("submit", (_e, cx) => this.saveActiveComment(cx));
    this.commentInput.on("focus", (_e, cx) => { this.typingComment = true; cx.notify(); });
    this.commentInput.on("blur", (_e, cx) => { this.typingComment = false; cx.notify(); });

    if (!this.isViewer) {
      if (this.wasVisible) this.refresh(cx);
      this.pollTask = cx.timer.every(30000, (cx) => {
        if (isChangesVisible()) this.refresh(cx);
      });
    }
  }

  close() {
    this._viewerClosed = true;
    try { this.logger?.dispose?.(); } catch {}
    this.resetViewerMarkdownState(true);
    try { this.renderRefreshTask?.cancel?.(); } catch {}
    this.renderRefreshTask = null;
    try { this.watchDebounceTask?.cancel?.(); } catch {}
    this.watchDebounceTask = null;
    try { this.agentTabSyncTask?.cancel?.(); } catch {}
    this.agentTabSyncTask = null;
    try { this.sharedSyncTask?.cancel?.(); } catch {}
    this.sharedSyncTask = null;
    try { this.viewerLoadTask?.cancel?.(); } catch {}
    this.viewerLoadTask = null;
    try { this.diffResizeTask?.cancel?.(); } catch {}
    this.diffResizeTask = null;
    try { this.focusCommentTask?.cancel?.(); } catch {}
    this.focusCommentTask = null;
    this.diffScrollbarDrag = null;
    this.viewerSourceLines = null;
    this.viewerSourceKey = "";
    this.viewerSourceFilePath = "";
    this.viewerExpandingGapId = null;
    try { this.pollTask?.cancel?.(); } catch {}
    this.pollTask = null;
    this.stopAllWatchers();
    try { this.input?.release(); } catch {}
    try { this.commentInput?.release(); } catch {}
  }

  isViewerMode() {
    const p = props() || this.viewerProps;
    return p?.role === "viewer" || this.isViewer;
  }

  getSessionContext() {
    const vp = props() || this.viewerProps || {};
    const allSpaces = spaces() || [];
    const allPanes = panes() || [];
    const storedAgentTabs = readPlainObject(safeShared("cognivisor.spaceAgentTabs", {}));

    if (this.isViewerMode()) {
      const targetSpaceId = vp.spaceId || null;
      const space = (targetSpaceId && allSpaces.find((s) => s.id === targetSpaceId)) || allSpaces.find((s) => s.active) || null;
      const spaceId = space?.id || targetSpaceId || "default";
      const diff = readActiveDiff(spaceId);
      const sourceTabId =
        diff?.sourceTabId ||
        vp.sourceTabId ||
        resolveSessionAgentTabId(space, allPanes, storedAgentTabs) ||
        null;
      const workspaceRoot = diff?.workspaceRoot || space?.folder || this.workspaceRoot || "";
      return {
        space,
        spaceId,
        sourceTabId,
        workspaceRoot,
        notesKey: getSessionNotesKey(spaceId, sourceTabId),
      };
    }

    const { activeSpace, sessionTabId } = getActiveSpaceAndTab();
    const spaceId = activeSpace?.id || "default";
    const sourceTabId = sessionTabId || null;
    return {
      space: activeSpace,
      spaceId,
      sourceTabId,
      workspaceRoot: this.workspaceRoot || activeSpace?.folder || "",
      notesKey: getSessionNotesKey(spaceId, sourceTabId),
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
    const prev = readPlainObject(safeShared("cognivisor.spaceAgentTabs", {}));
    if (prev[activeSpace.id] === activeTab.id) return;
    setShared("cognivisor.spaceAgentTabs", { ...prev, [activeSpace.id]: activeTab.id });
  }

  scheduleAgentTabSync(cx) {
    if (this.agentTabSyncTask || !cx?.timer) return;
    this.agentTabSyncTask = cx.timer.after(0, () => {
      this.agentTabSyncTask = null;
      this.recordActiveTerminalTabNow();
    });
  }

  scheduleSharedSync(cx, opts = {}) {
    if (this.sharedSyncTask || !cx?.timer) return;
    this.sharedSyncTask = cx.timer.after(0, (cx) => {
      this.sharedSyncTask = null;
      if (this.isViewerMode()) return;
      const ctx = this.getSessionContext();
      const diff = readActiveDiff(ctx.spaceId);
      const revTab = findReviewTabInSpace(ctx.spaceId);
      let changed = false;

      if (revTab && diff && diff.sourceTabId === ctx.sourceTabId) {
        if (diff.openFileKey !== this.open) {
          this.open = diff.openFileKey || null;
          this.closed = !this.open;
          changed = true;
        }
      }

      if (opts.forceNotify || changed) cx.notify();
    });
  }

  getSessionReviews(ctx = null) {
    const c = ctx || this.getSessionContext();
    const allNotes = readPlainObject(safeShared("cognivisor.reviewNotes", {}));
    const list = allNotes[c.notesKey];
    return Array.isArray(list) ? list : [];
  }

  saveSessionReviews(nextReviews, ctx = null) {
    const c = ctx || this.getSessionContext();
    const prevAll = readPlainObject(safeShared("cognivisor.reviewNotes", {}));
    const safeList = Array.isArray(nextReviews) ? nextReviews : [];
    this.reviews = safeList;
    setShared("cognivisor.reviewNotes", { ...prevAll, [c.notesKey]: safeList });
    return safeList;
  }

  resolveFileDescriptor(fileOrKey, fallbackFiles = null) {
    if (!fileOrKey) return null;
    if (typeof fileOrKey === "object" && fileOrKey.key) return buildFileDescriptor(fileOrKey);
    const k = String(fileOrKey);
    const found =
      (this.files || []).find((f) => f.key === k) ||
      (this.allSessionFiles || []).find((f) => f.key === k) ||
      (Array.isArray(fallbackFiles) ? fallbackFiles.find((f) => f.key === k) : null);
    return found ? buildFileDescriptor(found) : null;
  }

  buildActiveDiffPayload(file, overrides = {}) {
    const ctx = this.getSessionContext();
    const prev = readActiveDiff(ctx.spaceId);
    const rawFiles = overrides.files ?? (this.isViewerMode() ? (prev?.files || []) : this.files);
    const rawServices = overrides.services ?? (this.isViewerMode() ? (prev?.services || []) : this.services);
    const openFileDesc = file ? buildFileDescriptor(file) : null;
    const bumpSeq = overrides.bumpSeq !== false;
    const nextSeq = bumpSeq
      ? Math.max(prev?.requestSeq || 0, this.lastRequestSeq || 0) + 1
      : (prev?.requestSeq || this.lastRequestSeq || 1);
    this.lastRequestSeq = nextSeq;

    return {
      spaceId: ctx.spaceId,
      sourceTabId: ctx.sourceTabId,
      workspaceRoot: ctx.workspaceRoot || prev?.workspaceRoot || "",
      on: overrides.on !== undefined ? overrides.on : (this.isViewerMode() ? (prev?.on ?? this.on ?? null) : (this.on ?? null)),
      openFileKey: openFileDesc ? openFileDesc.key : null,
      openFile: openFileDesc,
      files: (rawFiles || []).map(buildFileDescriptor).filter(Boolean),
      services: (rawServices || []).map(buildServiceSummary).filter(Boolean),
      requestSeq: nextSeq,
      focusLine: overrides.focusLine !== undefined ? overrides.focusLine : null,
      focusSide: overrides.focusSide !== undefined ? overrides.focusSide : null,
      openCommentLine: overrides.openCommentLine !== undefined ? overrides.openCommentLine : null,
      openCommentSide: overrides.openCommentSide !== undefined ? overrides.openCommentSide : null,
      ts: Date.now(),
    };
  }

  openReviewTabForFile(fileOrKey, opts = {}) {
    this.recordActiveTerminalTabNow();
    const ctx = this.getSessionContext();
    if (!ctx.spaceId) return null;
    const fileDesc = this.resolveFileDescriptor(fileOrKey);
    const existing = findReviewTabInSpace(ctx.spaceId);

    if (!existing && opts.create === false) {
      return null;
    }

    const payload = this.buildActiveDiffPayload(fileDesc, {
      bumpSeq: opts.bumpSeq !== false,
      focusLine: opts.focusLine ?? null,
      focusSide: opts.focusSide ?? null,
      openCommentLine: opts.openCommentLine ?? null,
      openCommentSide: opts.openCommentSide ?? null,
    });
    writeActiveDiff(ctx.spaceId, payload);

    const title = formatReviewTabTitle(fileDesc);
    if (existing) {
      run("tab.rename", { id: existing.tabId, name: title });
      if (opts.select !== false) {
        run("tab.select", { id: existing.tabId });
      }
    } else if (opts.create !== false) {
      run("tab.new", {
        space: ctx.spaceId,
        name: title,
        mod: "changes-review",
        props: {
          role: "viewer",
          spaceId: ctx.spaceId,
          sourceTabId: ctx.sourceTabId,
        },
      });
    }
    return payload;
  }

  scheduleRenderRefresh(cx) {
    if (this.isViewerMode() || this.renderRefreshTask || !cx?.timer) return;
    this.renderRefreshTask = cx.timer.after(0, (cx) => {
      this.renderRefreshTask = null;
      if (isChangesVisible()) {
        this.refresh(cx);
      }
    });
  }

  buildCommentMapForFile(fileKey, ctx = null) {
    const commentMap = new Map();
    if (!fileKey) return commentMap;
    const sessionReviews = this.getSessionReviews(ctx);
    for (const r of sessionReviews) {
      if (r && (r.fileKey === fileKey || r.file === fileKey)) {
        commentMap.set(buildCommentKey(fileKey, r.line, r.side), r);
      }
    }
    return commentMap;
  }

  getComment(fileKey, line, side = "new", ctx = null) {
    const targetSide = normalizeCommentSide(side);
    const reviews = this.getSessionReviews(ctx);
    return reviews.find(
      (r) =>
        r &&
        (r.fileKey === fileKey || r.file === fileKey) &&
        r.line === line &&
        normalizeCommentSide(r.side) === targetSide,
    );
  }

  cancelFocusCommentTask() {
    if (this.focusCommentTask) {
      try { this.focusCommentTask.cancel(); } catch {}
      this.focusCommentTask = null;
    }
  }

  focusCommentInput(cx, expectedFileKey = null, expectedLine = null, expectedSide = null) {
    try { this.commentInput?.focus?.(); } catch {}
    this.cancelFocusCommentTask();
    if (!cx?.timer) return;
    const targetKey = expectedFileKey ?? this.activeComment?.fileKey ?? null;
    const targetLine = expectedLine ?? this.activeComment?.line ?? null;
    const targetSide = expectedSide ?? this.activeComment?.side ?? null;
    this.focusCommentTask = cx.timer.after(20, () => {
      this.focusCommentTask = null;
      if (this._viewerClosed || !this.activeComment) return;
      if (targetKey !== null && this.activeComment.fileKey !== targetKey) return;
      if (targetLine !== null && this.activeComment.line !== targetLine) return;
      if (targetSide !== null && normalizeCommentSide(this.activeComment.side) !== normalizeCommentSide(targetSide)) return;
      try { this.commentInput?.focus?.(); } catch {}
    });
  }

  openCommentEditor(file, line, side, snippet, initialText, cx = null) {
    const text = initialText ?? "";
    const normSide = normalizeCommentSide(side);
    const diff = this.isViewerMode() ? readActiveDiff(this.getSessionContext().spaceId) : null;
    const fallbackKey = file?.key || diff?.openFileKey || this.open;
    this.activeComment = {
      fileKey: fallbackKey,
      serviceId: file?.serviceId || "",
      serviceName: file?.serviceName || "",
      repoRoot: file?.repoRoot || this.root || "",
      file: file?.path || fallbackKey,
      displayPath: file?.displayPath || file?.path || fallbackKey,
      baseRef: file?.baseRef || "",
      line,
      side: normSide,
      snippet: (snippet || "").trim(),
    };
    this.commentText = text;
    this.commentInput.set_value(text);
    this.commentInput.set_selected_range({ start: text.length, end: text.length });
    this.focusCommentInput(cx, fallbackKey, line, normSide);
  }

  startComment(fileKey, line, side, snippet, cx, rowIndex = -1) {
    const normSide = normalizeCommentSide(side);
    if (
      this.activeComment &&
      this.activeComment.fileKey === fileKey &&
      this.activeComment.line === line &&
      normalizeCommentSide(this.activeComment.side) === normSide
    ) {
      this.focusCommentInput(cx, fileKey, line, normSide);
      cx?.notify();
      return;
    }
    const hadComposer = Boolean(this.activeComment && this.activeComment.fileKey === fileKey);
    const ctx = this.getSessionContext();
    const diff = this.isViewerMode() ? readActiveDiff(ctx.spaceId) : null;
    const file =
      (diff?.openFile?.key === fileKey ? diff.openFile : null) ||
      (diff?.files || []).find((f) => f.key === fileKey) ||
      (this.files || []).find((f) => f.key === fileKey) ||
      (this.allSessionFiles || []).find((f) => f.key === fileKey);
    const existing = this.getComment(fileKey, line, normSide, ctx);
    this.openCommentEditor(file, line, normSide, snippet, existing ? existing.text : "", cx);
    if (rowIndex >= 0 && this.rows.length > 0) {
      const commentMap = this.buildCommentMapForFile(fileKey, ctx);
      const layout = this.computeDiffRowLayout(commentMap, this.getReviewWrapCols(), fileKey);
      const baseVpH = this.getDiffViewportHeight();
      const targetVpH = hadComposer ? baseVpH : Math.max(80, baseVpH - REVIEW_COMPOSER_EST_HEIGHT);
      this.diffScrollPx = computeDiffScrollOffsetForRow(layout, rowIndex, targetVpH, "nearest", this.diffScrollPx);
    }
    cx.notify();
  }

  saveActiveComment(cx) {
    if (!this.activeComment) return;
    const ctx = this.getSessionContext();
    const curReviews = this.getSessionReviews(ctx);
    const raw = (this.commentInput.value() ?? "").replace(/\r\n/g, "\n");
    const text = raw.trim();
    const { fileKey, serviceId, serviceName, repoRoot, file, displayPath, baseRef, line, side, snippet } = this.activeComment;
    const normSide = normalizeCommentSide(side);
    const matchesTarget = (r) =>
      r &&
      (r.fileKey === fileKey || r.file === fileKey) &&
      r.line === line &&
      normalizeCommentSide(r.side) === normSide;

    let nextReviews;
    if (text) {
      const idx = curReviews.findIndex(matchesTarget);
      const item = {
        fileKey,
        serviceId,
        serviceName,
        repoRoot,
        file,
        displayPath,
        baseRef: baseRef || "",
        line,
        side: normSide,
        text,
        snippet,
      };
      if (idx >= 0) {
        nextReviews = curReviews.map((r, i) => (i === idx ? item : r));
      } else {
        nextReviews = [...curReviews, item];
      }
    } else {
      nextReviews = curReviews.filter((r) => !matchesTarget(r));
    }
    this.saveSessionReviews(nextReviews, ctx);
    this.cancelFocusCommentTask();
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  cancelActiveComment(cx) {
    this.cancelFocusCommentTask();
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  removeComment(fileKey, line, side = "new", cx = null) {
    const normSide = normalizeCommentSide(side);
    const ctx = this.getSessionContext();
    const curReviews = this.getSessionReviews(ctx);
    const nextReviews = curReviews.filter(
      (r) => !(r && (r.fileKey === fileKey || r.file === fileKey) && r.line === line && normalizeCommentSide(r.side) === normSide),
    );
    this.saveSessionReviews(nextReviews, ctx);
    if (
      this.activeComment &&
      this.activeComment.fileKey === fileKey &&
      this.activeComment.line === line &&
      normalizeCommentSide(this.activeComment.side) === normSide
    ) {
      this.cancelActiveComment(cx);
    } else {
      cx?.notify();
    }
  }

  clearComments(cx) {
    const ctx = this.getSessionContext();
    this.saveSessionReviews([], ctx);
    this.cancelFocusCommentTask();
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx?.notify();
  }

  jumpToComment(comment, cx) {
    this.recordActiveTerminalTabNow();
    const ctx = this.getSessionContext();
    const commentSide = normalizeCommentSide(comment?.side);
    const latest = this.getComment(comment.fileKey || comment.file, comment.line, commentSide, ctx) || comment;
    this.bottomTab = "review";

    const targetKey = latest.fileKey || latest.file;
    const targetFile = this.resolveFileDescriptor(targetKey) || buildFileDescriptor({
      key: targetKey,
      path: latest.file || targetKey,
      displayPath: latest.displayPath || latest.file || targetKey,
      repoRoot: latest.repoRoot || this.root || "",
      serviceId: latest.serviceId || "",
      serviceName: latest.serviceName || "",
      baseRef: latest.baseRef || "",
      status: "M",
      hasHead: true,
      fresh: false,
      add: 0,
      del: 0,
    });
    this.open = targetFile?.key || targetKey;
    this.closed = false;
    this.panelNote = null;
    const focusSide = normalizeCommentSide(latest.side);
    this.openReviewTabForFile(targetFile, {
      create: true,
      select: true,
      bumpSeq: true,
      focusLine: latest.line,
      focusSide,
      openCommentLine: latest.line,
      openCommentSide: focusSide,
    });
    cx.notify();
  }

  findActiveAgent() {
    const allAgents = agents() || [];
    const allTerminals = terminals() || [];
    const allPanes = panes() || [];
    const f = focused();
    const { sessionTabId } = this.getSessionContext ? { sessionTabId: this.getSessionContext().sourceTabId } : getActiveSpaceAndTab();
    const targetTabId = sessionTabId;

    const agentMap = new Map(allAgents.map((a) => [a.address, a]));
    const termMap = new Map(allTerminals.map((t) => [t.address, t]));

    const isRunner = (addr, pane) => {
      if (pane?.labels?.cognivisorRunner === "true") return true;
      const term = addr ? termMap.get(addr) : null;
      return term?.labels?.cognivisorRunner === "true";
    };

    const toTerminalAgent = (term, fallbackTabId) => {
      if (!term || (term.state && term.state !== "live")) return null;
      return {
        address: term.address,
        title: term.title || term.name || term.program?.name || term.address,
        app: term.program?.name || term.program?.key || term.name || null,
        program: term.program || null,
        tab: fallbackTabId || targetTabId || null,
      };
    };

    // 1. cognivisor.flows[targetTabId]?.leadTerminal -> match in agents() or terminals() (excluding runners)
    if (targetTabId) {
      const flows = readFlows();
      const leadAddr = flows[targetTabId]?.leadTerminal || null;
      if (leadAddr && !isRunner(leadAddr, null)) {
        const leadAgent = agentMap.get(leadAddr);
        if (leadAgent) return leadAgent;
        const leadTerm = toTerminalAgent(termMap.get(leadAddr), targetTabId);
        if (leadTerm) return leadTerm;
      }
    }

    // 2. focused()?.agent -> match in agents() (excluding cognivisorRunner=true)
    if (f?.agent && !isRunner(f.agent, null)) {
      const focusedAgent = agentMap.get(f.agent);
      if (focusedAgent) return focusedAgent;
    }

    // 3. Non-runner agent in targetTabId (panes() + terminals() + agents(), excluding labels?.cognivisorRunner === "true")
    if (targetTabId) {
      const tabPanes = allPanes.filter((p) => p.tab === targetTabId && p.terminal && !isRunner(p.terminal, p));
      const sortedTabPanes = [...tabPanes].sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)));
      for (const p of sortedTabPanes) {
        const m = agentMap.get(p.terminal);
        if (m) return m;
      }
      const tabNonRunnerAgent = allAgents.find((a) => a.tab === targetTabId && !isRunner(a.address, null));
      if (tabNonRunnerAgent) return tabNonRunnerAgent;

      for (const p of sortedTabPanes) {
        const term = termMap.get(p.terminal);
        if (p.program?.agent || term?.program?.agent || term?.reported) {
          const candidate = toTerminalAgent(term, targetTabId);
          if (candidate) return candidate;
        }
      }

      // 4. Non-runner or fallback agent in targetTabId
      const tabFallbackAgent =
        allAgents.find((a) => a.tab === targetTabId && !isRunner(a.address, null)) ||
        allAgents.find((a) => a.tab === targetTabId);
      if (tabFallbackAgent) return tabFallbackAgent;
    }

    // 5. agents()[0] global fallback (prefer non-runner)
    return allAgents.find((a) => !isRunner(a.address, null)) || allAgents[0] || null;
  }

  sendReview(cx) {
    const ctx = this.getSessionContext();
    const sessionReviews = this.getSessionReviews(ctx);
    if (this.sendingReview || sessionReviews.length === 0) return;
    const agent = this.findActiveAgent();
    if (!agent) {
      this.panelNote = "No active agent found to send review notes to.";
      cx?.notify();
      return;
    }

    const message = formatReviewAgentMessage(sessionReviews, {
      workspaceRoot: ctx.workspaceRoot,
      fallbackRoot: this.root,
    });
    const reviewCount = sessionReviews.length;

    this.sendingReview = true;
    this.panelNote = null;
    this.logger?.action("review.sendStarted", {
      agentAddress: agent.address,
      reviewCount,
      messageLength: message.length,
    }, cx);
    cx?.notify();

    const runSend = async (asyncCx) => {
      try {
        const preScreenRes = await hc(["read", "--lines", "0", agent.address]).catch(() => null);
        const preScreen = preScreenRes && preScreenRes.code === 0 && typeof preScreenRes.stdout === "string"
          ? preScreenRes.stdout
          : "";

        const r = await hc(["send", "--json", agent.address, message]);
        if (this._viewerClosed) return;
        if (!r || r.code !== 0) {
          throw new Error(formatHcErrorMessage(r, "Failed to send review to agent"));
        }

        const sendResult = parseHcJsonOutput(r.stdout || "");
        let nudges = 0;

        if (sendResult?.started !== true) {
          const maxNudges = sendResult?.started === false ? 2 : 1;
          for (let attempt = 0; attempt < maxNudges; attempt += 1) {
            const waitMs = attempt === 0 ? (sendResult?.started === false ? 250 : 350) : 450;
            if (asyncCx?.sleep) {
              await asyncCx.sleep(waitMs);
            }
            if (this._viewerClosed) return;

            const [termRes, screenRes] = await Promise.all([
              hc(["get", "--json", agent.address]).catch(() => null),
              hc(["read", "--lines", "0", agent.address]).catch(() => null),
            ]);
            if (this._viewerClosed) return;

            const liveTerminal = termRes && termRes.code === 0 ? parseHcJsonOutput(termRes.stdout || "") : null;
            const postScreen = screenRes && screenRes.code === 0 && typeof screenRes.stdout === "string"
              ? screenRes.stdout
              : "";

            const decision = decideSendSubmitAction({
              sendResult,
              liveTerminal,
              preScreen,
              postScreen,
              message,
              requireScreenMatch: attempt > 0,
            });
            if (!decision.shouldNudge) {
              break;
            }

            nudges += 1;
            this.logger?.action("review.sendSubmitNudge", {
              agentAddress: agent.address,
              attempt: nudges,
              reason: decision.reason,
              submitKey: decision.submitKey,
            }, asyncCx);
            await hc(["keys", agent.address, decision.submitKey]).catch(() => null);
          }
        }

        if (this._viewerClosed) return;
        this.logger?.action("review.sendSuccess", {
          agentAddress: agent.address,
          reviewCount,
          started: sendResult?.started ?? null,
          nudges,
        }, asyncCx);
        notify({ title: "Review notes sent to agent", level: "success" });
        this.clearComments(asyncCx);
      } catch (e) {
        if (this._viewerClosed) return;
        this.logger?.error("review.sendFailed", e, {
          agentAddress: agent.address,
          reviewCount,
        }, asyncCx);
        this.panelNote = `Failed to send review: ${e?.message || e}`;
      } finally {
        if (!this._viewerClosed) {
          this.sendingReview = false;
          try { asyncCx?.notify(); } catch {}
        }
      }
    };

    if (cx?.spawn) {
      cx.spawn(runSend);
    } else {
      runSend(cx);
    }
  }

  fileReviewKey(file) {
    return buildReviewedFileKey(file) || null;
  }

  isFileReviewed(file, flow) {
    const rk = this.fileReviewKey(file);
    if (!rk) return false;
    const flowEntry = flow?.reviewedFiles?.[rk];
    if (flowEntry !== undefined) {
      return Boolean(parseReviewedFileRecord(flowEntry));
    }
    if (flow?.tabId || this.getSessionContext().sourceTabId) {
      return false;
    }
    return Boolean(this.localReviewedFiles?.has(rk));
  }

  buildLocalReviewedSnapshot() {
    const out = { ...(this.localReviewedMeta || {}) };
    for (const rk of this.localReviewedFiles || []) {
      if (!Object.prototype.hasOwnProperty.call(out, rk)) {
        out[rk] = true;
      }
    }
    return out;
  }

  syncLocalReviewedFromMap(map) {
    this.localReviewedFiles.clear();
    this.localReviewedMeta = {};
    for (const [rk, val] of Object.entries(map || {})) {
      const rec = parseReviewedFileRecord(val);
      if (rec) {
        this.localReviewedFiles.add(rk);
        this.localReviewedMeta[rk] = rec;
      }
    }
  }

  applyFileReviewToggle(fileObj, fileKey, ctx) {
    const rk = this.fileReviewKey(fileKey);
    if (!rk || !fileKey) return { nextReviewed: false, updatedFlow: null };

    const flows = readFlows();
    const curFlow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    const nextReviewed = !this.isFileReviewed(fileKey, curFlow);
    const record = nextReviewed
      ? {
          reviewed: true,
          fp: computeFileReviewFingerprint(fileObj || { key: fileKey }),
          reviewedAt: Date.now(),
        }
      : null;

    if (nextReviewed) {
      this.localReviewedFiles.add(rk);
      this.localReviewedMeta[rk] = record;
    } else {
      this.localReviewedFiles.delete(rk);
      delete this.localReviewedMeta[rk];
    }

    let updatedFlow = curFlow;
    if (ctx.sourceTabId) {
      updatedFlow = updateTabFlow(
        ctx.sourceTabId,
        (prev) => {
          const nextMap = { ...(prev.reviewedFiles || {}) };
          if (nextReviewed) nextMap[rk] = record;
          else delete nextMap[rk];
          return { reviewedFiles: nextMap };
        },
        ctx.workspaceRoot,
      );
    }

    return { nextReviewed, updatedFlow };
  }

  toggleFileReviewed(file, cx) {
    const fileKey = typeof file === "string" ? file : file?.key;
    const rk = this.fileReviewKey(fileKey);
    if (!rk || !fileKey) return;

    const fileObj = typeof file === "object" && file ? file : this.resolveFileDescriptor(fileKey);
    const ctx = this.getSessionContext();
    this.applyFileReviewToggle(fileObj, fileKey, ctx);
    cx.notify();
  }

  pickPreferredFileForCurrentList(preferUnreviewed = false) {
    const files = this.files || [];
    if (files.length === 0) return null;
    if (!preferUnreviewed && this.open) {
      const existing = files.find((f) => f.key === this.open);
      if (existing) return existing;
    }
    const ctx = this.getSessionContext();
    const flows = readFlows();
    const flow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    return (
      pickNextUnreviewedFile(files, null, (f) => this.isFileReviewed(f, flow)) ||
      files[0] ||
      null
    );
  }

  getTargetRepos() {
    if (!this.services || this.services.length === 0) return [];
    return this.services.filter((s) => Array.isArray(s.dirtyPaths) && s.dirtyPaths.length > 0);
  }

  commit(cx) {
    const targetRepos = this.getTargetRepos();
    if (!this.message.trim() || targetRepos.length === 0 || this.busy || this.loading || this.context !== key()) return;
    const on = this.on, context = this.context, message = this.message.trim();
    this.busy = true;
    this.panelNote = null;
    cx.spawn(async (cx) => {
      const errors = [];
      try {
        for (const repo of targetRepos) {
          const root = repo.root;
          const dirtyPaths = Array.isArray(repo.dirtyPaths) ? repo.dirtyPaths.filter(Boolean) : [];
          if (dirtyPaths.length === 0) continue;
          const stagePaths = Array.isArray(repo.stagePaths) ? repo.stagePaths.filter(Boolean) : dirtyPaths;
          let repoOk = true;
          // Stage ONLY visible session dirty paths needing staging (skipping already-staged `git rm`
          // deletions where `git add -- <path>` would exit 128; never `git add -A`).
          const CHUNK = 100;
          for (let i = 0; i < stagePaths.length; i += CHUNK) {
            const slice = stagePaths.slice(i, i + CHUNK);
            const addRes = await exec("git", ["add", "--", ...slice], { cwd: root, on });
            if (addRes.code !== 0) {
              errors.push(`[${repo.name}]: ${(addRes.stderr || addRes.stdout).trim()}`);
              repoOk = false;
              break;
            }
          }
          if (!repoOk) continue;
          const commitRes = await exec("git", ["commit", "-m", message], { cwd: root, on });
          if (commitRes.code !== 0) {
            errors.push(`[${repo.name}]: ${(commitRes.stderr || commitRes.stdout).trim()}`);
          }
        }
        if (errors.length > 0) {
          throw new Error(errors.join("\n"));
        }
        if (key() === context) {
          this.message = "";
          this.input.set_value("");
        }
      } catch (e) {
        if (key() === context) this.panelNote = `Commit failed:\n${e.message || e}`;
      } finally {
        this.busy = false;
        this.candidateCache = null;
        this.refresh(cx, { force: true });
        cx.notify();
      }
    });
    cx.notify();
  }

  stopAllWatchers() {
    if (this.watchedRoots) this.watchedRoots.clear();
    if (this.watchDebounceTask) {
      try { this.watchDebounceTask.cancel(); } catch {}
      this.watchDebounceTask = null;
    }
  }

  scheduleRefresh(cx, delayMs = WATCH_DEBOUNCE_MS) {
    if (this.isViewerMode()) return;
    if (this.watchDebounceTask) {
      try { this.watchDebounceTask.cancel(); } catch {}
      this.watchDebounceTask = null;
    }
    const ctx = this.context;
    this.watchDebounceTask = cx.timer.after(delayMs, (cx) => {
      this.watchDebounceTask = null;
      if (key() !== ctx) return;
      if (!isChangesVisible()) {
        this.needsRefreshOnShow = true;
        return;
      }
      this.refresh(cx, { fromWatch: true });
    });
  }

  watch(services, cx) {
    if (this.isViewerMode() || this.on || !Array.isArray(services) || services.length === 0) {
      this.stopAllWatchers();
      return;
    }
    const MAX_WATCHED_REPOS = 24;
    const targets = services.length <= MAX_WATCHED_REPOS
      ? services
      : (this.workspaceRoot ? [{ root: this.workspaceRoot }] : services.slice(0, MAX_WATCHED_REPOS));
    const desired = new Map();
    for (const s of targets) {
      if (!s?.root) continue;
      const norm = normPathStr(s.root);
      if (norm && !desired.has(norm)) desired.set(norm, s.root);
    }
    for (const existingNorm of [...this.watchedRoots.keys()]) {
      if (!desired.has(existingNorm)) this.watchedRoots.delete(existingNorm);
    }
    for (const [normRoot, rawRoot] of desired.entries()) {
      if (this.watchedRoots.has(normRoot)) continue;
      const token = Symbol(normRoot);
      this.watchedRoots.set(normRoot, token);
      const ctx = this.context;
      cx.spawn(async (cx) => {
        while (this.watchedRoots.get(normRoot) === token && this.context === ctx) {
          try {
            const changed = await watchFolder(rawRoot);
            if (this.watchedRoots.get(normRoot) !== token || this.context !== ctx) break;
            if (!hasRelevantWatchChange(changed, rawRoot)) continue;
            if (!isChangesVisible()) {
              this.needsRefreshOnShow = true;
              continue;
            }
            this.scheduleRefresh(cx, WATCH_DEBOUNCE_MS);
          } catch {
            if (this.watchedRoots.get(normRoot) !== token || this.context !== ctx) break;
            await cx.sleep(3000);
          }
        }
      });
    }
  }

  toggleShowAllWorkingChanges(cx) {
    this.showAllWorkingChanges = !this.showAllWorkingChanges;
    this.logger?.action("review.toggleShowAll", {
      showAll: this.showAllWorkingChanges,
      hiddenPreExistingCount: this.hiddenPreExistingCount,
    }, cx);
    this.refresh(cx, { force: true });
    cx.notify();
  }

  resetSessionBaseline(cx) {
    const { sessionTabId } = getActiveSpaceAndTab();
    if (!sessionTabId || !this.workspaceRoot) return;
    const flows = safeReadFlows();
    const cachedEntry = getCachedSessionBaselineEntry(sessionTabId);
    const curBaseline = cachedEntry?.baseline || flows[sessionTabId]?.sessionBaseline || null;
    const repoRoots = Array.from(
      new Set([
        ...(this.lastCandidateRoots || []),
        ...(this.services || []).map((s) => normPathStr(s?.root)).filter(Boolean),
        normPathStr(this.workspaceRoot),
      ].filter(Boolean))
    );
    this.logger?.action("review.resetBaseline", {
      repoCount: repoRoots.length,
      previousHiddenCount: this.hiddenPreExistingCount,
    }, cx);
    const nextBaseline = createResetSessionBaseline(curBaseline, repoRoots, this.workspaceRoot);
    this.showAllWorkingChanges = false;
    this.hiddenPreExistingCount = 0;
    const appHomeDir = getSafeAppHome();
    const workspaceRoot = this.workspaceRoot;
    const primaryBranch = this.lastPrimaryBranch || "";
    cx.spawn(async (cx) => {
      let diskMtime = 0;
      if (appHomeDir) {
        await writeDiskSessionBaseline(appHomeDir, sessionTabId, workspaceRoot, primaryBranch, nextBaseline, "", fsPromises);
        diskMtime = await getDiskBaselineMtimeMs(appHomeDir, sessionTabId);
      }
      mergeSessionBaselineIntoFlow(sessionTabId, nextBaseline, null, true, diskMtime);
      try {
        notify({ title: "Session baseline reset", body: "All current working changes are now included in this session.", level: "info" });
      } catch {}
      this.refresh(cx, { force: true });
    });
    cx.notify();
  }

  refresh(cx, opts = {}) {
    if (this.isViewerMode() || this.busy) return;
    if (this.loading) {
      this.pendingRefresh = true;
      if (opts?.force) this.pendingRefreshForce = true;
      return;
    }
    this.pendingRefresh = false;
    this.pendingRefreshForce = false;
    this.recordActiveTerminalTabNow();
    const loc = location(), context = key();
    const workspaceRoot = loc.cwd;
    const on = loc.on;
    const force = Boolean(opts?.force);

    if (context !== this.context) {
      this.context = context;
      this.workspaceRoot = workspaceRoot;
      this.root = workspaceRoot;
      this.on = on;
      this.services = [];
      this.allSessionFiles = [];
      this.files = [];
      this.open = null;
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.panelNote = null;
      this.stopAllWatchers();
      this.candidateCache = null;
      this.lastTranscriptScan = { ts: 0, sig: "", text: "" };
      this.lastConsumedBusTs = 0;
      this.lastConsumedBusSig = "";
      this.hasLoadedOnce = false;
      this.needsRefreshOnShow = false;
      this.pendingRefresh = false;
      this.pendingRefreshForce = false;
      this.closed = false;
      this.limited = false;
      this.localReviewedFiles.clear();
      this.localReviewedMeta = {};
      this.showAllWorkingChanges = false;
      this.hiddenPreExistingCount = 0;
      this.lastCandidateRoots = [];
      this.lastPrimaryBranch = "";
      this.lastRefreshSummarySig = "";
    }

    this.isWindows = !on && this.hostIsWindows;

    if (!workspaceRoot) {
      this.error = "No folder";
      return;
    }

    this.hasLoadedOnce = true;
    const { activeSpace, sessionTabId } = getActiveSpaceAndTab();
    const normWs = normPathStr(workspaceRoot);
    const cmpWs = normCmpStr(workspaceRoot, this.isWindows);
    const bus = !force ? safeShared("cognivisor.services", null) : null;
    if (typeof bus?.ts === "number") {
      this.lastConsumedBusTs = bus.ts;
      this.lastConsumedBusSig = bus.sig || String(bus.ts);
    } else if (bus?.sig) {
      this.lastConsumedBusSig = bus.sig;
    }

    const busFresh = Boolean(
      bus &&
      typeof bus.ts === "number" &&
      (Date.now() - bus.ts) < BUS_MAX_AGE_MS &&
      normCmpStr(bus.workspaceRoot, this.isWindows) === cmpWs &&
      (bus.tabId || null) === (sessionTabId || null) &&
      (bus.on || null) === (on || null) &&
      Array.isArray(bus.services)
    );

    if (busFresh && Array.isArray(bus.candidates) && bus.candidates.length === 0) {
      this.workspaceRoot = workspaceRoot;
      this.services = [];
      this.root = workspaceRoot;
      this.allSessionFiles = [];
      this.files = [];
      this.open = null;
      this.stopAllWatchers();
      this.error = "Not a git repository";
      cx.notify();
      return;
    }

    this.loading = true;
    const isWindows = this.isWindows;
    const allPanesList = panes() || [];
    const extraCwds = sessionTabId
      ? Array.from(new Set(allPanesList.filter((p) => p?.cwd && p.tab === sessionTabId).map((p) => p.cwd)))
      : [];
    const tabPaneCwds = extraCwds;
    const tabFlowObj = sessionTabId && safeReadFlows()[sessionTabId];
    const tabTermAddrs = sessionTabId
      ? Array.from(
          new Set([
            ...(tabFlowObj?.leadTerminal ? [tabFlowObj.leadTerminal] : []),
            ...allPanesList.filter((p) => p.tab === sessionTabId && p.terminal && p.labels?.cognivisorRunner !== "true").map((p) => p.terminal),
            ...(agents() || []).filter((a) => a.tab === sessionTabId).map((a) => a.address),
          ])
        )
      : [];

    cx.spawn(async (cx) => {
      try {
        let candidateServices;
        const usingBusCandidates = Boolean(busFresh && Array.isArray(bus?.candidates) && bus.candidates.length > 0);
        if (usingBusCandidates) {
          candidateServices = mergeBusCandidateServices(bus.candidates, bus.services, isWindows);
        } else {
          const cacheKey = `${workspaceRoot}|${on || ""}|${extraCwds.slice().sort().join(",")}`;
          const now = Date.now();
          if (!force && this.candidateCache && this.candidateCache.key === cacheKey && (now - this.candidateCache.ts) < REPO_CACHE_TTL_MS) {
            candidateServices = this.candidateCache.services.map((s) => ({ ...s }));
          } else {
            candidateServices = await discoverRepos(workspaceRoot, on, isWindows, extraCwds);
            if (key() !== context) return;
            this.candidateCache = { key: cacheKey, services: candidateServices.map((s) => ({ ...s })), ts: Date.now() };
          }
        }

        if (!candidateServices || candidateServices.length === 0) {
          this.services = [];
          this.allSessionFiles = [];
          this.files = [];
          this.open = null;
          this.stopAllWatchers();
          this.error = "Not a git repository";
          return;
        }

        // Pre-load existing session baseline so snapshots receive startHead & dirtyFiles upfront.
        const preloadedBaseline = sessionTabId
          ? await peekExistingSessionBaseline(sessionTabId, workspaceRoot, tabTermAddrs)
          : null;
        if (key() !== context) return;

        const serviceResults = [];
        const SNAPSHOT_CONCURRENCY = 4;
        for (let i = 0; i < candidateServices.length; i += SNAPSHOT_CONCURRENCY) {
          const batch = candidateServices.slice(i, i + SNAPSHOT_CONCURRENCY);
          const batchRes = await Promise.all(
            batch.map((service) => {
              const baselineRepo = findBaselineRepoEntry(preloadedBaseline?.baseline?.repos, service?.root, isWindows);
              return loadServiceSessionSnapshot(service, on, { baselineRepo });
            })
          );
          if (key() !== context) return;
          for (const item of batchRes) serviceResults.push(item);
        }

        const erroredServiceIds = new Set();
        let firstSnapshotError = null;
        for (const res of serviceResults) {
          if (res.error) {
            if (!firstSnapshotError) firstSnapshotError = res;
            if (res.service?.id) erroredServiceIds.add(res.service.id);
          }
        }
        if (firstSnapshotError) {
          this.logger?.error("review.snapshotFailed", firstSnapshotError.error, {
            serviceId: firstSnapshotError.service?.id || "",
            serviceName: firstSnapshotError.service?.name || "",
            erroredCount: erroredServiceIds.size,
            candidatesCount: serviceResults.length,
          }, cx);
        }

        const baselineInit = sessionTabId
          ? await resolveOrInitSessionBaseline(sessionTabId, serviceResults, tabTermAddrs, workspaceRoot, preloadedBaseline)
          : { baseline: null, isFresh: false, dirtyChanged: false, primaryBranch: "" };
        if (key() !== context) return;

        const sessionBaseline = baselineInit.baseline;
        let baselineDirtyChanged = Boolean(baselineInit.dirtyChanged);
        let touchedResults = [];
        let totalHiddenPreExisting = 0;
        this.lastCandidateRoots = candidateServices.map((s) => normPathStr(s?.root)).filter(Boolean);
        this.lastPrimaryBranch = baselineInit.primaryBranch || "";

        const activeFeatureBranches = collectActiveFeatureBranches(serviceResults, {
          workspaceRoot,
          paneCwds: tabPaneCwds,
          isWindows,
        });

        if (sessionTabId && sessionBaseline) {
          const startedAt = sessionBaseline.startedAt || 0;
          const flowsNow = safeReadFlows();
          const curFlowNow = readPlainObject(flowsNow[sessionTabId]);
          const prevSessionRepos = new Set(
            Array.isArray(curFlowNow.sessionRepos)
              ? curFlowNow.sessionRepos.map((r) => normCmpStr(r, isWindows)).filter(Boolean)
              : []
          );
          const normPaneCwds = tabPaneCwds.map((c) => normPathStr(c)).filter(Boolean);

          const needTranscriptRepos = [];
          for (const res of serviceResults) {
            const normRoot = normPathStr(res.service?.root);
            const cmpRoot = normCmpStr(normRoot, isWindows);
            if (!normRoot || res.error) continue;
            const inPaneCwd = normPaneCwds.some((c) => isSameOrChildPath(c, normRoot, isWindows));
            const inWorkspaceRoot = Boolean(cmpWs && cmpRoot === cmpWs);
            const sameFeatureBranch = isMatchingFeatureBranch(res.branch || res.service?.branch, activeFeatureBranches);
            if (prevSessionRepos.has(cmpRoot) || inPaneCwd || inWorkspaceRoot || sameFeatureBranch) continue;
            const bRepo = findBaselineRepoEntry(sessionBaseline.repos, normRoot, isWindows);
            const headMoved = Boolean(!baselineInit.isFresh && bRepo?.startHead && res.headHash && bRepo.startHead !== res.headHash);
            const unbaselinedNoMtime = Boolean(!baselineInit.isFresh && !bRepo && (res.workingFiles || []).some((f) => !Number(f?.mtimeMs || 0)));
            const hasDiffFiles = Array.isArray(res.files) && res.files.length > 0;
            if (headMoved || unbaselinedNoMtime || hasDiffFiles) {
              needTranscriptRepos.push(res);
            }
          }

          let sessionTranscript = "";
          if (needTranscriptRepos.length > 0 && tabTermAddrs.length > 0) {
            const trSig = "session::" + needTranscriptRepos.map((r) => r.service?.root || "").sort().join("|") + "::" + tabTermAddrs.join(",");
            const nowTs = Date.now();
            if (this.lastTranscriptScan && this.lastTranscriptScan.sig === trSig && (nowTs - this.lastTranscriptScan.ts) < TRANSCRIPT_THROTTLE_MS) {
              sessionTranscript = this.lastTranscriptScan.text;
            } else {
              const reads = await Promise.all(
                tabTermAddrs.map((addr) => hc(["read", "--lines", "150", addr]).catch(() => null))
              );
              if (key() !== context) return;
              sessionTranscript = reads.map(extractHcReadText).filter(Boolean).join("\n").replace(/\\/g, "/");
              this.lastTranscriptScan = { sig: trSig, ts: nowTs, text: sessionTranscript };
            }
          }

          for (const res of serviceResults) {
            if (res.error) {
              res.touched = false;
              continue;
            }
            const normRoot = normPathStr(res.service?.root);
            const cmpRoot = normCmpStr(normRoot, isWindows);
            let baselineRepo = findBaselineRepoEntry(sessionBaseline.repos, normRoot, isWindows);
            const rawUnifiedFiles = Array.isArray(res.files) ? res.files : [];
            const rawWorkingFiles = Array.isArray(res.workingFiles) ? res.workingFiles : [];
            const inPaneCwd = Boolean(normRoot && normPaneCwds.some((c) => isSameOrChildPath(c, normRoot, isWindows)));
            const inWorkspaceRoot = Boolean(cmpRoot && cmpWs && cmpRoot === cmpWs);
            const sameFeatureBranch = isMatchingFeatureBranch(res.branch || res.service?.branch, activeFeatureBranches);
            const inSessionRepos = Boolean(cmpRoot && prevSessionRepos.has(cmpRoot));
            const matchedTranscript = repoMatchesTranscript(res.service, rawUnifiedFiles, sessionTranscript);
            const changedFileMatchedTranscript = changedFilesMatchTranscript(res.service, rawUnifiedFiles, sessionTranscript, isWindows);

            let sessionFiles = [];
            let visibleWorkingFiles = [];
            let hiddenCount = 0;

            if (baselineRepo) {
              // Backfill missing startHead/startBranch for pre-upgrade disk baselines.
              if (res.headHash && !baselineRepo.startHead) {
                baselineRepo.startHead = res.headHash;
                baselineDirtyChanged = true;
              }
              if (res.branch && !baselineRepo.startBranch) {
                baselineRepo.startBranch = res.branch;
                baselineDirtyChanged = true;
              }
              const unifiedPart = partitionSessionUnifiedEntries(rawUnifiedFiles, baselineRepo, res.committedPaths, startedAt);
              sessionFiles = unifiedPart.visible;
              hiddenCount = unifiedPart.hidden.length;
              const workingPart = partitionSessionUnifiedEntries(rawWorkingFiles, baselineRepo, null, startedAt);
              visibleWorkingFiles = workingPart.visible;
            } else {
              const isAttributed = Boolean(
                inPaneCwd ||
                inWorkspaceRoot ||
                sameFeatureBranch ||
                inSessionRepos ||
                matchedTranscript ||
                changedFileMatchedTranscript
              );
              const unbaselinedRes = filterUnbaselinedRepoEntries(rawWorkingFiles, startedAt, { isAttributed });
              visibleWorkingFiles = unbaselinedRes.sessionFiles;
              const newBaselineRepo = {
                dirtyFiles: unbaselinedRes.backfillDirtyFiles,
                ...(res.headHash ? { startHead: res.headHash } : {}),
                ...(res.branch ? { startBranch: res.branch } : {}),
              };
              if (normRoot) {
                sessionBaseline.repos[normRoot] = newBaselineRepo;
                baselineDirtyChanged = true;
              }
              baselineRepo = newBaselineRepo;
              const unifiedPart = partitionSessionUnifiedEntries(rawUnifiedFiles, baselineRepo, res.committedPaths, startedAt);
              sessionFiles = unifiedPart.visible;
              hiddenCount = unifiedPart.hidden.length;
            }

            const hasNewWorkingEdit = visibleWorkingFiles.length > 0;
            const hasActivity = evaluateRepoSessionActivity({
              hasNewWorkingEdit,
              inPaneCwd,
              inWorkspaceRoot,
              sameFeatureBranch,
              inSessionRepos,
              startHead: baselineRepo?.startHead || "",
              headHash: res.headHash || "",
              repoMatchesTranscript: matchedTranscript,
              changedFileMatchesTranscript: changedFileMatchedTranscript,
            });

            if (hasActivity || !res.service?.isSibling) {
              totalHiddenPreExisting += hiddenCount;
            }

            const displayFiles = this.showAllWorkingChanges ? rawUnifiedFiles : sessionFiles;
            const displayDirtyFiles = this.showAllWorkingChanges ? rawWorkingFiles : visibleWorkingFiles;
            const dirtyPaths = displayDirtyFiles.map((w) => w.path).filter(Boolean);
            const stagePaths = selectPathsToStageForCommit(displayDirtyFiles);

            res.allUnifiedFiles = rawUnifiedFiles;
            res.files = displayFiles;
            if (res.service) {
              res.service.dirtyPaths = dirtyPaths;
              res.service.stagePaths = stagePaths;
              res.service.workingCount = dirtyPaths.length;
              res.service.unifiedCount = displayFiles.length;
            }
            const showForPreExistingRecovery = Boolean(this.showAllWorkingChanges && !res.service?.isSibling && hiddenCount > 0);
            res.touched = Boolean((hasActivity || showForPreExistingRecovery) && displayFiles.length > 0);
          }

          this.hiddenPreExistingCount = totalHiddenPreExisting;
          touchedResults = serviceResults
            .filter((r) => r.touched)
            .sort((a, b) => String(a.service?.name || "").localeCompare(String(b.service?.name || "")));

          const sessionRepos = touchedResults.map((r) => normPathStr(r.service?.root)).filter(Boolean);
          const appHomeDir = getSafeAppHome();
          let diskMtime = 0;
          if (baselineDirtyChanged) {
            const curFlowRev = Number(curFlowNow?.baselineRev) || 0;
            sessionBaseline.rev = Math.max(Number(sessionBaseline.rev) || 0, curFlowRev) + 1;
          }
          if (appHomeDir && baselineDirtyChanged) {
            await writeDiskSessionBaseline(
              appHomeDir,
              sessionTabId,
              workspaceRoot,
              baselineInit.primaryBranch,
              sessionBaseline,
              baselineInit.resumeKey || "",
              fsPromises
            );
            if (key() !== context) return;
            diskMtime = await getDiskBaselineMtimeMs(appHomeDir, sessionTabId);
            if (key() !== context) return;
          }
          mergeSessionBaselineIntoFlow(sessionTabId, sessionBaseline, sessionRepos, false, diskMtime);
        } else {
          // No terminal session tab resolved yet: still surface non-sibling workspace repository diffs
          // plus any sibling repository checked out on the exact same non-base feature branch.
          this.hiddenPreExistingCount = 0;
          for (const res of serviceResults) {
            const sameFeatureBranch = isMatchingFeatureBranch(res.branch || res.service?.branch, activeFeatureBranches);
            if (res.error || (res.service?.isSibling && !sameFeatureBranch)) {
              res.touched = false;
              continue;
            }
            const rawUnifiedFiles = Array.isArray(res.files) ? res.files : [];
            const rawWorkingFiles = Array.isArray(res.workingFiles) ? res.workingFiles : [];
            const dirtyPaths = rawWorkingFiles.map((w) => w.path).filter(Boolean);
            const stagePaths = selectPathsToStageForCommit(rawWorkingFiles);
            res.allUnifiedFiles = rawUnifiedFiles;
            res.files = rawUnifiedFiles;
            if (res.service) {
              res.service.dirtyPaths = dirtyPaths;
              res.service.stagePaths = stagePaths;
              res.service.workingCount = dirtyPaths.length;
              res.service.unifiedCount = rawUnifiedFiles.length;
            }
            res.touched = rawUnifiedFiles.length > 0;
          }
          touchedResults = serviceResults
            .filter((r) => r.touched)
            .sort((a, b) => String(a.service?.name || "").localeCompare(String(b.service?.name || "")));
        }
        const services = touchedResults.map((r) => r.service);

        this.workspaceRoot = workspaceRoot;
        this.services = services;
        this.root = services[0]?.root || workspaceRoot;

        // Only publish cognivisor.services when sessionTabId is resolved (never wipe bus on null tab).
        if (sessionTabId) {
          const existingBus = safeShared("cognivisor.services", null);
          const sameBusWorkspace = Boolean(existingBus && normCmpStr(existingBus.workspaceRoot, isWindows) === cmpWs);
          const nextCandidates = (sameBusWorkspace && Array.isArray(existingBus.candidates))
            ? existingBus.candidates
            : candidateServices.map((s) => ({
                id: s.id,
                name: s.name,
                relPath: s.relPath || "",
                root: s.root,
                isSibling: Boolean(s.isSibling),
                branch: s.branch || "",
              }));
          const servicesSig = sessionTabId + "::" + normWs + "::" + nextCandidates.length + "::" + services.map((s) => `${normPathStr(s.root)}@${s.branch || ""}:${s.workingCount || 0}:${s.aheadCount || 0}`).join(",");
          const existingBusSig = existingBus && sameBusWorkspace && (existingBus.tabId || null) === sessionTabId
            ? (existingBus.sig || (sessionTabId + "::" + normWs + "::" + (existingBus.candidates?.length ?? -1) + "::" + (existingBus.services || []).map((s) => `${normPathStr(s.root)}@${s.branch || ""}:${s.workingCount || 0}:${s.aheadCount || 0}`).join(",")))
            : null;
          if ((!usingBusCandidates || force || servicesSig !== existingBusSig) && servicesSig !== this.lastPublishedServicesSig) {
            this.lastPublishedServicesSig = servicesSig;
            const pubTs = Date.now();
            this.lastConsumedBusTs = pubTs;
            this.lastConsumedBusSig = servicesSig;
            setShared("cognivisor.services", {
              tabId: sessionTabId,
              workspaceRoot,
              on,
              services: services.map((s) => ({
                id: s.id,
                name: s.name,
                relPath: s.relPath,
                root: s.root,
                isSibling: Boolean(s.isSibling),
                branch: s.branch || "",
                baseRef: s.baseRef || "",
                workingCount: s.workingCount || 0,
                aheadCount: s.aheadCount || 0,
              })),
              candidates: nextCandidates,
              sig: servicesSig,
              ts: pubTs,
            });
          } else {
            this.lastPublishedServicesSig = servicesSig;
            if (existingBusSig) this.lastConsumedBusSig = existingBusSig;
          }
        }

        const allVisibleFiles = [];
        const allUnifiedFiles = [];
        for (const res of touchedResults) {
          allVisibleFiles.push(...res.files);
          allUnifiedFiles.push(...(res.allUnifiedFiles || res.files));
        }
        const allReconcileFiles = [];
        for (const res of serviceResults) {
          if (res.error) continue;
          allReconcileFiles.push(...(res.allUnifiedFiles || res.files || []));
        }

        this.files = allVisibleFiles;
        this.allSessionFiles = allUnifiedFiles;

        const latestReviewedFiles = sessionTabId
          ? (readFlows()?.[sessionTabId]?.reviewedFiles || {})
          : this.buildLocalReviewedSnapshot();
        const reconciled = reconcileReviewedFiles(latestReviewedFiles, {
          sessionFiles: allReconcileFiles,
          erroredServiceIds,
        });

        if (sessionTabId) {
          if (reconciled.changed) {
            updateTabFlow(
              sessionTabId,
              () => ({ reviewedFiles: reconciled.nextMap }),
              workspaceRoot,
            );
          }
          this.syncLocalReviewedFromMap(reconciled.nextMap);
        } else if (reconciled.changed) {
          this.syncLocalReviewedFromMap(reconciled.nextMap);
        }

        // Watch all discovered candidate repos even when session starts clean so edits appear immediately.
        this.watch(candidateServices.length > 0 ? candidateServices : [{ root: workspaceRoot }], cx);

        this.limited = this.files.length > 1000;
        const allReposErrored = Boolean(firstSnapshotError && serviceResults.length > 0 && erroredServiceIds.size === serviceResults.length);
        this.error = allReposErrored
          ? `Failed to inspect git changes: ${firstSnapshotError.error?.message || firstSnapshotError.error}`
          : null;
        const primarySnap = serviceResults.find((r) => normCmpStr(r.service?.root, isWindows) === cmpWs) || null;
        const refreshSummarySig = `${candidateServices.length}|${touchedResults.length}|${this.files.length}|${this.hiddenPreExistingCount}|${erroredServiceIds.size}|${Boolean(sessionTabId)}|${primarySnap?.baseRef || ""}|${primarySnap?.baseSource || ""}`;
        if (refreshSummarySig !== this.lastRefreshSummarySig) {
          this.lastRefreshSummarySig = refreshSummarySig;
          this.logger?.info("review.refreshSummary", {
            candidatesCount: candidateServices.length,
            touchedCount: touchedResults.length,
            filesCount: this.files.length,
            hiddenPreExistingCount: this.hiddenPreExistingCount,
            erroredCount: erroredServiceIds.size,
            hasSessionTab: Boolean(sessionTabId),
            paneCwdCount: tabPaneCwds.length,
            primaryBranch: primarySnap?.branch || "",
            primaryBaseRef: primarySnap?.baseRef || "",
            primaryBaseSource: primarySnap?.baseSource || "",
            showAllWorkingChanges: Boolean(this.showAllWorkingChanges),
          }, cx);
        }
        const spaceId = activeSpace?.id || "default";
        const revTab = findReviewTabInSpace(spaceId);
        const curDiff = revTab ? readActiveDiff(spaceId) : null;
        if (revTab && curDiff && curDiff.sourceTabId === sessionTabId && curDiff.openFileKey && this.files.some((f) => f.key === curDiff.openFileKey)) {
          this.open = curDiff.openFileKey;
        }
        const prevOpen = this.open;
        if (this.open && !this.files.some((f) => f.key === this.open)) {
          this.open = null;
        }
        if (!this.open && !this.closed && this.files.length) {
          const preferred = this.pickPreferredFileForCurrentList(false);
          this.open = preferred ? preferred.key : null;
        }
        if (revTab) {
          if (!curDiff || curDiff.sourceTabId === sessionTabId) {
            const openFile = this.open ? (this.files.find((f) => f.key === this.open) || null) : null;
            const fileChanged = prevOpen !== this.open || (curDiff && curDiff.openFileKey !== this.open);
            const openFpChanged = Boolean(
              openFile &&
              curDiff?.openFile &&
              computeFileReviewFingerprint(curDiff.openFile) !== computeFileReviewFingerprint(openFile)
            );
            const payload = this.buildActiveDiffPayload(openFile, {
              bumpSeq: Boolean(fileChanged || openFpChanged || force),
              focusLine: fileChanged ? null : (curDiff?.focusLine ?? null),
              focusSide: fileChanged ? null : (curDiff?.focusSide ?? null),
              openCommentLine: fileChanged ? null : (curDiff?.openCommentLine ?? null),
              openCommentSide: fileChanged ? null : (curDiff?.openCommentSide ?? null),
            });
            writeActiveDiff(spaceId, payload);
            if (fileChanged) {
              run("tab.rename", { id: revTab.tabId, name: formatReviewTabTitle(openFile) });
            }
          }
        }
      } catch (e) {
        this.logger?.error("review.refreshFailed", e, {
          workspaceRoot,
          showAllWorkingChanges: this.showAllWorkingChanges,
        }, cx);
        if (key() === context) this.error = String(e.message || e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.pendingRefresh && !this._viewerClosed && key() === context) {
          const nextForce = Boolean(this.pendingRefreshForce);
          this.pendingRefresh = false;
          this.pendingRefreshForce = false;
          cx.timer.after(0, (nextCx) => {
            if (!this._viewerClosed && key() === context) {
              this.refresh(nextCx, nextForce ? { force: true } : { fromWatch: true });
            }
          });
        }
      }
    });
  }

  async fetchFileDiffLines(file, on) {
    if (!file || !file.repoRoot) return ["No file selected"];
    const root = file.repoRoot;
    const path = file.path;
    let lines;

    if (file.fresh) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        const lineTotal = countLines(text);
        lines = [`@@ -0,0 +1,${lineTotal} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 450).map((l) => `+${l}`)];
      }
    } else if (!file.hasHead) {
      const diffArgs = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
      const r = await exec("git", [...READ, ...diffArgs], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr || "git diff --cached failed");
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    } else {
      const baseTarget = file.baseHash || "HEAD";
      const diffArgs = ["diff", baseTarget, "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
      const r = await exec("git", [...READ, ...diffArgs], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr || "git diff failed");
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }

    const maxLines = 500;
    let finalLines = lines || [];
    if (finalLines.length > maxLines) {
      const remaining = finalLines.length - maxLines;
      finalLines = finalLines.slice(0, maxLines);
      finalLines.push(`@@ -0,0 +0,0 @@ [Diff preview truncated: showing first ${maxLines} lines. ${remaining} more lines hidden.]`);
    }
    return finalLines.map((line) => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  async fetchViewerSourceLines(file, on) {
    if (!file || !file.repoRoot || !file.path || file.binary || file.status === "D") return null;
    const text = await readTextFile(`${file.repoRoot}/${file.path}`, { on }).catch(() => null);
    return splitSourceFileLines(text);
  }

  computeViewerLoadedKey(diff) {
    if (!diff?.openFileKey) return "empty";
    return `${diff.requestSeq || 0}::${diff.openFileKey}::${diff.openFile?.baseHash || ""}`;
  }

  scheduleViewerLoad(diff, cx) {
    const targetKey = this.computeViewerLoadedKey(diff);
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

  getMarkdownReloadNonce(fileId) {
    if (!fileId || !this.viewerMarkdownReloadNonces) return 0;
    return this.viewerMarkdownReloadNonces.get(fileId) || 0;
  }

  invalidateViewerMarkdownCacheForFile(fileId) {
    if (!fileId) return;
    const prevKey = this.viewerMarkdownLastKeyByFileId?.get(fileId);
    if (prevKey) {
      this.viewerMarkdownRawCache?.delete(prevKey);
      this.viewerMarkdownLastKeyByFileId?.delete(fileId);
    }
    if (this.viewerMarkdownReloadNonces) {
      const nextNonce = (this.viewerMarkdownReloadNonces.get(fileId) || 0) + 1;
      if (!this.viewerMarkdownReloadNonces.has(fileId) && this.viewerMarkdownReloadNonces.size >= 32) {
        const oldest = this.viewerMarkdownReloadNonces.keys().next().value;
        if (oldest !== undefined) this.viewerMarkdownReloadNonces.delete(oldest);
      }
      this.viewerMarkdownReloadNonces.set(fileId, nextNonce);
    }
  }

  getMarkdownRawCacheEntry(key) {
    if (!key || !this.viewerMarkdownRawCache?.has(key)) return null;
    const hit = this.viewerMarkdownRawCache.get(key);
    this.viewerMarkdownRawCache.delete(key);
    this.viewerMarkdownRawCache.set(key, hit);
    return hit;
  }

  setMarkdownRawCacheEntry(key, value) {
    if (!key || !this.viewerMarkdownRawCache) return;
    if (this.viewerMarkdownRawCache.has(key)) {
      this.viewerMarkdownRawCache.delete(key);
    } else if (this.viewerMarkdownRawCache.size >= 16) {
      const oldest = this.viewerMarkdownRawCache.keys().next().value;
      if (oldest !== undefined) this.viewerMarkdownRawCache.delete(oldest);
    }
    this.viewerMarkdownRawCache.set(key, value);
  }

  resetViewerMarkdownState(clearCaches = false) {
    this.viewerMarkdownRendered = false;
    this.viewerMarkdownFileId = "";
    this.viewerMarkdownLoadedKey = "";
    this.viewerMarkdownLoadedToken = "";
    this.viewerMarkdownLoading = false;
    this.viewerMarkdownError = "";
    this.viewerMarkdownNotice = "";
    this.viewerMarkdownPrepared = null;
    this.viewerMarkdownLoadGen = (this.viewerMarkdownLoadGen || 0) + 1;
    if (clearCaches) {
      this.viewerMarkdownRawCache?.clear?.();
      this.viewerMarkdownRenderCache?.clear?.();
      this.viewerMarkdownReloadNonces?.clear?.();
      this.viewerMarkdownLastKeyByFileId?.clear?.();
    }
  }

  toggleViewerMarkdown(diff, cx) {
    if (this._viewerClosed) return;
    const ctx = this.getSessionContext();
    const activeDiff = diff || readActiveDiff(ctx.spaceId);
    const files = activeDiff?.files || [];
    const openFile = activeDiff?.openFile || files.find((f) => f.key === activeDiff?.openFileKey) || null;
    const openFilePath = openFile?.path || openFile?.displayPath || "";
    if (!openFile || !isMarkdownFile(openFilePath)) return;

    const fileId = computeViewerMarkdownFileId(openFile);
    const isCurrentlyActive = Boolean(this.viewerMarkdownRendered && this.viewerMarkdownFileId === fileId);

    if (isCurrentlyActive) {
      this.viewerMarkdownRendered = false;
      this.viewerMarkdownLoading = false;
      this.viewerMarkdownLoadGen = (this.viewerMarkdownLoadGen || 0) + 1;
      cx?.notify();
      return;
    }

    this.viewerMarkdownRendered = true;
    this.viewerMarkdownFileId = fileId;
    this.diffScrollbarDrag = null;
    if (this.activeComment) {
      this.cancelFocusCommentTask();
      this.activeComment = null;
      this.commentText = "";
      this.typingComment = false;
      try { this.commentInput?.set_value?.(""); } catch {}
    }
    this.loadViewerMarkdownNow(activeDiff, cx);
  }

  isMarkdownLoadStillCurrent(spaceId, fileId, gen) {
    if (this._viewerClosed || gen !== this.viewerMarkdownLoadGen) return false;
    if (!this.viewerMarkdownRendered || this.viewerMarkdownFileId !== fileId) return false;
    const curDiff = readActiveDiff(spaceId);
    const curOpen = curDiff?.openFile || (curDiff?.files || []).find((f) => f.key === curDiff?.openFileKey) || null;
    return computeViewerMarkdownFileId(curOpen) === fileId;
  }

  loadViewerMarkdownNow(diff, cx, opts = {}) {
    if (this._viewerClosed) return;
    const ctx = this.getSessionContext();
    const latestDiff = diff || readActiveDiff(ctx.spaceId);
    const files = latestDiff?.files || [];
    const openFile = latestDiff?.openFile || files.find((f) => f.key === latestDiff?.openFileKey) || null;
    const filePath = openFile?.path || openFile?.displayPath || "";

    if (!openFile || !isMarkdownFile(filePath)) {
      this.resetViewerMarkdownState(false);
      cx?.notify();
      return;
    }

    const fileId = computeViewerMarkdownFileId(openFile);
    if (!this.viewerMarkdownRendered || this.viewerMarkdownFileId !== fileId) {
      return;
    }

    if (opts.forceReload) {
      this.invalidateViewerMarkdownCacheForFile(fileId);
    }

    const reloadNonce = this.getMarkdownReloadNonce(fileId);
    const loadToken = computeReviewMarkdownLoadToken(openFile, {
      requestSeq: latestDiff?.requestSeq || 0,
      reloadNonce,
    });
    const cacheKey = buildReviewMarkdownCacheKey(openFile, {
      loadToken,
    });

    if (this.viewerMarkdownLastKeyByFileId) {
      if (!this.viewerMarkdownLastKeyByFileId.has(fileId) && this.viewerMarkdownLastKeyByFileId.size >= 32) {
        const oldest = this.viewerMarkdownLastKeyByFileId.keys().next().value;
        if (oldest !== undefined) this.viewerMarkdownLastKeyByFileId.delete(oldest);
      }
      this.viewerMarkdownLastKeyByFileId.set(fileId, cacheKey);
    }

    const cached = !opts.bypassCache ? this.getMarkdownRawCacheEntry(cacheKey) : null;
    if (cached) {
      this.viewerMarkdownLoadGen = (this.viewerMarkdownLoadGen || 0) + 1;
      this.viewerMarkdownLoading = false;
      this.viewerMarkdownLoadedKey = cacheKey;
      this.viewerMarkdownLoadedToken = loadToken;
      this.viewerMarkdownNotice = cached.notice || "";
      this.viewerMarkdownError = "";
      this.viewerMarkdownPrepared = this.viewerMarkdownRenderCache.getOrPrepare(cacheKey, cached.text, { filePath });
      cx?.notify();
      return;
    }

    const spec = resolveReviewMarkdownSourceSpec(openFile, {
      on: latestDiff?.on ?? null,
    });

    if (spec.kind === "unavailable") {
      this.viewerMarkdownLoadGen = (this.viewerMarkdownLoadGen || 0) + 1;
      this.viewerMarkdownLoading = false;
      this.viewerMarkdownLoadedKey = cacheKey;
      this.viewerMarkdownLoadedToken = loadToken;
      this.viewerMarkdownNotice = spec.notice || "";
      this.viewerMarkdownError = spec.error || spec.unavailableMessage || "Markdown preview is unavailable.";
      this.viewerMarkdownPrepared = null;
      cx?.notify();
      return;
    }

    const gen = (this.viewerMarkdownLoadGen || 0) + 1;
    this.viewerMarkdownLoadGen = gen;
    this.viewerMarkdownLoading = true;
    this.viewerMarkdownError = "";
    this.viewerMarkdownNotice = spec.notice || "";
    this.viewerMarkdownPrepared = null;
    this.viewerMarkdownLoadedKey = cacheKey;
    this.viewerMarkdownLoadedToken = loadToken;
    cx?.notify();

    const runLoad = async (asyncCx) => {
      try {
        let rawText = null;
        if (spec.kind === "file") {
          rawText = await readTextFile(spec.absPath, { on: spec.on }).catch(() => null);
          if (!this.isMarkdownLoadStillCurrent(ctx.spaceId, fileId, gen)) return;
        } else if (spec.kind === "git") {
          const res = await exec("git", spec.args, { cwd: spec.cwd, on: spec.on }).catch((e) => ({
            code: -1,
            stdout: "",
            stderr: String(e?.message || e || ""),
          }));
          if (!this.isMarkdownLoadStillCurrent(ctx.spaceId, fileId, gen)) return;
          if (!res || res.code !== 0) {
            this.viewerMarkdownError = formatGitShowMarkdownError(res?.stderr, spec);
            this.viewerMarkdownPrepared = null;
            return;
          }
          rawText = typeof res.stdout === "string" ? res.stdout : String(res.stdout ?? "");
        }

        const checked = validateMarkdownTextContent(rawText, spec.unavailableMessage);
        if (!checked.ok) {
          this.viewerMarkdownError = checked.error;
          this.viewerMarkdownPrepared = null;
          return;
        }

        this.setMarkdownRawCacheEntry(cacheKey, { text: checked.text, notice: spec.notice || "" });
        this.viewerMarkdownPrepared = this.viewerMarkdownRenderCache.getOrPrepare(cacheKey, checked.text, { filePath });
        this.viewerMarkdownError = "";
        this.viewerMarkdownNotice = spec.notice || "";
      } catch (e) {
        if (!this.isMarkdownLoadStillCurrent(ctx.spaceId, fileId, gen)) return;
        this.viewerMarkdownError = String(e?.message || e || spec.unavailableMessage || "Cannot preview Markdown file.");
        this.viewerMarkdownPrepared = null;
      } finally {
        if (!this._viewerClosed && gen === this.viewerMarkdownLoadGen) {
          this.viewerMarkdownLoading = false;
          try { asyncCx?.notify(); } catch {}
        }
      }
    };

    if (cx?.spawn) {
      cx.spawn(runLoad);
    } else {
      runLoad(cx);
    }
  }

  loadViewerDiffNow(diff, cx, opts = {}) {
    if (this._viewerClosed) return;
    if (this.viewerLoadTask) {
      try { this.viewerLoadTask.cancel(); } catch {}
      this.viewerLoadTask = null;
    }
    this.viewerScheduledKey = "";

    const gen = (this.viewerLoadGen || 0) + 1;
    this.viewerLoadGen = gen;

    const prevOpenKey = this.open;
    const loadKey = this.computeViewerLoadedKey(diff);
    this.viewerLoadedKey = loadKey;

    const openFile = diff?.openFile || (diff?.files || []).find((f) => f.key === diff?.openFileKey) || null;
    this.open = openFile ? openFile.key : null;
    this.viewerNote = null;

    const openFilePath = openFile?.path || openFile?.displayPath || "";
    const isMdFile = Boolean(openFile && isMarkdownFile(openFilePath));
    const nextFileId = isMdFile ? computeViewerMarkdownFileId(openFile) : "";
    const seq = diff?.requestSeq || 0;
    const isCommentJump = Boolean(diff?.openCommentLine != null && seq && seq !== this.lastHandledSeq);

    if (!openFile || !isMdFile || opts.resetMarkdown || nextFileId !== this.viewerMarkdownFileId || isCommentJump) {
      this.resetViewerMarkdownState(false);
    }
    if (opts.forceReload && nextFileId) {
      this.invalidateViewerMarkdownCacheForFile(nextFileId);
    }

    if (prevOpenKey && prevOpenKey !== this.open && this.activeComment && this.activeComment.fileKey !== this.open) {
      this.cancelFocusCommentTask();
      this.activeComment = null;
      this.commentText = "";
      this.commentInput.set_value("");
    }
    if (prevOpenKey !== this.open) {
      this.diffScrollbarDrag = null;
    }
    this.viewerSourceLines = null;
    this.viewerSourceKey = "";
    this.viewerExpandingGapId = null;

    if (!openFile) {
      this.setLines([]);
      this.diffScrollPx = 0;
      this.viewerLoading = false;
      cx?.notify();
      return;
    }

    if (isMdFile && this.viewerMarkdownRendered && this.viewerMarkdownFileId === nextFileId) {
      this.loadViewerMarkdownNow(diff, cx, { bypassCache: Boolean(opts.forceReload) });
    }

    this.viewerLoading = true;
    cx?.notify();

    const runLoad = async (asyncCx) => {
      try {
        const lines = await this.fetchFileDiffLines(openFile, diff?.on ?? null);
        if (this._viewerClosed || gen !== this.viewerLoadGen) return;
        const canExpandBottom = Boolean(
          !openFile.fresh &&
          !openFile.binary &&
          openFile.status !== "D" &&
          !(!openFile.hasHead && openFile.status === "A")
        );
        this.setLines(lines, openFile.path, { canExpandBottom });

        const shouldConsumeDirectives = Boolean(seq && seq !== this.lastHandledSeq) || Boolean(opts.forceScrollTop);
        if (seq && seq !== this.lastHandledSeq) {
          this.lastHandledSeq = seq;
        }

        const findRowForTarget = (targetLine, targetSide) => {
          if (targetSide) {
            const normSide = normalizeCommentSide(targetSide);
            const exact = this.rows.findIndex(
              (r) => r.number === targetLine && (r.kind === "-" ? "old" : "new") === normSide,
            );
            if (exact >= 0) return exact;
          }
          return this.rows.findIndex((r) => r.number === targetLine);
        };

        if (shouldConsumeDirectives && diff?.focusLine != null) {
          const rowIdx = findRowForTarget(diff.focusLine, diff.focusSide);
          if (rowIdx >= 0) {
            const ctxNow = this.getSessionContext();
            const cMap = this.buildCommentMapForFile(openFile.key, ctxNow);
            const layout = this.computeDiffRowLayout(cMap, this.getReviewWrapCols(), openFile.key);
            this.diffScrollPx = computeDiffScrollOffsetForRow(layout, rowIdx, this.getDiffViewportHeight(), "center");
          }
        } else if (prevOpenKey !== openFile.key || opts.forceScrollTop) {
          this.diffScrollPx = 0;
        }

        if (diff?.openCommentLine != null && diff?.openCommentLine !== undefined && shouldConsumeDirectives) {
          const commentSide = normalizeCommentSide(diff.openCommentSide);
          const rowIdx = findRowForTarget(diff.openCommentLine, commentSide);
          const row = rowIdx >= 0 ? this.rows[rowIdx] : null;
          const ctxNow = this.getSessionContext();
          const cur = this.getComment(openFile.key, diff.openCommentLine, commentSide, ctxNow);
          this.openCommentEditor(
            openFile,
            diff.openCommentLine,
            commentSide,
            cur?.snippet || row?.text || "",
            cur ? cur.text : "",
            asyncCx,
          );
        }
      } catch (e) {
        if (this._viewerClosed || gen !== this.viewerLoadGen) return;
        this.setLines([]);
        this.viewerNote = `Cannot preview this diff (too large or unreadable): ${e.message || e}`;
      } finally {
        if (!this._viewerClosed && gen === this.viewerLoadGen) {
          this.viewerLoading = false;
          try { asyncCx?.notify(); } catch {}
        }
      }
    };

    if (cx?.spawn) {
      cx.spawn(runLoad);
    } else {
      runLoad(cx);
    }
  }

  openViewerFile(nextFile, diff, ctx, cx, overrides = {}) {
    const payload = this.buildActiveDiffPayload(nextFile, {
      ...overrides,
      files: overrides.files ?? diff?.files ?? [],
      services: overrides.services ?? diff?.services ?? [],
      on: overrides.on !== undefined ? overrides.on : (diff?.on ?? null),
      bumpSeq: true,
      focusLine: null,
      focusSide: null,
      openCommentLine: null,
      openCommentSide: null,
    });
    writeActiveDiff(ctx.spaceId, payload);
    const revTab = findReviewTabInSpace(ctx.spaceId);
    if (revTab) {
      run("tab.rename", { id: revTab.tabId, name: formatReviewTabTitle(nextFile) });
    }
    this.loadViewerDiffNow(payload, cx, { forceScrollTop: true, resetMarkdown: true });
    return payload;
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
      this.openViewerFile(nextFile, diff, ctx, cx);
    }
  }

  toggleViewerFileReviewed(cx) {
    const ctx = this.getSessionContext();
    const diff = readActiveDiff(ctx.spaceId);
    const files = diff?.files || [];
    const curFile = diff?.openFile || files.find((f) => f.key === diff?.openFileKey) || null;
    if (!curFile) return;

    const rk = this.fileReviewKey(curFile);
    if (!rk) return;

    const { nextReviewed, updatedFlow } = this.applyFileReviewToggle(curFile, curFile.key, ctx);

    if (nextReviewed) {
      const nextFile = pickNextUnreviewedFile(
        files,
        curFile.key,
        (cand) => this.isFileReviewed(cand, updatedFlow),
      );
      if (nextFile) {
        this.openViewerFile(nextFile, diff, ctx, cx);
        return;
      }
    }

    cx.notify();
  }

  setLines(lines, filePath = "", gapOpts = null) {
    const baseRows = diffRows(lines, filePath);
    this.rows = gapOpts ? annotateDiffGaps(baseRows, gapOpts) : baseRows;
    this.viewerSourceFilePath = filePath || "";
    this.diffWidth = computeDiffContentWidth(this.rows);
  }

  pick(fileKey, cx) {
    const file = this.resolveFileDescriptor(fileKey);
    if (!file) return;
    this.open = file.key;
    this.closed = false;
    this.panelNote = null;
    this.openReviewTabForFile(file, {
      create: true,
      select: true,
      bumpSeq: true,
      focusLine: null,
      focusSide: null,
      openCommentLine: null,
      openCommentSide: null,
    });
    cx.notify();
  }

  applyGapExpansionWithSource(gapId, direction, sourceLines, activeKey, cx) {
    const syncedRows = syncBottomGapWithTotalLines(this.rows, sourceLines.length);
    const liveIdx = syncedRows.findIndex((r) => r?.kind === "@" && r?.gap?.id === gapId);
    if (liveIdx < 0) {
      if (syncedRows !== this.rows) {
        this.rows = syncedRows;
        this.diffWidth = computeDiffContentWidth(this.rows);
        cx?.notify();
      }
      return;
    }

    const ctx = this.getSessionContext();
    const openKey = activeKey || this.open;
    const commentMap = this.buildCommentMapForFile(openKey, ctx);
    const wrapCols = this.getReviewWrapCols();
    const vpH = this.getDiffViewportHeight();

    // Measure old layout before splicing (keep pre-sync row positions aligned with current screen).
    const oldLayout = this.computeDiffRowLayout(commentMap, wrapCols, openKey);
    const oldGapIdx = this.rows.findIndex((r) => r?.kind === "@" && r?.gap?.id === gapId);
    const oldGapOffset = oldGapIdx >= 0 ? (oldLayout.offsets[oldGapIdx] ?? 0) : 0;
    const gapScreenY = oldGapOffset - (this.diffScrollPx || 0);
    const anchorPreference = gapScreenY >= vpH * 0.5 ? "above" : "below";

    const result = expandDiffGapInRows(syncedRows, liveIdx, direction, sourceLines, {
      step: DEFAULT_CONTEXT_EXPAND_STEP,
      filePath: this.viewerSourceFilePath || "",
      anchorPreference,
    });
    if (!result.changed) return;

    const oldScrollPx = this.diffScrollPx || 0;
    this.rows = result.rows;
    this.diffWidth = computeDiffContentWidth(this.rows);
    const newLayout = this.computeDiffRowLayout(commentMap, wrapCols, openKey);
    this.diffScrollPx = computeAnchorPreservedScrollPx(
      oldLayout,
      newLayout,
      oldScrollPx,
      result.oldAnchorIndex,
      result.newAnchorIndex,
      vpH,
    );
    cx?.notify();
  }

  expandDiffGap(rowIndex, direction, fallbackOpenKey, cx) {
    if (this.viewerLoading || this.viewerExpandingGapId) return;
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= this.rows.length) return;
    const rowObj = this.rows[rowIndex];
    const gap = rowObj?.gap;
    if (!gap || !gap.id) return;

    const ctx = this.getSessionContext();
    const diff = readActiveDiff(ctx.spaceId);
    const activeKey = diff?.openFileKey || fallbackOpenKey || this.open;
    const openFile = diff?.openFile || (diff?.files || []).find((f) => f.key === activeKey) || null;
    if (!openFile) return;

    this.logger?.action("review.expandGap", {
      gapId: gap.id,
      position: gap.position,
      direction,
      startLine: gap.startLine,
      endLine: gap.endLine,
      openKey: activeKey || "",
    }, cx);

    try { this.handle?.focus?.(); } catch {}

    const loadedKey = this.viewerLoadedKey;
    if (this.viewerSourceKey === loadedKey && Array.isArray(this.viewerSourceLines)) {
      this.applyGapExpansionWithSource(gap.id, direction, this.viewerSourceLines, activeKey, cx);
      return;
    }

    const gen = this.viewerLoadGen;
    const gapId = gap.id;
    this.viewerExpandingGapId = gapId;
    cx?.notify();

    cx.spawn(async (asyncCx) => {
      try {
        const sourceLines = await this.fetchViewerSourceLines(openFile, diff?.on ?? null);
        if (this._viewerClosed || gen !== this.viewerLoadGen || loadedKey !== this.viewerLoadedKey) return;
        this.viewerExpandingGapId = null;
        if (!Array.isArray(sourceLines)) {
          this.viewerNote = "Cannot expand context for this file (binary or unreadable).";
          asyncCx.notify();
          return;
        }
        this.viewerSourceLines = sourceLines;
        this.viewerSourceKey = loadedKey;
        this.applyGapExpansionWithSource(gapId, direction, sourceLines, activeKey, asyncCx);
      } catch (e) {
        if (this._viewerClosed || gen !== this.viewerLoadGen) return;
        this.viewerExpandingGapId = null;
        this.logger?.error("review.expandGapFailed", e, { gapId, openKey: activeKey || "" }, asyncCx);
        asyncCx.notify();
      }
    });
  }

  getDiffViewportHeight() {
    return this.diffViewportHeight > 0 ? this.diffViewportHeight : 560;
  }

  getReviewWrapCols() {
    return computeWrapColumns({
      viewportWidth: this.diffViewportWidth > 0
        ? this.diffViewportWidth
        : Math.max(240, (this.viewerWidth || 900) - 8),
      gutterWidth: 56,
      rightPadding: 20,
      fontSize: 11.5,
      minCols: 12,
    });
  }

  getWrappedCommentLines(text, wrapCols) {
    const commentCols = computeReviewCommentWrapCols(wrapCols);
    const rawLines = String(text || "").split(/\r?\n/);
    const out = [];
    for (let i = 0; i < rawLines.length; i++) {
      const wrapped = wrapPlainText(rawLines[i], commentCols, { toNbsp: false });
      for (let j = 0; j < wrapped.length; j++) {
        out.push(wrapped[j]);
      }
    }
    return out.length > 0 ? out : [" "];
  }

  computeDiffRowLayout(commentMap, wrapCols, openKey = null) {
    const rows = this.rows;
    const len = rows.length;
    const activeOpenKey = openKey || this.open || "";

    let commentSig = "";
    if (commentMap && commentMap.size > 0) {
      commentMap.forEach((rec, cKey) => {
        commentSig += `${cKey}:${rec?.text?.length || 0};`;
      });
    }
    const cacheSig = `${len}|${wrapCols}|${activeOpenKey}|${commentSig}`;
    if (
      this._rowLayoutCache &&
      this._rowLayoutCache.rows === rows &&
      this._rowLayoutCache.sig === cacheSig
    ) {
      return this._rowLayoutCache.layout;
    }

    const heights = new Array(len);
    for (let i = 0; i < len; i++) {
      const r = rows[i];
      if (!r) {
        heights[i] = REVIEW_ROW_HEIGHT;
        continue;
      }
      if (r.kind === "@") {
        heights[i] = REVIEW_HUNK_ROW_HEIGHT;
        continue;
      }
      const lineCount = countWrappedLines(r.text || " ", wrapCols);
      let h = Math.max(1, lineCount) * REVIEW_ROW_HEIGHT;
      if (r.number !== undefined) {
        const rowSide = r.kind === "-" ? "old" : "new";
        const existing = commentMap ? commentMap.get(buildCommentKey(activeOpenKey, r.number, rowSide)) : null;
        if (existing) {
          const cLines = this.getWrappedCommentLines(existing.text, wrapCols);
          h += 13 + cLines.length * 16;
        }
      }
      heights[i] = h;
    }
    const layout = buildVariableRowLayout(heights);
    this._rowLayoutCache = { rows, sig: cacheSig, layout };
    return layout;
  }

  scheduleDiffResizeReflow(nextW, nextH, cx) {
    const prevCols = this.getReviewWrapCols();
    const prevH = this.diffViewportHeight || 0;
    let shouldNotify = false;

    if (nextW > 0 && Math.abs(nextW - (this.diffViewportWidth || 0)) > 4) {
      this.diffViewportWidth = nextW;
      if (this.getReviewWrapCols() !== prevCols) {
        shouldNotify = true;
      }
    }
    if (nextH > 0 && Math.abs(nextH - prevH) > 4) {
      this.diffViewportHeight = nextH;
      shouldNotify = true;
    }
    if (!shouldNotify) return;

    if (this.diffResizeTask) {
      try { this.diffResizeTask.cancel(); } catch {}
      this.diffResizeTask = null;
    }
    const timer = cx?.timer;
    if (timer) {
      this.diffResizeTask = timer.after(16, (timerCx) => {
        this.diffResizeTask = null;
        if (this._viewerClosed) return;
        try { (timerCx || cx)?.notify(); } catch {}
      });
    } else {
      cx?.notify();
    }
  }

  scrollDiffByPx(deltaPx, layout, cx) {
    if (!deltaPx || !layout) return;
    const vpH = this.getDiffViewportHeight();
    const maxScrollPx = Math.max(0, (layout.totalHeight || 0) - vpH);
    const prev = Math.max(0, Math.min(maxScrollPx, Math.round(this.diffScrollPx || 0)));
    const next = Math.max(0, Math.min(maxScrollPx, prev + Math.round(deltaPx)));
    if (next !== this.diffScrollPx) {
      this.diffScrollPx = next;
      cx?.notify();
    }
  }

  handleDiffRowActivate(rowIndex, fallbackOpenKey, cx) {
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= this.rows.length) return;
    const rowObj = this.rows[rowIndex];
    if (!rowObj) return;
    const activeKey = readActiveDiff(this.getSessionContext().spaceId)?.openFileKey || fallbackOpenKey || this.open;
    const rowSide = rowObj.kind === "-" ? "old" : "new";
    this.logger?.action("review.diffRowClick", {
      rowIndex,
      kind: rowObj.kind || "",
      line: rowObj.number ?? null,
      side: rowSide,
      openKey: activeKey || "",
    }, cx);
    if (rowObj.kind === "@") {
      const gap = rowObj.gap;
      if (!gap) return;
      const hiddenCount = gap.endLine != null ? Math.max(0, gap.endLine - gap.startLine + 1) : null;
      if (gap.position === "top") {
        this.expandDiffGap(rowIndex, hiddenCount != null && hiddenCount <= DEFAULT_CONTEXT_EXPAND_STEP ? "all" : "up", activeKey, cx);
      } else if (gap.position === "bottom") {
        this.expandDiffGap(rowIndex, hiddenCount != null && hiddenCount <= DEFAULT_CONTEXT_EXPAND_STEP ? "all" : "down", activeKey, cx);
      } else if (hiddenCount != null && hiddenCount <= DEFAULT_CONTEXT_EXPAND_STEP) {
        this.expandDiffGap(rowIndex, "all", activeKey, cx);
      }
    } else if (rowObj.number !== undefined) {
      this.startComment(activeKey, rowObj.number, rowSide, rowObj.text, cx, rowIndex);
    }
  }

  diffRow(rowObj, rowIndex, t, dt, commentMap, activeOpenKey = null, wrapCols = 96, expectedHeight = REVIEW_ROW_HEIGHT) {
    const { kind, number, text, tokens, gap } = rowObj;
    const openKey = activeOpenKey || this.open || "none";
    const rowId = `diff-row-${openKey}-${rowIndex}`;
    if (kind === "@") {
      const hunkH = expectedHeight || REVIEW_HUNK_ROW_HEIGHT;
      const hiddenCount = gap && gap.endLine != null ? Math.max(0, gap.endLine - gap.startLine + 1) : null;
      const isLoadingGap = Boolean(gap && this.viewerExpandingGapId === gap.id);
      const step = DEFAULT_CONTEXT_EXPAND_STEP;
      const barClickable = Boolean(
        gap &&
        !isLoadingGap &&
        (gap.position === "top" || gap.position === "bottom" || (hiddenCount != null && hiddenCount <= step))
      );

      const renderGapBtn = (btnId, label, dir, tipText, subtle = false) =>
        div()
          .id(btnId)
          .flex_none()
          .px(6)
          .py(1)
          .rounded(4)
          .border_1()
          .border_color(t.border)
          .bg(subtle ? t.raised : t.background)
          .text_size(9.5)
          .font_medium()
          .text_color(subtle ? t.dim : t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(tipText)
          .on_mouse_down("left", (_e, stopCx) => stopCx.stop_propagation())
          .on_click((_e, clickCx) => {
            clickCx.stop_propagation();
            this.expandDiffGap(rowIndex, dir, openKey, clickCx);
          })
          .child(label);

      const controls = [];
      if (gap) {
        if (isLoadingGap) {
          controls.push(
            div().flex_none().px(6).py(1).rounded(4).bg(t.background).text_size(9.5).text_color(t.dim).child("Loading…")
          );
        } else if (gap.position === "top") {
          if (hiddenCount != null && hiddenCount <= step) {
            controls.push(
              renderGapBtn(
                `gap-up-${gap.id}`,
                `↑ Expand ${hiddenCount} ${hiddenCount === 1 ? "line" : "lines"}`,
                "all",
                `Show all ${hiddenCount} hidden lines above this block`,
              )
            );
          } else {
            controls.push(
              renderGapBtn(
                `gap-up-${gap.id}`,
                `↑ +${step}`,
                "up",
                `Expand ${step} lines upward above this block`,
              )
            );
            if (hiddenCount != null) {
              controls.push(
                renderGapBtn(
                  `gap-all-${gap.id}`,
                  `All (${hiddenCount})`,
                  "all",
                  `Expand all ${hiddenCount} hidden lines above this block`,
                  true,
                )
              );
            }
          }
        } else if (gap.position === "bottom") {
          if (hiddenCount == null) {
            controls.push(
              renderGapBtn(
                `gap-down-${gap.id}`,
                `↓ Expand below`,
                "down",
                `Expand ${step} lines below this block`,
              )
            );
          } else if (hiddenCount <= step) {
            controls.push(
              renderGapBtn(
                `gap-down-${gap.id}`,
                `↓ Expand ${hiddenCount} ${hiddenCount === 1 ? "line" : "lines"}`,
                "all",
                `Show all ${hiddenCount} remaining lines below`,
              )
            );
          } else {
            controls.push(
              renderGapBtn(
                `gap-down-${gap.id}`,
                `↓ +${step}`,
                "down",
                `Expand ${step} lines downward below this block`,
              )
            );
            controls.push(
              renderGapBtn(
                `gap-all-${gap.id}`,
                `All (${hiddenCount})`,
                "all",
                `Expand all ${hiddenCount} remaining lines below`,
                true,
              )
            );
          }
        } else if (gap.position === "between") {
          if (hiddenCount != null && hiddenCount <= step) {
            controls.push(
              renderGapBtn(
                `gap-all-${gap.id}`,
                `↕ Expand ${hiddenCount} ${hiddenCount === 1 ? "line" : "lines"}`,
                "all",
                `Show all ${hiddenCount} hidden lines between blocks`,
              )
            );
          } else {
            controls.push(
              renderGapBtn(
                `gap-down-${gap.id}`,
                `↓ +${step}`,
                "down",
                `Expand ${step} lines downward below the previous block`,
              )
            );
            controls.push(
              renderGapBtn(
                `gap-up-${gap.id}`,
                `↑ +${step}`,
                "up",
                `Expand ${step} lines upward above the next block`,
              )
            );
            if (hiddenCount != null) {
              controls.push(
                renderGapBtn(
                  `gap-all-${gap.id}`,
                  `All (${hiddenCount})`,
                  "all",
                  `Expand all ${hiddenCount} hidden lines in this block`,
                  true,
                )
              );
            }
          }
        }
      }

      const headerLabel = text || (gap?.position === "bottom" && hiddenCount != null ? `${hiddenCount} lines hidden below` : "");
      return h_flex().id(rowId).w_full().h(hunkH).px(12).flex_none().items_center().gap(6)
        .bg(t.raised).border_b(1).border_color(t.border)
        .when(barClickable, (e) => e
          .cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, clickCx) => this.handleDiffRowActivate(rowIndex, openKey, clickCx))
        )
        .when(controls.length > 0, (e) => e.children(controls))
        .when(Boolean(headerLabel), (e) => e.child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .pl(controls.length > 0 ? 4 : 0)
            .text_size(11)
            .text_color(t.dim)
            .when(Boolean(text), (lbl) => lbl.tooltip(text))
            .child(headerLabel)
        ));
    }
    const isCommentable = number !== undefined;
    const rowSide = kind === "-" ? "old" : "new";
    const existing = (isCommentable && commentMap) ? commentMap.get(buildCommentKey(openKey, number, rowSide)) : null;
    const isActive = Boolean(
      this.activeComment &&
      this.activeComment.fileKey === openKey &&
      this.activeComment.line === number &&
      normalizeCommentSide(this.activeComment.side) === rowSide
    );

    const isAdd = kind === "+";
    const isDel = kind === "-";
    const diffColor = isAdd ? dt.add : isDel ? dt.del : null;
    const rowBg = isAdd ? dt.addBg : isDel ? dt.delBg : null;
    const hoverBg = isAdd ? dt.addHover : isDel ? dt.delHover : t.hover;
    const gutterSign = isAdd ? "+" : isDel ? "-" : " ";

    const hasTokens = Array.isArray(tokens) && tokens.length > 0;
    const wCacheKey = `${wrapCols}|${hasTokens ? 1 : 0}`;
    let cachedWrap = reviewWrapCache.get(rowObj);
    if (!cachedWrap || cachedWrap.key !== wCacheKey) {
      const segments = hasTokens
        ? wrapStyledSpans(tokens, wrapCols, { toNbsp: true })
        : wrapPlainText(text || " ", wrapCols, { toNbsp: true });
      cachedWrap = { key: wCacheKey, segments };
      reviewWrapCache.set(rowObj, cachedWrap);
    }
    const segments = cachedWrap.segments;

    const renderSegContent = (seg) => {
      if (!hasTokens) {
        return div().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
          .text_color(diffColor || t.foreground)
          .child(seg || "\u00a0");
      }
      if (!seg || seg.length === 0) {
        return div().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
          .text_color(diffColor || t.foreground)
          .child("\u00a0");
      }
      const spanEls = new Array(seg.length);
      for (let i = 0; i < seg.length; i++) {
        const sp = seg[i];
        spanEls[i] = div()
          .flex_none()
          .whitespace_nowrap()
          .text_color(syntaxTokenColor(sp[0], t))
          .child(sp[1] || "\u00a0");
      }
      return h_flex().flex_1().min_w(0).overflow_hidden().items_center().children(spanEls);
    };

    const buildVisualSubRow = (seg, isFirstSeg, applyOuterFrame) =>
      h_flex().w_full().h(REVIEW_ROW_HEIGHT).flex_none().items_center().gap(6).pr(14)
        .when(applyOuterFrame, (e) => e
          .border_l(2)
          .border_color(diffColor || t.background)
          .when(Boolean(rowBg), (b) => b.bg(rowBg))
          .when(Boolean(existing) || Boolean(isActive), (b) => b.bg(t.selected))
          .hover((s) => s.bg(hoverBg))
        )
        .child(
          div().w(32).flex_none().text_right()
            .text_color(existing || isActive ? t.foreground : diffColor || t.dim)
            .child(!isFirstSeg || number === undefined ? "\u00a0" : String(number))
        )
        .child(
          div().w(10).flex_none().text_center().font_semibold()
            .text_color(diffColor || t.dim)
            .child(isFirstSeg ? gutterSign : "\u00a0")
        )
        .child(renderSegContent(seg));

    const codeHeight = Math.max(1, segments.length) * REVIEW_ROW_HEIGHT;
    const row = segments.length <= 1
      ? buildVisualSubRow(segments[0], true, true)
      : v_flex().w_full().h(codeHeight).flex_none().overflow_hidden()
          .border_l(2)
          .border_color(diffColor || t.background)
          .when(Boolean(rowBg), (b) => b.bg(rowBg))
          .when(Boolean(existing) || Boolean(isActive), (b) => b.bg(t.selected))
          .hover((s) => s.bg(hoverBg))
          .children(segments.map((seg, idx) => buildVisualSubRow(seg, idx === 0, false)));

    if (!existing) {
      return row
        .id(rowId)
        .when(isCommentable, (e) => e
          .cursor_pointer()
          .on_click((_e, clickCx) => this.handleDiffRowActivate(rowIndex, openKey, clickCx))
        );
    }

    const commentLines = this.getWrappedCommentLines(existing.text, wrapCols);
    const commentBoxH = 13 + commentLines.length * 16;
    const totalRowH = expectedHeight || (codeHeight + commentBoxH);

    return v_flex().id(rowId).w_full().h(totalRowH).flex_none().overflow_hidden()
      .cursor_pointer()
      .on_click((_e, clickCx) => this.handleDiffRowActivate(rowIndex, openKey, clickCx))
      .child(row)
      .child(
        h_flex().w_full().min_w(0).h(commentBoxH).pl(12).pr(16).py(6).bg(t.raised).border_b(1).border_color(t.border)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .child(
            h_flex().w_full().min_w(0).gap(8).items_start()
              .child(div().pt(2).flex_none().child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(t.muted)))
              .child(
                v_flex().flex_1().min_w(0).overflow_hidden().children(
                  commentLines.map((line) =>
                    div().w_full().h(16).flex_none().overflow_hidden().whitespace_nowrap().text_size(11.5).text_color(t.foreground).child(line || " ")
                  )
                )
              )
              .child(div().flex_none().text_size(10).text_color(t.dim).child(isActive ? "Editing" : "Edit"))
          )
      );
  }

  /**
   * Renders the docked review-comment composer below `#changes-diff-viewport`.
   */
  renderCommentComposer(t, commentMap, openKey) {
    const active = this.activeComment;
    if (!active || active.fileKey !== openKey) return div();
    const activeSide = normalizeCommentSide(active.side);
    const existing = commentMap ? commentMap.get(buildCommentKey(openKey, active.line, activeSide)) : null;
    const canSave = Boolean(this.commentText.trim());
    const lineTitle = activeSide === "old" ? `Line ${active.line} (removed)` : `Line ${active.line}`;
    return v_flex().id("review-comment-composer").w_full().min_w(0).flex_none()
      .px(12).py(8).gap(6).bg(t.raised).border_t(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(
        h_flex().w_full().min_w(0).items_center().justify_between().gap(8)
          .child(
            h_flex().items_center().gap(6).min_w(0).flex_1()
              .child(svg("mods/changes-review/icons/comment.svg").size(11).flex_none().text_color(t.accent))
              .child(div().flex_none().whitespace_nowrap().text_size(11.5).font_semibold().text_color(t.foreground).child(lineTitle))
              .when(Boolean(active.snippet), (e) =>
                e.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(active.snippet))
              )
          )
          .when(Boolean(existing), (e) =>
            e.child(
              h_flex().id("inline-delete-btn").h(22).px(8).flex_none().items_center().gap(4).rounded(5)
                .border_1().border_color(t.border).bg(t.background)
                .text_color(t.muted).text_size(11).cursor_pointer()
                .hover((s) => s.text_color(t.foreground).bg(t.hover))
                .on_click((_e, cx) => this.removeComment(openKey, active.line, activeSide, cx))
                .child(svg("mods/changes-review/icons/trash.svg").size(10).flex_none().text_color(t.muted))
                .child("Delete")
            )
          )
      )
      .child(
        v_flex().id("review-comment-input-box").w_full().min_w(0).h(78).p(7).rounded(7)
          .border_1().border_color(this.typingComment ? t.accent : t.border).bg(t.background).cursor_text()
          .child(Textarea.new(this.commentInput).w_full().min_w(0).h(62).text_size(12).text_color(t.foreground))
      )
      .child(
        h_flex().w_full().min_w(0).h(26).gap(8).items_center().justify_between()
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child("Esc to cancel · Cmd/Ctrl+Enter to save"))
          .child(
            h_flex().flex_none().gap(6).items_center()
              .child(
                h_flex().id("inline-cancel-btn").h(26).px(10).flex_none().items_center().rounded(6)
                  .border_1().border_color(t.border).bg(t.background)
                  .text_color(t.muted).text_size(11.5).cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .on_click((_e, cx) => this.cancelActiveComment(cx))
                  .child("Cancel")
              )
              .child(
                h_flex().id("inline-save-btn").h(26).px(12).flex_none().items_center().rounded(6)
                  .bg(canSave ? t.solid : t.background)
                  .text_color(canSave ? t.solid_foreground : t.dim)
                  .text_size(11.5).font_medium()
                  .when(canSave, (e) => e.cursor_pointer())
                  .on_click((_e, cx) => this.saveActiveComment(cx))
                  .child(existing ? "Update" : "Save")
              )
          )
      );
  }

  render(cx) {
    try {
      if (this.isViewerMode()) {
        return this.renderViewer(cx);
      }
      return this.renderPanel(cx);
    } catch (err) {
      const ser = this.logger?.recordRenderError(err, {
        mode: this.isViewerMode() ? "viewer" : "panel",
        filesCount: this.files?.length || 0,
        hiddenPreExistingCount: this.hiddenPreExistingCount || 0,
      }, cx);
      const summary = ser ? `${ser.name}: ${ser.message}` : String(err || "Render error");
      return renderErrorFallbackCard({
        modName: "changes-review",
        errorSummary: summary,
        t: theme(),
        onRetry: (retryCx) => {
          this.error = null;
          retryCx.notify();
        },
        onExport: (exportCx) => {
          exportCx.spawn(async () => {
            await this.logger?.exportReport({
              trigger: "error-card",
              extraState: {
                mode: this.isViewerMode() ? "viewer" : "panel",
                filesCount: this.files?.length || 0,
                hiddenPreExistingCount: this.hiddenPreExistingCount || 0,
                showAllWorkingChanges: Boolean(this.showAllWorkingChanges),
              },
            });
          });
        },
      });
    }
  }

  renderViewer(cx) {
    const t = theme();
    const dt = getDiffTheme(t);
    const { add, del } = dt;
    const passColor = t.ansi2 || t.done || t.accent;
    const mono = settings()?.font_family ?? "JetBrains Mono";

    const ctx = this.getSessionContext();
    const diff = readActiveDiff(ctx.spaceId);
    const desiredKey = this.computeViewerLoadedKey(diff);
    if (desiredKey !== this.viewerLoadedKey && desiredKey !== this.viewerScheduledKey) {
      this.scheduleViewerLoad(diff, cx);
    }

    const files = diff?.files || [];
    const services = diff?.services || [];
    const openFile = diff?.openFile || files.find((f) => f.key === diff?.openFileKey) || null;
    const openKey = openFile?.key || diff?.openFileKey || null;
    const openFilePath = openFile?.path || openFile?.displayPath || "";
    const isMdFile = Boolean(openFile && isMarkdownFile(openFilePath));
    const currentMdFileId = isMdFile ? computeViewerMarkdownFileId(openFile) : "";
    const markdownActive = Boolean(
      isMdFile &&
      this.viewerMarkdownRendered &&
      this.viewerMarkdownFileId === currentMdFileId
    );

    const flows = readFlows();
    const flow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    const openFileReviewed = openFile ? this.isFileReviewed(openFile, flow) : false;
    const reviewedFilesCount = files.reduce((n, f) => n + (this.isFileReviewed(f, flow) ? 1 : 0), 0);
    const allFilesReviewed = files.length > 0 && reviewedFilesCount === files.length;
    const fileIdx = openKey ? files.findIndex((f) => f.key === openKey) : -1;

    const commentMap = this.buildCommentMapForFile(openKey, ctx);
    const wrapCols = markdownActive ? 96 : this.getReviewWrapCols();
    const diffRowLayout = !markdownActive ? this.computeDiffRowLayout(commentMap, wrapCols, openKey) : null;
    const diffViewportH = this.getDiffViewportHeight();
    const diffSlice = diffRowLayout
      ? computeVariableWindowSlice(diffRowLayout, this.diffScrollPx, diffViewportH, 2)
      : null;
    const diffScrollbar = diffSlice
      ? computeDiffScrollbarMetrics(diffSlice.totalHeight, diffSlice.scrollPx, diffSlice.viewportHeight, Math.max(24, diffSlice.viewportHeight - 8))
      : null;

    const canStepFiles = files.length > 1;
    const openIcon = openFile ? resolveDiffFileIcon(openFile.path || openFile.displayPath, t) : null;
    const compactViewer = (this.viewerWidth || 900) < 680;
    const baseBadgeLabel = openFile?.baseRef
      ? `vs ${openFile.baseRef}`
      : (openFile?.hasHead === false ? "New repo" : "Session");

    const renderFileInfo = () =>
      h_flex()
        .when(!compactViewer, (b) => b.flex_1().min_w(180))
        .when(compactViewer, (b) => b.w_full().min_w(0))
        .gap(6)
        .items_center()
        .when(services.length > 1 && Boolean(openFile?.serviceName), (b) => b.child(
          div().flex_none().px(5).py(1).rounded(4).bg(t.background).border_1().border_color(t.border)
            .text_size(10).font_medium().text_color(t.muted)
            .child(openFile.serviceName)
        ))
        .child(
          div().flex_none().w(14).text_center().text_size(11).font_semibold()
            .text_color(openFile?.status === "A" ? add : openFile?.status === "D" || openFile?.status === "U" ? del : t.blocked)
            .child(openFile?.status || "M")
        )
        .when(Boolean(openIcon), (b) => b.child(svg(openIcon.path).size(14).flex_none().text_color(openIcon.color)))
        .child(
          div().flex_1().min_w(0).truncate().text_size(12).font_medium()
            .text_color(openFileReviewed ? t.muted : t.foreground)
            .child(openFile?.displayPath || openFile?.path || "")
        )
        .when((openFile?.add || 0) > 0, (b) => b.child(div().flex_none().text_size(11).text_color(add).child(`+${openFile.add}`)))
        .when((openFile?.del || 0) > 0, (b) => b.child(div().flex_none().text_size(11).text_color(del).child(`−${openFile.del}`)))
        .when(!compactViewer, (b) => b.child(
          div().flex_none().px(5).py(1).rounded(4).bg(t.background).border_1().border_color(t.border)
            .text_size(10).text_color(t.muted)
            .child(baseBadgeLabel)
        ));

    const renderReviewControls = () =>
      h_flex()
        .when(compactViewer, (b) => b.w_full().justify_between())
        .when(!compactViewer, (b) => b.flex_none())
        .flex_wrap()
        .gap(5)
        .items_center()
        .when(files.length > 0, (b) => b.child(
          h_flex().flex_none().gap(4).items_center()
            .child(
              h_flex().id("diff-prev-btn").h(24).w(24).items_center().justify_center().rounded(5)
                .border_1().border_color(t.border).bg(t.background)
                .text_size(11.5).text_color(canStepFiles ? t.foreground : t.dim)
                .when(canStepFiles, (p) => p.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.stepViewerFile(-1, cx)))
                .tooltip("Previous file")
                .child("←")
            )
            .when(fileIdx >= 0, (p) => p.child(
              div().flex_none().px(3).text_size(10.5).text_color(t.muted).child(`${fileIdx + 1}/${files.length}`)
            ))
            .child(
              h_flex().id("diff-next-btn").h(24).w(24).items_center().justify_center().rounded(5)
                .border_1().border_color(t.border).bg(t.background)
                .text_size(11.5).text_color(canStepFiles ? t.foreground : t.dim)
                .when(canStepFiles, (p) => p.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.stepViewerFile(1, cx)))
                .tooltip("Next file")
                .child("→")
            )
            .child(
              div().flex_none().px(5).py(1).rounded(4)
                .bg(allFilesReviewed ? hexWithAlpha(passColor, "22") : t.background)
                .border_1()
                .border_color(allFilesReviewed ? hexWithAlpha(passColor, "66") : t.border)
                .text_size(10).font_medium().text_color(allFilesReviewed ? passColor : t.muted)
                .tooltip(`${reviewedFilesCount} of ${files.length} files reviewed`)
                .child(`${reviewedFilesCount}/${files.length} ✓`)
            )
        ))
        .child(
          h_flex().flex_none().flex_wrap().gap(5).items_center()
            .when(isMdFile, (bar) => bar.child(
              renderMarkdownToggleButton({
                id: "diff-markdown-toggle",
                active: markdownActive,
                compact: compactViewer,
                height: 24,
                rounded: 5,
                icon: "mods/changes-review/icons/file-types/markdown.svg",
                tooltip: markdownActive ? "Switch back to diff view" : "Render formatted Markdown",
                t,
                onClick: (_e, cx) => this.toggleViewerMarkdown(diff, cx),
              })
            ))
            .child(
              h_flex().id("diff-reload-btn").h(24).w(24).items_center().justify_center().rounded(5)
                .border_1().border_color(t.border).bg(t.background)
                .text_size(12).text_color(t.muted).cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip(markdownActive ? "Reload Markdown & diff" : "Reload diff")
                .on_click((_e, cx) => this.loadViewerDiffNow(diff, cx, { forceReload: true }))
                .child("↻")
            )
            .child(
              h_flex()
                .id("diff-viewed-btn")
                .h(24)
                .px(compactViewer ? 8 : 10)
                .flex_none()
                .items_center()
                .justify_center()
                .rounded(5)
                .border_1()
                .cursor_pointer()
                .tooltip(openFileReviewed ? "Click to unapprove file" : "Approve file & advance to next unreviewed file")
                .when(openFileReviewed, (btn) =>
                  btn
                    .bg(hexWithAlpha(passColor, "22"))
                    .border_color(hexWithAlpha(passColor, "77"))
                    .text_color(passColor)
                    .hover((s) => s.bg(hexWithAlpha(passColor, "33")))
                )
                .when(!openFileReviewed, (btn) =>
                  btn
                    .bg(t.solid)
                    .border_color(t.solid)
                    .text_color(t.solid_foreground)
                    .hover((s) => s.bg(hexWithAlpha(t.solid, "dd")))
                )
                .on_click((_e, cx) => this.toggleViewerFileReviewed(cx))
                .child(
                  div()
                    .text_size(11)
                    .font_medium()
                    .child(openFileReviewed ? (compactViewer ? "Approved" : "Approved ✓") : "Approve")
                )
            )
        );

    return v_flex().id("review-tab-viewer").size_full().min_h(0).rounded(10).overflow_hidden().relative()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const w = Math.round(size?.width || 0);
        const prevW = this.viewerWidth || 900;
        if (w > 0 && Math.abs(w - prevW) > 12) {
          const compactChanged = (prevW < 680) !== (w < 680);
          this.viewerWidth = w;
          if (compactChanged || !this.diffViewportWidth) {
            cx.notify();
          }
        }
      })
      .when(Boolean(this.diffScrollbarDrag), (el) =>
        el
          .on_mouse_move((e, moveCx) => {
            const drag = this.diffScrollbarDrag;
            if (!drag || !Number.isFinite(e?.position?.y)) return;
            const thumbTop = (e.position.y - drag.trackTopY) - drag.grabOffsetY;
            const nextPx = resolveDiffScrollbarDragPx(thumbTop, drag.trackHeight, drag.thumbHeight, drag.maxScrollPx);
            if (nextPx !== this.diffScrollPx) {
              this.diffScrollPx = nextPx;
              moveCx.notify();
            }
          })
          .on_mouse_up("left", (_e, upCx) => {
            if (this.diffScrollbarDrag) {
              this.diffScrollbarDrag = null;
              upCx.notify();
            }
          })
      )
      .on_key_down((e, cx) => {
        if (!markdownActive && e.key === "escape" && (this.typingComment || this.activeComment)) {
          this.cancelActiveComment(cx);
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
          return;
        }
        if (
          !markdownActive &&
          !this.typingComment &&
          !this.activeComment &&
          diffRowLayout &&
          this.rows.length > 0 &&
          !e.modifiers?.control &&
          !e.modifiers?.alt &&
          !e.modifiers?.platform
        ) {
          const k = e.key;
          const pagePx = Math.max(REVIEW_ROW_HEIGHT * 3, diffViewportH - REVIEW_ROW_HEIGHT * 2);
          if (k === "down" || k === "arrowdown") {
            this.scrollDiffByPx(REVIEW_ROW_HEIGHT * 2, diffRowLayout, cx);
            cx.stop_propagation();
          } else if (k === "up" || k === "arrowup") {
            this.scrollDiffByPx(-REVIEW_ROW_HEIGHT * 2, diffRowLayout, cx);
            cx.stop_propagation();
          } else if (k === "pagedown") {
            this.scrollDiffByPx(pagePx, diffRowLayout, cx);
            cx.stop_propagation();
          } else if (k === "pageup") {
            this.scrollDiffByPx(-pagePx, diffRowLayout, cx);
            cx.stop_propagation();
          } else if (k === "home") {
            if (this.diffScrollPx !== 0) {
              this.diffScrollPx = 0;
              cx.notify();
            }
            cx.stop_propagation();
          } else if (k === "end") {
            const maxPx = Math.max(0, diffRowLayout.totalHeight - diffViewportH);
            if (this.diffScrollPx !== maxPx) {
              this.diffScrollPx = maxPx;
              cx.notify();
            }
            cx.stop_propagation();
          }
        }
      })
      .when(Boolean(openFile), (el) => el.child(
        (compactViewer ? v_flex() : h_flex().flex_wrap())
          .id("diff-file-review-bar")
          .min_h(40)
          .flex_none()
          .px(compactViewer ? 10 : 12)
          .py(6)
          .gap(compactViewer ? 6 : 8)
          .when(!compactViewer, (b) => b.items_center().justify_between())
          .border_b(1)
          .border_color(t.border)
          .bg(t.raised)
          .child(renderFileInfo())
          .child(renderReviewControls())
      ))
      .when(!markdownActive && Boolean(this.viewerNote), (el) => el.child(
        div().flex_none().px(12).py(6).border_b(1).border_color(t.border).text_size(11).text_color(del).child(this.viewerNote)
      ))
      .child(
        markdownActive
          ? renderMarkdownViewer({
              id: `changes-md-view::${currentMdFileId}::${this.viewerMarkdownLoadedToken || "0"}`,
              scrollId: `changes-md-scroll::${currentMdFileId}::${this.viewerMarkdownLoadedToken || "0"}`,
              prepared: this.viewerMarkdownPrepared,
              filePath: openFilePath,
              loading: this.viewerMarkdownLoading,
              error: this.viewerMarkdownError,
              noticeBanner: this.viewerMarkdownNotice,
              emptyText: this.viewerMarkdownNotice
                ? `${this.viewerMarkdownNotice} (Empty Markdown file)`
                : "Empty Markdown file",
              monoFont: mono,
              t,
              onRelativeLink: (href, linkCx) => {
                const targetRel = resolveRelativeMarkdownPath(openFilePath, href);
                if (!targetRel) return;
                const normTarget = targetRel.replace(/^\/+/, "");
                const targetFile = files.find((f) => {
                  if (!f || f.serviceId !== openFile?.serviceId) return false;
                  const p = String(f.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
                  return p === normTarget;
                });
                if (targetFile) {
                  this.openViewerFile(targetFile, diff, ctx, linkCx || cx);
                }
              },
            })
          : (() => {
              const visibleRowEls = [];
              if (diffSlice && diffRowLayout && this.rows.length > 0) {
                for (let i = diffSlice.start; i < diffSlice.end; i++) {
                  visibleRowEls.push(
                    this.diffRow(this.rows[i], i, t, dt, commentMap, openKey, wrapCols, diffRowLayout.heights[i])
                  );
                }
              }
              return v_flex().id("changes-diff-viewport").flex_1().min_h(0).w_full()
                .on_size_change((size, sizeCx) => {
                  const w = Math.round(size?.width || 0);
                  const h = Math.round(size?.height || 0);
                  this.scheduleDiffResizeReflow(w, h, sizeCx);
                })
                .when(Boolean(diffRowLayout) && this.rows.length > 0, (el) =>
                  el.on_scroll_wheel((e, wheelCx) => {
                    const dx = Math.abs(e.delta?.x || 0);
                    const dy = Math.abs(e.delta?.y || 0);
                    const dlY = Number(e.delta_lines?.y || 0);
                    if (dlY !== 0 || (dy > 0 && dy >= dx && !e.modifiers?.shift)) {
                      const deltaPx = resolveDiffWheelDeltaPx(e.delta?.y || 0, dlY, REVIEW_ROW_HEIGHT);
                      if (deltaPx !== 0) {
                        this.scrollDiffByPx(deltaPx, diffRowLayout, wheelCx);
                        wheelCx.stop_propagation();
                      }
                    }
                  })
                )
                .child(
                  div().id("changes-diff-wrap").size_full().relative().overflow_hidden().font_family(mono).text_size(11.5)
                    .when(visibleRowEls.length > 0 && Boolean(diffSlice), (el) => el
                      .child(
                        v_flex()
                          .id("changes-diff-lines")
                          .w_full()
                          .absolute()
                          .top(diffSlice.topOffsetPx)
                          .left_0()
                          .right_0()
                          .children(visibleRowEls)
                      )
                    )
                    .when(Boolean(diffScrollbar?.visible), (el) => el
                      .child(
                        v_flex()
                          .id("changes-diff-scrollbar-track")
                          .absolute()
                          .top(4)
                          .bottom(4)
                          .right(2)
                          .w(10)
                          .items_center()
                          .cursor_pointer()
                          .on_mouse_down("left", (e, dragCx) => {
                            dragCx.stop_propagation();
                            const posY = Number(e?.position?.y);
                            const localY = Number.isFinite(e?.local_position?.y)
                              ? e.local_position.y
                              : (Number.isFinite(posY) && Number.isFinite(e?.bounds?.y) ? posY - e.bounds.y : 0);
                            const trackTopY = Number.isFinite(e?.bounds?.y)
                              ? e.bounds.y
                              : (Number.isFinite(posY) ? posY - localY : 0);
                            const hitThumb = localY >= diffScrollbar.thumbTop && localY <= (diffScrollbar.thumbTop + diffScrollbar.thumbHeight);
                            const grabOffsetY = hitThumb ? (localY - diffScrollbar.thumbTop) : (diffScrollbar.thumbHeight / 2);
                            this.diffScrollbarDrag = {
                              trackTopY,
                              trackHeight: diffScrollbar.trackHeight,
                              thumbHeight: diffScrollbar.thumbHeight,
                              maxScrollPx: diffScrollbar.maxScrollPx,
                              grabOffsetY,
                            };
                            if (!hitThumb) {
                              this.diffScrollPx = resolveDiffScrollbarDragPx(
                                localY - grabOffsetY,
                                diffScrollbar.trackHeight,
                                diffScrollbar.thumbHeight,
                                diffScrollbar.maxScrollPx,
                              );
                            }
                            dragCx.notify();
                          })
                          .child(div().w_full().h(diffScrollbar.thumbTop).flex_none())
                          .child(
                            div()
                              .id("changes-diff-scrollbar-thumb")
                              .w(6)
                              .h(diffScrollbar.thumbHeight)
                              .flex_none()
                              .rounded(3)
                              .bg(this.diffScrollbarDrag ? t.muted : t.border)
                              .hover((s) => s.bg(t.muted))
                          )
                          .child(div().w_full().flex_1().min_h(0))
                      )
                    )
                    .when(!openFile, (e) => e.child(
                      h_flex().absolute().inset_0().items_center().justify_center()
                        .child(div().text_size(12).text_color(t.dim).child(
                          files.length === 0
                            ? "No changes in this session yet"
                            : "Select a file from the Changes panel to review its diff"
                        ))
                    ))
                    .when(Boolean(openFile) && this.viewerLoading && this.rows.length === 0, (e) => e.child(
                      div().absolute().top(12).left(14).text_size(11.5).text_color(t.dim).child("Loading diff…")
                    ))
                );
            })()
      )
      .when(!markdownActive && Boolean(this.activeComment && this.activeComment.fileKey === openKey), (el) =>
        el.child(this.renderCommentComposer(t, commentMap, openKey))
      );
  }

  renderPanel(cx) {
    const visible = isChangesVisible();
    const bus = safeShared("cognivisor.services", null);
    const busTs = typeof bus?.ts === "number" ? bus.ts : 0;
    const busSig = bus?.sig || (busTs > 0 ? String(busTs) : "");
    const busChanged = Boolean(busSig && busSig !== this.lastConsumedBusSig);
    if (busTs > 0) this.lastConsumedBusTs = busTs;
    const becameVisible = visible && !this.wasVisible;
    this.wasVisible = visible;
    if (visible && (key() !== this.context || becameVisible || this.needsRefreshOnShow || !this.hasLoadedOnce || busChanged)) {
      this.needsRefreshOnShow = false;
      this.scheduleRenderRefresh(cx);
    } else if (!visible && busChanged) {
      this.needsRefreshOnShow = true;
    }

    // Zero per-frame allocations when the Changes sidebar panel is hidden.
    if (!visible) {
      return div().id("changes");
    }

    const allSpaces = spaces() || [];
    const allPanes = panes() || [];
    const curSpace = allSpaces.find((s) => s.active);
    const curTab = (curSpace?.tabs || []).find((t) => t.active);
    if (curSpace?.id && curTab?.id && allPanes.some((p) => p.tab === curTab.id && Boolean(p.terminal))) {
      const storedAgentTabs = readPlainObject(safeShared("cognivisor.spaceAgentTabs", {}));
      if (storedAgentTabs[curSpace.id] !== curTab.id) {
        this.scheduleAgentTabSync(cx);
      }
    }

    const ctx = this.getSessionContext();
    const activeDiff = readActiveDiff(ctx.spaceId);
    const revTab = findReviewTabInSpace(ctx.spaceId, allSpaces, allPanes);
    const diffSyncedFromViewer = Boolean(
      revTab &&
      activeDiff &&
      activeDiff.sourceTabId === ctx.sourceTabId &&
      activeDiff.openFileKey !== this.open
    );
    if (diffSyncedFromViewer) {
      this.scheduleSharedSync(cx);
    }

    const t = theme();
    const addCount = this.files.reduce((n, f) => n + f.add, 0);
    const delCount = this.files.reduce((n, f) => n + f.del, 0);
    const dt = getDiffTheme(t);
    const { add, del } = dt;
    const passColor = t.ansi2 || t.done || t.accent;

    const flows = readFlows();
    const flow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    const sessionReviews = this.getSessionReviews(ctx);

    const targetRepos = this.getTargetRepos();
    const commitEnabled = Boolean(this.message.trim() && targetRepos.length > 0 && !this.busy && !this.loading);
    const agent = this.findActiveAgent();
    const agentName = agent ? (agent.title || agent.app || agent.address) : null;
    const highlightedOpenKey = (revTab && activeDiff && activeDiff.sourceTabId === ctx.sourceTabId)
      ? activeDiff.openFileKey
      : this.open;
    const reviewedFilesCount = this.files.reduce((n, f) => n + (this.isFileReviewed(f, flow) ? 1 : 0), 0);
    const allFilesReviewed = this.files.length > 0 && reviewedFilesCount === this.files.length;
    const compactPanel = (this.panelWidth || 420) < 380;

    const renderPanelHeaderBadges = () =>
      h_flex().flex_none().gap(6).items_center()
        .child(div().flex_none().font_semibold().child("Changes"))
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(compactPanel ? `${this.files.length}` : `${this.files.length} files`))
        .when(this.files.length > 0 && reviewedFilesCount > 0, (el) => el.child(
          div()
            .flex_none()
            .px(5)
            .py(1)
            .rounded(4)
            .border_1()
            .border_color(allFilesReviewed ? hexWithAlpha(passColor, "77") : t.border)
            .when(allFilesReviewed, (b) => b.bg(hexWithAlpha(passColor, "22")))
            .text_size(10)
            .font_medium()
            .text_color(allFilesReviewed ? passColor : t.muted)
            .child(`${reviewedFilesCount}/${this.files.length} ✓`)
        ));

    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().relative().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
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
        if (e.key === "escape") {
          if (this.typingCommit) {
            this.typingCommit = false;
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
            return;
          }
        }
      })
      // Compact unified header (no commit picker, no repo filter bar)
      .child(
        h_flex().min_h(40).flex_none().px(compactPanel ? 10 : 12).py(6).gap(8).items_center().border_b(1).border_color(t.border)
          .child(renderPanelHeaderBadges())
          .child(div().flex_1())
          .child(div().flex_none().text_size(11).text_color(add).child(`+${addCount}`))
          .child(div().flex_none().text_size(11).text_color(del).child(`−${delCount}`))
      )

      // Pre-existing hidden files banner + toggle + baseline reset
      .when(this.hiddenPreExistingCount > 0 || this.showAllWorkingChanges, (el) => {
        const n = this.hiddenPreExistingCount;
        const label = this.showAllWorkingChanges
          ? (n > 0 ? `Showing all changes (${n} pre-existing)` : "Showing all changes")
          : `${n} ${n === 1 ? "file" : "files"} hidden as pre-existing`;
        return el.child(
          h_flex()
            .id("preexisting-baseline-bar")
            .min_h(28)
            .flex_none()
            .px(10)
            .py(4)
            .gap(6)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .text_color(this.showAllWorkingChanges ? t.foreground : t.muted)
                .child(label),
            )
            .child(
              div()
                .id("toggle-preexisting-btn")
                .flex_none()
                .px(6)
                .py(2)
                .rounded(4)
                .border_1()
                .border_color(this.showAllWorkingChanges ? (t.accent || t.border) : t.border)
                .bg(t.background)
                .text_size(10.5)
                .font_medium()
                .text_color(this.showAllWorkingChanges ? (t.accent || t.foreground) : t.foreground)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .tooltip(this.showAllWorkingChanges ? "Show only changes made during this session" : "Show all dirty working-tree files including pre-existing ones")
                .on_click((_e, cx) => this.toggleShowAllWorkingChanges(cx))
                .child(this.showAllWorkingChanges ? "Session only" : "Show all"),
            )
            .child(
              div()
                .id("reset-baseline-btn")
                .flex_none()
                .px(6)
                .py(2)
                .rounded(4)
                .border_1()
                .border_color(t.border)
                .bg(t.background)
                .text_size(10.5)
                .text_color(t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip("Clear pre-existing baseline snapshot so all current working changes belong to this session")
                .on_click((_e, cx) => this.resetSessionBaseline(cx))
                .child("Reset baseline"),
            ),
        );
      })

      // Unified changed files list across all session-touched repositories
      .child(v_flex().id("changes-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        const isReviewed = this.isFileReviewed(f, flow);
        const isOpen = highlightedOpenKey === f.key;
        const fileIcon = resolveDiffFileIcon(f.path, t);
        return h_flex().id(`change-${f.key}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
          .when(isOpen, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(f.key, cx))
          .child(
            h_flex()
              .id(`file-check-${f.key}`)
              .w(15)
              .h(15)
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(4)
              .border_1()
              .cursor_pointer()
              .tooltip(isReviewed ? "Mark file as unreviewed" : "Mark file as reviewed")
              .when(isReviewed, (cb) => cb.bg(passColor).border_color(passColor).text_color(t.background))
              .when(!isReviewed, (cb) => cb.bg(t.background).border_color(t.border).hover((s) => s.border_color(passColor)))
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.toggleFileReviewed(f, cx);
              })
              .child(div().text_size(9.5).font_semibold().child(isReviewed ? "✓" : ""))
          )
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? add : f.status === "D" || f.status === "U" ? del : t.blocked).child(f.status))
          .when(this.services.length > 1, (e) => e.child(
            div().flex_none().px(4).py(0.5).rounded(3).bg(t.raised).border_1().border_color(t.border).text_size(9.5).text_color(t.muted).child(f.serviceName)
          ))
          .child(svg(fileIcon.path).size(13).flex_none().text_color(fileIcon.color))
          .child(
            h_flex().flex_1().min_w(0)
              .child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : ""))
              .child(div().max_w(260).min_w(0).truncate().text_color(isReviewed ? (isOpen ? t.muted : t.dim) : t.foreground).child(name))
          )
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(isReviewed ? t.dim : add).child(`+${f.add}`)))
          .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(isReviewed ? t.dim : del).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(
        this.error || (this.loading ? "Loading changes…" : !this.workspaceRoot ? "No folder" : "No changes in this session yet")
      ))))

      .when(this.limited, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.panelNote), (e) => e.child(div().px(10).py(4).text_size(11).text_color(del).child(this.panelNote)))

      // Bottom switcher bar (Review | Commit)
      .child(
        h_flex().flex_none().h(28).px(8).gap(6).items_center().border_t(1).border_color(t.border).bg(t.raised)
          .child(
            h_flex().id("tab-review").px(8).py(3).gap(5).items_center().rounded(4).text_size(11).font_medium().cursor_pointer()
              .when(this.bottomTab === "review", (e) => e.bg(t.background).text_color(t.foreground).border_1().border_color(t.border), (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.bottomTab = "review"; cx.notify(); })
              .child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(this.bottomTab === "review" ? t.foreground : t.muted))
              .child(div().child("Review"))
              .when(sessionReviews.length > 0, (el) => el.child(
                div().px(4).py(0.5).rounded(3).border_1().border_color(t.border).text_color(t.muted).text_size(9.5).child(String(sessionReviews.length))
              ))
          )
          .child(
            h_flex().id("tab-commit").px(8).py(3).gap(5).items_center().rounded(4).text_size(11).font_medium().cursor_pointer()
              .when(this.bottomTab === "commit", (e) => e.bg(t.background).text_color(t.foreground).border_1().border_color(t.border), (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.bottomTab = "commit"; cx.notify(); })
              .child(svg("mods/changes-review/icons/git-commit.svg").size(11).text_color(this.bottomTab === "commit" ? t.foreground : t.muted))
              .child(div().child("Commit"))
          )
      )

      // Commit section (strictly targets visible dirty working-tree files)
      .when(this.bottomTab === "commit", (el) => el.child(
        targetRepos.length > 0 || this.files.length === 0
          ? h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.background)
              .child(
                div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typingCommit ? t.accent : t.border).bg(t.background).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground))
              )
              .child(
                div().id("commit").h(32).px(14).flex().items_center().rounded(8)
                  .bg(commitEnabled ? t.solid : t.raised)
                  .text_color(commitEnabled ? t.solid_foreground : t.dim)
                  .text_size(12)
                  .when(commitEnabled, (e) => e.cursor_pointer())
                  .on_click((_e, cx) => this.commit(cx))
                  .child(this.busy ? "Committing…" : targetRepos.length > 1 ? `Commit (${targetRepos.length} repos)` : "Commit")
              )
          : h_flex().flex_none().px(12).py(8).gap(6).items_center().border_t(1).border_color(t.border).bg(t.background)
              .child(svg("mods/changes-review/icons/git-commit.svg").size(12).flex_none().text_color(t.muted))
              .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).child("All session changes are already committed (no uncommitted working-tree files)."))
      ))

      // Review section (scrollable list of side-aware notes + send to agent)
      .when(this.bottomTab === "review", (el) => el.child(
        v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border).bg(t.background)
          .when(sessionReviews.length === 0, (h) => h.child(
            div().py(6).px(4).text_size(11).text_color(t.dim).child("Click any changed file to review its diff in a tab.")
          ))
          .when(sessionReviews.length > 0, (l) => l.child(
            div().w_full().h(Math.min(116, Math.max(26, sessionReviews.length * 29 - 3))).flex_none().relative()
              .child(
                v_flex().id("reviews-list").size_full().overflow_y_scroll().when(sessionReviews.length > 4, (e) => e.pr(10)).gap(3).children(
                  sessionReviews.map((r) => {
                    const fileName = (r.displayPath || r.file).split("/").pop();
                    const firstLine = String(r.text || "").split(/\r?\n/)[0];
                    const servicePrefix = this.services.length > 1 && r.serviceName ? `[${r.serviceName}] ` : "";
                    const noteSide = normalizeCommentSide(r.side);
                    const sideTag = noteSide === "old" ? " (-)" : "";
                    return h_flex().id(`review-${r.fileKey || r.file}-${noteSide}-${r.line}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).bg(t.raised).cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => this.jumpToComment(r, cx))
                      .child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(t.muted))
                      .child(div().text_size(11).text_color(t.muted).child(`${servicePrefix}${fileName}:${r.line}${sideTag}`))
                      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(firstLine))
                      .child(
                        div().p(3).rounded(4).cursor_pointer().hover((s) => s.bg(t.background))
                          .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.removeComment(r.fileKey || r.file, r.line, noteSide, cx);
                          })
                          .child(svg("mods/changes-review/icons/trash.svg").size(10).text_color(t.dim))
                      );
                  })
                )
              )
              .when(sessionReviews.length > 4, (e) => e.child(
                Scrollbar.vertical("reviews-list").mode("always").absolute().top_0().bottom_0().right_0().w(6)
              ))
          ))
          .child(
            h_flex().pt(2).gap(8).items_center().justify_between()
              .child(
                h_flex().gap(4).items_center().text_size(10.5).text_color(t.dim)
                  .child(svg("mods/changes-review/icons/bot.svg").size(11).text_color(t.dim))
                  .child(div().child(agentName || "No agent active"))
              )
              .child(
                h_flex().gap(6).items_center()
                  .when(sessionReviews.length > 0, (el) => el.child(
                    div().px(6).py(2).rounded(4).text_size(10.5).text_color(t.dim).cursor_pointer()
                      .hover((s) => s.text_color(del))
                      .on_click((_e, cx) => this.clearComments(cx))
                      .child("Clear all")
                  ))
                  .child(
                    h_flex().id("send-review-btn").h(30).px(14).gap(6).items_center().rounded(8)
                      .bg(sessionReviews.length > 0 && !this.sendingReview ? t.solid : t.raised)
                      .text_color(sessionReviews.length > 0 && !this.sendingReview ? t.solid_foreground : t.dim)
                      .text_size(12)
                      .when(sessionReviews.length > 0 && !this.sendingReview, (b) => b.cursor_pointer().on_click((_e, cx) => this.sendReview(cx)))
                      .child(svg("mods/changes-review/icons/send.svg").size(11).text_color(sessionReviews.length > 0 && !this.sendingReview ? t.solid_foreground : t.dim))
                      .child(div().child(this.sendingReview ? "Sending…" : "Send to agent"))
                  )
              )
          )
      ));
  }
}
