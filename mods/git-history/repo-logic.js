// Pure zero-UI repository discovery merging, branch parsing, watch filtering, and workspace/session helpers for git-history.

export const READ_GIT = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];

export const DISCOVER_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "vendor",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  "out",
  "coverage",
  "logs",
  ".gradle",
  ".idea",
  ".turbo",
]);

function normPath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  if (s === "/") return "/";
  return s.replace(/\/+$/, "");
}

function baseName(p) {
  const clean = normPath(p);
  if (!clean || clean === "/") return clean || "repo";
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

export function isHomeDirectoryRoot(dirPath, on = null, appHomeDir = "", isWindows = false) {
  const norm = normPath(dirPath);
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

export function resolveWorkspaceRoot(spaceOrOpts, activePane = undefined, extraOpts = {}) {
  let spaceFolder = null;
  let paneCwd = null;
  let fallbackCwd = null;
  let on = null;
  let isWindows = false;
  let appHomeDir = "";

  if (
    spaceOrOpts &&
    typeof spaceOrOpts === "object" &&
    activePane === undefined &&
    ("spaceFolder" in spaceOrOpts || "paneCwd" in spaceOrOpts || "fallbackCwd" in spaceOrOpts)
  ) {
    spaceFolder = spaceOrOpts.spaceFolder || null;
    paneCwd = spaceOrOpts.paneCwd || null;
    fallbackCwd = spaceOrOpts.fallbackCwd || null;
    on = spaceOrOpts.on || null;
    isWindows = Boolean(spaceOrOpts.isWindows);
    appHomeDir = spaceOrOpts.appHomeDir || "";
  } else {
    spaceFolder = typeof spaceOrOpts === "string" ? spaceOrOpts : (spaceOrOpts?.folder || null);
    paneCwd = typeof activePane === "string" ? activePane : (activePane?.cwd || null);
    fallbackCwd = extraOpts?.fallbackCwd || null;
    on = extraOpts?.on ?? activePane?.machine ?? (typeof spaceOrOpts === "object" ? spaceOrOpts?.machine : null) ?? null;
    isWindows = Boolean(extraOpts?.isWindows);
    appHomeDir = extraOpts?.appHomeDir || "";
  }

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

export function parseBranchesOutput(stdout) {
  if (typeof stdout !== "string" || !stdout) return [];
  const branches = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const parts = rawLine.includes("\x1f") ? rawLine.split("\x1f") : rawLine.split("\t");
    const headMark = (parts[0] || "").trim();
    const name = (parts[1] || "").trim();
    if (!name) continue;
    const fullName = (parts[2] || "").trim() || name;
    if (fullName.endsWith("/HEAD")) continue;
    const shortHash = (parts[3] || "").trim();
    const kind = fullName.startsWith("refs/remotes/") ? "remote" : "local";
    branches.push({
      name,
      fullName,
      kind,
      isCurrent: headMark === "*",
      shortHash,
    });
  }
  return branches;
}

export function mergeDiscoveredWithServices(discoveredRoots, cognivisorServices, spaceId = undefined) {
  let bus = cognivisorServices;
  if (
    spaceId &&
    bus &&
    typeof bus === "object" &&
    !Array.isArray(bus) &&
    !("services" in bus) &&
    !("candidates" in bus) &&
    bus[spaceId] &&
    typeof bus[spaceId] === "object"
  ) {
    bus = bus[spaceId];
  }

  const busMatchesSpace = !spaceId || !bus?.spaceId || bus.spaceId === spaceId;
  const svcList = Array.isArray(bus)
    ? bus
    : (busMatchesSpace && Array.isArray(bus?.services) ? bus.services : []);
  const candList = busMatchesSpace && !Array.isArray(bus) && Array.isArray(bus?.candidates)
    ? bus.candidates
    : [];

  const svcByRoot = new Map();
  for (const svc of svcList) {
    if (!svc || typeof svc !== "object") continue;
    const key = normPath(svc.root || svc.path || "");
    if (key) svcByRoot.set(key, svc);
  }

  const candByRoot = new Map();
  for (const cand of candList) {
    if (!cand || typeof cand !== "object") continue;
    const key = normPath(cand.root || cand.path || "");
    if (key) candByRoot.set(key, cand);
  }

  const merged = [];
  const seen = new Set();

  for (const item of Array.isArray(discoveredRoots) ? discoveredRoots : []) {
    const isObj = Boolean(item && typeof item === "object");
    const rawRoot = isObj ? (item.root || item.path || "") : item;
    const root = normPath(rawRoot);
    if (!root || seen.has(root)) continue;
    seen.add(root);

    const svc = svcByRoot.get(root);
    const cand = candByRoot.get(root);
    const dirtyCount = Number(
      svc?.workingCount ?? svc?.dirtyCount ?? (isObj ? (item.dirtyCount ?? item.workingCount) : 0) ?? 0,
    ) || 0;
    const branch = String(svc?.branch || cand?.branch || (isObj ? item.branch : "") || "");
    const fallbackName = baseName(root);
    const id = String(svc?.id || cand?.id || (isObj ? item.id : "") || fallbackName);
    const name = String(svc?.name || cand?.name || (isObj ? item.name : "") || fallbackName);

    merged.push({
      id,
      name,
      root,
      branch,
      dirtyCount,
      isDirty: dirtyCount > 0,
    });
  }

  for (const svc of svcList) {
    if (!svc || typeof svc !== "object") continue;
    const root = normPath(svc.root || svc.path || "");
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const dirtyCount = Number(svc.workingCount ?? svc.dirtyCount ?? 0) || 0;
    const fallbackName = baseName(root);
    merged.push({
      id: String(svc.id || fallbackName),
      name: String(svc.name || fallbackName),
      root,
      branch: String(svc.branch || ""),
      dirtyCount,
      isDirty: dirtyCount > 0,
    });
  }

  return merged;
}

function matchRepo(repos, candidate) {
  if (!candidate) return null;
  const targetRoot = typeof candidate === "string"
    ? normPath(candidate)
    : normPath(candidate.repoRoot || candidate.root || candidate.path || "");
  const targetId = typeof candidate === "string"
    ? candidate
    : (candidate.id || candidate.serviceId || "");

  if (targetRoot) {
    const byRoot = repos.find((r) => r && normPath(r.root) === targetRoot);
    if (byRoot) return byRoot;
  }
  if (targetId && targetId !== "all") {
    const byId = repos.find((r) => r && r.id === targetId);
    if (byId) return byId;
  }
  return null;
}

export function resolveSelectedRepo(repos, selectedRepoState, activeServiceState) {
  if (!Array.isArray(repos) || repos.length === 0) return null;

  const selectedMatch = matchRepo(repos, selectedRepoState);
  if (selectedMatch) return selectedMatch;

  const svcId = typeof activeServiceState === "string"
    ? activeServiceState
    : (activeServiceState?.serviceId || activeServiceState?.id || "");
  const svcRoot = typeof activeServiceState === "object" && activeServiceState
    ? (activeServiceState.repoRoot || activeServiceState.root || "")
    : "";
  if (svcId !== "all" && (svcId || svcRoot)) {
    const activeMatch = matchRepo(repos, activeServiceState);
    if (activeMatch) return activeMatch;
  }

  return repos[0];
}

const IGNORED_GIT_FILES = new Set([
  "index",
  "index.lock",
  "commit_editmsg",
  "fetch_head",
  "orig_head",
  "merge_msg",
  "squash_msg",
  "tag_editmsg",
  "cherry_pick_head",
  "revert_head",
  "bisect_log",
  "gitk.cache",
]);

export function shouldIgnoreGitWatchEvent(filename) {
  if (typeof filename !== "string") return true;
  const norm = normPath(filename.trim());
  if (!norm) return true;

  const lower = norm.toLowerCase();
  const gitMarker = lower.lastIndexOf("/.git/");
  let rel = gitMarker >= 0 ? norm.slice(gitMarker + 6) : norm;
  if (rel.toLowerCase().startsWith(".git/")) rel = rel.slice(5);
  rel = rel.replace(/^\/+/, "");
  if (!rel) return true;

  const segs = rel.split("/").filter(Boolean);
  const base = segs[segs.length - 1] || "";
  const baseLower = base.toLowerCase();
  const relLower = rel.toLowerCase();

  if (
    baseLower.endsWith(".lock") ||
    baseLower.endsWith(".tmp") ||
    baseLower.endsWith(".temp") ||
    baseLower.endsWith("~") ||
    baseLower.startsWith("tmp_") ||
    IGNORED_GIT_FILES.has(baseLower)
  ) {
    return true;
  }

  if (
    base === "HEAD" ||
    baseLower === "packed-refs" ||
    relLower === "refs" ||
    relLower.startsWith("refs/")
  ) {
    return false;
  }

  return true;
}

export function resolveSessionAgentTabId(space, allPanes, spaceAgentTabs) {
  const tabs = Array.isArray(space?.tabs) ? space.tabs : [];
  if (tabs.length === 0) return null;
  const panesList = Array.isArray(allPanes) ? allPanes : [];
  const hasTerminal = (tabId) =>
    Boolean(tabId) && panesList.some((p) => p && p.tab === tabId && Boolean(p.terminal));

  const activeTab = tabs.find((t) => t && t.active) || null;
  if (activeTab && hasTerminal(activeTab.id)) return activeTab.id;

  const activePanes = activeTab ? panesList.filter((p) => p && p.tab === activeTab.id) : [];
  const isViewerOnlyTab = Boolean(
    activeTab &&
    activePanes.length > 0 &&
    activePanes.every(
      (p) => !p.terminal && (p.mod === "git-history" || p.mod === "changes-review" || p.mod === "files-search"),
    ),
  );

  if (!activeTab || isViewerOnlyTab) {
    const storedId = spaceAgentTabs && space?.id ? spaceAgentTabs[space.id] : null;
    if (storedId && tabs.some((t) => t && t.id === storedId) && hasTerminal(storedId)) {
      return storedId;
    }

    const firstTerminalTab = tabs.find((t) => t && hasTerminal(t.id));
    if (firstTerminalTab) return firstTerminalTab.id;
  }

  return activeTab?.id || null;
}
