import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import {
  spaces, panes, focused, agents, terminals, exec, hc,
  appHome, readTextFile, writeTextFile, watchFolder,
  theme, settings, notify, layout, shared, setShared,
  props, openOverlay, closeOverlay, window,
} from "herdr";
import { mkdir, exists } from "fs/promises";
import { join, dirname, basename } from "path";

const PORT_PROBE_INTERVAL_MS = 3000;
const VISIBLE_POLL_INTERVAL_MS = 1500;
const WATCH_DEBOUNCE_MS = 150;
const CURL_TIMEOUT_MS = 30000;
const READ_CURL_LINES = "120";
const META_MARKER = "__HERDR_META__:";

function withAlpha(color, alphaHex, fallback) {
  if (typeof color !== "string" || !color.startsWith("#")) return fallback ?? color;
  const raw = color.slice(1);
  if (raw.length === 6) return `#${raw}${alphaHex}`;
  if (raw.length === 8) return `#${raw.slice(0, 6)}${alphaHex}`;
  if (raw.length === 3) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}${alphaHex}`;
  }
  return fallback ?? color;
}

function normalizePath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

function isAbsolutePath(p) {
  if (typeof p !== "string" || !p) return false;
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function pathBasename(p) {
  const norm = normalizePath(p);
  if (!norm) return "";
  return norm.split("/").filter(Boolean).pop() || norm;
}

function sanitizeSlug(value, fallback = "workspace") {
  const clean = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean || fallback;
}

function sanitizeTabSegment(tabId) {
  const clean = String(tabId || "default").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return clean || "default";
}

function fnv1a8Hex(input) {
  let hash = 0x811c9dc5;
  const text = String(input || "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function computeWorkspaceHash(workspaceRoot) {
  const norm = normalizePath(workspaceRoot) || "default";
  const base = sanitizeSlug(pathBasename(norm), "workspace");
  return `${base}-${fnv1a8Hex(norm)}`;
}

function getStoragePaths(workspaceRoot, tabId) {
  const homeDir = appHome();
  const hash = computeWorkspaceHash(workspaceRoot);
  const safeTab = sanitizeTabSegment(tabId);
  const workspaceDir = join(homeDir, "mesh", "workspaces", hash);
  const plansDir = join(workspaceDir, "test-plans");
  const planPath = join(plansDir, `${safeTab}.json`);
  const screenshotsDir = join(workspaceDir, "screenshots", safeTab);
  const legacyPaths = [];
  if (workspaceRoot) {
    legacyPaths.push(join(workspaceRoot, ".herdr", "test-plans", `${safeTab}.json`));
    if (tabId && String(tabId) !== safeTab) {
      legacyPaths.push(join(workspaceRoot, ".herdr", "test-plans", `${String(tabId)}.json`));
    }
  }
  return {
    hash,
    safeTab,
    workspaceDir,
    plansDir,
    planPath,
    screenshotsDir,
    legacyPaths,
  };
}

function stripMachinePrefix(id, machine) {
  if (!machine || typeof id !== "string") return id;
  const prefix = `${machine}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function findTestBlock(node) {
  if (!node || typeof node !== "object") return null;
  if (node.content?.mod === "mesh-test") return node;
  for (const child of node.children ?? []) {
    const found = findTestBlock(child);
    if (found) return found;
  }
  return null;
}

function isTestPanelVisible() {
  const root = layout();
  if (!root || typeof root !== "object") return false;
  const panel = findNode(root, "panel");
  const body = findNode(root, "panel-body");
  if (panel && body) {
    return !panel.hidden && body.active === "test";
  }
  const block = findTestBlock(root);
  return block ? !block.hidden : false;
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function resolveActiveContext() {
  const allSpaces = spaces() || [];
  const activeSpace = allSpaces.find((s) => s.active) || allSpaces[0] || null;
  const activeTab = activeSpace?.tabs?.find((tb) => tb.active) || activeSpace?.tabs?.[0] || null;
  const allPanes = panes() || [];
  const tabId = activeTab?.id || null;
  const tabPanes = tabId ? allPanes.filter((p) => p.tab === tabId) : [];
  const f = focused();
  const focusedPane = f?.pane ? tabPanes.find((p) => p.pane === f.pane) : null;
  const pane = focusedPane || tabPanes.find((p) => p.cwd) || null;
  const on = activeSpace?.machine ?? pane?.machine ?? null;

  let workspaceRoot = "";
  if (activeSpace?.folder) {
    workspaceRoot = activeSpace.folder;
    if (pane?.cwd) {
      const normSpace = normalizePath(activeSpace.folder);
      const normPane = normalizePath(pane.cwd);
      if (normPane && normSpace && normPane !== normSpace && !normPane.startsWith(`${normSpace}/`)) {
        workspaceRoot = pane.cwd;
      }
    }
  } else {
    const busServices = shared("mesh.services");
    workspaceRoot = pane?.cwd || busServices?.workspaceRoot || "";
  }

  return {
    space: activeSpace,
    spaceId: activeSpace?.id || null,
    tab: activeTab,
    tabId,
    tabName: activeTab?.name || "",
    tabPanes,
    on,
    workspaceRoot: normalizePath(workspaceRoot),
    rawWorkspaceRoot: workspaceRoot || "",
  };
}

function findActiveAgent(tabId) {
  const allAgents = agents() || [];
  const allTerms = terminals() || [];
  const allPanes = panes() || [];
  const f = focused();

  const agentMap = new Map(allAgents.map((a) => [a.address, a]));
  const termMap = new Map(allTerms.map((t) => [t.address, t]));
  const isRunner = (addr) => {
    if (!addr) return false;
    const term = termMap.get(addr);
    return term?.labels?.meshRunner === "true";
  };
  const toAgentRecord = (addr) => {
    if (!addr) return null;
    const ag = agentMap.get(addr);
    if (ag) return ag;
    const term = termMap.get(addr);
    if (!term || term.state === "dead") return null;
    return {
      address: addr,
      name: term.name || term.title || term.program?.name || addr,
      title: term.title || "",
      app: term.program?.key || null,
      program: term.program || null,
      tab: term.labels?.["herdr.tab"] || tabId || null,
      status: typeof term.status === "string" ? term.status : term.status?.state || "idle",
    };
  };

  // 1. Tab-scoped leadTerminal
  const flows = asPlainObject(shared("mesh.flows"));
  const leadAddr = tabId ? flows[tabId]?.leadTerminal : null;
  if (leadAddr && !isRunner(leadAddr)) {
    const leadRec = toAgentRecord(leadAddr);
    if (leadRec) return leadRec;
  }

  // 2. Focused pane/agent in the active tab
  if (f?.agent && !isRunner(f.agent)) {
    const focusedAgent = agentMap.get(f.agent);
    if (focusedAgent && (!tabId || focusedAgent.tab === tabId)) {
      return focusedAgent;
    }
  }

  // 3. Non-runner agent pane inside activeTabId
  if (tabId) {
    const tabPanes = allPanes.filter((p) => p.tab === tabId && p.terminal && !isRunner(p.terminal));
    for (const p of tabPanes) {
      const ag = agentMap.get(p.terminal);
      if (ag) return ag;
      if (p.program?.agent) {
        const rec = toAgentRecord(p.terminal);
        if (rec) return rec;
      }
    }
  }

  // 4. First non-runner agent in activeTabId
  if (tabId) {
    const tabAgent = allAgents.find((a) => a.tab === tabId && !isRunner(a.address));
    if (tabAgent) return tabAgent;
  }

  // 5. Global fallback
  return allAgents.find((a) => !isRunner(a.address)) || allAgents[0] || null;
}

function getWorkspaceServices(workspaceRoot) {
  const bus = shared("mesh.services");
  const normRoot = normalizePath(workspaceRoot);
  if (
    bus &&
    Array.isArray(bus.services) &&
    (!normRoot || !bus.workspaceRoot || normalizePath(bus.workspaceRoot) === normRoot)
  ) {
    return bus.services;
  }
  return [];
}

function readBrowserMode(workspaceRoot, fallbackMode = "headless") {
  const cfg = asPlainObject(shared("mesh.pipelineConfig"));
  const workspaces = asPlainObject(cfg.workspaces);
  const norm = normalizePath(workspaceRoot);
  const entry = asPlainObject(workspaces[workspaceRoot] || (norm ? workspaces[norm] : null));
  if (entry.browserMode === "headed" || entry.browserMode === "headless") {
    return entry.browserMode;
  }
  return fallbackMode;
}

function persistBrowserMode(workspaceRoot, mode) {
  const norm = normalizePath(workspaceRoot);
  if (!norm) return;
  const cfg = asPlainObject(shared("mesh.pipelineConfig"));
  const workspaces = { ...asPlainObject(cfg.workspaces) };
  const key = workspaceRoot && workspaces[workspaceRoot] ? workspaceRoot : norm;
  const prev = asPlainObject(workspaces[key]);
  if (prev.browserMode === mode) return;
  workspaces[key] = {
    ...prev,
    browserMode: mode,
    updatedAt: Date.now(),
  };
  setShared("mesh.pipelineConfig", {
    ...cfg,
    workspaces,
  });
}

function recordFlowTestPlanPath(tabId, workspaceRoot, planPath) {
  if (!tabId || !planPath) return;
  const flows = asPlainObject(shared("mesh.flows"));
  const prev = asPlainObject(flows[tabId]);
  if (prev.testPlanPath === planPath) return;
  setShared("mesh.flows", {
    ...flows,
    [tabId]: {
      ...prev,
      tabId,
      workspaceRoot: prev.workspaceRoot || workspaceRoot || "",
      stage: prev.stage || "plan",
      reviewedServices: prev.reviewedServices || {},
      testPlanPath: planPath,
      updatedAt: Date.now(),
    },
  });
}

function extractPortFromUrl(urlStr) {
  if (typeof urlStr !== "string" || !urlStr.trim()) return null;
  const m = /:(\d{2,5})(?:\/|\?|#|$)/.exec(urlStr.trim());
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port <= 65535 ? port : null;
}

function parsePortsFromSs(stdout) {
  const ports = new Set();
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("State") || line.startsWith("Netid")) continue;
    const cols = line.split(/\s+/);
    const localCol = cols[0] === "LISTEN" ? cols[3] : cols.find((c) => /:\d+$/.test(c));
    if (!localCol) continue;
    const m = /:(\d+)$/.exec(localCol);
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port <= 65535) ports.add(port);
    }
  }
  return ports;
}

