import * as fsPromises from "fs/promises";
import { join } from "path";

const { mkdir, readFile, writeFile, readdir, unlink } = fsPromises;

export const MAX_HASH_READ_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_RECENT_BASELINE_SCAN = 80;
export const DEFAULT_MAX_CLOSED_TAB_BASELINES = 40;
export const DEFAULT_DISK_BASELINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function normRelPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isHomeDirectoryRoot(folderPath, on = null, appHomeDir = "", isWindows = false) {
  const norm = normPath(folderPath);
  if (!norm) return false;
  if (norm === "~" || norm === "/root") return true;
  if (/^\/(?:home|Users)\/[^/]+$/.test(norm)) return true;
  if (/^[a-zA-Z]:\/Users\/[^/]+$/i.test(norm)) return true;
  if (!on && appHomeDir) {
    const normApp = normPath(appHomeDir);
    const cmpFolder = isWindows ? norm.toLowerCase() : norm;
    const cmpApp = isWindows ? normApp.toLowerCase() : normApp;
    if (normApp && cmpApp !== cmpFolder && cmpApp.startsWith(cmpFolder + "/")) {
      return true;
    }
  }
  return false;
}

export function resolveWorkspaceRoot({ spaceFolder, paneCwd, fallbackCwd = null, on = null, isWindows = false, appHomeDir = "" } = {}) {
  const activeCwd = paneCwd || fallbackCwd || null;
  if (spaceFolder) {
    if (activeCwd) {
      if (isHomeDirectoryRoot(spaceFolder, on, appHomeDir, isWindows)) {
        return activeCwd;
      }
      const normSpace = normPath(spaceFolder);
      const normActive = normPath(activeCwd);
      const cmpSpace = isWindows ? normSpace.toLowerCase() : normSpace;
      const cmpActive = isWindows ? normActive.toLowerCase() : normActive;
      if (cmpActive !== cmpSpace && !cmpActive.startsWith(cmpSpace + "/")) {
        return activeCwd;
      }
    }
    return spaceFolder;
  }
  return activeCwd;
}

function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function fnv1aBytes(buf) {
  let hash = 0x811c9dc5;
  if (typeof buf === "string") {
    for (let i = 0; i < buf.length; i++) {
      const code = buf.charCodeAt(i);
      hash ^= code & 0xff;
      hash = Math.imul(hash, 0x01000193);
      if (code > 0xff) {
        hash ^= (code >>> 8) & 0xff;
        hash = Math.imul(hash, 0x01000193);
      }
    }
    return { len: buf.length, hex: (hash >>> 0).toString(16).padStart(8, "0") };
  }
  const view = buf instanceof ArrayBuffer
    ? new Uint8Array(buf)
    : (ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf);
  const len = Number(view?.length) || 0;
  for (let i = 0; i < len; i++) {
    hash ^= (view[i] & 0xff);
    hash = Math.imul(hash, 0x01000193);
  }
  return { len, hex: (hash >>> 0).toString(16).padStart(8, "0") };
}

export function normalizeGitStatusMark(xy) {
  const s = String(xy || "");
  if (s.includes("U") || s === "AA" || s === "DD") return "U";
  if (s.includes("D")) return "D";
  if (s === "??" || s.includes("A")) return "A";
  return "M";
}

