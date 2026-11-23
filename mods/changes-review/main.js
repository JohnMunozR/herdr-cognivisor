import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle, InputState, Input, TextareaState, Textarea, Scrollbar, ScrollHandle } from "gpui-base";
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
  sortServicesDirtyFirst,
  filterSessionCommits,
  filterSessionWorkingEntries,
  partitionSessionWorkingEntries,
  normalizeSessionBaseline,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  resolveSessionStartTime,
  buildFreshSessionBaseline,
  createResetSessionBaseline,
  findRecentFlowWorkspaceBaseline,
  findRecentWorkspaceBaseline,
  countBaselineDirtyFiles,
  compactFlowsMap,
  extractResumeKeyFromTranscript,
  filterUnbaselinedRepoEntries,
  resolveWorkspaceRoot,
  READ_GIT_FLAGS,
  mergeBusCandidateServices,
  collectServiceWorkingSnapshot,
  computeFileReviewFingerprint,
  parseReviewedFileRecord,
  reconcileReviewedFiles,
  resolveReviewMarkdownSourceSpec,
  computeViewerMarkdownFileId,
  computeReviewMarkdownLoadToken,
  buildReviewMarkdownCacheKey,
  validateMarkdownTextContent,
  formatGitShowMarkdownError,
} from "./review-logic.js";
import { computeWrapColumns, countWrappedLines, wrapPlainText, wrapStyledSpans } from "./code-wrap.js";
import { renderDropdownTrigger, renderDropdownPopover } from "./dropdown.js";
import { isMarkdownFile, resolveRelativeMarkdownPath } from "./markdown-view-logic.js";
import { createMarkdownRenderCache, renderMarkdownToggleButton, renderMarkdownViewer } from "./markdown-view.js";
import { createModLogger, renderErrorFallbackCard } from "./diagnostics.js";

const reviewWrapCache = new WeakMap();
const REVIEW_ROW_HEIGHT = 20;
const REVIEW_ACTIVE_COMMENT_H = 134;

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

const SESSION_BASELINE_CACHE = new Map();
const MAX_BASELINE_CACHE_ENTRIES = 32;
let flowsBusOomDetected = false;

