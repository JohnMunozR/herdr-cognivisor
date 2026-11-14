// Pure helper logic for mesh-tabs: layout lookup, lead pane resolution, Jira key extraction, and prompt/branch summarization.

export const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;
export const NON_TICKET_RE = /^(UTF|ISO|SHA|MD|TLS|SSL)-\d+$/i;
export const DEFAULT_BRANCHES = new Set([
  "main", "master", "dev", "development", "develop", "ci", "staging", "production", "head",
]);

export function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function resolveSpacePanelTarget(storedPanelId, enabledPanels) {
  if (!storedPanelId || !Array.isArray(enabledPanels)) return null;
  return enabledPanels.includes(storedPanelId) ? storedPanelId : null;
}

export function classifyViewerTab(tabPanes, openFileEntry = null) {
  const list = Array.isArray(tabPanes) ? tabPanes : [];
  const isFilesTab = list.some((p) => p?.mod === "files-search") || Boolean(openFileEntry);
  const isReviewTab = list.some((p) => p?.mod === "changes-review");
  const isGitTab = list.some((p) => p?.mod === "git-history");
  const isViewerTab = isFilesTab || isReviewTab || isGitTab;
  const modIconPath = isReviewTab
    ? "mods/mesh-tabs/icons/changes.svg"
    : isGitTab
      ? "mods/mesh-tabs/icons/git.svg"
      : isFilesTab
        ? (openFileEntry?.iconPath || "mods/mesh-tabs/icons/files.svg")
        : null;
  return {
    isFilesTab,
    isReviewTab,
    isGitTab,
    isViewerTab,
    modIconPath,
    usesAccentTint: isReviewTab || isGitTab,
  };
}

export function isGenericName(name, program) {
  const s = String(name || "").trim();
  if (!s) return true;
  if (/^tb\d+$/.test(s) || /^\d+$/.test(s)) return true;
  if (s === "Terminal") return true;
  if (program?.name && s === program.name) return true;
  return false;
}

export function isGenericTab(tab, program) {
  if (!tab || tab.named) return false;
  return isGenericName(tab.name, program);
}

export function findLeadPane(tabId, allPanes, allTerminals, preferredAddress) {
  const termByAddr = new Map();
  for (const term of allTerminals || []) {
    if (term?.address) termByAddr.set(term.address, term);
  }
  const isRunner = (pane) => {
    const term = pane?.terminal ? termByAddr.get(pane.terminal) : null;
    return pane?.labels?.meshRunner === "true" || term?.labels?.meshRunner === "true";
  };

  if (preferredAddress) {
    const pinned = (allPanes || []).find(
      (p) => p.tab === tabId && p.terminal === preferredAddress && !isRunner(p),
    );
    if (pinned) return pinned;
  }

  const candidates = (allPanes || []).filter(
    (p) => p.tab === tabId && p.terminal && !isRunner(p),
  );
  return candidates.find((p) => p.program?.agent) || candidates[0] || null;
}

export function extractJiraKey(...sources) {
  for (const src of sources) {
    if (typeof src !== "string" || !src) continue;
    const match = JIRA_KEY_RE.exec(src);
    if (match && !NON_TICKET_RE.test(match[1])) {
      return match[1];
    }
  }
  return null;
}

