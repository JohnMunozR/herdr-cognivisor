// Workspace file & directory indexer with agent-gated pre-warming, persistent disk cache, and watch-driven invalidation.
import { readdir, exists, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import {
  spaces, panes, terminals, agents, focused,
  exec, appHome, shared,
} from "herdr";

export const DISCOVER_SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "build", "vendor",
  ".venv", "venv", ".next", ".nuxt", ".cache", "__pycache__", "out", "coverage", "logs",
]);

export const WATCH_SKIP_DIRS = new Set([
  "node_modules", "target", "dist", "build", "vendor", ".venv", "venv",
  ".next", ".nuxt", ".cache", "__pycache__", "logs", ".gradle", ".idea",
  ".turbo", ".parcel-cache", "coverage", ".sass-cache", "tmp", ".tmp",
]);

export const WATCH_SKIP_EXTS = [".log", ".tmp", ".swp", ".swo", ".part", ".crdownload"];

export const MAX_OVERLAY_FILES = 12000;
export const MAX_OVERLAY_DIRS = 3000;
export const OVERLAY_INDEX_FRESH_MS = 8000;
export const INDEX_WATCHED_TTL_MS = 300000;
export const INDEX_REBUILD_DEBOUNCE_MS = 1200;
export const AGENT_PREWARM_DEBOUNCE_MS = 250;

export const OVERLAY_INDEX_CACHE = new Map();
export const RG_AVAILABLE_CACHE = new Map();
const RG_AVAILABLE_TS = new Map();
const RG_AVAILABLE_FAIL_TTL_MS = 60000;

export function isRgAvailable(onKey = "local") {
  const key = onKey || "local";
  const cached = RG_AVAILABLE_CACHE.get(key);
  if (cached !== false) return cached;
  const ts = RG_AVAILABLE_TS.get(key) || 0;
  if (ts > 0 && Date.now() - ts >= RG_AVAILABLE_FAIL_TTL_MS) {
    RG_AVAILABLE_CACHE.delete(key);
    RG_AVAILABLE_TS.delete(key);
    return undefined;
  }
  return false;
}

export function markRgAvailable(onKey = "local", ok) {
  const key = onKey || "local";
  const boolOk = Boolean(ok);
  RG_AVAILABLE_CACHE.set(key, boolOk);
  if (boolOk) RG_AVAILABLE_TS.delete(key);
  else RG_AVAILABLE_TS.set(key, Date.now());
}

const INDEX_INFLIGHT = new Map();
const DISK_LOAD_INFLIGHT = new Map();
const DISK_LOAD_ATTEMPTED = new Set();
const INDEX_GENERATION = new Map();
const INDEX_DIRTY_SEQ = new Map();
const ACTIVE_ROOT_WATCHERS = new Map();

export const READ_GIT = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false",
];

export const COMMON_IGNORE_GLOBS = [
  "--glob", "!.git",
  "--glob", "!node_modules",
  "--glob", "!.cache",
  "--glob", "!target",
  "--glob", "!build",
  "--glob", "!.next",
  "--glob", "!.nuxt",
  "--glob", "!.svelte-kit",
  "--glob", "!.turbo",
  "--glob", "!.parcel-cache",
  "--glob", "!.venv",
  "--glob", "!venv",
  "--glob", "!vendor",
  "--glob", "!dist",
  "--glob", "!coverage",
  "--glob", "!.gradle",
  "--glob", "!.idea",
  "--glob", "!.vs",
  "--glob", "!__pycache__",
  "--glob", "!.pytest_cache",
  "--glob", "!.mypy_cache",
  "--glob", "!obj",
  "--glob", "!.terraform",
  "--glob", "!.angular",
  "--glob", "!.nx",
  "--glob", "!.cargo",
  "--glob", "!.rustup",
  "--glob", "!.npm",
  "--glob", "!.pnpm-store",
  "--glob", "!.bun",
  "--glob", "!.local/share",
  "--glob", "!.mozilla",
  "--glob", "!.config/google-chrome",
  "--glob", "!.config/chromium",
  "--glob", "!.Trash",
  "--glob", "!.var",
  "--glob", "!.m2",
  "--glob", "!go/pkg",
  "--glob", "!*.egg-info",
  "--glob", "!.sass-cache",
];