function safeTabId(tabId) {
  return String(tabId || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tab";
}

function resumeKeyHash(workspaceRoot, branch) {
  const normRoot = normPath(workspaceRoot);
  const normBranch = String(branch || "").trim();
  return fnv1aHex(`${normRoot}::${normBranch}`);
}

export function normalizeSessionBaseline(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const startedAtNum = Number(raw.startedAt);
  const startedAt = Number.isFinite(startedAtNum) && startedAtNum > 0 ? startedAtNum : Date.now();
  const workspaceRoot = normPath(raw.workspaceRoot || "");
  const revNum = Number(raw.rev);
  const hasRev = raw.rev !== undefined && Number.isFinite(revNum) && revNum >= 0;
  const repos = {};
  const rawRepos = raw.repos && typeof raw.repos === "object" && !Array.isArray(raw.repos) ? raw.repos : {};
  for (const [repoKey, repoVal] of Object.entries(rawRepos)) {
    const normRoot = normPath(repoKey);
    if (!normRoot || !repoVal || typeof repoVal !== "object" || Array.isArray(repoVal)) continue;
    const dirtyFiles = {};
    const rawDirty = repoVal.dirtyFiles && typeof repoVal.dirtyFiles === "object" && !Array.isArray(repoVal.dirtyFiles)
      ? repoVal.dirtyFiles
      : {};
    for (const [relFile, entryVal] of Object.entries(rawDirty)) {
      const cleanRel = normRelPath(relFile);
      if (!cleanRel || !entryVal || typeof entryVal !== "object" || Array.isArray(entryVal)) continue;
      dirtyFiles[cleanRel] = {
        status: String(entryVal.status || ""),
        sig: String(entryVal.sig || ""),
      };
    }
    const repoOut = { dirtyFiles };
    if (typeof repoVal.startHead === "string" && repoVal.startHead.trim()) {
      repoOut.startHead = repoVal.startHead.trim();
    }
    if (typeof repoVal.startBranch === "string" && repoVal.startBranch.trim()) {
      repoOut.startBranch = repoVal.startBranch.trim();
    }
    repos[normRoot] = repoOut;
  }
  const out = {
    version: 1,
    startedAt,
    workspaceRoot,
    repos,
  };
  if (hasRev) out.rev = Math.trunc(revNum);
  return out;
}

async function readBaselineJsonFile(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sessionBaseline && typeof parsed.sessionBaseline === "object"
      ? parsed.sessionBaseline
      : parsed;
    return normalizeSessionBaseline(payload);
  } catch {
    return null;
  }
}

function matchesWorkspaceRoot(baseline, workspaceRoot) {
  const normWs = normPath(workspaceRoot);
  if (!normWs || !baseline?.workspaceRoot) return true;
  return baseline.workspaceRoot === normWs;
}

export async function readDiskSessionBaseline(appHomeDir, tabId, workspaceRoot, branch, hasResumeCommand = false) {
  if (!appHomeDir) return null;
  const baseDir = join(String(appHomeDir), "cognivisor", "sessions");
  if (tabId) {
    const tabPath = join(baseDir, "tabs", `${safeTabId(tabId)}.json`);
    const fromTab = await readBaselineJsonFile(tabPath);
    if (fromTab && matchesWorkspaceRoot(fromTab, workspaceRoot)) return fromTab;
  }
  const shouldCheckResume = typeof hasResumeCommand === "object" && hasResumeCommand !== null
    ? Boolean(hasResumeCommand.hasResumeCommand)
    : Boolean(hasResumeCommand);
  if (shouldCheckResume && workspaceRoot) {
    const resumePath = join(baseDir, "resume", `${resumeKeyHash(workspaceRoot, branch)}.json`);
    const fromResume = await readBaselineJsonFile(resumePath);
    if (fromResume && matchesWorkspaceRoot(fromResume, workspaceRoot)) return fromResume;
  }
  return null;
}

export async function writeDiskSessionBaseline(appHomeDir, tabId, workspaceRoot, branch, data) {
  if (!appHomeDir || !data) return false;
  const normalized = normalizeSessionBaseline(
    workspaceRoot && !data.workspaceRoot ? { ...data, workspaceRoot } : data
  );
  if (!normalized) return false;
  const json = JSON.stringify(normalized);
  const baseDir = join(String(appHomeDir), "cognivisor", "sessions");
  let wrote = false;
  if (tabId) {
    try {
      const tabsDir = join(baseDir, "tabs");
      await mkdir(tabsDir, { recursive: true });
      await writeFile(join(tabsDir, `${safeTabId(tabId)}.json`), json, "utf8");
      wrote = true;
    } catch {
      // non-fatal on disk write failure
    }
  }
  if (workspaceRoot) {
    try {
      const resumeDir = join(baseDir, "resume");
      await mkdir(resumeDir, { recursive: true });
      await writeFile(join(resumeDir, `${resumeKeyHash(workspaceRoot, branch)}.json`), json, "utf8");
      wrote = true;
    } catch {
      // non-fatal on disk write failure
    }
  }
  return wrote;
}

