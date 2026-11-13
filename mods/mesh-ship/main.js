import { View, div, svg } from "gpui-kit";
import {
  v_flex, h_flex, InputState, Input, TextareaState, Textarea, ScrollHandle,
} from "gpui-base";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import {
  spaces, panes, focused, agents, terminals, exec, readTextFile, writeTextFile,
  appHome, theme, settings, notify, hc, shared, setShared, window,
} from "herdr";

// Every read-only Git command uses lock-free flags so we never acquire .git/index.lock
// or trip filesystem watchers on active repositories.
const READ_GIT_FLAGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false",
];

const DEFAULT_CHAIN = ["development", "ci", "main"];

const DEFAULT_PR_TEMPLATE = [
  "## Ticket",
  "{{ticket}}",
  "",
  "## Summary",
  "{{summary}}",
  "",
  "## Affected Microservices",
  "{{services}}",
  "",
  "## Test & Verification Evidence",
  "{{testSummary}}",
].join("\n");

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
const GH_TIMEOUT_MS = 15000;
const PASSIVE_CACHE_TTL_MS = 20000;

const GRAPHQL_THREADS_QUERY = [
  "query($owner: String!, $name: String!, $number: Int!) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $number) {",
  "      reviewThreads(first: 50) {",
  "        nodes {",
  "          isResolved",
  "          isOutdated",
  "          path",
  "          line",
  "          comments(first: 10) {",
  "            nodes {",
  "              author { login }",
  "              body",
  "              createdAt",
  "            }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join(" ");

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normPath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

function basename(p) {
  const norm = normPath(p);
  if (!norm) return "";
  return norm.split("/").filter(Boolean).pop() || norm;
}

function withAlpha(color, alphaHex, fallback = "#00000000") {
  if (typeof color !== "string" || !color.startsWith("#")) return fallback;
  const raw = color.slice(1);
  if (raw.length === 6) return `#${raw}${alphaHex}`;
  if (raw.length === 8) return `#${raw.slice(0, 6)}${alphaHex}`;
  if (raw.length === 3) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}${alphaHex}`;
  }
  return fallback;
}

function extractTicket(...sources) {
  for (const src of sources) {
    if (typeof src !== "string" || !src) continue;
    const match = JIRA_KEY_RE.exec(src);
    if (match) return match[1];
  }
  return null;
}

function parseChainInput(raw) {
  if (Array.isArray(raw)) {
    const cleaned = raw.map((s) => String(s || "").trim()).filter(Boolean);
    return dedupeConsecutive(cleaned);
  }
  if (typeof raw !== "string") return [];
  const parts = raw
    .split(/\s*(?:,|->|→|>|;|\n)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  return dedupeConsecutive(parts);
}

function dedupeConsecutive(items) {
  const out = [];
  for (const item of items) {
    if (out.length === 0 || out[out.length - 1] !== item) {
      out.push(item);
    }
  }
  return out;
}

function computePhases(chain) {
  const safeChain = Array.isArray(chain) && chain.length > 0 ? chain : DEFAULT_CHAIN;
  const phases = [
    {
      index: 0,
      key: `feature->${safeChain[0]}`,
      label: `Feature → ${safeChain[0]}`,
      shortLabel: `→ ${safeChain[0]}`,
      isFeaturePhase: true,
      headLabel: "feature",
      baseBranch: safeChain[0],
    },
  ];
  for (let i = 1; i < safeChain.length; i += 1) {
    phases.push({
      index: i,
      key: `${safeChain[i - 1]}->${safeChain[i]}`,
      label: `${safeChain[i - 1]} → ${safeChain[i]}`,
      shortLabel: `${safeChain[i - 1]} → ${safeChain[i]}`,
      isFeaturePhase: false,
      headBranch: safeChain[i - 1],
      baseBranch: safeChain[i],
    });
  }
  return phases;
}

function resolveServiceBranches(svcChain, phaseIdx, currentBranch) {
  const chain = Array.isArray(svcChain) && svcChain.length > 0 ? svcChain : DEFAULT_CHAIN;
  if (phaseIdx === 0) {
    return {
      phaseAvailable: true,
      isFeaturePhase: true,
      headBranch: currentBranch || "HEAD",
      baseBranch: chain[0],
    };
  }
  if (phaseIdx < chain.length) {
    return {
      phaseAvailable: true,
      isFeaturePhase: false,
      headBranch: chain[phaseIdx - 1],
      baseBranch: chain[phaseIdx],
    };
  }
  return {
    phaseAvailable: false,
    isFeaturePhase: false,
    headBranch: null,
    baseBranch: null,
  };
}

function getPrTemplateFilePath() {
  return path.join(appHome(), "mesh", "pr-template.md");
}

function readPipelineConfig(workspaceRoot) {
  const raw = asPlainObject(shared("mesh.pipelineConfig"));
  const defaultChain = parseChainInput(raw.defaultChain);
  const resolvedDefaultChain = defaultChain.length > 0 ? defaultChain : [...DEFAULT_CHAIN];
  const resolvedDefaultTemplate =
    typeof raw.defaultPrTemplate === "string" && raw.defaultPrTemplate.trim()
      ? raw.defaultPrTemplate
      : DEFAULT_PR_TEMPLATE;

  const workspaces = asPlainObject(raw.workspaces);
  const normRoot = normPath(workspaceRoot);
  const wsConfig =
    (normRoot && asPlainObject(workspaces[normRoot])) ||
    (workspaceRoot && asPlainObject(workspaces[workspaceRoot])) ||
    {};

  const wsChain = parseChainInput(wsConfig.chain);
  const chain = wsChain.length > 0 ? wsChain : resolvedDefaultChain;

  const rawOverrides = asPlainObject(wsConfig.repoOverrides);
  const repoOverrides = {};
  for (const [svcId, overrideVal] of Object.entries(rawOverrides)) {
    const parsed = parseChainInput(overrideVal);
    if (parsed.length > 0) repoOverrides[svcId] = parsed;
  }

  const prTemplate =
    typeof wsConfig.prTemplate === "string" && wsConfig.prTemplate.trim()
      ? wsConfig.prTemplate
      : resolvedDefaultTemplate;

  const prTemplatePath =
    typeof wsConfig.prTemplatePath === "string" && wsConfig.prTemplatePath.trim()
      ? wsConfig.prTemplatePath
      : getPrTemplateFilePath();

  const browserMode = wsConfig.browserMode === "headed" ? "headed" : "headless";

  return {
    raw,
    defaultChain: resolvedDefaultChain,
    defaultPrTemplate: resolvedDefaultTemplate,
    chain,
    repoOverrides,
    prTemplate,
    prTemplatePath,
    browserMode,
    hasWorkspaceEntry: Boolean(
      (normRoot && workspaces[normRoot]) || (workspaceRoot && workspaces[workspaceRoot]),
    ),
  };
}

function saveWorkspacePipelineConfig(workspaceRoot, patch) {
  const normRoot = normPath(workspaceRoot) || workspaceRoot || "__default__";
  const current = asPlainObject(shared("mesh.pipelineConfig"));
  const existingWorkspaces = asPlainObject(current.workspaces);
  const prevWs = asPlainObject(existingWorkspaces[normRoot] || existingWorkspaces[workspaceRoot]);

  const nextDefaultChain =
    parseChainInput(current.defaultChain).length > 0
      ? parseChainInput(current.defaultChain)
      : [...DEFAULT_CHAIN];
  const nextDefaultTemplate =
    typeof current.defaultPrTemplate === "string" && current.defaultPrTemplate.trim()
      ? current.defaultPrTemplate
      : DEFAULT_PR_TEMPLATE;

  const nextChain = patch.chain !== undefined
    ? (parseChainInput(patch.chain).length > 0 ? parseChainInput(patch.chain) : [...DEFAULT_CHAIN])
    : (parseChainInput(prevWs.chain).length > 0 ? parseChainInput(prevWs.chain) : [...nextDefaultChain]);

  const nextOverrides = patch.repoOverrides !== undefined
    ? patch.repoOverrides
    : asPlainObject(prevWs.repoOverrides);

  const nextTemplate = patch.prTemplate !== undefined
    ? (String(patch.prTemplate || "").trim() ? String(patch.prTemplate) : DEFAULT_PR_TEMPLATE)
    : (typeof prevWs.prTemplate === "string" && prevWs.prTemplate.trim()
      ? prevWs.prTemplate
      : nextDefaultTemplate);

  const nextTemplatePath = getPrTemplateFilePath();

  const nextWs = {
    ...prevWs,
    chain: nextChain,
    repoOverrides: nextOverrides,
    prTemplate: nextTemplate,
    prTemplatePath: nextTemplatePath,
    browserMode: prevWs.browserMode === "headed" ? "headed" : "headless",
    updatedAt: Date.now(),
  };

  const stripTs = (ws) => ({
    chain: ws?.chain || [],
    repoOverrides: ws?.repoOverrides || {},
    prTemplate: ws?.prTemplate || "",
    prTemplatePath: ws?.prTemplatePath || "",
    browserMode: ws?.browserMode || "headless",
  });

  if (
    existingWorkspaces[normRoot] &&
    JSON.stringify(stripTs(prevWs)) === JSON.stringify(stripTs(nextWs))
  ) {
    return nextWs;
  }

  const nextWorkspaces = { ...existingWorkspaces };
  if (workspaceRoot && workspaceRoot !== normRoot && nextWorkspaces[workspaceRoot]) {
    delete nextWorkspaces[workspaceRoot];
  }
  nextWorkspaces[normRoot] = nextWs;

  setShared("mesh.pipelineConfig", {
    ...current,
    defaultChain: nextDefaultChain,
    defaultPrTemplate: nextDefaultTemplate,
    workspaces: nextWorkspaces,
  });
  return nextWs;
}

async function mirrorPrTemplateToDisk(templateText) {
  const filePath = getPrTemplateFilePath();
  const dirPath = path.dirname(filePath);
  await mkdir(dirPath, { recursive: true }).catch(() => {});
  const prev = await readTextFile(filePath).catch(() => null);
  if (prev === templateText) return filePath;
  try {
    await writeTextFile(filePath, templateText, prev);
  } catch {
    try {
      const latest = await readTextFile(filePath).catch(() => null);
      if (latest !== templateText) {
        await writeTextFile(filePath, templateText, latest);
      }
    } catch {
      await writeFile(filePath, templateText);
    }
  }
  return filePath;
}

function readFlows() {
  return asPlainObject(shared("mesh.flows"));
}

function updateTabFlow(tabId, patch, workspaceRoot = "") {
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
  const nextFlow = {
    ...prev,
    tabId,
    workspaceRoot: prev.workspaceRoot || workspaceRoot || "",
    ...patch,
    updatedAt: Date.now(),
  };
  const changed =
    !flows[tabId] ||
    Object.keys(patch).some((k) => JSON.stringify(prev[k]) !== JSON.stringify(nextFlow[k]));
  if (!changed) return prev;
  setShared("mesh.flows", { ...flows, [tabId]: nextFlow });
  return nextFlow;
}

function stripPrUpdatedAt(prsMap) {
  const out = {};
  for (const k of Object.keys(asPlainObject(prsMap)).sort()) {
    const entry = prsMap[k];
    if (!entry || typeof entry !== "object") continue;
    const { updatedAt: _omit, ...rest } = entry;
    out[k] = rest;
  }
  return out;
}

function getActiveContext() {
  const allSpaces = spaces() || [];
  const activeSpace = allSpaces.find((s) => s.active) || allSpaces[0] || null;
  const spaceTabs = activeSpace?.tabs ?? [];
  const activeTab = spaceTabs.find((tb) => tb.active) || spaceTabs[0] || null;
  const f = focused();
  const allPanes = panes() || [];
  const tabIds = new Set(spaceTabs.map((tb) => tb.id));
  const spacePanes = allPanes.filter((p) => tabIds.has(p.tab));
  const activeTabPanes = activeTab ? spacePanes.filter((p) => p.tab === activeTab.id) : [];

  const pane =
    (f?.pane ? spacePanes.find((p) => p.pane === f.pane) : null) ||
    activeTabPanes.find((p) => p.focused && p.cwd) ||
    activeTabPanes.find((p) => p.cwd) ||
    spacePanes.find((p) => p.cwd) ||
    null;

  const on = pane?.machine || activeSpace?.machine || null;

  let workspaceRoot = "";
  if (activeSpace?.folder) {
    workspaceRoot = activeSpace.folder;
    if (pane?.cwd) {
      const normSpace = normPath(activeSpace.folder);
      const normPane = normPath(pane.cwd);
      if (normPane && normSpace && normPane !== normSpace && !normPane.startsWith(`${normSpace}/`)) {
        workspaceRoot = pane.cwd;
      }
    }
  } else {
    workspaceRoot = pane?.cwd || shared("mesh.services")?.workspaceRoot || "";
  }

  return {
    activeSpace,
    activeTab,
    activeTabPanes,
    pane,
    on,
    workspaceRoot,
  };
}

function findActiveAgent(activeTab, flow) {
  const allAgents = agents() || [];
  const allTerms = terminals() || [];
  const allPanes = panes() || [];
  const termMap = new Map(allTerms.map((t) => [t.address, t]));
  const agentMap = new Map(allAgents.map((a) => [a.address, a]));

  const isRunner = (addr) => termMap.get(addr)?.labels?.meshRunner === "true";

  // 1. Highest priority: tab-scoped leadTerminal
  if (flow?.leadTerminal && !isRunner(flow.leadTerminal)) {
    const ag = agentMap.get(flow.leadTerminal);
    if (ag) return ag;
    const tr = termMap.get(flow.leadTerminal);
    if (tr && tr.state !== "dead") {
      return {
        address: tr.address,
        pane: tr.pane || null,
        tab: tr.tab || activeTab?.id || null,
        title: tr.title || tr.name || tr.address,
        app: tr.program?.key || null,
        program: tr.program || null,
      };
    }
  }

  // 2. Currently focused agent
  const f = focused();
  if (f?.agent) {
    const ag = agentMap.get(f.agent);
    if (ag && !isRunner(ag.address)) return ag;
  }

  // 3. Non-runner agent pane inside activeTab
  if (activeTab?.id) {
    const tabAgentPanes = allPanes.filter(
      (p) => p.tab === activeTab.id && p.terminal && !isRunner(p.terminal),
    );
    for (const p of tabAgentPanes) {
      const ag = agentMap.get(p.terminal);
      if (ag) return ag;
    }
    const tabNonRunnerAgent = tabAgentPanes.find((p) => p.program?.agent);
    if (tabNonRunnerAgent) {
      return {
        address: tabNonRunnerAgent.terminal,
        pane: tabNonRunnerAgent.pane,
        tab: tabNonRunnerAgent.tab,
        title: tabNonRunnerAgent.title || tabNonRunnerAgent.program?.name || tabNonRunnerAgent.terminal,
        app: tabNonRunnerAgent.app || null,
        program: tabNonRunnerAgent.program || null,
      };
    }
  }

  // 4. Any non-runner agent in activeTab
  if (activeTab?.id) {
    const inTab = allAgents.find((a) => a.tab === activeTab.id && !isRunner(a.address));
    if (inTab) return inTab;
  }

  // 5. Global fallback
  return allAgents.find((a) => !isRunner(a.address)) || allAgents[0] || null;
}

function getParentDir(p) {
  const parts = String(p || "").split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const prefix = p.startsWith("/") ? "/" : "";
  return prefix + parts.slice(0, -1).join("/");
}

async function discoverRepos(workspaceRoot, on, isWindows = false) {
  if (!workspaceRoot) return [];
  const normWorkspace = normPath(workspaceRoot);

  const scanRoot = async (targetRoot, depth2 = true) => {
    if (!targetRoot) return [];
    if (!on && isWindows) {
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
      const r = await exec("powershell", ["-NoProfile", "-Command", psScript], { on, timeout: 6000 }).catch(() => null);
      if (r && r.code === 0 && r.stdout) {
        return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
      return [];
    }
    const script = depth2
      ? 'root="$1"; if [ -e "$root/.git" ]; then printf "%s\\n" "$root"; fi; for d in "$root"/* "$root"/*/*; do [ -e "$d/.git" ] || continue; case "$d" in */node_modules/*|*/target/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.venv/*) continue ;; esac; printf "%s\\n" "$d"; done'
      : 'root="$1"; for d in "$root"/*; do [ -e "$d/.git" ] || continue; case "$d" in */node_modules/*|*/target/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.venv/*) continue ;; esac; printf "%s\\n" "$d"; done';
    const r = await exec("sh", ["-c", script, "repos", targetRoot], { on, timeout: 6000 }).catch(() => null);
    if (r && r.code === 0 && r.stdout) {
      return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };

  let discovered = await scanRoot(workspaceRoot, true);
  let repoPaths = Array.from(new Set(discovered.map(normPath).filter(Boolean)));
  if (repoPaths.length === 0) {
    const top = await exec("git", [...READ_GIT_FLAGS, "rev-parse", "--show-toplevel"], {
      cwd: workspaceRoot,
      on,
      timeout: 4000,
    }).catch(() => null);
    if (top && top.code === 0 && top.stdout?.trim()) {
      repoPaths = [normPath(top.stdout.trim())];
    }
  }

  const isSingleRepoRoot =
    repoPaths.length === 1 &&
    (repoPaths[0] === normWorkspace || normWorkspace.startsWith(`${repoPaths[0]}/`));
  if (isSingleRepoRoot) {
    const parentDir = getParentDir(repoPaths[0]);
    if (parentDir) {
      const siblings = await scanRoot(parentDir, false);
      for (const s of siblings) {
        const normS = normPath(s);
        if (normS && !repoPaths.includes(normS)) repoPaths.push(normS);
      }
    }
  }

  return repoPaths.map((repoRoot) => {
    const isInsideWorkspace = repoRoot === normWorkspace || repoRoot.startsWith(`${normWorkspace}/`);
    let relPath = "";
    if (repoRoot !== normWorkspace && isInsideWorkspace) {
      relPath = repoRoot.slice(normWorkspace.length + 1);
    }
    const name = basename(repoRoot) || "root";
    const id = relPath || (repoRoot === normWorkspace ? "." : (isInsideWorkspace ? name : `../${name}`));
    return { id, name, relPath, root: repoRoot, isSibling: !isInsideWorkspace };
  });
}

async function isRepoTouched(root, on) {
  const st = await exec("git", [...READ_GIT_FLAGS, "status", "--porcelain=v1", "-z"], {
    cwd: root,
    on,
    timeout: 4000,
  }).catch(() => null);
  if (st && st.code === 0 && st.stdout) return true;
  const up = await exec("git", [...READ_GIT_FLAGS, "rev-list", "--count", "@{u}..HEAD"], {
    cwd: root,
    on,
    timeout: 4000,
  }).catch(() => null);
  if (up && up.code === 0 && parseInt((up.stdout || "").trim(), 10) > 0) return true;
  const branch = await readCurrentBranch(root, on);
  if (branch && !["main", "master", "development", "develop", "ci", "HEAD"].includes(branch)) {
    for (const base of ["development", "main", "master", "ci"]) {
      const ahead = await exec("git", [...READ_GIT_FLAGS, "rev-list", "--count", `${base}..HEAD`], {
        cwd: root,
        on,
        timeout: 4000,
      }).catch(() => null);
      if (ahead && ahead.code === 0 && parseInt((ahead.stdout || "").trim(), 10) > 0) return true;
    }
  }
  return false;
}

async function readCurrentBranch(root, on) {
  const res = await exec("git", [...READ_GIT_FLAGS, "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    on,
    timeout: 5000,
  }).catch(() => null);
  if (res && res.code === 0) {
    const out = (res.stdout || "").trim();
    if (out && out !== "HEAD") return out;
  }
  const fallback = await exec("git", [...READ_GIT_FLAGS, "branch", "--show-current"], {
    cwd: root,
    on,
    timeout: 5000,
  }).catch(() => null);
  if (fallback && fallback.code === 0 && fallback.stdout?.trim()) {
    return fallback.stdout.trim();
  }
  return "HEAD";
}

async function countDirtyFiles(root, on) {
  const res = await exec("git", [...READ_GIT_FLAGS, "status", "--porcelain=v1"], {
    cwd: root,
    on,
    timeout: 5000,
  }).catch(() => null);
  if (!res || res.code !== 0) return 0;
  return (res.stdout || "").split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

async function countCommitsAhead(root, headBranch, baseBranch, isFeaturePhase, on) {
  if (!headBranch || !baseBranch || headBranch === baseBranch) {
    return { commitsAhead: 0, rangeUsed: null };
  }
  const candidates = isFeaturePhase
    ? [`origin/${baseBranch}..${headBranch}`, `${baseBranch}..${headBranch}`]
    : [
        `origin/${baseBranch}..origin/${headBranch}`,
        `origin/${baseBranch}..${headBranch}`,
        `${baseBranch}..${headBranch}`,
      ];

  for (const range of candidates) {
    const res = await exec("git", [...READ_GIT_FLAGS, "rev-list", "--count", range], {
      cwd: root,
      on,
      timeout: 5000,
    }).catch(() => null);
    if (res && res.code === 0) {
      const n = Number.parseInt((res.stdout || "").trim(), 10);
      if (Number.isFinite(n)) {
        return { commitsAhead: Math.max(0, n), rangeUsed: range };
      }
    }
  }
  return { commitsAhead: 0, rangeUsed: null };
}

async function readCommitSummary(root, rangeUsed, headBranch, on) {
  const args = rangeUsed
    ? [...READ_GIT_FLAGS, "log", rangeUsed, "-n", "12", "--format=- %s (%h)"]
    : [...READ_GIT_FLAGS, "log", headBranch || "HEAD", "-n", "5", "--format=- %s (%h)"];
  const res = await exec("git", args, { cwd: root, on, timeout: 5000 }).catch(() => null);
  if (!res || res.code !== 0) return "";
  return (res.stdout || "").trim();
}

function summarizeStatusChecks(rollup) {
  const items = Array.isArray(rollup)
    ? rollup
    : Array.isArray(rollup?.contexts)
      ? rollup.contexts
      : [];

  if (items.length === 0) {
    return { checksStatus: "NONE", total: 0, passed: 0, failed: 0, pending: 0 };
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;

  const failConclusions = new Set([
    "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE",
  ]);
  const passConclusions = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const pendingStatuses = new Set([
    "IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED",
  ]);

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.conclusion !== undefined || item.status !== undefined) {
      const status = String(item.status || "").toUpperCase();
      const conclusion = String(item.conclusion || "").toUpperCase();
      if (failConclusions.has(conclusion)) {
        failed += 1;
      } else if (passConclusions.has(conclusion)) {
        passed += 1;
      } else if (pendingStatuses.has(status) || status !== "COMPLETED" || !conclusion) {
        pending += 1;
      } else {
        passed += 1;
      }
    } else if (item.state !== undefined) {
      const st = String(item.state || "").toUpperCase();
      if (st === "FAILURE" || st === "ERROR") failed += 1;
      else if (st === "PENDING" || st === "EXPECTED") pending += 1;
      else passed += 1;
    }
  }

  let checksStatus = "PASSING";
  if (failed > 0) checksStatus = "FAILING";
  else if (pending > 0) checksStatus = "PENDING";
  else if (passed === 0) checksStatus = "NONE";

  return { checksStatus, total: items.length, passed, failed, pending };
}

function extractFallbackComments(pr) {
  const items = [];
  const seen = new Set();

  if (Array.isArray(pr?.reviews)) {
    for (const rev of pr.reviews) {
      const body = String(rev?.body || "").trim();
      const state = String(rev?.state || "").toUpperCase();
      if (!body) continue;
      if (state !== "CHANGES_REQUESTED" && state !== "COMMENTED") continue;
      const author = rev?.author?.login || "reviewer";
      const key = `review:${author}:${body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: key,
        path: "review",
        line: null,
        author,
        body,
        isOutdated: false,
        source: "review",
      });
    }
  }

  if (Array.isArray(pr?.comments)) {
    for (const c of pr.comments) {
      const body = String(c?.body || "").trim();
      if (!body) continue;
      const author = c?.author?.login || "commenter";
      const key = `comment:${author}:${body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        id: key,
        path: "conversation",
        line: null,
        author,
        body,
        isOutdated: false,
        source: "comment",
      });
    }
  }

  return items;
}

async function fetchUnresolvedComments(root, pr, on) {
  const number = pr?.number;
  if (!number) return [];

  // 1. Prefer GraphQL reviewThreads so resolved threads are excluded accurately.
  const gqlRes = await exec(
    "gh",
    [
      "api", "graphql",
      "-F", "owner={owner}",
      "-F", "name={repo}",
      "-F", `number=${number}`,
      "-f", `query=${GRAPHQL_THREADS_QUERY}`,
    ],
    { cwd: root, on, timeout: GH_TIMEOUT_MS },
  ).catch(() => null);

  if (gqlRes && gqlRes.code === 0 && gqlRes.stdout?.trim()) {
    try {
      const parsed = JSON.parse(gqlRes.stdout);
      const nodes = parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes;
      if (Array.isArray(nodes)) {
        const threads = [];
        for (let idx = 0; idx < nodes.length; idx += 1) {
          const node = nodes[idx];
          if (!node || node.isResolved) continue;
          const comments = Array.isArray(node.comments?.nodes) ? node.comments.nodes : [];
          const first = comments[0];
          const latest = comments[comments.length - 1];
          const bodyParts = comments
            .map((c) => {
              const who = c?.author?.login || "reviewer";
              const txt = String(c?.body || "").trim();
              if (!txt) return "";
              return comments.length > 1 && c !== first ? `@${who}: ${txt}` : txt;
            })
            .filter(Boolean);
          const body = bodyParts.join("\n↳ ") || String(first?.body || latest?.body || "").trim();
          if (!body) continue;
          threads.push({
            id: `thread-${idx}-${node.path || "general"}-${node.line || 0}`,
            path: node.path || "general",
            line: node.line ?? null,
            author: first?.author?.login || latest?.author?.login || "reviewer",
            body,
            isOutdated: Boolean(node.isOutdated),
            source: "thread",
          });
        }
        // Also surface top-level CHANGES_REQUESTED review summaries if no inline threads exist.
        if (threads.length === 0 && String(pr?.reviewDecision || "").toUpperCase() === "CHANGES_REQUESTED") {
          return extractFallbackComments(pr);
        }
        return threads;
      }
    } catch {}
  }

  // 2. Fallback to REST pull request review comments endpoint.
  const restRes = await exec(
    "gh",
    ["api", `repos/{owner}/{repo}/pulls/${number}/comments`],
    { cwd: root, on, timeout: GH_TIMEOUT_MS },
  ).catch(() => null);

  if (restRes && restRes.code === 0 && restRes.stdout?.trim()) {
    try {
      const items = JSON.parse(restRes.stdout);
      if (Array.isArray(items) && items.length > 0) {
        return items
          .filter((c) => c && String(c.body || "").trim())
          .map((c, idx) => ({
            id: `rest-${c.id ?? idx}`,
            path: c.path || "general",
            line: c.line ?? c.original_line ?? c.position ?? null,
            author: c.user?.login || "reviewer",
            body: String(c.body || "").trim(),
            isOutdated: c.line == null && c.position == null,
            source: "rest",
          }));
      }
    } catch {}
  }

  // 3. Graceful final fallback to reviews & top-level PR comments from gh pr list.
  return extractFallbackComments(pr);
}

function classifyGhError(errMsg) {
  const msg = String(errMsg || "").trim();
  if (!msg) return { code: "unknown", summary: "GitHub CLI query failed" };
  const lower = msg.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not found") || lower.includes("cannot start")) {
    return { code: "missing_gh", summary: "GitHub CLI (`gh`) not installed or not in PATH" };
  }
  if (
    lower.includes("not logged into") ||
    lower.includes("gh auth login") ||
    lower.includes("authentication") ||
    lower.includes("401")
  ) {
    return { code: "auth", summary: "GitHub CLI not authenticated — run `gh auth login`" };
  }
  if (lower.includes("no git remotes") || lower.includes("none of the git remotes") || lower.includes("not a git repository")) {
    return { code: "no_remote", summary: "No GitHub remote configured" };
  }
  if (lower.includes("rate limit") || lower.includes("403")) {
    return { code: "rate_limit", summary: "GitHub API rate limit reached" };
  }
  const firstLine = msg.split(/\r?\n/).find((l) => l.trim()) || msg;
  return { code: "error", summary: firstLine.slice(0, 140) };
}

function interpolatePrTemplate(template, vars) {
  const source = typeof template === "string" && template.trim() ? template : DEFAULT_PR_TEMPLATE;
  const map = {
    ticket: vars.ticket || "N/A",
    title: vars.title || "Untitled Change",
    services: vars.services || "- No affected services listed",
    summary: vars.summary || "No commit summary available.",
    testSummary: vars.testSummary || "No automated test evidence recorded.",
  };
  return source.replace(/\{\{\s*(ticket|title|services|summary|testSummary)\s*\}\}/g, (_, key) => map[key]);
}

function readTabTestAlert(tabId, workspaceRoot) {
  const raw = shared("mesh.testAlert");
  if (!raw || typeof raw !== "object") return null;
  if (tabId && raw.tabId) {
    return raw.tabId === tabId ? raw : null;
  }
  if (workspaceRoot && raw.workspaceRoot) {
    return normPath(raw.workspaceRoot) === normPath(workspaceRoot) ? raw : null;
  }
  return raw;
}

function formatTestEvidence(alert, testPlan) {
  const lines = [];
  if (alert && typeof alert === "object") {
    const total = Number(alert.total) || 0;
    const passed = Number(alert.passed) || 0;
    const failed = Number(alert.failed) || 0;
    const running = Number(alert.running) || 0;
    const status = String(alert.status || "unknown").toUpperCase();
    lines.push(
      `- Status: **${status}** (${passed}/${total} passed, ${failed} failed${running > 0 ? `, ${running} running` : ""})`,
    );
    if (alert.summary) {
      lines.push(`- Summary: ${alert.summary}`);
    }
  }
  if (testPlan && Array.isArray(testPlan.cases) && testPlan.cases.length > 0) {
    if (lines.length === 0) {
      const total = testPlan.cases.length;
      const passed = testPlan.cases.filter((c) => c?.status === "passed").length;
      const failed = testPlan.cases.filter((c) => c?.status === "failed").length;
      lines.push(`- Test Plan (${testPlan.title || "Verification"}): ${passed}/${total} passed, ${failed} failed`);
    }
    for (const tc of testPlan.cases.slice(0, 8)) {
      if (!tc?.name) continue;
      const st = tc.status || "pending";
      const timing = tc.durationMs != null ? ` (${tc.durationMs}ms)` : "";
      const code = tc.httpCode != null ? ` [HTTP ${tc.httpCode}]` : "";
      lines.push(`  - [${st}] ${tc.kind ? `(${tc.kind}) ` : ""}${tc.name}${code}${timing}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No automated test run recorded yet.";
}

export default class MeshShip extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.configOpen = false;
    this.configDirty = false;
    this.selectedPhaseIdx = 0;
    this.activeService = "all";
    this.lastActiveServiceTs = 0;
    this.lastObservedShipPhaseKey = null;
    this.lastContextKey = null;

    this.workspaceRoot = "";
    this.on = null;
    this.tabId = null;
    this.services = [];
    this.serviceStates = [];
    this.cachedTestPlan = null;
    this.ghCache = new Map();
    this.expandedComments = new Set();
    this.repoOverrideInputs = new Map();

    this.refreshing = false;
    this.busyAction = null; // e.g. "promote-all", "ask-agent", "send-comments", "pr:<id>"
    this.globalGhError = null;
    this.statusMessage = null;

    const ctx = getActiveContext();
    const cfg = readPipelineConfig(ctx.workspaceRoot);
    this.loadedWorkspaceForInputs = normPath(ctx.workspaceRoot);

    this.chainInput = InputState.new({
      placeholder: "development, ci, main",
      value: cfg.chain.join(", "),
    });
    this.chainInput.set_value(cfg.chain.join(", "));
    this.chainInput.on("change", (_e, cx) => {
      this.configDirty = true;
      cx.notify();
    });
    this.chainInput.on("submit", (_e, cx) => this.saveConfig(cx));

    this.templateInput = TextareaState.new({
      placeholder: "Markdown PR template with {{ticket}}, {{title}}, {{services}}, {{summary}}, {{testSummary}}",
      value: cfg.prTemplate,
      rows: 7,
    });
    this.templateInput.set_soft_wrap(true);
    this.templateInput.set_auto_grow(6, 14);
    this.templateInput.set_value(cfg.prTemplate);
    this.templateInput.on("change", (_e, cx) => {
      this.configDirty = true;
      cx.notify();
    });

    const busServices = shared("mesh.services");
    if (Array.isArray(busServices?.services)) {
      this.ensureRepoOverrideInputs(busServices.services, cfg);
    }

    this.refresh(cx, { ensureTemplateMirrored: true });
  }

  close() {
    try { this.chainInput?.release(); } catch {}
    try { this.templateInput?.release(); } catch {}
    try { this.scroll?.release(); } catch {}
    for (const inp of this.repoOverrideInputs.values()) {
      try { inp?.release(); } catch {}
    }
    this.repoOverrideInputs.clear();
  }

  ensureRepoOverrideInputs(services, cfg) {
    for (const svc of services || []) {
      if (!svc?.id) continue;
      const existingVal = Array.isArray(cfg?.repoOverrides?.[svc.id])
        ? cfg.repoOverrides[svc.id].join(", ")
        : "";
      if (!this.repoOverrideInputs.has(svc.id)) {
        const inp = InputState.new({
          placeholder: `Inherit (${(cfg?.chain || DEFAULT_CHAIN).join(" → ")})`,
          value: existingVal,
        });
        inp.set_value(existingVal);
        inp.on("change", () => {
          this.configDirty = true;
        });
        inp.on("submit", (_e, cx) => this.saveConfig(cx));
        this.repoOverrideInputs.set(svc.id, inp);
      } else if (!this.configDirty) {
        const inp = this.repoOverrideInputs.get(svc.id);
        if (inp.value() !== existingVal) {
          inp.set_value(existingVal);
        }
      }
    }
  }

  syncConfigInputs(workspaceRoot, services) {
    const cfg = readPipelineConfig(workspaceRoot);
    const normWs = normPath(workspaceRoot);
    if (!this.configDirty || this.loadedWorkspaceForInputs !== normWs) {
      this.loadedWorkspaceForInputs = normWs;
      this.configDirty = false;
      const chainStr = cfg.chain.join(", ");
      if (this.chainInput.value() !== chainStr) {
        this.chainInput.set_value(chainStr);
      }
      if (this.templateInput.value() !== cfg.prTemplate) {
        this.templateInput.set_value(cfg.prTemplate);
      }
    }
    this.ensureRepoOverrideInputs(services, cfg);
  }

  toggleConfigDrawer(cx) {
    this.configOpen = !this.configOpen;
    if (this.configOpen) {
      const ctx = getActiveContext();
      this.syncConfigInputs(ctx.workspaceRoot, this.services);
    }
    cx.notify();
  }

  saveConfig(cx) {
    const ctx = getActiveContext();
    const workspaceRoot = ctx.workspaceRoot || this.workspaceRoot;
    const rawChain = this.chainInput.value();
    const parsedChain = parseChainInput(rawChain);
    if (parsedChain.length === 0) {
      notify({
        title: "Invalid promotion chain",
        body: "Enter at least one branch name (for example: development, ci, main).",
        level: "warning",
      });
      return;
    }

    const rawTemplate = String(this.templateInput.value() || "").replace(/\r\n/g, "\n").trim();
    const nextTemplate = rawTemplate || DEFAULT_PR_TEMPLATE;

    const repoOverrides = {};
    for (const svc of this.services) {
      const inp = this.repoOverrideInputs.get(svc.id);
      if (!inp) continue;
      const parsedOverride = parseChainInput(inp.value());
      if (parsedOverride.length > 0) {
        repoOverrides[svc.id] = parsedOverride;
      }
    }

    saveWorkspacePipelineConfig(workspaceRoot, {
      chain: parsedChain,
      repoOverrides,
      prTemplate: nextTemplate,
    });

    this.configDirty = false;
    this.chainInput.set_value(parsedChain.join(", "));
    this.templateInput.set_value(nextTemplate);

    const maxPhase = Math.max(0, computePhases(parsedChain).length - 1);
    if (this.selectedPhaseIdx > maxPhase) {
      this.selectedPhaseIdx = maxPhase;
    }

    cx.spawn(async (cx) => {
      try {
        await mirrorPrTemplateToDisk(nextTemplate);
        notify({
          title: "Pipeline config saved",
          body: `Chain: ${parsedChain.join(" → ")} · Template mirrored to pr-template.md`,
          level: "success",
        });
      } catch (err) {
        notify({
          title: "Saved in shared state, file mirror failed",
          body: String(err?.message || err),
          level: "warning",
        });
      }
      this.refresh(cx, { force: true });
    });
    cx.notify();
  }

  resetConfig(cx) {
    const ctx = getActiveContext();
    const workspaceRoot = ctx.workspaceRoot || this.workspaceRoot;

    this.chainInput.set_value(DEFAULT_CHAIN.join(", "));
    this.templateInput.set_value(DEFAULT_PR_TEMPLATE);
    for (const inp of this.repoOverrideInputs.values()) {
      inp.set_value("");
    }
    this.configDirty = false;

    saveWorkspacePipelineConfig(workspaceRoot, {
      chain: [...DEFAULT_CHAIN],
      repoOverrides: {},
      prTemplate: DEFAULT_PR_TEMPLATE,
    });

    const maxPhase = Math.max(0, computePhases(DEFAULT_CHAIN).length - 1);
    if (this.selectedPhaseIdx > maxPhase) {
      this.selectedPhaseIdx = maxPhase;
    }

    cx.spawn(async (cx) => {
      await mirrorPrTemplateToDisk(DEFAULT_PR_TEMPLATE).catch(() => {});
      notify({
        title: "Reset to defaults",
        body: `Promotion chain restored to ${DEFAULT_CHAIN.join(" → ")} and default PR template.`,
        level: "info",
      });
      this.refresh(cx, { force: true });
    });
    cx.notify();
  }

  selectPhase(idx, cx) {
    const ctx = getActiveContext();
    const cfg = readPipelineConfig(ctx.workspaceRoot || this.workspaceRoot);
    const phases = computePhases(cfg.chain);
    const clamped = Math.max(0, Math.min(idx, phases.length - 1));
    if (this.selectedPhaseIdx === clamped) return;

    this.selectedPhaseIdx = clamped;
    if (ctx.activeTab?.id) {
      const nextStage = clamped === 0 ? "pr_dev" : "promote";
      const nextShipPhase = clamped === 0 ? "dev" : "promote";
      this.lastObservedShipPhaseKey = `${ctx.activeTab.id}::${nextShipPhase}`;
      updateTabFlow(
        ctx.activeTab.id,
        { stage: nextStage, shipPhase: nextShipPhase },
        ctx.workspaceRoot,
      );
    }
    this.refresh(cx);
    cx.notify();
  }

  selectServiceFilter(serviceId, cx) {
    if (this.activeService === serviceId) return;
    this.activeService = serviceId;
    const now = Date.now();
    this.lastActiveServiceTs = now;
    if (this.workspaceRoot) {
      setShared("mesh.activeService", {
        workspaceRoot: this.workspaceRoot,
        serviceId,
        ts: now,
      });
    }
    cx.notify();
  }

  toggleExpandComments(key, cx) {
    if (this.expandedComments.has(key)) {
      this.expandedComments.delete(key);
    } else {
      this.expandedComments.add(key);
    }
    cx.notify();
  }

  renderPrTemplate(service, phaseMeta = null) {
    const ctx = getActiveContext();
    const workspaceRoot = ctx.workspaceRoot || this.workspaceRoot;
    const activeTab = ctx.activeTab;
    const tabId = activeTab?.id || this.tabId;
    const flows = readFlows();
    const flow = tabId ? asPlainObject(flows[tabId]) : {};
    const cfg = readPipelineConfig(workspaceRoot);
    const phases = computePhases(cfg.chain);
    const phase = phaseMeta || phases[this.selectedPhaseIdx] || phases[0];

    const matchedState = service
      ? this.serviceStates.find((s) => s.id === service.id || s.root === service.root) || service
      : null;

    const ticket =
      flow.ticket ||
      extractTicket(activeTab?.name, matchedState?.currentBranch, matchedState?.headBranch) ||
      "N/A";

    const rawTitle = flow.derivedTitle || activeTab?.name || "";
    const title = rawTitle && !/^tb\d+$|^\d+$/.test(rawTitle)
      ? rawTitle
      : matchedState?.headBranch
        ? `${matchedState.headBranch} → ${matchedState.baseBranch || phase.baseBranch}`
        : `Promote ${phase.label}`;

    // Build affected services list consistently so every microservice PR carries full cross-service context.
    const relevantStates = this.serviceStates.filter(
      (s) => s.commitsAhead > 0 || s.dirtyCount > 0 || Boolean(s.pr),
    );
    const listPool = relevantStates.length > 0
      ? relevantStates
      : this.serviceStates.length > 0
        ? this.serviceStates
        : matchedState
          ? [matchedState]
          : [];

    const servicesText = listPool
      .map((s) => {
        const head = s.headBranch || s.currentBranch || phase.headBranch || "feature";
        const base = s.baseBranch || phase.baseBranch || cfg.chain[0];
        const pathLabel = s.relPath || ".";
        const prTag = s.pr?.number ? ` (PR #${s.pr.number})` : "";
        return `- \`${s.name}\` (${pathLabel}) — \`${head}\` → \`${base}\`${prTag}`;
      })
      .join("\n") || "- Workspace repository";

    let summaryText = matchedState?.commitSummary || "";
    if (!summaryText) {
      const multiSummaries = listPool
        .filter((s) => s.commitSummary)
        .map((s) => `**${s.name}**\n${s.commitSummary}`);
      if (multiSummaries.length > 0) {
        summaryText = multiSummaries.join("\n\n");
      } else {
        const head = matchedState?.headBranch || phase.headBranch || "feature branch";
        const base = matchedState?.baseBranch || phase.baseBranch || cfg.chain[0];
        summaryText = `- ${title} (\`${head}\` → \`${base}\`)`;
      }
    }

    const alert = readTabTestAlert(tabId, workspaceRoot);
    const testSummary = formatTestEvidence(alert, this.cachedTestPlan);

    return interpolatePrTemplate(cfg.prTemplate, {
      ticket,
      title,
      services: servicesText,
      summary: summaryText,
      testSummary,
    });
  }

  refresh(cx, opts = {}) {
    if (this.refreshing && !opts.force) return;
    const ctx = getActiveContext();
    const workspaceRoot = ctx.workspaceRoot;
    const on = ctx.on;
    const tabId = ctx.activeTab?.id || null;
    const cfg = readPipelineConfig(workspaceRoot);
    const phases = computePhases(cfg.chain);
    const phaseIdx = Math.max(0, Math.min(this.selectedPhaseIdx, phases.length - 1));
    this.selectedPhaseIdx = phaseIdx;

    const nextContextKey = JSON.stringify({
      workspaceRoot,
      on,
      tabId,
      phaseIdx,
      chain: cfg.chain,
      overrides: cfg.repoOverrides,
    });
    this.lastContextKey = nextContextKey;
    this.workspaceRoot = workspaceRoot;
    this.on = on;
    this.tabId = tabId;

    if (!workspaceRoot) {
      this.services = [];
      this.serviceStates = [];
      this.globalGhError = null;
      return;
    }

    const force = Boolean(opts.force);
    const isWindows = !on && window()?.platform === "windows";
    const allPanesList = panes() || [];
    const tabPaneCwds = tabId
      ? Array.from(new Set(allPanesList.filter((p) => p.tab === tabId && p.cwd).map((p) => p.cwd)))
      : [];
    const tabFlowSnap = tabId ? asPlainObject(readFlows()[tabId]) : {};
    const tabTermAddrs = tabId
      ? Array.from(
          new Set([
            ...(tabFlowSnap.leadTerminal ? [tabFlowSnap.leadTerminal] : []),
            ...allPanesList.filter((p) => p.tab === tabId && p.terminal && p.labels?.meshRunner !== "true").map((p) => p.terminal),
            ...(agents() || []).filter((a) => a.tab === tabId).map((a) => a.address),
          ])
        )
      : [];
    this.refreshing = true;

    cx.spawn(async (cx) => {
      try {
        // Mirror default template on first load or adopt user's existing pr-template.md if no workspace template saved yet.
        if (opts.ensureTemplateMirrored || !cfg.hasWorkspaceEntry) {
          const tplPath = getPrTemplateFilePath();
          const diskTpl = await readTextFile(tplPath).catch(() => null);
          if (diskTpl && diskTpl.trim() && !cfg.hasWorkspaceEntry) {
            if (!this.configDirty) {
              this.templateInput.set_value(diskTpl);
            }
          } else if (diskTpl === null) {
            await mirrorPrTemplateToDisk(cfg.prTemplate).catch(() => {});
          }
        }

        // Load cached test plan evidence if mesh-test recorded a path for this tab.
        const currentFlows = readFlows();
        const tabFlow = tabId ? asPlainObject(currentFlows[tabId]) : {};
        if (tabFlow.testPlanPath) {
          const rawPlan = await readTextFile(tabFlow.testPlanPath, { on }).catch(() => null);
          if (rawPlan) {
            try {
              this.cachedTestPlan = JSON.parse(rawPlan);
            } catch {
              this.cachedTestPlan = null;
            }
          } else {
            this.cachedTestPlan = null;
          }
        } else {
          this.cachedTestPlan = null;
        }

        const busServices = shared("mesh.services");
        const busMatches =
          busServices &&
          Array.isArray(busServices.services) &&
          (!busServices.tabId || !tabId || busServices.tabId === tabId) &&
          normPath(busServices.workspaceRoot) === normPath(workspaceRoot);

        let services = busMatches ? busServices.services : null;
        if (!services) {
          const candidates = await discoverRepos(workspaceRoot, on, isWindows);
          const tabPrs = asPlainObject(tabFlow.prs);
          const sessionSet = new Set(
            Array.isArray(tabFlow.sessionRepos) ? tabFlow.sessionRepos.map((r) => normPath(r)) : []
          );
          const reads = tabId
            ? await Promise.all(tabTermAddrs.map((addr) => hc(["read", "--lines", "400", addr]).catch(() => "")))
            : [];
          const transcript = reads.filter(Boolean).join("\n").replace(/\\/g, "/");
          const normCwds = tabPaneCwds.map((c) => normPath(c)).filter(Boolean);
          const checks = await Promise.all(
            candidates.map(async (svc) => {
              if (!(Boolean(tabPrs[svc.id]) || (await isRepoTouched(svc.root, on)))) return null;
              if (!tabId) return svc;
              const nr = normPath(svc.root);
              const inSession =
                Boolean(tabPrs[svc.id]) ||
                sessionSet.has(nr) ||
                normCwds.some((c) => c === nr || c.startsWith(`${nr}/`)) ||
                (transcript && (transcript.includes(nr) || (svc.name && svc.name.length >= 3 && transcript.includes(`${svc.name}/`))));
              return inSession ? svc : null;
            })
          );
          services = checks.filter(Boolean);
        }
        if (!Array.isArray(services)) services = [];

        this.services = services;
        this.syncConfigInputs(workspaceRoot, services);

        if (this.activeService !== "all" && !services.some((s) => s.id === this.activeService)) {
          this.activeService = "all";
        }

        const now = Date.now();
        const prevPrs = asPlainObject(tabFlow.prs);
        const nextPrs = {};
        let missingGhCount = 0;
        let authErrMsg = null;

        const results = await Promise.all(
          services.map(async (svc) => {
            const svcChain = cfg.repoOverrides[svc.id] || cfg.chain;
            const [currentBranch, dirtyCount] = await Promise.all([
              readCurrentBranch(svc.root, on),
              countDirtyFiles(svc.root, on),
            ]);

            const branchInfo = resolveServiceBranches(svcChain, phaseIdx, currentBranch);
            const headBranch = branchInfo.headBranch;
            const baseBranch = branchInfo.baseBranch;
            const sameBranch = Boolean(headBranch && baseBranch && headBranch === baseBranch);

            let commitsAhead = 0;
            let rangeUsed = null;
            let commitSummary = "";

            if (branchInfo.phaseAvailable && !sameBranch && headBranch && baseBranch) {
              const ahead = await countCommitsAhead(
                svc.root,
                headBranch,
                baseBranch,
                branchInfo.isFeaturePhase,
                on,
              );
              commitsAhead = ahead.commitsAhead;
              rangeUsed = ahead.rangeUsed;
              commitSummary = await readCommitSummary(svc.root, rangeUsed, headBranch, on);
            }

            let pr = null;
            let ghError = null;
            let ghChecked = false;

            if (branchInfo.phaseAvailable && !sameBranch && headBranch && baseBranch) {
              const cacheKey = `${svc.root}::${headBranch}::${baseBranch}`;
              const cached = this.ghCache.get(cacheKey);
              if (!force && cached && now - cached.ts < PASSIVE_CACHE_TTL_MS) {
                pr = cached.pr;
                ghError = cached.ghError;
                ghChecked = true;
              } else {
                ghChecked = true;
                const ghRes = await exec(
                  "gh",
                  [
                    "pr", "list",
                    "--state", "all",
                    "--head", headBranch,
                    "--base", baseBranch,
                    "--json", "number,title,state,url,headRefName,baseRefName,reviewDecision,statusCheckRollup,comments,reviews",
                    "--limit", "5",
                  ],
                  { cwd: svc.root, on, timeout: GH_TIMEOUT_MS },
                ).catch((err) => ({ code: -1, stdout: "", stderr: String(err?.message || err) }));

                if (!ghRes || ghRes.code !== 0) {
                  const errInfo = classifyGhError(ghRes?.stderr || ghRes?.stdout || "gh command failed");
                  ghError = errInfo;
                  if (errInfo.code === "missing_gh") missingGhCount += 1;
                  if (errInfo.code === "auth" && !authErrMsg) authErrMsg = errInfo.summary;
                } else {
                  try {
                    const list = JSON.parse(ghRes.stdout || "[]");
                    if (Array.isArray(list) && list.length > 0) {
                      const sorted = [...list].sort((a, b) => {
                        const aOpen = String(a?.state || "").toUpperCase() === "OPEN" ? 0 : 1;
                        const bOpen = String(b?.state || "").toUpperCase() === "OPEN" ? 0 : 1;
                        if (aOpen !== bOpen) return aOpen - bOpen;
                        return (Number(b?.number) || 0) - (Number(a?.number) || 0);
                      });
                      const picked = sorted[0];
                      const stateUpper = String(picked.state || "OPEN").toUpperCase();
                      const checkStats = summarizeStatusChecks(picked.statusCheckRollup);
                      const threads =
                        stateUpper === "OPEN"
                          ? await fetchUnresolvedComments(svc.root, picked, on)
                          : [];

                      pr = {
                        number: picked.number,
                        title: picked.title || "",
                        state: stateUpper,
                        url: picked.url || "",
                        headRefName: picked.headRefName || headBranch,
                        baseRefName: picked.baseRefName || baseBranch,
                        reviewDecision: picked.reviewDecision || null,
                        checksStatus: checkStats.checksStatus,
                        checkStats,
                        threads,
                        unresolvedCount: threads.length,
                      };
                    }
                  } catch (parseErr) {
                    ghError = { code: "parse", summary: `Invalid gh JSON output: ${parseErr.message || parseErr}` };
                  }
                }
                this.ghCache.set(cacheKey, { ts: Date.now(), pr, ghError });
              }
            }

            if (pr) {
              nextPrs[svc.id] = {
                number: pr.number,
                url: pr.url,
                state: pr.state,
                head: pr.headRefName,
                base: pr.baseRefName,
                checksStatus: pr.checksStatus,
                reviewDecision: pr.reviewDecision,
                unresolvedCount: pr.unresolvedCount,
                updatedAt: Date.now(),
              };
            } else if (ghError && prevPrs[svc.id]) {
              // Keep prior telemetry if gh transiently errored.
              nextPrs[svc.id] = prevPrs[svc.id];
            }

            return {
              ...svc,
              svcChain,
              currentBranch,
              dirtyCount,
              phaseAvailable: branchInfo.phaseAvailable,
              isFeaturePhase: branchInfo.isFeaturePhase,
              headBranch,
              baseBranch,
              sameBranch,
              commitsAhead,
              commitSummary,
              ghChecked,
              ghError,
              pr,
            };
          }),
        );

        // Guard against stale async completion if user switched workspace or phase while gh ran.
        if (this.lastContextKey !== nextContextKey) return;

        this.serviceStates = results;
        if (services.length > 0 && missingGhCount === services.length) {
          this.globalGhError = "GitHub CLI (`gh`) was not found in PATH.";
        } else if (authErrMsg) {
          this.globalGhError = authErrMsg;
        } else {
          this.globalGhError = null;
        }

        // Publish normalized PR summaries to mesh.flows[tabId].prs only when changed.
        if (tabId) {
          const latestFlows = readFlows();
          const latestTabFlow = asPlainObject(latestFlows[tabId]);
          const prevStr = JSON.stringify(stripPrUpdatedAt(latestTabFlow.prs));
          const nextStr = JSON.stringify(stripPrUpdatedAt(nextPrs));
          if (prevStr !== nextStr) {
            updateTabFlow(tabId, { prs: nextPrs }, workspaceRoot);
          }
        }
      } catch (err) {
        this.statusMessage = { level: "error", text: String(err?.message || err) };
      } finally {
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  getVisibleServices() {
    if (this.activeService === "all") return this.serviceStates;
    return this.serviceStates.filter((s) => s.id === this.activeService);
  }

  async executeCreatePr(svcState, phaseMeta) {
    if (!svcState?.phaseAvailable || !svcState.headBranch || !svcState.baseBranch) {
      return { ok: false, error: `${svcState?.name || "Service"} is outside the configured override chain.` };
    }
    if (svcState.sameBranch) {
      return { ok: false, error: `${svcState.name}: head and base are both '${svcState.baseBranch}'.` };
    }
    if (svcState.isFeaturePhase && svcState.dirtyCount > 0 && svcState.commitsAhead === 0) {
      return {
        ok: false,
        error: `${svcState.name} has ${svcState.dirtyCount} uncommitted changes and 0 commits ahead of ${svcState.baseBranch}.`,
      };
    }

    const on = this.on;
    const root = svcState.root;
    const headBranch = svcState.headBranch;
    const baseBranch = svcState.baseBranch;

    // Ensure head branch is pushed to origin.
    let shouldPush = svcState.isFeaturePhase;
    if (!shouldPush) {
      const remoteRef = await exec(
        "git",
        [...READ_GIT_FLAGS, "rev-parse", "--verify", `origin/${headBranch}`],
        { cwd: root, on, timeout: 5000 },
      ).catch(() => null);
      shouldPush = !remoteRef || remoteRef.code !== 0;
    }

    if (shouldPush) {
      const pushRes = await exec("git", ["push", "-u", "origin", headBranch], {
        cwd: root,
        on,
        timeout: 30000,
      }).catch((err) => ({ code: -1, stderr: String(err?.message || err), stdout: "" }));
      if (!pushRes || pushRes.code !== 0) {
        return {
          ok: false,
          error: `${svcState.name} git push failed: ${(pushRes?.stderr || pushRes?.stdout || "").trim()}`,
        };
      }
    }

    const ctx = getActiveContext();
    const flows = readFlows();
    const flow = ctx.activeTab?.id ? asPlainObject(flows[ctx.activeTab.id]) : {};
    const ticket = flow.ticket || extractTicket(ctx.activeTab?.name, headBranch) || "";
    const rawTitle = (flow.derivedTitle || ctx.activeTab?.name || "").trim();
    const cleanTitle = rawTitle && !/^tb\d+$|^\d+$/.test(rawTitle) ? rawTitle : headBranch;

    let prTitle;
    if (svcState.isFeaturePhase) {
      if (ticket && !cleanTitle.toUpperCase().includes(ticket.toUpperCase())) {
        prTitle = `${ticket} ${cleanTitle}`;
      } else {
        prTitle = cleanTitle;
      }
    } else {
      prTitle = ticket
        ? `Promote ${headBranch} → ${baseBranch} (${ticket})`
        : `Promote ${headBranch} → ${baseBranch}`;
    }

    const prBody = this.renderPrTemplate(svcState, phaseMeta);

    const createRes = await exec(
      "gh",
      [
        "pr", "create",
        "--base", baseBranch,
        "--head", headBranch,
        "--title", prTitle,
        "--body", prBody,
      ],
      { cwd: root, on, timeout: 20000 },
    ).catch((err) => ({ code: -1, stderr: String(err?.message || err), stdout: "" }));

    if (!createRes || createRes.code !== 0) {
      return {
        ok: false,
        error: `${svcState.name} gh pr create failed: ${(createRes?.stderr || createRes?.stdout || "").trim()}`,
      };
    }

    this.ghCache.delete(`${svcState.root}::${headBranch}::${baseBranch}`);
    return { ok: true, url: (createRes.stdout || "").trim() };
  }

  createPrForService(svcState, cx) {
    if (this.busyAction || !svcState) return;
    const cfg = readPipelineConfig(this.workspaceRoot);
    const phases = computePhases(cfg.chain);
    const phaseMeta = phases[this.selectedPhaseIdx] || phases[0];

    this.busyAction = `pr:${svcState.id}`;
    this.statusMessage = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await this.executeCreatePr(svcState, phaseMeta);
        if (res.ok) {
          notify({
            title: `PR created for ${svcState.name}`,
            body: res.url || `${svcState.headBranch} → ${svcState.baseBranch}`,
            level: "success",
          });
          this.refresh(cx, { force: true });
        } else {
          notify({
            title: `Failed to create PR for ${svcState.name}`,
            body: res.error,
            level: "error",
          });
        }
      } finally {
        this.busyAction = null;
        cx.notify();
      }
    });
  }

  promoteAll(cx) {
    if (this.busyAction) return;
    const cfg = readPipelineConfig(this.workspaceRoot);
    const phases = computePhases(cfg.chain);
    const phaseMeta = phases[this.selectedPhaseIdx] || phases[0];

    const targets = this.getVisibleServices().filter(
      (s) =>
        s.phaseAvailable &&
        !s.sameBranch &&
        (!s.pr || s.pr.state !== "OPEN") &&
        (s.isFeaturePhase ? s.commitsAhead > 0 : true),
    );

    if (targets.length === 0) {
      if (this.selectedPhaseIdx + 1 < phases.length) {
        this.selectPhase(this.selectedPhaseIdx + 1, cx);
        notify({
          title: `Switched to ${phases[this.selectedPhaseIdx].label}`,
          body: "Showing promotion PR status for the next pipeline stage.",
          level: "info",
        });
      } else {
        notify({
          title: "Nothing to promote",
          body: "All eligible services already have open PRs or have no commits ahead.",
          level: "info",
        });
      }
      return;
    }

    this.busyAction = "promote-all";
    this.statusMessage = null;
    cx.notify();

    cx.spawn(async (cx) => {
      const created = [];
      const failed = [];
      try {
        for (const svc of targets) {
          const res = await this.executeCreatePr(svc, phaseMeta);
          if (res.ok) created.push(svc.name);
          else failed.push(res.error);
        }

        if (created.length > 0 && failed.length === 0) {
          notify({
            title: `Created ${created.length} PR${created.length === 1 ? "" : "s"}`,
            body: `${created.join(", ")} → ${phaseMeta.baseBranch}`,
            level: "success",
          });
        } else if (created.length > 0 && failed.length > 0) {
          notify({
            title: `Created ${created.length} PR(s), ${failed.length} failed`,
            body: failed.join("\n"),
            level: "warning",
          });
        } else {
          notify({
            title: "Batch PR creation failed",
            body: failed.join("\n"),
            level: "error",
          });
        }
        this.refresh(cx, { force: true });
      } finally {
        this.busyAction = null;
        cx.notify();
      }
    });
  }

  askAgentToCreatePrs(cx) {
    if (this.busyAction) return;
    const ctx = getActiveContext();
    const flows = readFlows();
    const flow = ctx.activeTab?.id ? asPlainObject(flows[ctx.activeTab.id]) : {};
    const agent = findActiveAgent(ctx.activeTab, flow);

    if (!agent) {
      notify({
        title: "No active agent found",
        body: "Start or focus an agent terminal in the active tab to dispatch PR creation.",
        level: "warning",
      });
      return;
    }

    const cfg = readPipelineConfig(ctx.workspaceRoot || this.workspaceRoot);
    const phases = computePhases(cfg.chain);
    const phaseMeta = phases[this.selectedPhaseIdx] || phases[0];

    const visible = this.getVisibleServices();
    const pending = visible.filter(
      (s) => s.phaseAvailable && !s.sameBranch && (!s.pr || s.pr.state !== "OPEN"),
    );
    const targetList = pending.length > 0 ? pending : visible;

    if (targetList.length === 0) {
      notify({
        title: "No target repositories found",
        body: "Discover or select at least one microservice repository first.",
        level: "warning",
      });
      return;
    }

    this.busyAction = "ask-agent";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const serviceLines = targetList.map((s) => {
          const head = s.headBranch || s.currentBranch || phaseMeta.headBranch || "HEAD";
          const base = s.baseBranch || phaseMeta.baseBranch || cfg.chain[0];
          const dirtyNote = s.dirtyCount > 0 ? `, ${s.dirtyCount} uncommitted files` : "";
          return `- **${s.name}** (\`${s.root}\`): push \`${head}\` and open PR targeting \`${base}\` (${s.commitsAhead} commits ahead${dirtyNote})`;
        });

        const exampleBody = this.renderPrTemplate(targetList[0], phaseMeta);

        const prompt = [
          `Create GitHub Pull Requests for stage **${phaseMeta.label}** across the affected microservices:`,
          "",
          ...serviceLines,
          "",
          "Instructions:",
          "1. For each repository with uncommitted changes intended for this feature, review and commit cleanly first.",
          "2. Push each head branch (`git push -u origin <headBranch>`) and create the PR with `gh pr create --base <baseBranch> --head <headBranch> --title \"<title>\" --body \"<body>\"`.",
          "3. **Strictly follow this exact PR Template structure** for every PR body (do not omit any section):",
          "",
          "```markdown",
          cfg.prTemplate,
          "```",
          "",
          "Pre-rendered reference body (adapt commit summary per service if needed):",
          "",
          "```markdown",
          exampleBody,
          "```",
        ].join("\n");

        const res = await hc(["send", agent.address, prompt]).catch((err) => ({
          code: 1,
          stderr: String(err?.message || err),
          stdout: "",
        }));

        if (!res || res.code !== 0) {
          notify({
            title: "Failed to dispatch PR prompt to agent",
            body: (res?.stderr || res?.stdout || "hc send failed").trim(),
            level: "error",
          });
        } else {
          notify({
            title: "PR creation dispatched to agent",
            body: `Sent instructions & PR template to ${agent.title || agent.app || agent.address}.`,
            level: "success",
          });
        }
      } finally {
        this.busyAction = null;
        cx.notify();
      }
    });
  }

  sendReviewCommentsToAgent(targetServices, cx) {
    if (this.busyAction) return;
    const ctx = getActiveContext();
    const flows = readFlows();
    const flow = ctx.activeTab?.id ? asPlainObject(flows[ctx.activeTab.id]) : {};
    const agent = findActiveAgent(ctx.activeTab, flow);

    if (!agent) {
      notify({
        title: "No active agent found",
        body: "Start or focus an agent terminal in the active tab to send PR review comments.",
        level: "warning",
      });
      return;
    }

    const withComments = (targetServices || []).filter(
      (s) => s.pr && Array.isArray(s.pr.threads) && s.pr.threads.length > 0,
    );

    if (withComments.length === 0) {
      notify({
        title: "No unresolved review comments",
        body: "There are no unresolved PR review threads to send.",
        level: "info",
      });
      return;
    }

    this.busyAction = "send-comments";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const blocks = [
          "Please address the following unresolved GitHub PR review comments and push updates to the corresponding branches:",
          "",
        ];

        for (const svc of withComments) {
          blocks.push(`### Service: ${svc.name} (PR #${svc.pr.number})`);
          if (svc.pr.url) blocks.push(`PR: ${svc.pr.url} · Branch: \`${svc.pr.headRefName}\` → \`${svc.pr.baseRefName}\``);
          for (const th of svc.pr.threads) {
            const loc = th.line ? `${th.path}:${th.line}` : th.path;
            const singleLineBody = String(th.body || "").replace(/\r?\n/g, "\n  ");
            blocks.push(`- ${loc} (@${th.author}): ${singleLineBody}`);
          }
          blocks.push("");
        }

        const msg = blocks.join("\n");
        const res = await hc(["send", agent.address, msg]).catch((err) => ({
          code: 1,
          stderr: String(err?.message || err),
          stdout: "",
        }));

        if (!res || res.code !== 0) {
          notify({
            title: "Failed to send review comments",
            body: (res?.stderr || res?.stdout || "hc send failed").trim(),
            level: "error",
          });
        } else {
          const totalCount = withComments.reduce((n, s) => n + s.pr.threads.length, 0);
          notify({
            title: "Review comments sent to agent",
            body: `Dispatched ${totalCount} unresolved comment${totalCount === 1 ? "" : "s"} to ${agent.title || agent.app || agent.address}.`,
            level: "success",
          });
        }
      } finally {
        this.busyAction = null;
        cx.notify();
      }
    });
  }

  openPrUrl(svcState, cx) {
    const pr = svcState?.pr;
    if (!pr) return;
    if (pr.url && /^https?:\/\//i.test(pr.url)) {
      try {
        cx.open_url(pr.url);
        return;
      } catch {}
    }

    const on = this.on;
    const isLinux = !on && window()?.platform === "linux";
    cx.spawn(async () => {
      if (pr.url && isLinux) {
        const r = await exec("xdg-open", [pr.url], { timeout: 5000 }).catch(() => null);
        if (r && r.code === 0) return;
      }
      if (pr.number && svcState.root) {
        const r = await exec("gh", ["pr", "view", String(pr.number), "--web"], {
          cwd: svcState.root,
          on,
          timeout: 10000,
        }).catch(() => null);
        if (!r || r.code !== 0) {
          notify({
            title: "Could not open PR in browser",
            body: pr.url || `PR #${pr.number}`,
            level: "warning",
          });
        }
      }
    });
  }

  renderBadge(label, color, t) {
    return div()
      .px(6)
      .py(1.5)
      .rounded(4)
      .flex_none()
      .border_1()
      .border_color(withAlpha(color, "44", t.border))
      .bg(withAlpha(color, "1c", t.raised))
      .text_size(10)
      .font_medium()
      .text_color(color)
      .child(label);
  }

  renderActionButton(id, label, opts, onClick) {
    const { t, icon, primary = false, disabled = false, tooltip = null, accentColor = null } = opts;
    const fg = primary ? t.solid_foreground : (accentColor || (disabled ? t.dim : t.foreground));
    const bg = primary ? t.solid : (accentColor ? withAlpha(accentColor, "1a", t.raised) : t.raised);
    const borderCol = primary
      ? t.solid
      : (accentColor ? withAlpha(accentColor, "48", t.border) : t.border);

    return h_flex()
      .id(id)
      .h(26)
      .px(9)
      .gap(5)
      .flex_none()
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(disabled ? t.border : borderCol)
      .bg(disabled ? t.raised : bg)
      .text_size(11)
      .font_medium()
      .text_color(disabled ? t.dim : fg)
      .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
      .when(!disabled, (el) =>
        el
          .cursor_pointer()
          .hover((s) => s.bg(primary ? t.accent : t.hover))
          .on_click(onClick),
      )
      .when(Boolean(icon), (el) =>
        el.child(svg(`mods/mesh-ship/icons/${icon}`).size(11.5).flex_none().text_color(disabled ? t.dim : fg)),
      )
      .child(div().whitespace_nowrap().child(label));
  }

  renderConfigDrawer(t, cfg, mono, cx) {
    const stop = (_e, cx) => cx.stop_propagation();
    const previewParsed = parseChainInput(this.chainInput.value());
    const previewLabel = previewParsed.length > 0
      ? ["Feature", ...previewParsed].join(" → ")
      : "Enter branches separated by commas or arrows";

    return v_flex()
      .id("ship-config-drawer")
      .flex_none()
      .border_b(1)
      .border_color(t.border)
      .bg(t.raised)
      .on_key_down((e, cx) => {
        if (e.key === "escape" || e.keystroke === "escape") {
          cx.stop_propagation();
          this.handle.focus();
          this.configOpen = false;
          cx.notify();
        }
      })
      .child(
        v_flex()
          .id("ship-config-scroll")
          .max_h(340)
          .p(10)
          .gap(10)
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .gap(4)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .justify_between()
                  .child(div().flex_none().text_size(11).font_semibold().text_color(t.foreground).child("Workspace Promotion Chain"))
                  .child(div().min_w(0).truncate().text_size(10).text_color(t.dim).child(previewLabel)),
              )
              .child(
                div()
                  .id("ship-chain-input-wrap")
                  .h(30)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .cursor_text()
                  .on_mouse_down("left", stop)
                  .child(Input.new(this.chainInput).w_full().h_full().text_size(11.5).text_color(t.foreground)),
              ),
          )
          .when(this.services.length > 0, (el) =>
            el.child(
              v_flex()
                .gap(4)
                .child(div().text_size(11).font_semibold().text_color(t.foreground).child("Per-Repo Chain Overrides (optional)"))
                .children(
                  this.services.map((svc) => {
                    const overrideInput = this.repoOverrideInputs.get(svc.id);
                    return h_flex()
                      .id(`ship-override-row-${svc.id}`)
                      .gap(8)
                      .items_center()
                      .child(
                        div()
                          .w(110)
                          .flex_none()
                          .truncate()
                          .font_family(mono)
                          .text_size(10.5)
                          .text_color(t.muted)
                          .child(svc.name),
                      )
                      .when(Boolean(overrideInput), (row) =>
                        row.child(
                          div()
                            .flex_1()
                            .min_w(0)
                            .h(26)
                            .px(7)
                            .flex()
                            .items_center()
                            .rounded(5)
                            .border_1()
                            .border_color(t.border)
                            .bg(t.background)
                            .cursor_text()
                            .on_mouse_down("left", stop)
                            .child(Input.new(overrideInput).w_full().h_full().text_size(11).text_color(t.foreground)),
                        ),
                      );
                  }),
                ),
            ),
          )
          .child(
            v_flex()
              .gap(4)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .justify_between()
                  .child(div().flex_none().text_size(11).font_semibold().text_color(t.foreground).child("PR Template (pr-template.md)"))
                  .child(div().min_w(0).text_size(9.5).font_family(mono).text_color(t.dim).truncate().child(cfg.prTemplatePath)),
              )
              .child(
                div()
                  .text_size(10)
                  .text_color(t.dim)
                  .child("Placeholders: {{ticket}}, {{title}}, {{services}}, {{summary}}, {{testSummary}}"),
              )
              .child(
                div()
                  .id("ship-template-editor-wrap")
                  .w_full()
                  .p(7)
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .cursor_text()
                  .on_mouse_down("left", stop)
                  .child(
                    Textarea.new(this.templateInput)
                      .w_full()
                      .font_family(mono)
                      .text_size(11)
                      .text_color(t.foreground),
                  ),
              ),
          ),
      )
      .child(
        h_flex()
          .px(10)
          .py(7)
          .items_center()
          .justify_end()
          .gap(6)
          .border_t(1)
          .border_color(t.border)
          .child(
            this.renderActionButton(
              "ship-config-reset",
              "Reset Default",
              { t, tooltip: "Restore default chain (development, ci, main) and PR template" },
              (_e, cx) => this.resetConfig(cx),
            ),
          )
          .child(
            this.renderActionButton(
              "ship-config-save",
              "Save Config",
              { t, icon: "check.svg", primary: true },
              (_e, cx) => this.saveConfig(cx),
            ),
          ),
      );
  }

  renderServiceCard(svcState, t, mono, phases, cx) {
    const pr = svcState.pr;
    const isBusy = this.busyAction === `pr:${svcState.id}` || this.busyAction === "promote-all";
    const commentKey = pr ? `${svcState.id}::${pr.number}` : svcState.id;
    const isExpanded = this.expandedComments.has(commentKey);
    const hasComments = Boolean(pr && Array.isArray(pr.threads) && pr.threads.length > 0);
    const nextStageIdx = this.selectedPhaseIdx + 1;
    const hasNextInRepoChain = nextStageIdx < svcState.svcChain.length;
    const nextBranchName = hasNextInRepoChain ? svcState.svcChain[nextStageIdx] : null;

    const passColor = t.ansi2 || t.done || t.accent;
    const failColor = t.ansi1 || t.blocked;
    const warnColor = t.working || t.ansi3 || t.accent;

    let prStateBadge = null;
    if (pr) {
      const stateColor =
        pr.state === "MERGED" ? t.accent : pr.state === "CLOSED" ? t.dim : passColor;
      prStateBadge = this.renderBadge(`#${pr.number} ${pr.state}`, stateColor, t);
    }

    let ciBadge = null;
    if (pr && pr.checksStatus && pr.checksStatus !== "NONE") {
      const ciColor =
        pr.checksStatus === "FAILING"
          ? failColor
          : pr.checksStatus === "PENDING"
            ? warnColor
            : passColor;
      const stats = pr.checkStats;
      const ciLabel =
        stats && stats.total > 0
          ? `CI: ${pr.checksStatus} (${stats.passed}/${stats.total})`
          : `CI: ${pr.checksStatus}`;
      ciBadge = this.renderBadge(ciLabel, ciColor, t);
    }

    let reviewBadge = null;
    if (pr?.reviewDecision) {
      const revColor =
        pr.reviewDecision === "APPROVED"
          ? passColor
          : pr.reviewDecision === "CHANGES_REQUESTED"
            ? failColor
            : warnColor;
      reviewBadge = this.renderBadge(pr.reviewDecision.replace(/_/g, " "), revColor, t);
    }

    const canCreateDirectPr =
      svcState.phaseAvailable &&
      !svcState.sameBranch &&
      (!pr || pr.state !== "OPEN");

    const createLabel = svcState.isFeaturePhase
      ? "Create PR (gh)"
      : `Promote → ${svcState.baseBranch}`;

    return v_flex()
      .id(`ship-svc-${svcState.id}`)
      .flex_none()
      .p(10)
      .gap(7)
      .rounded(8)
      .border_1()
      .border_color(
        pr?.checksStatus === "FAILING" || pr?.reviewDecision === "CHANGES_REQUESTED"
          ? withAlpha(failColor, "55", t.border)
          : t.border,
      )
      .bg(t.raised)
      .child(
        // Top row: service name + branch + git ahead/dirty telemetry
        h_flex()
          .gap(6)
          .items_center()
          .justify_between()
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(6)
              .items_center()
              .child(div().font_semibold().text_size(12.5).text_color(t.foreground).truncate().child(svcState.name))
              .child(
                h_flex()
                  .px(5)
                  .py(1)
                  .gap(4)
                  .flex_none()
                  .items_center()
                  .rounded(4)
                  .bg(t.background)
                  .border_1()
                  .border_color(t.border)
                  .child(svg("mods/mesh-ship/icons/git-branch.svg").size(10).flex_none().text_color(t.muted))
                  .child(div().font_family(mono).text_size(10).text_color(t.muted).child(svcState.currentBranch)),
              ),
          )
          .child(
            h_flex()
              .flex_none()
              .gap(5)
              .items_center()
              .when(svcState.commitsAhead > 0, (el) =>
                el.child(this.renderBadge(`${svcState.commitsAhead} ahead`, t.accent, t)),
              )
              .when(svcState.dirtyCount > 0, (el) =>
                el.child(this.renderBadge(`${svcState.dirtyCount} dirty`, warnColor, t)),
              ),
          ),
      )
      // Promotion target / chain visual strip
      .child(
        h_flex()
          .gap(5)
          .items_center()
          .text_size(10.5)
          .text_color(t.dim)
          .child(
            div()
              .font_family(mono)
              .text_color(t.muted)
              .truncate()
              .child(
                !svcState.phaseAvailable
                  ? `Stage N/A for override (${svcState.svcChain.join(" → ")})`
                  : svcState.sameBranch
                    ? `Checked out on ${svcState.baseBranch}`
                    : `${svcState.headBranch} → ${svcState.baseBranch}`,
              ),
          )
          .when(svcState.svcChain.join(",") !== (phases.map((p) => p.baseBranch).join(",")), (el) =>
            el.child(this.renderBadge("custom chain", t.muted, t)),
          ),
      )
      // PR status row
      .when(Boolean(pr), (el) =>
        el.child(
          v_flex()
            .gap(5)
            .child(
              h_flex()
                .gap(5)
                .items_center()
                .when(Boolean(prStateBadge), (r) => r.child(prStateBadge))
                .when(Boolean(ciBadge), (r) => r.child(ciBadge))
                .when(Boolean(reviewBadge), (r) => r.child(reviewBadge)),
            )
            .when(Boolean(pr.title), (r) =>
              r.child(div().text_size(11.5).text_color(t.foreground).truncate().child(pr.title)),
            ),
        ),
      )
      .when(!pr && svcState.ghError && !this.globalGhError, (el) =>
        el.child(
          div()
            .text_size(10.5)
            .text_color(svcState.ghError.code === "no_remote" ? t.dim : warnColor)
            .child(svcState.ghError.summary),
        ),
      )
      .when(!pr && !svcState.ghError && svcState.phaseAvailable && !svcState.sameBranch, (el) =>
        el.child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(`No PR found for ${svcState.headBranch} → ${svcState.baseBranch}`),
        ),
      )
      // Expandable unresolved review threads
      .when(hasComments, (el) =>
        el.child(
          v_flex()
            .gap(4)
            .child(
              h_flex()
                .id(`ship-comments-toggle-${svcState.id}`)
                .h(24)
                .px(7)
                .gap(6)
                .items_center()
                .rounded(5)
                .bg(withAlpha(warnColor, "18", t.background))
                .border_1()
                .border_color(withAlpha(warnColor, "44", t.border))
                .cursor_pointer()
                .hover((s) => s.bg(withAlpha(warnColor, "28", t.hover)))
                .on_click((_e, cx) => this.toggleExpandComments(commentKey, cx))
                .child(div().text_size(10).text_color(warnColor).child(isExpanded ? "▾" : "▸"))
                .child(svg("mods/mesh-ship/icons/comment.svg").size(11).flex_none().text_color(warnColor))
                .child(
                  div()
                    .text_size(11)
                    .font_medium()
                    .text_color(warnColor)
                    .child(`${pr.threads.length} unresolved comment${pr.threads.length === 1 ? "" : "s"}`),
                ),
            )
            .when(isExpanded, (box) =>
              box.child(
                v_flex()
                  .gap(4)
                  .pl(4)
                  .children(
                    pr.threads.map((th) =>
                      v_flex()
                        .id(`ship-thread-${svcState.id}-${th.id}`)
                        .p(7)
                        .gap(3)
                        .rounded(5)
                        .bg(t.background)
                        .border_1()
                        .border_color(t.border)
                        .child(
                          h_flex()
                            .gap(6)
                            .items_center()
                            .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(`@${th.author}`))
                            .child(
                              div()
                                .flex_1()
                                .min_w(0)
                                .truncate()
                                .font_family(mono)
                                .text_size(10)
                                .text_color(t.dim)
                                .child(th.line ? `${th.path}:${th.line}` : th.path),
                            )
                            .when(th.isOutdated, (b) => b.child(this.renderBadge("outdated", t.dim, t))),
                        )
                        .child(div().text_size(11).text_color(t.foreground).child(th.body)),
                    ),
                  ),
              ),
            ),
        ),
      )
      // Per-service action buttons
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .items_center()
          .when(canCreateDirectPr, (row) =>
            row.child(
              this.renderActionButton(
                `ship-create-pr-${svcState.id}`,
                isBusy ? "Creating…" : createLabel,
                {
                  t,
                  icon: isBusy ? "spinner.svg" : "git-pr.svg",
                  primary: true,
                  disabled: Boolean(this.busyAction),
                  tooltip: `Push ${svcState.headBranch} & run gh pr create → ${svcState.baseBranch}`,
                },
                (_e, cx) => this.createPrForService(svcState, cx),
              ),
            ),
          )
          .when(Boolean(pr), (row) =>
            row.child(
              this.renderActionButton(
                `ship-open-pr-${svcState.id}`,
                "Open PR",
                { t, icon: "external.svg", tooltip: pr.url || `Open PR #${pr.number}` },
                (_e, cx) => this.openPrUrl(svcState, cx),
              ),
            ),
          )
          .when(hasComments, (row) =>
            row.child(
              this.renderActionButton(
                `ship-send-comments-${svcState.id}`,
                "Send Comments",
                {
                  t,
                  icon: "send.svg",
                  accentColor: warnColor,
                  disabled: Boolean(this.busyAction),
                  tooltip: "Send unresolved PR review threads to active agent",
                },
                (_e, cx) => this.sendReviewCommentsToAgent([svcState], cx),
              ),
            ),
          )
          .when(Boolean(pr && nextBranchName), (row) =>
            row.child(
              this.renderActionButton(
                `ship-next-stage-${svcState.id}`,
                `Promote → ${nextBranchName}`,
                {
                  t,
                  icon: "git-branch.svg",
                  tooltip: `Switch to ${svcState.svcChain[nextStageIdx - 1]} → ${nextBranchName}`,
                },
                (_e, cx) => this.selectPhase(nextStageIdx, cx),
              ),
            ),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const ctx = getActiveContext();
    const workspaceRoot = ctx.workspaceRoot;
    const activeTabId = ctx.activeTab?.id || null;
    const flows = readFlows();
    const tabFlow = activeTabId ? asPlainObject(flows[activeTabId]) : {};
    const cfg = readPipelineConfig(workspaceRoot);
    const phases = computePhases(cfg.chain);

    // Observe mesh.flows[activeTabId].shipPhase when #flow switches between 5. PR → dev and 6. CI → main.
    const derivedShipPhase =
      tabFlow.shipPhase ??
      (tabFlow.stage === "promote" ? "promote" : tabFlow.stage === "pr_dev" ? "dev" : null);
    if (activeTabId && derivedShipPhase !== null && derivedShipPhase !== undefined) {
      const obsKey = `${activeTabId}::${derivedShipPhase}`;
      if (obsKey !== this.lastObservedShipPhaseKey) {
        this.lastObservedShipPhaseKey = obsKey;
        if (derivedShipPhase === "dev") {
          this.selectedPhaseIdx = 0;
        } else if (derivedShipPhase === "promote") {
          if (phases.length > 1 && this.selectedPhaseIdx === 0) {
            this.selectedPhaseIdx = 1;
          }
        } else {
          const numeric = Number(derivedShipPhase);
          if (Number.isInteger(numeric) && numeric >= 0 && numeric < phases.length) {
            this.selectedPhaseIdx = numeric;
          }
        }
      }
    }

    // Sync external mesh.activeService updates.
    const sharedActive = shared("mesh.activeService");
    if (
      sharedActive &&
      normPath(sharedActive.workspaceRoot) === normPath(workspaceRoot) &&
      typeof sharedActive.ts === "number" &&
      sharedActive.ts > this.lastActiveServiceTs
    ) {
      this.lastActiveServiceTs = sharedActive.ts;
      if (
        sharedActive.serviceId &&
        (sharedActive.serviceId === "all" || this.services.some((s) => s.id === sharedActive.serviceId))
      ) {
        this.activeService = sharedActive.serviceId;
      }
    }

    const desiredKey = JSON.stringify({
      workspaceRoot,
      on: ctx.on,
      tabId: activeTabId,
      phaseIdx: Math.max(0, Math.min(this.selectedPhaseIdx, phases.length - 1)),
      chain: cfg.chain,
      overrides: cfg.repoOverrides,
    });
    if (desiredKey !== this.lastContextKey && !this.refreshing) {
      this.refresh(cx);
    }

    const activePhase = phases[this.selectedPhaseIdx] || phases[0];
    const visibleServices = this.getVisibleServices();
    const openPrCount = this.serviceStates.filter((s) => s.pr?.state === "OPEN").length;
    const totalComments = visibleServices.reduce(
      (sum, s) => sum + (s.pr?.threads?.length || 0),
      0,
    );
    const agent = findActiveAgent(ctx.activeTab, tabFlow);
    const agentLabel = agent ? (agent.title || agent.app || agent.address) : "No active agent";
    const warnColor = t.working || t.ansi3 || t.accent;
    const failColor = t.ansi1 || t.blocked;

    const batchTargets = visibleServices.filter(
      (s) =>
        s.phaseAvailable &&
        !s.sameBranch &&
        (!s.pr || s.pr.state !== "OPEN") &&
        (s.isFeaturePhase ? s.commitsAhead > 0 : true),
    );
    const hasNextPhase = this.selectedPhaseIdx + 1 < phases.length;
    const batchPromoteLabel = batchTargets.length > 0
      ? (activePhase.isFeaturePhase
        ? `Create All PRs (${batchTargets.length})`
        : `Promote All → ${activePhase.baseBranch} (${batchTargets.length})`)
      : (hasNextPhase ? `Promote → ${phases[this.selectedPhaseIdx + 1].baseBranch}` : "All Promoted");

    return v_flex()
      .id("mesh-ship")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(12.5)
      .track_focus(this.handle)
      // Header
      .child(
        h_flex()
          .id("ship-header")
          .h(42)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(svg("mods/mesh-ship/icons/git-pr.svg").size(14).flex_none().text_color(t.accent))
          .child(div().min_w(0).truncate().font_semibold().text_size(13).child("Ship & Promote"))
          .when(openPrCount > 0, (el) =>
            el.child(this.renderBadge(`${openPrCount} open`, t.accent, t)),
          )
          .child(div().flex_1().min_w(0))
          .child(
            h_flex()
              .id("ship-refresh-btn")
              .h(26)
              .px(8)
              .gap(5)
              .flex_none()
              .items_center()
              .rounded(6)
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .text_size(11)
              .text_color(t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Refresh git & GitHub PR status")
              .on_click((_e, cx) => this.refresh(cx, { force: true }))
              .child(
                this.refreshing
                  ? svg("mods/mesh-ship/icons/spinner.svg").size(12).flex_none().text_color(t.accent).spin(900)
                  : svg("mods/mesh-ship/icons/refresh.svg").size(12).flex_none().text_color(t.muted),
              )
              .child(this.refreshing ? "Syncing…" : "Refresh"),
          )
          .child(
            h_flex()
              .id("ship-config-toggle")
              .h(26)
              .px(8)
              .gap(5)
              .flex_none()
              .items_center()
              .rounded(6)
              .border_1()
              .border_color(this.configOpen ? t.accent : t.border)
              .bg(this.configOpen ? t.selected : t.raised)
              .text_size(11)
              .font_medium()
              .text_color(this.configOpen ? t.foreground : t.muted)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Configure promotion chain & standardized PR template")
              .on_click((_e, cx) => this.toggleConfigDrawer(cx))
              .child(
                svg("mods/mesh-ship/icons/settings.svg")
                  .size(12)
                  .flex_none()
                  .text_color(this.configOpen ? t.accent : t.muted),
              )
              .child("Config & PR Template"),
          ),
      )
      // Collapsible Config & PR Template drawer
      .when(this.configOpen, (el) => el.child(this.renderConfigDrawer(t, cfg, mono, cx)))
      // Dynamic Stage Switcher from Promotion Chain
      .child(
        h_flex()
          .id("ship-phase-switcher")
          .h(34)
          .flex_none()
          .px(10)
          .gap(5)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .overflow_x_scrollbar()
          .children(
            phases.map((ph) => {
              const active = ph.index === this.selectedPhaseIdx;
              return h_flex()
                .id(`ship-phase-${ph.index}`)
                .h(23)
                .px(8)
                .gap(4)
                .flex_none()
                .items_center()
                .rounded(5)
                .border_1()
                .border_color(active ? withAlpha(t.accent, "66", t.border) : t.border)
                .bg(active ? t.selected : t.raised)
                .text_size(11)
                .font_medium()
                .text_color(active ? t.accent : t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(active ? t.selected : t.hover).text_color(active ? t.accent : t.foreground))
                .on_click((_e, cx) => this.selectPhase(ph.index, cx))
                .child(div().whitespace_nowrap().child(`${ph.index + 1}. ${ph.label}`));
            }),
          ),
      )
      // Service Filter Bar (when multiple repositories exist)
      .when(this.serviceStates.length > 1, (el) =>
        el.child(
          h_flex()
            .id("ship-service-filter")
            .h(30)
            .flex_none()
            .px(10)
            .gap(5)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .overflow_x_scrollbar()
            .child(
              h_flex()
                .id("ship-filter-all")
                .h(21)
                .px(7)
                .flex_none()
                .items_center()
                .rounded(4)
                .border_1()
                .border_color(this.activeService === "all" ? t.border : t.raised)
                .bg(this.activeService === "all" ? t.background : t.raised)
                .text_size(10.5)
                .font_medium()
                .text_color(this.activeService === "all" ? t.foreground : t.muted)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.selectServiceFilter("all", cx))
                .child(`All Services (${this.serviceStates.length})`),
            )
            .children(
              this.serviceStates.map((svc) => {
                const isCur = this.activeService === svc.id;
                const badgeCount = svc.pr?.unresolvedCount || 0;
                return h_flex()
                  .id(`ship-filter-${svc.id}`)
                  .h(21)
                  .px(7)
                  .gap(4)
                  .flex_none()
                  .items_center()
                  .rounded(4)
                  .border_1()
                  .border_color(isCur ? t.border : t.raised)
                  .bg(isCur ? t.background : t.raised)
                  .text_size(10.5)
                  .text_color(isCur ? t.foreground : t.muted)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.selectServiceFilter(svc.id, cx))
                  .child(div().whitespace_nowrap().child(svc.name))
                  .when(badgeCount > 0, (b) =>
                    b.child(div().text_size(9.5).text_color(warnColor).child(`· ${badgeCount}`)),
                  );
              }),
            ),
        ),
      )
      // Batch Actions Toolbar
      .child(
        v_flex()
          .id("ship-batch-toolbar")
          .flex_none()
          .px(10)
          .py(8)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .bg(t.background)
          .child(
            h_flex()
              .gap(6)
              .flex_wrap()
              .items_center()
              .child(
                this.renderActionButton(
                  "ship-ask-agent-prs",
                  this.busyAction === "ask-agent" ? "Sending…" : "Ask Agent to Create PRs",
                  {
                    t,
                    icon: "bot.svg",
                    primary: true,
                    disabled: Boolean(this.busyAction) || visibleServices.length === 0,
                    tooltip: `Dispatch PR instructions + template to ${agentLabel}`,
                  },
                  (_e, cx) => this.askAgentToCreatePrs(cx),
                ),
              )
              .child(
                this.renderActionButton(
                  "ship-promote-all",
                  this.busyAction === "promote-all" ? "Promoting…" : batchPromoteLabel,
                  {
                    t,
                    icon: "git-pr.svg",
                    disabled: Boolean(this.busyAction) || (batchTargets.length === 0 && !hasNextPhase),
                    tooltip: batchTargets.length > 0
                      ? `Run gh pr create targeting ${activePhase.baseBranch} for ${batchTargets.length} service(s)`
                      : "Switch to next promotion stage",
                  },
                  (_e, cx) => this.promoteAll(cx),
                ),
              )
              .when(totalComments > 0, (row) =>
                row.child(
                  this.renderActionButton(
                    "ship-send-all-comments",
                    this.busyAction === "send-comments"
                      ? "Sending…"
                      : `Send Review Comments (${totalComments})`,
                    {
                      t,
                      icon: "send.svg",
                      accentColor: warnColor,
                      disabled: Boolean(this.busyAction),
                      tooltip: `Send all unresolved review comments to ${agentLabel}`,
                    },
                    (_e, cx) => this.sendReviewCommentsToAgent(visibleServices, cx),
                  ),
                ),
              ),
          )
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .text_size(10.5)
              .text_color(t.dim)
              .child(svg("mods/mesh-ship/icons/bot.svg").size(11).flex_none().text_color(t.dim))
              .child(div().truncate().child(`Target agent: ${agentLabel}`)),
          ),
      )
      // Global GitHub CLI warning banner if gh is missing or unauthenticated
      .when(Boolean(this.globalGhError), (el) =>
        el.child(
          h_flex()
            .id("ship-gh-banner")
            .flex_none()
            .px(12)
            .py(6)
            .gap(6)
            .items_center()
            .border_b(1)
            .border_color(withAlpha(failColor, "44", t.border))
            .bg(withAlpha(failColor, "14", t.raised))
            .child(svg("mods/mesh-ship/icons/x.svg").size(12).flex_none().text_color(failColor))
            .child(div().flex_1().min_w(0).text_size(11).text_color(failColor).child(this.globalGhError)),
        ),
      )
      .when(Boolean(this.statusMessage), (el) =>
        el.child(
          h_flex()
            .id("ship-status-banner")
            .flex_none()
            .px(12)
            .py(6)
            .gap(6)
            .items_center()
            .border_b(1)
            .border_color(t.border)
            .bg(t.raised)
            .child(div().flex_1().min_w(0).text_size(11).text_color(failColor).child(this.statusMessage.text))
            .child(
              div()
                .p(2)
                .rounded(4)
                .cursor_pointer()
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => {
                  this.statusMessage = null;
                  cx.notify();
                })
                .child(svg("mods/mesh-ship/icons/x.svg").size(11).text_color(t.dim)),
            ),
        ),
      )
      // Scrollable Microservice PR List
      .child(
        v_flex()
          .id("ship-services-list")
          .flex_1()
          .min_h(0)
          .p(10)
          .gap(8)
          .overflow_y_scrollbar()
          .track_scroll(this.scroll)
          .when(visibleServices.length === 0, (el) =>
            el.child(
              div()
                .p(12)
                .rounded(8)
                .border_1()
                .border_color(t.border)
                .bg(t.raised)
                .text_size(11.5)
                .text_color(t.dim)
                .child(
                  !workspaceRoot
                    ? "Open a workspace folder to inspect repositories and Pull Requests."
                    : this.refreshing
                      ? "Discovering repositories and querying GitHub PRs…"
                      : "No Git repositories discovered in this workspace.",
                ),
            ),
          )
          .children(
            visibleServices.map((svcState) => this.renderServiceCard(svcState, t, mono, phases, cx)),
          ),
      );
  }
}