export function normPathStr(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function normCmpStr(p, isWindows = false) {
  const s = normPathStr(p);
  return isWindows ? s.toLowerCase() : s;
}

export function isSameOrChildPath(child, parent, isWindows = false) {
  const c = normCmpStr(child, isWindows);
  const p = normCmpStr(parent, isWindows);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + "/");
}

export function joinSubPath(root, rel) {
  if (!rel) return root;
  if (root === "/") return `/${rel}`;
  if (/^[A-Za-z]:[\\/]?$/.test(root)) {
    return `${root.slice(0, 2)}/${rel}`;
  }
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

export function isSupportedDirentList(entries) {
  if (!Array.isArray(entries)) return false;
  if (entries.length === 0) return true;
  const first = entries[0];
  return (
    typeof first === "object" &&
    first !== null &&
    "name" in first &&
    (typeof first.isDirectory === "function" || typeof first.isDirectory === "boolean")
  );
}

export function direntIsDir(entry) {
  return typeof entry?.isDirectory === "function"
    ? Boolean(entry.isDirectory())
    : Boolean(entry?.isDirectory);
}

export function getRelToWorkspace(changedPath, workspaceRoot) {
  const normP = normPathStr(changedPath);
  const normRoot = normPathStr(workspaceRoot);
  if (!normP || !normRoot) return null;
  if (normP === normRoot) return "";
  if (normP.startsWith(normRoot + "/")) return normP.slice(normRoot.length + 1);
  const lowerP = normP.toLowerCase();
  const lowerRoot = normRoot.toLowerCase();
  if (lowerP === lowerRoot) return "";
  if (lowerP.startsWith(lowerRoot + "/")) return normP.slice(normRoot.length + 1);
  return null;
}

export function isIgnoredWatchPath(changedPath, workspaceRoot) {
  const rel = getRelToWorkspace(changedPath, workspaceRoot);
  const target = rel !== null ? rel : normPathStr(changedPath);
  if (!target) return false;
  const segs = target.split("/").filter(Boolean);
  const segsLower = segs.map(s => s.toLowerCase());

  const gitIdx = segsLower.indexOf(".git");
  if (gitIdx >= 0) {
    const afterGit = segsLower.slice(gitIdx + 1).join("/");
    if (
      afterGit === "index" ||
      afterGit === "head" ||
      afterGit === "merge_head" ||
      afterGit === "rebase-head" ||
      afterGit === "cherry_pick_head" ||
      afterGit.startsWith("refs/") ||
      afterGit.startsWith("rebase-merge/") ||
      afterGit.startsWith("rebase-apply/")
    ) {
      return false;
    }
    return true;
  }

  for (let i = 0; i < segsLower.length - 1; i++) {
    if (WATCH_SKIP_DIRS.has(segsLower[i])) return true;
  }
  const base = segsLower[segsLower.length - 1] || "";
  if (WATCH_SKIP_DIRS.has(base)) return true;
  if (base === ".ds_store" || base === "thumbs.db" || base.endsWith("~")) return true;
  for (const ext of WATCH_SKIP_EXTS) {
    if (base.endsWith(ext)) return true;
  }
  return false;
}

export function analyzeWatchBatch(changedPaths, workspaceRoot, openFolders) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { hasNonIgnored: true, hasGitChange: true, hasGitRefChange: false, hasNonGitChange: true, invalidateRepos: false, dirtyDirs: new Set(["*"]) };
  }
  let hasNonIgnored = false;
  let hasGitChange = false;
  let hasGitRefChange = false;
  let hasNonGitChange = false;
  let invalidateRepos = false;
  const dirtyDirs = new Set();

  for (const raw of changedPaths) {
    if (!raw || isIgnoredWatchPath(raw, workspaceRoot)) continue;
    hasNonIgnored = true;
    const rel = getRelToWorkspace(raw, workspaceRoot);
    if (rel === null) {
      hasNonGitChange = true;
      dirtyDirs.add("*");
      continue;
    }
    const segs = rel.split("/").filter(Boolean);
    if (segs.includes(".git") || segs.some(s => s.toLowerCase() === ".git")) {
      hasGitChange = true;
      const lowerRel = rel.toLowerCase();
      if (
        lowerRel.includes(".git/head") ||
        lowerRel.includes(".git/refs/") ||
        segs[segs.length - 1].toLowerCase() === ".git"
      ) {
        invalidateRepos = true;
        hasGitRefChange = true;
      }
      continue;
    }
    hasNonGitChange = true;
    if (segs.length <= 2) invalidateRepos = true;
    const parent = segs.slice(0, -1).join("/");
    dirtyDirs.add(parent);
    if (segs.length >= 2) {
      dirtyDirs.add(segs.slice(0, -2).join("/"));
    }
    if (openFolders?.has(rel)) dirtyDirs.add(rel);
  }
  return { hasNonIgnored, hasGitChange, hasGitRefChange, hasNonGitChange, invalidateRepos, dirtyDirs };
}