export const DEFAULT_RECENT_BASELINE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function resolveSessionStartTime(flowObj, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
  const candidates = [];
  if (flowObj && typeof flowObj === "object") {
    for (const raw of [flowObj.sessionStartedAt, flowObj.createdAt, flowObj.updatedAt]) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0 && n <= nowMs) {
        candidates.push(n);
      }
    }
  }
  if (candidates.length > 0) {
    const earliest = Math.min(...candidates);
    return { startedAt: earliest, anchored: earliest < nowMs };
  }
  return { startedAt: nowMs, anchored: false };
}

export function findRecentFlowWorkspaceBaseline(
  flows,
  workspaceRoot,
  { excludeTabId = "", liveTabIds = null, maxAgeMs = DEFAULT_RECENT_BASELINE_MAX_AGE_MS, now = Date.now() } = {},
) {
  const normWs = normPath(workspaceRoot || "");
  if (!normWs || !flows || typeof flows !== "object") return null;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const maxAge = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0 ? Number(maxAgeMs) : DEFAULT_RECENT_BASELINE_MAX_AGE_MS;
  const liveRawSet = liveTabIds ? new Set(Array.from(liveTabIds).filter(Boolean)) : null;

  let best = null;
  for (const [tabId, flow] of Object.entries(flows)) {
    if (!tabId || tabId === excludeTabId) continue;
    if (liveRawSet && liveRawSet.has(tabId)) continue;
    const candidate = normalizeSessionBaseline(flow?.sessionBaseline);
    if (!candidate || candidate.workspaceRoot !== normWs) continue;
    const age = nowMs - candidate.startedAt;
    if (age < 0 || age > maxAge) continue;
    if (!best || candidate.startedAt > best.startedAt) {
      best = candidate;
    }
  }
  return best;
}

