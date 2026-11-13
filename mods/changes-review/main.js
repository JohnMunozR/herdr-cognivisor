import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar, ScrollHandle } from "gpui-base";
import { readdir, exists } from "fs/promises";
import { join } from "path";
import {
  spaces, panes, focused, agents, terminals, exec, readTextFile, watchFolder,
  theme, settings, notify, hc, run, layout, shared, setShared, window,
} from "herdr";

function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const allPanes = panes();
  const spaceTabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const spacePanes = allPanes.filter((p) => spaceTabs.has(p.tab));
  const pane = (f?.pane ? spacePanes.find((p) => p.pane === f.pane) : null) || spacePanes.find((p) => p.cwd) || null;
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

  const activeTab = (space?.tabs ?? []).find((t) => t.active) || null;
  return { cwd: workspaceRoot, paneCwd: pane?.cwd || null, on, spaceId: space?.id ?? null, tabId: activeTab?.id ?? null };
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

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
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
const BUS_MAX_AGE_MS = 90000;
const WATCH_DEBOUNCE_MS = 800;
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

function getRelToRepo(changedPath, repoRoot) {
  const normP = normPathStr(changedPath);
  const normRoot = normPathStr(repoRoot);
  if (!normP || !normRoot) return null;
  if (normP === normRoot) return "";
  if (normP.startsWith(normRoot + "/")) return normP.slice(normRoot.length + 1);
  if (normP.toLowerCase().startsWith(normRoot.toLowerCase() + "/")) {
    return normP.slice(normRoot.length + 1);
  }
  return null;
}

function isIgnoredWatchPath(changedPath, repoRoot) {
  const rel = getRelToRepo(changedPath, repoRoot);
  const target = rel !== null ? rel : normPathStr(changedPath);
  if (!target) return false;
  const segs = target.split("/").filter(Boolean);
  const segsLower = segs.map((s) => s.toLowerCase());

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

function hasRelevantWatchChange(changedPaths, repoRoot) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return true;
  for (const p of changedPaths) {
    if (p && !isIgnoredWatchPath(p, repoRoot)) return true;
  }
  return false;
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

function getParentDir(normPath) {
  const parts = String(normPath || "").split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const prefix = normPath.startsWith("/") ? "/" : "";
  return prefix + parts.slice(0, -1).join("/");
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

function readFlows() {
  const value = shared("mesh.flows");
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getActiveSpaceAndTab() {
  const allSpaces = spaces() || [];
  const activeSpace = allSpaces.find((s) => s.active) || null;
  const activeTab = activeSpace?.tabs?.find((t) => t.active) || null;
  return { activeSpace, activeTab, activeTabId: activeTab?.id || null };
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

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function tailOutput(stdout, stderr, maxLines = 60, maxChars = 4000) {
  const combined = [stripAnsi(stdout).trimEnd(), stripAnsi(stderr).trimEnd()].filter(Boolean).join("\n");
  if (!combined) return "";
  const lines = combined.split("\n");
  const slicedLines = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  const text = slicedLines.join("\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

const SHELL_FENCE_LANGS = new Set([
  "", "sh", "bash", "zsh", "shell", "console", "terminal", "cmd", "powershell",
]);

const CHECK_CMD_RE = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:test|lint|typecheck|check|build|verify|format|run\s+[a-zA-Z0-9:_-]+)|npx\s+(?:ng|tsc|eslint|prettier|vitest|jest|playwright|biome|stylelint)\b|ng\s+(?:test|lint|build|e2e)\b|(?:\.\/)?mvnw?(?:\.cmd)?\s+(?:test|verify|check|compile|package|test-compile|spotless:check|checkstyle:check)\b|(?:\.\/)?gradlew?(?:\.bat)?\s+(?:test|check|build|lint)\b|cargo\s+(?:check|test|clippy|fmt(?:\s+--check)?|build)\b|go\s+(?:test|vet|build)\b|(?:uv\s+run\s+|python3?\s+-m\s+)?(?:pytest|unittest|ruff|mypy|flake8)\b|make\s+(?:lint|test|check|typecheck|verify)\b|herdr-app\s+check\b|node\s+(?:--check|-e)\b|(?:eslint|vitest|jest|tsc|pytest|ruff|mypy)\b|dotnet\s+(?:test|build)\b|bundle\s+exec\s+(?:rspec|rubocop)\b)/;

const UNSAFE_CMD_RE = /(?:\$\(|`|;|\||>|<|\b(?:rm|sudo|curl|wget|chmod|chown|mkfs|dd)\b|\bgit\s+(?:push|reset|clean)\b)/;

function isSafeRecognizedCheckCommand(raw) {
  if (!raw || typeof raw !== "string") return false;
  const cmd = raw.trim();
  if (cmd.length < 3 || cmd.length > 220 || cmd.includes("\n")) return false;
  if (/<[^>\s]+>|(?:^|[^\/])\.\.\.(?:$|\s)|\$\{[A-Z0-9_]+\}/.test(cmd)) return false;
  if (UNSAFE_CMD_RE.test(cmd)) return false;
  if (cmd.includes("&&")) {
    const parts = cmd.split("&&").map((p) => p.trim());
    return parts.length > 0 && parts.every((p) => p && CHECK_CMD_RE.test(p));
  }
  return CHECK_CMD_RE.test(cmd);
}

function extractDocChecks(text, sourceName) {
  if (!text || typeof text !== "string") return [];
  const found = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let fenceLang = "";

  for (const line of lines) {
    const fenceMatch = /^\s*```([a-zA-Z0-9_-]*)/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = (fenceMatch[1] || "").toLowerCase();
      } else {
        inFence = false;
        fenceLang = "";
      }
      continue;
    }

    if (inFence) {
      if (!SHELL_FENCE_LANGS.has(fenceLang)) continue;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const cleaned = trimmed.replace(/^(?:\$\s+|>\s+)/, "").trim();
      if (isSafeRecognizedCheckCommand(cleaned)) {
        found.push({ command: cleaned, source: sourceName });
      }
      continue;
    }

    let matchedInline = false;
    const inlineRe = /`([^`\n]+)`/g;
    let m;
    while ((m = inlineRe.exec(line)) !== null) {
      const candidate = m[1].trim().replace(/^(?:\$\s+|>\s+)/, "").trim();
      if (isSafeRecognizedCheckCommand(candidate)) {
        found.push({ command: candidate, source: sourceName });
        matchedInline = true;
      }
    }

    if (!matchedInline) {
      const labelMatch = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:checks?|verification|verify|test|lint)(?:\*\*)?\s*:\s*(.+)$/i.exec(line);
      if (labelMatch) {
        const candidate = labelMatch[1].trim().replace(/^["'`]+|["'`]+$/g, "").replace(/^(?:\$\s+|>\s+)/, "").trim();
        if (isSafeRecognizedCheckCommand(candidate)) {
          found.push({ command: candidate, source: sourceName });
        }
      }
    }
  }

  return found;
}

const WIN_CMD_SHIMS = new Set(["npm", "pnpm", "yarn", "npx", "bun", "ng", "mvnw", "gradlew"]);