export function parseIndexedPaths(stdout, cap = MAX_OVERLAY_FILES, prefix = "") {
  const out = [];
  if (!stdout) return out;
  let start = 0;
  const len = stdout.length;
  while (start < len && out.length < cap) {
    let nl = stdout.indexOf("\n", start);
    if (nl === -1) nl = len;
    let line = stdout.slice(start, nl).trim();
    start = nl + 1;
    if (!line) continue;
    if (line.indexOf("\\") !== -1) line = line.replace(/\\/g, "/");
    if (line.startsWith("./")) line = line.slice(2);
    if (!line) continue;
    out.push(prefix ? `${prefix}${line}` : line);
  }
  return out;
}

export async function runInBatches(items, concurrency, fn, shouldStop) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    if (shouldStop && shouldStop()) break;
    const chunk = items.slice(i, i + concurrency);
    const batchOut = await Promise.all(chunk.map(fn));
    results.push(...batchOut);
  }
  return results;
}

export function makeIndexKey(root, on, isWindows = false) {
  return `${normCmpStr(root, isWindows)}::${on || ""}`;
}

export function getCachedIndex(indexKey) {
  return OVERLAY_INDEX_CACHE.get(indexKey) || null;
}

export function isIndexInFlight(indexKey) {
  return INDEX_INFLIGHT.has(indexKey);
}

export function claimRootWatcher(indexKey, token, isPanel = false) {
  const cur = ACTIVE_ROOT_WATCHERS.get(indexKey);
  if (cur && cur.isPanel && !isPanel) return false;
  ACTIVE_ROOT_WATCHERS.set(indexKey, { token, isPanel });
  return true;
}

export function ownsRootWatcher(indexKey, token) {
  return ACTIVE_ROOT_WATCHERS.get(indexKey)?.token === token;
}

export function hasActiveRootWatcher(indexKey) {
  return ACTIVE_ROOT_WATCHERS.has(indexKey);
}

export function releaseRootWatcher(indexKey, token) {
  const cur = ACTIVE_ROOT_WATCHERS.get(indexKey);
  if (cur && cur.token === token) {
    ACTIVE_ROOT_WATCHERS.delete(indexKey);
  }
}

export function setIndexWatching(indexKey, watching) {
  const cached = OVERLAY_INDEX_CACHE.get(indexKey);
  if (cached) cached.watching = Boolean(watching);
}

// Detect whether the active workspace space has at least one open non-runner agent (never plain shells only).
export function hasOpenAgentInSpace(targetSpace = null) {
  const allSpaces = spaces() || [];
  const space = targetSpace || allSpaces.find(s => s.active) || null;
  const f = focused();
  const allTerms = terminals() || [];
  const termByAddr = new Map();
  for (const term of allTerms) {
    if (term?.address) termByAddr.set(term.address, term);
  }
  const isRunner = (pane, term) =>
    pane?.labels?.cognivisorRunner === "true" || term?.labels?.cognivisorRunner === "true";

  const spaceId = space?.id || f?.space || null;
  const spaceTabIds = new Set((space?.tabs || []).map(t => t?.id).filter(Boolean));
  if (!spaceTabIds.size && f?.tab) spaceTabIds.add(f.tab);

  for (const a of agents() || []) {
    if (!a?.address) continue;
    const term = termByAddr.get(a.address) || null;
    if (isRunner(null, term)) continue;
    if ((spaceId && a.space === spaceId) || (a.tab && spaceTabIds.has(a.tab))) {
      return true;
    }
  }

  for (const p of panes() || []) {
    if (!p?.terminal) continue;
    if (spaceTabIds.size > 0 && !spaceTabIds.has(p.tab)) continue;
    const term = termByAddr.get(p.terminal) || null;
    if (isRunner(p, term)) continue;
    if (
      p.program?.agent === true ||
      term?.program?.agent === true ||
      Boolean(term?.report) ||
      Boolean(p.status) ||
      Boolean(term?.status)
    ) {
      return true;
    }
  }

  if (f?.agent) {
    const focusedTerm = termByAddr.get(f.agent) || null;
    if (!isRunner(null, focusedTerm) && (!spaceId || !f.space || f.space === spaceId)) {
      return true;
    }
  }

  return false;
}