export async function findRecentWorkspaceBaseline(
  appHomeDir,
  workspaceRoot,
  {
    excludeTabId = "",
    liveTabIds = null,
    maxAgeMs = DEFAULT_RECENT_BASELINE_MAX_AGE_MS,
    maxScanFiles = DEFAULT_MAX_RECENT_BASELINE_SCAN,
    now = Date.now(),
    fsDeps = fsPromises,
  } = {},
) {
  const normWs = normPath(workspaceRoot || "");
  if (!appHomeDir || !normWs) return null;
  const readerDir = typeof fsDeps?.readdir === "function" ? fsDeps.readdir : readdir;
  if (typeof readerDir !== "function") return null;

  const tabsDir = join(String(appHomeDir), "cognivisor", "sessions", "tabs");
  let entries;
  try {
    entries = await readerDir(tabsDir);
  } catch {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const maxAge = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0 ? Number(maxAgeMs) : DEFAULT_RECENT_BASELINE_MAX_AGE_MS;
  const scanCap = Number.isFinite(Number(maxScanFiles)) && Number(maxScanFiles) > 0 ? Math.trunc(Number(maxScanFiles)) : DEFAULT_MAX_RECENT_BASELINE_SCAN;
  const safeExclude = excludeTabId ? safeTabId(excludeTabId) : "";
  let safeLiveSet = null;
  if (liveTabIds) {
    safeLiveSet = new Set();
    for (const id of liveTabIds) {
      if (id) safeLiveSet.add(safeTabId(id));
    }
  }

  const candidateFiles = [];
  for (const rawEntry of entries) {
    const name = typeof rawEntry === "string" ? rawEntry : rawEntry?.name;
    if (!name || !name.endsWith(".json")) continue;
    const fileTabId = name.slice(0, -".json".length);
    if (!fileTabId || fileTabId === safeExclude) continue;
    if (safeLiveSet && safeLiveSet.has(fileTabId)) continue;
    candidateFiles.push(name);
    if (candidateFiles.length >= scanCap) break;
  }

  const reader = typeof fsDeps?.readFile === "function" ? fsDeps.readFile : readFile;
  let best = null;
  const BATCH_SIZE = 8;
  for (let i = 0; i < candidateFiles.length; i += BATCH_SIZE) {
    const slice = candidateFiles.slice(i, i + BATCH_SIZE);
    const parsedBatch = await Promise.all(
      slice.map(async (name) => {
        try {
          const text = await reader(join(tabsDir, name), "utf8");
          const parsed = JSON.parse(text);
          const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sessionBaseline && typeof parsed.sessionBaseline === "object"
            ? parsed.sessionBaseline
            : parsed;
          return normalizeSessionBaseline(payload);
        } catch {
          return null;
        }
      })
    );
    for (const candidate of parsedBatch) {
      if (!candidate || candidate.workspaceRoot !== normWs) continue;
      const age = nowMs - candidate.startedAt;
      if (age < 0 || age > maxAge) continue;
      if (!best || candidate.startedAt > best.startedAt) {
        best = candidate;
      }
    }
  }
  return best;
}

export async function pruneDiskSessionBaselines(
  appHomeDir,
  {
    liveTabIds = null,
    maxClosedFiles = DEFAULT_MAX_CLOSED_TAB_BASELINES,
    maxAgeMs = DEFAULT_DISK_BASELINE_MAX_AGE_MS,
    now = Date.now(),
    fsDeps = fsPromises,
  } = {},
) {
  if (!appHomeDir) return { pruned: 0, remaining: 0 };
  const readerDir = typeof fsDeps?.readdir === "function" ? fsDeps.readdir : readdir;
  const reader = typeof fsDeps?.readFile === "function" ? fsDeps.readFile : readFile;
  const unlinker = typeof fsDeps?.unlink === "function" ? fsDeps.unlink : unlink;
  if (typeof readerDir !== "function" || typeof unlinker !== "function") {
    return { pruned: 0, remaining: 0 };
  }

  const tabsDir = join(String(appHomeDir), "cognivisor", "sessions", "tabs");
  let entries;
  try {
    entries = await readerDir(tabsDir);
  } catch {
    return { pruned: 0, remaining: 0 };
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return { pruned: 0, remaining: 0 };
  }

  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const ageLimit = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0 ? Number(maxAgeMs) : DEFAULT_DISK_BASELINE_MAX_AGE_MS;
  const closedCap = Number.isFinite(Number(maxClosedFiles)) && Number(maxClosedFiles) >= 0 ? Math.trunc(Number(maxClosedFiles)) : DEFAULT_MAX_CLOSED_TAB_BASELINES;

  let safeLiveSet = null;
  if (liveTabIds) {
    safeLiveSet = new Set();
    for (const id of liveTabIds) {
      if (id) safeLiveSet.add(safeTabId(id));
    }
  }

  const closedNames = [];
  let liveCount = 0;
  for (const rawEntry of entries) {
    const name = typeof rawEntry === "string" ? rawEntry : rawEntry?.name;
    if (!name || !name.endsWith(".json")) continue;
    const fileTabId = name.slice(0, -".json".length);
    if (safeLiveSet && safeLiveSet.has(fileTabId)) {
      liveCount += 1;
      continue;
    }
    closedNames.push(name);
  }

  if (closedNames.length === 0) {
    return { pruned: 0, remaining: liveCount };
  }

  const toDelete = [];
  const retainedClosed = [];
  const BATCH_SIZE = 8;
  for (let i = 0; i < closedNames.length; i += BATCH_SIZE) {
    const slice = closedNames.slice(i, i + BATCH_SIZE);
    const metaBatch = await Promise.all(
      slice.map(async (name) => {
        const fullPath = join(tabsDir, name);
        try {
          const text = await reader(fullPath, "utf8");
          const parsed = JSON.parse(text);
          const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sessionBaseline && typeof parsed.sessionBaseline === "object"
            ? parsed.sessionBaseline
            : parsed;
          const startedAt = Number(payload?.startedAt) || 0;
          return { name, fullPath, startedAt, invalid: !payload || typeof payload !== "object" };
        } catch {
          return { name, fullPath, startedAt: 0, invalid: true };
        }
      })
    );
    for (const item of metaBatch) {
      if (item.invalid || (item.startedAt > 0 && (nowMs - item.startedAt) > ageLimit)) {
        toDelete.push(item.fullPath);
      } else {
        retainedClosed.push(item);
      }
    }
  }

  if (retainedClosed.length > closedCap) {
    retainedClosed.sort((a, b) => b.startedAt - a.startedAt);
    for (let i = closedCap; i < retainedClosed.length; i++) {
      toDelete.push(retainedClosed[i].fullPath);
    }
  }

  let pruned = 0;
  for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
    const results = await Promise.all(
      toDelete.slice(i, i + BATCH_SIZE).map(p => unlinker(p).then(() => true).catch(() => false))
    );
    for (const ok of results) if (ok) pruned += 1;
  }

  return {
    pruned,
    remaining: liveCount + Math.max(0, Math.min(retainedClosed.length, closedCap)),
  };
}