function tokenizeCheckCommand(rawCmd, isWindows) {
  const command = rawCmd.trim();
  const parts = command.split(/\s+/).filter(Boolean);
  const head = (parts[0] || "").toLowerCase().replace(/\.(?:cmd|bat|exe)$/, "");
  const needsShell = /['"&|;$*?()~]/.test(command) || (isWindows && WIN_CMD_SHIMS.has(head));
  if (needsShell) {
    return isWindows
      ? { command, cmd: "cmd", args: ["/c", command], useShell: true }
      : { command, cmd: "sh", args: ["-c", command], useShell: true };
  }
  return {
    command,
    cmd: parts[0] || command,
    args: parts.slice(1),
    useShell: false,
  };
}

async function discoverServiceChecks(service, on, isWindows) {
  const root = String(service?.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return { standardsDocs: [], checks: [] };

  const readRoot = (name) => readTextFile(`${root}/${name}`, { on }).catch(() => null);
  const [agentsMd, claudeMd, specMd, pkgRaw, pomRaw, cargoRaw, makeRaw] = await Promise.all([
    readRoot("AGENTS.md"),
    readRoot("CLAUDE.md"),
    readRoot("SPEC.md"),
    readRoot("package.json"),
    readRoot("pom.xml"),
    readRoot("Cargo.toml"),
    readRoot("Makefile"),
  ]);

  const standardsDocs = [];
  const discovered = [];

  if (agentsMd !== null) {
    standardsDocs.push("AGENTS.md");
    discovered.push(...extractDocChecks(agentsMd, "AGENTS.md"));
  }
  if (claudeMd !== null) {
    standardsDocs.push("CLAUDE.md");
    discovered.push(...extractDocChecks(claudeMd, "CLAUDE.md"));
  }
  if (specMd !== null) {
    standardsDocs.push("SPEC.md");
    discovered.push(...extractDocChecks(specMd, "SPEC.md"));
  }

  if (pkgRaw !== null) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const scripts = pkg?.scripts;
      if (scripts && typeof scripts === "object") {
        const pmRaw = typeof pkg.packageManager === "string" ? pkg.packageManager.toLowerCase() : "";
        const pm = pmRaw.startsWith("pnpm") ? "pnpm" : pmRaw.startsWith("yarn") ? "yarn" : pmRaw.startsWith("bun") ? "bun" : "npm";
        for (const scriptName of ["lint", "typecheck", "test", "build"]) {
          if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim()) {
            const cmdStr = pm === "npm" && scriptName === "test" ? "npm test" : `${pm} run ${scriptName}`;
            discovered.push({ command: cmdStr, source: "package.json" });
          }
        }
      }
    } catch {}
  }

  if (pomRaw !== null) {
    const wrapperName = isWindows ? "mvnw.cmd" : "mvnw";
    const hasWrapper = (await readRoot(wrapperName)) !== null;
    discovered.push({
      command: hasWrapper ? (isWindows ? "mvnw.cmd test" : "./mvnw test") : "mvn test",
      source: "pom.xml",
    });
  }

  if (cargoRaw !== null) {
    discovered.push({ command: "cargo check", source: "Cargo.toml" });
    discovered.push({ command: "cargo test", source: "Cargo.toml" });
  }

  if (makeRaw !== null) {
    for (const target of ["lint", "test", "check"]) {
      const re = new RegExp(`^${target}\\s*:(?!=)`, "m");
      if (re.test(makeRaw)) {
        discovered.push({ command: `make ${target}`, source: "Makefile" });
      }
    }
  }

  const deduped = [];
  const byCmd = new Map();
  for (const item of discovered) {
    const key = item.command.trim();
    if (!key) continue;
    const existing = byCmd.get(key);
    if (existing) {
      if (!existing.sources.includes(item.source)) {
        existing.sources.push(item.source);
        existing.source = existing.sources.join(" · ");
      }
    } else {
      const tokenized = tokenizeCheckCommand(key, isWindows);
      const entry = {
        ...tokenized,
        source: item.source,
        sources: [item.source],
      };
      byCmd.set(key, entry);
      deduped.push(entry);
    }
  }

  return { standardsDocs, checks: deduped };
}

export default class ChangesReview extends View {
  init(_props, cx) {
    this.files = [];
    this.allWorkingFiles = [];
    this.rows = [];
    this.diffWidth = 0;
    this.handle = cx.focus_handle();
    this.bottomTab = "review"; // "review" | "commit"
    this.reviews = []; // Array of { fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, text, snippet }
    this.activeComment = null; // { fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, snippet }
    this.commentText = "";
    this.sendingReview = false;
    this.busy = false;
    this.expandedFiles = new Set();

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
    this.wasVisible = isChangesVisible();
    this.hasLoadedOnce = false;
    this.needsRefreshOnShow = false;

    // Repo standards & checks runner state
    this.checksOpen = false;
    this.checksByService = new Map();
    this.checkResults = new Map();
    this.runningAllTarget = null;
    this.sendingCheckFailures = false;
    this.serviceFilterScroll = ScrollHandle.new();
    this.checksScroll = ScrollHandle.new();

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

    if (this.wasVisible) this.refresh(cx);
    cx.timer.every(30000, (cx) => {
      if (isChangesVisible()) this.refresh(cx);
    });
  }

  close() {
    this.renderRefreshTask?.cancel();
    this.renderRefreshTask = null;
    this.watchDebounceTask?.cancel();
    this.watchDebounceTask = null;
    this.stopAllWatchers();
    try { this.input?.release(); } catch {}
    try { this.commentInput?.release(); } catch {}
    try { this.serviceFilterScroll?.release(); } catch {}
    try { this.checksScroll?.release(); } catch {}
  }

  scheduleRenderRefresh(cx) {
    if (this.renderRefreshTask || !cx?.timer) return;
    this.renderRefreshTask = cx.timer.after(0, (cx) => {
      this.renderRefreshTask = null;
      if (isChangesVisible()) {
        this.refresh(cx);
      }
    });
  }

  getComment(fileKey, line) {
    return this.reviews.find((r) => (r.fileKey === fileKey || r.file === fileKey) && r.line === line);
  }