// Detect whether the active workspace space has at least one open non-runner terminal (plain shell or agent).
export function hasOpenTerminalInSpace(targetSpace = null) {
  const allSpaces = spaces() || [];
  const space = targetSpace || allSpaces.find(s => s.active) || null;
  const f = focused();
  const allTerms = terminals() || [];
  const termByAddr = new Map();
  for (const term of allTerms) {
    if (term?.address) termByAddr.set(term.address, term);
  }
  const isRunner = (pane, term) =>
    pane?.labels?.cognivisorRunner === "true" || term?.labels?.cognivisorRunner === "true";

  const spaceId = space?.id || f?.space || null;
  const spaceTabIds = new Set((space?.tabs || []).map(t => t?.id).filter(Boolean));
  if (!spaceTabIds.size && f?.tab && (!spaceId || !f?.space || f.space === spaceId)) {
    spaceTabIds.add(f.tab);
  }
  const otherSpaceTabIds = new Set();
  for (const sp of allSpaces) {
    if (spaceId && sp?.id === spaceId) continue;
    for (const t of sp?.tabs || []) {
      if (t?.id) otherSpaceTabIds.add(t.id);
    }
  }

  for (const p of panes() || []) {
    if (!p?.terminal) continue;
    if (spaceTabIds.size > 0) {
      if (!spaceTabIds.has(p.tab)) continue;
    } else if (otherSpaceTabIds.has(p.tab) || (space && !f?.tab)) {
      continue;
    }
    const term = termByAddr.get(p.terminal) || null;
    if (isRunner(p, term)) continue;
    return true;
  }

  for (const a of agents() || []) {
    if (!a?.address) continue;
    const term = termByAddr.get(a.address) || null;
    if (isRunner(null, term)) continue;
    if ((spaceId && a.space === spaceId) || (a.tab && spaceTabIds.has(a.tab))) {
      return true;
    }
  }

  if (f?.terminal || f?.agent) {
    const focusedAddr = f.terminal || f.agent;
    const focusedTerm = termByAddr.get(focusedAddr) || null;
    if (!isRunner(null, focusedTerm) && (!spaceId || !f.space || f.space === spaceId)) {
      return true;
    }
  }

  return false;
}

function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sanitizeSlug(name) {
  return String(name || "workspace")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
}

function getWorkspaceCachePath(root, on, isWindows) {
  let baseAppHome = "";
  try {
    baseAppHome = typeof appHome === "function" ? appHome() : "";
  } catch {
    baseAppHome = "";
  }
  if (!baseAppHome) return null;
  const normRoot = normPathStr(root);
  const baseName = normRoot.split("/").filter(Boolean).pop() || "root";
  const hash = fnv1aHex(makeIndexKey(root, on, isWindows));
  const dir = join(baseAppHome, "cognivisor", "workspaces", `${sanitizeSlug(baseName)}-${hash}`);
  return { dir, filePath: join(dir, "files-index.json") };
}

function putIndexCache(indexKey, record) {
  if (OVERLAY_INDEX_CACHE.has(indexKey)) {
    OVERLAY_INDEX_CACHE.delete(indexKey);
  } else if (OVERLAY_INDEX_CACHE.size >= 2) {
    const oldestKey = OVERLAY_INDEX_CACHE.keys().next().value;
    if (oldestKey !== undefined) OVERLAY_INDEX_CACHE.delete(oldestKey);
  }
  OVERLAY_INDEX_CACHE.set(indexKey, record);
}

async function yieldPeriodically(index, interval, cx) {
  if (index > 0 && index % interval === 0 && cx?.sleep) {
    await cx.sleep(0);
  }
}

export async function deriveDirsFromFiles(files, extraDirs = [], maxDirs = MAX_OVERLAY_DIRS, cx = null) {
  const dirSet = new Set();
  for (const d of extraDirs || []) {
    if (!d) continue;
    const clean = String(d).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!clean || clean === ".") continue;
    dirSet.add(clean);
    if (dirSet.size >= maxDirs) break;
  }

  for (let i = 0; i < files.length; i++) {
    await yieldPeriodically(i, 3000, cx);
    const p = files[i];
    if (!p) continue;
    let idx = p.indexOf("/");
    while (idx !== -1) {
      if (idx > 0) {
        dirSet.add(p.slice(0, idx));
        if (dirSet.size >= maxDirs) return Array.from(dirSet);
      }
      idx = p.indexOf("/", idx + 1);
    }
  }
  return Array.from(dirSet);
}