export function compactFlowsMap(
  flows,
  liveTabIds = null,
  { maxClosedTabs = 25, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = {},
) {
  if (!flows || typeof flows !== "object" || Array.isArray(flows)) return {};
  const liveSet = liveTabIds ? new Set(Array.from(liveTabIds).filter(Boolean)) : null;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const ageLimit = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0 ? Number(maxAgeMs) : 7 * 24 * 60 * 60 * 1000;
  const closedCap = Number.isFinite(Number(maxClosedTabs)) && Number(maxClosedTabs) >= 0 ? Math.trunc(Number(maxClosedTabs)) : 25;

  const liveEntries = [];
  const closedEntries = [];
  for (const [tabId, rawFlow] of Object.entries(flows)) {
    if (!tabId || !rawFlow || typeof rawFlow !== "object" || Array.isArray(rawFlow)) continue;
    const { sessionBaseline: _droppedBaseline, ...rest } = rawFlow;
    const updatedAt = Number(rest.updatedAt) || Number(rest.sessionStartedAt) || 0;
    if (!liveSet || liveSet.has(tabId)) {
      liveEntries.push([tabId, rest]);
    } else {
      if (updatedAt > 0 && (nowMs - updatedAt) > ageLimit) continue;
      closedEntries.push({ tabId, flow: rest, updatedAt });
    }
  }

  closedEntries.sort((a, b) => b.updatedAt - a.updatedAt);
  const out = {};
  for (const [tabId, flow] of liveEntries) out[tabId] = flow;
  for (const item of closedEntries.slice(0, closedCap)) out[item.tabId] = item.flow;
  return out;
}

function stripAnsiEscapes(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

const RESUME_CMD_LINE_RE =
  /^(?:(?:[^\n]{0,60}?[$%>❯›•]\s+)|Running\s+)?(?:\/resume(?:\s+([a-zA-Z0-9_][a-zA-Z0-9._:/-]*))?|(?:claude|codex|gemini|opencode|antigravity)\s+(?:--)?resume(?:\s+([a-zA-Z0-9_][a-zA-Z0-9._:/-]*))?)\s*$/i;

export function terminalHasResumeCommand(transcriptText) {
  if (typeof transcriptText !== "string" || !transcriptText) return false;
  const tail = transcriptText.length > 16384 ? transcriptText.slice(-16384) : transcriptText;
  const clean = stripAnsiEscapes(tail);
  const lines = clean.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.length > 300) continue;
    if (RESUME_CMD_LINE_RE.test(line)) return true;
  }
  return false;
}

