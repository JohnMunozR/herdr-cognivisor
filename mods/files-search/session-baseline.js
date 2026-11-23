import * as fsPromises from "fs/promises";
import { join } from "path";

const { mkdir, readFile, writeFile } = fsPromises;

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
    repos[normRoot] = { dirtyFiles };
  }
  return {
    version: 1,
    startedAt,
    workspaceRoot,
    repos,
  };
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
  { excludeTabId = "", liveTabIds = null, maxAgeMs = DEFAULT_RECENT_BASELINE_MAX_AGE_MS, now = Date.now(), fsDeps = fsPromises } = {},
) {
  const normWs = normPath(workspaceRoot || "");
  if (!appHomeDir || !normWs) return null;
  const readerDir = typeof fsDeps?.readdir === "function" ? fsDeps.readdir : fsPromises.readdir;
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
  const safeExclude = excludeTabId ? safeTabId(excludeTabId) : "";
  let safeLiveSet = null;
  if (liveTabIds) {
    safeLiveSet = new Set();
    for (const id of liveTabIds) {
      if (id) safeLiveSet.add(safeTabId(id));
    }
  }

  const reader = typeof fsDeps?.readFile === "function" ? fsDeps.readFile : readFile;
  let best = null;
  for (const rawEntry of entries) {
    const name = typeof rawEntry === "string" ? rawEntry : rawEntry?.name;
    if (!name || !name.endsWith(".json")) continue;
    const fileTabId = name.slice(0, -".json".length);
    if (!fileTabId || fileTabId === safeExclude) continue;
    if (safeLiveSet && safeLiveSet.has(fileTabId)) continue;
    let candidate = null;
    try {
      const text = await reader(join(tabsDir, name), "utf8");
      const parsed = JSON.parse(text);
      const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sessionBaseline && typeof parsed.sessionBaseline === "object"
        ? parsed.sessionBaseline
        : parsed;
      candidate = normalizeSessionBaseline(payload);
    } catch {
      candidate = null;
    }
    if (!candidate || candidate.workspaceRoot !== normWs) continue;
    const age = nowMs - candidate.startedAt;
    if (age < 0 || age > maxAge) continue;
    if (!best || candidate.startedAt > best.startedAt) {
      best = candidate;
    }
  }
  return best;
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
  const clean = stripAnsiEscapes(transcriptText);
  const lines = clean.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
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
      const entrySig = lookupSig(entry, sigMap);
      return baseEntry.status !== String(entry.status || "") || baseEntry.sig !== entrySig;
    });
  }
  const startedAt = Number(baselineStartedAt) || 0;
  return entries.filter(entry => {
    if (!entry || !entry.relFile) return false;
    return Boolean(entry.mtimeMs && startedAt > 0 && entry.mtimeMs >= startedAt);
  });
}