export async function hydrateIndexEntries(files, dirs, cx = null) {
  const entries = [];
  // Keep file entries before directories so empty-query initial list surfaces files first.
  for (let i = 0; i < files.length; i++) {
    await yieldPeriodically(i, 4000, cx);
    const path = files[i];
    const slash = path.lastIndexOf("/");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    entries.push({
      kind: "file",
      path,
      name,
      lowerPath: path.toLowerCase(),
      lowerName: name.toLowerCase(),
    });
  }
  for (let i = 0; i < dirs.length; i++) {
    await yieldPeriodically(i, 4000, cx);
    const path = dirs[i];
    const slash = path.lastIndexOf("/");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    entries.push({
      kind: "dir",
      path,
      name,
      lowerPath: path.toLowerCase(),
      lowerName: name.toLowerCase(),
    });
  }
  return entries;
}

export async function fsListWorkspace(root, maxFiles = MAX_OVERLAY_FILES, maxDirs = MAX_OVERLAY_DIRS) {
  if (!root) return { files: [], dirs: [] };
  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  if (!isSupportedDirentList(rootEntries)) return null;
  const files = [];
  const dirs = [];
  const queue = [];

  const pushEntries = (parentAbs, parentRel, entries) => {
    for (const e of entries) {
      if (!e?.name || e.name.startsWith(".")) continue;
      const rel = parentRel ? `${parentRel}/${e.name}` : e.name;
      if (direntIsDir(e)) {
        if (!DISCOVER_SKIP_DIRS.has(e.name)) {
          if (dirs.length < maxDirs) dirs.push(rel);
          queue.push({ abs: join(parentAbs, e.name), rel });
        }
      } else if (e.isFile?.() || (!e.isSymbolicLink?.() && !direntIsDir(e))) {
        if (files.length < maxFiles) files.push(rel);
        if (files.length >= maxFiles && dirs.length >= maxDirs) break;
      }
    }
  };

  pushEntries(root, "", rootEntries);
  let qHead = 0;
  while (qHead < queue.length && files.length < maxFiles) {
    const end = Math.min(queue.length, qHead + 16);
    const batch = queue.slice(qHead, end);
    qHead = end;
    const dirLists = await Promise.all(
      batch.map(async item => {
        const entries = await readdir(item.abs, { withFileTypes: true }).catch(() => []);
        return { item, entries };
      })
    );
    for (const { item, entries } of dirLists) {
      if (!isSupportedDirentList(entries)) continue;
      pushEntries(item.abs, item.rel, entries);
      if (files.length >= maxFiles) break;
    }
  }
  return { files, dirs };
}

export async function restoreDiskIndex(root, on, isWindows, cx) {
  if (!root) return null;
  const indexKey = makeIndexKey(root, on, isWindows);
  const existing = OVERLAY_INDEX_CACHE.get(indexKey);
  if (existing) return existing;
  if (DISK_LOAD_INFLIGHT.has(indexKey)) return DISK_LOAD_INFLIGHT.get(indexKey);
  if (DISK_LOAD_ATTEMPTED.has(indexKey)) return null;

  const task = (async () => {
    try {
      DISK_LOAD_ATTEMPTED.add(indexKey);
      if (DISK_LOAD_ATTEMPTED.size > 40) {
        const first = DISK_LOAD_ATTEMPTED.values().next().value;
        if (first !== undefined) DISK_LOAD_ATTEMPTED.delete(first);
      }
      const cachePaths = getWorkspaceCachePath(root, on, isWindows);
      if (!cachePaths) return null;
      const fileExists = await exists(cachePaths.filePath).catch(() => false);
      if (!fileExists) return null;

      const raw = await readFile(cachePaths.filePath, "utf8").catch(() => null);
      if (!raw || OVERLAY_INDEX_CACHE.has(indexKey)) return OVERLAY_INDEX_CACHE.get(indexKey) || null;

      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1) return null;
      if (makeIndexKey(parsed.root, parsed.on, isWindows) !== indexKey) return null;
      if (!Array.isArray(parsed.files)) return null;

      const files = parsed.files.slice(0, MAX_OVERLAY_FILES).filter(s => typeof s === "string" && s.length > 0);
      const dirs = Array.isArray(parsed.dirs)
        ? parsed.dirs.slice(0, MAX_OVERLAY_DIRS).filter(s => typeof s === "string" && s.length > 0)
        : await deriveDirsFromFiles(files, [], MAX_OVERLAY_DIRS, cx);
      const entries = await hydrateIndexEntries(files, dirs, cx);
      if (OVERLAY_INDEX_CACHE.has(indexKey)) return OVERLAY_INDEX_CACHE.get(indexKey);

      const record = {
        key: indexKey,
        root,
        on: on || null,
        isWindows,
        list: files,
        files,
        dirs,
        fileSet: new Set(files),
        dirSet: new Set(dirs),
        entries,
        ts: Number(parsed.ts) || Date.now(),
        dirty: false,
        needsVerify: true,
        watching: hasActiveRootWatcher(indexKey),
        fromDisk: true,
      };
      putIndexCache(indexKey, record);
      return record;
    } catch {
      return null;
    } finally {
      DISK_LOAD_INFLIGHT.delete(indexKey);
    }
  })();

  DISK_LOAD_INFLIGHT.set(indexKey, task);
  return task;
}