export async function statFileEntry(fullPath, status, on = null, fsDeps = fsPromises) {
  if (on) return { sig: String(status || ""), mtimeMs: 0 };
  if (!fullPath) return { sig: "deleted", mtimeMs: 0 };
  const api = fsDeps || fsPromises;
  if (typeof api.stat === "function") {
    try {
      const st = await api.stat(fullPath);
      if (typeof st?.isDirectory === "function" && st.isDirectory()) {
        return { sig: `dir:${String(status || "")}`, mtimeMs: 0 };
      }
      const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
      return { sig: `${st.size}:${Math.trunc(mtimeMs)}`, mtimeMs };
    } catch (err) {
      if (err && err.code === "ENOENT") return { sig: "deleted", mtimeMs: 0 };
      // fall through when stat is unsupported or fails transiently
    }
  }
  if (typeof api.exists === "function") {
    try {
      const ok = await api.exists(fullPath);
      if (!ok) return { sig: "deleted", mtimeMs: 0 };
    } catch {
      // fall through
    }
  }
  const reader = typeof api.readFile === "function" ? api.readFile : readFile;
  if (typeof reader === "function") {
    try {
      const buf = await reader(fullPath);
      const { len, hex } = fnv1aBytes(buf);
      return { sig: `${len}:b${hex}`, mtimeMs: 0 };
    } catch (err) {
      if (err && err.code === "ENOENT") return { sig: "deleted", mtimeMs: 0 };
      return { sig: `dir:${String(status || "")}`, mtimeMs: 0 };
    }
  }
  return { sig: String(status || ""), mtimeMs: 0 };
}

export async function computeFileSig(fullPath, status, on = null, fsDeps = fsPromises) {
  const res = await statFileEntry(fullPath, status, on, fsDeps);
  return res.sig;
}

/**
 * Bounded LRU cache mapping normalized fullPath -> { mtimeSec, size, sig } so
 * live QuickJS (where fs.stat is absent) avoids re-reading and FNV-1a hashing
 * unchanged dirty/untracked files on every 30s tick or watch refresh.
 */
