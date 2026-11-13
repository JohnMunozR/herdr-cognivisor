import * as fsPromises from "fs/promises";
import { join } from "path";

const { mkdir, readFile, writeFile } = fsPromises;

function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function normRelPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function fnv1aHex(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
    return normalizeSessionBaseline(parsed);
  } catch {
    return null;
  }
}

export async function readDiskSessionBaseline(appHomeDir, tabId, workspaceRoot, branch, hasResumeCommand = false) {
  if (!appHomeDir) return null;
  const baseDir = join(String(appHomeDir), "mesh", "sessions");
  if (tabId) {
    const tabPath = join(baseDir, "tabs", `${safeTabId(tabId)}.json`);
    const fromTab = await readBaselineJsonFile(tabPath);
    if (fromTab) return fromTab;
  }
  const shouldCheckResume = typeof hasResumeCommand === "object" && hasResumeCommand !== null
    ? Boolean(hasResumeCommand.hasResumeCommand)
    : Boolean(hasResumeCommand);
  if (shouldCheckResume && workspaceRoot) {
    const resumePath = join(baseDir, "resume", `${resumeKeyHash(workspaceRoot, branch)}.json`);
    const fromResume = await readBaselineJsonFile(resumePath);
    if (fromResume) return fromResume;
  }
  return null;
}

export async function writeDiskSessionBaseline(appHomeDir, tabId, workspaceRoot, branch, data) {
  if (!appHomeDir || !data) return false;
  const normalized = normalizeSessionBaseline(data);
  if (!normalized) return false;
  const json = JSON.stringify(normalized);
  const baseDir = join(String(appHomeDir), "mesh", "sessions");
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

export function terminalHasResumeCommand(transcriptText) {
  return typeof transcriptText === "string" && /\/resume\b/i.test(transcriptText);
}

export async function statFileEntry(fullPath, status, on = null) {
  if (on) return { sig: String(status || ""), mtimeMs: 0 };
  if (!fullPath) return { sig: "deleted", mtimeMs: 0 };
  if (typeof fsPromises.stat === "function") {
    try {
      const st = await fsPromises.stat(fullPath);
      const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
      return { sig: `${st.size}:${Math.trunc(mtimeMs)}`, mtimeMs };
    } catch (err) {
      if (err && err.code === "ENOENT") return { sig: "deleted", mtimeMs: 0 };
      return { sig: String(status || ""), mtimeMs: 0 };
    }
  }
  if (typeof fsPromises.exists === "function") {
    try {
      const ok = await fsPromises.exists(fullPath);
      if (!ok) return { sig: "deleted", mtimeMs: 0 };
      if (typeof readFile === "function") {
        const buf = await readFile(fullPath);
        return { sig: `${buf.length}:${fnv1aHex(String(buf))}`, mtimeMs: 0 };
      }
    } catch {
      // fall through
    }
  }
  return { sig: String(status || ""), mtimeMs: 0 };
}

export async function computeFileSig(fullPath, status, on = null) {
  const res = await statFileEntry(fullPath, status, on);
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
