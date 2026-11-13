import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, ScrollHandle } from "gpui-base";
import { readdir, exists } from "fs/promises";
import { join } from "path";
import {
  spaces, panes, focused, agents, terminals, exec, readTextFile, watchFolder,
  theme, settings, notify, hc, run, layout, props, shared, setShared, window,
} from "herdr";
import {
  DISCOVER_SKIP_DIRS,
  diffRows,
  diffSyntaxTokenColor,
  resolveDiffFileIcon,
  expandCodeTabs,
  computeDiffContentWidth,
  normPathStr,
  normCmpStr,
  isSameOrChildPath,
  isSupportedDirentList,
  direntIsDir,
  hasRelevantWatchChange,
  parsePorcelainHeader,
  getParentDir,
  formatReviewTabTitle,
  getSessionNotesKey,
  resolveSessionAgentTabId,
  pickNextUnreviewedFile,
  pickNextDirtyService,
  sortServicesDirtyFirst,
} from "./review-logic.js";

function readPlainObject(val) {
  return val && typeof val === "object" && !Array.isArray(val) ? val : {};
}

function location() {
  const space = (spaces() || []).find((s) => s.active) || null;
  const f = focused();
  const allPanes = panes() || [];
  const storedAgentTabs = readPlainObject(shared("mesh.spaceAgentTabs"));
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

  let workspaceRoot = null;
  if (space?.folder) {
    workspaceRoot = space.folder;
    if (pane?.cwd) {
      const normSpace = normCmpStr(space.folder, isWin);
      const normPane = normCmpStr(pane.cwd, isWin);
      if (normPane !== normSpace && !normPane.startsWith(normSpace + "/")) {
        workspaceRoot = pane.cwd;
      }
    }
  } else {
    workspaceRoot = pane?.cwd || null;
  }

  return { cwd: workspaceRoot, paneCwd: pane?.cwd || null, on, spaceId: space?.id ?? null, tabId: sessionTabId };
}

const key = () => {
  const loc = location();
  return JSON.stringify({ cwd: loc.cwd, on: loc.on, spaceId: loc.spaceId, tabId: loc.tabId });
};

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
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

const BASE_BRANCHES = new Set(["main", "master", "development", "develop", "ci", "HEAD", ""]);
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