function cacheSessionBaseline(tabId, baseline) {
  if (!tabId || !baseline) return;
  if (SESSION_BASELINE_CACHE.size >= MAX_BASELINE_CACHE_ENTRIES && !SESSION_BASELINE_CACHE.has(tabId)) {
    const oldest = SESSION_BASELINE_CACHE.keys().next().value;
    if (oldest !== undefined) SESSION_BASELINE_CACHE.delete(oldest);
  }
  SESSION_BASELINE_CACHE.set(tabId, baseline);
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

function mergeSessionBaselineIntoFlow(tabId, baseline, sessionRepos = null, force = false) {
  if (!tabId) return;
  const normalized = normalizeSessionBaseline(baseline);
  if (!normalized) return;
  cacheSessionBaseline(tabId, normalized);
  const rawFlows = safeReadFlows();
  const liveTabIds = getLiveTabIdsSet();
  const flows = compactFlowsMap(rawFlows, liveTabIds);
  const hadLegacyBaseline = Object.values(rawFlows).some((f) => f && typeof f === "object" && Boolean(f.sessionBaseline));
  const prunedCount = Object.keys(rawFlows).length !== Object.keys(flows).length;
  const cur = flows[tabId] && typeof flows[tabId] === "object" ? flows[tabId] : {};
  const prevRepos = Array.isArray(cur.sessionRepos) ? cur.sessionRepos.map((r) => normPathStr(r)) : [];
  const nextRepos = Array.isArray(sessionRepos) ? sessionRepos.map((r) => normPathStr(r)).filter(Boolean) : null;
  const reposChanged = Boolean(nextRepos && (prevRepos.length !== nextRepos.length || prevRepos.some((r, idx) => r !== nextRepos[idx])));
  const metaChanged =
    force ||
    flowsBusOomDetected ||
    hadLegacyBaseline ||
    prunedCount ||
    cur.sessionStartedAt !== normalized.startedAt;
  if (!metaChanged && !reposChanged) return;
  flowsBusOomDetected = false;
  setShared("cognivisor.flows", {
    ...flows,
    [tabId]: {
      ...cur,
      sessionStartedAt: normalized.startedAt,
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

async function resolveOrInitSessionBaseline(sessionTabId, serviceResults, tabTermAddrs, workspaceRoot) {
  if (!sessionTabId) return { baseline: null, isFresh: false, anchored: false, dirtyChanged: false, primaryBranch: "" };
  const normWs = normPathStr(workspaceRoot || "");
  const primaryService = (serviceResults || []).find((r) => normPathStr(r.service?.root) === normWs)
    || (serviceResults || []).find((r) => r.branch)
    || null;
  const primaryBranch = String(primaryService?.branch || "").trim();
  const candidateBranches = Array.from(
    new Set((serviceResults || []).map((r) => String(r.branch || r.service?.branch || "").trim()).filter(Boolean))
  );

  const cached = normalizeSessionBaseline(SESSION_BASELINE_CACHE.get(sessionTabId));
  if (cached && (!normWs || !cached.workspaceRoot || cached.workspaceRoot === normWs)) {
    return { baseline: cached, isFresh: false, anchored: false, dirtyChanged: false, primaryBranch };
  }

  const flows = safeReadFlows();
  const curFlow = readPlainObject(flows[sessionTabId]);
  const rawExisting = curFlow.sessionBaseline;
  const existing = normalizeSessionBaseline(rawExisting);
  if (existing && (!normWs || !existing.workspaceRoot || existing.workspaceRoot === normWs)) {
    cacheSessionBaseline(sessionTabId, existing);
    return { baseline: existing, isFresh: false, anchored: false, dirtyChanged: true, primaryBranch };
  }

  const appHomeDir = getSafeAppHome();
  if (appHomeDir) {
    const fromTab = await readDiskSessionBaseline(appHomeDir, sessionTabId, workspaceRoot, candidateBranches, false, fsPromises);
    if (fromTab) {
      cacheSessionBaseline(sessionTabId, fromTab);
      return { baseline: fromTab, isFresh: false, anchored: false, dirtyChanged: false, primaryBranch };
    }
  }

  let resumeKey = "";
  if (appHomeDir && Array.isArray(tabTermAddrs) && tabTermAddrs.length > 0) {
    const reads = await Promise.all(
      tabTermAddrs.slice(0, 2).map((addr) => hc(["read", "--lines", "100", addr]).catch(() => ""))
    );
    const transcript = reads.filter(Boolean).join("\n");
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
        cacheSessionBaseline(sessionTabId, fromResume);
        return { baseline: fromResume, isFresh: false, anchored: false, dirtyChanged: true, primaryBranch, resumeKey };
      }
    }
  }

  // Reuse a recent orphaned baseline for the same workspaceRoot (e.g., after tab recreation)
  // without stealing baselines owned by other currently-open tabs.
  const liveTabIds = getLiveTabIdsSet();
  const recentFlowBaseline = findRecentFlowWorkspaceBaseline(flows, workspaceRoot, {
    excludeTabId: sessionTabId,
    liveTabIds,
  });
  if (recentFlowBaseline) {
    cacheSessionBaseline(sessionTabId, recentFlowBaseline);
    return { baseline: recentFlowBaseline, isFresh: false, anchored: false, dirtyChanged: true, primaryBranch, resumeKey };
  }
  if (appHomeDir) {
    const recentDiskBaseline = await findRecentWorkspaceBaseline(appHomeDir, workspaceRoot, {
      excludeTabId: sessionTabId,
      liveTabIds,
      fsDeps: fsPromises,
    });
    if (recentDiskBaseline) {
      cacheSessionBaseline(sessionTabId, recentDiskBaseline);
      return { baseline: recentDiskBaseline, isFresh: false, anchored: false, dirtyChanged: true, primaryBranch, resumeKey };
    }
  }

  const { startedAt, anchored } = resolveSessionStartTime(curFlow);
  const baseline = buildFreshSessionBaseline(serviceResults, {
    workspaceRoot: normWs,
    startedAt,
    anchored,
  });
  cacheSessionBaseline(sessionTabId, baseline);
  return { baseline, isFresh: true, anchored, dirtyChanged: true, primaryBranch, resumeKey };
}

function location() {
  const space = (spaces() || []).find((s) => s.active) || null;
  const f = focused();
  const allPanes = panes() || [];
  const storedAgentTabs = readPlainObject(shared("cognivisor.spaceAgentTabs"));
  const sessionTabId = resolveSessionAgentTabId(space, allPanes, storedAgentTabs);
  const spaceTabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const spacePanes = allPanes.filter((p) => spaceTabs.has(p.tab));
  const focusedPane = f?.pane ? spacePanes.find((p) => p.pane === f.pane) : null;
  const pane =
    (focusedPane?.cwd ? focusedPane : null) ||
    (sessionTabId ? spacePanes.find((p) => p.tab === sessionTabId && p.cwd) : null) ||
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

async function loadServiceWorkingSnapshot(service, on, includeCommits = true) {
  return collectServiceWorkingSnapshot(service, on, includeCommits, { exec, fsPromises });
}

function readFlows() {
  return safeReadFlows();
}

function readAllActiveDiffs() {
  return readPlainObject(shared("changes-review.activeDiff"));
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
    hasHead: Boolean(f.hasHead),
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
    workingCount,
    aheadCount: Number(s.aheadCount) || 0,
    dirty: workingCount > 0,
  };
}

function buildCommitSummary(c) {
  if (!c) return null;
  return {
    hash: c.hash,
    shortHash: c.shortHash,
    subject: c.subject,
    author: c.author || "",
    date: c.date || "",
    repoRoot: c.repoRoot || "",
    serviceId: c.serviceId || ".",
    serviceName: c.serviceName || "root",
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
  const storedAgentTabs = readPlainObject(shared("cognivisor.spaceAgentTabs"));
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
    reviewedServices: {},
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
    this.allWorkingFiles = [];
    this.rows = [];
    this.diffWidth = 300;
    this.panelWidth = 420;
    this.viewerWidth = 900;
    this.diffViewportWidth = 0;
    this.handle = cx.focus_handle();
    this.bottomTab = "review"; // "review" | "commit"
    this.reviews = []; // Cached mirror of shared("cognivisor.reviewNotes")[sessionKey]
    this.activeComment = null; // { fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, snippet }
    this.commentText = "";
    this.sendingReview = false;
    this.busy = false;
    this.expandedFiles = new Set();
    this.localReviewedFiles = new Set();
    this.localReviewedMeta = {};
    this.lastRepoHeads = new Map();
    this.commitFilesCache = new Map();

    // Multi-repository & Git inspection state
    this.workspaceRoot = null;
    this.services = [];
    this.activeService = "all"; // "all" | service.id
    this.lastPublishedServicesSig = null;
    this.lastActiveServiceTs = 0;
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

    this.serviceFilterScroll = ScrollHandle.new();
    this.commitDropdownScroll = ScrollHandle.new();
    this.diffScroll = VirtualListScrollHandle.new();
    this.diffResizeTask = null;
    this._cachedCommitMenu = null;

    this.viewMode = "working"; // "working" | "commit"
    this.commits = [];
    this.allCommits = [];
    this.serviceCommitsMap = new Map();
    this.selectedCommit = null;
    this.showCommitMenu = false;
    this.workingFiles = [];
    this.workingFilesCount = 0;
    this.showAllWorkingChanges = false;
    this.hiddenPreExistingCount = 0;
    this.lastCandidateRoots = [];
    this.lastPrimaryBranch = "";

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
    try { this.pollTask?.cancel?.(); } catch {}
    this.pollTask = null;
    this.stopAllWatchers();
    try { this.input?.release(); } catch {}
    try { this.commentInput?.release(); } catch {}
    try { this.serviceFilterScroll?.release(); } catch {}
    try { this.commitDropdownScroll?.release(); } catch {}
    try { this.diffScroll?.release(); } catch {}
  }

  isViewerMode() {
    const p = props() || this.viewerProps;
    return p?.role === "viewer" || this.isViewer;
  }

  getSessionContext() {
    const vp = props() || this.viewerProps || {};
    const allSpaces = spaces() || [];
    const allPanes = panes() || [];
    const storedAgentTabs = readPlainObject(shared("cognivisor.spaceAgentTabs"));

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
    const prev = readPlainObject(shared("cognivisor.spaceAgentTabs"));
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
      const sharedActive = shared("cognivisor.activeService");
      let changed = false;

      if (sharedActive && normPathStr(sharedActive.workspaceRoot) === normPathStr(this.workspaceRoot) && typeof sharedActive.ts === "number") {
        if (!this.lastActiveServiceTs || sharedActive.ts > this.lastActiveServiceTs) {
          this.lastActiveServiceTs = sharedActive.ts;
          if (sharedActive.serviceId && (sharedActive.serviceId === "all" || this.services.some((s) => s.id === sharedActive.serviceId))) {
            if (this.activeService !== sharedActive.serviceId) {
              this.activeService = sharedActive.serviceId;
              this.applyServiceFilter(null, { broadcast: false, syncReviewTab: false });
              changed = true;
            }
          }
        }
      }

      if (revTab && diff && diff.sourceTabId === ctx.sourceTabId) {
        if (diff.activeService && diff.activeService !== this.activeService && (diff.activeService === "all" || this.services.some((s) => s.id === diff.activeService))) {
          this.activeService = diff.activeService;
          this.applyServiceFilter(null, { broadcast: false, syncReviewTab: false });
          changed = true;
        }
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
    const allNotes = readPlainObject(shared("cognivisor.reviewNotes"));
    const list = allNotes[c.notesKey];
    return Array.isArray(list) ? list : [];
  }

  saveSessionReviews(nextReviews, ctx = null) {
    const c = ctx || this.getSessionContext();
    const prevAll = readPlainObject(shared("cognivisor.reviewNotes"));
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
      (this.allWorkingFiles || []).find((f) => f.key === k) ||
      (Array.isArray(fallbackFiles) ? fallbackFiles.find((f) => f.key === k) : null);
    return found ? buildFileDescriptor(found) : null;
  }

  buildActiveDiffPayload(file, overrides = {}) {
    const ctx = this.getSessionContext();
    const prev = readActiveDiff(ctx.spaceId);
    const viewMode = overrides.viewMode ?? this.viewMode ?? prev?.viewMode ?? "working";
    const rawFiles = overrides.files ?? (this.isViewerMode() ? (prev?.files || []) : this.files);
    const rawAllFiles = overrides.allFiles ?? (this.isViewerMode() ? (prev?.allFiles || prev?.files || []) : (viewMode === "working" ? this.allWorkingFiles : rawFiles));
    const rawServices = overrides.services ?? (this.isViewerMode() ? (prev?.services || []) : this.services);
    const selectedCommit = overrides.selectedCommit !== undefined
      ? overrides.selectedCommit
      : (viewMode === "commit" ? (this.selectedCommit ? buildCommitSummary(this.selectedCommit) : prev?.selectedCommit || null) : null);
    const activeService = overrides.activeService ?? (this.isViewerMode() ? (prev?.activeService || "all") : this.activeService);
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
      viewMode,
      selectedCommit,
      activeService,
      openFileKey: openFileDesc ? openFileDesc.key : null,
      openFile: openFileDesc,
      files: (rawFiles || []).map(buildFileDescriptor).filter(Boolean),
      allFiles: (rawAllFiles || []).map(buildFileDescriptor).filter(Boolean),
      services: (rawServices || []).map(buildServiceSummary).filter(Boolean),
      requestSeq: nextSeq,
      focusLine: overrides.focusLine !== undefined ? overrides.focusLine : null,
      openCommentLine: overrides.openCommentLine !== undefined ? overrides.openCommentLine : null,
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
      openCommentLine: opts.openCommentLine ?? null,
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

  getComment(fileKey, line, ctx = null) {
    const reviews = this.getSessionReviews(ctx);
    return reviews.find((r) => (r.fileKey === fileKey || r.file === fileKey) && r.line === line);
  }

  openCommentEditor(file, line, snippet, initialText) {
    const text = initialText ?? "";
    const diff = this.isViewerMode() ? readActiveDiff(this.getSessionContext().spaceId) : null;
    const fallbackKey = file?.key || diff?.openFileKey || this.open;
    this.activeComment = {
      fileKey: fallbackKey,
      serviceId: file?.serviceId || "",
      serviceName: file?.serviceName || "",
      repoRoot: file?.repoRoot || this.root || "",
      file: file?.path || fallbackKey,
      displayPath: file?.displayPath || file?.path || fallbackKey,
      line,
      snippet: (snippet || "").trim(),
    };
    this.commentText = text;
    this.commentInput.set_value(text);
    this.commentInput.set_selected_range({ start: text.length, end: text.length });
    this.commentInput.focus();
  }

  startComment(fileKey, line, snippet, cx) {
    if (this.activeComment && this.activeComment.fileKey === fileKey && this.activeComment.line === line) {
      this.commentInput.focus();
      return;
    }
    const ctx = this.getSessionContext();
    const diff = this.isViewerMode() ? readActiveDiff(ctx.spaceId) : null;
    const file =
      (diff?.openFile?.key === fileKey ? diff.openFile : null) ||
      (diff?.files || []).find((f) => f.key === fileKey) ||
      (this.files || []).find((f) => f.key === fileKey) ||
      (this.allWorkingFiles || []).find((f) => f.key === fileKey);
    const existing = this.getComment(fileKey, line, ctx);
    this.openCommentEditor(file, line, snippet, existing ? existing.text : "");
    cx.notify();
  }

  syncServiceNoteStatus(serviceId, hasNotes, ctx = null) {
    if (!serviceId) return;
    const c = ctx || this.getSessionContext();
    if (!c.sourceTabId) return;
    const flows = readFlows();
    const flow = flows[c.sourceTabId];
    const currentStatus = flow?.reviewedServices?.[serviceId]?.status;
    const diff = this.isViewerMode() ? readActiveDiff(c.spaceId) : null;
    const servicesList = (diff?.services?.length ? diff.services : this.services) || [];
    const svc = servicesList.find((s) => s.id === serviceId);
    const branch = svc?.branch || "";

    if (hasNotes && currentStatus !== "has_notes") {
      updateTabFlow(
        c.sourceTabId,
        (prev) => ({
          reviewedServices: {
            ...(prev.reviewedServices || {}),
            [serviceId]: { status: "has_notes", branch, updatedAt: Date.now() },
          },
        }),
        c.workspaceRoot,
      );
    } else if (!hasNotes && currentStatus && currentStatus !== "pending") {
      updateTabFlow(
        c.sourceTabId,
        (prev) => ({
          reviewedServices: {
            ...(prev.reviewedServices || {}),
            [serviceId]: { status: "pending", branch, updatedAt: Date.now() },
          },
        }),
        c.workspaceRoot,
      );
    }
  }

  saveActiveComment(cx) {
    if (!this.activeComment) return;
    const ctx = this.getSessionContext();
    const curReviews = this.getSessionReviews(ctx);
    const raw = (this.commentInput.value() ?? "").replace(/\r\n/g, "\n");
    const text = raw.trim();
    const { fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, snippet } = this.activeComment;
    const activeDiff = this.isViewerMode() ? readActiveDiff(ctx.spaceId) : null;
    const noteViewMode = this.isViewerMode() ? (activeDiff?.viewMode || "working") : (this.viewMode || "working");
    const noteCommitHash = noteViewMode === "commit"
      ? (this.isViewerMode() ? (activeDiff?.selectedCommit?.hash || null) : (this.selectedCommit?.hash || null))
      : null;
    let nextReviews;
    if (text) {
      const idx = curReviews.findIndex((r) => (r.fileKey === fileKey || r.file === fileKey) && r.line === line);
      const item = {
        fileKey,
        serviceId,
        serviceName,
        repoRoot,
        file,
        displayPath,
        line,
        text,
        snippet,
        viewMode: noteViewMode,
        commitHash: noteCommitHash,
      };
      if (idx >= 0) {
        nextReviews = curReviews.map((r, i) => (i === idx ? item : r));
      } else {
        nextReviews = [...curReviews, item];
      }
    } else {
      nextReviews = curReviews.filter((r) => !((r.fileKey === fileKey || r.file === fileKey) && r.line === line));
    }
    this.saveSessionReviews(nextReviews, ctx);
    if (serviceId) {
      this.syncServiceNoteStatus(serviceId, nextReviews.some((r) => r.serviceId === serviceId), ctx);
    }
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  cancelActiveComment(cx) {
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  removeComment(fileKey, line, cx) {
    const ctx = this.getSessionContext();
    const curReviews = this.getSessionReviews(ctx);
    const removed = curReviews.filter((r) => (r.fileKey === fileKey || r.file === fileKey) && r.line === line);
    const nextReviews = curReviews.filter((r) => !((r.fileKey === fileKey || r.file === fileKey) && r.line === line));
    this.saveSessionReviews(nextReviews, ctx);
    for (const r of removed) {
      if (r.serviceId) {
        this.syncServiceNoteStatus(r.serviceId, nextReviews.some((item) => item.serviceId === r.serviceId), ctx);
      }
    }
    if (this.activeComment && this.activeComment.fileKey === fileKey && this.activeComment.line === line) {
      this.cancelActiveComment(cx);
    } else {
      cx.notify();
    }
  }

  clearComments(cx) {
    const ctx = this.getSessionContext();
    const curReviews = this.getSessionReviews(ctx);
    const affectedServices = Array.from(new Set(curReviews.map((r) => r.serviceId).filter(Boolean)));
    this.saveSessionReviews([], ctx);
    for (const sId of affectedServices) {
      this.syncServiceNoteStatus(sId, false, ctx);
    }
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  jumpToComment(comment, cx) {
    this.recordActiveTerminalTabNow();
    const ctx = this.getSessionContext();
    const latest = this.getComment(comment.fileKey || comment.file, comment.line, ctx) || comment;
    this.bottomTab = "review";

    const targetKey = latest.fileKey || latest.file;
    const targetMode = latest.viewMode || "working";
    if (targetMode === "working" && this.viewMode !== "working") {
      this.viewMode = "working";
      this.selectedCommit = null;
    } else if (targetMode === "commit" && latest.commitHash && (this.viewMode !== "commit" || this.selectedCommit?.hash !== latest.commitHash)) {
      const matchedCommit = (this.allCommits || this.commits || []).find((c) => c.hash === latest.commitHash) || null;
      if (matchedCommit) {
        this.viewMode = "commit";
        this.selectedCommit = matchedCommit;
      }
    }

    if (latest.serviceId && this.activeService !== "all" && this.activeService !== latest.serviceId) {
      this.activeService = latest.serviceId;
      const now = Date.now();
      this.lastActiveServiceTs = now;
      if (this.workspaceRoot) {
        setShared("cognivisor.activeService", {
          workspaceRoot: this.workspaceRoot,
          serviceId: this.activeService,
          ts: now,
        });
      }
      this.applyServiceFilter(null, { broadcast: false, syncReviewTab: false });
    } else {
      this.applyServiceFilter(null, { broadcast: false, syncReviewTab: false });
    }

    const targetFile = this.resolveFileDescriptor(targetKey) || buildFileDescriptor({
      key: targetKey,
      path: latest.file || targetKey,
      displayPath: latest.displayPath || latest.file || targetKey,
      repoRoot: latest.repoRoot || this.root || "",
      serviceId: latest.serviceId || "",
      serviceName: latest.serviceName || "",
      status: "M",
      hasHead: true,
      fresh: false,
      add: 0,
      del: 0,
    });
    this.open = targetFile?.key || targetKey;
    this.closed = false;
    this.panelNote = null;
    this.openReviewTabForFile(targetFile, {
      create: true,
      select: true,
      bumpSeq: true,
      focusLine: latest.line,
      openCommentLine: latest.line,
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

  async sendReview(cx) {
    const ctx = this.getSessionContext();
    const sessionReviews = this.getSessionReviews(ctx);
    if (this.sendingReview || sessionReviews.length === 0) return;
    const agent = this.findActiveAgent();
    if (!agent) {
      this.panelNote = "No active agent found to send review notes to.";
      cx.notify();
      return;
    }
    this.sendingReview = true;
    this.panelNote = null;
    cx.notify();

    try {
      const diff = this.isViewerMode() ? readActiveDiff(ctx.spaceId) : null;
      const curViewMode = diff?.viewMode || this.viewMode;
      const curCommit = diff?.selectedCommit || this.selectedCommit;
      let header = "Review comments on uncommitted changes:";
      if (curViewMode === "commit" && curCommit) {
        header = `Review comments on commit ${curCommit.shortHash} ("${curCommit.subject}"):`;
      }
      const parts = [
        header,
        "",
      ];

      const byService = new Map();
      for (const r of sessionReviews) {
        const sId = r.serviceId || "default";
        if (!byService.has(sId)) byService.set(sId, []);
        byService.get(sId).push(r);
      }

      for (const [sId, revs] of byService) {
        const sName = revs[0].serviceName || sId;
        const sRoot = revs[0].repoRoot || ctx.workspaceRoot || this.root;
        parts.push(`### Service: ${sName} (${sRoot})`, "");
        for (const r of revs) {
          const filePath = r.displayPath || r.file;
          parts.push(`- \`${filePath}:${r.line}\`:`);
          for (const line of String(r.text || "").split(/\r?\n/)) {
            parts.push(`  ${line}`);
          }
          if (r.snippet) {
            parts.push(`  > ${r.snippet}`);
          }
          parts.push("");
        }
      }

      const message = parts.join("\n");
      const r = await hc(["send", agent.address, message]);
      if (r.code !== 0) {
        throw new Error(r.stderr || r.stdout || "Failed to send review to agent");
      }
      notify({ title: "Review notes sent to agent", level: "success" });
      this.clearComments(cx);
    } catch (e) {
      this.panelNote = `Failed to send review: ${e.message || e}`;
    } finally {
      this.sendingReview = false;
      cx.notify();
    }
  }

  getSortedServices(servicesList = null) {
    return sortServicesDirtyFirst(servicesList ?? this.services ?? []);
  }

  getServiceReviewStatus(serviceId, flow, reviewsOverride = null, workingFilesOverride = null) {
    if (!serviceId) return "pending";
    const reviews = reviewsOverride ?? this.getSessionReviews();
    if (reviews.some((r) => r.serviceId === serviceId)) return "has_notes";
    let workingFiles;
    if (Array.isArray(workingFilesOverride)) {
      workingFiles = workingFilesOverride;
    } else if (this.isViewerMode()) {
      const diff = readActiveDiff(this.getSessionContext().spaceId);
      workingFiles = diff?.viewMode === "working" ? (diff?.allFiles || diff?.files || []) : [];
    } else {
      workingFiles = this.allWorkingFiles || [];
    }
    const svcFiles = workingFiles.filter((f) => f && f.serviceId === serviceId);
    if (svcFiles.length > 0 && svcFiles.every((f) => this.isFileReviewed(f, flow, "working"))) {
      return "approved";
    }
    return "pending";
  }

  fileReviewScope(viewModeOverride = null, commitOverride = null) {
    const vm = viewModeOverride ?? this.viewMode;
    const cm = commitOverride !== undefined ? commitOverride : this.selectedCommit;
    if (vm === "commit" && cm?.hash) {
      return `commit:${cm.hash}`;
    }
    return "working";
  }

  fileReviewKey(file, scopeOverride = null) {
    const fileKey = typeof file === "string" ? file : file?.key;
    if (!fileKey) return null;
    const scope = scopeOverride ?? this.fileReviewScope();
    return `${scope}::${fileKey}`;
  }

  isFileReviewed(file, flow, scopeOverride = null) {
    const rk = this.fileReviewKey(file, scopeOverride);
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

  applyFileReviewToggle(fileObj, fileKey, scope, ctx) {
    const rk = this.fileReviewKey(fileKey, scope);
    if (!rk || !fileKey) return { nextReviewed: false, updatedFlow: null };

    const flows = readFlows();
    const curFlow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    const nextReviewed = !this.isFileReviewed(fileKey, curFlow, scope);
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

  toggleFileReviewed(file, cx, _advanceToNext = false, scopeOverride = null) {
    const fileKey = typeof file === "string" ? file : file?.key;
    const scope = scopeOverride ?? this.fileReviewScope();
    const rk = this.fileReviewKey(fileKey, scope);
    if (!rk || !fileKey) return;

    const fileObj = typeof file === "object" && file ? file : this.resolveFileDescriptor(fileKey);
    const ctx = this.getSessionContext();
    this.applyFileReviewToggle(fileObj, fileKey, scope, ctx);
    cx.notify();
  }

  clearCommittedReviewedFiles(serviceIds) {
    if (!Array.isArray(serviceIds) || serviceIds.length === 0) return;
    const prefixes = serviceIds.map((id) => `working::${id}::`);
    for (const rk of [...this.localReviewedFiles]) {
      if (prefixes.some((p) => rk.startsWith(p))) {
        this.localReviewedFiles.delete(rk);
      }
    }
    for (const rk of Object.keys(this.localReviewedMeta || {})) {
      if (prefixes.some((p) => rk.startsWith(p))) {
        delete this.localReviewedMeta[rk];
      }
    }
    const ctx = this.getSessionContext();
    if (!ctx.sourceTabId) return;
    updateTabFlow(
      ctx.sourceTabId,
      (prev) => {
        const prevMap = prev.reviewedFiles || {};
        const nextMap = {};
        let changed = false;
        for (const [k, v] of Object.entries(prevMap)) {
          if (prefixes.some((p) => k.startsWith(p))) {
            changed = true;
          } else {
            nextMap[k] = v;
          }
        }
        return changed ? { reviewedFiles: nextMap } : null;
      },
      ctx.workspaceRoot,
    );
  }

  selectService(serviceId, cx, opts = {}) {
    if (this.activeService === serviceId && !opts.force) return;
    this.activeService = serviceId;
    const now = Date.now();
    this.lastActiveServiceTs = now;
    if (this.workspaceRoot && opts.broadcast !== false) {
      setShared("cognivisor.activeService", {
        workspaceRoot: this.workspaceRoot,
        serviceId: this.activeService,
        ts: now,
      });
    }
    if (this.viewMode === "commit" && this.selectedCommit) {
      if (this.activeService !== "all" && this.selectedCommit.serviceId !== this.activeService) {
        this.switchMode("working", null, cx);
        return;
      }
    }
    this.applyServiceFilter(cx, {
      preferUnreviewed: opts.preferUnreviewed !== false,
      syncReviewTab: opts.syncReviewTab !== false,
      selectTab: Boolean(opts.selectTab),
    });
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
    const scope = this.fileReviewScope();
    return (
      pickNextUnreviewedFile(files, null, (f) => this.isFileReviewed(f, flow, scope)) ||
      files[0] ||
      null
    );
  }

  applyServiceFilter(cx, opts = {}) {
    if (this.viewMode === "working") {
      if (this.activeService === "all") {
        this.files = this.allWorkingFiles;
      } else {
        this.files = this.allWorkingFiles.filter((f) => f.serviceId === this.activeService);
      }

      const shouldPickNew = Boolean(opts.preferUnreviewed) || !this.open || !this.files.some((f) => f.key === this.open);
      if (shouldPickNew) {
        const nextFile = this.pickPreferredFileForCurrentList(Boolean(opts.preferUnreviewed));
        this.open = nextFile ? nextFile.key : null;
        this.closed = !this.open;
        if (opts.syncReviewTab !== false) {
          this.openReviewTabForFile(nextFile, {
            create: false,
            select: Boolean(opts.selectTab),
            bumpSeq: true,
          });
        }
      } else if (opts.syncReviewTab === true) {
        const curFile = this.files.find((f) => f.key === this.open) || null;
        this.openReviewTabForFile(curFile, {
          create: false,
          select: Boolean(opts.selectTab),
          bumpSeq: false,
        });
      }
    }

    if (this.activeService === "all") {
      this.commits = this.allCommits.slice(0, 30);
    } else {
      this.commits = (this.serviceCommitsMap.get(this.activeService) || []).slice(0, 30);
    }

    if (cx) cx.notify();
  }

  switchMode(mode, target, cx) {
    this.showCommitMenu = false;
    this.viewMode = mode;
    this.panelNote = null;
    this.error = null;

    if (mode === "working") {
      this.selectedCommit = null;
      this.files = this.activeService === "all"
        ? (this.allWorkingFiles || [])
        : (this.allWorkingFiles || []).filter((f) => f.serviceId === this.activeService);
      const nextFile = this.pickPreferredFileForCurrentList(true);
      this.open = nextFile ? nextFile.key : null;
      this.closed = !this.open;
      this.openReviewTabForFile(nextFile, { create: false, select: false, bumpSeq: true });
      cx.notify();
      return;
    }

    if (mode === "commit" && target) {
      this.selectedCommit = target;
      this.loadCommitFiles(target, cx);
      return;
    }

    cx.notify();
  }

  loadCommitFiles(target, cx) {
    let c = target;
    if (typeof target === "string") {
      c = this.commits.find((x) => x.hash === target) || {
        hash: target,
        repoRoot: this.services[0]?.root || this.root,
        serviceId: this.services[0]?.id || ".",
        serviceName: this.services[0]?.name || "root",
      };
    }
    const hash = c?.hash, repoRoot = c?.repoRoot, serviceId = c?.serviceId, serviceName = c?.serviceName;
    const on = this.on, context = this.context;
    if (!repoRoot || !hash) return;
    this.loading = true;
    this.files = [];
    this.open = null;
    this.expandedFiles.clear();
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: repoRoot, on });
        const numResult = await git(["diff-tree", "-r", "--no-commit-id", "--root", "--no-renames", "--numstat", "-z", hash]);
        const statResult = await git(["diff-tree", "-r", "--no-commit-id", "--root", "--no-renames", "--name-status", "-z", hash]);
        if (numResult.code !== 0) throw new Error(numResult.stderr || "Failed to load commit stats");

        const stats = {};
        for (const entry of (numResult.stdout || "").split("\0")) {
          const [a, d, ...parts] = entry.split("\t");
          if (!parts.length) continue;
          const path = parts.join("\t");
          stats[path] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
        }

        const service = (this.services || []).find((s) => s.id === serviceId);
        const relPrefix = service?.relPath || "";
        const files = [];
        const statEntries = (statResult.stdout || "").split("\0").filter(Boolean);
        for (let i = 0; i < statEntries.length; i += 2) {
          const status = statEntries[i]?.charAt(0) || "M";
          const path = statEntries[i + 1];
          if (!path) continue;
          const stat = stats[path] ?? { add: 0, del: 0 };
          const fileKey = `${serviceId}::${path}`;
          const displayPath = relPrefix ? `${relPrefix}/${path}` : path;
          files.push({
            key: fileKey,
            serviceId,
            serviceName: serviceName || service?.name || "root",
            relPrefix,
            repoRoot,
            hasHead: true,
            path,
            displayPath,
            status,
            fresh: false,
            ...stat,
          });
        }

        if (key() !== context) return;
        this.files = files;
        const firstFile = this.pickPreferredFileForCurrentList(true);
        this.open = firstFile ? firstFile.key : null;
        this.openReviewTabForFile(firstFile, { create: false, select: false, bumpSeq: true });
      } catch (e) {
        this.logger?.error("review.loadCommitFilesFailed", e, {
          workspaceRoot: this.workspaceRoot,
          viewMode: this.viewMode,
        }, cx);
        if (key() === context) this.error = String(e.message || e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  getTargetRepos() {
    if (!this.services || this.services.length === 0) return [];
    if (this.activeService === "all") {
      return this.services.filter((s) => (s.workingCount || 0) > 0);
    }
    const s = this.services.find((s) => s.id === this.activeService);
    if (s && (s.workingCount || 0) > 0) return [s];
    return s ? [s] : [];
  }

  commit(cx) {
    const targetRepos = this.getTargetRepos();
    if (!this.message.trim() || targetRepos.length === 0 || this.busy || this.loading || this.context !== key()) return;
    const on = this.on, context = this.context, message = this.message.trim();
    this.busy = true;
    this.panelNote = null;
    cx.spawn(async (cx) => {
      const errors = [];
      const committedIds = [];
      try {
        for (const repo of targetRepos) {
          const root = repo.root;
          let repoOk = true;
          for (const args of [["add", "-A"], ["commit", "-m", message]]) {
            const r = await exec("git", args, { cwd: root, on });
            if (r.code !== 0) {
              errors.push(`[${repo.name}]: ${(r.stderr || r.stdout).trim()}`);
              repoOk = false;
              break;
            }
          }
          if (repoOk && repo.id) committedIds.push(repo.id);
        }
        if (committedIds.length > 0) {
          this.clearCommittedReviewedFiles(committedIds);
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
    const desired = new Map();
    for (const s of services) {
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
    const curBaseline = SESSION_BASELINE_CACHE.get(sessionTabId) || flows[sessionTabId]?.sessionBaseline || null;
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
    mergeSessionBaselineIntoFlow(sessionTabId, nextBaseline, null, true);
    this.showAllWorkingChanges = false;
    this.hiddenPreExistingCount = 0;
    const appHomeDir = getSafeAppHome();
    const workspaceRoot = this.workspaceRoot;
    const primaryBranch = this.lastPrimaryBranch || "";
    cx.spawn(async (cx) => {
      if (appHomeDir) {
        await writeDiskSessionBaseline(appHomeDir, sessionTabId, workspaceRoot, primaryBranch, nextBaseline, "", fsPromises);
      }
      try {
        notify({ title: "Session baseline reset", body: "All current working changes are now included in this session.", level: "info" });
      } catch {}
      this.refresh(cx, { force: true });
    });
    cx.notify();
  }

  refresh(cx, opts = {}) {
    if (this.isViewerMode() || this.loading || this.busy) return;
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
      this.allWorkingFiles = [];
      this.serviceCommitsMap.clear();
      this.allCommits = [];
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
      this.closed = false;
      this.limited = false;
      this.expandedFiles.clear();
      this.localReviewedFiles.clear();
      this.localReviewedMeta = {};
      this.lastRepoHeads.clear();
      this.viewMode = "working";
      this.showCommitMenu = false;
      this.selectedCommit = null;
      this.workingFiles = [];
      this.workingFilesCount = 0;
      this.showAllWorkingChanges = false;
      this.hiddenPreExistingCount = 0;
      this.lastCandidateRoots = [];
      this.lastPrimaryBranch = "";
    }

    this.isWindows = !on && this.hostIsWindows;

    if (!workspaceRoot) {
      this.error = "No folder";
      return;
    }

    this.hasLoadedOnce = true;
    const { activeSpace, sessionTabId } = getActiveSpaceAndTab();
    const normWs = normPathStr(workspaceRoot);
    const bus = !force ? shared("cognivisor.services") : null;
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
      normPathStr(bus.workspaceRoot) === normWs &&
      (bus.tabId || null) === (sessionTabId || null) &&
      (bus.on || null) === (on || null) &&
      Array.isArray(bus.services)
    );

    if (busFresh && Array.isArray(bus.candidates) && bus.candidates.length === 0) {
      this.workspaceRoot = workspaceRoot;
      this.services = [];
      this.root = workspaceRoot;
      this.allWorkingFiles = [];
      this.workingFiles = [];
      this.workingFilesCount = 0;
      this.allCommits = [];
      this.serviceCommitsMap.clear();
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
          this.allWorkingFiles = [];
          this.files = [];
          this.open = null;
          this.stopAllWatchers();
          this.error = "Not a git repository";
          return;
        }

        const serviceResults = [];
        const SNAPSHOT_CONCURRENCY = 4;
        for (let i = 0; i < candidateServices.length; i += SNAPSHOT_CONCURRENCY) {
          const batch = candidateServices.slice(i, i + SNAPSHOT_CONCURRENCY);
          const batchRes = await Promise.all(
            batch.map((service) => loadServiceWorkingSnapshot(service, on, true))
          );
          if (key() !== context) return;
          for (const item of batchRes) serviceResults.push(item);
        }

        const erroredServiceIds = new Set();
        const headTransitions = [];
        const prevHeadsByServiceId = new Map();
        const nextRepoHeads = [];
        const persistedHeads = sessionTabId ? readPlainObject(readFlows()?.[sessionTabId]?.repoHeads) : {};

        for (const res of serviceResults) {
          const svcId = res.service?.id;
          if (res.error) {
            if (svcId) erroredServiceIds.add(svcId);
            continue;
          }
          const normRoot = normPathStr(res.service?.root);
          const newHead = String(res.headHash || "").trim();
          const persistedPrevHead = normRoot && typeof persistedHeads[normRoot] === "string"
            ? persistedHeads[normRoot]
            : "";
          const prevHead = normRoot ? (this.lastRepoHeads.get(normRoot) || persistedPrevHead) : "";
          if (svcId) prevHeadsByServiceId.set(svcId, prevHead);
          if (prevHead && newHead && prevHead !== newHead) {
            headTransitions.push({ service: res.service, prevHead, newHead });
          }
          if (normRoot && newHead) {
            nextRepoHeads.push([normRoot, newHead]);
          }
        }

        const committedFileKeys = new Set();
        if (headTransitions.length > 0) {
          await Promise.all(
            headTransitions.map(async ({ service, prevHead, newHead }) => {
              let r = await exec(
                "git",
                [...READ, "diff", "--name-only", "--no-renames", prevHead, newHead],
                { cwd: service.root, on },
              ).catch(() => null);
              if (!r || r.code !== 0) {
                r = await exec(
                  "git",
                  [...READ, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--no-renames", newHead],
                  { cwd: service.root, on },
                ).catch(() => null);
              }
              if (r && r.code === 0 && r.stdout) {
                for (const line of r.stdout.split(/\r?\n/)) {
                  const p = line.trim();
                  if (p) committedFileKeys.add(`${service.id}::${p}`);
                }
              }
            })
          );
          if (key() !== context) return;
        }

        const nextRepoHeadsObj = { ...persistedHeads };
        let headsChanged = false;
        for (const [normRoot, newHead] of nextRepoHeads) {
          this.lastRepoHeads.set(normRoot, newHead);
          if (nextRepoHeadsObj[normRoot] !== newHead) {
            nextRepoHeadsObj[normRoot] = newHead;
            headsChanged = true;
          }
        }

        const baselineInit = sessionTabId
          ? await resolveOrInitSessionBaseline(sessionTabId, serviceResults, tabTermAddrs, workspaceRoot)
          : { baseline: null, isFresh: false, dirtyChanged: false, primaryBranch: "" };
        if (key() !== context) return;

        const sessionBaseline = baselineInit.baseline;
        let baselineDirtyChanged = Boolean(baselineInit.dirtyChanged);
        let touchedResults = [];
        let totalHiddenPreExisting = 0;
        this.lastCandidateRoots = candidateServices.map((s) => normPathStr(s?.root)).filter(Boolean);
        this.lastPrimaryBranch = baselineInit.primaryBranch || "";

        if (sessionTabId && sessionBaseline) {
          const startedAt = sessionBaseline.startedAt || 0;
          const flowsNow = safeReadFlows();
          const curFlowNow = readPlainObject(flowsNow[sessionTabId]);
          const prevSessionRepos = new Set(
            Array.isArray(curFlowNow.sessionRepos) ? curFlowNow.sessionRepos.map((r) => normPathStr(r)).filter(Boolean) : []
          );
          const normPaneCwds = tabPaneCwds.map((c) => normPathStr(c)).filter(Boolean);

          const unbaselinedNeedTranscript = [];
          if (!baselineInit.isFresh) {
            for (const res of serviceResults) {
              const normRoot = normPathStr(res.service?.root);
              if (!normRoot || sessionBaseline.repos?.[normRoot]) continue;
              const inPaneCwd = normPaneCwds.some((c) => c === normRoot || c.startsWith(normRoot + "/"));
              if (!prevSessionRepos.has(normRoot) && !inPaneCwd && (res.files || []).some((f) => !Number(f?.mtimeMs || 0))) {
                unbaselinedNeedTranscript.push(res);
              }
            }
          }
          let unbaselinedTranscript = "";
          if (unbaselinedNeedTranscript.length > 0 && tabTermAddrs.length > 0) {
            const unattrSig = "unbaselined::" + unbaselinedNeedTranscript.map((r) => r.service?.root || "").sort().join("|") + "::" + tabTermAddrs.join(",");
            const nowTs = Date.now();
            if (this.lastTranscriptScan && this.lastTranscriptScan.sig === unattrSig && (nowTs - this.lastTranscriptScan.ts) < TRANSCRIPT_THROTTLE_MS) {
              unbaselinedTranscript = this.lastTranscriptScan.text;
            } else {
              const reads = await Promise.all(
                tabTermAddrs.map((addr) => hc(["read", "--lines", "150", addr]).catch(() => ""))
              );
              if (key() !== context) return;
              unbaselinedTranscript = reads.filter(Boolean).join("\n").replace(/\\/g, "/");
              this.lastTranscriptScan = { sig: unattrSig, ts: nowTs, text: unbaselinedTranscript };
            }
          }

          for (const res of serviceResults) {
            const normRoot = normPathStr(res.service?.root);
            const baselineRepo = normRoot ? (sessionBaseline.repos?.[normRoot] || null) : null;
            const rawWorkingFiles = Array.isArray(res.files) ? res.files : [];
            const sessionCommits = filterSessionCommits(res.commits, startedAt);
            let sessionFiles = [];
            let hiddenCount = 0;
            if (baselineRepo) {
              const partitioned = partitionSessionWorkingEntries(rawWorkingFiles, baselineRepo, startedAt);
              sessionFiles = partitioned.visible;
              hiddenCount = partitioned.hidden.length;
            } else {
              const inPaneCwd = normRoot && normPaneCwds.some((c) => c === normRoot || c.startsWith(normRoot + "/"));
              const isAttributed = Boolean(
                normRoot && (prevSessionRepos.has(normRoot) || inPaneCwd || repoMatchesTranscript(res.service, rawWorkingFiles, unbaselinedTranscript))
              );
              const unbaselinedRes = filterUnbaselinedRepoEntries(rawWorkingFiles, startedAt, {
                isAttributed,
                hasSessionCommits: sessionCommits.length > 0,
              });
              sessionFiles = unbaselinedRes.sessionFiles;
              hiddenCount = Math.max(0, rawWorkingFiles.length - sessionFiles.length);
              if (normRoot) {
                sessionBaseline.repos[normRoot] = { dirtyFiles: unbaselinedRes.backfillDirtyFiles };
                baselineDirtyChanged = true;
              }
            }
            totalHiddenPreExisting += hiddenCount;
            const displayFiles = this.showAllWorkingChanges ? rawWorkingFiles : sessionFiles;
            res.files = displayFiles;
            res.commits = sessionCommits;
            if (res.service) {
              res.service.workingCount = displayFiles.length;
              res.service.sessionCommitCount = sessionCommits.length;
            }
            res.touched = displayFiles.length > 0 || sessionCommits.length > 0;
          }

          this.hiddenPreExistingCount = totalHiddenPreExisting;
          touchedResults = serviceResults.filter((r) => r.touched);
          const sessionRepos = touchedResults.map((r) => normPathStr(r.service?.root)).filter(Boolean);
          mergeSessionBaselineIntoFlow(sessionTabId, sessionBaseline, sessionRepos);
          const appHomeDir = getSafeAppHome();
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
          }
        } else {
          this.hiddenPreExistingCount = 0;
        }
        const services = touchedResults.map((r) => r.service);

        this.workspaceRoot = workspaceRoot;
        this.services = services;
        this.root = services[0]?.root || workspaceRoot;

        // Check external cognivisor.activeService
        const sharedActive = shared("cognivisor.activeService");
        if (sharedActive && normPathStr(sharedActive.workspaceRoot) === normWs && typeof sharedActive.ts === "number") {
          if (!this.lastActiveServiceTs || sharedActive.ts > this.lastActiveServiceTs) {
            this.lastActiveServiceTs = sharedActive.ts;
            if (sharedActive.serviceId && (sharedActive.serviceId === "all" || services.some((s) => s.id === sharedActive.serviceId))) {
              this.activeService = sharedActive.serviceId;
            }
          }
        }
        if (this.activeService !== "all" && !services.some((s) => s.id === this.activeService)) {
          this.activeService = "all";
        }

        const existingBus = shared("cognivisor.services");
        const sameBusWorkspace = Boolean(existingBus && normPathStr(existingBus.workspaceRoot) === normWs);
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
        const servicesSig = (sessionTabId || "") + "::" + normWs + "::" + nextCandidates.length + "::" + services.map((s) => `${normPathStr(s.root)}@${s.branch || ""}:${s.workingCount || 0}:${s.aheadCount || 0}`).join(",");
        const existingBusSig = existingBus && normPathStr(existingBus.workspaceRoot) === normWs && (existingBus.tabId || null) === (sessionTabId || null)
          ? (existingBus.sig || ((sessionTabId || "") + "::" + normWs + "::" + (existingBus.candidates?.length ?? -1) + "::" + (existingBus.services || []).map((s) => `${normPathStr(s.root)}@${s.branch || ""}:${s.workingCount || 0}:${s.aheadCount || 0}`).join(",")))
          : null;
        if ((!usingBusCandidates || force || servicesSig !== existingBusSig) && servicesSig !== this.lastPublishedServicesSig) {
          this.lastPublishedServicesSig = servicesSig;
          const pubTs = Date.now();
          this.lastConsumedBusTs = pubTs;
          this.lastConsumedBusSig = servicesSig;
          setShared("cognivisor.services", {
            tabId: sessionTabId || null,
            workspaceRoot,
            on,
            services: services.map((s) => ({
              id: s.id,
              name: s.name,
              relPath: s.relPath,
              root: s.root,
              isSibling: Boolean(s.isSibling),
              branch: s.branch || "",
              workingCount: s.workingCount || 0,
              aheadCount: s.aheadCount || 0,
              sessionCommitCount: Number(s.sessionCommitCount) || 0,
            })),
            candidates: nextCandidates,
            sig: servicesSig,
            ts: pubTs,
          });
        } else {
          this.lastPublishedServicesSig = servicesSig;
          if (existingBusSig) this.lastConsumedBusSig = existingBusSig;
        }

        const allFiles = [];
        const allCommits = [];
        this.serviceCommitsMap.clear();

        for (const res of touchedResults) {
          allFiles.push(...res.files);
          allCommits.push(...res.commits);
          this.serviceCommitsMap.set(res.service.id, res.commits);
        }

        allCommits.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        this.allCommits = allCommits;
        this.allWorkingFiles = allFiles;
        this.workingFiles = allFiles;
        this.workingFilesCount = allFiles.length;

        const snapshotReviewedFiles = sessionTabId
          ? (readFlows()?.[sessionTabId]?.reviewedFiles || {})
          : this.buildLocalReviewedSnapshot();
        const committedAfterByKey = await this.collectCommitInvalidations(
          snapshotReviewedFiles,
          allCommits,
          prevHeadsByServiceId,
          erroredServiceIds,
          on,
          committedFileKeys,
        );
        if (key() !== context) return;

        const latestReviewedFiles = sessionTabId
          ? (readFlows()?.[sessionTabId]?.reviewedFiles || {})
          : this.buildLocalReviewedSnapshot();
        const reconciled = reconcileReviewedFiles(latestReviewedFiles, {
          workingFiles: allFiles,
          committedFileKeys,
          committedAfterByKey,
          erroredServiceIds,
          scopeMode: "working",
        });

        if (sessionTabId) {
          if (reconciled.changed || headsChanged) {
            updateTabFlow(
              sessionTabId,
              () => {
                const patch = {};
                if (reconciled.changed) patch.reviewedFiles = reconciled.nextMap;
                if (headsChanged) patch.repoHeads = nextRepoHeadsObj;
                return patch;
              },
              workspaceRoot,
            );
          }
          this.syncLocalReviewedFromMap(reconciled.nextMap);
        } else if (reconciled.changed) {
          this.syncLocalReviewedFromMap(reconciled.nextMap);
        }

        this.watch(services, cx);
        this.applyServiceFilter(null, { preferUnreviewed: false, syncReviewTab: false });

        if (this.viewMode === "working") {
          this.limited = this.files.length > 1000;
          this.error = null;
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
                openCommentLine: fileChanged ? null : (curDiff?.openCommentLine ?? null),
              });
              writeActiveDiff(spaceId, payload);
              if (fileChanged) {
                run("tab.rename", { id: revTab.tabId, name: formatReviewTabTitle(openFile) });
              }
            }
          }
        }
      } catch (e) {
        this.logger?.error("review.refreshFailed", e, {
          workspaceRoot,
          viewMode: this.viewMode,
          showAllWorkingChanges: this.showAllWorkingChanges,
        }, cx);
        if (key() === context) this.error = String(e.message || e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async getCommitChangedFiles(commit, on) {
    if (!commit?.hash || !commit?.repoRoot) return [];
    const cacheKey = `${normPathStr(commit.repoRoot)}::${commit.hash}`;
    if (this.commitFilesCache.has(cacheKey)) {
      return this.commitFilesCache.get(cacheKey);
    }
    const r = await exec(
      "git",
      [...READ, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "--no-renames", commit.hash],
      { cwd: commit.repoRoot, on },
    ).catch(() => null);
    const paths = r && r.code === 0 && r.stdout
      ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
    if (this.commitFilesCache.size > 250) {
      this.commitFilesCache.clear();
    }
    this.commitFilesCache.set(cacheKey, paths);
    return paths;
  }

  async collectCommitInvalidations(snapshotReviewedFiles, allCommits, prevHeadsByServiceId, erroredServiceIds, on, committedFileKeys) {
    const committedAfterByKey = new Map();
    const entries = Object.entries(snapshotReviewedFiles || {});
    if (entries.length === 0 || !Array.isArray(allCommits) || allCommits.length === 0) {
      return committedAfterByKey;
    }

    const commitReviewsBySvc = new Map();
    const workingReviewedAtByKey = new Map();
    const workingSvcsCold = new Set();

    for (const [rk, rawVal] of entries) {
      const rec = parseReviewedFileRecord(rawVal);
      if (!rec) continue;
      if (rk.startsWith("commit:")) {
        const rest = rk.slice("commit:".length);
        const hashSep = rest.indexOf("::");
        if (hashSep <= 0) continue;
        const cHash = rest.slice(0, hashSep);
        const fileKey = rest.slice(hashSep + 2);
        const svcSep = fileKey.indexOf("::");
        const svcId = svcSep >= 0 ? fileKey.slice(0, svcSep) : "";
        if (!svcId || erroredServiceIds.has(svcId)) continue;
        if (!commitReviewsBySvc.has(svcId)) commitReviewsBySvc.set(svcId, []);
        commitReviewsBySvc.get(svcId).push({ hash: cHash, reviewedAt: rec.reviewedAt || 0 });
      } else if (rk.startsWith("working::")) {
        const fileKey = rk.slice("working::".length);
        const svcSep = fileKey.indexOf("::");
        const svcId = svcSep >= 0 ? fileKey.slice(0, svcSep) : "";
        if (!svcId || erroredServiceIds.has(svcId) || !rec.reviewedAt || prevHeadsByServiceId.get(svcId)) continue;
        workingSvcsCold.add(svcId);
        const prevTs = workingReviewedAtByKey.get(fileKey);
        if (prevTs === undefined || rec.reviewedAt < prevTs) {
          workingReviewedAtByKey.set(fileKey, rec.reviewedAt);
        }
      }
    }

    if (commitReviewsBySvc.size === 0 && workingSvcsCold.size === 0) {
      return committedAfterByKey;
    }

    const commitsByService = new Map();
    for (const c of allCommits) {
      if (!c?.serviceId || !c?.hash) continue;
      if (!commitReviewsBySvc.has(c.serviceId) && !workingSvcsCold.has(c.serviceId)) continue;
      if (!commitsByService.has(c.serviceId)) commitsByService.set(c.serviceId, []);
      commitsByService.get(c.serviceId).push(c);
    }

    const commitsToInspect = [];
    for (const [svcId, svcCommits] of commitsByService.entries()) {
      const commitReviews = commitReviewsBySvc.get(svcId) || [];
      let minWorkingTs = Infinity;
      if (workingSvcsCold.has(svcId)) {
        for (const [fk, ts] of workingReviewedAtByKey.entries()) {
          if (fk.startsWith(`${svcId}::`) && ts < minWorkingTs) {
            minWorkingTs = ts;
          }
        }
      }

      const hashToIdx = new Map();
      for (let i = 0; i < svcCommits.length; i++) {
        if (svcCommits[i]?.hash && !hashToIdx.has(svcCommits[i].hash)) {
          hashToIdx.set(svcCommits[i].hash, i);
        }
      }

      for (let idx = 0; idx < svcCommits.length; idx++) {
        const c = svcCommits[idx];
        const commitMs = (Number(c.timestamp) || 0) * 1000;
        const forCommitReview = commitReviews.some((entry) => {
          if (entry.hash === c.hash) return false;
          if (entry.reviewedAt > 0) return commitMs > entry.reviewedAt;
          const entryIdx = hashToIdx.get(entry.hash);
          return entryIdx !== undefined && idx < entryIdx;
        });
        const forWorkingReview = workingSvcsCold.has(svcId) && commitMs > minWorkingTs;
        if (forCommitReview || forWorkingReview) {
          commitsToInspect.push({ commit: c, commitMs, forCommitReview, forWorkingReview });
        }
      }
    }

    if (commitsToInspect.length === 0) return committedAfterByKey;

    const inspected = await Promise.all(
      commitsToInspect.map(async (item) => ({
        ...item,
        paths: await this.getCommitChangedFiles(item.commit, on),
      }))
    );

    for (const { commit, commitMs, forCommitReview, forWorkingReview, paths } of inspected) {
      for (const p of paths) {
        const fk = `${commit.serviceId}::${p}`;
        if (forCommitReview) {
          const prevTs = committedAfterByKey.get(fk) || 0;
          if (commitMs > prevTs) committedAfterByKey.set(fk, commitMs);
        }
        if (forWorkingReview) {
          const reviewedAt = workingReviewedAtByKey.get(fk);
          if (reviewedAt !== undefined && commitMs > reviewedAt) {
            committedFileKeys.add(fk);
          }
        }
      }
    }

    return committedAfterByKey;
  }

  async fetchFileDiffLines(file, viewMode, selectedCommit, on, isExpanded) {
    if (!file || !file.repoRoot) return ["No file selected"];
    const root = file.repoRoot;
    const path = file.path;
    let lines;

    if (viewMode === "working") {
      if (file.fresh || (!file.hasHead && file.status === "A")) {
        const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
        if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
        else if (text.includes("\0")) lines = ["Binary file · no text diff"];
        else {
          const lineTotal = countLines(text);
          lines = [`@@ -0,0 +1,${lineTotal} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 450).map((l) => `+${l}`)];
        }
      } else {
        const diffArgs = ["diff", ...(file.hasHead ? ["HEAD"] : []), ...(isExpanded ? ["-U99999"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
        const r = await exec("git", [...READ, ...diffArgs], { cwd: root, on });
        if (r.code !== 0) throw new Error(r.stderr || "git diff failed");
        const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
        lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
      }
    } else if (viewMode === "commit" && selectedCommit) {
      const diffArgs = ["show", selectedCommit.hash, ...(isExpanded ? ["-U99999"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
      const r = await exec("git", [...READ, ...diffArgs], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr || "git show failed");
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }

    const maxLines = isExpanded ? 800 : 350;
    let finalLines = lines || [];
    if (finalLines.length > maxLines) {
      const remaining = finalLines.length - maxLines;
      finalLines = finalLines.slice(0, maxLines);
      finalLines.push(`@@ -0,0 +0,0 @@ [Diff preview truncated: showing first ${maxLines} lines. ${remaining} more lines hidden. ${isExpanded ? "File is very large." : "Click Expand context above for more."}]`);
    }
    return finalLines.map((line) => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  computeViewerLoadedKey(diff) {
    if (!diff?.openFileKey) return "empty";
    const isExpanded = Boolean(this.expandedFiles?.has(diff.openFileKey));
    const commitHash = diff.viewMode === "commit" ? (diff.selectedCommit?.hash || "") : "";
    return `${diff.requestSeq || 0}::${diff.openFileKey}::${diff.viewMode || "working"}::${commitHash}::${isExpanded ? 1 : 0}`;
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

    const viewMode = activeDiff?.viewMode || "working";
    const commitHash = viewMode === "commit" ? (activeDiff?.selectedCommit?.hash || "") : "";
    const fileId = computeViewerMarkdownFileId(openFile, viewMode, commitHash);
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
    if (this.activeComment) {
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
    const curMode = curDiff?.viewMode || "working";
    const curHash = curMode === "commit" ? (curDiff?.selectedCommit?.hash || "") : "";
    return computeViewerMarkdownFileId(curOpen, curMode, curHash) === fileId;
  }

  async loadViewerMarkdownNow(diff, cx, opts = {}) {
    if (this._viewerClosed) return;
    const ctx = this.getSessionContext();
    const latestDiff = diff || readActiveDiff(ctx.spaceId);
    const files = latestDiff?.files || [];
    const openFile = latestDiff?.openFile || files.find((f) => f.key === latestDiff?.openFileKey) || null;
    const viewMode = latestDiff?.viewMode || "working";
    const commitHash = viewMode === "commit" ? (latestDiff?.selectedCommit?.hash || "") : "";
    const filePath = openFile?.path || openFile?.displayPath || "";

    if (!openFile || !isMarkdownFile(filePath)) {
      this.resetViewerMarkdownState(false);
      cx?.notify();
      return;
    }

    const fileId = computeViewerMarkdownFileId(openFile, viewMode, commitHash);
    if (!this.viewerMarkdownRendered || this.viewerMarkdownFileId !== fileId) {
      return;
    }

    if (opts.forceReload) {
      this.invalidateViewerMarkdownCacheForFile(fileId);
    }

    const reloadNonce = this.getMarkdownReloadNonce(fileId);
    const loadToken = computeReviewMarkdownLoadToken(openFile, {
      viewMode,
      commitHash,
      requestSeq: latestDiff?.requestSeq || 0,
      reloadNonce,
    });
    const cacheKey = buildReviewMarkdownCacheKey(openFile, {
      viewMode,
      commitHash,
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
      viewMode,
      commitHash,
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
        cx?.notify();
      }
    }
  }

  async loadViewerDiffNow(diff, cx, opts = {}) {
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

    const viewMode = diff?.viewMode || "working";
    const commitHash = viewMode === "commit" ? (diff?.selectedCommit?.hash || "") : "";
    const openFilePath = openFile?.path || openFile?.displayPath || "";
    const isMdFile = Boolean(openFile && isMarkdownFile(openFilePath));
    const nextFileId = isMdFile ? computeViewerMarkdownFileId(openFile, viewMode, commitHash) : "";
    const seq = diff?.requestSeq || 0;
    const isCommentJump = Boolean(diff?.openCommentLine != null && seq && seq !== this.lastHandledSeq);

    if (!openFile || !isMdFile || opts.resetMarkdown || nextFileId !== this.viewerMarkdownFileId || isCommentJump) {
      this.resetViewerMarkdownState(false);
    }
    if (opts.forceReload && nextFileId) {
      this.invalidateViewerMarkdownCacheForFile(nextFileId);
    }

    if (prevOpenKey && prevOpenKey !== this.open && this.activeComment && this.activeComment.fileKey !== this.open) {
      this.activeComment = null;
      this.commentText = "";
      this.commentInput.set_value("");
    }

    if (!openFile) {
      this.setLines([]);
      this.viewerLoading = false;
      cx?.notify();
      return;
    }

    if (isMdFile && this.viewerMarkdownRendered && this.viewerMarkdownFileId === nextFileId) {
      this.loadViewerMarkdownNow(diff, cx, { bypassCache: Boolean(opts.forceReload) });
    }

    const isExpanded = Boolean(this.expandedFiles?.has(openFile.key));
    this.viewerLoading = true;
    cx?.notify();

    try {
      const lines = await this.fetchFileDiffLines(
        openFile,
        diff?.viewMode || "working",
        diff?.selectedCommit || null,
        diff?.on ?? null,
        isExpanded,
      );
      if (this._viewerClosed || gen !== this.viewerLoadGen) return;
      this.setLines(lines, openFile.path);

      const shouldConsumeDirectives = Boolean(seq && seq !== this.lastHandledSeq) || Boolean(opts.forceScrollTop);
      if (seq && seq !== this.lastHandledSeq) {
        this.lastHandledSeq = seq;
      }

      if (shouldConsumeDirectives && diff?.focusLine != null) {
        const rowIdx = this.rows.findIndex((r) => r.number === diff.focusLine);
        if (rowIdx >= 0) {
          try { this.diffScroll?.scroll_to_item(rowIdx); } catch {}
        }
      } else if (prevOpenKey !== openFile.key || opts.forceScrollTop) {
        try { this.diffScroll?.scroll_to_item(0); } catch {}
      }

      if (diff?.openCommentLine != null && diff?.openCommentLine !== undefined && shouldConsumeDirectives) {
        const row = this.rows.find((r) => r.number === diff.openCommentLine);
        const ctx = this.getSessionContext();
        const cur = this.getComment(openFile.key, diff.openCommentLine, ctx);
        this.openCommentEditor(
          openFile,
          diff.openCommentLine,
          cur?.snippet || row?.text || "",
          cur ? cur.text : "",
        );
      }
    } catch (e) {
      if (this._viewerClosed || gen !== this.viewerLoadGen) return;
      this.setLines([]);
      this.viewerNote = `Cannot preview this diff (too large or unreadable): ${e.message || e}`;
    } finally {
      if (!this._viewerClosed && gen === this.viewerLoadGen) {
        this.viewerLoading = false;
        cx?.notify();
      }
    }
  }

  openViewerFile(nextFile, diff, ctx, cx, overrides = {}) {
    const payload = this.buildActiveDiffPayload(nextFile, {
      ...overrides,
      files: overrides.files ?? diff?.files ?? [],
      allFiles: overrides.allFiles ?? diff?.allFiles ?? diff?.files ?? [],
      services: overrides.services ?? diff?.services ?? [],
      viewMode: overrides.viewMode ?? diff?.viewMode ?? "working",
      selectedCommit: overrides.selectedCommit !== undefined ? overrides.selectedCommit : (diff?.selectedCommit ?? null),
      activeService: overrides.activeService ?? diff?.activeService ?? "all",
      on: overrides.on !== undefined ? overrides.on : (diff?.on ?? null),
      bumpSeq: true,
      focusLine: null,
      openCommentLine: null,
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

    const scope = this.fileReviewScope(diff?.viewMode, diff?.selectedCommit);
    const rk = this.fileReviewKey(curFile, scope);
    if (!rk) return;

    const { nextReviewed, updatedFlow } = this.applyFileReviewToggle(curFile, curFile.key, scope, ctx);

    if (nextReviewed) {
      const nextFile = pickNextUnreviewedFile(
        files,
        curFile.key,
        (cand) => this.isFileReviewed(cand, updatedFlow, scope),
      );
      if (nextFile) {
        this.openViewerFile(nextFile, diff, ctx, cx);
        return;
      }
    }

    cx.notify();
  }

  setLines(lines, filePath = "") {
    this.rows = diffRows(lines, filePath);
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
      openCommentLine: null,
    });
    cx.notify();
  }

  toggleExpand(fileKey, cx) {
    if (!fileKey || this.viewerLoading) return;
    if (this.expandedFiles.has(fileKey)) {
      this.expandedFiles.delete(fileKey);
    } else {
      this.expandedFiles.add(fileKey);
    }
    const ctx = this.getSessionContext();
    const diff = readActiveDiff(ctx.spaceId);
    if (diff && diff.openFileKey === fileKey) {
      this.loadViewerDiffNow(diff, cx);
    } else {
      cx.notify();
    }
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
    const commentCols = Math.max(24, Math.min(56, (wrapCols || 80) - 8));
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

  computeDiffRowHeights(commentMap, wrapCols) {
    const rows = this.rows;
    const len = rows.length;
    const hunkCols = Math.max(12, wrapCols - 16);

    let commentSig = "";
    if (commentMap && commentMap.size > 0) {
      commentMap.forEach((rec, lineNo) => {
        commentSig += `${lineNo}:${rec?.text?.length || 0};`;
      });
    }
    const cacheSig = `${len}|${wrapCols}|${commentSig}`;
    if (
      this._rowHeightsCache &&
      this._rowHeightsCache.rows === rows &&
      this._rowHeightsCache.sig === cacheSig
    ) {
      return this._rowHeightsCache.heights;
    }

    const heights = new Array(len);
    for (let i = 0; i < len; i++) {
      const r = rows[i];
      if (!r) {
        heights[i] = REVIEW_ROW_HEIGHT;
        continue;
      }
      if (r.kind === "@") {
        const hunkLines = countWrappedLines(r.text || "", hunkCols);
        heights[i] = Math.max(22, 6 + hunkLines * 16);
        continue;
      }
      const lineCount = countWrappedLines(r.text || " ", wrapCols);
      let h = Math.max(1, lineCount) * REVIEW_ROW_HEIGHT;
      if (r.number !== undefined) {
        const existing = commentMap ? commentMap.get(r.number) : null;
        if (existing) {
          const cLines = this.getWrappedCommentLines(existing.text, wrapCols);
          h += 13 + cLines.length * 16;
        }
      }
      heights[i] = h;
    }
    this._rowHeightsCache = { rows, sig: cacheSig, heights };
    return heights;
  }

  scheduleDiffResizeReflow(nextW, cx) {
    const prevCols = this.getReviewWrapCols();
    this.diffViewportWidth = nextW;
    const nextCols = this.getReviewWrapCols();
    if (nextCols === prevCols) return;

    if (this.diffResizeTask) {
      try { this.diffResizeTask.cancel(); } catch {}
      this.diffResizeTask = null;
    }
    const timer = cx?.timer || this.hostCx?.timer;
    if (timer) {
      this.diffResizeTask = timer.after(16, (timerCx) => {
        this.diffResizeTask = null;
        try { (timerCx || cx || this.hostCx)?.notify(); } catch {}
      });
    } else {
      cx?.notify();
    }
  }

  diffRow(rowObj, t, dt, commentMap, activeOpenKey = null, wrapCols = 96) {
    const { kind, number, text, tokens } = rowObj;
    const openKey = activeOpenKey || this.open;
    if (kind === "@") {
      const isExpanded = Boolean(this.expandedFiles && this.expandedFiles.has(openKey));
      const hunkCols = Math.max(12, wrapCols - 16);
      const hCacheKey = `h|${hunkCols}`;
      let cachedHunk = reviewWrapCache.get(rowObj);
      if (!cachedHunk || cachedHunk.key !== hCacheKey) {
        cachedHunk = { key: hCacheKey, segments: wrapPlainText(text || "", hunkCols, { toNbsp: true }) };
        reviewWrapCache.set(rowObj, cachedHunk);
      }
      const hunkSegments = cachedHunk.segments;
      const hunkH = Math.max(22, 6 + hunkSegments.length * 16);
      return h_flex().w_full().h(hunkH).px(12).py(2).flex_none().items_center().gap(10)
        .bg(t.raised).border_b(1).border_color(t.border)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .child(
          div().flex_none().px(5).py(0.5).rounded(3).bg(t.background).text_size(9.5).text_color(t.muted)
            .child(isExpanded ? "Collapse context" : "Expand context")
        )
        .child(
          v_flex().flex_1().min_w(0).overflow_hidden().children(
            hunkSegments.map((seg) =>
              div().w_full().h(16).flex_none().whitespace_nowrap().text_size(11).text_color(t.dim).child(seg || "\u00a0")
            )
          )
        );
    }
    const isCommentable = number !== undefined;
    const existing = (isCommentable && commentMap) ? commentMap.get(number) : null;
    const isActive = this.activeComment && this.activeComment.fileKey === openKey && this.activeComment.line === number;

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

    const buildVisualSubRow = (seg, isFirstSeg) =>
      h_flex().w_full().h(REVIEW_ROW_HEIGHT).flex_none().items_center().gap(6).pr(14)
        .border_l(2)
        .border_color(diffColor || t.background)
        .when(isCommentable, (e) => e.cursor_pointer())
        .when(Boolean(rowBg), (e) => e.bg(rowBg))
        .when(Boolean(existing) || Boolean(isActive), (e) => e.bg(t.selected))
        .hover((s) => s.bg(hoverBg))
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

    const row = segments.length <= 1
      ? buildVisualSubRow(segments[0], true)
      : v_flex().w_full().flex_none().children(
          segments.map((seg, idx) => buildVisualSubRow(seg, idx === 0))
        );

    if (!existing) {
      return row;
    }

    const commentLines = this.getWrappedCommentLines(existing.text, wrapCols);

    return v_flex().w_full().flex_none()
      .child(row)
      .child(
        h_flex().w_full().h(13 + commentLines.length * 16).pl(12).pr(16).py(6).bg(t.raised).border_b(1).border_color(t.border)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .child(
            h_flex().w_full().max_w(460).gap(8).items_start()
              .child(div().pt(2).flex_none().child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(t.muted)))
              .child(
                v_flex().flex_1().min_w(0).children(
                  commentLines.map((line) =>
                    div().w_full().h(16).flex_none().whitespace_nowrap().text_size(11.5).text_color(t.foreground).child(line || " ")
                  )
                )
              )
              .child(div().flex_none().text_size(10).text_color(t.dim).child(isActive ? "Editing" : "Edit"))
          )
      );
  }

  /**
   * Renders the docked review-comment composer outside `v_virtual_list` so GPUI
   * retained Textarea and button handlers never run inside a virtual-list layout callback.
   */
  renderCommentComposer(t, commentMap, openKey) {
    const active = this.activeComment;
    if (!active || active.fileKey !== openKey) return div();
    const existing = commentMap ? commentMap.get(active.line) : null;
    const canSave = Boolean(this.commentText.trim());
    return v_flex().id("review-comment-composer").w_full().flex_none()
      .px(12).py(8).bg(t.raised).border_t(1).border_color(t.border)
      .child(
        v_flex().w_full().max_w(520).gap(6)
          .child(
            h_flex().w_full().items_center().justify_between().gap(8)
              .child(
                h_flex().items_center().gap(6).min_w(0).flex_1()
                  .child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(t.accent))
                  .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(`Line ${active.line}`))
                  .when(Boolean(active.snippet), (e) =>
                    e.child(div().flex_1().min_w(0).overflow_hidden().whitespace_nowrap().text_size(11).text_color(t.dim).child(active.snippet))
                  )
              )
              .when(Boolean(existing), (e) =>
                e.child(
                  h_flex().id("inline-delete-btn").h(22).px(8).items_center().gap(4).rounded(5)
                    .border_1().border_color(t.border).bg(t.background)
                    .text_color(t.muted).text_size(11).cursor_pointer()
                    .hover((s) => s.text_color(t.foreground).bg(t.hover))
                    .on_click((_e, cx) => this.removeComment(openKey, active.line, cx))
                    .child(svg("mods/changes-review/icons/trash.svg").size(10).text_color(t.muted))
                    .child("Delete")
                )
              )
          )
          .child(
            div().w_full().h(78).p(7).rounded(7).border_1().border_color(this.typingComment ? t.accent : t.border).bg(t.background).cursor_text()
              .child(Textarea.new(this.commentInput).w_full().h(62).text_size(12).text_color(t.foreground))
          )
          .child(
            h_flex().w_full().h(26).items_center().justify_between()
              .child(div().text_size(10.5).text_color(t.dim).child("Esc to cancel · Cmd/Ctrl+Enter to save"))
              .child(
                h_flex().gap(6).items_center()
                  .child(
                    h_flex().id("inline-cancel-btn").h(26).px(10).items_center().rounded(6)
                      .border_1().border_color(t.border).bg(t.background)
                      .text_color(t.muted).text_size(11.5).cursor_pointer()
                      .hover((s) => s.text_color(t.foreground))
                      .on_click((_e, cx) => this.cancelActiveComment(cx))
                      .child("Cancel")
                  )
                  .child(
                    h_flex().id("inline-save-btn").h(26).px(12).items_center().rounded(6)
                      .bg(canSave ? t.solid : t.background)
                      .text_color(canSave ? t.solid_foreground : t.dim)
                      .text_size(11.5).font_medium()
                      .when(canSave, (e) => e.cursor_pointer())
                      .on_click((_e, cx) => this.saveActiveComment(cx))
                      .child(existing ? "Update" : "Save")
                  )
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
        viewMode: this.viewMode,
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
                viewMode: this.viewMode,
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
    const viewMode = diff?.viewMode || "working";
    const selectedCommit = diff?.selectedCommit || null;
    const commitHash = viewMode === "commit" ? (selectedCommit?.hash || "") : "";
    const openFilePath = openFile?.path || openFile?.displayPath || "";
    const isMdFile = Boolean(openFile && isMarkdownFile(openFilePath));
    const currentMdFileId = isMdFile ? computeViewerMarkdownFileId(openFile, viewMode, commitHash) : "";
    const markdownActive = Boolean(
      isMdFile &&
      this.viewerMarkdownRendered &&
      this.viewerMarkdownFileId === currentMdFileId
    );

    const flows = readFlows();
    const flow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    const scope = this.fileReviewScope(viewMode, selectedCommit);
    const openFileReviewed = openFile ? this.isFileReviewed(openFile, flow, scope) : false;
    const reviewedFilesCount = files.reduce((n, f) => n + (this.isFileReviewed(f, flow, scope) ? 1 : 0), 0);
    const allFilesReviewed = files.length > 0 && reviewedFilesCount === files.length;
    const fileIdx = openKey ? files.findIndex((f) => f.key === openKey) : -1;

    const sessionReviews = this.getSessionReviews(ctx);
    const commentMap = new Map();
    if (openKey && sessionReviews.length > 0) {
      for (const r of sessionReviews) {
        if (r.fileKey === openKey || r.file === openKey) {
          commentMap.set(r.line, r);
        }
      }
    }

    const canStepFiles = files.length > 1;
    const openIcon = openFile ? resolveDiffFileIcon(openFile.path || openFile.displayPath, t) : null;
    const compactViewer = (this.viewerWidth || 900) < 680;

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
        .when(!compactViewer || viewMode === "commit", (b) => b.child(
          div().flex_none().px(5).py(1).rounded(4).bg(t.background).border_1().border_color(t.border)
            .text_size(10).text_color(viewMode === "commit" ? (t.accent || t.foreground) : t.muted)
            .child(viewMode === "commit" && selectedCommit?.shortHash ? selectedCommit.shortHash : "Working")
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
      .on_key_down((e, cx) => {
        if (!markdownActive && e.key === "escape" && (this.typingComment || this.activeComment)) {
          this.cancelActiveComment(cx);
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
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
              const wrapCols = this.getReviewWrapCols();
              const rowHeights = this.computeDiffRowHeights(commentMap, wrapCols);
              return v_flex().flex_1().min_h(0).w_full()
                .on_size_change((size, cx) => {
                  const w = Math.round(size?.width || 0);
                  if (w > 0 && Math.abs(w - (this.diffViewportWidth || 0)) > 4) {
                    this.scheduleDiffResizeReflow(w, cx);
                  }
                })
                .child(
                  div().size_full().relative().font_family(mono).text_size(11.5)
                    .when(this.rows.length > 0, (el) => el
                      .child(
                        v_virtual_list(
                          "changes-diff-lines",
                          this.rows.length,
                          rowHeights,
                          (index) => `${openKey || ""}::${index}`,
                          (range) => {
                            const out = [];
                            for (let i = range.start; i < range.end; i++) {
                              out.push(this.diffRow(this.rows[i], t, dt, commentMap, openKey, wrapCols));
                            }
                            return out;
                          }
                        )
                          .size_full()
                          .track_scroll(this.diffScroll)
                          .on_item_click((itemKey, cx) => {
                            const keyStr = String(itemKey || "");
                            const sep = keyStr.lastIndexOf("::");
                            const idx = Number(sep >= 0 ? keyStr.slice(sep + 2) : keyStr);
                            if (!Number.isInteger(idx) || idx < 0 || idx >= this.rows.length) return;
                            const rowObj = this.rows[idx];
                            if (!rowObj) return;
                            const activeKey = readActiveDiff(this.getSessionContext().spaceId)?.openFileKey || openKey;
                            if (rowObj.kind === "@") {
                              this.toggleExpand(activeKey, cx);
                            } else if (rowObj.number !== undefined) {
                              this.startComment(activeKey, rowObj.number, rowObj.text, cx);
                            }
                          })
                      )
                      .child(Scrollbar.vertical("changes-diff-lines").viewport_from_layout().absolute().inset_0())
                    )
                    .when(!openFile, (e) => e.child(
                      h_flex().absolute().inset_0().items_center().justify_center()
                        .child(div().text_size(12).text_color(t.dim).child(
                          files.length === 0 && viewMode === "working"
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

  getCommitMenuItems(t) {
    if (!this.showCommitMenu) return [];
    const selectedHash = this.selectedCommit?.hash || "";
    const servicesCount = this.services.length;
    const themeSig = `${t?.accent || ""}|${t?.foreground || ""}|${t?.muted || ""}|${t?.dim || ""}|${t?.background || ""}`;
    if (
      this._cachedCommitMenu &&
      this._cachedCommitMenu.viewMode === this.viewMode &&
      this._cachedCommitMenu.selectedHash === selectedHash &&
      this._cachedCommitMenu.workingFilesCount === this.workingFilesCount &&
      this._cachedCommitMenu.servicesCount === servicesCount &&
      this._cachedCommitMenu.commits === this.commits &&
      this._cachedCommitMenu.themeSig === themeSig
    ) {
      return this._cachedCommitMenu.items;
    }

    const items = [
      {
        type: "option",
        id: "select-working-tree",
        icon: "mods/changes-review/icons/git-commit.svg",
        iconSize: 13,
        iconColor: this.viewMode === "working" ? (t.accent || t.foreground) : t.muted,
        label: "Working Tree",
        fontMedium: this.viewMode === "working",
        meta: "Uncommitted",
        metaColor: t.dim,
        badge: this.workingFilesCount > 0 ? String(this.workingFilesCount) : undefined,
        badgeBg: t.raised || t.background,
        badgeColor: t.muted,
        selected: this.viewMode === "working",
        onSelect: (_e, cx) => this.switchMode("working", null, cx),
      },
    ];

    if (this.commits.length > 0) {
      items.push({ type: "divider", id: "commit-menu-divider" });
      for (let i = 0; i < this.commits.length; i += 1) {
        const c = this.commits[i];
        const isSelected = this.viewMode === "commit" && selectedHash === c.hash;
        items.push({
          type: "option",
          id: `commit-item-${c.serviceId || "repo"}-${c.hash || `${c.shortHash}-${i}`}`,
          icon: "mods/changes-review/icons/git-commit.svg",
          iconSize: 13,
          iconColor: isSelected ? (t.accent || t.foreground) : t.muted,
          label: c.subject || c.shortHash,
          labelColor: t.foreground,
          fontMedium: isSelected,
          subline: [c.author, c.date].filter(Boolean).join(" · ") || undefined,
          sublineColor: t.dim,
          sublineBadge: servicesCount > 1 && c.serviceName ? c.serviceName : undefined,
          sublineBadgeBg: t.raised || t.background,
          sublineBadgeColor: t.muted,
          rightText: c.shortHash,
          rightMono: true,
          rightColor: isSelected ? t.foreground : t.dim,
          height: 42,
          selected: isSelected,
          onSelect: (_e, cx) => this.switchMode("commit", c, cx),
        });
      }
    }

    this._cachedCommitMenu = {
      viewMode: this.viewMode,
      selectedHash,
      workingFilesCount: this.workingFilesCount,
      servicesCount,
      commits: this.commits,
      themeSig,
      items,
    };
    return items;
  }

  renderPanel(cx) {
    const visible = isChangesVisible();
    const bus = shared("cognivisor.services");
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

    const allSpaces = spaces() || [];
    const allPanes = panes() || [];
    const curSpace = allSpaces.find((s) => s.active);
    const curTab = (curSpace?.tabs || []).find((t) => t.active);
    if (curSpace?.id && curTab?.id && allPanes.some((p) => p.tab === curTab.id && Boolean(p.terminal))) {
      const storedAgentTabs = readPlainObject(shared("cognivisor.spaceAgentTabs"));
      if (storedAgentTabs[curSpace.id] !== curTab.id) {
        this.scheduleAgentTabSync(cx);
      }
    }

    const ctx = this.getSessionContext();
    const activeDiff = readActiveDiff(ctx.spaceId);
    const revTab = findReviewTabInSpace(ctx.spaceId, allSpaces, allPanes);
    const sharedActive = shared("cognivisor.activeService");
    const extServiceChanged = Boolean(
      sharedActive &&
      normPathStr(sharedActive.workspaceRoot) === normPathStr(this.workspaceRoot) &&
      typeof sharedActive.ts === "number" &&
      sharedActive.ts > (this.lastActiveServiceTs || 0) &&
      sharedActive.serviceId &&
      sharedActive.serviceId !== this.activeService &&
      (sharedActive.serviceId === "all" || this.services.some((s) => s.id === sharedActive.serviceId))
    );
    const diffSyncedFromViewer = Boolean(
      revTab &&
      activeDiff &&
      activeDiff.sourceTabId === ctx.sourceTabId &&
      (activeDiff.openFileKey !== this.open ||
        (activeDiff.activeService &&
          activeDiff.activeService !== this.activeService &&
          (activeDiff.activeService === "all" || this.services.some((s) => s.id === activeDiff.activeService))))
    );
    if (extServiceChanged || diffSyncedFromViewer) {
      this.scheduleSharedSync(cx);
    }

    const t = theme();
    const addCount = this.files.reduce((n, f) => n + f.add, 0);
    const delCount = this.files.reduce((n, f) => n + f.del, 0);
    const dt = getDiffTheme(t);
    const { add, del } = dt;
    const passColor = t.ansi2 || t.done || t.accent;
    const noteColor = t.blocked || t.working || t.accent;

    const flows = readFlows();
    const flow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    const sessionReviews = this.getSessionReviews(ctx);
    const sortedServices = this.getSortedServices();
    const soleService = this.services.length === 1 ? (this.services[0] || null) : null;

    const targetRepos = this.getTargetRepos();
    const commitEnabled = Boolean(this.message.trim() && targetRepos.length > 0 && !this.busy && !this.loading);
    const agent = this.findActiveAgent();
    const agentName = agent ? (agent.title || agent.app || agent.address) : null;
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const highlightedOpenKey = (revTab && activeDiff && activeDiff.sourceTabId === ctx.sourceTabId)
      ? activeDiff.openFileKey
      : this.open;
    const reviewedFilesCount = this.files.reduce((n, f) => n + (this.isFileReviewed(f, flow) ? 1 : 0), 0);
    const allFilesReviewed = this.files.length > 0 && reviewedFilesCount === this.files.length;
    const compactPanel = (this.panelWidth || 420) < 380;

    const commitSelectorLabel = this.viewMode === "working"
      ? "Working Tree"
      : this.selectedCommit
        ? `${this.services.length > 1 && this.selectedCommit.serviceName ? `[${this.selectedCommit.serviceName}] ` : ""}${this.selectedCommit.shortHash}: ${this.selectedCommit.subject}`
        : "Select commit";

    const renderCommitSelector = () =>
      renderDropdownTrigger({
        id: "commit-selector-btn",
        isOpen: this.showCommitMenu,
        label: commitSelectorLabel,
        labelColor: t.foreground,
        fontMedium: true,
        badge: this.viewMode === "working" && this.workingFilesCount > 0 ? String(this.workingFilesCount) : undefined,
        leftIcon: "mods/changes-review/icons/git-commit.svg",
        leftIconSize: 11,
        leftIconColor: this.viewMode === "working" ? t.muted : (t.accent || t.foreground),
        chevronIcon: "mods/changes-review/icons/chevron-down.svg",
        maxW: compactPanel ? undefined : 210,
        flex1: !compactPanel,
        fullWidth: compactPanel,
        t,
        onClick: (_e, cx) => {
          this.showCommitMenu = !this.showCommitMenu;
          cx.notify();
        },
      });

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
          if (this.showCommitMenu) {
            this.showCommitMenu = false;
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
            return;
          }
          if (this.typingCommit) {
            this.typingCommit = false;
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
            return;
          }
        }
      })
      // Header
      .child(
        compactPanel
          ? v_flex().flex_none().px(10).py(7).gap(6).border_b(1).border_color(t.border)
              .child(
                h_flex().w_full().min_w(0).gap(6).items_center().justify_between()
                  .child(renderPanelHeaderBadges())
                  .child(
                    h_flex().flex_none().gap(6).items_center()
                      .child(div().flex_none().text_size(11).text_color(add).child(`+${addCount}`))
                      .child(div().flex_none().text_size(11).text_color(del).child(`−${delCount}`))
                  )
              )
              .child(renderCommitSelector())
          : h_flex().min_h(40).flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border)
              .child(renderPanelHeaderBadges())
              .child(renderCommitSelector())
              .child(div().flex_1())
              .child(div().flex_none().text_size(11).text_color(add).child(`+${addCount}`))
              .child(div().flex_none().text_size(11).text_color(del).child(`−${delCount}`))
      )

      // Service filter bar (when workspace contains multiple repositories)
      .when(this.services.length > 1, (el) => {
        const isAllActive = this.activeService === "all";
        return el.child(
          h_flex().id("service-filter-bar").h(32).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.raised).overflow_x_scrollbar().track_scroll(this.serviceFilterScroll)
            .child(
              h_flex().id("service-pill-all").h(22).flex_none().px(7).gap(5).items_center().rounded(4).cursor_pointer()
                .when(isAllActive, (s) => s.bg(t.background).border_1().border_color(t.border).text_color(t.foreground).font_medium(), (s) => s.bg(t.raised).text_color(t.muted).hover((h) => h.bg(t.hover).text_color(t.foreground)))
                .on_click((_e, cx) => this.selectService("all", cx))
                .child(div().text_size(11).child("All"))
                .child(
                  div().flex_none().px(4).py(0.5).rounded(3).bg(isAllActive ? t.raised : t.background).text_size(9.5).text_color(t.muted).child(String(this.allWorkingFiles.length))
                )
            )
            .children(
              sortedServices.map((s) => {
                const isCur = this.activeService === s.id;
                const count = s.workingCount || 0;
                const svcStatus = this.getServiceReviewStatus(s.id, flow, sessionReviews);
                const glyph = svcStatus === "approved" ? "✓" : svcStatus === "has_notes" ? "✎" : "○";
                const glyphColor = svcStatus === "approved" ? passColor : svcStatus === "has_notes" ? noteColor : t.dim;
                const branchLabel = s.branch || "";
                return h_flex().id(`service-pill-${s.id}`).h(22).flex_none().px(7).gap(5).items_center().rounded(4).cursor_pointer()
                  .when(isCur, (p) => p.bg(t.background).border_1().border_color(t.border).text_color(t.foreground).font_medium(), (p) => p.bg(t.raised).text_color(t.muted).hover((h) => h.bg(t.hover).text_color(t.foreground)))
                  .on_click((_e, cx) => this.selectService(s.id, cx))
                  .child(div().flex_none().text_size(10).text_color(glyphColor).child(glyph))
                  .child(div().flex_none().text_size(11).child(s.name))
                  .when(Boolean(branchLabel), (p) => p.child(
                    div().max_w(96).truncate().text_size(9.5).text_color(isCur ? t.muted : t.dim).child(branchLabel)
                  ))
                  .when(count > 0, (p) => p.child(
                    div().flex_none().px(4).py(0.5).rounded(3).bg(isCur ? t.raised : t.background).text_size(9.5).text_color(t.muted).child(String(count))
                  ));
              })
            )
        );
      })

      // Compact read-only branch bar when workspace contains a single repository
      .when(Boolean(soleService), (el) => {
        const svc = soleService;
        const branchLabel = svc.branch || "HEAD";
        return el.child(
          h_flex()
            .id("microservice-review-bar")
            .min_h(28)
            .flex_none()
            .px(10)
            .py(4)
            .gap(6)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .child(svg("mods/changes-review/icons/git-branch.svg").size(11).flex_none().text_color(t.muted))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11)
                .font_medium()
                .text_color(t.foreground)
                .child(`${svc.name} · ${branchLabel}`),
            ),
        );
      })

      // Pre-existing hidden files banner + toggle + baseline reset
      .when(this.viewMode === "working" && (this.hiddenPreExistingCount > 0 || this.showAllWorkingChanges), (el) => {
        const n = this.hiddenPreExistingCount;
        const label = this.showAllWorkingChanges
          ? (n > 0 ? `Showing all working changes (${n} pre-existing)` : "Showing all working changes")
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

      // File list (changes-list fills remaining space above the bottom Review | Commit drawer)
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
                this.toggleFileReviewed(f, cx, false);
              })
              .child(div().text_size(9.5).font_semibold().child(isReviewed ? "✓" : ""))
          )
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? add : f.status === "D" || f.status === "U" ? del : t.blocked).child(f.status))
          .when(this.services.length > 1 && this.activeService === "all", (e) => e.child(
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
        this.error || (this.loading ? "Loading changes…" : !this.workspaceRoot ? "No folder" : this.viewMode === "commit" ? "No files changed in this commit" : "No changes in this session yet")
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

      // Commit section (Working Tree commit input, or switch button if viewing historical commit/branch)
      .when(this.bottomTab === "commit", (el) => el.child(
        this.viewMode === "working"
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
              .child(div().flex_1().min_w(0).text_size(11.5).text_color(t.dim).child("Select Working Tree above to commit."))
      ))

      // Review section (scrollable list of notes + send to agent without counter)
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
                    return h_flex().id(`review-${r.fileKey || r.file}-${r.line}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).bg(t.raised).cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => this.jumpToComment(r, cx))
                      .child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(t.muted))
                      .child(div().text_size(11).text_color(t.muted).child(`${servicePrefix}${fileName}:${r.line}`))
                      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(firstLine))
                      .child(
                        div().p(3).rounded(4).cursor_pointer().hover((s) => s.bg(t.background))
                          .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.removeComment(r.fileKey || r.file, r.line, cx);
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
      ))

      // Floating commit dropdown overlay
      .when(this.showCommitMenu, (el) => el.child(
        renderDropdownPopover({
          overlayId: "commit-menu-overlay",
          menuId: "commit-dropdown-floating",
          triggerId: "commit-selector-btn",
          top: compactPanel ? 68 : 43,
          left: 10,
          anchor: "left",
          minWidth: 220,
          maxWidth: 360,
          maxHeight: 320,
          panelWidth: this.panelWidth || 420,
          marginX: 20,
          items: this.getCommitMenuItems(t),
          scrollHandle: this.commitDropdownScroll,
          monoFont: mono,
          t,
          onClose: (_e, cx) => {
            this.showCommitMenu = false;
            cx.notify();
          },
        })
      ));
  }
}