async function saveDiskIndex(record) {
  try {
    const cachePaths = getWorkspaceCachePath(record.root, record.on, record.isWindows);
    if (!cachePaths) return;
    await mkdir(cachePaths.dir, { recursive: true });
    await writeFile(
      cachePaths.filePath,
      JSON.stringify({
        v: 1,
        root: record.root,
        on: record.on || null,
        ts: record.ts,
        files: record.files,
        dirs: record.dirs,
      })
    );
  } catch {
    // Non-fatal: disk cache persistence must never break indexing.
  }
}

export function shouldRefreshIndex(cached, on) {
  if (!cached || !Array.isArray(cached.entries) || cached.entries.length === 0) return true;
  if (cached.dirty || cached.needsVerify) return true;
  const age = Date.now() - (cached.ts || 0);
  if (cached.watching && !on) {
    return age >= INDEX_WATCHED_TTL_MS;
  }
  return age >= OVERLAY_INDEX_FRESH_MS;
}

function markIndexDirty(indexKey, cached = null) {
  INDEX_DIRTY_SEQ.set(indexKey, (INDEX_DIRTY_SEQ.get(indexKey) || 0) + 1);
  if (cached) cached.dirty = true;
  return true;
}

// Inspect non-ignored watch paths to distinguish pure edits from file/dir additions or deletions.
export async function handleWatchForIndex(root, on, isWindows, info, changedPaths) {
  if (!root || !info?.hasNonIgnored) return false;
  const indexKey = makeIndexKey(root, on, isWindows);
  const cached = OVERLAY_INDEX_CACHE.get(indexKey);
  if (!cached) return false;

  if (info.hasGitRefChange || info.dirtyDirs?.has("*")) {
    return markIndexDirty(indexKey, cached);
  }
  if (!info.hasNonGitChange) return false;

  if (on || !Array.isArray(changedPaths) || changedPaths.length === 0 || changedPaths.length > 50) {
    return markIndexDirty(indexKey, cached);
  }

  const toVerify = [];
  for (const raw of changedPaths) {
    if (!raw || isIgnoredWatchPath(raw, root)) continue;
    const rel = getRelToWorkspace(raw, root);
    if (rel === null) {
      return markIndexDirty(indexKey, cached);
    }
    if (!rel) continue;
    const cleanRel = rel.replace(/\\/g, "/").replace(/\/+$/, "");
    const lowerClean = cleanRel.toLowerCase();
    if (lowerClean === ".gitignore" || lowerClean.endsWith("/.gitignore")) {
      return markIndexDirty(indexKey, cached);
    }
    const known = Boolean(cached.fileSet?.has(cleanRel) || cached.dirSet?.has(cleanRel));
    if (!known) {
      return markIndexDirty(indexKey, cached);
    }
    toVerify.push(cleanRel);
  }

  for (let i = 0; i < toVerify.length; i += 8) {
    const checks = await Promise.all(
      toVerify.slice(i, i + 8).map((cleanRel) => exists(joinSubPath(root, cleanRel)).catch(() => false))
    );
    if (checks.some((ok) => !ok)) {
      return markIndexDirty(indexKey, cached);
    }
  }

  // Only existing files were edited; refresh timestamp without rescanning or rewriting disk cache.
  cached.ts = Date.now();
  return false;
}

