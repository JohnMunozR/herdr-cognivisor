import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, ScrollHandle } from "gpui-base";
import {
  spaces, panes, terminals, agents, exec, hc, run,
  theme, notify, props, shared, setShared, openOverlay, closeOverlay, window,
} from "herdr";

const READ_GIT_FLAGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false",
];

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

const STAGES = [
  { id: "plan", short: "1. Plan" },
  { id: "build", short: "2. Build" },
  { id: "review", short: "3. Review", panel: "changes" },
  { id: "test", short: "4. Test", panel: "test" },
  { id: "pr_dev", short: "5. PR → dev", panel: "ship" },
  { id: "promote", short: "6. CI → main", panel: "ship" },
];

const GENERIC_BRANCHES = new Set([
  "HEAD", "main", "master", "dev", "develop", "development", "ci",
]);

function withAlpha(color, alphaHex) {
  if (typeof color !== "string" || !color.startsWith("#")) return color;
  const raw = color.slice(1);
  if (raw.length === 6) return `#${raw}${alphaHex}`;
  if (raw.length === 8) return `#${raw.slice(0, 6)}${alphaHex}`;
  if (raw.length === 3) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}${alphaHex}`;
  }
  return color;
}

function normalizePath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

function basename(p) {
  const norm = normalizePath(p);
  if (!norm) return "";
  return norm.split("/").filter(Boolean).pop() || norm;
}

function stripMachinePrefix(id, machine) {
  if (!machine || typeof id !== "string") return id;
  const prefix = `${machine}/`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function extractTicket(text) {
  if (!text || typeof text !== "string") return null;
  const match = JIRA_KEY_RE.exec(text);
  return match ? match[1] : null;
}

function readFlows() {
  const value = shared("cognivisor.flows");
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  setShared("cognivisor.flows", { ...flows, [tabId]: nextFlow });
  return nextFlow;
}

function resolveWorkspaceRoot(activeSpace, tabPanes) {
  const spaceFolder = activeSpace?.folder || "";
  const paneCwd = tabPanes?.find((p) => p.focused && p.cwd)?.cwd || tabPanes?.find((p) => p.cwd)?.cwd || "";
  if (spaceFolder) {
    if (!paneCwd) return spaceFolder;
    const normSpace = normalizePath(spaceFolder);
    const normPane = normalizePath(paneCwd);
    if (normPane === normSpace || normPane.startsWith(`${normSpace}/`)) {
      return spaceFolder;
    }
    return paneCwd;
  }
  const busRoot = shared("cognivisor.services")?.workspaceRoot;
  return paneCwd || busRoot || "";
}

function resolveTermStatus(term, agent) {
  const raw = agent?.status ?? (typeof term?.status === "string" ? term.status : term?.status?.state);
  if (raw === "error") return "blocked";
  return raw || "idle";
}

function resolveTabAgents(activeTab, flow) {
  if (!activeTab) {
    return { tabPanes: [], candidates: [], agentCandidates: [], cycleCandidates: [], lead: null };
  }
  const tabPanes = (panes() || []).filter((p) => p.tab === activeTab.id && p.terminal);
  const termMap = new Map((terminals() || []).map((t) => [t.address, t]));
  const agentMap = new Map((agents() || []).map((a) => [a.address, a]));

  const seen = new Set();
  const candidates = [];
  for (const pane of tabPanes) {
    if (!pane.terminal || seen.has(pane.terminal)) continue;
    const term = termMap.get(pane.terminal) || null;
    if (term?.labels?.cognivisorRunner === "true") continue;
    seen.add(pane.terminal);

    const agent = agentMap.get(pane.terminal) || null;
    const program = agent?.program || term?.program || pane.program || null;
    const isAgent = Boolean(agent || program?.agent || term?.reported);
    candidates.push({
      address: pane.terminal,
      pane: pane.pane,
      cwd: pane.cwd || term?.cwd || null,
      branch: pane.branch || null,
      title: pane.title || term?.title || "",
      name: term?.name || null,
      template: term?.template || null,
      app: agent?.app || pane.app || null,
      program,
      isAgent,
      focused: Boolean(pane.focused || agent?.focused),
      status: resolveTermStatus(term, agent),
      term,
      agent,
    });
  }

  const agentCandidates = candidates.filter((c) => c.isAgent);
  const cycleCandidates = agentCandidates.length > 0 ? agentCandidates : candidates;

  let lead = null;
  if (flow?.leadTerminal) {
    lead = candidates.find((c) => c.address === flow.leadTerminal) || null;
  }
  if (!lead) {
    lead =
      agentCandidates.find((c) => c.focused) ||
      agentCandidates[0] ||
      candidates.find((c) => c.focused) ||
      candidates[0] ||
      null;
  }

  return { tabPanes, candidates, agentCandidates, cycleCandidates, lead };
}

function readTabTestAlert(tabId) {
  if (!tabId) return null;
  const raw = shared("cognivisor.testAlert");
  if (!raw || typeof raw !== "object") return null;
  if (raw.tabId === tabId) return raw;
  const nested = raw[tabId];
  return nested && typeof nested === "object" ? nested : null;
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

function isBoilerplateLine(line) {
  const s = line.trim();
  if (!s || s.length < 3) return true;
  if (/^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬•·*=\-_~`]+$/.test(s)) return true;
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/.test(s)) return true;
  if (/^[\w.-]+@[\w.-]+[:\s]/.test(s)) return true;
  if (/^[~\/].*[$#%]\s*$/.test(s)) return true;
  if (/^(~\/|\/|[A-Za-z]:\\)\S*$/.test(s)) return true;
  if (/^\$\s+(claude|gemini|codex|opencode|pi|agy|bash|zsh|sh|fish)\b/i.test(s)) return true;
  if (/^(claude code|welcome to|antigravity|opencode|gemini cli|codex|type \/help|press enter|shift\+tab|ctrl\+|model:|context:|tokens:|cost:|working directory|tips:|version \d)/i.test(s)) {
    return true;
  }
  return false;
}

function parsePromptFromScreen(screenText) {
  const lines = stripAnsi(screenText).split("\n");
  const promptMarkerRe = /^(?:[>❯›»]+|(?:you|user|prompt)\s*:)\s*(.+)$/i;

  for (const line of lines) {
    const match = promptMarkerRe.exec(line.trim());
    if (!match) continue;
    const candidate = match[1].trim();
    if (!candidate || candidate.startsWith("/") || isBoilerplateLine(candidate)) continue;
    if (candidate.length >= 4) return candidate;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (isBoilerplateLine(trimmed) || trimmed.startsWith("/")) continue;
    if (trimmed.length >= 8 && /[A-Za-z]/.test(trimmed)) return trimmed;
  }

  return "";
}

function capWords(text, maxLen = 34) {
  const clean = text.trim();
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 12 ? slice.slice(0, lastSpace) : slice).trim();
}