  openCommentEditor(file, line, snippet, initialText) {
    const text = initialText ?? "";
    this.activeComment = {
      fileKey: file?.key || this.open,
      serviceId: file?.serviceId || "",
      serviceName: file?.serviceName || "",
      repoRoot: file?.repoRoot || this.root || "",
      file: file?.path || this.open,
      displayPath: file?.displayPath || file?.path || this.open,
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
    const file = (this.files || []).find((f) => f.key === fileKey) || (this.allWorkingFiles || []).find((f) => f.key === fileKey);
    const existing = this.getComment(fileKey, line);
    this.openCommentEditor(file, line, snippet, existing ? existing.text : "");
    cx.notify();
  }

  syncServiceNoteStatus(serviceId, hasNotes) {
    if (!serviceId) return;
    const { activeSpace, activeTabId } = getActiveSpaceAndTab();
    if (!activeTabId) return;
    const flows = readFlows();
    const flow = flows[activeTabId];
    const currentStatus = flow?.reviewedServices?.[serviceId]?.status;
    const svc = (this.services || []).find((s) => s.id === serviceId);
    const branch = svc?.branch || "";

    if (hasNotes && currentStatus !== "has_notes") {
      updateTabFlow(
        activeTabId,
        (prev) => ({
          reviewedServices: {
            ...(prev.reviewedServices || {}),
            [serviceId]: { status: "has_notes", branch, updatedAt: Date.now() },
          },
        }),
        this.workspaceRoot || activeSpace?.folder || "",
      );
    } else if (!hasNotes && currentStatus === "has_notes") {
      updateTabFlow(
        activeTabId,
        (prev) => ({
          reviewedServices: {
            ...(prev.reviewedServices || {}),
            [serviceId]: { status: "pending", branch, updatedAt: Date.now() },
          },
        }),
        this.workspaceRoot || activeSpace?.folder || "",
      );
    }
  }

  saveActiveComment(cx) {
    if (!this.activeComment) return;
    const raw = (this.commentInput.value() ?? "").replace(/\r\n/g, "\n");
    const text = raw.trim();
    const { fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, snippet } = this.activeComment;
    if (text) {
      const idx = this.reviews.findIndex((r) => (r.fileKey === fileKey || r.file === fileKey) && r.line === line);
      const item = { fileKey, serviceId, serviceName, repoRoot, file, displayPath, line, text, snippet };
      if (idx >= 0) {
        this.reviews = this.reviews.map((r, i) => (i === idx ? item : r));
      } else {
        this.reviews = [...this.reviews, item];
      }
    } else {
      this.reviews = this.reviews.filter((r) => !((r.fileKey === fileKey || r.file === fileKey) && r.line === line));
    }
    if (serviceId) {
      this.syncServiceNoteStatus(serviceId, this.reviews.some((r) => r.serviceId === serviceId));
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
    const removed = this.reviews.filter((r) => (r.fileKey === fileKey || r.file === fileKey) && r.line === line);
    this.reviews = this.reviews.filter((r) => !((r.fileKey === fileKey || r.file === fileKey) && r.line === line));
    for (const r of removed) {
      if (r.serviceId) {
        this.syncServiceNoteStatus(r.serviceId, this.reviews.some((item) => item.serviceId === r.serviceId));
      }
    }
    if (this.activeComment && this.activeComment.fileKey === fileKey && this.activeComment.line === line) {
      this.cancelActiveComment(cx);
    } else {
      cx.notify();
    }
  }

  clearComments(cx) {
    const affectedServices = Array.from(new Set(this.reviews.map((r) => r.serviceId).filter(Boolean)));
    this.reviews = [];
    for (const sId of affectedServices) {
      this.syncServiceNoteStatus(sId, false);
    }
    this.activeComment = null;
    this.commentText = "";
    this.commentInput.set_value("");
    cx.notify();
  }

  jumpToComment(comment, cx) {
    const latest = this.getComment(comment.fileKey || comment.file, comment.line) || comment;
    this.bottomTab = "review";

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
      this.applyServiceFilter();
      if (this.checksOpen) this.ensureChecksDiscovered(cx);
    }

    const targetKey = latest.fileKey || latest.file;
    if (this.open !== targetKey) {
      this.open = targetKey;
      this.closed = false;
      const context = this.context;
      cx.spawn(async (cx) => {
        try {
          await this.load(targetKey, context);
        } catch {}
        if (key() !== context) return;
        const cur = this.getComment(latest.fileKey || latest.file, latest.line) || latest;
        const file = (this.files || []).find((f) => f.key === targetKey) || (this.allWorkingFiles || []).find((f) => f.key === targetKey);
        this.openCommentEditor(file, cur.line, cur.snippet || "", cur.text);
        cx.notify();
      });
    } else {
      const file = (this.files || []).find((f) => f.key === targetKey) || (this.allWorkingFiles || []).find((f) => f.key === targetKey);
      this.openCommentEditor(file, latest.line, latest.snippet || "", latest.text);
    }
    cx.notify();
  }

  findActiveAgent() {
    const allAgents = agents() || [];
    const allTerminals = terminals() || [];
    const allPanes = panes() || [];
    const f = focused();
    const { activeTabId } = getActiveSpaceAndTab();

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
        tab: fallbackTabId || activeTabId || null,
      };
    };

    // 1. mesh.flows[activeTabId]?.leadTerminal -> match in agents() or terminals() (excluding runners)
    if (activeTabId) {
      const flows = readFlows();
      const leadAddr = flows[activeTabId]?.leadTerminal || null;
      if (leadAddr && !isRunner(leadAddr, null)) {
        const leadAgent = agentMap.get(leadAddr);
        if (leadAgent) return leadAgent;
        const leadTerm = toTerminalAgent(termMap.get(leadAddr), activeTabId);
        if (leadTerm) return leadTerm;
      }
    }

    // 2. focused()?.agent -> match in agents() (excluding meshRunner=true)
    if (f?.agent && !isRunner(f.agent, null)) {
      const focusedAgent = agentMap.get(f.agent);
      if (focusedAgent) return focusedAgent;
    }

    // 3. Non-runner agent in activeTabId (panes() + terminals() + agents(), excluding labels?.meshRunner === "true")
    if (activeTabId) {
      const tabPanes = allPanes.filter((p) => p.tab === activeTabId && p.terminal && !isRunner(p.terminal, p));
      const sortedTabPanes = [...tabPanes].sort((a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)));
      for (const p of sortedTabPanes) {
        const m = agentMap.get(p.terminal);
        if (m) return m;
      }
      const tabNonRunnerAgent = allAgents.find((a) => a.tab === activeTabId && !isRunner(a.address, null));
      if (tabNonRunnerAgent) return tabNonRunnerAgent;

      for (const p of sortedTabPanes) {
        const term = termMap.get(p.terminal);
        if (p.program?.agent || term?.program?.agent || term?.reported) {
          const candidate = toTerminalAgent(term, activeTabId);
          if (candidate) return candidate;
        }
      }

