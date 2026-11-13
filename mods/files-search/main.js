// FilesSearch: File browser with search button + floating IntelliJ-style Search Everywhere dialog.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { readdir, exists } from "fs/promises";
import { join } from "path";
import {
  spaces, panes, focused, agents, hc, exec, readTextFile, watchFolder,
  theme, settings, window, layout, props, openOverlay, closeOverlay,
  shared, setShared,
} from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const activeTab = (space?.tabs || []).find(t => t.active) || null;
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const isWin = !on && window()?.platform === "windows";
  let cwd;
  const spaceFolder = space?.folder;
  const paneCwd = pane?.cwd;
  if (spaceFolder && (!paneCwd || isSameOrChildPath(paneCwd, spaceFolder, isWin))) {
    cwd = spaceFolder;
  } else {
    cwd = paneCwd || f?.cwd || spaceFolder;
  }
  return { cwd, on, space: space?.id, tabId: activeTab?.id ?? null };
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
    if (f?.name && f.name.length >= 5 && transcript.includes(f.name)) return true;
  }
  return false;
}

const DISCOVER_SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "build", "vendor",
  ".venv", "venv", ".next", ".nuxt", ".cache", "__pycache__", "out", "coverage", "logs",
]);

const WATCH_SKIP_DIRS = new Set([
  "node_modules", "target", "dist", "build", "vendor", ".venv", "venv",
  ".next", ".nuxt", ".cache", "__pycache__", "logs", ".gradle", ".idea",
  ".turbo", ".parcel-cache", "coverage", ".sass-cache", "tmp", ".tmp",
]);

const WATCH_SKIP_EXTS = [".log", ".tmp", ".swp", ".swo", ".part", ".crdownload"];
const BASE_BRANCHES = new Set(["main", "master", "development", "develop", "ci", "HEAD", ""]);
const REPO_CACHE_TTL_MS = 60000;
const WATCH_DEBOUNCE_MS = 750;
const TRANSCRIPT_THROTTLE_MS = 4000;

function normPathStr(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function normCmpStr(p, isWindows = false) {
  const s = normPathStr(p);
  return isWindows ? s.toLowerCase() : s;
}

function isSameOrChildPath(child, parent, isWindows = false) {
  const c = normCmpStr(child, isWindows);
  const p = normCmpStr(parent, isWindows);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + "/");
}