function summarizePrompt(rawText, ticket) {
  if (!rawText || typeof rawText !== "string") return "";
  let s = stripAnsi(rawText)
    .split("\n")[0]
    .trim()
    .replace(/^(?:[>❯›»$#]+|(?:you|user|prompt)\s*:)\s*/i, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~#>]+/g, " ");

  if (ticket) {
    const escTicket = ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`\\b${escTicket}\\b\\s*[:\\-–—]?`, "gi"), " ");
  }

  s = s.replace(/\s+/g, " ").trim();

  // Strip conversational filler lead-ins iteratively without dropping concrete action verbs like "fix" or "add".
  const fillerRe = /^(?:please|can you|could you|would you|help me|i need you to|i need to|i want you to|i want to|let's|lets|implement)\b[\s,:;-]*/i;
  let prev = null;
  while (s && s !== prev) {
    prev = s;
    s = s.replace(fillerRe, "").trim();
  }

  s = s.replace(/^[:\-–—.,;]+\s*/, "").replace(/\s+/g, " ").trim();
  if (!s) return "";

  const capped = capWords(s, 34);
  return capped ? capped[0].toUpperCase() + capped.slice(1) : "";
}

function cleanBranchSlug(branch, ticket) {
  if (!branch || GENERIC_BRANCHES.has(branch)) return "";
  let s = branch
    .replace(/^(?:feat|feature|fix|bugfix|hotfix|chore|refactor|docs|test|ci|release)\//i, "")
    .trim();
  if (ticket) {
    const escTicket = ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    s = s.replace(new RegExp(`\\b${escTicket}\\b[-_\\s]*`, "gi"), "");
  }
  s = s.replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const capped = capWords(s, 34);
  return capped ? capped[0].toUpperCase() + capped.slice(1) : "";
}

function isTellingTitle(title, program) {
  const cleaned = String(title || "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();
  if (!cleaned) return false;
  if (/^[~/]|^[A-Za-z]:\\/.test(cleaned)) return false;
  if (/^[\w.-]+@[\w.-]+/.test(cleaned) || cleaned.includes("@")) return false;
  const lower = cleaned.toLowerCase();
  if (lower === "terminal" || lower === "bash" || lower === "zsh" || lower === "sh" || lower === "fish") {
    return false;
  }
  if (program?.name && lower === program.name.toLowerCase()) return false;
  if (program?.key && lower === program.key.toLowerCase()) return false;
  return true;
}

async function readGitBranch(dir, on) {
  if (!dir) return null;
  const res = await exec("git", [...READ_GIT_FLAGS, "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    on,
    timeout: 4000,
  }).catch(() => null);
  if (!res || res.code !== 0) return null;
  const branch = (res.stdout || "").trim();
  return branch && branch !== "HEAD" ? branch : null;
}

async function discoverRepos(workspaceRoot, on, isWindows = false) {
  if (!workspaceRoot) return [];
  let discovered = [];

  if (!on && isWindows) {
    const escaped = workspaceRoot.replace(/'/g, "''");
    const psScript = `
      $root = '${escaped}';
      $res = @();
      if (Test-Path -LiteralPath (Join-Path $root '.git')) { $res += $root };
      Get-ChildItem -LiteralPath $root -Directory -Depth 2 -Force -ErrorAction SilentlyContinue | Where-Object {
        $_.FullName -notmatch '[\\\\/](node_modules|target|dist|build|\\.git|vendor|\\.venv)[\\\\/]' -and (Test-Path -LiteralPath (Join-Path $_.FullName '.git'))
      } | ForEach-Object { $res += $_.FullName };
      $res | Select-Object -Unique
    `.trim();
    const r = await exec("powershell", ["-NoProfile", "-Command", psScript], { on, timeout: 6000 }).catch(() => null);
    if (r && r.code === 0 && r.stdout) {
      discovered = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  } else {
    const script =
      'root="$1"; if [ -e "$root/.git" ]; then printf "%s\\n" "$root"; fi; for d in "$root"/* "$root"/*/*; do [ -e "$d/.git" ] || continue; case "$d" in */node_modules/*|*/target/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.venv/*) continue ;; esac; printf "%s\\n" "$d"; done';
    const r = await exec("sh", ["-c", script, "repos", workspaceRoot], { on, timeout: 6000 }).catch(() => null);
    if (r && r.code === 0 && r.stdout) {
      discovered = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  }

  let repoPaths = Array.from(new Set(discovered.map(normalizePath).filter(Boolean)));
  if (repoPaths.length === 0) {
    const top = await exec("git", [...READ_GIT_FLAGS, "rev-parse", "--show-toplevel"], {
      cwd: workspaceRoot,
      on,
      timeout: 4000,
    }).catch(() => null);
    if (top && top.code === 0 && top.stdout.trim()) {
      repoPaths = [normalizePath(top.stdout.trim())];
    }
  }

  const normWorkspace = normalizePath(workspaceRoot);
  return repoPaths.map((repoRoot) => {
    let relPath = "";
    if (repoRoot !== normWorkspace) {
      relPath = repoRoot.startsWith(`${normWorkspace}/`)
        ? repoRoot.slice(normWorkspace.length + 1)
        : basename(repoRoot);
    }
    const name = basename(repoRoot) || "root";
    const id = relPath || (repoRoot === normWorkspace ? "." : name);
    return { id, name, relPath, root: repoRoot };
  });
}

export default class CognivisorFlow extends View {
  init(_props, cx) {
    const p = props() || {};
    if (p.role === "shellMenu") {
      this.isShellMenu = true;
      this.spawning = null;
      this.menuScroll = ScrollHandle.new();
      this.discoveredServices = null;
      this.loadingServices = false;

      const busServices = shared("cognivisor.services");
      const busMatches =
        busServices &&
        Array.isArray(busServices.services) &&
        (!p.workspaceRoot || normalizePath(busServices.workspaceRoot) === normalizePath(p.workspaceRoot));

      if (!busMatches && p.workspaceRoot) {
        const isWindows = !p.on && window()?.platform === "windows";
        this.loadingServices = true;
        cx.spawn(async (cx) => {
          try {
            this.discoveredServices = await discoverRepos(p.workspaceRoot, p.on ?? null, isWindows);
          } catch {
            this.discoveredServices = [];
          } finally {
            this.loadingServices = false;
            cx.notify();
          }
        });
      }
      return;
    }

    this.isShellMenu = false;
    this.editingTitle = false;
    this.editingTabId = null;
    this.titleValue = "";
    this.autoSyncingTabId = null;
    this.stageScroll = ScrollHandle.new();

    this.titleInput = InputState.new({ placeholder: "Feature or ticket title…" });
    this.titleInput.on("change", () => {
      this.titleValue = this.titleInput.value();
    });
    this.titleInput.on("submit", (_e, cx) => this.commitInlineTitle(cx));
    this.titleInput.on("blur", (_e, cx) => this.cancelInlineTitle(cx));
  }

  close() {
    try { this.titleInput?.release(); } catch {}
    try { this.stageScroll?.release(); } catch {}
    try { this.menuScroll?.release(); } catch {}
  }

  startInlineEdit(activeTab, cx) {
    if (!activeTab) return;
    const initial = activeTab.name || "";
    this.editingTitle = true;
    this.editingTabId = activeTab.id;
    this.titleValue = initial;
    this.titleInput.set_value(initial);
    this.titleInput.set_selected_range({ start: 0, end: initial.length });
    this.titleInput.focus();
    cx.notify();
  }

  cancelInlineTitle(cx) {
    if (!this.editingTitle) return;
    this.editingTitle = false;
    this.editingTabId = null;
    cx.notify();
  }

  commitInlineTitle(cx) {
    if (!this.editingTitle) return;
    const targetTabId = this.editingTabId;
    const raw = (this.titleInput.value() ?? "").trim();
    this.editingTitle = false;
    this.editingTabId = null;

    if (targetTabId && raw) {
      run("tab.rename", { id: targetTabId, name: raw });
      const activeSpace = (spaces() || []).find((s) => s.active) || null;
      const ticket = extractTicket(raw);
      updateTabFlow(
        targetTabId,
        {
          ticket,
          manualTitle: true,
          autoNamed: false,
        },
        activeSpace?.folder || "",
      );
    }
    cx.notify();
  }

  selectStage(activeTab, activeSpace, stage, cx) {
    if (!activeTab || !stage) return;
    const patch = { stage: stage.id };
    if (stage.panel === "ship") {
      patch.shipPhase = stage.id === "promote" ? "promote" : "dev";
    }
    updateTabFlow(activeTab.id, patch, activeSpace?.folder || "");
    if (stage.panel) {
      run("layout.select", { stack: "panel-body", child: stage.panel });
      run("layout.show", { id: "panel" });
    }
    cx.notify();
  }

  cycleLeadTerminal(activeTab, activeSpace, cycleCandidates, currentLead, cx) {
    if (!activeTab || !cycleCandidates || cycleCandidates.length === 0) return;
    if (cycleCandidates.length === 1) {
      run("pane.focus", { terminal: cycleCandidates[0].address });
      return;
    }
    const idx = currentLead ? cycleCandidates.findIndex((c) => c.address === currentLead.address) : -1;
    const next = cycleCandidates[(idx + 1) % cycleCandidates.length];
    updateTabFlow(activeTab.id, { leadTerminal: next.address }, activeSpace?.folder || "");
    cx.notify();
  }

  autoDeriveTitle(activeTab, activeSpace, lead, tabPanes, cx) {
    if (!activeTab || this.autoSyncingTabId === activeTab.id) return;
    const tabId = activeTab.id;
    const spaceFolder = activeSpace?.folder || "";
    const on = activeSpace?.machine ?? null;
    const leadAddr = lead?.address || tabPanes?.[0]?.terminal || null;
    const candidateDirs = Array.from(
      new Set(
        [
          lead?.cwd,
          ...(tabPanes || []).map((p) => p.cwd),
          spaceFolder,
        ].filter(Boolean),
      ),
    );

    this.autoSyncingTabId = tabId;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        let firstMessage = "";
        let screenPrompt = "";
        let termTitle = lead?.title || "";
        let termProgram = lead?.program || null;

        if (leadAddr) {
          const getRes = await hc(["get", leadAddr, "--json"]).catch(() => null);
          if (getRes && getRes.code === 0 && getRes.stdout) {
            try {
              const info = JSON.parse(getRes.stdout);
              if (typeof info?.first_message === "string") firstMessage = info.first_message.trim();
              if (typeof info?.title === "string" && info.title.trim()) termTitle = info.title.trim();
              if (info?.cwd && !candidateDirs.includes(info.cwd)) candidateDirs.unshift(info.cwd);
            } catch {}
          }
          if (!firstMessage) {
            const readRes = await hc(["read", leadAddr, "--lines", "40"]).catch(() => null);
            if (readRes && readRes.code === 0 && readRes.stdout) {
              screenPrompt = parsePromptFromScreen(readRes.stdout);
            }
          }
        }

        let featureBranch = null;
        let fallbackBranch = null;
        for (const dir of candidateDirs) {
          const b = await readGitBranch(dir, on);
          if (!b) continue;
          if (!fallbackBranch) fallbackBranch = b;
          if (!GENERIC_BRANCHES.has(b)) {
            featureBranch = b;
            break;
          }
        }
        const branch = featureBranch || fallbackBranch;

        const tellingTitle = isTellingTitle(termTitle, termProgram)
          ? termTitle.replace(/^[^\p{L}\p{N}~/]+/u, "").trim()
          : "";

        const promptSource = firstMessage || screenPrompt;
        const ticket =
          extractTicket(promptSource) ||
          extractTicket(tellingTitle) ||
          extractTicket(branch) ||
          extractTicket(activeTab.name);

        const summary = summarizePrompt(promptSource, ticket);
        const branchSlug = cleanBranchSlug(branch, ticket);

        let derivedName = "";
        if (ticket && summary) derivedName = `${ticket} ${summary}`;
        else if (ticket && branchSlug) derivedName = `${ticket} ${branchSlug}`;
        else if (summary) derivedName = summary;
        else if (ticket) derivedName = ticket;
        else if (branchSlug) derivedName = branchSlug;
        else if (tellingTitle) derivedName = capWords(tellingTitle, 34);
        else if (branch) derivedName = branch;
        else if (lead?.program?.name) derivedName = lead.program.name;

        const stillOpen = (spaces() || []).some((s) => (s.tabs || []).some((t) => t.id === tabId));
        if (!stillOpen) return;

        if (!derivedName) {
          notify({
            title: "Auto-name skipped",
            body: "No prompt message, ticket key, or Git branch found for this tab.",
            level: "info",
          });
          return;
        }

        run("tab.rename", { id: tabId, name: derivedName });
        updateTabFlow(
          tabId,
          {
            derivedTitle: derivedName,
            ticket: ticket || extractTicket(derivedName),
            manualTitle: false,
            autoNamed: true,
          },
          spaceFolder,
        );
      } finally {
        if (this.autoSyncingTabId === tabId) this.autoSyncingTabId = null;
        cx.notify();
      }
    });
  }

  spawnServiceShell(svc, tabId, spaceId, on, overlayId, cx) {
    if (this.spawning) return;
    this.spawning = svc.root || "__root__";
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const args = ["run", "--bg", "--keep"];
        if (on) args.push("--on", on);
        if (svc.root) args.push("--cwd", svc.root);
        if (spaceId) args.push("--label", `herdr.space=${stripMachinePrefix(spaceId, on)}`);
        if (tabId) args.push("--label", `herdr.tab=${stripMachinePrefix(tabId, on)}`);
        args.push("--label", "cognivisorRunner=true");

        const res = await hc(args).catch((err) => ({ code: 1, stderr: String(err), stdout: "" }));
        if (!res || res.code !== 0) {
          notify({
            title: "Failed to open service shell",
            body: res?.stderr?.trim() || "hc run exited with an error",
            level: "error",
          });
        }
      } finally {
        this.spawning = null;
        if (overlayId) closeOverlay(overlayId);
        else cx.notify();
      }
    });
  }

  renderShellMenu(cx) {
    const t = theme();
    const p = props() || {};
    const allSpaces = spaces() || [];
    const space = allSpaces.find((s) => s.id === p.spaceId) || allSpaces.find((s) => s.active) || null;
    const tab = space?.tabs?.find((tb) => tb.id === p.tabId) || space?.tabs?.find((tb) => tb.active) || null;
    const tabId = tab?.id || p.tabId || null;
    const spaceId = space?.id || p.spaceId || null;
    const on = p.on !== undefined ? p.on : (space?.machine ?? null);

    const busServices = shared("cognivisor.services");
    const workspaceRoot = p.workspaceRoot || space?.folder || busServices?.workspaceRoot || "";
    const normRoot = normalizePath(workspaceRoot);

    let services = [];
    if (
      busServices &&
      Array.isArray(busServices.services) &&
      (!normRoot || normalizePath(busServices.workspaceRoot) === normRoot)
    ) {
      services = busServices.services;
    } else if (Array.isArray(this.discoveredServices)) {
      services = this.discoveredServices;
    }

    const entries = [];
    const seenRoots = new Set();
    if (workspaceRoot) {
      seenRoots.add(normRoot);
      entries.push({
        key: "__workspace_root__",
        name: "Workspace Root",
        sub: basename(workspaceRoot) || workspaceRoot,
        root: workspaceRoot,
        isRoot: true,
      });
    }
    for (const svc of services) {
      if (!svc?.root) continue;
      const normSvcRoot = normalizePath(svc.root);
      if (normRoot && normSvcRoot === normRoot && entries.length > 0) {
        entries[0].sub = svc.name ? `${svc.name} (root)` : entries[0].sub;
        continue;
      }
      if (seenRoots.has(normSvcRoot)) continue;
      seenRoots.add(normSvcRoot);
      entries.push({
        key: svc.id || svc.root,
        name: svc.name || basename(svc.root),
        sub: svc.relPath || basename(svc.root),
        root: svc.root,
        isRoot: false,
      });
    }

    if (entries.length === 0) {
      entries.push({
        key: "__default_shell__",
        name: "Default Shell",
        sub: on ? `on ${on}` : "home directory",
        root: "",
        isRoot: true,
      });
    }

    return v_flex()
      .id("cognivisor-flow-shell-menu")
      .size_full()
      .min_h(0)
      .p(6)
      .gap(4)
      .bg(t.popover)
      .text_size(12)
      .child(
        h_flex()
          .h(24)
          .px(8)
          .flex_none()
          .items_center()
          .justify_between()
          .child(div().text_size(11).font_semibold().text_color(t.dim).child("Open Split Shell in Tab"))
          .child(div().text_size(10.5).text_color(t.dim).child("Esc")),
      )
      .child(
        v_flex()
          .id("cognivisor-flow-shell-list")
          .flex_1()
          .min_h(0)
          .gap(2)
          .overflow_y_scrollbar()
          .track_scroll(this.menuScroll)
          .children(
            entries.map((entry) => {
              const busy = this.spawning === (entry.root || "__root__");
              return h_flex()
                .id(`shell-svc-${entry.key}`)
                .h(36)
                .px(8)
                .gap(8)
                .flex_none()
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .bg(busy ? t.selected : t.popover)
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.spawnServiceShell(entry, tabId, spaceId, on, p.overlay, cx))
                .child(
                  svg(`mods/cognivisor-flow/icons/${entry.isRoot ? "terminal" : "layers"}.svg`)
                    .size(14)
                    .flex_none()
                    .text_color(entry.isRoot ? t.accent : t.muted),
                )
                .child(
                  v_flex()
                    .flex_1()
                    .min_w(0)
                    .gap(1)
                    .child(div().truncate().text_size(12).font_medium().text_color(t.foreground).child(entry.name))
                    .child(div().truncate().text_size(10.5).text_color(t.dim).child(busy ? "Starting shell…" : entry.sub)),
                );
            }),
          )
          .when(this.loadingServices, (el) =>
            el.child(div().px(8).py(6).text_size(11).text_color(t.dim).child("Scanning microservices…")),
          ),
      );
  }

  render(cx) {
    if (props()?.role === "shellMenu" || this.isShellMenu) {
      return this.renderShellMenu(cx);
    }

    const t = theme();
    const allSpaces = spaces() || [];
    const activeSpace = allSpaces.find((s) => s.active) || allSpaces[0] || null;
    const activeTab = activeSpace?.tabs?.find((tb) => tb.active) || activeSpace?.tabs?.[0] || null;

    if (this.editingTitle && this.editingTabId !== activeTab?.id) {
      this.editingTitle = false;
      this.editingTabId = null;
    }

    const flows = readFlows();
    const flow = activeTab
      ? flows[activeTab.id] || { tabId: activeTab.id, stage: "plan" }
      : { tabId: null, stage: "plan" };

    const activeStageId = flow.stage || "plan";
    const activeStageIdx = Math.max(0, STAGES.findIndex((s) => s.id === activeStageId));

    const { tabPanes, cycleCandidates, lead } = resolveTabAgents(activeTab, flow);
    const leadAddress = lead?.address || flow.leadTerminal || null;
    const workspaceRoot = resolveWorkspaceRoot(activeSpace, tabPanes);

    const liveSubagents = leadAddress
      ? (terminals() || []).filter((term) => term.state === "live" && term.parent === leadAddress)
      : [];
    const termMap = new Map((terminals() || []).map((term) => [term.address, term]));
    const agentMap = new Map((agents() || []).map((ag) => [ag.address, ag]));
    const subStatus = (sub) => resolveTermStatus(termMap.get(sub.address) || sub, agentMap.get(sub.address));
    const blockedSub = liveSubagents.find((sub) => subStatus(sub) === "blocked");
    const workingSub = liveSubagents.find((sub) => subStatus(sub) === "working");
    const targetSub = blockedSub || workingSub || liveSubagents[0] || null;

    const testAlert = readTabTestAlert(activeTab?.id);
    const hasFailedTests = Boolean(testAlert && (testAlert.status === "failed" || (testAlert.failed || 0) > 0));
    const hasRunningTests = Boolean(testAlert && (testAlert.status === "running" || (testAlert.running || 0) > 0));
    const showTestAlert = hasFailedTests || hasRunningTests;

    const ticket = flow.ticket || extractTicket(activeTab?.name);
    const displayTitle = activeTab?.name || "Untitled flow";
    const isAutoSyncing = Boolean(activeTab && this.autoSyncingTabId === activeTab.id);

    const leadRawName = lead ? (lead.name || lead.program?.name || lead.app || lead.address) : "";
    const leadDisplay = lead
      ? (leadRawName !== lead.address ? `${leadRawName} (${lead.address})` : lead.address)
      : "No agent";
    const leadStatusColor = lead ? (t[lead.status] || t.dim) : t.dim;

    const stop = (_e, cx) => cx.stop_propagation();

    return h_flex()
      .id("cognivisor-flow-bar")
      .size_full()
      .min_w(0)
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      // Left Zone: Ticket badge + Inline editable title + Auto re-sync
      .child(
        h_flex()
          .id("flow-identity")
          .flex_none()
          .min_w(0)
          .max_w(340)
          .gap(6)
          .items_center()
          .when(Boolean(ticket), (el) =>
            el.child(
              div()
                .id("flow-ticket")
                .h(22)
                .px(7)
                .flex()
                .flex_none()
                .items_center()
                .rounded(5)
                .bg(withAlpha(t.accent, "22"))
                .border_1()
                .border_color(withAlpha(t.accent, "55"))
                .text_size(11)
                .font_semibold()
                .text_color(t.accent)
                .child(ticket),
            ),
          )
          .when(!this.editingTitle, (el) =>
            el.child(
              h_flex()
                .id("flow-title-btn")
                .h(24)
                .px(6)
                .gap(5)
                .min_w(0)
                .max_w(190)
                .items_center()
                .rounded(5)
                .when(Boolean(activeTab), (btn) =>
                  btn
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .tooltip("Click to rename tab")
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => this.startInlineEdit(activeTab, cx)),
                )
                .child(
                  div()
                    .min_w(0)
                    .truncate()
                    .text_size(12)
                    .font_medium()
                    .text_color(activeTab ? t.foreground : t.dim)
                    .child(activeTab ? displayTitle : "No active tab"),
                )
                .when(Boolean(activeTab), (btn) =>
                  btn.child(svg("mods/cognivisor-flow/icons/pencil.svg").size(11).flex_none().text_color(t.dim)),
                ),
            ),
          )
          .when(this.editingTitle, (el) =>
            el.child(
              h_flex()
                .id("flow-title-edit")
                .w(190)
                .h(26)
                .px(6)
                .flex_none()
                .items_center()
                .rounded(5)
                .border_1()
                .border_color(t.accent)
                .bg(t.background)
                .on_mouse_down("left", stop)
                .on_key_down((e, cx) => {
                  if (e.key === "escape" || e.keystroke === "escape") {
                    cx.stop_propagation();
                    this.cancelInlineTitle(cx);
                  }
                })
                .child(Input.new(this.titleInput).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground)),
            ),
          )
          .child(
            h_flex()
              .id("flow-auto")
              .h(24)
              .px(7)
              .gap(4)
              .flex_none()
              .items_center()
              .rounded(5)
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .text_size(11)
              .font_medium()
              .text_color(isAutoSyncing ? t.accent : (activeTab ? t.muted : t.dim))
              .when(Boolean(activeTab), (btn) =>
                btn
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Auto-derive tab name from agent prompt or Git branch")
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.autoDeriveTitle(activeTab, activeSpace, lead, tabPanes, cx)),
              )
              .child(svg("mods/cognivisor-flow/icons/sparkles.svg").size(11).flex_none().text_color(isAutoSyncing ? t.accent : t.muted))
              .child(isAutoSyncing ? "Syncing…" : "Auto"),
          ),
      )
      // Center Zone: Interactive 6-Stage Stepper
      .child(
        h_flex()
          .id("flow-stages")
          .flex_1()
          .min_w(0)
          .h(28)
          .items_center()
          .gap(2)
          .overflow_x_scrollbar()
          .track_scroll(this.stageScroll)
          .children(
            STAGES.flatMap((stage, idx) => {
              const isActive = Boolean(activeTab) && idx === activeStageIdx;
              const isDone = Boolean(activeTab) && idx < activeStageIdx;
              const pill = h_flex()
                .id(`flow-stage-${stage.id}`)
                .h(24)
                .px(8)
                .gap(4)
                .flex_none()
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(isActive ? withAlpha(t.accent, "88") : isDone ? t.border : t.chrome)
                .bg(isActive ? t.selected : isDone ? t.raised : t.chrome)
                .text_size(11.5)
                .text_color(isActive ? t.accent : isDone ? t.foreground : t.muted)
                .when(isActive, (el) => el.font_semibold())
                .when(Boolean(activeTab), (el) =>
                  el
                    .cursor_pointer()
                    .hover((s) => s.bg(isActive ? t.selected : t.hover).text_color(isActive ? t.accent : t.foreground))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => this.selectStage(activeTab, activeSpace, stage, cx)),
                )
                .when(isDone, (el) =>
                  el.child(svg("mods/cognivisor-flow/icons/check.svg").size(11).flex_none().text_color(t.done || t.accent)),
                )
                .child(div().whitespace_nowrap().child(stage.short));

              if (idx === 0) return [pill];
              return [
                svg("mods/cognivisor-flow/icons/chevron-right.svg").size(11).flex_none().text_color(t.dim),
                pill,
              ];
            }),
          ),
      )
      // Right Zone: Test Alert + Live Subagents + Lead Agent + + Shell
      .child(
        h_flex()
          .id("flow-meta")
          .flex_none()
          .gap(6)
          .items_center()
          .when(showTestAlert, (el) =>
            el.child(
              h_flex()
                .id("flow-test-alert")
                .h(24)
                .px(7)
                .gap(4)
                .flex_none()
                .items_center()
                .rounded(5)
                .border_1()
                .border_color(withAlpha(hasFailedTests ? t.blocked : t.working, "66"))
                .bg(withAlpha(hasFailedTests ? t.blocked : t.working, "22"))
                .text_size(11)
                .font_medium()
                .text_color(hasFailedTests ? t.blocked : t.working)
                .cursor_pointer()
                .tooltip("Jump to 4. Test and open Test panel")
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => this.selectStage(activeTab, activeSpace, STAGES[3], cx))
                .child(
                  svg("mods/cognivisor-flow/icons/flask.svg")
                    .size(11)
                    .flex_none()
                    .text_color(hasFailedTests ? t.blocked : t.working),
                )
                .child(
                  hasFailedTests
                    ? `${testAlert.failed || 1} failed`
                    : testAlert.running > 0
                      ? `${testAlert.running} running`
                      : "Testing",
                ),
            ),
          )
          .when(liveSubagents.length > 0, (el) =>
            el.child(
              h_flex()
                .id("flow-subagents")
                .h(24)
                .px(7)
                .gap(4)
                .flex_none()
                .items_center()
                .rounded(5)
                .border_1()
                .border_color(
                  blockedSub
                    ? withAlpha(t.blocked, "66")
                    : workingSub
                      ? withAlpha(t.working, "66")
                      : t.border,
                )
                .bg(
                  blockedSub
                    ? withAlpha(t.blocked, "22")
                    : workingSub
                      ? withAlpha(t.working, "22")
                      : t.raised,
                )
                .text_size(11)
                .font_medium()
                .text_color(blockedSub ? t.blocked : workingSub ? t.working : t.muted)
                .cursor_pointer()
                .tooltip("Peek active subagent")
                .on_mouse_down("left", stop)
                .on_click(() => {
                  if (targetSub) run("terminal.peek", { terminal: targetSub.address });
                })
                .child(`${liveSubagents.length} sub`),
            ),
          )
          .child(
            h_flex()
              .id("flow-lead-agent")
              .h(24)
              .px(7)
              .gap(5)
              .max_w(190)
              .flex_none()
              .items_center()
              .rounded(5)
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .text_size(11)
              .text_color(lead ? t.foreground : t.dim)
              .when(Boolean(lead), (el) =>
                el
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip(
                    cycleCandidates.length > 1
                      ? `Lead terminal: ${lead.address} — click to cycle (${cycleCandidates.length} in tab)`
                      : `Lead terminal: ${lead.address} — click to focus`,
                  )
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.cycleLeadTerminal(activeTab, activeSpace, cycleCandidates, lead, cx)),
              )
              .child(svg("mods/cognivisor-flow/icons/bot.svg").size(11).flex_none().text_color(lead ? t.muted : t.dim))
              .when(Boolean(lead), (el) =>
                el.child(div().size(6).flex_none().rounded_full().bg(leadStatusColor)),
              )
              .child(div().min_w(0).truncate().child(`Lead: ${leadDisplay}`)),
          )
          .child(
            h_flex()
              .id("flow-add-shell")
              .h(24)
              .px(8)
              .gap(4)
              .flex_none()
              .items_center()
              .rounded(5)
              .border_1()
              .border_color(t.border)
              .bg(t.raised)
              .text_size(11)
              .font_medium()
              .text_color(activeTab ? t.foreground : t.dim)
              .when(Boolean(activeTab), (el) =>
                el
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .tooltip("Open a split service shell in the active tab")
                  .on_mouse_down("left", stop)
                  .on_click(() => {
                    openOverlay({
                      mod: "cognivisor-flow",
                      kind: "popup",
                      width: 250,
                      height: 320,
                      props: {
                        role: "shellMenu",
                        tabId: activeTab.id,
                        spaceId: activeSpace?.id || null,
                        workspaceRoot,
                        on: activeSpace?.machine ?? null,
                      },
                    });
                  }),
              )
              .child(svg("mods/cognivisor-flow/icons/terminal.svg").size(11).flex_none().text_color(activeTab ? t.muted : t.dim))
              .child("+ Shell"),
          ),
      );
  }
}