export function isBoilerplateLine(line) {
  if (!line) return true;
  if (/^[\s─━═\-_=*~·•|+┌┐└┘├┤┬┴┼╭╮╰╯\\/<>]+$/.test(line)) return true;
  if (/^[>$%❯›#]+$/.test(line)) return true;
  if (/^[●○✦◆◇✓✔✗×•▸▹↳⚠ℹ]/.test(line)) return true;
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:[^$#%]*[$#%]\s*$/.test(line)) return true;
  if (/^[~./\\][^\s]*$/.test(line)) return true;
  if (/^\d+\s*(?:ms|s|%|tokens?)\b/i.test(line)) return true;
  if (/\b(?:ctrl\+[a-z]|shift\+tab|esc to|for shortcuts|accept edits|bypass permissions|auto-accept|context left|% left|thought for|thinking\.\.\.|welcome to|tips for getting started|claude code|gemini cli|openai codex|opencode|antigravity)\b/i.test(line)) {
    return true;
  }
  if (/^(?:claude|gemini|codex|opencode|pi|agy|antigravity|bash|zsh|fish|sh|ls|cd|pwd|clear|exit|\/help|\/clear|\/model|\/status|\/compact)$/i.test(line)) {
    return true;
  }
  if (/^try\s+["']/i.test(line) || /^(?:ask anything|type a message|send a message)\b/i.test(line)) {
    return true;
  }
  return false;
}

export function extractPromptLine(screenText) {
  if (typeof screenText !== "string" || !screenText.trim()) return "";
  const lines = screenText
    .split(/\r?\n/)
    .map((raw) => raw.replace(/^[\s│┃║|]+|[\s│┃║|]+$/g, "").trim())
    .filter(Boolean);

  // Pass 1: explicit prompt prefixes (>, ❯, ›, User:)
  for (const line of lines) {
    const m = /^(?:>|❯|›|user:)\s*(.+)$/i.exec(line);
    if (!m) continue;
    const candidate = m[1].replace(/^[>$%❯›#\s]+/, "").trim();
    if (!candidate || isBoilerplateLine(candidate)) continue;
    if (/[a-zA-Z0-9\u00C0-\u024F]{3,}/.test(candidate)) return candidate;
  }

  // Pass 2: shell command invocations with an inline quoted task (e.g. $ claude "Fix PROJ-412...")
  for (const line of lines) {
    const shellCmd = /(?:^|[$#%]\s+)(?:claude|gemini|codex|opencode|pi|agy)\s+["']([^"']{4,})["']/i.exec(line);
    if (shellCmd && !isBoilerplateLine(shellCmd[1])) {
      return shellCmd[1].trim();
    }
  }

  // Pass 3: first non-boilerplate text line
  for (const line of lines) {
    if (isBoilerplateLine(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && /[a-zA-Z\u00C0-\u024F]{3,}/.test(line)) {
      return line;
    }
  }
  return "";
}

export function trimCleanly(text, maxLen = 28) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  if (/\s/.test(clean[maxLen])) return slice.trim();
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLen * 0.5)) {
    return slice.slice(0, lastSpace).trim();
  }
  return `${clean.slice(0, maxLen - 1).trim()}…`;
}

export function summarizePrompt(rawText, ticket) {
  if (typeof rawText !== "string" || !rawText.trim()) return "";
  let text = rawText
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^(?:>|❯|›|user:)\s*/i, "")
    .replace(/[`*_~]/g, " ")
    .trim();

  if (ticket) {
    const escaped = ticket.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    text = text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }

  const fillerRe = /^(?:hola|hi|hello|hey|buenos\s+dias|buenos\s+días|buenas\s+tardes|buenas\s+noches|buenas|good\s+morning|good\s+afternoon|por\s+favor|please|pls|necesito\s+que|necesito|quiero\s+que|quiero|me\s+ayudes\s+a|ayudame\s+a|ayúdame\s+a|ayudarme\s+a|me\s+puedes\s+ayudar\s+a|puedes\s+ayudarme\s+a|puedes|podrias|podrías|can\s+you|could\s+you|would\s+you|will\s+you|help\s+me\s+to|help\s+me|i\s+need\s+you\s+to|i\s+need\s+to|i\s+need|i\s+want\s+you\s+to|i\s+want\s+to|i\s+want|let'?s|we\s+need\s+to|para\s+el\s+ticket|en\s+el\s+ticket|sobre\s+el\s+ticket|ticket)\b[\s,.:;\-–—!?]*/i;

  let prev;
  do {
    prev = text;
    text = text.replace(/^[,.:;\-–—!?\s]+/, "").replace(fillerRe, "").trim();
  } while (text !== prev && text.length > 0);

  text = text
    .replace(/[,.;:!?()[\]{}"'“”«»/\\|`~@#%^&*+=<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || !/[a-zA-Z0-9\u00C0-\u024F]{2,}/.test(text)) return "";
  const capped = trimCleanly(text, 28);
  return capped.replace(/^[a-z\u00e0-\u00f6\u00f8-\u00ff]/, (ch) => ch.toUpperCase());
}

export function cleanBranchSlug(branch, ticket) {
  if (typeof branch !== "string") return "";
  let slug = branch.trim();
  if (!slug || DEFAULT_BRANCHES.has(slug.toLowerCase())) return "";
  slug = slug.replace(/^(?:feat|feature|fix|bugfix|hotfix|chore|refactor|docs|test|tests|release)\//i, "");
  if (ticket) {
    const escaped = ticket.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    slug = slug.replace(new RegExp(`\\b${escaped}\\b`, "gi"), " ");
  }
  slug = slug
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!slug || DEFAULT_BRANCHES.has(slug.toLowerCase())) return "";
  return trimCleanly(slug, 28);
}