      // 4. Non-runner or fallback agent in activeTabId
      const tabFallbackAgent =
        allAgents.find((a) => a.tab === activeTabId && !isRunner(a.address, null)) ||
        allAgents.find((a) => a.tab === activeTabId);
      if (tabFallbackAgent) return tabFallbackAgent;
    }

    // 5. agents()[0] global fallback (prefer non-runner)
    return allAgents.find((a) => !isRunner(a.address, null)) || allAgents[0] || null;
  }

  async sendReview(cx) {
    if (this.sendingReview || this.reviews.length === 0) return;
    const agent = this.findActiveAgent();
    if (!agent) {
      this.note = "No active agent found to send review notes to.";
      cx.notify();
      return;
    }
    this.sendingReview = true;
    this.note = null;
    cx.notify();

    try {
      let header = "Review comments on uncommitted changes:";
      if (this.viewMode === "commit" && this.selectedCommit) {
        header = `Review comments on commit ${this.selectedCommit.shortHash} ("${this.selectedCommit.subject}"):`;
      }
      const parts = [
        header,
        "",
      ];

      const byService = new Map();
      for (const r of this.reviews) {
        const sId = r.serviceId || "default";
        if (!byService.has(sId)) byService.set(sId, []);
        byService.get(sId).push(r);
      }

      for (const [sId, revs] of byService) {
        const sName = revs[0].serviceName || sId;
        const sRoot = revs[0].repoRoot || this.root;
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
      this.note = `Failed to send review: ${e.message || e}`;
    } finally {
      this.sendingReview = false;
      cx.notify();
    }
  }

  getSortedServices() {
    return [...(this.services || [])].sort((a, b) => {
      const aCount = a.workingCount || 0;
      const bCount = b.workingCount || 0;
      if ((aCount > 0) !== (bCount > 0)) return bCount - aCount;
      return a.name.localeCompare(b.name);
    });
  }

  getServiceReviewStatus(serviceId, flow) {
    if (this.reviews.some((r) => r.serviceId === serviceId)) return "has_notes";
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

    const { activeSpace, activeTabId } = getActiveSpaceAndTab();
    if (!activeTabId) {
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
      activeTabId,
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
      this.workspaceRoot || activeSpace?.folder || "",
    );

    if (nextStatus === "approved") {
      const sorted = this.getSortedServices();
      const curIdx = sorted.findIndex((s) => s.id === service.id);
      let nextDirty = null;
      if (sorted.length > 1) {
        const start = curIdx >= 0 ? curIdx : 0;
        for (let offset = 1; offset < sorted.length; offset++) {
          const cand = sorted[(start + offset) % sorted.length];
          if ((cand.workingCount || 0) > 0 && this.getServiceReviewStatus(cand.id, updatedFlow) !== "approved") {
            nextDirty = cand;
            break;
          }
        }
      }
      if (nextDirty) {
        this.selectService(nextDirty.id, cx);
        return;
      }
    }

    cx.notify();
  }

  checkKey(serviceId, command) {
    return `${serviceId}::${command}`;
  }

  getCheckTargetServices() {
    if (!this.services || this.services.length === 0) return [];
    if (this.activeService !== "all") {
      const svc = this.services.find((s) => s.id === this.activeService);
      return svc ? [svc] : [];
    }
    const dirty = this.services.filter((s) => (s.workingCount || 0) > 0);
    return dirty.length > 0 ? dirty : this.services;
  }

  toggleChecksDrawer(cx) {
    this.isWindows = !this.on && window()?.platform === "windows";
    this.checksOpen = !this.checksOpen;
    if (this.checksOpen) {
      this.ensureChecksDiscovered(cx, false);
    }
    cx.notify();
  }

  ensureChecksDiscovered(cx, force = false) {
    const targets = this.getCheckTargetServices();
    if (targets.length === 0) return;

    const on = this.on;
    const context = this.context;
    const isWindows = Boolean(this.isWindows);
    const toScan = [];

    for (const svc of targets) {
      const existing = this.checksByService.get(svc.id);
      if (!force && existing && (existing.scanning || existing.root === svc.root)) {
        continue;
      }
      this.checksByService.set(svc.id, {
        root: svc.root,
        discoveredAt: 0,
        standardsDocs: existing?.standardsDocs || [],
        checks: existing?.checks || [],
        scanning: true,
        error: null,
      });
      toScan.push(svc);
    }

    if (toScan.length === 0) return;
    cx.notify();

    cx.spawn(async (cx) => {
      await Promise.all(
        toScan.map(async (svc) => {
          try {
            const res = await discoverServiceChecks(svc, on, isWindows);
            if (key() !== context) return;
            this.checksByService.set(svc.id, {
              root: svc.root,
              discoveredAt: Date.now(),
              standardsDocs: res.standardsDocs,
              checks: res.checks,
              scanning: false,
              error: null,
            });
          } catch (e) {
            if (key() !== context) return;
            this.checksByService.set(svc.id, {
              root: svc.root,
              discoveredAt: Date.now(),
              standardsDocs: [],
              checks: [],
              scanning: false,
              error: String(e?.message || e),
            });
          }
        }),
      );
      cx.notify();
    });
  }

  async executeCheck(service, check, context, cx) {
    const resKey = this.checkKey(service.id, check.command);
    const current = this.checkResults.get(resKey);
    if (current?.status === "running") return;

    const on = this.on;
    const started = Date.now();
    this.checkResults.set(resKey, {
      status: "running",
      exitCode: null,
      durationMs: null,
      output: "",
      updatedAt: started,
      expanded: Boolean(current?.expanded),
    });
    cx.notify();

    const r = await exec(check.cmd, check.args, {
      cwd: service.root,
      on,
      timeout: 120000,
    }).catch((e) => ({
      code: 1,
      stdout: "",
      stderr: String(e?.message || e),
    }));

    if (key() !== context) return;
    const durationMs = Date.now() - started;
    const exitCode = typeof r?.code === "number" ? r.code : 1;
    const output = tailOutput(r?.stdout, r?.stderr, 60, 4000);
    const passed = exitCode === 0;

    this.checkResults.set(resKey, {
      status: passed ? "passed" : "failed",
      exitCode,
      durationMs,
      output,
      updatedAt: Date.now(),
      expanded: !passed || Boolean(current?.expanded),
    });
    cx.notify();
  }

  runCheck(service, check, cx) {
    if (!service || !check) return;
    const context = this.context;
    cx.spawn(async (cx) => {
      await this.executeCheck(service, check, context, cx);
    });
  }

  runAllChecks(servicesToRun, targetId, cx) {
    if (this.runningAllTarget || !servicesToRun || servicesToRun.length === 0) return;
    const context = this.context;
    this.runningAllTarget = targetId;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        for (const svc of servicesToRun) {
          if (key() !== context) return;
          const entry = this.checksByService.get(svc.id);
          if (!entry || !entry.checks || entry.checks.length === 0) continue;
          for (const check of entry.checks) {
            if (key() !== context) return;
            await this.executeCheck(svc, check, context, cx);
          }
        }
      } finally {
        if (key() !== context) return;
        if (this.runningAllTarget === targetId) {
          this.runningAllTarget = null;
        }
        cx.notify();
      }
    });
  }

  toggleCheckOutput(serviceId, command, cx) {
    const resKey = this.checkKey(serviceId, command);
    const cur = this.checkResults.get(resKey);
    if (!cur) return;
    this.checkResults.set(resKey, { ...cur, expanded: !cur.expanded });
    cx.notify();
  }

  getFailedChecksForTargets() {
    const targets = this.getCheckTargetServices();
    const failures = [];
    for (const svc of targets) {
      const entry = this.checksByService.get(svc.id);
      if (!entry || !entry.checks) continue;
      for (const chk of entry.checks) {
        const res = this.checkResults.get(this.checkKey(svc.id, chk.command));
        if (res && res.status === "failed") {
          failures.push({ service: svc, check: chk, result: res });
        }
      }
    }
    return failures;
  }

  async sendCheckFailuresToAgent(cx) {
    const failures = this.getFailedChecksForTargets();
    if (this.sendingCheckFailures || failures.length === 0) return;

    const agent = this.findActiveAgent();
    if (!agent) {
      this.note = "No active agent found to send check failures to.";
      notify({
        title: "No active agent found",
        body: "Open or focus an agent terminal to send check failures.",
        level: "warning",
      });
      cx.notify();
      return;
    }

    this.sendingCheckFailures = true;
    this.note = null;
    cx.notify();

    try {
      const byService = new Map();
      for (const item of failures) {
        if (!byService.has(item.service.id)) byService.set(item.service.id, []);
        byService.get(item.service.id).push(item);
      }

      const parts = [
        `Repository check failures in workspace (${this.workspaceRoot || this.root || ""}):`,
        "",
      ];

      for (const [, items] of byService) {
        const svc = items[0].service;
        const branchNote = svc.branch ? ` · branch: ${svc.branch}` : "";
        parts.push(`### Service: ${svc.name} (${svc.root}${branchNote})`, "");
        for (const { check, result } of items) {
          parts.push(`- Failed check: \`${check.command}\` (source: ${check.source}, exit code: ${result.exitCode ?? 1})`);
          if (result.output) {
            parts.push("  ```text");
            for (const line of tailOutput(result.output, "", 40, 2500).split("\n")) {
              parts.push(`  ${line}`);
            }
            parts.push("  ```");
          }
          parts.push("");
        }
      }

      const r = await hc(["send", agent.address, parts.join("\n")]);
      if (r.code !== 0) {
        throw new Error(r.stderr || r.stdout || "Failed to send check failures to agent");
      }
      notify({
        title: "Check failures sent to agent",
        body: `${failures.length} failed check${failures.length === 1 ? "" : "s"} sent to ${agent.address}.`,
        level: "success",
      });
    } catch (e) {
      this.note = `Failed to send check failures: ${e.message || e}`;
      notify({
        title: "Failed to send check failures",
        body: String(e?.message || e),
        level: "error",
      });
    } finally {
      this.sendingCheckFailures = false;
      cx.notify();
    }
  }

  selectService(serviceId, cx) {
    if (this.activeService === serviceId) return;
    this.activeService = serviceId;
    const now = Date.now();
    this.lastActiveServiceTs = now;
    if (this.workspaceRoot) {
      setShared("mesh.activeService", {
        workspaceRoot: this.workspaceRoot,
        serviceId: this.activeService,
        ts: now,
      });
    }
    if (this.viewMode === "commit" && this.selectedCommit) {
      if (this.activeService !== "all" && this.selectedCommit.serviceId !== this.activeService) {
        this.switchMode("working", null, cx);
        if (this.checksOpen) this.ensureChecksDiscovered(cx, false);
        return;
      }
    }
    this.applyServiceFilter(cx);
    if (this.checksOpen) this.ensureChecksDiscovered(cx, false);
  }

  applyServiceFilter(cx) {
    if (this.viewMode === "working") {
      if (this.activeService === "all") {
        this.files = this.allWorkingFiles;
      } else {
        this.files = this.allWorkingFiles.filter((f) => f.serviceId === this.activeService);
      }
      if (this.open && !this.files.some((f) => f.key === this.open)) {
        this.open = this.files.length ? this.files[0].key : null;
        this.setLines([]);
        if (this.open) {
          const context = this.context;
          if (cx) {
            cx.spawn(async (cx) => {
              try { await this.load(this.open, context); } catch {}
              cx.notify();
            });
          }
        }
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
    this.note = null;
    this.error = null;

    if (mode === "working") {
      this.selectedCommit = null;
      this.files = this.activeService === "all"
        ? (this.allWorkingFiles || [])
        : (this.allWorkingFiles || []).filter((f) => f.serviceId === this.activeService);
      this.open = this.files.length ? this.files[0].key : null;
      this.setLines([]);
      if (this.open) {
        const context = this.context;
        cx.spawn(async (cx) => {
          try { await this.load(this.open, context); } catch {}
          cx.notify();
        });
      }
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
    this.setLines([]);
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
        if (files.length) {
          this.open = files[0].key;
          await this.load(this.open, context);
        }
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
    this.note = null;
    cx.spawn(async (cx) => {
      const errors = [];
      try {
        for (const repo of targetRepos) {
          const root = repo.root;
          for (const args of [["add", "-A"], ["commit", "-m", message]]) {
            const r = await exec("git", args, { cwd: root, on });
            if (r.code !== 0) {
              errors.push(`[${repo.name}]: ${(r.stderr || r.stdout).trim()}`);
              break;
            }
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
        if (key() === context) this.note = `Commit failed:\n${e.message || e}`;
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
    if (this.on || !Array.isArray(services) || services.length === 0) {
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
    if (this.loading || this.busy) return;
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
      this.setLines([]);
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
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
      this.checksByService.clear();
      this.checkResults.clear();
      this.runningAllTarget = null;
      this.sendingCheckFailures = false;
    }

    this.isWindows = !on && this.hostIsWindows;

    if (!workspaceRoot) {
      this.error = "No folder";
      return;
    }

    this.hasLoadedOnce = true;
    const activeSpace = spaces().find((s) => s.active);
    const activeTab = (activeSpace?.tabs || []).find((t) => t.active) || null;
    const activeTabId = activeTab?.id || null;
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
      (bus.tabId || null) === (activeTabId || null) &&
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
      this.setLines([]);
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
      this.setLines([]);
      this.stopAllWatchers();
      this.error = null;
      this.applyServiceFilter();
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
    const tabPaneCwds = activeTabId
      ? Array.from(new Set(allPanesList.filter((p) => p.tab === activeTabId && p.cwd).map((p) => p.cwd)))
      : [];
    const tabFlowObj = activeTabId && shared("mesh.flows")?.[activeTabId];
    const tabTermAddrs = activeTabId
      ? Array.from(
          new Set([
            ...(tabFlowObj?.leadTerminal ? [tabFlowObj.leadTerminal] : []),
            ...allPanesList.filter((p) => p.tab === activeTabId && p.terminal && p.labels?.meshRunner !== "true").map((p) => p.terminal),
            ...(agents() || []).filter((a) => a.tab === activeTabId).map((a) => a.address),
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
          this.setLines([]);
          this.open = null;
          this.stopAllWatchers();
          this.error = "Not a git repository";
          return;
        }

        // Query target services in parallel with single git status -b call per repo
        const serviceResults = await Promise.all(
          candidateServices.map(async (service) => {
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

              // Expand untracked directory entries (?? dir/) cleanly for individual file review
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

              const commits = await listCommits(service.root, branch, on, service);
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
          })
        );

        if (key() !== context) return;

        const rawTouched = serviceResults.filter((r) => r.touched);
        const touchedResults = (activeTabId && !usingBusServices)
          ? await attributeSessionRepos(activeTabId, rawTouched, tabPaneCwds, tabTermAddrs, this.lastTranscriptScan)
          : rawTouched;
        if (key() !== context) return;
        const services = touchedResults.map((r) => r.service);

        this.workspaceRoot = workspaceRoot;
        this.services = services;
        this.root = services[0]?.root || workspaceRoot;

        // Check external mesh.activeService
        const prevActiveService = this.activeService;
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
        const servicesSig = (activeTabId || "") + "::" + normWs + "::" + nextCandidates.length + "::" + services.map((s) => `${normPathStr(s.root)}@${s.branch || ""}:${s.workingCount || 0}:${s.aheadCount || 0}`).join(",");
        const existingBusSig = existingBus && normPathStr(existingBus.workspaceRoot) === normWs && (existingBus.tabId || null) === (activeTabId || null)
          ? (existingBus.sig || ((activeTabId || "") + "::" + normWs + "::" + (existingBus.candidates?.length ?? -1) + "::" + (existingBus.services || []).map((s) => `${normPathStr(s.root)}@${s.branch || ""}:${s.workingCount || 0}:${s.aheadCount || 0}`).join(",")))
          : null;
        if ((!usingBusServices || force || servicesSig !== existingBusSig) && servicesSig !== this.lastPublishedServicesSig) {
          this.lastPublishedServicesSig = servicesSig;
          const pubTs = Date.now();
          this.lastConsumedBusTs = pubTs;
          this.lastConsumedBusSig = servicesSig;
          setShared("mesh.services", {
            tabId: activeTabId || null,
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
        this.applyServiceFilter();
        if (this.checksOpen && (prevActiveService !== this.activeService || !this.checksByService.size)) {
          this.ensureChecksDiscovered(cx, false);
        }

        if (this.viewMode === "working") {
          this.limited = this.files.length > 1000;
          this.error = null;
          if (this.open && !this.files.some((f) => f.key === this.open)) {
            this.open = null;
            this.setLines([]);
          }
          if (!this.open && !this.closed && this.files.length) {
            this.open = this.files[0].key;
          }
          if (this.open) {
            try {
              await this.load(this.open, context);
            } catch {
              if (key() === context && this.open) {
                this.setLines(["Cannot preview this diff (too large or unreadable)"]);
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

  async load(fileKey, context) {
    const file = (this.files || []).find((f) => f.key === fileKey) || (this.allWorkingFiles || []).find((f) => f.key === fileKey);
    if (!file) return;
    const root = file.repoRoot, on = this.on;
    const path = file.path;
    let lines;
    const isExpanded = Boolean(this.expandedFiles && this.expandedFiles.has(fileKey));

    if (this.viewMode === "working") {
      if (file.fresh || (!file.hasHead && file.status === "A")) {
        const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
        if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
        else if (text.includes("\0")) lines = ["Binary file · no text diff"];
        else {
          file.add = countLines(text);
          lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 450).map((l) => `+${l}`)];
        }
      } else {
        const diffArgs = ["diff", ...(file.hasHead ? ["HEAD"] : []), ...(isExpanded ? ["-U99999"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
        const r = await exec("git", [...READ, ...diffArgs], { cwd: root, on });
        if (r.code !== 0) throw new Error(r.stderr || "git diff failed");
        const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
        lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
      }
    } else if (this.viewMode === "commit" && this.selectedCommit) {
      const diffArgs = ["show", this.selectedCommit.hash, ...(isExpanded ? ["-U99999"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path];
      const r = await exec("git", [...READ, ...diffArgs], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr || "git show failed");
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }

    if ((key() === context || !context) && this.open === fileKey) {
      const maxLines = isExpanded ? 800 : 350;
      let finalLines = lines || [];
      if (finalLines.length > maxLines) {
        const remaining = finalLines.length - maxLines;
        finalLines = finalLines.slice(0, maxLines);
        finalLines.push(`@@ -0,0 +0,0 @@ [Diff preview truncated: showing first ${maxLines} lines. ${remaining} more lines hidden. ${isExpanded ? "File is very large." : "Click Expand context above for more."}]`);
      }
      this.setLines(finalLines.map((line) => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line)));
    }
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map((line) => line.length * 7 + 50));
  }

  pick(fileKey, cx) {
    this.open = this.open === fileKey ? null : fileKey;
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) {
      cx.spawn(async (cx) => {
        try {
          await this.load(fileKey, context);
        } catch (e) {
          if (key() === context && this.open === fileKey) this.note = `Cannot preview this diff (too large or unreadable): ${e.message || e}`;
        }
        cx.notify();
      });
    }
    cx.notify();
  }

  toggleExpand(fileKey, cx) {
    if (!fileKey || this.loading) return;
    if (this.expandedFiles.has(fileKey)) {
      this.expandedFiles.delete(fileKey);
    } else {
      this.expandedFiles.add(fileKey);
    }
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        await this.load(fileKey, context);
      } catch (e) {
        if (key() === context && this.open === fileKey) {
          this.note = `Cannot preview this diff (too large or unreadable): ${e.message || e}`;
        }
      }
      cx.notify();
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t, dt, commentMap) {
    if (kind === "@") {
      const isExpanded = Boolean(this.expandedFiles && this.expandedFiles.has(this.open));
      return h_flex().w_full().px(12).h(20).flex_none().items_center().justify_between()
        .bg(t.raised).border_b(1).border_color(t.border)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleExpand(this.open, cx))
        .child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(text))
        .child(
          div().flex_none().px(5).py(0.5).rounded(3).bg(t.background).text_size(9.5).text_color(t.muted)
            .child(isExpanded ? "Collapse context" : "Expand context")
        );
    }
    const isCommentable = number !== undefined;
    const existing = (isCommentable && commentMap) ? commentMap.get(number) : null;
    const isActive = this.activeComment && this.activeComment.fileKey === this.open && this.activeComment.line === number;
    const canSave = Boolean(this.commentText.trim());

    const isAdd = kind === "+";
    const isDel = kind === "-";
    const diffColor = isAdd ? dt.add : isDel ? dt.del : null;
    const rowBg = isAdd ? dt.addBg : isDel ? dt.delBg : null;
    const hoverBg = isAdd ? dt.addHover : isDel ? dt.delHover : t.hover;

    const row = h_flex().w_full().h(20).flex_none().gap(10).cursor_pointer()
      .when(Boolean(rowBg), (e) => e.bg(rowBg))
      .when(Boolean(existing) || Boolean(isActive), (e) => e.bg(t.selected))
      .hover((s) => s.bg(hoverBg))
      .on_click((_e, cx) => {
        if (isCommentable) this.startComment(this.open, number, text, cx);
      })
      .child(
        div().w(30).flex_none().text_right()
          .text_color(existing || isActive ? t.foreground : diffColor || t.dim)
          .child(number === undefined ? "" : String(number))
      )
      .child(
        div().flex_1().min_w(0).truncate()
          .text_color(diffColor || t.foreground)
          .child(text)
      );

    if (!isActive && !existing) {
      return row;
    }

    return v_flex().w_full().flex_none()
      .child(row)
      .when(Boolean(isActive), (c) => c.child(
        v_flex().w_full().pl(8).pr(14).py(8).gap(6).bg(t.raised).border_b(1).border_t(1).border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
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
      ))
      .when(!isActive && Boolean(existing), (c) => c.child(
        h_flex().w_full().pl(12).pr(16).py(6).gap(8).items_start().bg(t.raised).border_b(1).border_color(t.border).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.startComment(this.open, number, text, cx))
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
                this.removeComment(this.open, number, cx);
              })
              .child(svg("mods/changes-review/icons/trash.svg").size(10).text_color(t.dim))
          )
      ));
  }

  renderChecksDrawer(t, mono, targetServices, failedChecks) {
    const passColor = t.ansi2 || t.done || t.accent;
    const failColor = t.ansi1 || t.blocked;
    const warnColor = t.working || t.accent;
    const totalChecks = targetServices.reduce((n, svc) => {
      const entry = this.checksByService.get(svc.id);
      return n + (entry?.checks?.length || 0);
    }, 0);
    const isRunningAny = Boolean(this.runningAllTarget) || targetServices.some((svc) => {
      const entry = this.checksByService.get(svc.id);
      return (entry?.checks || []).some((c) => this.checkResults.get(this.checkKey(svc.id, c.command))?.status === "running");
    });

    return v_flex()
      .id("changes-checks-drawer")
      .flex_none()
      .max_h(220)
      .border_b(1)
      .border_color(t.border)
      .bg(t.raised)
      .child(
        h_flex()
          .flex_none()
          .h(32)
          .px(10)
          .gap(6)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child("Checks"))
              .child(
                div()
                  .truncate()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .child(
                    targetServices.length === 1
                      ? targetServices[0].name
                      : `${targetServices.length} services`,
                  ),
              ),
          )
          .child(
            h_flex()
              .flex_none()
              .gap(5)
              .items_center()
              .child(
                h_flex()
                  .id("checks-rescan-btn")
                  .h(22)
                  .px(7)
                  .items_center()
                  .rounded(4)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .text_size(10)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.ensureChecksDiscovered(cx, true))
                  .child("Rescan"),
              )
              .child(
                h_flex()
                  .id("checks-run-all-btn")
                  .h(22)
                  .px(8)
                  .items_center()
                  .rounded(4)
                  .bg(totalChecks > 0 && !isRunningAny ? t.solid : t.background)
                  .border_1()
                  .border_color(totalChecks > 0 && !isRunningAny ? t.solid : t.border)
                  .text_size(10)
                  .font_medium()
                  .text_color(totalChecks > 0 && !isRunningAny ? t.solid_foreground : t.dim)
                  .when(totalChecks > 0 && !isRunningAny, (btn) =>
                    btn.cursor_pointer().on_click((_e, cx) => this.runAllChecks(targetServices, "__all__", cx)),
                  )
                  .child(this.runningAllTarget === "__all__" ? "Running…" : "Run All Checks"),
              )
              .when(failedChecks.length > 0, (el) =>
                el.child(
                  h_flex()
                    .id("checks-send-failures-btn")
                    .h(22)
                    .px(8)
                    .gap(4)
                    .items_center()
                    .rounded(4)
                    .bg(hexWithAlpha(failColor, "22"))
                    .border_1()
                    .border_color(hexWithAlpha(failColor, "77"))
                    .text_size(10)
                    .font_semibold()
                    .text_color(failColor)
                    .when(!this.sendingCheckFailures, (btn) =>
                      btn.cursor_pointer().hover((s) => s.bg(hexWithAlpha(failColor, "33"))).on_click((_e, cx) => this.sendCheckFailuresToAgent(cx)),
                    )
                    .child(this.sendingCheckFailures ? "Sending…" : "Send Failures to Agent"),
                ),
              )
              .child(
                h_flex()
                  .id("checks-close-btn")
                  .h(22)
                  .w(22)
                  .items_center()
                  .justify_center()
                  .rounded(4)
                  .text_size(11)
                  .text_color(t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => {
                    this.checksOpen = false;
                    cx.notify();
                  })
                  .child("×"),
              ),
          ),
      )
      .child(
        v_flex()
          .id("changes-checks-body")
          .flex_1()
          .min_h(0)
          .max_h(186)
          .overflow_y_scrollbar()
          .track_scroll(this.checksScroll)
          .p(8)
          .gap(8)
          .children(
            targetServices.map((svc) => {
              const entry = this.checksByService.get(svc.id);
              const docs = entry?.standardsDocs || [];
              const checks = entry?.checks || [];
              const branchLabel = svc.branch || "";
              const svcRunning = this.runningAllTarget === svc.id || this.runningAllTarget === "__all__";

              return v_flex()
                .id(`checks-svc-${svc.id}`)
                .flex_none()
                .p(6)
                .gap(5)
                .rounded(6)
                .bg(t.background)
                .border_1()
                .border_color(t.border)
                .child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .justify_between()
                    .child(
                      h_flex()
                        .flex_1()
                        .min_w(0)
                        .gap(5)
                        .items_center()
                        .child(div().truncate().text_size(11).font_medium().text_color(t.foreground).child(svc.name))
                        .when(Boolean(branchLabel), (b) =>
                          b.child(
                            div()
                              .max_w(110)
                              .truncate()
                              .text_size(9.5)
                              .text_color(t.dim)
                              .child(branchLabel),
                          ),
                        )
                        .children(
                          docs.map((docName) =>
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
                              .child(docName),
                          ),
                        ),
                    )
                    .when(checks.length > 0 && targetServices.length > 1, (b) =>
                      b.child(
                        h_flex()
                          .id(`checks-run-svc-${svc.id}`)
                          .h(20)
                          .px(6)
                          .flex_none()
                          .items_center()
                          .rounded(4)
                          .bg(t.raised)
                          .border_1()
                          .border_color(t.border)
                          .text_size(9.5)
                          .text_color(svcRunning ? t.dim : t.foreground)
                          .when(!svcRunning, (btn) =>
                            btn.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.runAllChecks([svc], svc.id, cx)),
                          )
                          .child(svcRunning ? "Running…" : "Run All"),
                      ),
                    ),
                )
                .when(Boolean(entry?.scanning), (el) =>
                  el.child(div().text_size(10.5).text_color(t.dim).child("Inspecting repository checks…")),
                )
                .when(Boolean(entry?.error), (el) =>
                  el.child(div().text_size(10.5).text_color(failColor).child(`Scan failed: ${entry.error}`)),
                )
                .when(!entry?.scanning && !entry?.error && checks.length === 0, (el) =>
                  el.child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child("No check commands detected in AGENTS.md, CLAUDE.md, SPEC.md, package.json, pom.xml, Cargo.toml, or Makefile."),
                  ),
                )
                .children(
                  checks.map((chk, idx) => {
                    const res = this.checkResults.get(this.checkKey(svc.id, chk.command));
                    const status = res?.status || "idle";
                    const isRunning = status === "running";
                    const statusLabel = status === "passed"
                      ? "✓ Pass"
                      : status === "failed"
                        ? `✗ Fail${res?.exitCode != null ? ` (${res.exitCode})` : ""}`
                        : status === "running"
                          ? "Running…"
                          : "Idle";
                    const statusColor = status === "passed"
                      ? passColor
                      : status === "failed"
                        ? failColor
                        : status === "running"
                          ? warnColor
                          : t.dim;
                    const durText = res?.durationMs != null
                      ? (res.durationMs < 1000 ? `${res.durationMs}ms` : `${(res.durationMs / 1000).toFixed(1)}s`)
                      : "";

                    return v_flex()
                      .id(`check-item-${svc.id}-${idx}`)
                      .flex_none()
                      .gap(4)
                      .p(5)
                      .rounded(5)
                      .bg(t.raised)
                      .border_1()
                      .border_color(status === "failed" ? hexWithAlpha(failColor, "55") : t.border)
                      .child(
                        h_flex()
                          .gap(6)
                          .items_center()
                          .child(
                            div()
                              .flex_none()
                              .px(5)
                              .py(0.5)
                              .rounded(3)
                              .bg(status === "idle" ? t.background : hexWithAlpha(statusColor, "22"))
                              .text_size(9.5)
                              .font_medium()
                              .text_color(statusColor)
                              .child(statusLabel),
                          )
                          .child(
                            div()
                              .flex_1()
                              .min_w(0)
                              .truncate()
                              .font_family(mono)
                              .text_size(10.5)
                              .text_color(t.foreground)
                              .child(chk.command),
                          )
                          .child(
                            div()
                              .flex_none()
                              .px(4)
                              .py(0.5)
                              .rounded(3)
                              .bg(t.background)
                              .text_size(9)
                              .text_color(t.dim)
                              .child(chk.source),
                          )
                          .when(Boolean(durText), (el) =>
                            el.child(div().flex_none().text_size(9.5).text_color(t.dim).child(durText)),
                          )
                          .when(Boolean(res?.output), (el) =>
                            el.child(
                              h_flex()
                                .id(`check-toggle-out-${svc.id}-${idx}`)
                                .h(20)
                                .px(5)
                                .flex_none()
                                .items_center()
                                .rounded(4)
                                .bg(t.background)
                                .border_1()
                                .border_color(t.border)
                                .text_size(9.5)
                                .text_color(t.muted)
                                .cursor_pointer()
                                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                                .on_click((_e, cx) => this.toggleCheckOutput(svc.id, chk.command, cx))
                                .child(res.expanded ? "Hide" : "Output"),
                            ),
                          )
                          .child(
                            h_flex()
                              .id(`check-run-${svc.id}-${idx}`)
                              .h(20)
                              .px(7)
                              .flex_none()
                              .items_center()
                              .rounded(4)
                              .bg(isRunning ? t.background : t.solid)
                              .text_size(9.5)
                              .font_medium()
                              .text_color(isRunning ? t.dim : t.solid_foreground)
                              .when(!isRunning, (btn) =>
                                btn.cursor_pointer().on_click((_e, cx) => this.runCheck(svc, chk, cx)),
                              )
                              .child(isRunning ? "…" : res ? "Re-run" : "Run"),
                          ),
                      )
                      .when(Boolean(res?.output && res?.expanded), (el) =>
                        el.child(
                          v_flex()
                            .id(`check-out-${svc.id}-${idx}`)
                            .w_full()
                            .max_h(110)
                            .overflow_y_scrollbar()
                            .p(6)
                            .gap(1)
                            .rounded(4)
                            .bg(t.background)
                            .border_1()
                            .border_color(t.border)
                            .font_family(mono)
                            .text_size(10)
                            .children(
                              res.output.split("\n").map((line) =>
                                div()
                                  .w_full()
                                  .text_color(status === "failed" ? t.foreground : t.muted)
                                  .child(line || " "),
                              ),
                            ),
                        ),
                      );
                  }),
                );
            }),
          ),
      );
  }

  render(cx) {
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
    const t = theme();
    const addCount = this.files.reduce((n, f) => n + f.add, 0);
    const delCount = this.files.reduce((n, f) => n + f.del, 0);
    const dt = getDiffTheme(t);
    const { add, del } = dt;
    const passColor = t.ansi2 || t.done || t.accent;
    const failColor = t.ansi1 || t.blocked;
    const noteColor = t.blocked || t.working || t.accent;

    const { activeTabId } = getActiveSpaceAndTab();
    const flows = readFlows();
    const flow = activeTabId ? (flows[activeTabId] || {}) : {};
    const sortedServices = this.getSortedServices();
    const focusedService = this.activeService !== "all"
      ? (this.services.find((s) => s.id === this.activeService) || null)
      : (this.services.length === 1 ? this.services[0] : null);

    const checkTargetServices = this.getCheckTargetServices();
    const failedChecks = this.getFailedChecksForTargets();
    let runningChecksCount = 0;
    let passedChecksCount = 0;
    for (const svc of checkTargetServices) {
      const entry = this.checksByService.get(svc.id);
      for (const chk of entry?.checks || []) {
        const res = this.checkResults.get(this.checkKey(svc.id, chk.command));
        if (res?.status === "running") runningChecksCount++;
        else if (res?.status === "passed") passedChecksCount++;
      }
    }

    const targetRepos = this.getTargetRepos();
    const commitEnabled = Boolean(this.message.trim() && targetRepos.length > 0 && !this.busy && !this.loading);
    const agent = this.findActiveAgent();
    const agentName = agent ? (agent.title || agent.app || agent.address) : null;
    const mono = settings()?.font_family ?? "JetBrains Mono";

    const commentMap = new Map();
    if (this.open && this.reviews.length > 0) {
      for (const r of this.reviews) {
        if (r.fileKey === this.open || r.file === this.open) {
          commentMap.set(r.line, r);
        }
      }
    }

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
          if (this.typingComment || this.activeComment) {
            this.cancelActiveComment(cx);
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
        .child(div().flex_none().text_size(11).text_color(del).child(`−${delCount}`))
        .child(
          h_flex()
            .id("changes-checks-btn")
            .h(24)
            .px(8)
            .gap(4)
            .flex_none()
            .items_center()
            .rounded(5)
            .border_1()
            .border_color(
              failedChecks.length > 0
                ? hexWithAlpha(failColor, "77")
                : this.checksOpen
                  ? t.accent
                  : t.border,
            )
            .bg(
              failedChecks.length > 0
                ? hexWithAlpha(failColor, "22")
                : this.checksOpen
                  ? t.selected
                  : t.background,
            )
            .text_size(11)
            .font_medium()
            .text_color(
              failedChecks.length > 0
                ? failColor
                : this.checksOpen
                  ? t.foreground
                  : t.muted,
            )
            .cursor_pointer()
            .tooltip("Discover and run repository standard checks")
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.toggleChecksDrawer(cx))
            .child("Checks")
            .when(runningChecksCount > 0, (el) =>
              el.child(div().text_size(10).text_color(t.working || t.accent).child("…")),
            )
            .when(runningChecksCount === 0 && failedChecks.length > 0, (el) =>
              el.child(
                div()
                  .px(4)
                  .py(0.5)
                  .rounded(3)
                  .bg(hexWithAlpha(failColor, "33"))
                  .text_size(9.5)
                  .text_color(failColor)
                  .child(String(failedChecks.length)),
              ),
            )
            .when(runningChecksCount === 0 && failedChecks.length === 0 && passedChecksCount > 0, (el) =>
              el.child(div().text_size(10).text_color(passColor).child("✓")),
            ),
        ))

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
                const svcStatus = this.getServiceReviewStatus(s.id, flow);
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
        const svcStatus = this.getServiceReviewStatus(svc.id, flow);
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

      // Collapsible Repo Checks Drawer
      .when(this.checksOpen, (el) =>
        el.child(this.renderChecksDrawer(t, mono, checkTargetServices, failedChecks)),
      )

      // File list (changes-list)
      .child(v_flex().id("changes-list").flex_none().h(Math.min(this.checksOpen ? 96 : 160, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).border_b(1).border_color(t.border).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.key}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
          .when(this.open === f.key, (e) => e.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.pick(f.key, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? add : f.status === "D" || f.status === "U" ? del : t.blocked).child(f.status))
          .when(this.services.length > 1 && this.activeService === "all", (e) => e.child(
            div().flex_none().px(4).py(0.5).rounded(3).bg(t.raised).border_1().border_color(t.border).text_size(9.5).text_color(t.muted).child(f.serviceName)
          ))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(add).child(`+${f.add}`)))
          .when(f.del > 0, (e) => e.child(div().text_size(11).text_color(del).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(
        this.error || (this.loading ? "Loading changes…" : this.services.length ? (this.viewMode === "commit" ? "No files changed in this commit" : "No uncommitted changes") : "No folder")
      ))))

      .when(this.limited, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))

      // Diff area
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(v_flex().id("changes-diff-lines").size_full().overflow_y_scrollbar().children(
          this.rows.map((row) => this.diffRow(row, t, dt, commentMap))
        ))
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(4).text_size(11).text_color(del).child(this.note)))

      // Bottom switcher bar (Review | Commit)
      .child(
        h_flex().flex_none().h(28).px(8).gap(6).items_center().border_t(1).border_color(t.border).bg(t.raised)
          .child(
            h_flex().id("tab-review").px(8).py(3).gap(5).items_center().rounded(4).text_size(11).font_medium().cursor_pointer()
              .when(this.bottomTab === "review", (e) => e.bg(t.background).text_color(t.foreground).border_1().border_color(t.border), (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
              .on_click((_e, cx) => { this.bottomTab = "review"; cx.notify(); })
              .child(svg("mods/changes-review/icons/comment.svg").size(11).text_color(this.bottomTab === "review" ? t.foreground : t.muted))
              .child(div().child("Review"))
              .when(this.reviews.length > 0, (el) => el.child(
                div().px(4).py(0.5).rounded(3).border_1().border_color(t.border).text_color(t.muted).text_size(9.5).child(String(this.reviews.length))
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
          .when(this.reviews.length === 0, (h) => h.child(
            div().py(6).px(4).text_size(11).text_color(t.dim).child("Click any diff line to add an inline review note.")
          ))
          .when(this.reviews.length > 0, (l) => l.child(
            div().w_full().h(Math.min(116, Math.max(26, this.reviews.length * 29 - 3))).flex_none().relative()
              .child(
                v_flex().id("reviews-list").size_full().overflow_y_scroll().when(this.reviews.length > 4, (e) => e.pr(10)).gap(3).children(
                  this.reviews.map((r) => {
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
              .when(this.reviews.length > 4, (e) => e.child(
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
                  .when(this.reviews.length > 0, (el) => el.child(
                    div().px(6).py(2).rounded(4).text_size(10.5).text_color(t.dim).cursor_pointer()
                      .hover((s) => s.text_color(del))
                      .on_click((_e, cx) => this.clearComments(cx))
                      .child("Clear all")
                  ))
                  .child(
                    h_flex().id("send-review-btn").h(30).px(14).gap(6).items_center().rounded(8)
                      .bg(this.reviews.length > 0 && !this.sendingReview ? t.solid : t.raised)
                      .text_color(this.reviews.length > 0 && !this.sendingReview ? t.solid_foreground : t.dim)
                      .text_size(12)
                      .when(this.reviews.length > 0 && !this.sendingReview, (b) => b.cursor_pointer().on_click((_e, cx) => this.sendReview(cx)))
                      .child(svg("mods/changes-review/icons/send.svg").size(11).text_color(this.reviews.length > 0 && !this.sendingReview ? t.solid_foreground : t.dim))
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