export function createFileSigCache(maxEntries = 4000) {
  const cap = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0 ? Math.trunc(Number(maxEntries)) : 4000;
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      map.delete(key);
      map.set(key, hit);
      return hit;
    },
    set(key, val) {
      if (!key || !val) return;
      if (map.has(key)) map.delete(key);
      else if (map.size >= cap) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, val);
    },
    delete(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

/**
 * Batch-stat local relative paths under `root`.
 * Uses `fsDeps.stat` when available (Node), else batched GNU/BSD `stat` on POSIX
 * (`!isWindows`) to fetch `(mtimeSec, mtimeMs, size, isDir)` in ~1 process per 200 files.
 */
export async function batchStatLocalPaths(
  root,
  relPaths,
  { execFn = null, isWindows = false, fsDeps = fsPromises, chunkSize = 200, concurrency = 2 } = {},
) {
  const statMap = new Map();
  if (!root || !Array.isArray(relPaths) || relPaths.length === 0) return statMap;
  const api = fsDeps || fsPromises;

  if (typeof api?.stat === "function") {
    const batchSize = 16;
    for (let i = 0; i < relPaths.length; i += batchSize) {
      const slice = relPaths.slice(i, i + batchSize);
      await Promise.all(
        slice.map(async (rel) => {
          if (!rel) return;
          try {
            const st = await api.stat(join(root, rel));
            const isDir = typeof st?.isDirectory === "function" && Boolean(st.isDirectory());
            const mtimeMs = Number.isFinite(st?.mtimeMs) ? st.mtimeMs : 0;
            statMap.set(rel, {
              size: Number.isFinite(st?.size) ? st.size : 0,
              mtimeSec: Math.floor(mtimeMs / 1000),
              mtimeMs,
              isDir,
            });
          } catch {
            // ENOENT / permission errors handled downstream by statFileEntry
          }
        })
      );
    }
    return statMap;
  }

  if (isWindows || typeof execFn !== "function") return statMap;

  const size = Math.max(1, Math.trunc(Number(chunkSize) || 200));
  const maxConc = Math.max(1, Math.trunc(Number(concurrency) || 2));
  const chunks = [];
  for (let i = 0; i < relPaths.length; i += size) {
    chunks.push(relPaths.slice(i, i + size));
  }

  const parseGnuNulOutput = (stdout, sliceSet) => {
    if (!stdout || !stdout.includes("\0")) return 0;
    const fields = String(stdout).split("\0");
    let matched = 0;
    for (let i = 0; i + 3 < fields.length; i += 4) {
      const mtimeSec = Number(fields[i]);
      const fileSize = Number(fields[i + 1]);
      const fileType = String(fields[i + 2] || "").trim().toLowerCase();
      const rel = fields[i + 3];
      if (!rel || !sliceSet.has(rel)) continue;
      if (!Number.isFinite(mtimeSec) || !Number.isFinite(fileSize)) continue;
      statMap.set(rel, {
        size: fileSize,
        mtimeSec: Math.trunc(mtimeSec),
        mtimeMs: Math.trunc(mtimeSec) * 1000,
        isDir: fileType.includes("directory"),
      });
      matched += 1;
    }
    return matched;
  };

  const parseBsdTabOutput = (stdout, sliceSet) => {
    if (!stdout) return 0;
    const lines = String(stdout).split(/\r?\n/);
    let matched = 0;
    for (const line of lines) {
      if (!line) continue;
      const t1 = line.indexOf("\t");
      const t2 = t1 >= 0 ? line.indexOf("\t", t1 + 1) : -1;
      const t3 = t2 >= 0 ? line.indexOf("\t", t2 + 1) : -1;
      if (t1 <= 0 || t2 <= t1 || t3 <= t2) continue;
      const mtimeSec = Number(line.slice(0, t1));
      const fileSize = Number(line.slice(t1 + 1, t2));
      const fileType = line.slice(t2 + 1, t3).trim().toLowerCase();
      const rel = line.slice(t3 + 1);
      if (!rel || !sliceSet.has(rel)) continue;
      if (!Number.isFinite(mtimeSec) || !Number.isFinite(fileSize)) continue;
      statMap.set(rel, {
        size: fileSize,
        mtimeSec: Math.trunc(mtimeSec),
        mtimeMs: Math.trunc(mtimeSec) * 1000,
        isDir: fileType.includes("directory"),
      });
      matched += 1;
    }
    return matched;
  };

  for (let i = 0; i < chunks.length; i += maxConc) {
    const batch = chunks.slice(i, i + maxConc);
    await Promise.all(
      batch.map(async (slice) => {
        const sliceSet = new Set(slice);
        // GNU stat emits NUL-delimited records keyed by path (%n), so a missing file or broken symlink
        // in the chunk exits 1 without discarding or misaligning surviving entries.
        const gnuRes = await execFn("stat", ["-L", "--printf=%Y\\0%s\\0%F\\0%n\\0", "--", ...slice], { cwd: root, timeout: 4000 }).catch(() => null);
        const gnuMatched = gnuRes?.stdout ? parseGnuNulOutput(gnuRes.stdout, sliceSet) : 0;
        if (gnuMatched > 0 || (gnuRes && gnuRes.code === 0)) return;
        // BSD/macOS stat fallback (tab-delimited path-keyed output, resilient to partial ENOENT exit 1).
        const bsdRes = await execFn("stat", ["-L", "-f", "%m\t%z\t%HT\t%N", "--", ...slice], { cwd: root, timeout: 4000 }).catch(() => null);
        if (bsdRes?.stdout) {
          parseBsdTabOutput(bsdRes.stdout, sliceSet);
        }
      })
    );
  }
  return statMap;
}

/**
 * Resolve a file signature compatible with `statFileEntry`, accelerating no-`fs.stat`
 * runtimes via batched stat metadata + LRU signature cache and capping huge files so
 * QuickJS never reads/hashes multi-megabyte binaries/logs on the main thread.
 */
export async function resolveFileSigCached(
  fullPath,
  status,
  {
    on = null,
    statMeta = null,
    cache = null,
    fsDeps = fsPromises,
    maxHashBytes = MAX_HASH_READ_BYTES,
  } = {},
) {
  if (on) return { sig: String(status || ""), mtimeMs: 0, hashed: false };
  if (!fullPath) return { sig: "deleted", mtimeMs: 0, hashed: false };

  const api = fsDeps || fsPromises;
  if (typeof api?.stat === "function") {
    const res = await statFileEntry(fullPath, status, on, api);
    return { ...res, hashed: false };
  }

  if (statMeta) {
    if (statMeta.isDir) {
      return { sig: `dir:${String(status || "")}`, mtimeMs: 0, hashed: false };
    }
    const cached = cache?.get(fullPath);
    if (cached && cached.mtimeSec === statMeta.mtimeSec && cached.size === statMeta.size) {
      return { sig: cached.sig, mtimeMs: statMeta.mtimeMs, hashed: false };
    }
    if (Number.isFinite(statMeta.size) && statMeta.size > maxHashBytes) {
      const sig = `${statMeta.size}:${Math.trunc(statMeta.mtimeMs)}`;
      cache?.set(fullPath, { mtimeSec: statMeta.mtimeSec, size: statMeta.size, sig });
      return { sig, mtimeMs: statMeta.mtimeMs, hashed: false };
    }
    const res = await statFileEntry(fullPath, status, on, api);
    cache?.set(fullPath, { mtimeSec: statMeta.mtimeSec, size: statMeta.size, sig: res.sig });
    return { sig: res.sig, mtimeMs: statMeta.mtimeMs || res.mtimeMs, hashed: true };
  }

  const res = await statFileEntry(fullPath, status, on, api);
  return { ...res, hashed: true };
}

function lookupSig(entry, sigMap) {
  if (entry.sig !== undefined && entry.sig !== null) return String(entry.sig);
  if (!sigMap) return "";
  if (sigMap instanceof Map) {
    return String(sigMap.get(entry.relFile) ?? sigMap.get(entry.fullPath) ?? "");
  }
  if (typeof sigMap === "object") {
    return String(sigMap[entry.relFile] ?? sigMap[entry.fullPath] ?? "");
  }
  return "";
}

export function filterSessionDirtyEntries(entries, baselineRepo, baselineStartedAt, sigMap = null) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  if (baselineRepo && typeof baselineRepo === "object") {
    const baseDirty = baselineRepo.dirtyFiles && typeof baselineRepo.dirtyFiles === "object"
      ? baselineRepo.dirtyFiles
      : {};
    return entries.filter(entry => {
      if (!entry || !entry.relFile) return false;
      const baseEntry = baseDirty[entry.relFile];
      if (!baseEntry) return true;
      const entryStatus = String(entry.status || "");
      const entrySig = lookupSig(entry, sigMap);
      if (baseEntry.status !== entryStatus) return true;
      if (baseEntry.sig === entrySig) return false;
      if (
        entryStatus === "D" &&
        (baseEntry.sig === "deleted" || baseEntry.sig === "deleted:D") &&
        (entrySig === "deleted" || entrySig === "deleted:D")
      ) {
        return false;
      }
      return true;
    });
  }
  const startedAt = Number(baselineStartedAt) || 0;
  return entries.filter(entry => {
    if (!entry || !entry.relFile) return false;
    return Boolean(entry.mtimeMs && startedAt > 0 && entry.mtimeMs >= startedAt);
  });
}