function joinSubPath(root, rel) {
  if (!rel) return root;
  if (root === "/") return `/${rel}`;
  if (/^[A-Za-z]:[\\/]?$/.test(root)) {
    return `${root.slice(0, 2)}/${rel}`;
  }
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

function isSupportedDirentList(entries) {
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

function direntIsDir(entry) {
  return typeof entry?.isDirectory === "function"
    ? Boolean(entry.isDirectory())
    : Boolean(entry?.isDirectory);
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

function findFilesBlock(node) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === "files-search" && !node.content?.props?.overlay) return node;
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

function getRelToWorkspace(changedPath, workspaceRoot) {
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

function isIgnoredWatchPath(changedPath, workspaceRoot) {
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

function analyzeWatchBatch(changedPaths, workspaceRoot, openFolders) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { hasNonIgnored: true, hasGitChange: true, hasNonGitChange: true, invalidateRepos: false, dirtyDirs: new Set(["*"]) };
  }
  let hasNonIgnored = false;
  let hasGitChange = false;
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
      if (rel.toLowerCase().includes(".git/head") || rel.toLowerCase().includes(".git/refs/")) {
        invalidateRepos = true;
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
  return { hasNonIgnored, hasGitChange, hasNonGitChange, invalidateRepos, dirtyDirs };
}

function parsePorcelainHeader(headerLine) {
  const raw = String(headerLine || "").replace(/^##\s*/, "").trim();
  if (!raw || raw.startsWith("HEAD (no branch)")) {
    return { branch: "HEAD", hasUpstream: false, ahead: 0 };
  }
  const initMatch = raw.match(/^(?:No commits yet on|Initial commit on)\s+(.+)$/i);
  if (initMatch) {
    return { branch: initMatch[1].trim(), hasUpstream: false, ahead: 0 };
  }
  const bracketMatch = raw.match(/\[([^\]]+)\]\s*$/);
  const trackingSpec = bracketMatch ? bracketMatch[1] : "";
  const withoutBracket = bracketMatch ? raw.slice(0, bracketMatch.index).trim() : raw;
  const dotIdx = withoutBracket.indexOf("...");
  const branch = (dotIdx >= 0 ? withoutBracket.slice(0, dotIdx) : withoutBracket).trim() || "HEAD";
  const hasUpstream = dotIdx >= 0;
  let ahead = hasUpstream ? 0 : null;
  if (trackingSpec) {
    const aheadMatch = trackingSpec.match(/\bahead\s+(\d+)/i);
    if (aheadMatch) ahead = parseInt(aheadMatch[1], 10) || 0;
  }
  return { branch, hasUpstream, ahead };
}

async function attributeSessionServices(tabId, touchedServices, serviceFiles, tabPaneCwds, tabTermAddrs, transcriptCache = null) {
  if (!tabId || !Array.isArray(touchedServices) || touchedServices.length === 0) return [];
  const flows = shared("mesh.flows");
  const flowObj = flows && typeof flows === "object" ? flows[tabId] : null;
  const prevSessionRepos = new Set(
    Array.isArray(flowObj?.sessionRepos)
      ? flowObj.sessionRepos.map(r => normPathStr(r))
      : []
  );

  const normCwds = (tabPaneCwds || []).map(c => normPathStr(c)).filter(Boolean);
  const needTranscript = [];
  for (const s of touchedServices) {
    const normRoot = normPathStr(s.root);
    if (!normRoot) continue;
    const inPrev = prevSessionRepos.has(normRoot);
    const inPaneCwd = normCwds.some(c => c === normRoot || c.startsWith(normRoot + "/"));
    if (!inPrev && !inPaneCwd) needTranscript.push(s);
  }

  let transcript = "";
  if (needTranscript.length > 0 && (tabTermAddrs || []).length > 0) {
    const now = Date.now();
    const unattrSig = needTranscript.map(s => s.root).sort().join("|") + "::" + (tabTermAddrs || []).join(",");
    const canReuse = transcriptCache && transcriptCache.sig === unattrSig && (now - transcriptCache.ts) < TRANSCRIPT_THROTTLE_MS;
    if (canReuse) {
      transcript = transcriptCache.text;
    } else {
      const reads = await Promise.all(
        (tabTermAddrs || []).map(addr => hc(["read", "--lines", "250", addr]).catch(() => ""))
      );
      transcript = reads.filter(Boolean).join("\n").replace(/\\/g, "/");
      if (transcriptCache) {
        transcriptCache.sig = unattrSig;
        transcriptCache.ts = now;
        transcriptCache.text = transcript;
      }
    }
  }

  const attributed = [];
  const nextSessionRepos = new Set(prevSessionRepos);

  for (const s of touchedServices) {
    const normRoot = normPathStr(s.root);
    if (!normRoot) continue;
    const inPrev = prevSessionRepos.has(normRoot);
    const inPaneCwd = normCwds.some(c => c === normRoot || c.startsWith(normRoot + "/"));
    const inTranscript = !inPrev && !inPaneCwd && repoMatchesTranscript(s, serviceFiles[s.id], transcript);

    if (inPrev || inPaneCwd || inTranscript) {
      attributed.push(s);
      nextSessionRepos.add(normRoot);
    }
  }

  if (nextSessionRepos.size !== prevSessionRepos.size) {
    const allFlows = flows && typeof flows === "object" ? { ...flows } : {};
    const cur = allFlows[tabId] && typeof allFlows[tabId] === "object" ? allFlows[tabId] : {};
    allFlows[tabId] = { ...cur, sessionRepos: [...nextSessionRepos], updatedAt: Date.now() };
    setShared("mesh.flows", allFlows);
  }

  return attributed;
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

async function fsListFiles(root, limit = 20000) {
  if (!root) return [];
  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  if (!isSupportedDirentList(rootEntries)) return null;
  const results = [];
  const queue = [];
  const pushEntries = (parentAbs, parentRel, entries) => {
    for (const e of entries) {
      if (!e?.name || e.name.startsWith(".")) continue;
      const rel = parentRel ? `${parentRel}/${e.name}` : e.name;
      if (direntIsDir(e)) {
        if (!DISCOVER_SKIP_DIRS.has(e.name)) {
          queue.push({ abs: join(parentAbs, e.name), rel });
        }
      } else if (e.isFile?.() || (!e.isSymbolicLink?.() && !direntIsDir(e))) {
        results.push(rel);
        if (results.length >= limit) break;
      }
    }
  };
  pushEntries(root, "", rootEntries);
  while (queue.length > 0 && results.length < limit) {
    const batch = queue.splice(0, 16);
    const dirLists = await Promise.all(
      batch.map(async item => {
        const entries = await readdir(item.abs, { withFileTypes: true }).catch(() => []);
        return { item, entries };
      })
    );
    for (const { item, entries } of dirLists) {
      if (!isSupportedDirentList(entries)) continue;
      pushEntries(item.abs, item.rel, entries);
      if (results.length >= limit) break;
    }
  }
  return results;
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
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

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

// Fuzzy score and hit indices for file matching
function fuzzy(q, text) {
  const t = text.toLowerCase();
  let score = 0, at = 0, run = 0;
  const hits = [];
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || /[\s:.\-_/]/.test(t[i - 1]);
    run = i === at && hits.length ? run + 1 : 0;
    score += 1 + (start ? 6 : 0) + run * 3 - Math.min(i - at, 6) * 0.3;
    hits.push(i);
    at = i + 1;
  }
  return { score: score - text.length * 0.02, hits };
}

const SHOWN = 9;
const ROW_H = 34;
const LIST_H = SHOWN * ROW_H;

export default class FilesSearch extends View {
  init(_props, cx) {
    this.isOverlay = Boolean(props()?.overlay);
    if (this.isOverlay) {
      this.initOverlay(cx);
    } else {
      this.initPanel(cx);
    }
  }

  // ==========================================
  // PANEL MODE (Files tab with Search Icon)
  // ==========================================
  initPanel(cx) {
    this.saved = new Map();
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
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
    if (
      key() !== this.context?.key ||
      (isFilesVisible() && (!this.entries.has("") || Boolean(this.error) || this.needsFolderReloadOnShow || this.dirtyFolders.size > 0))
    ) {
      this.refresh(cx, { fromWatch: this.dirtyFolders.size > 0 && key() === this.context?.key && this.entries.has("") && !this.error && !this.needsFolderReloadOnShow });
      dirty = true;
    }

    const activeReq = shared("mesh.activeService");
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
                if (!this.entries.has(accum) && !this.pending.has(accum)) {
                  const context = this.context;
                  this.pending.add(accum);
                  cx.spawn(async cx => {
                    try { await this.loadFolder(accum, context); }
                    catch {}
                    finally { if (this.context === context) this.pending.delete(accum); cx.notify(); }
                  });
                }
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
        this.openFromSearch(filePath, cx);
        return;
      }
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
          if (!this.entries.has(accum) && !this.pending.has(accum)) {
            const context = this.context;
            this.pending.add(accum);
            cx.spawn(async cx => {
              try { await this.loadFolder(accum, context); }
              catch {}
              finally { if (this.context === context) this.pending.delete(accum); cx.notify(); }
            });
          }
        }
      }
    }
    this.lastActiveServiceTs = Date.now();
    setShared("mesh.activeService", {
      workspaceRoot: this.root,
      serviceId: this.serviceFilter,
      ts: this.lastActiveServiceTs,
    });
    cx.notify();
  }

  resetServiceFilter(cx) {
    this.serviceFilter = "all";
    this.lastActiveServiceTs = Date.now();
    setShared("mesh.activeService", {
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

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      while (this.context === context) {
        try {
          const changed = await watchFolder(root);
          if (!this.current(context)) break;
          const info = analyzeWatchBatch(changed, root, this.folders);
          if (!info.hasNonIgnored) continue;
          if (info.invalidateRepos) this.candidateCache = null;
          if (info.dirtyDirs.has("*")) {
            this.dirtyFolders.add("*");
          } else {
            for (const d of info.dirtyDirs) this.dirtyFolders.add(d);
            if (info.hasNonGitChange && info.dirtyDirs.has("")) this.dirtyFolders.add("");
          }
          this.scheduleWatchRefresh(cx);
        } catch {
          if (!this.current(context)) break;
          await cx.sleep(3000);
        }
      }
      if (this.watched === root && !this.current(context)) {
        this.watched = null;
      }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root, isWindows } = context;
    const entries = await directory(joinSubPath(root, path), on, isWindows);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(
      path,
      entries
        .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    );
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx, opts = {}) {
    const { cwd, on } = location(), next = key();
    const isWindows = !on && window()?.platform === "windows";
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, serviceFilter: this.serviceFilter });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, isWindows };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.pending = new Set();
      this.marks = {};
      this.dirCounts = {};
      this.dirMarks = {};
      this.serviceCounts = {};
      this.serviceFiles = {};
      this.services = [];
      this.repoRoots = new Set();
      this.serviceFilter = saved?.serviceFilter || "all";
      this.show(null);
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
      if (saved?.file) this.show(saved.file, cx);
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
    const activeTabId = activeTab?.id || null;
    const activeTabIds = new Set((activeSpace?.tabs || []).map(t => t.id));
    const allPanesList = panes() || [];
    const extraCwds = Array.from(
      new Set(allPanesList.filter(p => p?.cwd && activeTabIds.has(p.tab)).map(p => p.cwd))
    );
    const tabPaneCwds = activeTabId
      ? Array.from(new Set(allPanesList.filter(p => p.tab === activeTabId && p.cwd).map(p => p.cwd)))
      : [];
    const tabFlowObj = activeTabId && shared("mesh.flows")?.[activeTabId];
    const tabTermAddrs = activeTabId
      ? Array.from(
          new Set([
            ...(tabFlowObj?.leadTerminal ? [tabFlowObj.leadTerminal] : []),
            ...allPanesList.filter(p => p.tab === activeTabId && p.terminal && p.labels?.meshRunner !== "true").map(p => p.terminal),
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
          const foldersToLoad = shouldReloadAll
            ? ["", ...this.folders]
            : [...new Set(["", ...this.folders].filter(f => watchDirty.has(f)))];
          for (const path of foldersToLoad) {
            if (!this.current(context)) return;
            await this.loadFolder(path, context);
          }
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

        for (const { service, branch, fileEntries, ahead } of statusResults) {
          serviceAhead[service.id] = ahead || 0;
          serviceBranches[service.id] = branch || "";
          if (!fileEntries.length) continue;
          let count = 0;
          const touchedList = [];
          for (const entry of fileEntries.slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            const rawRel = entry.slice(3);
            const relFile = rawRel.replace(/\/+$/, "");
            if (!relFile) continue;
            const fullPath = `${service.root}/${relFile}`;
            const cmpFile = normCmpStr(fullPath, isWindows);
            const mark = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
            marks[fullPath] = mark;
            marks[cmpFile] = mark;
            count++;
            touchedList.push({ name: relFile, fullPath, mark });

            const cmpCwd = normCmpStr(cwd, isWindows);
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
          serviceCounts[service.id] = count;
          serviceFiles[service.id] = touchedList;
        }

        const prevBus = shared("mesh.services");
        const normBusRoot = prevBus?.workspaceRoot ? normPathStr(prevBus.workspaceRoot) : "";
        const prevByRoot = new Map();
        if (prevBus && normBusRoot === normCwd && Array.isArray(prevBus.services)) {
          for (const ps of prevBus.services) {
            if (ps?.root) {
              prevByRoot.set(normPathStr(ps.root), ps);
            }
          }
        }

        // Only expose touched/modified repositories in this session & tab
        const rawTouched = candidateServices
          .map(s => {
            const normRoot = normPathStr(s.root);
            const existing = prevByRoot.get(normRoot);
            return {
              ...s,
              branch: serviceBranches[s.id] || existing?.branch || s.branch || "",
              workingCount: serviceCounts[s.id] ?? 0,
              aheadCount: serviceAhead[s.id] ?? existing?.aheadCount ?? 0,
            };
          })
          .filter(s => (s.workingCount || 0) > 0 || (s.aheadCount || 0) > 0);

        const enrichedServices = activeTabId
          ? await attributeSessionServices(activeTabId, rawTouched, serviceFiles, tabPaneCwds, tabTermAddrs, this.lastTranscriptScan)
          : rawTouched;
        if (!this.current(context)) return;

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
          setShared("mesh.services", {
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

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) {
        if (folder === path || folder.startsWith(path + "/")) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try {
            await this.loadFolder(path, context);
          } catch (e) {
            if (this.current(context)) this.error = String(e);
          } finally {
            if (this.context === context) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release();
    this.code = null;
    this.file = path;
    this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    const isAbs = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
    const targetPath = isAbs ? path : `${root}/${path}`;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(targetPath, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family,
          font_size: 12,
          syntax: {
            keyword: t.ansi5,
            string: t.ansi2,
            comment: t.dim,
            function: t.ansi4,
            type: t.ansi3,
            number: t.ansi1,
            constant: t.ansi6,
          },
        });
      } catch {
        if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)";
      } finally {
        cx.notify();
      }
    });
  }

  // Open a file from external/search selection and expand its parent folders in the tree
  openFromSearch(path, cx) {
    if (!path) return;
    const segments = path.split("/");
    let accum = "";
    for (let i = 0; i < segments.length - 1; i++) {
      accum = accum ? `${accum}/${segments[i]}` : segments[i];
      this.folders.add(accum);
      if (!this.entries.has(accum) && !this.pending.has(accum)) {
        const context = this.context;
        this.pending.add(accum);
        cx.spawn(async cx => {
          try { await this.loadFolder(accum, context); }
          catch {}
          finally { if (this.context === context) this.pending.delete(accum); cx.notify(); }
        });
      }
    }
    this.show(path, cx);
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
        root: this.root || currentLoc.cwd,
        on: this.on || currentLoc.on,
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

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;

    const selectedService = (this.serviceFilter && this.serviceFilter !== "all")
      ? this.services?.find(s => s.id === this.serviceFilter)
      : null;

    if (depth === 0 && selectedService?.isSibling) {
      const siblingFiles = this.serviceFiles?.[selectedService.id] ?? [];
      for (const sf of siblingFiles.slice(0, TOTAL)) {
        out.push(
          h_flex().id(`sibling-file-${sf.fullPath}`).h(28).flex_none().pl(8).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => this.show(sf.fullPath, cx))
            .child(div().w(12).flex_none())
            .child(svg("mods/files-search/file.svg").size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().child(sf.name))
            .child(div().flex_none().text_size(11).font_medium().text_color(t.blocked).child(sf.mark))
        );
      }
      return out;
    }

    const filterRel = selectedService?.relPath || null;

    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (filterRel) {
        const matches = path === filterRel || path.startsWith(filterRel + "/") || filterRel.startsWith(path + "/");
        if (!matches) continue;
      }

      const open = this.folders.has(path);
      const isWin = Boolean(this.context?.isWindows);
      const fullPath = joinSubPath(this.root, path);
      const normFullPath = normPathStr(fullPath);
      const cmpFullPath = normCmpStr(fullPath, isWin);
      const isRepo = Boolean(entry.dir && (this.repoRoots?.has(fullPath) || this.repoRoots?.has(normFullPath) || this.repoRoots?.has(cmpFullPath)));
      const dirCount = entry.dir ? (this.dirCounts?.[fullPath] || this.dirCounts?.[normFullPath] || this.dirCounts?.[cmpFullPath] || 0) : 0;
      const mark = this.marks[fullPath] || this.marks[normFullPath] || this.marks[cmpFullPath];

      out.push(
        h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => (entry.dir ? this.toggle(path, cx) : this.show(path, cx)))
          .child(entry.dir ? svg(`mods/files-search/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
          .child(svg(`mods/files-search/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(div().truncate().child(entry.name))
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
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  renderPanel(cx) {
    const visible = isFilesVisible();
    const becameVisible = visible && !this.wasVisible;
    this.wasVisible = visible;

    const activeReq = shared("mesh.activeService");
    const hasActiveReq = Boolean(activeReq && activeReq.ts && activeReq.ts > (this.lastActiveServiceTs || 0));
    const selectReq = shared("files-search.select");
    const hasSelectReq = Boolean(selectReq && selectReq.ts && selectReq.ts > (this.lastSelectedTs || 0));

    if (
      key() !== this.context?.key ||
      (becameVisible && (!this.entries.has("") || Boolean(this.error) || this.needsFolderReloadOnShow || this.dirtyFolders.size > 0)) ||
      hasActiveReq ||
      hasSelectReq
    ) {
      this.schedulePanelSync(cx);
    }

    const t = theme();
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
          .when(Boolean(this.file), el =>
            el.child(this.button("files-back", div().child("←"), (_e, cx) => { this.show(null); cx.notify(); }))
          )
          .child(div().font_semibold().child("Files"))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? (this.root?.split(/[\\/]/).filter(Boolean).pop() || this.root || "")))
          .child(this.button("files-search-btn", svg("mods/files-search/search.svg").size(14), () => this.openSearchOverlay()))
      )
      // Compact horizontal scrollable service quick-filter bar
      .when(Boolean((this.services?.length > 1 || (this.serviceFilter && this.serviceFilter !== "all")) && !this.file), el =>
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
      .when(!this.file, el =>
        el.child(
          v_flex()
            .id("files-tree")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .p(6)
            .children(this.rows("", 0, [], t))
            .when(Boolean(this.error) || !this.entries.get("")?.length, el =>
              el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder")))
            )
            .when(this.limited, el =>
              el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))
            )
        )
      )
      .when(Boolean(this.file), el =>
        el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"))
      );
  }

  // ==========================================
  // OVERLAY MODE (IntelliJ-style Search Everywhere)
  // ==========================================
  initOverlay(cx) {
    const p = props();
    this.searchRoot = p?.root || shared("mesh.services")?.workspaceRoot || location().cwd;
    this.searchOn = p?.on || location().on;
    this.searchIsWindows = !this.searchOn && window()?.platform === "windows";
    this.tab = "all"; // "all" | "files" | "text"
    this.query = "";
    this.fileList = [];
    this.textResults = [];
    this.isSearchingText = false;
    this.searchSeq = 0;
    this.previewReqSeq = 0;
    this.textSearchTask = null;
    this.previewDebounceTask = null;
    this.fileEntries = [];
    this._cachedResults = null;
    this._lastSearchKey = null;
    this._currentPreviewKey = null;
    this.at = 0;
    this.scroll = 0;
    this.handle = cx.focus_handle();

    // Preview state (default enabled, remembers user preference)
    const savedPreview = shared("files-search.preview");
    this.showPreview = savedPreview !== null && savedPreview !== undefined ? Boolean(savedPreview) : true;
    this.previewItem = null;
    this.previewLines = [];
    this.previewStartLine = 1;
    this.previewHasMore = false;
    this.previewLoading = false;
    this.previewLoadingMore = false;
    this.previewError = null;
    this.previewScroll = 0;
    this.previewCache = new Map();

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
      this._lastSearchKey = null;
      this._cachedResults = null;
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

    // Preload files in workspace
    this.loadWorkspaceFiles(cx);
  }

  close(cx) {
    this.focusInputTask?.cancel();
    this.focusInputTask = null;
    this.watchDebounceTask?.cancel();
    this.watchDebounceTask = null;
    this.pendingPanelSyncTask?.cancel();
    this.pendingPanelSyncTask = null;
    this.textSearchTask?.cancel();
    this.textSearchTask = null;
    this.previewDebounceTask?.cancel();
    this.previewDebounceTask = null;
    try { this.input?.release(); } catch {}
    this.input = null;
    this.code?.release();
    this.code = null;
  }

  closeOverlay() {
    this.focusInputTask?.cancel();
    this.focusInputTask = null;
    this.textSearchTask?.cancel();
    this.textSearchTask = null;
    this.previewDebounceTask?.cancel();
    this.previewDebounceTask = null;
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
    cx.stop_propagation();
    cx.notify();
  }

  handleResizeMove(e, minW, maxW, minH, maxH, cx) {
    if (!this.resizing) return;
    const totalDx = e.position.x - this.resizeStartX;
    const totalDy = e.position.y - this.resizeStartY;
    this.customWidth = Math.max(minW, Math.min(maxW, Math.round(this.resizeStartW + totalDx)));
    this.customListHeight = Math.max(minH, Math.min(maxH, Math.round(this.resizeStartH + totalDy)));
    cx.notify();
  }

  handleResizeEnd(cx) {
    if (!this.resizing) return;
    this.resizing = false;
    setShared("files-search.customSize", { w: this.customWidth, h: this.customListHeight });
    cx.notify();
  }

  selectResult(item, cx) {
    if (!item) return;
    setShared("files-search.select", {
      root: this.searchRoot,
      path: item.path,
      line: item.line || null,
      ts: Date.now(),
    });
    this.closeOverlay();
    cx.notify();
  }

  schedulePreview(item, cx, immediate = false) {
    if (!item) {
      this.previewItem = null;
      this.previewLines = [];
      this.previewStartLine = 1;
      this.previewHasMore = false;
      this.previewLoading = false;
      this.previewLoadingMore = false;
      this.previewError = null;
      this._currentPreviewKey = null;
      return;
    }

    const itemKey = `${item.path}:${item.line || 0}`;
    if (this._currentPreviewKey === itemKey && (this.previewLines.length > 0 || this.previewError)) {
      return;
    }
    this._currentPreviewKey = itemKey;
    this.previewItem = item;

    // Check memory cache first
    const cached = this.previewCache.get(itemKey);
    if (cached) {
      this.previewDebounceTask?.cancel();
      this.previewDebounceTask = null;
      this.previewLines = cached.lines;
      this.previewStartLine = cached.startLine;
      this.previewHasMore = cached.hasMore;
      this.previewError = null;
      this.previewLoading = false;
      this.previewLoadingMore = false;
      this.previewScroll = cached.scroll;
      return;
    }

    this.previewLoading = true;
    this.previewError = null;

    if (this.previewDebounceTask) {
      this.previewDebounceTask.cancel();
      this.previewDebounceTask = null;
    }

    const reqSeq = ++this.previewReqSeq;
    const root = this.searchRoot;
    const on = this.searchOn;
    const isWindows = this.searchIsWindows ?? (!on && window()?.platform === "windows");
    const targetPath = item.path;
    const targetLine = item.kind === "text" && item.line ? item.line : null;
    const startLine = targetLine ? Math.max(1, targetLine - 20) : 1;

    const fetchAction = (asyncCx) => {
      asyncCx.spawn(async cx => {
        try {
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
            lines: [...lines],
            startLine,
            hasMore: this.previewHasMore,
            scroll: this.previewScroll,
          });
        } catch {
          if (reqSeq === this.previewReqSeq) {
            this.previewError = "Cannot preview this file";
            this.previewLines = [];
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
    if (!this.previewItem || !this.previewHasMore || this.previewLoadingMore || this.previewLoading) return;
    this.previewLoadingMore = true;

    const reqSeq = this.previewReqSeq;
    const root = this.searchRoot;
    const on = this.searchOn;
    const isWindows = this.searchIsWindows ?? (!on && window()?.platform === "windows");
    const targetPath = this.previewItem.path;
    const itemKey = `${this.previewItem.path}:${this.previewItem.line || 0}`;
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

    cx.spawn(async cx => {
      try {
        let list = [];
        // Fast ripgrep file list (rg traverses sub-repositories and respects their .gitignores)
        const rgRes = await exec(
          "rg",
          [
            "--files", "--hidden", "--path-separator", "/",
            "--glob", "!.git", "--glob", "!node_modules", "--glob", "!.cache",
            "--glob", "!target", "--glob", "!build", "--glob", "!.next",
            "--glob", "!.venv", "--glob", "!vendor"
          ],
          { cwd: root, on }
        ).catch(() => null);

        if (rgRes?.code === 0 && rgRes.stdout.trim()) {
          list = rgRes.stdout
            .split(/\r?\n/)
            .map(s => s.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
            .filter(Boolean);
        } else if (!rgRes || rgRes.code !== 0) {
          // Check if root is a git repository
          const rev = await exec(
            "git",
            ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "rev-parse", "--show-toplevel"],
            { cwd: root, on }
          ).catch(() => null);

          if (rev?.code === 0) {
            const gitRes = await exec(
              "git",
              ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "ls-files", "--cached", "--others", "--exclude-standard"],
              { cwd: root, on }
            ).catch(() => null);
            if (gitRes?.code === 0 && gitRes.stdout.trim()) {
              list = gitRes.stdout
                .split(/\r?\n/)
                .map(s => s.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
                .filter(Boolean);
            }
          } else {
            // Multi-repo fallback: reuse mesh.services candidates when matching, else discoverRepos
            const bus = shared("mesh.services");
            const hasBusCandidates = Boolean(
              bus &&
              normPathStr(bus.workspaceRoot) === normPathStr(root) &&
              (bus.on || null) === (on || null) &&
              Array.isArray(bus.candidates) &&
              bus.candidates.length > 0
            );
            const services = hasBusCandidates ? bus.candidates : await discoverRepos(root, on, isWindows);
            if (services && services.length > 0) {
              const perService = await Promise.all(
                services.map(async s => {
                  const r = await exec(
                    "git",
                    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "ls-files", "--cached", "--others", "--exclude-standard"],
                    { cwd: s.root, on }
                  ).catch(() => null);
                  if (r?.code === 0 && r.stdout.trim()) {
                    const prefix = s.relPath ? `${s.relPath}/` : "";
                    return r.stdout
                      .split(/\r?\n/)
                      .map(line => line.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
                      .filter(Boolean)
                      .map(line => `${prefix}${line}`);
                  }
                  return [];
                })
              );
              list = perService.flat();
            } else {
              const fsFiles = !on ? await fsListFiles(root, 20000) : null;
              if (Array.isArray(fsFiles)) {
                list = fsFiles;
              } else if (!on && isWindows) {
                const escaped = root.replace(/['‘’‚‛]/g, "$&$&");
                const cmd = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) $n = $p.TrimEnd('\\','/'); Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '[\\\\/](\\.(git|cache|next|nuxt|venv)|node_modules|target|dist|build|vendor|out|coverage|logs)([\\\\/]|$)' } | Select-Object -First 20000 -ExpandProperty FullName | ForEach-Object { $_.Substring($n.Length).TrimStart('\\','/') -replace '\\\\','/' } } '${escaped}'`;
                const psRes = await exec("powershell", ["-NoProfile", "-Command", cmd], { on }).catch(() => null);
                if (psRes?.code === 0 && psRes.stdout.trim()) {
                  list = psRes.stdout
                    .split(/\r?\n/)
                    .map(s => s.trim())
                    .filter(Boolean);
                }
              } else {
                // Remote or POSIX find fallback
                const findRes = await exec(
                  "sh",
                  ["-c", 'find . -not -path "*/.*" -not -path "*/target/*" -not -path "*/build/*" -not -path "*/node_modules/*" -not -path "*/.venv/*" -type f | sed "s|^./||"'],
                  { cwd: root, on }
                ).catch(() => null);
                if (findRes?.code === 0 && findRes.stdout.trim()) {
                  list = findRes.stdout
                    .split(/\r?\n/)
                    .map(s => s.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
                    .filter(Boolean);
                }
              }
            }
          }
        }

        const sliced = list.slice(0, 20000);
        this.fileList = sliced;
        this.fileEntries = sliced.map(path => {
          const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
          return {
            path,
            name,
            lowerPath: path.toLowerCase(),
            lowerName: name.toLowerCase(),
          };
        });
        this._lastSearchKey = null;
        this._cachedResults = null;
      } catch (err) {
        this.fileList = [];
        this.fileEntries = [];
      } finally {
        cx.notify();
      }
    });
  }

  triggerTextSearch(cx) {
    const q = this.query.trim();
    if (this.tab === "files" || !q || q.length < 2) {
      this.textResults = [];
      this.isSearchingText = false;
      this._lastSearchKey = null;
      this._cachedResults = null;
      if (this.textSearchTask) {
        this.textSearchTask.cancel();
        this.textSearchTask = null;
      }
      return;
    }

    const seq = ++this.searchSeq;
    const root = this.searchRoot;
    const on = this.searchOn;
    const isWindows = this.searchIsWindows ?? (!on && window()?.platform === "windows");
    this.isSearchingText = true;

    if (this.textSearchTask) {
      this.textSearchTask.cancel();
      this.textSearchTask = null;
    }

    this.textSearchTask = cx.timer.after(160, cx => {
      cx.spawn(async cx => {
        try {
          const rgBaseArgs = [
            "--vimgrep", "--no-heading", "--color=never", "--smart-case",
            "--path-separator", "/", "--max-count=8", "--max-columns=200",
            "--glob", "!.git", "--glob", "!node_modules", "--glob", "!.cache",
            "--glob", "!target", "--glob", "!build", "--glob", "!.next", "--glob", "!.venv",
          ];
          const parseSearchLines = (stdout, prefix = "", cap = 35, out = []) => {
            for (const line of String(stdout || "").split(/\r?\n/)) {
              if (!line.trim()) continue;
              const m = line.match(/^([^:]+):(\d+):(?:(\d+):)?(.*)$/);
              if (m) {
                const normRel = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
                out.push({
                  kind: "text",
                  path: `${prefix}${normRel}`,
                  line: parseInt(m[2], 10),
                  content: m[4].trim(),
                  matchedQuery: q,
                });
              }
              if (out.length >= cap) break;
            }
            return out;
          };

          let res = await exec("rg", [...rgBaseArgs, "--", q], { cwd: root, on }).catch(() => null);
          if (res && res.code === 2) {
            // Query contains unescaped regex characters; retry as literal fixed string.
            res = await exec("rg", [...rgBaseArgs, "-F", "--", q], { cwd: root, on }).catch(() => null);
          }

          let results = [];
          if (res && res.code === 0) {
            if (res.stdout) parseSearchLines(res.stdout, "", 35, results);
          } else if (res && res.code === 1) {
            // Ripgrep exit code 1 means zero matches (not missing ripgrep).
            results = [];
          } else {
            // Fallback when rg is unavailable or failed unexpectedly
            const rev = await exec(
              "git",
              ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "rev-parse", "--show-toplevel"],
              { cwd: root, on }
            ).catch(() => null);

            if (rev?.code === 0) {
              const gitRes = await exec(
                "git",
                ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "grep", "-nI", "-F", "-i", "-m", "8", "--", q],
                { cwd: root, on }
              ).catch(() => null);
              if (gitRes && gitRes.stdout) {
                parseSearchLines(gitRes.stdout, "", 35, results);
              }
            } else {
              const bus = shared("mesh.services");
              const hasBusCandidates = Boolean(
                bus &&
                normPathStr(bus.workspaceRoot) === normPathStr(root) &&
                (bus.on || null) === (on || null) &&
                Array.isArray(bus.candidates) &&
                bus.candidates.length > 0
              );
              const services = hasBusCandidates ? bus.candidates : await discoverRepos(root, on, isWindows);
              if (services && services.length > 0) {
                const perRepo = await Promise.all(
                  services.map(async s => {
                    const sRes = await exec(
                      "git",
                      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "grep", "-nI", "-F", "-i", "-m", "8", "--", q],
                      { cwd: s.root, on }
                    ).catch(() => null);
                    if (!sRes || !sRes.stdout) return [];
                    const prefix = s.relPath ? `${s.relPath}/` : "";
                    return parseSearchLines(sRes.stdout, prefix, 35, []);
                  })
                );
                for (const batch of perRepo) {
                  for (const item of batch) {
                    results.push(item);
                    if (results.length >= 35) break;
                  }
                  if (results.length >= 35) break;
                }
              }
            }
          }

          if (seq !== this.searchSeq) return;
          this.textResults = results;
          this._lastSearchKey = null;
          this._cachedResults = null;
        } catch {
          if (seq === this.searchSeq) {
            this.textResults = [];
            this._lastSearchKey = null;
            this._cachedResults = null;
          }
        } finally {
          if (seq === this.searchSeq) {
            this.isSearchingText = false;
            cx.notify();
          }
        }
      });
    });
  }

  setTab(tab, cx) {
    this.tab = tab;
    this.at = 0;
    this.scroll = 0;
    this._lastSearchKey = null;
    this._cachedResults = null;
    if (tab === "text" || tab === "all") {
      this.triggerTextSearch(cx);
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

  // Returns array of items: { kind: 'file'|'text', path, name, hits, score, line?, content?, matchedQuery? }
  searchResults() {
    const rawQ = this.query.trim().toLowerCase();
    const cacheKey = `${this.tab}:${rawQ}:${this.textResults.length}`;
    if (this._lastSearchKey === cacheKey && this._cachedResults) {
      return this._cachedResults;
    }

    const q = rawQ.replace(/\s+/g, "");

    // 1. Matched files
    let matchedFiles = [];
    if (this.tab === "all" || this.tab === "files") {
      const entries = this.fileEntries && this.fileEntries.length ? this.fileEntries : this.fileList.map(path => {
        const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
        return { path, name, lowerPath: path.toLowerCase(), lowerName: name.toLowerCase() };
      });

      if (!rawQ) {
        matchedFiles = entries.slice(0, 30).map(e => ({
          kind: "file",
          path: e.path,
          name: e.name,
          score: 0,
          hits: [],
        }));
      } else {
        const qLen = q.length;
        const hasSlash = q.includes("/");
        const scored = [];

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const targetStr = hasSlash ? entry.lowerPath : entry.lowerName;
          let at = 0;
          let match = true;
          for (let j = 0; j < qLen; j++) {
            at = targetStr.indexOf(q[j], at);
            if (at === -1) {
              match = false;
              break;
            }
            at++;
          }
          if (!match && !hasSlash) {
            at = 0;
            match = true;
            for (let j = 0; j < qLen; j++) {
              at = entry.lowerPath.indexOf(q[j], at);
              if (at === -1) {
                match = false;
                break;
              }
              at++;
            }
          }
          if (!match) continue;

          const matchName = fuzzy(q, entry.name);
          if (matchName) {
            scored.push({
              kind: "file",
              path: entry.path,
              name: entry.name,
              score: matchName.score + 15,
              hits: matchName.hits,
            });
          } else {
            const matchPath = fuzzy(q, entry.path);
            if (matchPath) {
              scored.push({
                kind: "file",
                path: entry.path,
                name: entry.name,
                score: matchPath.score,
                hits: [],
              });
            }
          }
          if (scored.length >= 250 && qLen <= 2) break;
        }
        scored.sort((a, b) => b.score - a.score);
        matchedFiles = scored.slice(0, 50);
      }
    }

    // 2. Matched text
    const textItems = (this.tab === "all" || this.tab === "text") ? this.textResults : [];

    let out;
    if (this.tab === "files") out = matchedFiles;
    else if (this.tab === "text") out = textItems;
    else out = [...matchedFiles.slice(0, 25), ...textItems.slice(0, 25)];

    this._lastSearchKey = cacheKey;
    this._cachedResults = out;
    return out;
  }

  renderHighlightedTitle(t, text, hits, isSelected) {
    if (!hits || !hits.length) {
      return div().text_color(isSelected ? t.foreground : t.muted).child(text);
    }
    const parts = [];
    let cur = "";
    let lit = false;
    [...text].forEach((ch, i) => {
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
          .child(s.replace(/ /g, "\u00a0"))
      )
    );
  }

  renderTextSnippet(t, content, query, isSelected) {
    if (!content || !query) return div().text_color(t.dim).child(content);
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerContent.indexOf(lowerQuery);
    if (idx < 0) {
      return div().text_size(11.5).truncate().text_color(t.dim).child(content);
    }

    const before = content.slice(0, idx);
    const match = content.slice(idx, idx + query.length);
    const after = content.slice(idx + query.length);

    return h_flex()
      .text_size(11.5)
      .truncate()
      .child(div().text_color(t.dim).child(before.replace(/ /g, "\u00a0")))
      .child(div().text_color(t.ansi4).font_semibold().child(match.replace(/ /g, "\u00a0")))
      .child(div().text_color(t.dim).child(after.replace(/ /g, "\u00a0")));
  }

  renderSyntaxLine(t, text, ext, query, isTarget) {
    if (!text) return div().child("\u00a0");
    const clean = text.replace(/\t/g, "    ");

    const tokenRegex = /(\/\/.*$|#.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:class|public|private|protected|static|final|abstract|interface|extends|implements|import|package|return|new|this|super|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|void|int|long|short|byte|float|double|boolean|char|const|let|var|function|def|fn|async|await|export|from|as|type|struct|impl|trait|pub|mut|match|enum|select|defer|go)\b|\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\()|\b[A-Z][a-zA-Z0-9_]*\b|\b(?:true|false|null|nil|None|undefined|[A-Z0-9_]{2,})\b|\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b)/g;

    const spans = [];
    let lastIndex = 0;
    let match;
    const lowerQ = query ? query.toLowerCase() : "";

    const addTextChunk = (str, color, isBold = false) => {
      if (!str) return;
      if (lowerQ && str.toLowerCase().includes(lowerQ)) {
        const lowerStr = str.toLowerCase();
        let cur = 0;
        let qIdx = lowerStr.indexOf(lowerQ, cur);
        while (qIdx !== -1) {
          if (qIdx > cur) {
            spans.push({ text: str.slice(cur, qIdx), color, bold: isBold });
          }
          spans.push({ text: str.slice(qIdx, qIdx + query.length), color: t.background, bold: true, bg: t.accent });
          cur = qIdx + query.length;
          qIdx = lowerStr.indexOf(lowerQ, cur);
        }
        if (cur < str.length) {
          spans.push({ text: str.slice(cur), color, bold: isBold });
        }
      } else {
        spans.push({ text: str, color, bold: isBold });
      }
    };

    while ((match = tokenRegex.exec(clean)) !== null) {
      if (match.index > lastIndex) {
        addTextChunk(clean.slice(lastIndex, match.index), isTarget ? t.foreground : t.muted);
      }
      const tok = match[0];
      let color = isTarget ? t.foreground : t.muted;
      let bold = false;

      if (tok.startsWith("//") || tok.startsWith("#")) {
        color = t.dim;
      } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith("`")) {
        color = t.ansi2;
      } else if (/^\d/.test(tok) || tok.startsWith("0x")) {
        color = t.ansi1;
      } else if (/^(true|false|null|nil|None|undefined)$/.test(tok) || (tok.length > 1 && tok === tok.toUpperCase() && /^[A-Z0-9_]+$/.test(tok))) {
        color = t.ansi6;
      } else if (/^(class|public|private|protected|static|final|abstract|interface|extends|implements|import|package|return|new|this|super|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|void|int|long|short|byte|float|double|boolean|char|const|let|var|function|def|fn|async|await|export|from|as|type|struct|impl|trait|pub|mut|match|enum|select|defer|go)$/.test(tok)) {
        color = t.ansi5;
        bold = true;
      } else if (/^[A-Z]/.test(tok)) {
        color = t.ansi3;
      } else {
        color = t.ansi4;
      }

      addTextChunk(tok, color, bold);
      lastIndex = tokenRegex.lastIndex;
    }

    if (lastIndex < clean.length) {
      addTextChunk(clean.slice(lastIndex), isTarget ? t.foreground : t.muted);
    }

    if (spans.length === 0) {
      return div().child(clean ? clean.replace(/ /g, "\u00a0") : "\u00a0");
    }

    const row = h_flex().items_center();
    spans.forEach((s) => {
      const el = div()
        .text_size(11.5)
        .font_family(settings()?.font_family || "monospace")
        .text_color(s.color)
        .when(Boolean(s.bold), d => d.font_semibold())
        .when(Boolean(s.bg), d => d.bg(s.bg).rounded(2).px(2))
        .child(s.text.replace(/ /g, "\u00a0"));
      row.child(el);
    });
    return row;
  }

  renderHighlightedCodeLine(t, text, query) {
    if (!text || !query) return div().child(text ? text.replace(/\t/g, "    ").replace(/ /g, "\u00a0") : "\u00a0");
    const clean = text.replace(/\t/g, "    ");
    const lowerText = clean.toLowerCase();
    const lowerQ = query.toLowerCase();
    const idx = lowerText.indexOf(lowerQ);
    if (idx < 0) {
      return div().child(clean ? clean.replace(/ /g, "\u00a0") : "\u00a0");
    }
    const before = clean.slice(0, idx);
    const match = clean.slice(idx, idx + query.length);
    const after = clean.slice(idx + query.length);

    return h_flex()
      .child(div().child(before.replace(/ /g, "\u00a0")))
      .child(
        div()
          .bg(t.accent)
          .text_color(t.background)
          .font_semibold()
          .rounded(2)
          .px(2)
          .child(match.replace(/ /g, "\u00a0"))
      )
      .child(div().child(after.replace(/ /g, "\u00a0")));
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

    const isTextMatch = item.kind === "text" && item.line;
    const targetLine = isTextMatch ? item.line : null;
    const fileName = item.path.split("/").pop() || item.path;
    const dirPath = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
    const ext = item.path.includes(".") ? item.path.split(".").pop().toLowerCase() : "";

    const LINE_H = 21;
    const VISIBLE_ROWS = Math.max(5, Math.floor((listH + 12) / LINE_H));
    const maxScroll = Math.max(0, this.previewLines.length - VISIBLE_ROWS);
    this.previewScroll = Math.max(0, Math.min(this.previewScroll, maxScroll));

    const visibleLines = [];
    const startIdx = this.previewScroll;
    const endIdx = Math.min(this.previewLines.length, startIdx + VISIBLE_ROWS);

    for (let i = startIdx; i < endIdx; i++) {
      const lineNum = (this.previewStartLine || 1) + i;
      const isTarget = lineNum === targetLine;
      const lineContent = this.previewLines[i] ?? "";

      visibleLines.push(
        h_flex()
          .h(LINE_H)
          .flex_none()
          .items_center()
          .px(4)
          .gap(8)
          .cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click(() => this.selectResult({ ...item, line: lineNum }, cx))
          .when(isTarget, el => el.bg(t.selected).border_l(3).border_color(t.accent))
          .when(!isTarget, el => el.border_l(3).border_color(t.background))
          // Line Number Gutter
          .child(
            div()
              .w(38)
              .flex_none()
              .text_right()
              .text_size(11)
              .font_family(settings()?.font_family || "monospace")
              .text_color(isTarget ? t.ansi3 : t.dim)
              .when(isTarget, el => el.font_semibold())
              .child(String(lineNum))
          )
          // Line Content with Syntax Highlighting
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .child(this.renderSyntaxLine(t, lineContent, ext, isTarget ? item.matchedQuery : null, isTarget))
          )
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
          .child(svg("mods/files-search/file.svg").size(13).flex_none().text_color(t.dim))
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
                .font_family(settings()?.font_family || "monospace")
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
          .when(Boolean(this.previewLoadingMore), el =>
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
          .flex_1()
          .min_h(0)
          .overflow_hidden()
          .when(this.previewLoading && this.previewLines.length === 0, el =>
            el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child("Loading preview…"))
          )
          .when(!this.previewLoading && Boolean(this.previewError) && this.previewLines.length === 0, el =>
            el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child(this.previewError))
          )
          .when(this.previewLines.length > 0, el =>
            el
              .py(4)
              .on_scroll_wheel((e, cx) => {
                const delta = e.delta.y > 0 ? -3 : 3;
                this.previewScroll = Math.max(0, this.previewScroll + delta);
                if (this.previewHasMore && !this.previewLoadingMore) {
                  if (this.previewScroll + VISIBLE_ROWS >= this.previewLines.length - 15) {
                    this.loadNextPreviewChunk(cx);
                  }
                }
                const max = Math.max(0, this.previewLines.length - VISIBLE_ROWS);
                this.previewScroll = Math.min(this.previewScroll, max);
                cx.notify();
              })
              .children(visibleLines)
          )
          .when(!this.previewLoading && !this.previewError && this.previewLines.length === 0, el =>
            el.child(div().p(20).text_center().text_size(12).text_color(t.dim).child("Empty file"))
          )
      );
  }

  renderOverlay(cx) {
    const t = theme();
    const results = this.searchResults();
    this.at = Math.min(this.at, Math.max(0, results.length - 1));
    const currentItem = results[this.at];
    if (this.showPreview && currentItem) {
      const itemKey = `${currentItem.path}:${currentItem.line || 0}`;
      if (this._currentPreviewKey !== itemKey) {
        this.schedulePreview(currentItem, cx, false);
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

    const meshInfo = shared("mesh.services");
    const meshServices = meshInfo?.services || [];
    const hasMultipleServices = meshServices.length > 1;

    const findServiceForPath = (filePath) => {
      if (!hasMultipleServices || !filePath) return null;
      let best = null;
      for (const s of meshServices) {
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
      const isFile = item.kind === "file";
      const matchedService = findServiceForPath(item.path);

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
            svg(`mods/files-search/${isFile ? "file" : "search"}.svg`)
              .size(13)
              .flex_none()
              .text_color(isFile ? t.muted : t.ansi4)
          )
          .when(isFile, el =>
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
                  .child(div().min_w(0).child(this.renderHighlightedTitle(t, item.name, item.hits, on)))
              )
              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(item.path.includes("/") ? item.path : ""))
          )
          .when(!isFile, el =>
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
          .on_key_down((e, cx) => {
        const k = e.key;
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
          .when(this.isSearchingText, el =>
            el.child(div().text_size(11).text_color(t.dim).child("Searching text…"))
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
                          ? `No matches found for "${this.query}".`
                          : "Type to search files or text across workspace..."
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

  render(cx) {
    if (this.isOverlay) {
      return this.renderOverlay(cx);
    }
    return this.renderPanel(cx);
  }
}