async function attributeSessionRepos(tabId, touchedResults, tabPaneCwds, tabTermAddrs, transcriptCache = null) {
  if (!tabId || !Array.isArray(touchedResults) || touchedResults.length === 0) return [];
  const flows = shared("mesh.flows");
  const flowObj = flows && typeof flows === "object" ? flows[tabId] : null;
  const prevSessionRepos = new Set(
    Array.isArray(flowObj?.sessionRepos)
      ? flowObj.sessionRepos.map((r) => normPathStr(r))
      : []
  );

  const normCwds = (tabPaneCwds || []).map((c) => normPathStr(c)).filter(Boolean);
  const needTranscript = [];
  for (const res of touchedResults) {
    const normRoot = normPathStr(res.service?.root);
    if (!normRoot) continue;
    const inPrev = prevSessionRepos.has(normRoot);
    const inPaneCwd = normCwds.some((c) => c === normRoot || c.startsWith(normRoot + "/"));
    if (!inPrev && !inPaneCwd) needTranscript.push(res);
  }

  let transcript = "";
  if (needTranscript.length > 0 && (tabTermAddrs || []).length > 0) {
    const now = Date.now();
    const unattrSig = needTranscript.map((r) => r.service?.root || "").sort().join("|") + "::" + (tabTermAddrs || []).join(",");
    const canReuse = transcriptCache && transcriptCache.sig === unattrSig && (now - transcriptCache.ts) < TRANSCRIPT_THROTTLE_MS;
    if (canReuse) {
      transcript = transcriptCache.text;
    } else {
      const reads = await Promise.all(
        (tabTermAddrs || []).map((addr) =>
          hc(["read", "--lines", "250", addr]).catch(() => "")
        )
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

  for (const res of touchedResults) {
    const normRoot = normPathStr(res.service?.root);
    if (!normRoot) continue;
    const inPrev = prevSessionRepos.has(normRoot);
    const inPaneCwd = normCwds.some((c) => c === normRoot || c.startsWith(normRoot + "/"));
    const inTranscript = !inPrev && !inPaneCwd && repoMatchesTranscript(res.service, res.files, transcript);

    if (inPrev || inPaneCwd || inTranscript) {
      attributed.push(res);
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

async function repoAheadCount(root, branch, on) {
  if (!branch || BASE_BRANCHES.has(branch)) return 0;
  const refs = await exec(
    "git",
    [...READ, "for-each-ref", "--format=%(refname:short)", "refs/heads/development", "refs/heads/main", "refs/heads/master", "refs/heads/ci"],
    { cwd: root, on }
  ).catch(() => null);
  const avail = new Set((refs?.code === 0 ? refs.stdout : "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  for (const base of ["development", "main", "master", "ci"]) {
    if (!avail.has(base)) continue;
    const check = await exec("git", [...READ, "rev-list", "--count", `${base}..HEAD`], { cwd: root, on }).catch(() => null);
    if (check && check.code === 0) {
      const n = parseInt((check.stdout || "").trim(), 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

async function listCommits(root, ref, on, service) {
  if (!ref) return [];
  const r = await exec("git", [...READ, "log", ref, "-n", "30", "--format=%h%x09%s%x09%an%x09%cr%x09%H%x09%ct"], { cwd: root, on }).catch(() => null);
  if (!r || r.code !== 0) return [];
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  return lines.map((line) => {
    const [shortHash, subject, author, date, hash, ts] = line.split("\t");
    return {
      shortHash,
      subject,
      author,
      date,
      hash,
      timestamp: Number(ts) || 0,
      serviceId: service?.id || ".",
      serviceName: service?.name || "root",
      repoRoot: service?.root || root,
    };
  });
}

async function loadServiceWorkingSnapshot(service, on, includeCommits = true) {
  try {
    const git = (args) => exec("git", [...READ, ...args], { cwd: service.root, on });
    const status = await git(["status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=normal"]);
    if (status.code !== 0) throw new Error(status.stderr || `status failed on ${service.name}`);

    const records = status.stdout.split("\0").filter(Boolean);
    let branch = service.branch || "HEAD";
    let parsedAhead = null;
    const rawEntries = [];
    for (const rec of records) {
      if (rec.startsWith("## ")) {
        const parsed = parsePorcelainHeader(rec);
        branch = parsed.branch || branch;
        parsedAhead = parsed.ahead;
      } else {
        rawEntries.push(rec);
      }
    }

    const aheadCount = parsedAhead !== null
      ? parsedAhead
      : await repoAheadCount(service.root, branch, on);

    if (rawEntries.length === 0 && aheadCount === 0) {
      service.workingCount = 0;
      service.aheadCount = 0;
      service.branch = branch;
      return { service, files: [], commits: [], branch, rawCount: 0, touched: false };
    }

    const dirEntries = [];
    const fileEntries = [];
    for (const entry of rawEntries) {
      const xy = entry.slice(0, 2);
      const p = entry.slice(3);
      if (!p) continue;
      if (xy === "??" && p.endsWith("/")) {
        dirEntries.push(p.replace(/\/+$/, ""));
      } else {
        fileEntries.push({ xy, path: p.replace(/\/+$/, "") });
      }
    }
    if (dirEntries.length > 0) {
      const ls = await git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...dirEntries]).catch(() => null);
      if (ls?.code === 0 && ls.stdout) {
        for (const expandedPath of ls.stdout.split("\0").filter(Boolean)) {
          fileEntries.push({ xy: "??", path: expandedPath });
        }
      }
    }

    const commits = includeCommits ? await listCommits(service.root, branch, on, service) : [];
    let serviceHasHead = true;
    const stats = {};
    if (fileEntries.length > 0) {
      const head = await git(["rev-parse", "--verify", "HEAD"]);
      serviceHasHead = head.code === 0;
      const results = serviceHasHead
        ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
        : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];

      for (const result of results) {
        if (result.code !== 0) throw new Error(result.stderr || `diff failed on ${service.name}`);
        for (const entry of result.stdout.split("\0")) {
          const [a, d, ...parts] = entry.split("\t");
          if (!parts.length) continue;
          const p = parts.join("\t"), old = stats[p] ?? { add: 0, del: 0 };
          stats[p] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
        }
      }
    }

    const files = [];
    for (const { xy, path } of fileEntries) {
      const fresh = xy === "??";
      const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
      const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
      const stat = stats[path] ?? { add: 0, del: 0 };
      files.push({
        key: `${service.id}::${path}`,
        serviceId: service.id,
        serviceName: service.name,
        relPrefix: service.relPath,
        repoRoot: service.root,
        hasHead: serviceHasHead,
        path,
        displayPath: service.relPath ? `${service.relPath}/${path}` : (service.isSibling ? `${service.name}/${path}` : path),
        status: s,
        fresh,
        ...stat,
      });
    }

    service.workingCount = rawEntries.length;
    service.aheadCount = aheadCount;
    service.branch = branch;
    return { service, files, commits, branch, rawCount: rawEntries.length, touched: true };
  } catch (e) {
    service.workingCount = 0;
    service.aheadCount = 0;
    service.branch = service.branch || "HEAD";
    return { service, files: [], commits: [], branch: service.branch, rawCount: 0, touched: false, error: e };
  }
}

function readFlows() {
  return readPlainObject(shared("mesh.flows"));
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
  const storedAgentTabs = readPlainObject(shared("mesh.spaceAgentTabs"));
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
  setShared("mesh.flows", { ...flows, [tabId]: nextFlow });
  return nextFlow;
}

export default class ChangesReview extends View {
  init(initProps, cx) {
    const p = initProps ?? props();
    this.viewerProps = p || null;
    this.isViewer = p?.role === "viewer";

    this.files = [];
    this.allWorkingFiles = [];
    this.rows = [];
    this.diffWidth = 300;
    this.handle = cx.focus_handle();
    this.bottomTab = "review"; // "review" | "commit"
    this.reviews = []; // Cached mirror of shared("mesh.reviewNotes")[sessionKey]
    this.activeComment = null; // { fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, snippet }
    this.commentText = "";
    this.sendingReview = false;
    this.busy = false;
    this.expandedFiles = new Set();
    this.localReviewedFiles = new Set();

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
    this.lastRequestSeq = 0;
    this.lastHandledSeq = 0;
    this.panelNote = null;
    this.viewerNote = null;
    this.wasVisible = !this.isViewer && isChangesVisible();
    this.hasLoadedOnce = false;
    this.needsRefreshOnShow = false;

    this.serviceFilterScroll = ScrollHandle.new();
    this.diffScroll = ScrollHandle.new();

    this.viewMode = "working"; // "working" | "commit"
    this.commits = [];
    this.allCommits = [];
    this.serviceCommitsMap = new Map();
    this.selectedCommit = null;
    this.showCommitMenu = false;
    this.workingFiles = [];
    this.workingFilesCount = 0;

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

    // Inline review comment textarea (wraps lines and auto-grows)
    this.commentInput = TextareaState.new({ placeholder: "Add a review note…", rows: 2 });
    this.commentInput.set_soft_wrap(true);
    this.commentInput.set_auto_grow(2, 6);
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
    try { this.pollTask?.cancel?.(); } catch {}
    this.pollTask = null;
    this.stopAllWatchers();
    try { this.input?.release(); } catch {}
    try { this.commentInput?.release(); } catch {}
    try { this.serviceFilterScroll?.release(); } catch {}
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
    const storedAgentTabs = readPlainObject(shared("mesh.spaceAgentTabs"));

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

  scheduleSharedSync(cx, opts = {}) {
    if (this.sharedSyncTask || !cx?.timer) return;
    this.sharedSyncTask = cx.timer.after(0, (cx) => {
      this.sharedSyncTask = null;
      if (this.isViewerMode()) return;
      const ctx = this.getSessionContext();
      const diff = readActiveDiff(ctx.spaceId);
      const revTab = findReviewTabInSpace(ctx.spaceId);
      const sharedActive = shared("mesh.activeService");
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
    const allNotes = readPlainObject(shared("mesh.reviewNotes"));
    const list = allNotes[c.notesKey];
    return Array.isArray(list) ? list : [];
  }

  saveSessionReviews(nextReviews, ctx = null) {
    const c = ctx || this.getSessionContext();
    const prevAll = readPlainObject(shared("mesh.reviewNotes"));
    const safeList = Array.isArray(nextReviews) ? nextReviews : [];
    this.reviews = safeList;
    setShared("mesh.reviewNotes", { ...prevAll, [c.notesKey]: safeList });
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
    } else if (!hasNotes && currentStatus === "has_notes") {
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
        setShared("mesh.activeService", {
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
      if (pane?.labels?.meshRunner === "true") return true;
      const term = addr ? termMap.get(addr) : null;
      return term?.labels?.meshRunner === "true";
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

    // 1. mesh.flows[targetTabId]?.leadTerminal -> match in agents() or terminals() (excluding runners)
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

    // 2. focused()?.agent -> match in agents() (excluding meshRunner=true)
    if (f?.agent && !isRunner(f.agent, null)) {
      const focusedAgent = agentMap.get(f.agent);
      if (focusedAgent) return focusedAgent;
    }

    // 3. Non-runner agent in targetTabId (panes() + terminals() + agents(), excluding labels?.meshRunner === "true")
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

  getServiceReviewStatus(serviceId, flow, reviewsOverride = null) {
    const reviews = reviewsOverride ?? this.getSessionReviews();
    if (reviews.some((r) => r.serviceId === serviceId)) return "has_notes";
    if (flow?.reviewedServices?.[serviceId]?.status === "approved") return "approved";
    return "pending";
  }

  toggleServiceApproval(service, currentStatus, cx) {
    if (!service) return;
    if (currentStatus === "has_notes") {
      notify({
        title: "Review notes pending",
        body: `Send or clear review notes for ${service.name} before approving.`,
        level: "info",
      });
      return;
    }

    const ctx = this.getSessionContext();
    if (!ctx.sourceTabId) {
      notify({
        title: "No active tab",
        body: "Focus a workspace tab to record service review status.",
        level: "warning",
      });
      return;
    }

    const nextStatus = currentStatus === "approved" ? "pending" : "approved";
    const branch = service.branch || "";
    const updatedFlow = updateTabFlow(
      ctx.sourceTabId,
      (prev) => ({
        reviewedServices: {
          ...(prev.reviewedServices || {}),
          [service.id]: {
            status: nextStatus,
            branch,
            updatedAt: Date.now(),
          },
        },
      }),
      ctx.workspaceRoot,
    );

    if (nextStatus === "approved") {
      const sorted = this.getSortedServices();
      const reviews = this.getSessionReviews(ctx);
      const nextDirty = pickNextDirtyService(
        sorted,
        service.id,
        (sId) => this.getServiceReviewStatus(sId, updatedFlow, reviews),
      );
      if (nextDirty) {
        this.selectService(nextDirty.id, cx, { preferUnreviewed: true });
        return;
      }
    }

    cx.notify();
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
    if (flow?.tabId || this.getSessionContext().sourceTabId) {
      return Boolean(flow?.reviewedFiles?.[rk]);
    }
    return Boolean(this.localReviewedFiles?.has(rk));
  }

  toggleFileReviewed(file, cx, _advanceToNext = false, scopeOverride = null) {
    const fileKey = typeof file === "string" ? file : file?.key;
    const scope = scopeOverride ?? this.fileReviewScope();
    const rk = this.fileReviewKey(file, scope);
    if (!rk || !fileKey) return;

    const ctx = this.getSessionContext();
    const flows = readFlows();
    const curFlow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    const nextReviewed = !this.isFileReviewed(file, curFlow, scope);

    if (nextReviewed) this.localReviewedFiles.add(rk);
    else this.localReviewedFiles.delete(rk);

    if (ctx.sourceTabId) {
      updateTabFlow(
        ctx.sourceTabId,
        (prev) => {
          const nextMap = { ...(prev.reviewedFiles || {}) };
          if (nextReviewed) nextMap[rk] = true;
          else delete nextMap[rk];
          return { reviewedFiles: nextMap };
        },
        ctx.workspaceRoot,
      );
    }

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
      setShared("mesh.activeService", {
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
      this.viewMode = "working";
      this.showCommitMenu = false;
      this.selectedCommit = null;
      this.workingFiles = [];
      this.workingFilesCount = 0;
    }

    this.isWindows = !on && this.hostIsWindows;

    if (!workspaceRoot) {
      this.error = "No folder";
      return;
    }

    this.hasLoadedOnce = true;
    const { activeSpace, sessionTabId } = getActiveSpaceAndTab();
    const normWs = normPathStr(workspaceRoot);
    const bus = !force ? shared("mesh.services") : null;
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

    if (busFresh && Array.isArray(bus.candidates) && bus.candidates.length > 0 && bus.services.length === 0) {
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
      this.error = null;
      this.applyServiceFilter(null, { syncReviewTab: false });
      cx.notify();
      return;
    }

    this.loading = true;
    const isWindows = this.isWindows;
    const activeTabIds = new Set((activeSpace?.tabs || []).map((t) => t.id));
    const allPanesList = panes() || [];
    const extraCwds = Array.from(
      new Set(
        allPanesList
          .filter((p) => p?.cwd && activeTabIds.has(p.tab))
          .map((p) => p.cwd),
      ),
    );
    const tabPaneCwds = sessionTabId
      ? Array.from(new Set(allPanesList.filter((p) => p.tab === sessionTabId && p.cwd).map((p) => p.cwd)))
      : [];
    const tabFlowObj = sessionTabId && shared("mesh.flows")?.[sessionTabId];
    const tabTermAddrs = sessionTabId
      ? Array.from(
          new Set([
            ...(tabFlowObj?.leadTerminal ? [tabFlowObj.leadTerminal] : []),
            ...allPanesList.filter((p) => p.tab === sessionTabId && p.terminal && p.labels?.meshRunner !== "true").map((p) => p.terminal),
            ...(agents() || []).filter((a) => a.tab === sessionTabId).map((a) => a.address),
          ])
        )
      : [];

    cx.spawn(async (cx) => {
      try {
        let candidateServices;
        const usingBusServices = Boolean(busFresh && Array.isArray(bus?.services) && bus.services.length > 0);
        if (usingBusServices) {
          candidateServices = bus.services.map((s) => ({ ...s }));
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

        const serviceResults = await Promise.all(
          candidateServices.map((service) => loadServiceWorkingSnapshot(service, on, true))
        );

        if (key() !== context) return;

        const rawTouched = serviceResults.filter((r) => r.touched);
        const touchedResults = (sessionTabId && !usingBusServices)
          ? await attributeSessionRepos(sessionTabId, rawTouched, tabPaneCwds, tabTermAddrs, this.lastTranscriptScan)
          : rawTouched;
        if (key() !== context) return;
        const services = touchedResults.map((r) => r.service);

        this.workspaceRoot = workspaceRoot;
        this.services = services;
        this.root = services[0]?.root || workspaceRoot;

        // Check external mesh.activeService
        const sharedActive = shared("mesh.activeService");
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

        const existingBus = shared("mesh.services");
        const nextCandidates = existingBus?.candidates || candidateServices.map((s) => ({
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
        if ((!usingBusServices || force || servicesSig !== existingBusSig) && servicesSig !== this.lastPublishedServicesSig) {
          this.lastPublishedServicesSig = servicesSig;
          const pubTs = Date.now();
          this.lastConsumedBusTs = pubTs;
          this.lastConsumedBusSig = servicesSig;
          setShared("mesh.services", {
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
              const payload = this.buildActiveDiffPayload(openFile, {
                bumpSeq: Boolean(fileChanged || force),
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
        if (key() === context) this.error = String(e.message || e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
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
          file.add = lineTotal;
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

  async loadViewerDiffNow(diff, cx, opts = {}) {
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
      if (gen !== this.viewerLoadGen) return;
      this.setLines(lines, openFile.path);

      const seq = diff?.requestSeq || 0;
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
      if (gen !== this.viewerLoadGen) return;
      this.setLines([]);
      this.viewerNote = `Cannot preview this diff (too large or unreadable): ${e.message || e}`;
    } finally {
      if (gen === this.viewerLoadGen) {
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
    this.loadViewerDiffNow(payload, cx, { forceScrollTop: true });
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

    const flows = readFlows();
    const curFlow = ctx.sourceTabId ? (flows[ctx.sourceTabId] || {}) : {};
    const nextReviewed = !this.isFileReviewed(curFile, curFlow, scope);

    if (nextReviewed) this.localReviewedFiles.add(rk);
    else this.localReviewedFiles.delete(rk);

    let updatedFlow = curFlow;
    if (ctx.sourceTabId) {
      updatedFlow = updateTabFlow(
        ctx.sourceTabId,
        (prev) => {
          const nextMap = { ...(prev.reviewedFiles || {}) };
          if (nextReviewed) nextMap[rk] = true;
          else delete nextMap[rk];
          return { reviewedFiles: nextMap };
        },
        ctx.workspaceRoot,
      );
    }

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

  async toggleViewerServiceApproval(service, currentStatus, cx) {
    if (!service) return;
    if (currentStatus === "has_notes") {
      notify({
        title: "Review notes pending",
        body: `Send or clear review notes for ${service.name} before approving.`,
        level: "info",
      });
      return;
    }

    const ctx = this.getSessionContext();
    if (!ctx.sourceTabId) {
      notify({
        title: "No active tab",
        body: "Focus a workspace tab to record service review status.",
        level: "warning",
      });
      return;
    }

    const diff = readActiveDiff(ctx.spaceId);
    const nextStatus = currentStatus === "approved" ? "pending" : "approved";
    const branch = service.branch || "";
    const updatedFlow = updateTabFlow(
      ctx.sourceTabId,
      (prev) => ({
        reviewedServices: {
          ...(prev.reviewedServices || {}),
          [service.id]: {
            status: nextStatus,
            branch,
            updatedAt: Date.now(),
          },
        },
      }),
      ctx.workspaceRoot,
    );

    if (nextStatus === "approved") {
      const sorted = this.getSortedServices(diff?.services || []);
      const reviews = this.getSessionReviews(ctx);
      const nextDirty = pickNextDirtyService(
        sorted,
        service.id,
        (sId) => this.getServiceReviewStatus(sId, updatedFlow, reviews),
      );
      if (nextDirty) {
        if (ctx.workspaceRoot) {
          setShared("mesh.activeService", {
            workspaceRoot: ctx.workspaceRoot,
            serviceId: nextDirty.id,
            ts: Date.now(),
          });
        }
        let nextFiles = (diff?.allFiles || []).filter((f) => f.serviceId === nextDirty.id);
        if (nextFiles.length === 0 && nextDirty.root) {
          try {
            const snap = await loadServiceWorkingSnapshot(nextDirty, diff?.on ?? null, false);
            nextFiles = (snap?.files || []).map(buildFileDescriptor);
          } catch {}
        }
        const firstUnreviewed =
          pickNextUnreviewedFile(nextFiles, null, (f) => this.isFileReviewed(f, updatedFlow, "working")) ||
          nextFiles[0] ||
          null;
        this.openViewerFile(firstUnreviewed, diff, ctx, cx, {
          viewMode: "working",
          selectedCommit: null,
          activeService: nextDirty.id,
          files: nextFiles,
        });
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

  diffRow({ kind, number, text, tokens }, t, dt, commentMap, activeOpenKey = null) {
    const openKey = activeOpenKey || this.open;
    if (kind === "@") {
      const isExpanded = Boolean(this.expandedFiles && this.expandedFiles.has(openKey));
      return h_flex().w_full().px(12).h(20).flex_none().items_center().gap(10)
        .bg(t.raised).border_b(1).border_color(t.border)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleExpand(openKey, cx))
        .child(
          div().flex_none().px(5).py(0.5).rounded(3).bg(t.background).text_size(9.5).text_color(t.muted)
            .child(isExpanded ? "Collapse context" : "Expand context")
        )
        .child(
          div().flex_none().whitespace_nowrap().pr(20).text_size(11).text_color(t.dim)
            .child(expandCodeTabs(text).replace(/ /g, "\u00a0"))
        );
    }
    const isCommentable = number !== undefined;
    const existing = (isCommentable && commentMap) ? commentMap.get(number) : null;
    const isActive = this.activeComment && this.activeComment.fileKey === openKey && this.activeComment.line === number;
    const canSave = Boolean(this.commentText.trim());

    const isAdd = kind === "+";
    const isDel = kind === "-";
    const diffColor = isAdd ? dt.add : isDel ? dt.del : null;
    const rowBg = isAdd ? dt.addBg : isDel ? dt.delBg : null;
    const hoverBg = isAdd ? dt.addHover : isDel ? dt.delHover : t.hover;
    const gutterSign = isAdd ? "+" : isDel ? "-" : " ";

    const plainText = expandCodeTabs(text || " ");
    const codeCell = tokens && tokens.length
      ? h_flex().flex_none().whitespace_nowrap().items_center().pr(20).children(
          tokens.map(([tokKind, tokText]) =>
            div()
              .flex_none()
              .whitespace_nowrap()
              .text_color(syntaxTokenColor(tokKind, t))
              .child(tokText.replace(/ /g, "\u00a0"))
          )
        )
      : div().flex_none().whitespace_nowrap().pr(20)
          .text_color(diffColor || t.foreground)
          .child(plainText.replace(/ /g, "\u00a0"));

    const row = h_flex().w_full().h(20).flex_none().items_center().gap(6).cursor_pointer()
      .border_l(2)
      .border_color(diffColor || t.background)
      .when(Boolean(rowBg), (e) => e.bg(rowBg))
      .when(Boolean(existing) || Boolean(isActive), (e) => e.bg(t.selected))
      .hover((s) => s.bg(hoverBg))
      .on_click((_e, cx) => {
        if (isCommentable) this.startComment(openKey, number, text, cx);
      })
      .child(
        div().w(32).flex_none().text_right()
          .text_color(existing || isActive ? t.foreground : diffColor || t.dim)
          .child(number === undefined ? "" : String(number))
      )
      .child(
        div().w(10).flex_none().text_center().font_semibold()
          .text_color(diffColor || t.dim)
          .child(gutterSign)
      )
      .child(codeCell);

    if (!isActive && !existing) {
      return row;
    }

    return v_flex().w_full().flex_none()
      .child(row)
      .when(Boolean(isActive), (c) => c.child(
        v_flex().w_full().pl(8).pr(14).py(8).bg(t.raised).border_b(1).border_t(1).border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            v_flex().w_full().max_w(460).gap(6)
              .child(
                div().w_full().p(8).rounded(7).border_1().border_color(this.typingComment ? t.accent : t.border).bg(t.background).cursor_text()
                  .child(Textarea.new(this.commentInput).w_full().text_size(12).text_color(t.foreground))
              )
              .child(
                h_flex().w_full().items_center().justify_between()
                  .child(div().text_size(11).text_color(t.dim).child(`Line ${number}`))
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
          )
      ))
      .when(!isActive && Boolean(existing), (c) => c.child(
        h_flex().w_full().pl(12).pr(16).py(6).bg(t.raised).border_b(1).border_color(t.border).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.startComment(openKey, number, text, cx))
          .child(
            h_flex().w_full().max_w(460).gap(8).items_start()
              .child(div().pt(2).flex_none().child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(t.muted)))
              .child(
                v_flex().flex_1().min_w(0).gap(2).children(
                  String(existing.text || "").split(/\r?\n/).map((line) =>
                    div().w_full().text_size(11.5).text_color(t.foreground).child(line || " ")
                  )
                )
              )
              .child(
                div().p(3).rounded(4).flex_none().cursor_pointer().hover((s) => s.bg(t.background))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    this.removeComment(openKey, number, cx);
                  })
                  .child(svg("mods/changes-review/icons/trash.svg").size(10).text_color(t.dim))
              )
          )
      ));
  }

  render(cx) {
    if (this.isViewerMode()) {
      return this.renderViewer(cx);
    }
    return this.renderPanel(cx);
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

    const focusedService =
      (diff?.activeService && diff.activeService !== "all"
        ? services.find((s) => s.id === diff.activeService)
        : null) ||
      (openFile?.serviceId ? services.find((s) => s.id === openFile.serviceId) : null) ||
      (services.length === 1 ? services[0] : null);
    const svcStatus = focusedService ? this.getServiceReviewStatus(focusedService.id, flow, sessionReviews) : null;
    const svcApproved = svcStatus === "approved";
    const svcHasNotes = svcStatus === "has_notes";
    const canStepFiles = files.length > 1;
    const openIcon = openFile ? resolveDiffFileIcon(openFile.path || openFile.displayPath, t) : null;

    return v_flex().id("review-tab-viewer").size_full().min_h(0).rounded(10).overflow_hidden().relative()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && (this.typingComment || this.activeComment)) {
          this.cancelActiveComment(cx);
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .when(Boolean(openFile), (el) => el.child(
        h_flex()
          .id("diff-file-review-bar")
          .min_h(40)
          .flex_none()
          .px(12)
          .py(6)
          .gap(8)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .bg(t.raised)
          .child(
            h_flex().flex_1().min_w(0).gap(7).items_center()
              .when(services.length > 1 && Boolean(openFile.serviceName), (b) => b.child(
                div().flex_none().px(5).py(1).rounded(4).bg(t.background).border_1().border_color(t.border)
                  .text_size(10).font_medium().text_color(t.muted)
                  .child(openFile.serviceName)
              ))
              .child(
                div().flex_none().w(14).text_center().text_size(11).font_semibold()
                  .text_color(openFile.status === "A" ? add : openFile.status === "D" || openFile.status === "U" ? del : t.blocked)
                  .child(openFile.status || "M")
              )
              .when(Boolean(openIcon), (b) => b.child(svg(openIcon.path).size(14).flex_none().text_color(openIcon.color)))
              .child(
                div().min_w(0).truncate().text_size(12).font_medium()
                  .text_color(openFileReviewed ? t.muted : t.foreground)
                  .child(openFile.displayPath || openFile.path)
              )
              .when((openFile.add || 0) > 0, (b) => b.child(div().flex_none().text_size(11).text_color(add).child(`+${openFile.add}`)))
              .when((openFile.del || 0) > 0, (b) => b.child(div().flex_none().text_size(11).text_color(del).child(`−${openFile.del}`)))
              .child(
                div().flex_none().px(6).py(1).rounded(4).bg(t.background).border_1().border_color(t.border)
                  .text_size(10).text_color(viewMode === "commit" ? (t.accent || t.foreground) : t.muted)
                  .child(viewMode === "commit" && selectedCommit?.shortHash ? selectedCommit.shortHash : "Working Tree")
              )
          )
          .child(
            h_flex().flex_none().gap(6).items_center()
              .when(files.length > 0, (b) => b.child(
                h_flex().gap(4).items_center()
                  .child(
                    h_flex().id("diff-prev-btn").h(24).w(24).items_center().justify_center().rounded(5)
                      .border_1().border_color(t.border).bg(t.background)
                      .text_size(11.5).text_color(canStepFiles ? t.foreground : t.dim)
                      .when(canStepFiles, (p) => p.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.stepViewerFile(-1, cx)))
                      .tooltip("Previous file")
                      .child("←")
                  )
                  .when(fileIdx >= 0, (p) => p.child(
                    div().flex_none().px(4).text_size(10.5).text_color(t.muted).child(`${fileIdx + 1}/${files.length}`)
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
                    div().flex_none().px(6).py(1).rounded(4)
                      .bg(allFilesReviewed ? hexWithAlpha(passColor, "22") : t.background)
                      .border_1()
                      .border_color(allFilesReviewed ? hexWithAlpha(passColor, "66") : t.border)
                      .text_size(10).font_medium().text_color(allFilesReviewed ? passColor : t.muted)
                      .child(`${reviewedFilesCount}/${files.length} reviewed`)
                  )
              ))
              .child(
                h_flex().id("diff-reload-btn").h(24).w(24).items_center().justify_center().rounded(5)
                  .border_1().border_color(t.border).bg(t.background)
                  .text_size(12).text_color(t.muted).cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Reload diff")
                  .on_click((_e, cx) => this.loadViewerDiffNow(diff, cx))
                  .child("↻")
              )
              .child(
                h_flex()
                  .id("diff-viewed-btn")
                  .h(24)
                  .px(9)
                  .gap(5)
                  .flex_none()
                  .items_center()
                  .rounded(5)
                  .border_1()
                  .cursor_pointer()
                  .tooltip(openFileReviewed ? "Unmark reviewed" : "Mark reviewed & advance to next unreviewed file")
                  .when(openFileReviewed, (btn) =>
                    btn
                      .bg(hexWithAlpha(passColor, "22"))
                      .border_color(hexWithAlpha(passColor, "77"))
                      .text_color(passColor)
                      .hover((s) => s.bg(hexWithAlpha(passColor, "33")))
                  )
                  .when(!openFileReviewed, (btn) =>
                    btn
                      .bg(t.background)
                      .border_color(t.border)
                      .text_color(t.foreground)
                      .hover((s) => s.bg(t.hover))
                  )
                  .on_click((_e, cx) => this.toggleViewerFileReviewed(cx))
                  .child(
                    h_flex().w(12).h(12).flex_none().items_center().justify_center().rounded(3).border_1()
                      .when(openFileReviewed, (c) => c.bg(passColor).border_color(passColor).text_color(t.background))
                      .when(!openFileReviewed, (c) => c.bg(t.background).border_color(t.border))
                      .text_size(8.5).font_semibold()
                      .child(openFileReviewed ? "✓" : "")
                  )
                  .child(div().text_size(11).font_medium().child(openFileReviewed ? "Reviewed ✓" : "Mark reviewed"))
              )
              .when(Boolean(focusedService) && viewMode !== "commit", (el) => el.child(
                h_flex()
                  .id("diff-approve-service-btn")
                  .h(24)
                  .px(10)
                  .flex_none()
                  .items_center()
                  .rounded(5)
                  .text_size(11)
                  .font_medium()
                  .when(svcApproved, (btn) =>
                    btn
                      .bg(t.background)
                      .border_1()
                      .border_color(t.border)
                      .text_color(t.muted)
                      .cursor_pointer()
                      .tooltip(`Unapprove ${focusedService.name}`)
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .on_click((_e, cx) => this.toggleViewerServiceApproval(focusedService, svcStatus, cx))
                  )
                  .when(svcHasNotes, (btn) =>
                    btn
                      .bg(t.background)
                      .border_1()
                      .border_color(t.border)
                      .text_color(t.dim)
                      .tooltip("Send or clear review notes before approving")
                  )
                  .when(!svcApproved && !svcHasNotes, (btn) =>
                    btn
                      .bg(t.solid)
                      .text_color(t.solid_foreground)
                      .cursor_pointer()
                      .tooltip(`Approve ${focusedService.name} & advance to next dirty service`)
                      .on_click((_e, cx) => this.toggleViewerServiceApproval(focusedService, svcStatus, cx))
                  )
                  .child(svcApproved ? "Unapprove" : "Approve Service ✓")
              ))
          )
      ))
      .when(Boolean(this.viewerNote), (el) => el.child(
        div().flex_none().px(12).py(6).border_b(1).border_color(t.border).text_size(11).text_color(del).child(this.viewerNote)
      ))
      .child(
        div().flex_1().min_h(0).relative().font_family(mono).text_size(11.5)
          .child(
            div().id("changes-diff-x").size_full().overflow_x_scrollbar()
              .child(
                div().w_full().min_w(this.diffWidth).h_full()
                  .child(
                    v_flex().id("changes-diff-lines").size_full().overflow_y_scroll().track_scroll(this.diffScroll).pb(16).children(
                      this.rows.map((row) => this.diffRow(row, t, dt, commentMap, openKey))
                    )
                  )
              )
          )
          .child(Scrollbar.vertical("changes-diff-lines").viewport_from_layout().absolute().inset_0())
          .when(!openFile, (e) => e.child(
            h_flex().absolute().inset_0().items_center().justify_center()
              .child(div().text_size(12).text_color(t.dim).child("Select a file from the Changes panel to review its diff"))
          ))
          .when(Boolean(openFile) && this.viewerLoading && this.rows.length === 0, (e) => e.child(
            div().absolute().top(12).left(14).text_size(11.5).text_color(t.dim).child("Loading diff…")
          ))
      );
  }

  renderPanel(cx) {
    const visible = isChangesVisible();
    const bus = shared("mesh.services");
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
      const storedAgentTabs = readPlainObject(shared("mesh.spaceAgentTabs"));
      if (storedAgentTabs[curSpace.id] !== curTab.id) {
        this.scheduleAgentTabSync(cx);
      }
    }

    const ctx = this.getSessionContext();
    const activeDiff = readActiveDiff(ctx.spaceId);
    const revTab = findReviewTabInSpace(ctx.spaceId, allSpaces, allPanes);
    const sharedActive = shared("mesh.activeService");
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
    const focusedService = this.activeService !== "all"
      ? (this.services.find((s) => s.id === this.activeService) || null)
      : (this.services.length === 1 ? this.services[0] : null);

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

    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().relative().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
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
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child("Changes"))
        .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
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
        ))

        // Commit selector dropdown button right beside "Changes" and file counter
        .child(
          h_flex().id("commit-selector-btn").h(24).px(8).gap(6).items_center().rounded(5)
            .min_w(0).max_w(180)
            .bg(this.showCommitMenu ? t.selected : t.background).border_1().border_color(this.showCommitMenu ? t.accent : t.border)
            .cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              this.showCommitMenu = !this.showCommitMenu;
              cx.notify();
            })
            .child(
              svg("mods/changes-review/icons/git-commit.svg")
                .size(11).flex_none()
                .text_color(this.viewMode === "working" ? t.muted : t.accent || t.foreground)
            )
            .child(
              div().flex_1().min_w(0).truncate().text_size(11).font_medium()
                .text_color(t.foreground)
                .child(
                  this.viewMode === "working"
                    ? "Working Tree"
                    : this.selectedCommit
                      ? `${this.services.length > 1 && this.selectedCommit.serviceName ? `[${this.selectedCommit.serviceName}] ` : ""}${this.selectedCommit.shortHash}: ${this.selectedCommit.subject}`
                      : "Select commit"
                )
            )
            .when(this.viewMode === "working" && this.workingFilesCount > 0, (el) => el.child(
              div().flex_none().px(4).py(0.5).rounded(3).bg(t.raised).text_size(9.5).text_color(t.muted).child(String(this.workingFilesCount))
            ))
            .child(svg("mods/changes-review/icons/chevron-down.svg").size(9).flex_none().text_color(t.dim))
        )

        // Quick return to Working Tree if currently viewing a commit
        .when(this.viewMode !== "working", (el) => el.child(
          h_flex().id("quick-working-tree-btn").h(22).px(7).gap(4).flex_none().items_center().rounded(4)
            .bg(t.background).border_1().border_color(t.border)
            .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
            .text_color(t.muted).text_size(10.5)
            .on_click((_e, cx) => {
              this.switchMode("working", null, cx);
            })
            .child("⚡ Working Tree")
            .when(this.workingFilesCount > 0, (b) => b.child(
              div().px(3.5).py(0.5).rounded(3).bg(t.raised).text_size(9).child(String(this.workingFilesCount))
            ))
        ))

        .child(div().flex_1())
        .child(div().flex_none().text_size(11).text_color(add).child(`+${addCount}`))
        .child(div().flex_none().text_size(11).text_color(del).child(`−${delCount}`)))

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

      // Microservice Review Bar (when a single service is selected, or sole repository)
      .when(Boolean(focusedService), (el) => {
        const svc = focusedService;
        const svcStatus = this.getServiceReviewStatus(svc.id, flow, sessionReviews);
        const branchLabel = svc.branch || "HEAD";
        const statusText = svcStatus === "approved" ? "Approved ✓" : svcStatus === "has_notes" ? "Has notes" : "Pending";
        const statusColor = svcStatus === "approved" ? passColor : svcStatus === "has_notes" ? noteColor : t.muted;
        const isApproved = svcStatus === "approved";
        const hasNotes = svcStatus === "has_notes";

        return el.child(
          h_flex()
            .id("microservice-review-bar")
            .min_h(34)
            .flex_none()
            .px(10)
            .py(5)
            .gap(8)
            .items_center()
            .justify_between()
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .child(
              h_flex()
                .flex_1()
                .min_w(0)
                .gap(6)
                .items_center()
                .child(svg("mods/changes-review/icons/git-branch.svg").size(11).flex_none().text_color(t.muted))
                .child(
                  div()
                    .min_w(0)
                    .truncate()
                    .text_size(11)
                    .font_medium()
                    .text_color(t.foreground)
                    .child(`${svc.name} · ${branchLabel}`),
                )
                .child(
                  div()
                    .flex_none()
                    .px(5)
                    .py(0.5)
                    .rounded(4)
                    .bg(svcStatus === "pending" ? t.background : hexWithAlpha(statusColor, "22"))
                    .border_1()
                    .border_color(svcStatus === "pending" ? t.border : hexWithAlpha(statusColor, "66"))
                    .text_size(9.5)
                    .font_medium()
                    .text_color(statusColor)
                    .child(statusText),
                ),
            )
            .child(
              h_flex()
                .flex_none()
                .gap(6)
                .items_center()
                .child(
                  h_flex()
                    .id("approve-service-btn")
                    .h(22)
                    .px(8)
                    .flex_none()
                    .items_center()
                    .rounded(5)
                    .text_size(10.5)
                    .font_medium()
                    .when(isApproved, (btn) =>
                      btn
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_color(t.muted)
                        .cursor_pointer()
                        .hover((s) => s.bg(t.hover).text_color(t.foreground)),
                    )
                    .when(hasNotes, (btn) =>
                      btn
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .text_color(t.dim)
                        .cursor_pointer()
                        .tooltip("Send or clear review notes before approving"),
                    )
                    .when(!isApproved && !hasNotes, (btn) =>
                      btn
                        .bg(t.solid)
                        .text_color(t.solid_foreground)
                        .cursor_pointer(),
                    )
                    .on_click((_e, cx) => this.toggleServiceApproval(svc, svcStatus, cx))
                    .child(isApproved ? "Unapprove" : "Approve Service ✓"),
                ),
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
        this.error || (this.loading ? "Loading changes…" : this.services.length ? (this.viewMode === "commit" ? "No files changed in this commit" : "No uncommitted changes") : "No folder")
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
          : h_flex().flex_none().p(10).gap(8).items_center().justify_between().border_t(1).border_color(t.border).bg(t.background)
              .child(
                h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
                  .child(svg("mods/changes-review/icons/git-commit.svg").size(12).text_color(t.muted))
                  .child(div().child("Commits can only be made on uncommitted Working Tree changes."))
              )
              .child(
                h_flex().h(28).px(10).items_center().rounded(6).bg(t.raised).border_1().border_color(t.border)
                  .text_size(11.5).text_color(t.foreground).cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.switchMode("working", null, cx);
                  })
                  .child("Switch to Working Tree")
              )
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
        div().id("commit-menu-overlay").absolute().inset_0()
          .on_mouse_down("left", (_e, cx) => {
            this.showCommitMenu = false;
            cx.notify();
          })
          .child(
            v_flex().id("commit-dropdown-floating")
              .absolute().top(43).left(10).right(10).max_w(360).max_h(320)
              .rounded(8).bg(t.raised).border_1().border_color(t.border).shadow_xl().p(4).gap(2)
              .overflow_y_scrollbar()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(
                h_flex().id("select-working-tree").min_h(28).py(3).flex_none().px(8).gap(7).items_center().rounded(5).cursor_pointer()
                  .when(this.viewMode === "working", (s) => s.bg(t.selected))
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => this.switchMode("working", null, cx))
                  .child(svg("mods/changes-review/icons/git-commit.svg").size(11).flex_none().text_color(this.viewMode === "working" ? t.accent || t.foreground : t.muted))
                  .child(div().text_size(11).font_medium().child("Working Tree"))
                  .child(div().text_size(10).text_color(t.dim).child("Uncommitted"))
                  .child(div().flex_1())
                  .when(this.workingFilesCount > 0, (b) => b.child(
                    div().flex_none().px(4).py(0.5).rounded(3).bg(t.background).text_size(9).text_color(t.muted).child(String(this.workingFilesCount))
                  ))
              )
              .child(div().h(1).w_full().bg(t.border).my(1).flex_none())
              .children(
                this.commits.map((c) => {
                  const isSelected = this.viewMode === "commit" && this.selectedCommit?.hash === c.hash;
                  return h_flex().id(`commit-item-${c.shortHash}`).min_h(34).py(3.5).flex_none().px(8).gap(7).items_center().rounded(5).cursor_pointer()
                    .when(isSelected, (s) => s.bg(t.selected))
                    .hover((s) => s.bg(t.hover))
                    .on_click((_e, cx) => this.switchMode("commit", c, cx))
                    .child(svg("mods/changes-review/icons/git-commit.svg").size(11).flex_none().text_color(isSelected ? t.accent || t.foreground : t.muted))
                    .child(
                      v_flex().flex_1().min_w(0).gap(1.5)
                        .child(
                          h_flex().gap(6).items_center()
                            .when(this.services.length > 1 && Boolean(c.serviceName), (b) => b.child(
                              div().flex_none().px(3.5).py(0.5).rounded(3).bg(t.background).border_1().border_color(t.border).text_size(9).text_color(t.muted).child(c.serviceName)
                            ))
                            .child(div().flex_none().font_family(mono).text_size(10).font_medium().text_color(isSelected ? t.foreground : t.dim).child(c.shortHash))
                            .child(div().flex_1().min_w(0).truncate().text_size(11).font_medium().text_color(t.foreground).child(c.subject))
                        )
                        .child(
                          h_flex().gap(5).items_center().text_size(9).text_color(t.dim)
                            .child(div().truncate().child(c.author))
                            .child(div().child("·"))
                            .child(div().flex_none().child(c.date))
                        )
                    );
                })
              )
          )
      ));
  }
}