function parsePortsFromLsof(stdout) {
  const ports = new Set();
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const m = /:(\d+)\s+\(LISTEN\)/i.exec(rawLine);
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port <= 65535) ports.add(port);
    }
  }
  return ports;
}

function normalizeCaseStatus(rawStatus) {
  const st = String(rawStatus || "pending").trim().toLowerCase();
  if (st === "passed" || st === "pass" || st === "ok") return "passed";
  if (st === "failed" || st === "fail" || st === "error") return "failed";
  if (st === "running" || st === "in_progress") return "running";
  return "pending";
}

function computePlanMetrics(plan) {
  const cases = Array.isArray(plan?.cases) ? plan.cases : [];
  const total = cases.length;
  let passed = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;

  for (const c of cases) {
    const st = normalizeCaseStatus(c?.status);
    if (st === "passed") passed++;
    else if (st === "failed") failed++;
    else if (st === "running") running++;
    else pending++;
  }

  let status = "plan_ready";
  if (running > 0) status = "running";
  else if (failed > 0) status = "failed";
  else if (total > 0 && passed === total) status = "passed";

  const titlePrefix = plan?.title ? `${plan.title}: ` : "";
  let summary = `${titlePrefix}${total} cases`;
  if (status === "running") {
    summary = `${titlePrefix}${running} running · ${passed}/${total} passed`;
  } else if (status === "failed") {
    summary = `${titlePrefix}${failed} failed · ${passed}/${total} passed`;
  } else if (status === "passed") {
    summary = `${titlePrefix}${passed}/${total} passed`;
  } else if (!plan?.approved) {
    summary = `${titlePrefix}Awaiting approval (${total} cases)`;
  }

  return { status, total, passed, failed, running, pending, summary };
}

function resolveScreenshotAbsPath(rawPath, screenshotsDir) {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim().replace(/\\/g, "/");
  if (!trimmed) return "";
  if (isAbsolutePath(trimmed)) return normalizePath(trimmed);
  if (trimmed.startsWith("screenshots/")) {
    return normalizePath(join(dirname(dirname(screenshotsDir)), trimmed));
  }
  return normalizePath(join(screenshotsDir, trimmed));
}

function collectCaseScreenshots(testCase, screenshotsDir) {
  const candidates = [];
  if (typeof testCase?.screenshot === "string" && testCase.screenshot.trim()) {
    candidates.push(testCase.screenshot.trim());
  }
  if (Array.isArray(testCase?.screenshots)) {
    for (const s of testCase.screenshots) {
      if (typeof s === "string" && s.trim()) candidates.push(s.trim());
    }
  }
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const absPath = resolveScreenshotAbsPath(raw, screenshotsDir);
    if (!absPath || seen.has(absPath)) continue;
    seen.add(absPath);
    out.push({ raw, absPath, name: pathBasename(absPath) || "screenshot.png" });
  }
  return out;
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(n >= 10000 ? 1 : 2)}s`;
}

function shellQuote(arg) {
  return `'${String(arg ?? "").replace(/'/g, `'\\''`)}'`;
}

function buildCurlShellCommand(testCase) {
  const rawCmd = typeof testCase?.command === "string" ? testCase.command.trim() : "";
  if (rawCmd) {
    const hasMetaOrPipe = /[|;&><\n]/.test(rawCmd) || /\s(?:-w|--write-out)\b/.test(rawCmd);
    if (hasMetaOrPipe) {
      return { shellCmd: rawCmd, hasMarker: false };
    }
    return {
      shellCmd: `${rawCmd} -sS -w ${shellQuote(`\n${META_MARKER}%{http_code}:%{time_total}`)}`,
      hasMarker: true,
    };
  }
  const url = typeof testCase?.url === "string" ? testCase.url.trim() : "";
  if (!url) return null;
  const method = String(testCase?.method || "GET").trim().toUpperCase();
  return {
    shellCmd: `curl -sS -X ${shellQuote(method)} ${shellQuote(url)} -w ${shellQuote(`\n${META_MARKER}%{http_code}:%{time_total}`)}`,
    hasMarker: true,
  };
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "");
}