function sameIndexedSnapshot(prev, files, dirs) {
  if (!prev || !Array.isArray(prev.files) || !Array.isArray(prev.dirs)) return false;
  if (prev.files.length !== files.length || prev.dirs.length !== dirs.length) return false;
  for (let i = 0; i < files.length; i += 1) {
    if (prev.files[i] !== files[i]) return false;
  }
  for (let i = 0; i < dirs.length; i += 1) {
    if (prev.dirs[i] !== dirs[i]) return false;
  }
  return true;
}

export async function ensureWorkspaceIndex({ root, on = null, isWindows = false, discoverRepos, force = false, cx = null }) {
  if (!root) return null;
  const indexKey = makeIndexKey(root, on, isWindows);
  const cached = OVERLAY_INDEX_CACHE.get(indexKey);
  if (!force && cached && !shouldRefreshIndex(cached, on)) {
    return cached;
  }

  if (INDEX_INFLIGHT.has(indexKey)) {
    if (!force) return INDEX_INFLIGHT.get(indexKey);
    try { await INDEX_INFLIGHT.get(indexKey); } catch {}
  }

  const nextGen = (INDEX_GENERATION.get(indexKey) || 0) + 1;
  INDEX_GENERATION.set(indexKey, nextGen);
  const startDirtySeq = INDEX_DIRTY_SEQ.get(indexKey) || 0;
  const onKey = on || "local";

  const promise = (async () => {
    let files = [];
    let extraDirs = [];
    // Fast ripgrep file list (respects nested .gitignores and skips noisy directories)
    let rgRes = null;
    if (isRgAvailable(onKey) !== false) {
      if (!isWindows) {
        const rgLineCap = MAX_OVERLAY_FILES + 1;
        const rgScript = `command -v rg >/dev/null 2>&1 || exit 127; rg "$@" 2>/dev/null | head -n ${rgLineCap}`;
        rgRes = await exec(
          "sh",
          ["-c", rgScript, "sh", "--files", "--hidden", "--path-separator", "/", "--threads", "4", ...COMMON_IGNORE_GLOBS],
          { cwd: root, on, timeout: 10000 }
        ).catch(() => null);
        if (rgRes && rgRes.code === 127) {
          markRgAvailable(onKey, false);
          rgRes = null;
        } else if (rgRes) {
          markRgAvailable(onKey, true);
        } else {
          const probe = await exec("rg", ["--version"], { on, timeout: 2500 }).catch(() => null);
          markRgAvailable(onKey, Boolean(probe && probe.code === 0));
        }
      } else {
        const rgLineCap = MAX_OVERLAY_FILES + 1;
        const psGlobs = COMMON_IGNORE_GLOBS.map(g => `'${g.replace(/'/g, "''")}'`).join(",");
        const psCmd = `if (-not (Get-Command rg -ErrorAction SilentlyContinue)) { exit 127 }; & rg --files --hidden --path-separator / --threads 4 @(${psGlobs}) 2>$null | Select-Object -First ${rgLineCap}`;
        rgRes = await exec(
          "powershell",
          ["-NoProfile", "-Command", psCmd],
          { cwd: root, on, timeout: 10000 }
        ).catch(() => null);
        if (rgRes && rgRes.code === 127) {
          markRgAvailable(onKey, false);
          rgRes = null;
        } else if (rgRes) {
          markRgAvailable(onKey, true);
        } else {
          const probe = await exec("rg", ["--version"], { on, timeout: 2500 }).catch(() => null);
          markRgAvailable(onKey, Boolean(probe && probe.code === 0));
        }
      }
    }

    if (rgRes?.code === 0 && rgRes.stdout) {
      files = parseIndexedPaths(rgRes.stdout, MAX_OVERLAY_FILES);
    } else if (!rgRes || rgRes.code !== 0 || !files.length) {
      const rev = await exec(
        "git",
        [...READ_GIT, "rev-parse", "--show-toplevel"],
        { cwd: root, on, timeout: 5000 }
      ).catch(() => null);

      if (rev?.code === 0) {
        const gitRes = await exec(
          "git",
          [...READ_GIT, "ls-files", "--cached", "--others", "--exclude-standard"],
          { cwd: root, on, timeout: 8000 }
        ).catch(() => null);
        if (gitRes?.code === 0 && gitRes.stdout) {
          files = parseIndexedPaths(gitRes.stdout, MAX_OVERLAY_FILES);
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
        const services = hasBusCandidates
          ? bus.candidates
          : (typeof discoverRepos === "function" ? await discoverRepos(root, on, isWindows) : []);
        if (services && services.length > 0) {
          const collected = [];
          await runInBatches(
            services,
            4,
            async s => {
              const r = await exec(
                "git",
                [...READ_GIT, "ls-files", "--cached", "--others", "--exclude-standard"],
                { cwd: s.root, on, timeout: 6000 }
              ).catch(() => null);
              if (r?.code === 0 && r.stdout && collected.length < MAX_OVERLAY_FILES) {
                const prefix = s.relPath ? `${s.relPath}/` : "";
                const parsed = parseIndexedPaths(r.stdout, MAX_OVERLAY_FILES - collected.length, prefix);
                for (let i = 0; i < parsed.length && collected.length < MAX_OVERLAY_FILES; i++) {
                  collected.push(parsed[i]);
                }
              }
            },
            () => collected.length >= MAX_OVERLAY_FILES
          );
          files = collected;
        } else {
          const fsResult = !on ? await fsListWorkspace(root, MAX_OVERLAY_FILES, MAX_OVERLAY_DIRS) : null;
          if (fsResult && Array.isArray(fsResult.files)) {
            files = fsResult.files;
            extraDirs = fsResult.dirs || [];
          } else if (!on && isWindows) {
            const escaped = root.replace(/['‘’‚‛]/g, "$&$&");
            const cmd = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) $n = $p.TrimEnd('\\','/'); Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '[\\\\/](\\.(git|cache|next|nuxt|venv)|node_modules|target|dist|build|vendor|out|coverage|logs)([\\\\/]|$)' } | Select-Object -First 20000 -ExpandProperty FullName | ForEach-Object { $_.Substring($n.Length).TrimStart('\\','/') -replace '\\\\','/' } } '${escaped}'`;
            const psRes = await exec("powershell", ["-NoProfile", "-Command", cmd], { on }).catch(() => null);
            if (psRes?.code === 0 && psRes.stdout.trim()) {
              files = parseIndexedPaths(psRes.stdout, MAX_OVERLAY_FILES);
            }
          } else {
            const findRes = await exec(
              "sh",
              ["-c", 'find . -not -path "*/.*" -not -path "*/target/*" -not -path "*/build/*" -not -path "*/node_modules/*" -not -path "*/.venv/*" -type f | head -n 20000 | sed "s|^./||"'],
              { cwd: root, on, timeout: 10000 }
            ).catch(() => null);
            if (findRes?.code === 0 && findRes.stdout) {
              files = parseIndexedPaths(findRes.stdout, MAX_OVERLAY_FILES);
            }
          }
        }
      }
    }

    const slicedFiles = files.length > MAX_OVERLAY_FILES ? files.slice(0, MAX_OVERLAY_FILES) : files;
    const dirs = await deriveDirsFromFiles(slicedFiles, extraDirs, MAX_OVERLAY_DIRS, cx);
    const entries = await hydrateIndexEntries(slicedFiles, dirs, cx);

    // Preserve a newer watch-dirty mark raised while this scan was in flight.
    const superseded = (INDEX_GENERATION.get(indexKey) || 0) !== nextGen;
    const dirtiedMidScan = (INDEX_DIRTY_SEQ.get(indexKey) || 0) !== startDirtySeq;
    const record = {
      key: indexKey,
      root,
      on: on || null,
      isWindows,
      list: slicedFiles,
      files: slicedFiles,
      dirs,
      fileSet: new Set(slicedFiles),
      dirSet: new Set(dirs),
      entries,
      ts: Date.now(),
      dirty: superseded || dirtiedMidScan,
      needsVerify: false,
      watching: hasActiveRootWatcher(indexKey),
      fromDisk: false,
    };
    const unchangedSnapshot = Boolean(
      cached &&
      !force &&
      sameIndexedSnapshot(cached, slicedFiles, dirs) &&
      Date.now() - (cached.ts || 0) < INDEX_WATCHED_TTL_MS
    );
    putIndexCache(indexKey, record);
    if (!unchangedSnapshot) {
      await saveDiskIndex(record);
    }
    return record;
  })();

  INDEX_INFLIGHT.set(indexKey, promise);
  try {
    return await promise;
  } finally {
    if (INDEX_INFLIGHT.get(indexKey) === promise) {
      INDEX_INFLIGHT.delete(indexKey);
    }
  }
}