function parseCurlsFromTerminalOutput(rawText) {
  const lines = stripAnsi(rawText).split("\n");
  const commands = [];
  let i = 0;

  while (i < lines.length) {
    let line = lines[i].trim();
    // Strip common shell / agent prompt prefixes
    line = line.replace(/^(?:[^\s]+@[^\s]+[:\s][^$#%]*[$#%]\s*|[$#>❯›]+\s+)/, "").trim();

    if (/^curl(?:\s|$)/.test(line)) {
      let full = line;
      while (full.endsWith("\\") && i + 1 < lines.length) {
        full = full.slice(0, -1).trimEnd() + " " + lines[++i].trim();
      }
      full = full.replace(/\s+/g, " ").trim();
      if (full.length > 5 && /https?:\/\/|localhost|127\.0\.0\.1|:\d{2,5}/i.test(full)) {
        commands.push(full);
      }
    }
    i++;
  }

  const unique = [];
  const seen = new Set();
  for (const cmd of commands) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    const methodMatch = /\s(?:-X|--request)\s+([A-Za-z]+)/.exec(cmd);
    const hasBody = /\s(?:-d|--data|--data-raw|--data-binary|--form|-F)\b/.test(cmd);
    const method = (methodMatch?.[1] || (hasBody ? "POST" : "GET")).toUpperCase();
    const urlMatch = /(https?:\/\/[^\s'"]+)/.exec(cmd);
    const url = urlMatch ? urlMatch[1] : "";
    let shortName = cmd;
    if (url) {
      try {
        const u = new URL(url);
        shortName = `${method} ${u.pathname}${u.search}`;
      } catch {
        shortName = `${method} ${url}`;
      }
    }
    unique.push({
      command: cmd,
      method,
      url,
      name: shortName.slice(0, 72),
    });
  }
  return unique;
}

function resolveServiceCwd(svc, workspaceServices, workspaceRoot) {
  const raw = typeof svc?.cwd === "string" && svc.cwd.trim()
    ? svc.cwd.trim()
    : typeof svc?.root === "string" && svc.root.trim()
      ? svc.root.trim()
      : "";
  if (raw) {
    if (isAbsolutePath(raw) || raw.startsWith("~")) return raw;
    if (workspaceRoot) return join(workspaceRoot, raw);
    return raw;
  }
  if (svc?.serviceId) {
    const match = workspaceServices.find((s) => s.id === svc.serviceId || s.name === svc.serviceId);
    if (match?.root) return match.root;
  }
  return workspaceRoot || "";
}

export default class MeshTest extends View {
  init(initProps, cx) {
    const p = props() || initProps || {};
    if (p.zoomImage) {
      this.isZoomModal = true;
      this.zoomFocus = cx.focus_handle();
      this.zoomFocus.focus();
      const extra = Array.isArray(p.screenshots) ? p.screenshots.filter(Boolean) : [];
      this.zoomImages = Array.from(new Set([p.zoomImage, ...extra].map(normalizePath).filter(Boolean)));
      this.activeZoomImage = normalizePath(p.zoomImage);
      this.zoomVerified = new Map();
      this.verifyZoomImage(this.activeZoomImage, cx);
      return;
    }

    this.isZoomModal = false;
    this.bodyScroll = ScrollHandle.new();
    this.activeKey = null;
    this.wasVisible = false;

    this.plan = null;
    this.planRaw = null;
    this.planSourcePath = null;
    this.planError = null;
    this.note = null;
    this.localBrowserMode = "headless";

    this.verifiedImages = new Map(); // absPath -> boolean
    this.listeningPorts = new Set();
    this.lastPortProbeAt = 0;
    this.portProbeInFlight = false;
    this.lastAlertSig = null;

    this.loadingPlan = false;
    this.loadSeq = 0;
    this.askingAgent = false;
    this.approving = false;
    this.sendingFailures = false;
    this.scanningCurls = false;
    this.spawningRunnerKey = null;
    this.runningCases = new Set();

    this.watchedPlansDir = null;
    this.watchToken = 0;
    this.debounceTask = null;
    this.pollTask = null;
  }

  close() {
    this.watchToken++;
    this.watchedPlansDir = null;
    if (this.debounceTask) {
      try { this.debounceTask.cancel(); } catch {}
      this.debounceTask = null;
    }
    if (this.pollTask) {
      try { this.pollTask.cancel(); } catch {}
      this.pollTask = null;
    }
    try { this.bodyScroll?.release(); } catch {}
    try { this.zoomFocus?.release(); } catch {}
  }

  verifyZoomImage(imgPath, cx) {
    if (!imgPath) return;
    cx.spawn(async (cx) => {
      const ok = await exists(imgPath).catch(() => false);
      this.zoomVerified.set(imgPath, ok);
      cx.notify();
    });
  }

  selectZoomImage(imgPath, cx) {
    if (!imgPath || imgPath === this.activeZoomImage) return;
    this.activeZoomImage = imgPath;
    if (!this.zoomVerified.has(imgPath)) {
      this.verifyZoomImage(imgPath, cx);
    }
    cx.notify();
  }

  closeZoomModal() {
    const overlayId = props()?.overlay;
    if (overlayId) closeOverlay(overlayId);
  }

  publishTestAlert(tabId, workspaceRoot, plan) {
    if (!tabId) return;
    const current = shared("mesh.testAlert");
    const currentSig = current && typeof current === "object"
      ? `${current.tabId}|${current.status}|${current.total}|${current.passed}|${current.failed}|${current.running}`
      : null;

    if (!plan) {
      if (current && typeof current === "object" && current.tabId === tabId && this.lastAlertSig !== null) {
        this.lastAlertSig = null;
        setShared("mesh.testAlert", null);
      }
      return;
    }
    const { status, total, passed, failed, running, summary } = computePlanMetrics(plan);
    const sig = `${tabId}|${status}|${total}|${passed}|${failed}|${running}`;
    if (sig === this.lastAlertSig || sig === currentSig) {
      this.lastAlertSig = sig;
      return;
    }
    this.lastAlertSig = sig;
    setShared("mesh.testAlert", {
      tabId,
      workspaceRoot: workspaceRoot || "",
      status,
      total,
      passed,
      failed,
      running,
      summary,
      ts: Date.now(),
    });
  }

  startPlansWatcher(plansDir, cx) {
    if (!plansDir || this.watchedPlansDir === plansDir) return;
    this.watchedPlansDir = plansDir;
    const token = ++this.watchToken;

    cx.spawn(async (cx) => {
      try {
        await mkdir(plansDir, { recursive: true });
      } catch {
        if (this.watchToken === token) this.watchedPlansDir = null;
        return;
      }

      while (this.watchToken === token) {
        try {
          await watchFolder(plansDir);
          if (this.watchToken !== token) break;
          this.scheduleDebouncedReload(cx);
        } catch {
          if (this.watchToken !== token) break;
          await cx.sleep(2000);
        }
      }
    });
  }

  scheduleDebouncedReload(cx) {
    if (this.debounceTask) {
      this.debounceTask.cancel();
      this.debounceTask = null;
    }
    this.debounceTask = cx.timer.after(WATCH_DEBOUNCE_MS, (cx) => {
      this.debounceTask = null;
      this.loadPlan(cx, { silent: true });
      if (isTestPanelVisible()) {
        this.probePorts(cx, { force: false });
      }
    });
  }

  ensurePollTimer(cx) {
    if (this.pollTask) return;
    this.pollTask = cx.timer.every(VISIBLE_POLL_INTERVAL_MS, (cx) => {
      if (!isTestPanelVisible()) {
        this.wasVisible = false;
        if (this.pollTask) {
          this.pollTask.cancel();
          this.pollTask = null;
        }
        return;
      }
      this.loadPlan(cx, { silent: true });
      this.probePorts(cx, { force: false });
    });
  }

  async verifyPlanScreenshots(plan, screenshotsDir) {
    const cases = Array.isArray(plan?.cases) ? plan.cases : [];
    const paths = [];
    for (const c of cases) {
      for (const item of collectCaseScreenshots(c, screenshotsDir)) {
        paths.push(item.absPath);
      }
    }
    const uniquePaths = Array.from(new Set(paths));
    let changed = false;
    await Promise.all(
      uniquePaths.map(async (absPath) => {
        const ok = await exists(absPath).catch(() => false);
        if (this.verifiedImages.get(absPath) !== ok) {
          this.verifiedImages.set(absPath, ok);
          changed = true;
        }
      }),
    );
    return changed;
  }

  loadPlan(cx, opts = {}) {
    const silent = Boolean(opts.silent);
    const ctx = resolveActiveContext();
    if (!ctx.workspaceRoot || !ctx.tabId) return;
    if (this.loadingPlan && silent) return;

    const seq = ++this.loadSeq;
    const expectedKey = JSON.stringify({
      spaceId: ctx.spaceId,
      tabId: ctx.tabId,
      workspaceRoot: ctx.workspaceRoot,
      on: ctx.on,
    });
    const paths = getStoragePaths(ctx.workspaceRoot, ctx.tabId);
    this.loadingPlan = true;

    cx.spawn(async (cx) => {
      try {
        let raw = await readTextFile(paths.planPath).catch(() => null);
        let sourcePath = raw !== null ? paths.planPath : null;

        if (raw === null) {
          for (const legacyPath of paths.legacyPaths) {
            const legacyRaw = await readTextFile(legacyPath, { on: ctx.on }).catch(() => null);
            if (legacyRaw !== null) {
              raw = legacyRaw;
              sourcePath = legacyPath;
              break;
            }
          }
        }

        if (seq !== this.loadSeq || this.activeKey !== expectedKey) return;

        if (raw === null) {
          const hadPlan = Boolean(this.plan || this.planError || this.planSourcePath);
          this.plan = null;
          this.planRaw = null;
          this.planSourcePath = null;
          this.planError = null;
          this.verifiedImages.clear();
          this.publishTestAlert(ctx.tabId, ctx.workspaceRoot, null);
          if (hadPlan || !silent) cx.notify();
          return;
        }

        if (raw === this.planRaw && sourcePath === this.planSourcePath && this.plan) {
          const imgChanged = await this.verifyPlanScreenshots(this.plan, paths.screenshotsDir);
          if (seq === this.loadSeq && this.activeKey === expectedKey && imgChanged) {
            cx.notify();
          }
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (err) {
          this.planError = `Malformed test plan JSON in ${pathBasename(sourcePath)}: ${err?.message || err}`;
          cx.notify();
          return;
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          this.planError = "Test plan JSON must be an object.";
          cx.notify();
          return;
        }

        const normalized = {
          ...parsed,
          title: typeof parsed.title === "string" ? parsed.title : "Test Plan",
          approved: Boolean(parsed.approved),
          browserMode: parsed.browserMode === "headed" || parsed.browserMode === "headless"
            ? parsed.browserMode
            : undefined,
          servicesToStart: Array.isArray(parsed.servicesToStart) ? parsed.servicesToStart : [],
          cases: Array.isArray(parsed.cases) ? parsed.cases : [],
        };

        this.plan = normalized;
        this.planRaw = raw;
        this.planSourcePath = sourcePath;
        this.planError = null;

        await this.verifyPlanScreenshots(normalized, paths.screenshotsDir);
        if (seq !== this.loadSeq || this.activeKey !== expectedKey) return;

        this.publishTestAlert(ctx.tabId, ctx.workspaceRoot, normalized);
        cx.notify();
      } finally {
        if (seq === this.loadSeq) {
          this.loadingPlan = false;
        }
      }
    });
  }

  probePorts(cx, opts = {}) {
    const force = Boolean(opts.force);
    const now = Date.now();
    if (this.portProbeInFlight) return;
    if (!force && now - this.lastPortProbeAt < PORT_PROBE_INTERVAL_MS) return;

    const ctx = resolveActiveContext();
    this.portProbeInFlight = true;
    this.lastPortProbeAt = now;

    cx.spawn(async (cx) => {
      try {
        let nextPorts = null;
        const ssRes = await exec("ss", ["-tln"], { on: ctx.on, timeout: 5000 }).catch(() => null);
        if (ssRes && ssRes.code === 0) {
          nextPorts = parsePortsFromSs(ssRes.stdout);
        } else {
          const lsofRes = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
            on: ctx.on,
            timeout: 5000,
          }).catch(() => null);
          if (lsofRes && lsofRes.code === 0) {
            nextPorts = parsePortsFromLsof(lsofRes.stdout);
          }
        }

        if (nextPorts) {
          const prevSig = Array.from(this.listeningPorts).sort((a, b) => a - b).join(",");
          const nextSig = Array.from(nextPorts).sort((a, b) => a - b).join(",");
          if (prevSig !== nextSig) {
            this.listeningPorts = nextPorts;
            cx.notify();
          }
        }
      } finally {
        this.portProbeInFlight = false;
      }
    });
  }

  async mutatePlanAtomic(planPath, mutator) {
    await mkdir(dirname(planPath), { recursive: true }).catch(() => {});
    for (let attempt = 0; attempt < 4; attempt++) {
      const expectedText = await readTextFile(planPath).catch(() => null);
      let baseObj = null;
      if (expectedText !== null && expectedText.trim()) {
        try {
          baseObj = JSON.parse(expectedText);
        } catch {
          throw new Error("Existing test plan JSON is malformed.");
        }
      } else if (this.plan) {
        baseObj = JSON.parse(JSON.stringify(this.plan));
      } else {
        baseObj = {
          title: "Test Plan",
          approved: false,
          servicesToStart: [],
          cases: [],
        };
      }

      const cloned = JSON.parse(JSON.stringify(baseObj));
      const nextObj = mutator(cloned);
      const nextText = `${JSON.stringify(nextObj, null, 2)}\n`;
      try {
        await writeTextFile(planPath, nextText, expectedText);
        return { plan: nextObj, raw: nextText };
      } catch (err) {
        if (attempt === 3) throw err;
      }
    }
    throw new Error("Failed to commit atomic plan update.");
  }

  toggleBrowserMode(mode, cx) {
    const ctx = resolveActiveContext();
    this.localBrowserMode = mode;
    if (ctx.workspaceRoot) {
      persistBrowserMode(ctx.workspaceRoot, mode);
    }
    cx.notify();
  }

  askAgentForTestPlan(cx) {
    if (this.askingAgent) return;
    const ctx = resolveActiveContext();
    if (!ctx.workspaceRoot || !ctx.tabId) {
      this.note = "Open a workspace tab before requesting a test plan.";
      cx.notify();
      return;
    }
    const agent = findActiveAgent(ctx.tabId);
    if (!agent) {
      this.note = "No active AI agent found in this tab.";
      notify({
        title: "No active agent",
        body: "Start or focus an agent terminal in the current tab first.",
        level: "warning",
      });
      cx.notify();
      return;
    }

    const paths = getStoragePaths(ctx.workspaceRoot, ctx.tabId);
    const services = getWorkspaceServices(ctx.workspaceRoot);
    const browserMode = readBrowserMode(ctx.workspaceRoot, this.localBrowserMode);
    const flow = asPlainObject(shared("mesh.flows"))[ctx.tabId];
    const ticketLabel = flow?.ticket ? ` (${flow.ticket})` : "";
    const featureTitle = ctx.tabName || flow?.derivedTitle || "Active feature";

    const serviceLines = services.length > 0
      ? services.map((s) => `- ${s.name} (serviceId: "${s.id}", root: "${s.root}"${s.branch ? `, branch: "${s.branch}"` : ""})`).join("\n")
      : `- workspace (serviceId: "workspace", root: "${ctx.workspaceRoot}")`;

    const prompt = [
      `Create an executable zero-pollution test plan for tab "${featureTitle}"${ticketLabel}.`,
      "",
      `Workspace Root: ${ctx.workspaceRoot}`,
      "Workspace Microservices:",
      serviceLines,
      "",
      "CRITICAL ZERO-POLLUTION STORAGE RULES:",
      `- Write the test plan JSON strictly to: ${paths.planPath}`,
      `- Save any Playwright E2E PNG screenshots strictly under: ${paths.screenshotsDir}/<caseId>.png`,
      "- NEVER create test plan files, temporary Playwright scripts, or screenshots inside any microservice Git repository.",
      "",
      "Instructions:",
      "1. Inspect the modified microservices and recent changes for this feature.",
      `2. Write an executable test plan JSON at "${paths.planPath}" using this exact schema:`,
      "```json",
      "{",
      '  "title": "Short feature test plan title",',
      '  "approved": false,',
      `  "browserMode": "${browserMode}",`,
      '  "servicesToStart": [',
      '    { "serviceId": "service-id", "name": "service-name", "cwd": "/abs/path/to/service", "command": "npm start", "port": 8080, "healthUrl": "http://localhost:8080/health" }',
      "  ],",
      '  "cases": [',
      "    {",
      '      "id": "case-1",',
      '      "kind": "curl",',
      '      "name": "Descriptive test name",',
      '      "serviceId": "service-id",',
      '      "command": "curl -sS http://localhost:8080/api/...",',
      '      "method": "GET",',
      '      "url": "http://localhost:8080/api/...",',
      '      "expectedStatus": 200,',
      '      "status": "pending",',
      '      "httpCode": null,',
      '      "durationMs": null,',
      '      "summary": "",',
      '      "error": "",',
      `      "screenshot": "${paths.screenshotsDir}/case-2.png",`,
      '      "screenshots": []',
      "    }",
      "  ]",
      "}",
      "```",
      `3. Include Playwright E2E test cases ("kind": "e2e") whenever frontend (e.g. Angular/web) or cross-service UI flows are touched. Configure Playwright in "${browserMode}" mode, save PNG screenshots to "${paths.screenshotsDir}/<caseId>.png", and update each case's "status" ("running" -> "passed" | "failed"), "httpCode", "durationMs", "summary", "error", and "screenshot"/"screenshots" live inside "${paths.planPath}" as you execute.`,
      "4. Set \"approved\": false and WAIT for my approval before starting services or running tests.",
    ].join("\n");

    this.askingAgent = true;
    this.note = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await mkdir(paths.plansDir, { recursive: true });
        await mkdir(paths.screenshotsDir, { recursive: true });
        recordFlowTestPlanPath(ctx.tabId, ctx.workspaceRoot, paths.planPath);

        const res = await hc(["send", agent.address, prompt]).catch((err) => ({
          code: 1,
          stderr: String(err),
          stdout: "",
        }));
        if (!res || res.code !== 0) {
          const msg = res?.stderr?.trim() || res?.stdout?.trim() || "hc send failed";
          this.note = `Failed to reach agent (${agent.address}): ${msg}`;
          notify({ title: "Failed to prompt agent", body: msg, level: "error" });
        } else {
          notify({
            title: "Test plan requested",
            body: `Sent instructions to ${agent.name || agent.address}`,
            level: "success",
          });
        }
      } catch (err) {
        this.note = `Failed to prepare test plan request: ${err?.message || err}`;
      } finally {
        this.askingAgent = false;
        cx.notify();
      }
    });
  }

  approvePlan(cx) {
    if (this.approving || !this.plan || this.plan.approved) return;
    const ctx = resolveActiveContext();
    if (!ctx.workspaceRoot || !ctx.tabId) return;

    const agent = findActiveAgent(ctx.tabId);
    if (!agent) {
      this.note = "No active AI agent found to execute the approved test plan.";
      notify({
        title: "No active agent",
        body: "Start or focus an agent terminal in this tab before approving.",
        level: "warning",
      });
      cx.notify();
      return;
    }

    const paths = getStoragePaths(ctx.workspaceRoot, ctx.tabId);
    const browserMode = readBrowserMode(ctx.workspaceRoot, this.localBrowserMode);

    this.approving = true;
    this.note = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await mkdir(paths.plansDir, { recursive: true });
        await mkdir(paths.screenshotsDir, { recursive: true });

        const { plan: nextPlan, raw: nextRaw } = await this.mutatePlanAtomic(paths.planPath, (doc) => ({
          ...doc,
          approved: true,
          browserMode,
        }));

        this.plan = nextPlan;
        this.planRaw = nextRaw;
        this.planSourcePath = paths.planPath;
        this.planError = null;
        recordFlowTestPlanPath(ctx.tabId, ctx.workspaceRoot, paths.planPath);
        this.publishTestAlert(ctx.tabId, ctx.workspaceRoot, nextPlan);

        const message = [
          `Test plan approved. Please start any required local services and execute the test plan, updating live status and screenshots in ${paths.planPath}.`,
          `Use Playwright browser mode "${browserMode}" and save screenshots under ${paths.screenshotsDir}/.`,
        ].join("\n");

        const res = await hc(["send", agent.address, message]).catch((err) => ({
          code: 1,
          stderr: String(err),
          stdout: "",
        }));
        if (!res || res.code !== 0) {
          const msg = res?.stderr?.trim() || res?.stdout?.trim() || "hc send failed";
          this.note = `Plan approved on disk, but failed to notify agent (${agent.address}): ${msg}`;
          notify({ title: "Failed to notify agent", body: msg, level: "error" });
        } else {
          notify({
            title: "Test plan approved",
            body: `Execution started on ${agent.name || agent.address}`,
            level: "success",
          });
        }
      } catch (err) {
        this.note = `Failed to approve test plan: ${err?.message || err}`;
        notify({ title: "Approval failed", body: String(err?.message || err), level: "error" });
      } finally {
        this.approving = false;
        cx.notify();
      }
    });
  }

  spawnServiceRunner(svc, key, cx) {
    if (this.spawningRunnerKey) return;
    const ctx = resolveActiveContext();
    if (!ctx.tabId) return;

    const services = getWorkspaceServices(ctx.workspaceRoot);
    const cwd = resolveServiceCwd(svc, services, ctx.workspaceRoot);
    const cmd = typeof svc?.command === "string" ? svc.command.trim() : "";

    this.spawningRunnerKey = key;
    this.note = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const args = ["run", "--bg", "--keep"];
        if (ctx.on) args.push("--on", ctx.on);
        if (cwd) args.push("--cwd", cwd);
        if (ctx.spaceId) args.push("--label", `herdr.space=${stripMachinePrefix(ctx.spaceId, ctx.on)}`);
        if (ctx.tabId) args.push("--label", `herdr.tab=${stripMachinePrefix(ctx.tabId, ctx.on)}`);
        args.push("--label", "meshRunner=true");
        if (cmd) {
          args.push("bash", "-lc", `${cmd}; exec bash`);
        }

        const res = await hc(args).catch((err) => ({ code: 1, stderr: String(err), stdout: "" }));
        if (!res || res.code !== 0) {
          const msg = res?.stderr?.trim() || res?.stdout?.trim() || "hc run exited with an error";
          this.note = `Failed to start service runner: ${msg}`;
          notify({ title: "Runner launch failed", body: msg, level: "error" });
        } else {
          notify({
            title: `Runner opened: ${svc.name || svc.serviceId || "Service"}`,
            body: cmd || cwd || "Split shell ready",
            level: "info",
          });
          this.probePorts(cx, { force: true });
        }
      } finally {
        this.spawningRunnerKey = null;
        cx.notify();
      }
    });
  }

  runCurlCase(testCase, caseIndex, cx) {
    const caseKey = testCase?.id || String(caseIndex);
    if (this.runningCases.has(caseKey)) return;

    const built = buildCurlShellCommand(testCase);
    if (!built) {
      this.note = `Case "${testCase?.name || caseKey}" has no curl command or URL.`;
      cx.notify();
      return;
    }

    const ctx = resolveActiveContext();
    if (!ctx.workspaceRoot || !ctx.tabId) return;
    const paths = getStoragePaths(ctx.workspaceRoot, ctx.tabId);
    const services = getWorkspaceServices(ctx.workspaceRoot);
    const targetCwd = resolveServiceCwd(
      { serviceId: testCase?.serviceId },
      services,
      ctx.workspaceRoot,
    );

    const matchCase = (c, idx) => (testCase?.id ? c?.id === testCase.id : idx === caseIndex);

    this.runningCases.add(caseKey);
    this.note = null;
    if (this.plan && Array.isArray(this.plan.cases)) {
      this.plan = {
        ...this.plan,
        cases: this.plan.cases.map((c, idx) => (matchCase(c, idx) ? { ...c, status: "running", error: "" } : c)),
      };
      this.publishTestAlert(ctx.tabId, ctx.workspaceRoot, this.plan);
    }
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        try {
          const { plan: runningPlan, raw: runningRaw } = await this.mutatePlanAtomic(paths.planPath, (doc) => {
            const list = Array.isArray(doc.cases) ? doc.cases : [];
            return {
              ...doc,
              cases: list.map((c, idx) => (matchCase(c, idx) ? { ...c, status: "running", error: "" } : c)),
            };
          });
          this.plan = runningPlan;
          this.planRaw = runningRaw;
          this.planSourcePath = paths.planPath;
          this.publishTestAlert(ctx.tabId, ctx.workspaceRoot, runningPlan);
          cx.notify();
        } catch {}

        const startedAt = Date.now();
        const res = await exec("sh", ["-c", built.shellCmd], {
          cwd: targetCwd || undefined,
          on: ctx.on,
          timeout: CURL_TIMEOUT_MS,
        }).catch((err) => ({
          code: 1,
          stdout: "",
          stderr: String(err?.message || err),
        }));

        const wallDurationMs = Date.now() - startedAt;
        let stdout = String(res?.stdout || "");
        const stderr = String(res?.stderr || "").trim();
        let httpCode = null;
        let durationMs = wallDurationMs;

        if (built.hasMarker) {
          const metaRe = new RegExp(`\\n?${META_MARKER}(\\d+):([0-9.]+)\\s*$`);
          const m = metaRe.exec(stdout);
          if (m) {
            httpCode = Number(m[1]) || null;
            const parsedSec = Number(m[2]);
            if (Number.isFinite(parsedSec) && parsedSec >= 0) {
              durationMs = Math.round(parsedSec * 1000);
            }
            stdout = stdout.slice(0, m.index).trim();
          }
        }

        const expectedStatus = Number(testCase?.expectedStatus);
        const hasExpected = Number.isFinite(expectedStatus) && expectedStatus > 0;

        let passed = false;
        let summary = "";
        let error = "";
        const snippet = stdout.replace(/\s+/g, " ").trim().slice(0, 140);

        if (res?.code !== 0) {
          passed = false;
          error = stderr || snippet || `curl exited with code ${res?.code ?? 1}`;
        } else if (httpCode !== null) {
          passed = hasExpected ? httpCode === expectedStatus : httpCode >= 200 && httpCode < 400;
          if (passed) {
            summary = `HTTP ${httpCode} in ${formatDuration(durationMs)}${snippet ? ` · ${snippet}` : ""}`;
          } else {
            error = hasExpected
              ? `Expected HTTP ${expectedStatus}, got ${httpCode}${snippet ? `: ${snippet}` : ""}`
              : `HTTP ${httpCode}${snippet ? `: ${snippet}` : ""}`;
          }
        } else {
          passed = true;
          summary = snippet || `Completed in ${formatDuration(durationMs)}`;
        }

        const nextStatus = passed ? "passed" : "failed";
        const { plan: finalPlan, raw: finalRaw } = await this.mutatePlanAtomic(paths.planPath, (doc) => {
          const list = Array.isArray(doc.cases) ? doc.cases : [];
          return {
            ...doc,
            cases: list.map((c, idx) => {
              if (!matchCase(c, idx)) return c;
              return {
                ...c,
                status: nextStatus,
                httpCode: httpCode ?? c.httpCode ?? null,
                durationMs,
                summary: passed ? summary : (c.summary || ""),
                error: passed ? "" : error,
              };
            }),
          };
        });

        this.plan = finalPlan;
        this.planRaw = finalRaw;
        this.planSourcePath = paths.planPath;
        this.publishTestAlert(ctx.tabId, ctx.workspaceRoot, finalPlan);
      } catch (err) {
        this.note = `Failed to run curl test: ${err?.message || err}`;
      } finally {
        this.runningCases.delete(caseKey);
        this.probePorts(cx, { force: false });
        cx.notify();
      }
    });
  }

  sendFailuresToAgent(cx) {
    if (this.sendingFailures || !this.plan) return;
    const ctx = resolveActiveContext();
    if (!ctx.workspaceRoot || !ctx.tabId) return;

    const failedCases = (this.plan.cases || []).filter((c) => normalizeCaseStatus(c?.status) === "failed");
    if (failedCases.length === 0) return;

    const agent = findActiveAgent(ctx.tabId);
    if (!agent) {
      this.note = "No active AI agent found to send test failures to.";
      notify({ title: "No active agent", body: "Focus or open an agent terminal in this tab.", level: "warning" });
      cx.notify();
      return;
    }

    const paths = getStoragePaths(ctx.workspaceRoot, ctx.tabId);
    const planFile = this.planSourcePath || paths.planPath;
    const blocks = failedCases.map((c, idx) => {
      const shots = collectCaseScreenshots(c, paths.screenshotsDir).map((s) => s.absPath);
      const lines = [
        `${idx + 1}. **${c.name || c.id || "Unnamed case"}** (${String(c.kind || "curl").toUpperCase()})`,
      ];
      if (c.serviceId) lines.push(`   - Service: \`${c.serviceId}\``);
      if (c.command) lines.push(`   - Command: \`${c.command}\``);
      else if (c.url) lines.push(`   - Endpoint: \`${String(c.method || "GET").toUpperCase()} ${c.url}\``);
      if (c.expectedStatus || c.httpCode) {
        lines.push(`   - HTTP Status: expected \`${c.expectedStatus ?? "2xx"}\`, actual \`${c.httpCode ?? "n/a"}\``);
      }
      if (c.error) lines.push(`   - Error: ${c.error}`);
      if (c.summary) lines.push(`   - Summary: ${c.summary}`);
      if (shots.length > 0) lines.push(`   - Screenshot(s): ${shots.join(", ")}`);
      return lines.join("\n");
    });

    const msg = [
      `${failedCases.length} test case(s) failed in "${this.plan.title || "Test Plan"}":`,
      "",
      ...blocks,
      "",
      "Please investigate each failure, determine whether it is an application bug or a test plan/setup issue, apply the fix, and re-run the failed tests.",
      `Update live test results in "${planFile}" (and any E2E screenshots under "${paths.screenshotsDir}/").`,
    ].join("\n");

    this.sendingFailures = true;
    this.note = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await hc(["send", agent.address, msg]).catch((err) => ({
          code: 1,
          stderr: String(err),
          stdout: "",
        }));
        if (!res || res.code !== 0) {
          const errMsg = res?.stderr?.trim() || res?.stdout?.trim() || "hc send failed";
          this.note = `Failed to send failures to agent: ${errMsg}`;
          notify({ title: "Dispatch failed", body: errMsg, level: "error" });
        } else {
          notify({
            title: "Failures sent to agent",
            body: `Dispatched ${failedCases.length} failure(s) to ${agent.name || agent.address}`,
            level: "success",
          });
        }
      } finally {
        this.sendingFailures = false;
        cx.notify();
      }
    });
  }

  scanTerminalCurls(cx) {
    if (this.scanningCurls) return;
    const ctx = resolveActiveContext();
    if (!ctx.workspaceRoot || !ctx.tabId) return;

    const agent = findActiveAgent(ctx.tabId);
    const targetAddr = agent?.address || ctx.tabPanes.find((p) => p.terminal)?.terminal || null;
    if (!targetAddr) {
      this.note = "No terminal available in the active tab to scan.";
      cx.notify();
      return;
    }

    const paths = getStoragePaths(ctx.workspaceRoot, ctx.tabId);
    this.scanningCurls = true;
    this.note = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const readRes = await hc(["read", "--lines", READ_CURL_LINES, targetAddr]).catch(() => null);
        if (!readRes || readRes.code !== 0) {
          this.note = `Unable to read terminal ${targetAddr}.`;
          return;
        }
        const parsed = parseCurlsFromTerminalOutput(readRes.stdout);
        if (parsed.length === 0) {
          this.note = `No curl commands found in the last ${READ_CURL_LINES} lines of ${targetAddr}.`;
          notify({
            title: "No curl commands found",
            body: `Checked ${targetAddr} scrollback.`,
            level: "info",
          });
          return;
        }

        let addedCount = 0;
        const { plan: nextPlan, raw: nextRaw } = await this.mutatePlanAtomic(paths.planPath, (doc) => {
          const existingCases = Array.isArray(doc.cases) ? [...doc.cases] : [];
          const existingCmds = new Set(existingCases.map((c) => String(c?.command || "").trim()).filter(Boolean));
          for (const item of parsed) {
            if (existingCmds.has(item.command)) continue;
            existingCmds.add(item.command);
            addedCount++;
            existingCases.push({
              id: `scan-${existingCases.length + 1}`,
              kind: "curl",
              name: item.name,
              command: item.command,
              method: item.method,
              url: item.url,
              expectedStatus: 200,
              status: "pending",
              summary: "Scanned from terminal output",
            });
          }
          return {
            title: doc.title || "Terminal Curl Checks",
            approved: doc.approved ?? true,
            browserMode: doc.browserMode || readBrowserMode(ctx.workspaceRoot, this.localBrowserMode),
            servicesToStart: Array.isArray(doc.servicesToStart) ? doc.servicesToStart : [],
            cases: existingCases,
          };
        });

        this.plan = nextPlan;
        this.planRaw = nextRaw;
        this.planSourcePath = paths.planPath;
        this.planError = null;
        recordFlowTestPlanPath(ctx.tabId, ctx.workspaceRoot, paths.planPath);
        this.publishTestAlert(ctx.tabId, ctx.workspaceRoot, nextPlan);

        notify({
          title: addedCount > 0 ? `Imported ${addedCount} curl command(s)` : "Terminal curls up to date",
          body: `Scanned ${targetAddr}`,
          level: addedCount > 0 ? "success" : "info",
        });
      } catch (err) {
        this.note = `Scan failed: ${err?.message || err}`;
      } finally {
        this.scanningCurls = false;
        cx.notify();
      }
    });
  }

  openScreenshotZoom(absPath, testCase, allVerifiedPaths) {
    openOverlay({
      mod: "mesh-test",
      kind: "dialog",
      width: 920,
      height: 680,
      props: {
        zoomImage: absPath,
        title: testCase?.name || "E2E Screenshot",
        summary: testCase?.summary || testCase?.error || "",
        status: normalizeCaseStatus(testCase?.status),
        httpCode: testCase?.httpCode ?? null,
        durationMs: testCase?.durationMs ?? null,
        screenshots: allVerifiedPaths,
      },
    });
  }

  renderZoomModal(cx) {
    const t = theme();
    const p = props() || {};
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const activeImg = this.activeZoomImage || normalizePath(p.zoomImage);
    const verified = this.zoomVerified.get(activeImg);
    const status = p.status ? normalizeCaseStatus(p.status) : null;
    const passColor = t.ansi2 || t.done || t.accent;
    const failColor = t.ansi1 || t.blocked || t.accent;
    const statusColor = status === "passed" ? passColor : status === "failed" ? failColor : t.muted;

    return v_flex()
      .id("mesh-test-zoom-modal")
      .size_full()
      .min_h(0)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.zoomFocus)
      .on_key_down((e, cx) => {
        const k = String(e.key || "").toLowerCase();
        const ks = String(e.keystroke || "").toLowerCase();
        if (k === "escape" || ks === "escape") {
          cx.stop_propagation();
          this.closeZoomModal();
          return;
        }
        if (this.zoomImages.length > 1) {
          const idx = this.zoomImages.indexOf(activeImg);
          if (k === "right" || k === "arrowright") {
            const next = this.zoomImages[(idx + 1) % this.zoomImages.length];
            this.selectZoomImage(next, cx);
          } else if (k === "left" || k === "arrowleft") {
            const prev = this.zoomImages[(idx - 1 + this.zoomImages.length) % this.zoomImages.length];
            this.selectZoomImage(prev, cx);
          }
        }
      })
      .child(
        h_flex()
          .flex_none()
          .px(16)
          .py(12)
          .gap(10)
          .items_center()
          .justify_between()
          .border_b(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(3)
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(svg("mods/mesh-test/icons/camera.svg").size(14).flex_none().text_color(t.accent))
                  .child(div().min_w(0).truncate().font_semibold().text_size(14).child(p.title || "Screenshot Viewer"))
                  .when(Boolean(status), (el) =>
                    el.child(
                      div()
                        .flex_none()
                        .px(6)
                        .py(1)
                        .rounded(4)
                        .bg(withAlpha(statusColor, "20", t.raised))
                        .border_1()
                        .border_color(withAlpha(statusColor, "55", t.border))
                        .text_size(10.5)
                        .font_semibold()
                        .text_color(statusColor)
                        .child(status.toUpperCase()),
                    ),
                  )
                  .when(Boolean(p.httpCode), (el) =>
                    el.child(
                      div()
                        .flex_none()
                        .px(6)
                        .py(1)
                        .rounded(4)
                        .bg(t.raised)
                        .border_1()
                        .border_color(t.border)
                        .text_size(10.5)
                        .font_family(mono)
                        .text_color(t.muted)
                        .child(String(p.httpCode)),
                    ),
                  )
                  .when(p.durationMs !== null && p.durationMs !== undefined, (el) =>
                    el.child(
                      div()
                        .flex_none()
                        .text_size(11)
                        .text_color(t.dim)
                        .child(formatDuration(p.durationMs)),
                    ),
                  ),
              )
              .when(Boolean(p.summary), (el) =>
                el.child(div().truncate().text_size(12).text_color(t.muted).child(String(p.summary))),
              ),
          )
          .child(
            h_flex()
              .id("zoom-close-btn")
              .h(28)
              .px(10)
              .gap(6)
              .flex_none()
              .items_center()
              .rounded(6)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .text_size(12)
              .text_color(t.foreground)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .on_click(() => this.closeZoomModal())
              .child(svg("mods/mesh-test/icons/close.svg").size(12).flex_none().text_color(t.muted))
              .child("Close"),
          ),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .w_full()
          .p(14)
          .gap(10)
          .bg(t.background)
          .child(
            v_flex()
              .flex_1()
              .min_h(0)
              .w_full()
              .items_center()
              .justify_center()
              .overflow_hidden()
              .rounded(8)
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .p(8)
              .when(verified === true, (el) =>
                el.child(image(activeImg).flex_1().min_h(0).w_full()),
              )
              .when(verified === false, (el) =>
                el.child(
                  v_flex()
                    .gap(6)
                    .items_center()
                    .child(svg("mods/mesh-test/icons/camera.svg").size(22).text_color(t.dim))
                    .child(div().text_size(12.5).text_color(t.muted).child("Screenshot file is not present on disk."))
                    .child(div().font_family(mono).text_size(11).text_color(t.dim).child(activeImg)),
                ),
              )
              .when(verified === undefined, (el) =>
                el.child(div().text_size(12).text_color(t.dim).child("Loading screenshot…")),
              ),
          )
          .when(this.zoomImages.length > 1, (el) =>
            el.child(
              h_flex()
                .flex_none()
                .gap(6)
                .items_center()
                .overflow_x_scrollbar()
                .children(
                  this.zoomImages.map((imgPath, idx) => {
                    const isCur = imgPath === activeImg;
                    return h_flex()
                      .id(`zoom-pick-${idx}`)
                      .h(26)
                      .px(8)
                      .flex_none()
                      .items_center()
                      .rounded(5)
                      .border_1()
                      .border_color(isCur ? t.accent : t.border)
                      .bg(isCur ? t.selected : t.raised)
                      .text_size(11)
                      .text_color(isCur ? t.foreground : t.muted)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover))
                      .on_click((_e, cx) => this.selectZoomImage(imgPath, cx))
                      .child(pathBasename(imgPath) || `Shot ${idx + 1}`);
                  }),
                ),
            ),
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .h(30)
          .px(16)
          .gap(10)
          .items_center()
          .justify_between()
          .border_t(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(11).text_color(t.dim).child(activeImg))
          .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc to close")),
      );
  }

  renderCaseRow(testCase, index, screenshotsDir, mono, t) {
    const status = normalizeCaseStatus(testCase?.status);
    const kind = String(testCase?.kind || "curl").toLowerCase() === "e2e" ? "e2e" : "curl";
    const caseKey = testCase?.id || String(index);
    const isRunningLocal = this.runningCases.has(caseKey);
    const effectiveStatus = isRunningLocal ? "running" : status;

    const passColor = t.ansi2 || t.done || t.accent;
    const failColor = t.ansi1 || t.blocked || t.accent;
    const runColor = t.working || t.accent;
    const statusColor = effectiveStatus === "passed"
      ? passColor
      : effectiveStatus === "failed"
        ? failColor
        : effectiveStatus === "running"
          ? runColor
          : t.dim;

    const shots = collectCaseScreenshots(testCase, screenshotsDir);
    const verifiedShots = shots.filter((s) => this.verifiedImages.get(s.absPath) === true);
    const missingShots = shots.filter((s) => this.verifiedImages.get(s.absPath) !== true);
    const verifiedPaths = verifiedShots.map((s) => s.absPath);
    const hasCurlTarget = kind === "curl" && Boolean(testCase?.command || testCase?.url);
    const endpointText = testCase?.command || (testCase?.url ? `${String(testCase?.method || "GET").toUpperCase()} ${testCase.url}` : "");

    return v_flex()
      .id(`test-case-${caseKey}-${index}`)
      .w_full()
      .flex_none()
      .p(10)
      .gap(6)
      .rounded(8)
      .border_1()
      .border_color(effectiveStatus === "failed" ? withAlpha(failColor, "55", t.border) : t.border)
      .bg(t.raised)
      .child(
        h_flex()
          .w_full()
          .gap(6)
          .items_center()
          .child(
            h_flex()
              .flex_none()
              .h(20)
              .px(6)
              .gap(4)
              .items_center()
              .rounded(4)
              .bg(withAlpha(statusColor, "20", t.background))
              .border_1()
              .border_color(withAlpha(statusColor, "48", t.border))
              .text_size(10)
              .font_semibold()
              .text_color(statusColor)
              .when(effectiveStatus === "running", (el) =>
                el.child(svg("mods/mesh-test/icons/spinner.svg").size(10).flex_none().text_color(statusColor).spin(900)),
              )
              .when(effectiveStatus === "passed", (el) =>
                el.child(svg("mods/mesh-test/icons/check.svg").size(10).flex_none().text_color(statusColor)),
              )
              .when(effectiveStatus === "failed", (el) =>
                el.child(svg("mods/mesh-test/icons/x.svg").size(10).flex_none().text_color(statusColor)),
              )
              .when(effectiveStatus === "pending", (el) =>
                el.child(div().size(5).rounded_full().flex_none().bg(t.dim)),
              )
              .child(effectiveStatus.toUpperCase()),
          )
          .child(
            h_flex()
              .flex_none()
              .h(20)
              .px(5)
              .gap(4)
              .items_center()
              .rounded(4)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .text_size(10)
              .font_medium()
              .text_color(kind === "e2e" ? t.accent : t.muted)
              .child(
                svg(`mods/mesh-test/icons/${kind === "e2e" ? "globe" : "terminal"}.svg`)
                  .size(10)
                  .flex_none()
                  .text_color(kind === "e2e" ? t.accent : t.muted),
              )
              .child(kind.toUpperCase()),
          )
          .when(Boolean(testCase?.serviceId), (el) =>
            el.child(
              div()
                .max_w(110)
                .truncate()
                .px(5)
                .py(1)
                .rounded(4)
                .bg(t.background)
                .text_size(10)
                .text_color(t.muted)
                .child(String(testCase.serviceId)),
            ),
          )
          .child(div().flex_1().min_w(0))
          .when(testCase?.httpCode !== null && testCase?.httpCode !== undefined && testCase?.httpCode !== "", (el) => {
            const codeNum = Number(testCase.httpCode);
            const codeColor = codeNum >= 200 && codeNum < 400
              ? passColor
              : codeNum >= 400
                ? failColor
                : t.muted;
            return el.child(
              div()
                .flex_none()
                .px(5)
                .py(1)
                .rounded(4)
                .bg(withAlpha(codeColor, "18", t.background))
                .font_family(mono)
                .text_size(10)
                .font_medium()
                .text_color(codeColor)
                .child(String(testCase.httpCode)),
            );
          })
          .when(testCase?.durationMs !== null && testCase?.durationMs !== undefined, (el) =>
            el.child(
              div()
                .flex_none()
                .text_size(10.5)
                .text_color(t.dim)
                .child(formatDuration(testCase.durationMs)),
            ),
          )
          .when(hasCurlTarget, (el) =>
            el.child(
              h_flex()
                .id(`run-curl-${caseKey}-${index}`)
                .flex_none()
                .h(22)
                .px(7)
                .gap(4)
                .items_center()
                .rounded(5)
                .border_1()
                .border_color(t.border)
                .bg(isRunningLocal ? t.selected : t.background)
                .text_size(10.5)
                .font_medium()
                .text_color(isRunningLocal ? t.dim : t.foreground)
                .when(!isRunningLocal, (btn) =>
                  btn
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .tooltip("Execute this curl check and update test plan")
                    .on_click((_e, cx) => this.runCurlCase(testCase, index, cx)),
                )
                .child(svg("mods/mesh-test/icons/play.svg").size(9).flex_none().text_color(isRunningLocal ? t.dim : t.accent))
                .child(isRunningLocal ? "Running" : "Run"),
            ),
          ),
      )
      .child(
        div()
          .w_full()
          .text_size(12.5)
          .font_medium()
          .text_color(t.foreground)
          .child(testCase?.name || caseKey),
      )
      .when(Boolean(endpointText), (el) =>
        el.child(
          div()
            .w_full()
            .px(7)
            .py(4)
            .rounded(5)
            .bg(t.background)
            .font_family(mono)
            .text_size(10.5)
            .text_color(t.muted)
            .truncate()
            .tooltip(endpointText)
            .child(endpointText),
        ),
      )
      .when(Boolean(testCase?.summary), (el) =>
        el.child(
          div()
            .w_full()
            .text_size(11.5)
            .text_color(t.muted)
            .child(String(testCase.summary)),
        ),
      )
      .when(Boolean(testCase?.error), (el) =>
        el.child(
          div()
            .w_full()
            .p(6)
            .rounded(5)
            .border_1()
            .border_color(withAlpha(failColor, "44", t.border))
            .bg(withAlpha(failColor, "14", t.background))
            .text_size(11)
            .text_color(failColor)
            .child(String(testCase.error)),
        ),
      )
      .when(verifiedShots.length > 0, (el) =>
        el.child(
          h_flex()
            .w_full()
            .gap(8)
            .flex_wrap()
            .pt(2)
            .children(
              verifiedShots.map((shot, shotIdx) =>
                v_flex()
                  .id(`shot-${caseKey}-${index}-${shotIdx}`)
                  .flex_none()
                  .w(168)
                  .rounded(6)
                  .overflow_hidden()
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .cursor_pointer()
                  .hover((s) => s.border_color(t.accent))
                  .tooltip(`Open zoom viewer: ${shot.absPath}`)
                  .on_click(() => this.openScreenshotZoom(shot.absPath, testCase, verifiedPaths))
                  .child(
                    div()
                      .w_full()
                      .h(96)
                      .overflow_hidden()
                      .bg(t.chrome)
                      .child(image(shot.absPath).size_full()),
                  )
                  .child(
                    h_flex()
                      .h(20)
                      .px(6)
                      .gap(4)
                      .items_center()
                      .border_t(1)
                      .border_color(t.border)
                      .child(svg("mods/mesh-test/icons/camera.svg").size(10).flex_none().text_color(t.muted))
                      .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.muted).child(shot.name)),
                  ),
              ),
            ),
        ),
      )
      .when(missingShots.length > 0 && verifiedShots.length === 0, (el) =>
        el.child(
          h_flex()
            .gap(5)
            .items_center()
            .pt(2)
            .text_size(10.5)
            .text_color(t.dim)
            .child(svg("mods/mesh-test/icons/camera.svg").size(11).flex_none().text_color(t.dim))
            .child(`Pending screenshot: ${missingShots.map((s) => s.name).join(", ")}`),
        ),
      );
  }

  render(cx) {
    const p = props() || {};
    if (this.isZoomModal || p.zoomImage) {
      return this.renderZoomModal(cx);
    }

    const t = theme();
    const mono = settings()?.font_family ?? "JetBrains Mono";
    const ctx = resolveActiveContext();
    const nextKey = JSON.stringify({
      spaceId: ctx.spaceId,
      tabId: ctx.tabId,
      workspaceRoot: ctx.workspaceRoot,
      on: ctx.on,
    });

    const visible = isTestPanelVisible();
    const paths = ctx.workspaceRoot && ctx.tabId ? getStoragePaths(ctx.workspaceRoot, ctx.tabId) : null;

    if (nextKey !== this.activeKey) {
      this.activeKey = nextKey;
      this.plan = null;
      this.planRaw = null;
      this.planSourcePath = null;
      this.planError = null;
      this.note = null;
      this.verifiedImages.clear();
      this.runningCases.clear();
      this.lastAlertSig = null;

      if (paths) {
        this.startPlansWatcher(paths.plansDir, cx);
        this.loadPlan(cx, { silent: true });
      }
      if (visible) {
        this.probePorts(cx, { force: true });
      }
    } else if (paths && this.watchedPlansDir !== paths.plansDir) {
      this.startPlansWatcher(paths.plansDir, cx);
    }

    if (visible && !this.wasVisible) {
      this.wasVisible = true;
      if (paths) this.loadPlan(cx, { silent: true });
      this.probePorts(cx, { force: false });
      this.ensurePollTimer(cx);
    } else if (visible) {
      this.ensurePollTimer(cx);
    } else if (!visible && this.wasVisible) {
      this.wasVisible = false;
      if (this.pollTask) {
        this.pollTask.cancel();
        this.pollTask = null;
      }
    }

    const activeAgent = ctx.tabId ? findActiveAgent(ctx.tabId) : null;
    const browserMode = ctx.workspaceRoot
      ? readBrowserMode(ctx.workspaceRoot, this.localBrowserMode)
      : this.localBrowserMode;
    const workspaceServices = getWorkspaceServices(ctx.workspaceRoot);

    const servicesList = this.plan?.servicesToStart?.length > 0
      ? this.plan.servicesToStart.map((s, idx) => ({
          key: s.serviceId || s.name || String(idx),
          serviceId: s.serviceId || "",
          name: s.name || s.serviceId || `Service ${idx + 1}`,
          cwd: resolveServiceCwd(s, workspaceServices, ctx.workspaceRoot),
          command: s.command || "",
          port: Number(s.port) || extractPortFromUrl(s.healthUrl) || null,
        }))
      : workspaceServices.map((s, idx) => ({
          key: s.id || s.root || String(idx),
          serviceId: s.id || "",
          name: s.name || pathBasename(s.root) || `Service ${idx + 1}`,
          cwd: s.root || ctx.workspaceRoot,
          command: "",
          port: Number(s.port) || null,
        }));

    const cases = Array.isArray(this.plan?.cases) ? this.plan.cases : [];
    const metrics = this.plan ? computePlanMetrics(this.plan) : null;
    const failedCount = metrics?.failed || 0;
    const canApprove = Boolean(this.plan && !this.plan.approved);
    const hasContext = Boolean(ctx.workspaceRoot && ctx.tabId);

    const passColor = t.ansi2 || t.done || t.accent;
    const failColor = t.ansi1 || t.blocked || t.accent;
    const runColor = t.working || t.accent;
    const warnColor = t.blocked || t.working || t.accent;

    return v_flex()
      .id("mesh-test")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      // Header
      .child(
        v_flex()
          .flex_none()
          .px(12)
          .py(9)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .w_full()
              .gap(8)
              .items_center()
              .child(div().font_semibold().text_size(13).child("Tests"))
              .when(Boolean(this.plan), (el) =>
                el.child(
                  div()
                    .flex_none()
                    .px(6)
                    .py(1)
                    .rounded(4)
                    .border_1()
                    .border_color(
                      this.plan.approved
                        ? withAlpha(passColor, "55", t.border)
                        : withAlpha(warnColor, "55", t.border),
                    )
                    .bg(
                      this.plan.approved
                        ? withAlpha(passColor, "1c", t.raised)
                        : withAlpha(warnColor, "1c", t.raised),
                    )
                    .text_size(10)
                    .font_medium()
                    .text_color(this.plan.approved ? passColor : warnColor)
                    .child(this.plan.approved ? "Approved" : "Pending Approval"),
                ),
              )
              .child(div().flex_1().min_w(0))
              // [Headless | Headed] browser mode toggle
              .child(
                h_flex()
                  .id("browser-mode-toggle")
                  .flex_none()
                  .h(24)
                  .p(2)
                  .gap(2)
                  .items_center()
                  .rounded(6)
                  .bg(t.raised)
                  .border_1()
                  .border_color(t.border)
                  .children(
                    ["headless", "headed"].map((mode) => {
                      const active = browserMode === mode;
                      return h_flex()
                        .id(`browser-mode-${mode}`)
                        .h(18)
                        .px(7)
                        .items_center()
                        .rounded(4)
                        .text_size(10.5)
                        .font_medium()
                        .bg(active ? t.selected : t.raised)
                        .text_color(active ? t.foreground : t.dim)
                        .cursor_pointer()
                        .hover((s) => s.text_color(t.foreground))
                        .on_click((_e, cx) => this.toggleBrowserMode(mode, cx))
                        .child(mode === "headless" ? "Headless" : "Headed");
                    }),
                  ),
              )
              .child(
                h_flex()
                  .id("mesh-test-refresh")
                  .size(24)
                  .flex_none()
                  .items_center()
                  .justify_center()
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.raised)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip("Reload test plan and probe ports")
                  .on_click((_e, cx) => {
                    this.loadPlan(cx, { silent: false });
                    this.probePorts(cx, { force: true });
                  })
                  .child(svg("mods/mesh-test/icons/refresh.svg").size(12).text_color(t.muted)),
              ),
          )
          .when(Boolean(this.plan) || Boolean(activeAgent), (el) =>
            el.child(
              h_flex()
                .w_full()
                .gap(8)
                .items_center()
                .justify_between()
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11.5)
                    .text_color(t.muted)
                    .child(
                      metrics
                        ? `${metrics.passed} passed · ${metrics.failed} failed · ${metrics.running} running / ${metrics.total}`
                        : "No test plan loaded",
                    ),
                )
                .child(
                  h_flex()
                    .flex_none()
                    .max_w(160)
                    .gap(4)
                    .items_center()
                    .text_size(10.5)
                    .text_color(activeAgent ? t.muted : t.dim)
                    .child(svg("mods/mesh-test/icons/bot.svg").size(11).flex_none().text_color(activeAgent ? t.muted : t.dim))
                    .child(
                      div()
                        .min_w(0)
                        .truncate()
                        .child(activeAgent ? (activeAgent.name || activeAgent.address) : "No agent"),
                    ),
                ),
            ),
          ),
      )
      // Action Toolbar
      .child(
        h_flex()
          .flex_none()
          .px(10)
          .py(8)
          .gap(6)
          .flex_wrap()
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .bg(t.raised)
          .child(
            h_flex()
              .id("ask-agent-plan-btn")
              .h(28)
              .px(10)
              .gap(6)
              .items_center()
              .rounded(6)
              .bg(hasContext && !this.askingAgent ? t.solid : t.background)
              .border_1()
              .border_color(hasContext && !this.askingAgent ? t.solid : t.border)
              .text_size(11.5)
              .font_medium()
              .text_color(hasContext && !this.askingAgent ? t.solid_foreground : t.dim)
              .when(hasContext && !this.askingAgent, (btn) =>
                btn
                  .cursor_pointer()
                  .on_click((_e, cx) => this.askAgentForTestPlan(cx)),
              )
              .child(
                svg("mods/mesh-test/icons/bot.svg")
                  .size(12)
                  .flex_none()
                  .text_color(hasContext && !this.askingAgent ? t.solid_foreground : t.dim),
              )
              .child(this.askingAgent ? "Asking Agent…" : "Ask Agent for Test Plan"),
          )
          .when(canApprove, (el) =>
            el.child(
              h_flex()
                .id("approve-plan-btn")
                .h(28)
                .px(10)
                .gap(5)
                .items_center()
                .rounded(6)
                .bg(withAlpha(passColor, "24", t.selected))
                .border_1()
                .border_color(withAlpha(passColor, "66", t.accent))
                .text_size(11.5)
                .font_semibold()
                .text_color(passColor)
                .when(!this.approving, (btn) =>
                  btn
                    .cursor_pointer()
                    .hover((s) => s.bg(withAlpha(passColor, "36", t.hover)))
                    .on_click((_e, cx) => this.approvePlan(cx)),
                )
                .child(svg("mods/mesh-test/icons/check.svg").size(12).flex_none().text_color(passColor))
                .child(this.approving ? "Approving…" : "Approve Plan"),
            ),
          )
          .when(failedCount > 0, (el) =>
            el.child(
              h_flex()
                .id("send-failures-btn")
                .h(28)
                .px(10)
                .gap(5)
                .items_center()
                .rounded(6)
                .bg(withAlpha(failColor, "20", t.selected))
                .border_1()
                .border_color(withAlpha(failColor, "66", t.border))
                .text_size(11.5)
                .font_medium()
                .text_color(failColor)
                .when(!this.sendingFailures, (btn) =>
                  btn
                    .cursor_pointer()
                    .hover((s) => s.bg(withAlpha(failColor, "32", t.hover)))
                    .on_click((_e, cx) => this.sendFailuresToAgent(cx)),
                )
                .child(svg("mods/mesh-test/icons/send.svg").size(11).flex_none().text_color(failColor))
                .child(this.sendingFailures ? "Sending…" : `Send Failures to Agent (${failedCount})`),
            ),
          )
          .child(
            h_flex()
              .id("scan-curls-btn")
              .h(28)
              .px(9)
              .gap(5)
              .items_center()
              .rounded(6)
              .bg(t.background)
              .border_1()
              .border_color(t.border)
              .text_size(11)
              .text_color(hasContext && !this.scanningCurls ? t.muted : t.dim)
              .tooltip("Scan recent curl commands from active terminal scrollback")
              .when(hasContext && !this.scanningCurls, (btn) =>
                btn
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.scanTerminalCurls(cx)),
              )
              .child(svg("mods/mesh-test/icons/terminal.svg").size(11).flex_none().text_color(t.muted))
              .child(this.scanningCurls ? "Scanning…" : "Scan Terminal Curls"),
          ),
      )
      // Status / Error Banner
      .when(Boolean(this.note || this.planError), (el) =>
        el.child(
          h_flex()
            .flex_none()
            .px(12)
            .py(7)
            .gap(8)
            .items_center()
            .justify_between()
            .border_b(1)
            .border_color(t.border)
            .bg(withAlpha(failColor, "14", t.raised))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .text_size(11.5)
                .text_color(this.planError ? failColor : t.foreground)
                .child(this.planError || this.note),
            )
            .when(Boolean(this.note), (b) =>
              b.child(
                div()
                  .id("dismiss-note-btn")
                  .p(3)
                  .rounded(4)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    this.note = null;
                    cx.notify();
                  })
                  .child(svg("mods/mesh-test/icons/close.svg").size(10).text_color(t.dim)),
              ),
            ),
        ),
      )
      // Scrollable Body: Local Services + Cases List
      .child(
        v_flex()
          .id("mesh-test-body")
          .flex_1()
          .min_h(0)
          .w_full()
          .p(10)
          .gap(12)
          .overflow_y_scrollbar()
          .track_scroll(this.bodyScroll)
          // Local Services & TCP Port Probing Section
          .when(servicesList.length > 0, (body) =>
            body.child(
              v_flex()
                .w_full()
                .flex_none()
                .gap(6)
                .child(
                  h_flex()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("LOCAL SERVICES & PORTS"))
                    .child(div().text_size(10).text_color(t.dim).child("ss -tln")),
                )
                .children(
                  servicesList.map((svc, idx) => {
                    const portUp = svc.port ? this.listeningPorts.has(svc.port) : false;
                    const spawning = this.spawningRunnerKey === svc.key;
                    const subText = svc.command || svc.cwd;
                    return h_flex()
                      .id(`svc-runner-row-${svc.key}-${idx}`)
                      .w_full()
                      .min_h(36)
                      .px(9)
                      .py(6)
                      .gap(8)
                      .items_center()
                      .rounded(7)
                      .border_1()
                      .border_color(t.border)
                      .bg(t.raised)
                      .child(
                        div()
                          .size(7)
                          .flex_none()
                          .rounded_full()
                          .bg(svc.port ? (portUp ? passColor : t.dim) : t.muted),
                      )
                      .child(
                        v_flex()
                          .flex_1()
                          .min_w(0)
                          .gap(1)
                          .child(div().truncate().text_size(12).font_medium().text_color(t.foreground).child(svc.name))
                          .when(Boolean(subText), (sub) =>
                            sub.child(
                              div()
                                .truncate()
                                .font_family(mono)
                                .text_size(10)
                                .text_color(t.dim)
                                .tooltip(subText)
                                .child(subText),
                            ),
                          ),
                      )
                      .when(Boolean(svc.port), (el) =>
                        el.child(
                          div()
                            .flex_none()
                            .px(6)
                            .py(2)
                            .rounded(4)
                            .border_1()
                            .border_color(portUp ? withAlpha(passColor, "55", t.border) : t.border)
                            .bg(portUp ? withAlpha(passColor, "18", t.background) : t.background)
                            .font_family(mono)
                            .text_size(10)
                            .font_medium()
                            .text_color(portUp ? passColor : t.dim)
                            .child(`${portUp ? "UP" : "DOWN"} :${svc.port}`),
                        ),
                      )
                      .child(
                        h_flex()
                          .id(`add-runner-btn-${svc.key}-${idx}`)
                          .flex_none()
                          .h(24)
                          .px(8)
                          .gap(4)
                          .items_center()
                          .rounded(5)
                          .border_1()
                          .border_color(t.border)
                          .bg(spawning ? t.selected : t.background)
                          .text_size(10.5)
                          .font_medium()
                          .text_color(spawning ? t.dim : t.foreground)
                          .when(!spawning && Boolean(ctx.tabId), (btn) =>
                            btn
                              .cursor_pointer()
                              .hover((s) => s.bg(t.hover))
                              .tooltip(
                                svc.command
                                  ? `Open split runner: ${svc.command}`
                                  : `Open split shell in ${svc.cwd || "workspace"}`,
                              )
                              .on_click((_e, cx) => this.spawnServiceRunner(svc, svc.key, cx)),
                          )
                          .child(svg("mods/mesh-test/icons/terminal.svg").size(10).flex_none().text_color(t.muted))
                          .child(spawning ? "Opening…" : "+ Runner"),
                      );
                  }),
                ),
            ),
          )
          // Test Cases Section
          .child(
            v_flex()
              .w_full()
              .flex_none()
              .gap(8)
              .child(
                h_flex()
                  .w_full()
                  .items_center()
                  .justify_between()
                  .child(
                    div()
                      .text_size(10.5)
                      .font_semibold()
                      .text_color(t.dim)
                      .child(this.plan?.title ? `TEST CASES · ${this.plan.title}` : "TEST CASES"),
                  )
                  .when(Boolean(metrics && metrics.total > 0), (el) =>
                    el.child(
                      div()
                        .text_size(10.5)
                        .font_medium()
                        .text_color(
                          metrics.running > 0
                            ? runColor
                            : metrics.failed > 0
                              ? failColor
                              : metrics.passed === metrics.total
                                ? passColor
                                : t.dim,
                        )
                        .child(`${metrics.passed}/${metrics.total} passed`),
                    ),
                  ),
              )
              .when(!this.plan, (el) =>
                el.child(
                  v_flex()
                    .w_full()
                    .p(14)
                    .gap(6)
                    .rounded(8)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.raised)
                    .child(
                      div()
                        .text_size(12.5)
                        .font_medium()
                        .text_color(t.foreground)
                        .child(hasContext ? "No test plan yet for this tab." : "No active workspace tab."),
                    )
                    .when(hasContext, (sub) =>
                      sub
                        .child(
                          div()
                            .text_size(11.5)
                            .text_color(t.muted)
                            .child('Click "Ask Agent for Test Plan" to generate curl & Playwright E2E tests under appHome without polluting your repositories, or use "Scan Terminal Curls" to import ad-hoc curls.'),
                        )
                        .when(Boolean(paths), (pEl) =>
                          pEl.child(
                            div()
                              .pt(2)
                              .font_family(mono)
                              .text_size(10)
                              .text_color(t.dim)
                              .truncate()
                              .child(paths.planPath),
                          ),
                        ),
                    ),
                ),
              )
              .when(Boolean(this.plan) && cases.length === 0, (el) =>
                el.child(
                  div()
                    .w_full()
                    .p(12)
                    .rounded(8)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.raised)
                    .text_size(12)
                    .text_color(t.muted)
                    .child("Test plan loaded with 0 test cases."),
                ),
              )
              .when(cases.length > 0, (el) =>
                el.children(
                  cases.map((c, idx) => this.renderCaseRow(c, idx, paths?.screenshotsDir || "", mono, t)),
                ),
              ),
          ),
      )
      // Footer: Zero-pollution storage path & live watcher status
      .child(
        h_flex()
          .flex_none()
          .h(24)
          .px(10)
          .gap(6)
          .items_center()
          .justify_between()
          .border_t(1)
          .border_color(t.border)
          .bg(t.chrome)
          .child(
            h_flex()
              .flex_1()
              .min_w(0)
              .gap(5)
              .items_center()
              .child(
                div()
                  .size(6)
                  .flex_none()
                  .rounded_full()
                  .bg(this.watchedPlansDir ? passColor : t.dim),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .font_family(mono)
                  .text_size(10)
                  .text_color(t.dim)
                  .tooltip(this.planSourcePath || paths?.planPath || "")
                  .child(
                    this.planSourcePath
                      ? this.planSourcePath
                      : paths
                        ? `${paths.hash}/test-plans/${paths.safeTab}.json`
                        : "Inactive",
                  ),
              ),
          )
          .child(
            div()
              .flex_none()
              .text_size(10)
              .text_color(t.dim)
              .child(visible ? "Live" : "Paused"),
          ),
      );
  }
}
