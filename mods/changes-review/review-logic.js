// Pure helper logic for changes-review: diff row parsing, linear syntax lexer, path normalization, watch filtering, and session baseline helpers.
import * as fsPromises from "fs/promises";
import { join } from "path";
import {
  isMarkdownExt,
  createMarkdownState,
  advanceMarkdownState,
} from "./markdown-syntax.js";
import {
  MAX_PREVIEW_SYNTAX_LINE_CHARS,
  MAX_PREVIEW_RENDER_LINE_CHARS,
  CODE_KEYWORDS,
  CODE_BOOLEANS,
  CODE_CONSTANTS,
  CODE_SPECIAL_VARS,
  CODE_BUILTIN_VARS,
  CODE_TYPES,
  HASH_COMMENT_EXTS,
  SLASH_COMMENT_EXTS,
  MARKUP_EXTS,
  getSyntaxExt as getFileExt,
  getDiffSyntaxPalette,
  diffSyntaxTokenColor,
  expandCodeTabs,
  tokenizeCodeLine,
} from "./code-syntax.js";
import { getDiffMarkdownPlan } from "./markdown-view-logic.js";

export {
  CODE_KEYWORDS as DIFF_KEYWORDS,
  CODE_BOOLEANS as DIFF_BOOLEANS,
  CODE_CONSTANTS as DIFF_CONSTANTS,
  CODE_SPECIAL_VARS as DIFF_SPECIAL_VARS,
  CODE_BUILTIN_VARS as DIFF_BUILTIN_VARS,
  CODE_TYPES as DIFF_TYPES,
  HASH_COMMENT_EXTS,
  SLASH_COMMENT_EXTS,
  MARKUP_EXTS,
  getDiffSyntaxPalette,
  diffSyntaxTokenColor,
  getFileExt,
  expandCodeTabs,
};

export const MAX_DIFF_SYNTAX_LINE_CHARS = MAX_PREVIEW_SYNTAX_LINE_CHARS;
export const MAX_DIFF_RENDER_LINE_CHARS = MAX_PREVIEW_RENDER_LINE_CHARS;

// Linear single-pass lexer that preserves exact characters and avoids regex backtracking.
export function tokenizeDiffLine(rawText, ext, mdState = null) {
  return tokenizeCodeLine(rawText, ext, mdState, {
    maxLineChars: MAX_DIFF_SYNTAX_LINE_CHARS,
  });
}

function resetMdStateForLine(state, lineNo) {
  if (!state) return;
  const n = Number.isFinite(lineNo) && lineNo > 0 ? lineNo : 1;
  state.lineIndex = n - 1;
  state.inFrontmatter = false;
  state.frontmatterClosed = n > 1;
  state.fence = null;
  state.fenceLang = "";
}

const DIFF_HUNK_POS_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)/;

// Numbers and syntax-tokenizes each diff line once so frames only draw visible rows.
export function diffRows(lines, filePath = "") {
  const ext = getFileExt(filePath);
  const isMd = isMarkdownExt(ext);
  const oldMdState = isMd ? createMarkdownState() : null;
  const newMdState = isMd ? createMarkdownState() : null;
  let old = 0;
  let next = 0;
  let hasHunk = false;

  return lines.map((rawLine) => {
    const line = typeof rawLine === "string"
      ? (rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine)
      : String(rawLine ?? "");
    const match = DIFF_HUNK_POS_RE.exec(line);
    if (match) {
      const nextOld = +match[1];
      const nextNew = +match[2];
      if (isMd && (!hasHunk || nextOld !== old || nextNew !== next)) {
        resetMdStateForLine(oldMdState, nextOld || 1);
        resetMdStateForLine(newMdState, nextNew || 1);
      }
      old = nextOld;
      next = nextNew;
      hasHunk = true;
      return { kind: "@", text: line };
    }
    if (
      line.startsWith("diff ") ||
      (!hasHunk && (
        line.startsWith("index ") ||
        line.startsWith("--- a/") ||
        line.startsWith("--- /dev/null") ||
        line.startsWith("+++ b/") ||
        line.startsWith("+++ /dev/null")
      ))
    ) {
      hasHunk = false;
      if (isMd) {
        resetMdStateForLine(oldMdState, 1);
        resetMdStateForLine(newMdState, 1);
      }
      return { kind: "", text: expandCodeTabs(line) };
    }
    const kind = line[0];
    if (kind === "-") {
      const code = expandCodeTabs(line.slice(1) || " ");
      return { kind, number: old++, text: code, tokens: tokenizeDiffLine(code, ext, oldMdState) };
    }
    if (kind === "+") {
      const code = expandCodeTabs(line.slice(1) || " ");
      return { kind, number: next++, text: code, tokens: tokenizeDiffLine(code, ext, newMdState) };
    }
    if (kind === " ") {
      old++;
      const code = expandCodeTabs(line.slice(1) || " ");
      if (isMd) advanceMarkdownState(code, oldMdState);
      return { kind, number: next++, text: code, tokens: tokenizeDiffLine(code, ext, newMdState) };
    }
    return { kind: "", text: expandCodeTabs(line) };
  });
}

// Stack-safe pixel width estimation for horizontal diff scrolling.
export function computeDiffContentWidth(rows, { minWidth = 300, charPx = 7.8, gutterPx = 96 } = {}) {
  const pxPerChar = Number.isFinite(Number(charPx)) && Number(charPx) > 0 ? Number(charPx) : 7.8;
  const capCols = MAX_DIFF_RENDER_LINE_CHARS + 32;
  let maxCols = 0;
  for (const row of rows || []) {
    const raw = typeof row === "string" ? row : row?.text;
    if (!raw) continue;
    let cols;
    if (raw.length >= capCols) {
      cols = capCols;
    } else if (raw.indexOf("\t") === -1) {
      cols = raw.length;
    } else {
      cols = Math.min(expandCodeTabs(raw).length, capCols);
    }
    if (cols > maxCols) maxCols = cols;
  }
  return Math.max(minWidth, Math.ceil(maxCols * pxPerChar) + gutterPx);
}

export const DISCOVER_SKIP_DIRS = new Set([
  ".git", "node_modules", "target", "dist", "build", "vendor",
  ".venv", "venv", ".next", ".nuxt", ".cache", "__pycache__", "out", "coverage", "logs",
]);

export const WATCH_SKIP_DIRS = new Set([
  "node_modules", "target", "dist", "build", "vendor", ".venv", "venv",
  ".next", ".nuxt", ".cache", "__pycache__", "logs", ".gradle", ".idea",
  ".turbo", ".parcel-cache", "coverage", ".sass-cache", "tmp", ".tmp",
]);

export const WATCH_SKIP_EXTS = [".log", ".tmp", ".swp", ".swo", ".part", ".crdownload"];

export function normPathStr(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function normCmpStr(p, isWindows = false) {
  const s = normPathStr(p);
  return isWindows ? s.toLowerCase() : s;
}

export function isSameOrChildPath(child, parent, isWindows = false) {
  const c = normCmpStr(child, isWindows);
  const p = normCmpStr(parent, isWindows);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + "/");
}

export function isSupportedDirentList(entries) {
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

export function direntIsDir(entry) {
  return typeof entry?.isDirectory === "function"
    ? Boolean(entry.isDirectory())
    : Boolean(entry?.isDirectory);
}

export function getRelToRepo(changedPath, repoRoot) {
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

export function isIgnoredWatchPath(changedPath, repoRoot) {
  const rel = getRelToRepo(changedPath, repoRoot);
  const target = rel !== null ? rel : normPathStr(changedPath);
  if (!target) return false;
  const lower = target.toLowerCase();
  const len = lower.length;

  let gitEnd = -1;
  let pos = 0;
  let lastSeg = "";
  while (pos < len) {
    while (pos < len && lower.charCodeAt(pos) === 47) pos += 1;
    if (pos >= len) break;
    let end = lower.indexOf("/", pos);
    if (end === -1) end = len;
    const seg = lower.slice(pos, end);
    if (gitEnd < 0 && seg === ".git") {
      gitEnd = end;
      break;
    }
    if (WATCH_SKIP_DIRS.has(seg)) return true;
    lastSeg = seg;
    pos = end + 1;
  }

  if (gitEnd >= 0) {
    let p = gitEnd + 1;
    while (p < len && lower.charCodeAt(p) === 47) p += 1;
    const tail = p < len ? lower.slice(p) : "";
    const afterGit = tail.indexOf("//") === -1 ? tail : tail.replace(/\/+/g, "/").replace(/\/$/, "");
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

  if (!lastSeg) return false;
  if (lastSeg === ".ds_store" || lastSeg === "thumbs.db" || lastSeg.endsWith("~")) return true;
  for (let i = 0; i < WATCH_SKIP_EXTS.length; i += 1) {
    if (lastSeg.endsWith(WATCH_SKIP_EXTS[i])) return true;
  }
  return false;
}

export function hasRelevantWatchChange(changedPaths, repoRoot) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return true;
  for (const p of changedPaths) {
    if (p && !isIgnoredWatchPath(p, repoRoot)) return true;
  }
  return false;
}

export function parsePorcelainHeader(headerLine) {
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

export function getParentDir(normPath) {
  const parts = String(normPath || "").split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const prefix = normPath.startsWith("/") ? "/" : "";
  return prefix + parts.slice(0, -1).join("/");
}

const EXACT_DIFF_FILE_ICONS = {
  "pom.xml": { kind: "build", tone: "operator" },
  "build.gradle": { kind: "build", tone: "operator" },
  "build.gradle.kts": { kind: "build", tone: "operator" },
  "settings.gradle": { kind: "build", tone: "operator" },
  "settings.gradle.kts": { kind: "build", tone: "operator" },
  "gradle.properties": { kind: "settings", tone: "number" },
  gradlew: { kind: "build", tone: "operator" },
  "gradlew.bat": { kind: "build", tone: "operator" },
  mvnw: { kind: "build", tone: "operator" },
  "mvnw.cmd": { kind: "build", tone: "operator" },
  makefile: { kind: "build", tone: "operator" },
  gnumakefile: { kind: "build", tone: "operator" },
  "cmakelists.txt": { kind: "build", tone: "operator" },
  dockerfile: { kind: "docker", tone: "function" },
  ".dockerignore": { kind: "docker", tone: "function" },
  ".gitignore": { kind: "git", tone: "annotation" },
  ".gitattributes": { kind: "git", tone: "annotation" },
  ".gitmodules": { kind: "git", tone: "annotation" },
  ".gitkeep": { kind: "git", tone: "annotation" },
  ".editorconfig": { kind: "settings", tone: "number" },
  ".prettierrc": { kind: "settings", tone: "number" },
  ".eslintrc": { kind: "settings", tone: "number" },
  ".npmrc": { kind: "settings", tone: "number" },
  ".nvmrc": { kind: "settings", tone: "number" },
  "package-lock.json": { kind: "lock", tone: "muted" },
  "pnpm-lock.yaml": { kind: "lock", tone: "muted" },
  "yarn.lock": { kind: "lock", tone: "muted" },
  "bun.lock": { kind: "lock", tone: "muted" },
  "bun.lockb": { kind: "lock", tone: "muted" },
  "poetry.lock": { kind: "lock", tone: "muted" },
  "uv.lock": { kind: "lock", tone: "muted" },
  "pipfile.lock": { kind: "lock", tone: "muted" },
  "cargo.lock": { kind: "lock", tone: "muted" },
  "composer.lock": { kind: "lock", tone: "muted" },
  "gemfile.lock": { kind: "lock", tone: "muted" },
  "gradle.lockfile": { kind: "lock", tone: "muted" },
  "logback-spring.xml": { kind: "spring", tone: "string" },
  "spring.factories": { kind: "spring", tone: "string" },
  "spring.imports": { kind: "spring", tone: "string" },
  readme: { kind: "markdown", tone: "function" },
  "readme.md": { kind: "markdown", tone: "function" },
  "changelog.md": { kind: "markdown", tone: "function" },
  license: { kind: "markdown", tone: "function" },
  "license.md": { kind: "markdown", tone: "function" },
};

const EXT_DIFF_FILE_ICONS = {
  java: { kind: "java", tone: "annotation" },
  jar: { kind: "java", tone: "annotation" },
  class: { kind: "java", tone: "annotation" },
  kt: { kind: "kotlin", tone: "keyword" },
  kts: { kind: "kotlin", tone: "keyword" },
  py: { kind: "python", tone: "function" },
  pyw: { kind: "python", tone: "function" },
  pyi: { kind: "python", tone: "function" },
  pyx: { kind: "python", tone: "function" },
  ipynb: { kind: "python", tone: "function" },
  js: { kind: "javascript", tone: "type" },
  mjs: { kind: "javascript", tone: "type" },
  cjs: { kind: "javascript", tone: "type" },
  ts: { kind: "typescript", tone: "function" },
  mts: { kind: "typescript", tone: "function" },
  cts: { kind: "typescript", tone: "function" },
  jsx: { kind: "react", tone: "operator" },
  tsx: { kind: "react", tone: "operator" },
  json: { kind: "json", tone: "type" },
  jsonc: { kind: "json", tone: "type" },
  json5: { kind: "json", tone: "type" },
  yml: { kind: "yaml", tone: "keyword" },
  yaml: { kind: "yaml", tone: "keyword" },
  toml: { kind: "yaml", tone: "keyword" },
  properties: { kind: "settings", tone: "number" },
  ini: { kind: "settings", tone: "number" },
  conf: { kind: "settings", tone: "number" },
  cfg: { kind: "settings", tone: "number" },
  env: { kind: "settings", tone: "number" },
  xml: { kind: "html", tone: "number" },
  xsd: { kind: "html", tone: "number" },
  xsl: { kind: "html", tone: "number" },
  wsdl: { kind: "html", tone: "number" },
  html: { kind: "html", tone: "annotation" },
  htm: { kind: "html", tone: "annotation" },
  vue: { kind: "html", tone: "string" },
  svelte: { kind: "html", tone: "annotation" },
  css: { kind: "css", tone: "function" },
  scss: { kind: "css", tone: "keyword" },
  sass: { kind: "css", tone: "keyword" },
  less: { kind: "css", tone: "function" },
  sql: { kind: "database", tone: "operator" },
  ddl: { kind: "database", tone: "operator" },
  dml: { kind: "database", tone: "operator" },
  sqlite: { kind: "database", tone: "operator" },
  db: { kind: "database", tone: "operator" },
  prisma: { kind: "database", tone: "operator" },
  md: { kind: "markdown", tone: "function" },
  mdx: { kind: "markdown", tone: "function" },
  rst: { kind: "markdown", tone: "function" },
  adoc: { kind: "markdown", tone: "function" },
  sh: { kind: "shell", tone: "string" },
  bash: { kind: "shell", tone: "string" },
  zsh: { kind: "shell", tone: "string" },
  fish: { kind: "shell", tone: "string" },
  ps1: { kind: "shell", tone: "string" },
  psm1: { kind: "shell", tone: "string" },
  psd1: { kind: "shell", tone: "string" },
  bat: { kind: "shell", tone: "string" },
  cmd: { kind: "shell", tone: "string" },
  gradle: { kind: "build", tone: "operator" },
  groovy: { kind: "build", tone: "operator" },
  mk: { kind: "build", tone: "operator" },
  dockerfile: { kind: "docker", tone: "function" },
  rs: { kind: "code", tone: "number" },
  go: { kind: "code", tone: "operator" },
  c: { kind: "code", tone: "function" },
  cpp: { kind: "code", tone: "function" },
  cc: { kind: "code", tone: "function" },
  cxx: { kind: "code", tone: "function" },
  h: { kind: "code", tone: "keyword" },
  hpp: { kind: "code", tone: "keyword" },
  cs: { kind: "code", tone: "keyword" },
  rb: { kind: "code", tone: "annotation" },
  php: { kind: "code", tone: "keyword" },
  swift: { kind: "code", tone: "annotation" },
  dart: { kind: "code", tone: "operator" },
  scala: { kind: "code", tone: "annotation" },
  lua: { kind: "code", tone: "function" },
  r: { kind: "code", tone: "function" },
  pl: { kind: "code", tone: "function" },
  png: { kind: "image", tone: "keyword" },
  jpg: { kind: "image", tone: "keyword" },
  jpeg: { kind: "image", tone: "keyword" },
  gif: { kind: "image", tone: "keyword" },
  webp: { kind: "image", tone: "keyword" },
  svg: { kind: "image", tone: "type" },
  ico: { kind: "image", tone: "keyword" },
  bmp: { kind: "image", tone: "keyword" },
};

export function resolveDiffFileIconSpec(filePath) {
  const raw = String(filePath || "");
  const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  const base = (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase();
  if (!base) return { kind: "file", tone: "muted" };
  if (/^(?:application|bootstrap)(?:[-.][a-z0-9_.-]+)?\.(?:ya?ml|properties)$/.test(base)) {
    return { kind: "spring", tone: "string" };
  }
  if (/^dockerfile[.-]/.test(base) || /^(?:docker-)?compose(?:\.[a-z0-9_-]+)?\.ya?ml$/.test(base)) {
    return { kind: "docker", tone: "function" };
  }
  if (EXACT_DIFF_FILE_ICONS[base]) return EXACT_DIFF_FILE_ICONS[base];
  if (base.startsWith(".env")) return { kind: "settings", tone: "number" };
  const ext = getFileExt(base);
  if (ext && EXT_DIFF_FILE_ICONS[ext]) return EXT_DIFF_FILE_ICONS[ext];
  return { kind: "file", tone: "muted" };
}

export function resolveDiffFileIcon(filePath, t) {
  const spec = resolveDiffFileIconSpec(filePath);
  const palette = getDiffSyntaxPalette(t);
  return {
    kind: spec.kind,
    path: `mods/changes-review/icons/file-types/${spec.kind}.svg`,
    color: palette[spec.tone] || palette.muted,
  };
}

export function formatReviewTabTitle(file) {
  const raw = typeof file === "string"
    ? file
    : (file?.path || file?.displayPath || file?.name || "");
  const clean = String(raw || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!clean) return "Review";
  const slash = clean.lastIndexOf("/");
  const base = slash >= 0 ? clean.slice(slash + 1) : clean;
  return base ? `Review · ${base}` : "Review";
}

export function getSessionNotesKey(spaceId, sourceTabId) {
  return `${spaceId || "default"}::${sourceTabId || "global"}`;
}

export function resolveSessionAgentTabId(space, allPanes, storedAgentTabs) {
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
    activePanes.every((p) => !p.terminal && (p.mod === "changes-review" || p.mod === "files-search" || p.mod === "git-history"))
  );

  if (!activeTab || isViewerOnlyTab) {
    const storedId = storedAgentTabs && space?.id ? storedAgentTabs[space.id] : null;
    if (storedId && tabs.some((t) => t && t.id === storedId) && hasTerminal(storedId)) {
      return storedId;
    }

    const firstTerminalTab = tabs.find((t) => t && hasTerminal(t.id));
    if (firstTerminalTab) return firstTerminalTab.id;
  }

  return activeTab?.id || null;
}

export function pickNextUnreviewedFile(files, currentKey, isReviewedFn) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const isReviewed = typeof isReviewedFn === "function" ? isReviewedFn : () => false;
  const curIdx = currentKey ? files.findIndex((f) => f?.key === currentKey) : -1;
  if (curIdx < 0) {
    for (const cand of files) {
      if (cand && !isReviewed(cand)) return cand;
    }
    return null;
  }
  for (let offset = 1; offset < files.length; offset++) {
    const cand = files[(curIdx + offset) % files.length];
    if (cand && cand.key !== currentKey && !isReviewed(cand)) {
      return cand;
    }
  }
  return null;
}

export function sortServicesDirtyFirst(services) {
  return [...(Array.isArray(services) ? services : [])].sort((a, b) => {
    const aCount = a?.workingCount || 0;
    const bCount = b?.workingCount || 0;
    if ((aCount > 0) !== (bCount > 0)) return bCount - aCount;
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
}

/** Normalize comment diff side (`"old"` for deleted lines, `"new"` for added/context lines). */
export function normalizeCommentSide(side) {
  return side === "old" ? "old" : "new";
}

/** Build a collision-free comment key scoped by fileKey, diff side, and line number. */
export function buildCommentKey(fileKey, line, side = "new") {
  return `${String(fileKey || "")}::${normalizeCommentSide(side)}::${Number(line) || 0}`;
}

/** Build the unified session review approval key (`session::<serviceId>::<path>`). */
export function buildReviewedFileKey(fileOrKey) {
  const fileKey = typeof fileOrKey === "string"
    ? fileOrKey
    : (fileOrKey?.key || (fileOrKey?.serviceId && fileOrKey?.path ? `${fileOrKey.serviceId}::${fileOrKey.path}` : ""));
  return fileKey ? `session::${fileKey}` : "";
}

/**
 * Compute a commit-resilient fingerprint string for a unified session diff file.
 * Excludes transient `fresh` state so approving a file persists across `git add` / `git commit`
 * while invalidating immediately when net diff, content sig, or `baseHash` changes.
 */
export function computeFileReviewFingerprint(file) {
  if (!file || typeof file !== "object") return "";
  const status = String(file.status || "M");
  const baseHash = String(file.baseHash || "");
  const sig = status === "D" ? "deleted:D" : String(file.sig || "");
  return `${status}|${Number(file.add) || 0}|${Number(file.del) || 0}|${file.binary ? 1 : 0}|${baseHash}|${sig}`;
}

/** Normalize a stored reviewedFiles entry (legacy boolean or structured record). */
export function parseReviewedFileRecord(entry) {
  if (entry === true) return { reviewed: true, fp: "", reviewedAt: 0 };
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (entry.reviewed !== true) return null;
  const reviewedAtNum = Number(entry.reviewedAt);
  return {
    reviewed: true,
    fp: typeof entry.fp === "string" ? entry.fp : "",
    reviewedAt: Number.isFinite(reviewedAtNum) ? reviewedAtNum : 0,
  };
}

function extractFileKeyServiceId(fileKey) {
  const sep = fileKey.indexOf("::");
  return sep >= 0 ? fileKey.slice(0, sep) : "";
}

/**
 * Reconcile persisted `session::` file-reviewed records against current unified session files.
 * Preserves approvals across `git commit` when net diff & content fingerprint against `baseHash`
 * are unchanged, and invalidates checks when a file leaves the diff, is edited, or changes base.
 */
export function reconcileReviewedFiles(
  prevReviewedFiles,
  {
    sessionFiles,
    workingFiles = [],
    erroredServiceIds = new Set(),
  } = {},
) {
  const prev = prevReviewedFiles && typeof prevReviewedFiles === "object" && !Array.isArray(prevReviewedFiles)
    ? prevReviewedFiles
    : {};
  const activeList = Array.isArray(sessionFiles)
    ? sessionFiles
    : (Array.isArray(workingFiles) ? workingFiles : []);
  const fileByKey = new Map();
  for (const f of activeList) {
    if (f?.key) fileByKey.set(f.key, f);
  }
  const erroredSet = erroredServiceIds instanceof Set
    ? erroredServiceIds
    : new Set(Array.isArray(erroredServiceIds) ? erroredServiceIds : []);

  const nextMap = {};
  let changed = false;

  for (const [rk, rawVal] of Object.entries(prev)) {
    const rec = parseReviewedFileRecord(rawVal);
    if (!rec) {
      changed = true;
      continue;
    }

    if (rk.startsWith("session::")) {
      const fileKey = rk.slice("session::".length);
      const serviceIdFromKey = extractFileKeyServiceId(fileKey);
      if (erroredSet.has(serviceIdFromKey)) {
        nextMap[rk] = rawVal;
        continue;
      }
      const curFile = fileByKey.get(fileKey);
      if (!curFile) {
        changed = true;
        continue;
      }
      const curFp = computeFileReviewFingerprint(curFile);
      if (!rec.fp || rec.fp !== curFp) {
        changed = true;
        continue;
      }
      nextMap[rk] = rawVal;
      continue;
    }

    // Drop legacy `working::` and `commit:*` entries cleanly.
    if (rk.startsWith("working::") || rk.startsWith("commit:")) {
      changed = true;
      continue;
    }

    nextMap[rk] = rawVal;
  }

  return { nextMap, changed };
}

function baselineEntriesMatch(base, status, sig) {
  if (!base || typeof base !== "object") return false;
  const baseStatus = String(base.status ?? "");
  const curStatus = String(status ?? "");
  if (baseStatus !== curStatus) return false;
  const baseSig = String(base.sig ?? "");
  const curSig = String(sig ?? "");
  if (baseSig === curSig) return true;
  if (
    curStatus === "D" &&
    (baseSig === "deleted" || baseSig === "deleted:D") &&
    (curSig === "deleted" || curSig === "deleted:D")
  ) {
    return true;
  }
  return false;
}

export function partitionSessionWorkingEntries(entries, baselineRepo, sessionStartedAt) {
  if (!Array.isArray(entries) || entries.length === 0) return { visible: [], hidden: [] };
  const startedAtMs = Number(sessionStartedAt || 0);
  const dirtyFiles =
    baselineRepo && typeof baselineRepo === "object" && baselineRepo.dirtyFiles && typeof baselineRepo.dirtyFiles === "object"
      ? baselineRepo.dirtyFiles
      : null;

  const visible = [];
  const hidden = [];

  for (const entry of entries) {
    if (!entry) continue;
    const relFile = entry.relFile ?? entry.path ?? "";
    const status = entry.status ?? "";
    const sig = entry.sig ?? "";
    const mtimeMs = Number(entry.mtimeMs || 0);

    if (dirtyFiles) {
      if (baselineEntriesMatch(dirtyFiles[relFile], status, sig)) {
        hidden.push(entry);
        continue;
      }
      visible.push(entry);
      continue;
    }

    if (startedAtMs > 0) {
      if (mtimeMs > 0 && mtimeMs >= startedAtMs) {
        visible.push(entry);
      } else {
        hidden.push(entry);
      }
      continue;
    }
    visible.push(entry);
  }

  return { visible, hidden };
}

export function filterSessionWorkingEntries(entries, baselineRepo, sessionStartedAt) {
  return partitionSessionWorkingEntries(entries, baselineRepo, sessionStartedAt).visible;
}

/**
 * Partition unified origin-branch diff entries into visible session changes vs hidden pre-existing
 * uncommitted working-tree entries. Files already modified in `baseHash..HEAD` commits (`committedPaths`)
 * are always visible; uncommitted files matching `baselineRepo.dirtyFiles` remain hidden.
 */
export function partitionSessionUnifiedEntries(entries, baselineRepo, committedPaths = null, sessionStartedAt = 0) {
  if (!Array.isArray(entries) || entries.length === 0) return { visible: [], hidden: [] };
  const committedSet = committedPaths instanceof Set
    ? committedPaths
    : new Set(Array.isArray(committedPaths) ? committedPaths : []);
  const startedAtMs = Number(sessionStartedAt || 0);
  const dirtyFiles =
    baselineRepo && typeof baselineRepo === "object" && baselineRepo.dirtyFiles && typeof baselineRepo.dirtyFiles === "object"
      ? baselineRepo.dirtyFiles
      : null;

  const visible = [];
  const hidden = [];

  for (const entry of entries) {
    if (!entry) continue;
    const relFile = normBaselineRel(entry.relFile ?? entry.path ?? "");
    if (committedSet.has(relFile)) {
      visible.push(entry);
      continue;
    }
    if (entry.inWorkingTree === false) {
      visible.push(entry);
      continue;
    }
    const status = entry.workingStatus || entry.status || "";
    const sig = entry.sig ?? "";
    const mtimeMs = Number(entry.mtimeMs || 0);
    if (dirtyFiles) {
      if (baselineEntriesMatch(dirtyFiles[relFile], status, sig)) {
        hidden.push(entry);
        continue;
      }
      visible.push(entry);
      continue;
    }
    if (startedAtMs > 0) {
      if (mtimeMs > 0 && mtimeMs >= startedAtMs) {
        visible.push(entry);
      } else {
        hidden.push(entry);
      }
      continue;
    }
    visible.push(entry);
  }

  return { visible, hidden };
}

/**
 * Determine whether a candidate repository has legitimate activity in the current chat session.
 * Prevents untouched sibling repositories (including those on old feature branches) from leaking,
 * while ensuring a Space opened directly on a single repository (`inWorkspaceRoot`) remains attributed
 * even when Windows ConPTY terminals do not report `pane.cwd`.
 */
export function evaluateRepoSessionActivity({
  hasNewWorkingEdit = false,
  inPaneCwd = false,
  inWorkspaceRoot = false,
  inSessionRepos = false,
  startHead = "",
  headHash = "",
  repoMatchesTranscript = false,
} = {}) {
  if (hasNewWorkingEdit || inPaneCwd || inWorkspaceRoot || inSessionRepos) return true;
  const headMoved = Boolean(startHead && headHash && startHead !== headHash);
  return Boolean(headMoved && repoMatchesTranscript);
}

function normBaselineRoot(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWindowsDrivePath(normPath) {
  return /^[a-zA-Z]:\//.test(String(normPath || "")) || /^[a-zA-Z]:$/.test(String(normPath || ""));
}

/**
 * Look up a repository entry inside `baseline.repos`, matching exact normalized paths first
 * and falling back to case-insensitive matching on Windows (or Windows drive paths).
 */
export function findBaselineRepoEntry(reposMap, repoRoot, isWindows = false) {
  if (!reposMap || typeof reposMap !== "object" || !repoRoot) return null;
  const norm = normBaselineRoot(repoRoot);
  if (!norm) return null;
  if (Object.prototype.hasOwnProperty.call(reposMap, norm) && reposMap[norm]) {
    return reposMap[norm];
  }
  const caseInsensitive = Boolean(isWindows) || isWindowsDrivePath(norm);
  if (!caseInsensitive) return null;
  const lowerTarget = norm.toLowerCase();
  for (const [k, v] of Object.entries(reposMap)) {
    if (v && normBaselineRoot(k).toLowerCase() === lowerTarget) {
      return v;
    }
  }
  return null;
}

function normBaselineRel(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function isHomeDirectoryRoot(folderPath, on = null, appHomeDir = "", isWindows = false) {
  const norm = normBaselineRoot(folderPath);
  if (!norm) return false;
  if (norm === "~" || norm === "/root") return true;
  if (/^\/(?:home|Users)\/[^/]+$/.test(norm)) return true;
  if (/^[a-zA-Z]:\/Users\/[^/]+$/i.test(norm)) return true;
  if (!on && appHomeDir) {
    const normApp = normBaselineRoot(appHomeDir);
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
      const normSpace = normBaselineRoot(spaceFolder);
      const normActive = normBaselineRoot(activeCwd);
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

function fnv1aHexStr(str) {
  let hash = 0x811c9dc5;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
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

function safeBaselineTabId(tabId) {
  return String(tabId || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "tab";
}

function resumeKeyHash(workspaceRoot, branch) {
  const normRoot = normBaselineRoot(workspaceRoot);
  const normBranch = String(branch || "").trim();
  return fnv1aHexStr(`${normRoot}::${normBranch}`);
}

export function normalizeGitStatusMark(xy) {
  const s = String(xy || "");
  if (s.includes("U") || s === "AA" || s === "DD") return "U";
  if (s.includes("D")) return "D";
  if (s === "??" || s.includes("A")) return "A";
  return "M";
}

export async function statFileEntry(fullPath, status, on = null, fsDeps = fsPromises, opts = null) {
  if (String(status || "") === "D") return { sig: "deleted:D", mtimeMs: 0 };
  if (on) {
    const ds = opts?.diffStat;
    if (ds && typeof ds === "object") {
      return {
        sig: `ssh:${String(status || "M")}:${Number(ds.add) || 0}:${Number(ds.del) || 0}:${ds.binary ? 1 : 0}`,
        mtimeMs: 0,
      };
    }
    return { sig: String(status || ""), mtimeMs: 0 };
  }
  if (!fullPath) return { sig: "deleted:D", mtimeMs: 0 };
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
      if (err && err.code === "ENOENT") return { sig: "deleted:D", mtimeMs: 0 };
    }
  }
  if (typeof api.exists === "function") {
    try {
      const ok = await api.exists(fullPath);
      if (!ok) return { sig: "deleted:D", mtimeMs: 0 };
    } catch {
      // fall through
    }
  }
  const reader = typeof api.readFile === "function" ? api.readFile : fsPromises.readFile;
  if (typeof reader === "function") {
    try {
      const buf = await reader(fullPath);
      const { len, hex } = fnv1aBytes(buf);
      return { sig: `${len}:b${hex}`, mtimeMs: 0 };
    } catch (err) {
      if (err && err.code === "ENOENT") return { sig: "deleted:D", mtimeMs: 0 };
      return { sig: `dir:${String(status || "")}`, mtimeMs: 0 };
    }
  }
  return { sig: String(status || ""), mtimeMs: 0 };
}

export function normalizeSessionBaseline(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw.sessionBaseline && typeof raw.sessionBaseline === "object" && !Array.isArray(raw.sessionBaseline)
    ? raw.sessionBaseline
    : raw;
  const startedAtNum = Number(payload.startedAt);
  if (!Number.isFinite(startedAtNum) || startedAtNum <= 0) return null;
  const workspaceRoot = normBaselineRoot(payload.workspaceRoot || "");
  const revNum = Number(payload.rev);
  const rev = Number.isFinite(revNum) && revNum >= 0 ? Math.trunc(revNum) : 0;
  const repos = {};
  const rawRepos = payload.repos && typeof payload.repos === "object" && !Array.isArray(payload.repos) ? payload.repos : {};
  for (const [repoKey, repoVal] of Object.entries(rawRepos)) {
    const normRoot = normBaselineRoot(repoKey);
    if (!normRoot || !repoVal || typeof repoVal !== "object" || Array.isArray(repoVal)) continue;
    const dirtyFiles = {};
    const rawDirty = repoVal.dirtyFiles && typeof repoVal.dirtyFiles === "object" && !Array.isArray(repoVal.dirtyFiles)
      ? repoVal.dirtyFiles
      : {};
    for (const [relFile, entryVal] of Object.entries(rawDirty)) {
      const cleanRel = normBaselineRel(relFile);
      if (!cleanRel || !entryVal || typeof entryVal !== "object" || Array.isArray(entryVal)) continue;
      dirtyFiles[cleanRel] = {
        status: String(entryVal.status || ""),
        sig: String(entryVal.sig || ""),
      };
    }
    const repoOut = { dirtyFiles };
    if (typeof repoVal.startHead === "string" && repoVal.startHead.trim()) {
      repoOut.startHead = repoVal.startHead.trim();
    }
    if (typeof repoVal.startBranch === "string" && repoVal.startBranch.trim()) {
      repoOut.startBranch = repoVal.startBranch.trim();
    }
    repos[normRoot] = repoOut;
  }
  return {
    version: 1,
    rev,
    startedAt: startedAtNum,
    workspaceRoot,
    repos,
  };
}

export function getDiskSessionBaselinePath(appHomeDir, tabId) {
  if (!appHomeDir || !tabId) return "";
  return join(String(appHomeDir), "cognivisor", "sessions", "tabs", `${safeBaselineTabId(tabId)}.json`);
}

function baselineMatchesWorkspace(baseline, workspaceRoot) {
  const normWs = normBaselineRoot(workspaceRoot);
  if (!normWs || !baseline?.workspaceRoot) return true;
  if (baseline.workspaceRoot === normWs) return true;
  if (isWindowsDrivePath(normWs) && isWindowsDrivePath(baseline.workspaceRoot)) {
    return baseline.workspaceRoot.toLowerCase() === normWs.toLowerCase();
  }
  return false;
}

async function readBaselineJsonFile(filePath, fsDeps = fsPromises) {
  if (!filePath) return null;
  const reader = typeof fsDeps?.readFile === "function" ? fsDeps.readFile : fsPromises.readFile;
  try {
    const text = await reader(filePath, "utf8");
    const parsed = JSON.parse(text);
    return normalizeSessionBaseline(parsed);
  } catch {
    return null;
  }
}

export async function readDiskSessionBaseline(appHomeDir, tabId, workspaceRoot, branchesOrBranch, resumeArg = false, fsDeps = fsPromises) {
  if (!appHomeDir) return null;
  const baseDir = join(String(appHomeDir), "cognivisor", "sessions");
  if (tabId) {
    const tabPath = join(baseDir, "tabs", `${safeBaselineTabId(tabId)}.json`);
    const fromTab = await readBaselineJsonFile(tabPath, fsDeps);
    if (fromTab && baselineMatchesWorkspace(fromTab, workspaceRoot)) return fromTab;
  }
  const resumeKey = typeof resumeArg === "object" && resumeArg !== null
    ? String(resumeArg.resumeKey || "")
    : (typeof resumeArg === "string" ? resumeArg : "");
  const shouldCheckResume = typeof resumeArg === "object" && resumeArg !== null
    ? Boolean(resumeArg.hasResumeCommand || resumeArg.resumeKey)
    : Boolean(resumeArg);
  if (shouldCheckResume && (workspaceRoot || resumeKey)) {
    const branchList = Array.isArray(branchesOrBranch)
      ? Array.from(new Set(branchesOrBranch.map((b) => String(b || "").trim()).filter(Boolean)))
      : (String(branchesOrBranch || "").trim() ? [String(branchesOrBranch || "").trim()] : []);
    const hashes = [];
    if (resumeKey) hashes.push(fnv1aHexStr(resumeKey));
    if (workspaceRoot) {
      for (const br of branchList) {
        hashes.push(resumeKeyHash(workspaceRoot, br));
      }
      if (branchList.length === 0) {
        hashes.push(resumeKeyHash(workspaceRoot, ""));
      }
    }
    for (const h of Array.from(new Set(hashes))) {
      const resumePath = join(baseDir, "resume", `${h}.json`);
      const fromResume = await readBaselineJsonFile(resumePath, fsDeps);
      if (fromResume && baselineMatchesWorkspace(fromResume, workspaceRoot)) return fromResume;
    }
  }
  return null;
}

export async function writeDiskSessionBaseline(appHomeDir, tabId, workspaceRoot, branch, data, resumeKey = "", fsDeps = fsPromises) {
  if (!appHomeDir || !data) return false;
  const normalized = normalizeSessionBaseline(
    workspaceRoot && !data.workspaceRoot ? { ...data, workspaceRoot } : data
  );
  if (!normalized) return false;
  const json = JSON.stringify(normalized);
  const baseDir = join(String(appHomeDir), "cognivisor", "sessions");
  const mk = typeof fsDeps?.mkdir === "function" ? fsDeps.mkdir : fsPromises.mkdir;
  const wr = typeof fsDeps?.writeFile === "function" ? fsDeps.writeFile : fsPromises.writeFile;
  let wrote = false;
  if (tabId) {
    try {
      const tabsDir = join(baseDir, "tabs");
      await mk(tabsDir, { recursive: true });
      await wr(join(tabsDir, `${safeBaselineTabId(tabId)}.json`), json, "utf8");
      wrote = true;
    } catch {
      // non-fatal
    }
  }
  if (workspaceRoot || resumeKey) {
    try {
      const resumeDir = join(baseDir, "resume");
      await mk(resumeDir, { recursive: true });
      const h = resumeKey ? fnv1aHexStr(resumeKey) : resumeKeyHash(workspaceRoot, branch);
      await wr(join(resumeDir, `${h}.json`), json, "utf8");
      wrote = true;
    } catch {
      // non-fatal
    }
  }
  return wrote;
}

export function resolveSessionStartTime(flowObj, now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
  const candidates = [];
  if (flowObj && typeof flowObj === "object") {
    // Only trust explicit session start / creation timestamps — never `updatedAt` written by tab naming.
    for (const raw of [flowObj.sessionStartedAt, flowObj.createdAt]) {
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

export function buildFreshSessionBaseline(repoSnapshots, { workspaceRoot = "", startedAt = Date.now(), anchored = false, rev = 0 } = {}) {
  const startedAtNum = Number.isFinite(Number(startedAt)) && Number(startedAt) > 0 ? Number(startedAt) : Date.now();
  const normWs = normBaselineRoot(workspaceRoot || "");
  const revNum = Number.isFinite(Number(rev)) && Number(rev) >= 0 ? Math.trunc(Number(rev)) : 0;
  const repos = {};
  for (const res of Array.isArray(repoSnapshots) ? repoSnapshots : []) {
    const normRoot = normBaselineRoot(res?.service?.root ?? res?.root ?? "");
    if (!normRoot) continue;
    const dirtyFiles = {};
    // Prefer `workingFiles` (working-tree only) so committed branch changes are never baselined as dirty.
    const workingList = Array.isArray(res?.workingFiles)
      ? res.workingFiles
      : (Array.isArray(res?.files) ? res.files : []);
    for (const f of workingList) {
      const rel = normBaselineRel(f?.relFile ?? f?.path ?? "");
      if (!rel) continue;
      const mtimeMs = Number(f?.mtimeMs || 0);
      if (anchored && mtimeMs > 0 && mtimeMs >= startedAtNum) {
        continue;
      }
      dirtyFiles[rel] = {
        status: String(f?.workingStatus || f?.status || "M"),
        sig: String(f?.sig || ""),
      };
    }
    const repoEntry = { dirtyFiles };
    const startHead = String(res?.headHash || "").trim();
    const startBranch = String(res?.branch || res?.service?.branch || "").trim();
    if (startHead) repoEntry.startHead = startHead;
    if (startBranch) repoEntry.startBranch = startBranch;
    repos[normRoot] = repoEntry;
  }
  return {
    version: 1,
    rev: revNum,
    startedAt: startedAtNum,
    workspaceRoot: normWs,
    repos,
  };
}

export function createResetSessionBaseline(existingBaseline, repoRoots = [], workspaceRoot = "", now = Date.now()) {
  const nowMs = Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
  const normExisting = normalizeSessionBaseline(existingBaseline);
  const startedAt = normExisting?.startedAt && normExisting.startedAt > 0 ? normExisting.startedAt : nowMs;
  const normWs = normBaselineRoot(workspaceRoot || normExisting?.workspaceRoot || "");
  const nextRev = (normExisting?.rev || 0) + 1;
  const repos = {};
  if (normExisting?.repos) {
    for (const [repoRoot, prevRepo] of Object.entries(normExisting.repos)) {
      const clean = normBaselineRoot(repoRoot);
      if (!clean) continue;
      const entry = { dirtyFiles: {} };
      if (prevRepo?.startHead) entry.startHead = prevRepo.startHead;
      if (prevRepo?.startBranch) entry.startBranch = prevRepo.startBranch;
      repos[clean] = entry;
    }
  }
  for (const repoRoot of Array.isArray(repoRoots) ? repoRoots : []) {
    const clean = normBaselineRoot(repoRoot);
    if (!clean) continue;
    if (!repos[clean]) repos[clean] = { dirtyFiles: {} };
  }
  return {
    version: 1,
    rev: nextRev,
    startedAt,
    workspaceRoot: normWs,
    repos,
  };
}

export function countBaselineDirtyFiles(baseline) {
  if (!baseline || typeof baseline !== "object" || !baseline.repos || typeof baseline.repos !== "object") return 0;
  let total = 0;
  for (const repoVal of Object.values(baseline.repos)) {
    if (repoVal && typeof repoVal === "object" && repoVal.dirtyFiles && typeof repoVal.dirtyFiles === "object") {
      total += Object.keys(repoVal.dirtyFiles).length;
    }
  }
  return total;
}

/**
 * Compact `cognivisor.flows` to prevent QuickJS shared-bus OOM:
 * strips bulky `sessionBaseline` snapshots (persisted on disk under sessions/tabs/*.json)
 * and prunes stale closed-tab entries while keeping all live tabs.
 */
export function compactFlowsMap(
  flows,
  liveTabIds = null,
  { maxClosedTabs = 25, maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = {},
) {
  if (!flows || typeof flows !== "object" || Array.isArray(flows)) return {};
  const liveSet = liveTabIds ? new Set(Array.from(liveTabIds).filter(Boolean)) : null;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const ageLimit = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0 ? Number(maxAgeMs) : 7 * 24 * 60 * 60 * 1000;
  const closedCap = Number.isFinite(Number(maxClosedTabs)) && Number(maxClosedTabs) >= 0 ? Math.trunc(Number(maxClosedTabs)) : 25;

  const liveEntries = [];
  const closedEntries = [];
  for (const [tabId, rawFlow] of Object.entries(flows)) {
    if (!tabId || !rawFlow || typeof rawFlow !== "object" || Array.isArray(rawFlow)) continue;
    const { sessionBaseline: _droppedBaseline, ...rest } = rawFlow;
    const updatedAt = Number(rest.updatedAt) || Number(rest.sessionStartedAt) || 0;
    if (liveSet && liveSet.has(tabId)) {
      liveEntries.push([tabId, rest]);
    } else if (!liveSet) {
      liveEntries.push([tabId, rest]);
    } else {
      if (updatedAt > 0 && (nowMs - updatedAt) > ageLimit) continue;
      closedEntries.push({ tabId, flow: rest, updatedAt });
    }
  }

  closedEntries.sort((a, b) => b.updatedAt - a.updatedAt);
  const keptClosed = closedEntries.slice(0, closedCap);

  const out = {};
  for (const [tabId, flow] of liveEntries) out[tabId] = flow;
  for (const item of keptClosed) out[item.tabId] = item.flow;
  return out;
}

function stripAnsiEscapes(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

const RESUME_CMD_LINE_RE =
  /^(?:(?:[^\n]{0,60}?[$%>❯›•]\s+)|Running\s+)?(?:\/resume(?:\s+([a-zA-Z0-9_][a-zA-Z0-9._:/-]*))?|(?:claude|codex|gemini|opencode|antigravity)\s+(?:--)?resume(?:\s+([a-zA-Z0-9_][a-zA-Z0-9._:/-]*))?)\s*$/i;

export function extractResumeKeyFromTranscript(text, workspaceRoot) {
  if (typeof text !== "string" || !text) return "";
  const tail = text.length > 16384 ? text.slice(-16384) : text;
  const s = stripAnsiEscapes(tail);
  if (!s) return "";
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.length > 300) continue;
    const cmdMatch = line.match(RESUME_CMD_LINE_RE);
    if (cmdMatch) {
      const id = (cmdMatch[1] || cmdMatch[2] || "").trim();
      return id ? `resume:${id}` : `resume:${normBaselineRoot(workspaceRoot || "")}`;
    }
  }
  return "";
}

export function filterUnbaselinedRepoEntries(entries, sessionStartedAt, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { sessionFiles: [], backfillDirtyFiles: {} };
  }
  const startedAtMs = Number(sessionStartedAt || 0);
  const hasAnyMtime = entries.some((e) => Number(e?.mtimeMs || 0) > 0);
  const { isAttributed = false } = opts || {};

  if (hasAnyMtime) {
    const sessionFiles = [];
    const backfillDirtyFiles = {};
    for (const item of entries) {
      if (!item) continue;
      const rel = item.relFile ?? item.path ?? "";
      if (!rel) continue;
      const mtimeMs = Number(item.mtimeMs || 0);
      if (startedAtMs > 0 && mtimeMs > 0 && mtimeMs >= startedAtMs) {
        sessionFiles.push(item);
      } else if (startedAtMs <= 0 && mtimeMs > 0) {
        sessionFiles.push(item);
      } else {
        // Pre-existing older files AND deleted files (mtimeMs === 0) get backfilled into baseline.
        backfillDirtyFiles[rel] = {
          status: String(item.workingStatus || item.status || ""),
          sig: String(item.sig || ""),
        };
      }
    }
    return { sessionFiles, backfillDirtyFiles };
  }

  if (isAttributed) {
    return {
      sessionFiles: entries.filter(Boolean),
      backfillDirtyFiles: {},
    };
  }

  const backfillDirtyFiles = {};
  for (const item of entries) {
    const rel = item?.relFile ?? item?.path ?? "";
    if (!rel) continue;
    backfillDirtyFiles[rel] = {
      status: String(item.workingStatus || item.status || ""),
      sig: String(item.sig || ""),
    };
  }
  return { sessionFiles: [], backfillDirtyFiles };
}

export const READ_GIT_FLAGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const BASE_BRANCH_NAMES = new Set(["main", "master", "development", "develop", "release", "ci", "HEAD", ""]);
export const MAX_UNTRACKED_COUNT_BYTES = 400_000;

/**
 * Merge `cognivisor.services` candidates with any already-enriched service metadata so
 * discovered repositories are evaluated uniformly against their origin/base branch.
 */
export function mergeBusCandidateServices(candidates, busServices = [], isWindows = false) {
  const byRoot = new Map();
  const byId = new Map();
  for (const s of Array.isArray(busServices) ? busServices : []) {
    if (!s) continue;
    const rootKey = s.root ? normCmpStr(s.root, isWindows) : "";
    if (rootKey && !byRoot.has(rootKey)) byRoot.set(rootKey, s);
    if (s.id && !byId.has(s.id)) byId.set(s.id, s);
  }

  const merged = [];
  const seenRoots = new Set();
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c) continue;
    const rootKey = c.root ? normCmpStr(c.root, isWindows) : "";
    if (rootKey) {
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);
    }
    const enriched = (rootKey && byRoot.get(rootKey)) || (c.id && byId.get(c.id)) || null;
    merged.push({
      ...c,
      ...(enriched || {}),
      branch: enriched?.branch || c.branch || "",
    });
  }

  for (const s of Array.isArray(busServices) ? busServices : []) {
    if (!s) continue;
    const rootKey = s.root ? normCmpStr(s.root, isWindows) : "";
    if (rootKey) {
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);
    }
    merged.push({ ...s });
  }
  return merged;
}

/** Count unpushed commits relative to the first matching base branch via `exec`. */
export async function repoAheadCountWithExec(root, branch, on, execFn, opts = {}) {
  const baseBranches = opts.baseBranches || BASE_BRANCH_NAMES;
  const readFlags = opts.readFlags || READ_GIT_FLAGS;
  if (!branch || baseBranches.has(branch) || typeof execFn !== "function") return 0;
  const refs = await execFn(
    "git",
    [...readFlags, "for-each-ref", "--format=%(refname:short)", "refs/heads/development", "refs/heads/develop", "refs/heads/main", "refs/heads/master", "refs/heads/ci"],
    { cwd: root, on },
  ).catch(() => null);
  const avail = new Set((refs?.code === 0 ? refs.stdout : "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  for (const base of ["development", "develop", "main", "master", "ci"]) {
    if (!avail.has(base)) continue;
    const check = await execFn("git", [...readFlags, "rev-list", "--count", `${base}..HEAD`], { cwd: root, on }).catch(() => null);
    if (check && check.code === 0) {
      const n = parseInt((check.stdout || "").trim(), 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return 0;
}

/**
 * Count lines of a local untracked file safely (bounded at `MAX_UNTRACKED_COUNT_BYTES`,
 * checking NUL bytes to detect binary files without crashing QuickJS).
 */
export async function countUntrackedFileLines(fullPath, on = null, fsDeps = fsPromises, maxBytes = MAX_UNTRACKED_COUNT_BYTES) {
  if (on || !fullPath) return { add: 0, del: 0, binary: false };
  const api = fsDeps || fsPromises;
  const reader = typeof api.readFile === "function" ? api.readFile : fsPromises.readFile;
  if (typeof reader !== "function") return { add: 0, del: 0, binary: false };
  try {
    const raw = await reader(fullPath);
    if (typeof raw === "string") {
      const probeLen = Math.min(raw.length, 8192);
      for (let i = 0; i < probeLen; i += 1) {
        if (raw.charCodeAt(i) === 0) return { add: 0, del: 0, binary: true };
      }
      const len = Math.min(raw.length, maxBytes);
      if (len === 0) return { add: 0, del: 0, binary: false };
      let lines = 0;
      for (let i = 0; i < len; i += 1) {
        if (raw.charCodeAt(i) === 10) lines += 1;
      }
      if (raw.charCodeAt(len - 1) !== 10) lines += 1;
      return { add: lines, del: 0, binary: false };
    }
    const view = raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : (ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : null);
    if (!view) return { add: 0, del: 0, binary: false };
    const probeLen = Math.min(view.length, 8192);
    for (let i = 0; i < probeLen; i += 1) {
      if (view[i] === 0) return { add: 0, del: 0, binary: true };
    }
    const len = Math.min(view.length, maxBytes);
    if (len === 0) return { add: 0, del: 0, binary: false };
    let lines = 0;
    for (let i = 0; i < len; i += 1) {
      if (view[i] === 10) lines += 1;
    }
    if (view[len - 1] !== 10) lines += 1;
    return { add: lines, del: 0, binary: false };
  } catch {
    return { add: 0, del: 0, binary: false };
  }
}

/** Parse NUL-delimited `git diff --name-status -z --no-renames` output into `Map<path, status>`. */
export function parseNameStatusZ(stdout) {
  const map = new Map();
  const raw = String(stdout || "");
  if (!raw) return map;
  const parts = raw.split("\0");
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    if (!code) {
      i += 1;
      continue;
    }
    const first = code[0];
    if (first === "R" || first === "C") {
      const nextPath = parts[i + 2] || "";
      if (nextPath) map.set(nextPath.replace(/\/+$/, ""), first === "C" ? "A" : "M");
      i += 3;
      continue;
    }
    const filePath = parts[i + 1] || "";
    if (filePath) {
      const normStatus = first === "D" ? "D" : first === "A" ? "A" : first === "U" ? "U" : "M";
      map.set(filePath.replace(/\/+$/, ""), normStatus);
    }
    i += 2;
  }
  return map;
}

/** Parse NUL-delimited `git diff --numstat -z --no-renames` output into `Map<path, { add, del, binary }>`. */
export function parseNumstatZ(stdout) {
  const stats = new Map();
  const out = String(stdout || "");
  let eStart = 0;
  while (eStart < out.length) {
    let eEnd = out.indexOf("\0", eStart);
    if (eEnd === -1) eEnd = out.length;
    const entry = out.slice(eStart, eEnd);
    eStart = eEnd + 1;
    if (!entry) continue;
    const t1 = entry.indexOf("\t");
    const t2 = t1 >= 0 ? entry.indexOf("\t", t1 + 1) : -1;
    if (t2 < 0) continue;
    const p = entry.slice(t2 + 1).replace(/\/+$/, "");
    if (!p) continue;
    const a = entry.slice(0, t1);
    const d = entry.slice(t1 + 1, t2);
    const isBinary = a === "-" || d === "-";
    const old = stats.get(p) ?? { add: 0, del: 0, binary: false };
    stats.set(p, {
      add: old.add + (isBinary ? 0 : (Number(a) || 0)),
      del: old.del + (isBinary ? 0 : (Number(d) || 0)),
      binary: old.binary || isBinary,
    });
  }
  return stats;
}

const ORIGIN_BASE_REF_PRIORITY = [
  "origin/development",
  "origin/develop",
  "origin/main",
  "origin/master",
  "origin/release",
  "origin/ci",
  "development",
  "develop",
  "main",
  "master",
  "release",
  "ci",
];

/**
 * Infer preferred target base refs from Gitflow-style branch path segments
 * (e.g. `user/prod/TICKET` -> `origin/master`/`origin/main`, `user/dev/TICKET` -> `origin/development`,
 * `user/release/TICKET` -> `origin/release`, `user/ci/TICKET` -> `origin/ci`).
 */
export function inferBranchBaseHintRefs(branch) {
  const clean = String(branch || "").trim();
  if (!clean || BASE_BRANCH_NAMES.has(clean)) return [];
  if (/(?:^|\/)(?:prod|production|hotfix|master|main)(?:\/|$)/i.test(clean)) {
    return ["origin/master", "origin/main", "master", "main"];
  }
  if (/(?:^|\/)(?:dev|develop|development)(?:\/|$)/i.test(clean)) {
    return ["origin/development", "origin/develop", "development", "develop"];
  }
  if (/(?:^|\/)(?:release|staging|stage)(?:\/|$)/i.test(clean)) {
    return ["origin/release", "release"];
  }
  if (/(?:^|\/)ci(?:\/|$)/i.test(clean)) {
    return ["origin/ci", "ci"];
  }
  return [];
}

/**
 * Resolve a repository's lock-free origin/base comparison reference (`merge-base HEAD <baseRef>`),
 * prioritizing explicit Gitflow branch hints, `origin/HEAD`, closest ancestor across multi-base
 * remote branches (`origin/development`, `origin/main`, `origin/master`, `origin/release`, `origin/ci`),
 * then local base branches, with automatic fallback to remote upstream or session `startHead`
 * when working directly on a base branch.
 */
export async function resolveRepoBaseRefWithExec(root, branch, headHash, on, execFn, opts = {}) {
  const readFlags = opts.readFlags || READ_GIT_FLAGS;
  const startHead = String(opts.startHead || "").trim();
  const cleanHead = String(headHash || "").trim();
  if (!cleanHead || typeof execFn !== "function") {
    return { hasHead: false, baseRef: "", baseHash: "", baseSource: "unborn" };
  }

  const git = (args) => execFn("git", [...readFlags, ...args], { cwd: root, on }).catch(() => null);
  const forEachArgs = [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin/development",
    "refs/remotes/origin/develop",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
    "refs/remotes/origin/release",
    "refs/remotes/origin/ci",
    "refs/heads/development",
    "refs/heads/develop",
    "refs/heads/main",
    "refs/heads/master",
    "refs/heads/release",
    "refs/heads/ci",
  ];
  const cleanBranch = String(branch || "").trim();
  const onBaseBranch = Boolean(cleanBranch && cleanBranch !== "HEAD" && BASE_BRANCH_NAMES.has(cleanBranch));
  if (onBaseBranch) {
    const remoteSame = `refs/remotes/origin/${cleanBranch}`;
    if (!forEachArgs.includes(remoteSame)) forEachArgs.push(remoteSame);
  }

  const [symRes, refsRes] = await Promise.all([
    git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
    git(forEachArgs),
  ]);

  const avail = new Set(
    (refsRes?.code === 0 ? String(refsRes.stdout || "") : "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const symShortRef = (() => {
    if (symRes?.code !== 0 || !symRes.stdout) return "";
    const fullRef = String(symRes.stdout).trim();
    return fullRef.startsWith("refs/remotes/") ? fullRef.slice("refs/remotes/".length) : fullRef;
  })();

  let matchedCandidateRef = "";

  if (onBaseBranch) {
    // Working directly on a base branch: anchor strictly to `origin/<branch>` (or `origin/HEAD` /
    // local `<branch>`) so working on `development` never floods with `origin/master..development`.
    const baseCands = [];
    const seenBase = new Set();
    const pushBase = (ref) => {
      const r = String(ref || "").trim();
      if (!r || seenBase.has(r)) return;
      seenBase.add(r);
      baseCands.push(r);
    };
    const remoteCurrent = `origin/${cleanBranch}`;
    if (avail.has(remoteCurrent)) pushBase(remoteCurrent);
    if (symShortRef) pushBase(symShortRef);
    for (const ref of ORIGIN_BASE_REF_PRIORITY) {
      if (ref.startsWith("origin/") && avail.has(ref)) pushBase(ref);
    }
    if (baseCands.length === 0 && avail.has(cleanBranch)) pushBase(cleanBranch);
    for (const ref of ORIGIN_BASE_REF_PRIORITY) {
      if (!ref.startsWith("origin/") && avail.has(ref)) pushBase(ref);
    }

    for (const cand of baseCands) {
      const mb = await git(["merge-base", "HEAD", cand]);
      const mbHash = mb?.code === 0 ? String(mb.stdout || "").trim() : "";
      if (!mbHash) continue;
      if (!matchedCandidateRef) matchedCandidateRef = cand;
      if (mbHash !== cleanHead) {
        return { hasHead: true, baseRef: cand, baseHash: mbHash, baseSource: "base" };
      }
      break;
    }
  } else {
    // Feature branch: prefer remote base refs when available, else local base refs.
    const remoteCands = [];
    const localCands = [];
    const seen = new Set();
    const pushCand = (ref, list) => {
      const r = String(ref || "").trim();
      if (!r || seen.has(r)) return;
      seen.add(r);
      list.push(r);
    };

    const hintRefs = inferBranchBaseHintRefs(cleanBranch);
    const hintSet = new Set(hintRefs);

    for (const ref of hintRefs) {
      if (ref.startsWith("origin/") && (avail.has(ref) || ref === symShortRef)) pushCand(ref, remoteCands);
    }
    if (symShortRef) pushCand(symShortRef, remoteCands);
    for (const ref of ORIGIN_BASE_REF_PRIORITY) {
      if (ref.startsWith("origin/") && avail.has(ref)) pushCand(ref, remoteCands);
    }

    for (const ref of hintRefs) {
      if (!ref.startsWith("origin/") && avail.has(ref)) pushCand(ref, localCands);
    }
    for (const ref of ORIGIN_BASE_REF_PRIORITY) {
      if (!ref.startsWith("origin/") && avail.has(ref)) pushCand(ref, localCands);
    }

    const activeTier = remoteCands.length > 0 ? remoteCands : localCands;
    if (activeTier.length > 0) {
      const mbResults = await Promise.all(
        activeTier.map(async (cand, idx) => {
          const mb = await git(["merge-base", "HEAD", cand]);
          const mbHash = mb?.code === 0 ? String(mb.stdout || "").trim() : "";
          return { cand, idx, mbHash, hinted: hintSet.has(cand) };
        }),
      );
      const valid = mbResults.filter((r) => Boolean(r.mbHash));
      if (valid.length > 0) {
        matchedCandidateRef = valid[0].cand;

        // 1. Explicit Gitflow branch hint (e.g. `user/prod/TICKET` -> `origin/master`):
        //    Honor the hinted target base even if `HEAD` was already merged into another base branch
        //    such as `origin/development`.
        const hintedValid = valid.filter((r) => r.hinted);
        if (hintedValid.length > 0) {
          const hintedAhead = hintedValid.find((r) => r.mbHash !== cleanHead);
          if (hintedAhead) {
            return { hasHead: true, baseRef: hintedAhead.cand, baseHash: hintedAhead.mbHash, baseSource: "base" };
          }
          // Branch is already at/merged into its own hinted target base -> fall through to startHead/HEAD.
        } else {
          // 2. Unhinted feature branch: if `HEAD` is already at or an ancestor of any base branch
          //    (e.g. freshly cut off `origin/development` with 0 commits), do NOT diff against an older base.
          const mergedIntoBase = valid.find((r) => r.mbHash === cleanHead);
          if (!mergedIntoBase) {
            const uniqueHashes = Array.from(new Set(valid.map((r) => r.mbHash)));
            if (uniqueHashes.length === 1) {
              return { hasHead: true, baseRef: valid[0].cand, baseHash: valid[0].mbHash, baseSource: "base" };
            }
            // Multiple distinct merge-bases (e.g. `origin/development` vs `origin/master`):
            // pick the closest ancestor (smallest positive commit count in `<mbHash>..HEAD`).
            const distEntries = await Promise.all(
              uniqueHashes.map(async (mbHash) => {
                const cnt = await git(["rev-list", "--count", `${mbHash}..HEAD`]);
                const n = cnt?.code === 0 ? parseInt(String(cnt.stdout || "").trim(), 10) : NaN;
                return [mbHash, Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY];
              }),
            );
            const distByHash = new Map(distEntries);
            let best = valid[0];
            let bestDist = distByHash.get(best.mbHash) ?? Number.POSITIVE_INFINITY;
            for (let i = 1; i < valid.length; i += 1) {
              const cand = valid[i];
              const d = distByHash.get(cand.mbHash) ?? Number.POSITIVE_INFINITY;
              if (d < bestDist) {
                best = cand;
                bestDist = d;
              }
            }
            return { hasHead: true, baseRef: best.cand, baseHash: best.mbHash, baseSource: "base" };
          }
        }
      }
    }
  }

  // Fallback for commits made directly on a base branch (including pushed commits or local-only repos):
  if (startHead && startHead !== cleanHead) {
    const anc = await git(["merge-base", "--is-ancestor", startHead, "HEAD"]);
    if (anc?.code === 0) {
      return { hasHead: true, baseRef: "session start", baseHash: startHead, baseSource: "session" };
    }
  }

  return {
    hasHead: true,
    baseRef: matchedCandidateRef || (cleanBranch && cleanBranch !== "HEAD" ? cleanBranch : "HEAD"),
    baseHash: cleanHead,
    baseSource: matchedCandidateRef ? "base" : "head",
  };
}

/**
 * Extract stdout text cleanly from a Herdr `hc(["read", ...])` result (`ExecResult` or string).
 */
export function extractHcReadText(res) {
  if (typeof res === "string") return res;
  if (res && res.code === 0 && typeof res.stdout === "string") return res.stdout;
  return "";
}

/**
 * Select visible session working-tree paths that should be passed to `git add -- <paths>`.
 * Already-staged deletions (`xy === "D "`, e.g. `git rm` or the deleted half of `git mv`)
 * are omitted because `git add -- <path>` exits 128 when a file exists in neither the index
 * nor the working tree; the deletion is already staged for `git commit`.
 */
export function selectPathsToStageForCommit(workingFiles) {
  if (!Array.isArray(workingFiles) || workingFiles.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const entry of workingFiles) {
    const path = String(entry?.path || entry?.relFile || "").trim();
    if (!path || seen.has(path)) continue;
    if (entry?.stagedDeletion === true || entry?.xy === "D ") continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Inspect a repository's unified session diff against its origin/base branch (`git diff <baseHash>`
 * merged with untracked `??` files), returning both unified diff files and raw working-tree entries
 * for baseline tracking and dirty-only commits.
 */
export async function collectServiceSessionSnapshot(service, on, opts = {}, deps = {}) {
  const execFn = deps.exec;
  const fsDeps = deps.fsPromises || fsPromises;
  const readFlags = deps.readFlags || READ_GIT_FLAGS;
  const baselineRepo = opts?.baselineRepo || null;

  try {
    if (typeof execFn !== "function") throw new Error("Missing exec helper");
    const git = (args) => execFn("git", [...readFlags, ...args], { cwd: service.root, on });
    const [status, head] = await Promise.all([
      git(["status", "--porcelain=v1", "-b", "-z", "--no-renames", "--untracked-files=normal"]),
      git(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => ({ code: 1, stdout: "", stderr: "" })),
    ]);
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

    const dirEntries = [];
    const workingMap = new Map();
    for (const entry of rawEntries) {
      const xy = entry.slice(0, 2);
      const p = entry.slice(3);
      if (!p) continue;
      if (xy === "??" && p.endsWith("/")) {
        dirEntries.push(p.replace(/\/+$/, ""));
      } else {
        const cleanP = p.replace(/\/+$/, "");
        workingMap.set(cleanP, { xy, status: normalizeGitStatusMark(xy), fresh: xy === "??" });
      }
    }
    if (dirEntries.length > 0) {
      const ls = await git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...dirEntries]).catch(() => null);
      if (ls?.code === 0 && ls.stdout) {
        for (const expandedPath of ls.stdout.split("\0").filter(Boolean)) {
          const cleanP = expandedPath.replace(/\/+$/, "");
          if (cleanP && !workingMap.has(cleanP)) {
            workingMap.set(cleanP, { xy: "??", status: "A", fresh: true });
          }
        }
      }
    }

    const serviceHasHead = head?.code === 0 && Boolean(String(head.stdout || "").trim());
    const headHash = serviceHasHead ? String(head.stdout || "").trim() : "";

    const baseInfo = await resolveRepoBaseRefWithExec(
      service.root,
      branch,
      headHash,
      on,
      execFn,
      { readFlags, startHead: baselineRepo?.startHead || "" },
    );

    const hasBaselineDirty = Boolean(
      baselineRepo?.dirtyFiles && Object.keys(baselineRepo.dirtyFiles).length > 0,
    );
    const needCommittedPaths = Boolean(
      (hasBaselineDirty || (!baselineRepo && workingMap.size > 0)) &&
      baseInfo.hasHead &&
      baseInfo.baseHash &&
      baseInfo.baseHash !== headHash,
    );
    const needRevListCount = Boolean(
      parsedAhead === null && baseInfo.hasHead && baseInfo.baseHash && baseInfo.baseHash !== headHash,
    );

    let nameStatusRes;
    let numstatRes;
    let committedNamesRes = null;
    let revListRes = null;

    if (baseInfo.hasHead && baseInfo.baseHash) {
      const tasks = [
        git(["diff", baseInfo.baseHash, "--name-status", "-z", "--no-renames"]),
        git(["diff", baseInfo.baseHash, "--numstat", "-z", "--no-renames"]),
        needCommittedPaths
          ? git(["diff", "--name-only", "-z", baseInfo.baseHash, "HEAD"]).catch(() => null)
          : Promise.resolve(null),
        needRevListCount
          ? git(["rev-list", "--count", `${baseInfo.baseHash}..HEAD`]).catch(() => null)
          : Promise.resolve(null),
      ];
      [nameStatusRes, numstatRes, committedNamesRes, revListRes] = await Promise.all(tasks);
    } else {
      [nameStatusRes, numstatRes] = await Promise.all([
        git(["diff", "--cached", "--name-status", "-z", "--no-renames"]),
        git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
      ]);
    }

    if (nameStatusRes?.code !== 0) {
      throw new Error(nameStatusRes?.stderr || `diff name-status failed on ${service.name}`);
    }
    if (numstatRes?.code !== 0) {
      throw new Error(numstatRes?.stderr || `diff numstat failed on ${service.name}`);
    }

    const nameStatusMap = parseNameStatusZ(nameStatusRes.stdout);
    const numstatMap = parseNumstatZ(numstatRes.stdout);
    const committedPaths = new Set();
    if (committedNamesRes?.code === 0 && committedNamesRes.stdout) {
      for (const p of committedNamesRes.stdout.split("\0").filter(Boolean)) {
        committedPaths.add(normBaselineRel(p));
      }
    }

    // Deduplicated unified paths: tracked diff vs baseHash + untracked (??) files.
    const unifiedPaths = new Set(nameStatusMap.keys());
    for (const [p, info] of workingMap) {
      if (info.fresh) unifiedPaths.add(p);
    }

    const statCache = new Map();
    const getFileStat = async (path, statusForStat, diffStatForSsh) => {
      const cacheKey = `${path}::${statusForStat}`;
      if (statCache.has(cacheKey)) return statCache.get(cacheKey);
      const res = await statFileEntry(
        join(service.root, path),
        statusForStat,
        on,
        fsDeps,
        diffStatForSsh ? { diffStat: diffStatForSsh } : null,
      );
      statCache.set(cacheKey, res);
      return res;
    };

    const sortedPaths = Array.from(unifiedPaths).sort((a, b) => a.localeCompare(b));
    const files = await Promise.all(
      sortedPaths.map(async (path) => {
        const workingInfo = workingMap.get(path) || null;
        const trackedStatus = nameStatusMap.get(path) || "";
        // If `path` already exists in `nameStatusMap` (e.g. existed at `baseHash`, deleted in HEAD,
        // and recreated untracked on disk), `git diff <baseHash>` already compares `<baseHash>` directly
        // against the working file — treat only brand-new paths absent from `<baseHash>` as `fresh`.
        const fresh = Boolean(workingInfo?.fresh && !trackedStatus);
        const status = fresh
          ? "A"
          : (trackedStatus || workingInfo?.status || "M");
        const lineStat = fresh
          ? await countUntrackedFileLines(join(service.root, path), on, fsDeps)
          : (numstatMap.get(path) ?? { add: 0, del: 0, binary: false });
        const { sig, mtimeMs } = await getFileStat(path, status, lineStat);
        return {
          key: `${service.id}::${path}`,
          serviceId: service.id,
          serviceName: service.name,
          relPrefix: service.relPath,
          repoRoot: service.root,
          hasHead: baseInfo.hasHead,
          headHash,
          baseRef: baseInfo.baseRef,
          baseHash: baseInfo.baseHash,
          baseSource: baseInfo.baseSource,
          path,
          relFile: path,
          displayPath: service.relPath ? `${service.relPath}/${path}` : (service.isSibling ? `${service.name}/${path}` : path),
          status,
          workingStatus: workingInfo ? workingInfo.status : "",
          inWorkingTree: Boolean(workingInfo),
          fresh,
          sig,
          mtimeMs,
          add: lineStat.add || 0,
          del: lineStat.del || 0,
          binary: Boolean(lineStat.binary),
        };
      }),
    );

    const workingFiles = await Promise.all(
      Array.from(workingMap.entries()).map(async ([path, info]) => {
        const lineStat = info.fresh
          ? (files.find((f) => f.path === path) || { add: 0, del: 0, binary: false })
          : (numstatMap.get(path) ?? { add: 0, del: 0, binary: false });
        const { sig, mtimeMs } = await getFileStat(path, info.status, lineStat);
        return {
          path,
          relFile: path,
          xy: info.xy,
          stagedDeletion: info.xy === "D ",
          status: info.status,
          workingStatus: info.status,
          fresh: info.fresh,
          sig,
          mtimeMs,
        };
      }),
    );

    let aheadCount = 0;
    if (parsedAhead !== null) {
      aheadCount = parsedAhead;
    } else if (revListRes?.code === 0) {
      const n = parseInt(String(revListRes.stdout || "").trim(), 10);
      if (!Number.isNaN(n)) aheadCount = n;
    }

    service.workingCount = workingFiles.length;
    service.aheadCount = aheadCount;
    service.branch = branch;
    service.baseRef = baseInfo.baseRef;
    service.baseHash = baseInfo.baseHash;

    return {
      service,
      files,
      workingFiles,
      committedPaths,
      branch,
      headHash,
      hasHead: baseInfo.hasHead,
      baseRef: baseInfo.baseRef,
      baseHash: baseInfo.baseHash,
      baseSource: baseInfo.baseSource,
      rawCount: workingFiles.length,
      aheadCount,
      touched: files.length > 0,
    };
  } catch (e) {
    service.workingCount = 0;
    service.aheadCount = 0;
    service.branch = service.branch || "HEAD";
    return {
      service,
      files: [],
      workingFiles: [],
      committedPaths: new Set(),
      branch: service.branch,
      headHash: "",
      hasHead: false,
      baseRef: "",
      baseHash: "",
      baseSource: "error",
      rawCount: 0,
      aheadCount: 0,
      touched: false,
      error: e,
    };
  }
}

function normalizeMarkdownRelPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function joinRepoFilePath(repoRoot, relPath) {
  const rawRoot = String(repoRoot || "");
  const cleanRoot = rawRoot === "/" ? "/" : rawRoot.replace(/[\\/]+$/, "");
  const cleanRel = normalizeMarkdownRelPath(relPath);
  if (!cleanRoot) return cleanRel;
  if (!cleanRel) return cleanRoot;
  return cleanRoot === "/" ? `/${cleanRel}` : `${cleanRoot}/${cleanRel}`;
}

/**
 * Resolve how a Markdown file snapshot should be loaded for the unified session review viewer
 * (working-tree file read for existing files, lock-free `git show <baseHash>:<path>` for deletions).
 */
export function resolveReviewMarkdownSourceSpec(file, opts = {}) {
  const rawStatus = String(file?.status || "M").trim().toUpperCase();
  const plan = getDiffMarkdownPlan(rawStatus);
  if (!file || typeof file !== "object") {
    return {
      kind: "unavailable",
      mode: plan.mode,
      isDeleted: plan.isDeleted,
      notice: plan.notice,
      targetPath: "",
      error: "No file selected.",
    };
  }

  const repoRoot = String(file.repoRoot || "").trim();
  const filePath = normalizeMarkdownRelPath(file.path || file.relFile || "");
  const oldPath = normalizeMarkdownRelPath(file.oldPath || opts?.oldPath || "");
  const targetPath = plan.isDeleted ? (oldPath || filePath) : filePath;

  if (!repoRoot || !targetPath) {
    return {
      kind: "unavailable",
      mode: plan.mode,
      isDeleted: plan.isDeleted,
      notice: plan.notice,
      targetPath,
      error: "File location is unavailable.",
    };
  }

  if (file.binary === true) {
    return {
      kind: "unavailable",
      mode: plan.mode,
      isDeleted: plan.isDeleted,
      notice: plan.notice,
      targetPath,
      error: "Binary file — Markdown preview is unavailable.",
    };
  }

  const readFlags = Array.isArray(opts?.readFlags) && opts.readFlags.length > 0
    ? opts.readFlags
    : READ_GIT_FLAGS;
  const on = opts?.on ?? null;

  if (plan.isDeleted) {
    if (file.fresh === true || file.hasHead === false) {
      return {
        kind: "unavailable",
        mode: plan.mode,
        isDeleted: true,
        notice: plan.notice,
        targetPath,
        error: "Previous version is unavailable (file is untracked or repository has no HEAD commit).",
      };
    }
    const baseRef = String(file.baseHash || opts?.baseHash || "HEAD").trim() || "HEAD";
    const refSpec = `${baseRef}:${targetPath}`;
    return {
      kind: "git",
      mode: plan.mode,
      isDeleted: true,
      notice: plan.notice,
      cwd: repoRoot,
      on,
      refSpec,
      targetPath,
      args: [...readFlags, "show", refSpec],
      unavailableMessage: "Previous version is unavailable (file is untracked or not present at comparison base).",
    };
  }

  return {
    kind: "file",
    mode: plan.mode,
    isDeleted: false,
    notice: plan.notice,
    cwd: repoRoot,
    on,
    absPath: joinRepoFilePath(repoRoot, filePath),
    targetPath: filePath,
    unavailableMessage: "Cannot preview this Markdown file (unavailable, too large, or unreadable).",
  };
}

/** Build a stable per-file identity key so file/base switches reset Markdown preview cleanly. */
export function computeViewerMarkdownFileId(file) {
  if (!file || !file.key) return "";
  return `${file.key}::${String(file.baseHash || "")}`;
}

/** Compute a revision token for Markdown snapshot caching and unique GPUI TextView element IDs. */
export function computeReviewMarkdownLoadToken(
  file,
  { requestSeq = 0, reloadNonce = 0 } = {},
) {
  const rNonce = Number(reloadNonce) || 0;
  if (!file || typeof file !== "object") return `0|r${rNonce}`;
  const status = String(file.status || "M").trim().toUpperCase();
  const oldPath = normalizeMarkdownRelPath(file.oldPath || "");
  const baseHash = String(file.baseHash || "");
  const sig = String(file.sig || "");
  const mtimeMs = Number(file.mtimeMs) || 0;
  const needsSeqFallback = !mtimeMs && !/\d/.test(sig);
  const seqPart = needsSeqFallback ? `|q${Number(requestSeq) || 0}` : "";
  return `${status}|${oldPath}|${baseHash}|${file.fresh ? 1 : 0}|${sig}|${mtimeMs}|${Number(file.add) || 0}|${Number(file.del) || 0}${seqPart}|r${rNonce}`;
}

/** Build a bounded-cache key scoped by repo, baseHash, file paths, status, and load token. */
export function buildReviewMarkdownCacheKey(
  file,
  { loadToken = "" } = {},
) {
  if (!file || typeof file !== "object") return "";
  const repo = normPathStr(file.repoRoot || "");
  const baseHash = String(file.baseHash || "");
  const path = normalizeMarkdownRelPath(file.path || file.relFile || "");
  const oldPath = normalizeMarkdownRelPath(file.oldPath || "");
  const status = String(file.status || "M").trim().toUpperCase();
  return `${repo}|${baseHash}|${path}|${oldPath}|${status}|${String(loadToken || "")}`;
}

/** Guard raw Markdown content against null reads and binary NUL bytes. */
export function validateMarkdownTextContent(text, unavailableMessage = "Cannot preview this Markdown file.") {
  if (typeof text !== "string") {
    return { ok: false, error: unavailableMessage };
  }
  if (text.includes("\0")) {
    return { ok: false, error: "Binary file — Markdown preview is unavailable." };
  }
  return { ok: true, text };
}

/** Translate `git show` stderr failures into concise, user-readable messages. */
export function formatGitShowMarkdownError(stderr, spec = {}) {
  const msg = String(stderr || "").trim();
  const lower = msg.toLowerCase();
  if (spec?.isDeleted) {
    if (
      lower.includes("exists on disk, but not in") ||
      lower.includes("does not exist in") ||
      lower.includes("not in 'head'") ||
      lower.includes("invalid object name")
    ) {
      return "Previous version is unavailable (file is untracked or not present at comparison base).";
    }
  }
  const firstLine = msg ? msg.split(/\r?\n/)[0] : "";
  if (spec?.unavailableMessage) {
    return firstLine ? `${spec.unavailableMessage} (${firstLine})` : spec.unavailableMessage;
  }
  return firstLine || "Markdown snapshot is unavailable.";
}

/**
 * Build cumulative vertical offsets and total height for a variable-height diff row list.
 */
export function buildVariableRowLayout(heights) {
  const src = Array.isArray(heights) ? heights : [];
  const len = src.length;
  const normalized = new Array(len);
  const offsets = new Array(len);
  let totalHeight = 0;
  for (let i = 0; i < len; i += 1) {
    const raw = Number(src[i]);
    const h = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 20;
    normalized[i] = h;
    offsets[i] = totalHeight;
    totalHeight += h;
  }
  return {
    heights: normalized,
    offsets,
    totalHeight,
  };
}

/**
 * Compute visible row slice `[start, end)` and pixel top shift for a variable-height virtualized diff viewport.
 */
export function computeVariableWindowSlice(layout, scrollPx = 0, viewportHeightPx = 560, overscan = 2) {
  const heights = Array.isArray(layout?.heights) ? layout.heights : [];
  const offsets = Array.isArray(layout?.offsets) ? layout.offsets : [];
  const len = heights.length;
  const totalHeight = Math.max(0, Number(layout?.totalHeight) || 0);
  const vpH = Math.max(20, Math.round(Number(viewportHeightPx) || 560));
  const maxScrollPx = Math.max(0, totalHeight - vpH);
  const clampedScrollPx = Math.max(0, Math.min(maxScrollPx, Math.round(Number(scrollPx) || 0)));

  if (len === 0) {
    return {
      start: 0,
      end: 0,
      scrollPx: 0,
      maxScrollPx: 0,
      totalHeight: 0,
      viewportHeight: vpH,
      topOffsetPx: 0,
    };
  }

  // Binary search first row whose bottom edge extends below `clampedScrollPx`.
  let lo = 0;
  let hi = len - 1;
  let firstVisible = len;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bottom = offsets[mid] + heights[mid];
    if (bottom > clampedScrollPx) {
      firstVisible = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (firstVisible >= len) {
    firstVisible = len - 1;
  }

  const viewBottom = clampedScrollPx + vpH;
  let lastVisible = firstVisible + 1;
  while (lastVisible < len && offsets[lastVisible] < viewBottom) {
    lastVisible += 1;
  }

  const pad = Math.max(0, Math.floor(Number(overscan) || 0));
  const start = Math.max(0, firstVisible - pad);
  const end = Math.min(len, lastVisible + pad);
  const topOffsetPx = offsets[start] - clampedScrollPx;

  return {
    start,
    end,
    scrollPx: clampedScrollPx,
    maxScrollPx,
    totalHeight,
    viewportHeight: vpH,
    topOffsetPx,
  };
}

/**
 * Compute clamped scroll offset in pixels to bring `rowIndex` into view (`top`, `center`, or `nearest`).
 */
export function computeDiffScrollOffsetForRow(
  layout,
  rowIndex,
  viewportHeightPx = 560,
  strategy = "top",
  currentScrollPx = 0,
) {
  const heights = Array.isArray(layout?.heights) ? layout.heights : [];
  const offsets = Array.isArray(layout?.offsets) ? layout.offsets : [];
  const len = heights.length;
  if (len === 0) return 0;

  const vpH = Math.max(20, Math.round(Number(viewportHeightPx) || 560));
  const totalHeight = Math.max(0, Number(layout?.totalHeight) || 0);
  const maxScrollPx = Math.max(0, totalHeight - vpH);
  const idx = Math.max(0, Math.min(len - 1, Math.floor(Number(rowIndex) || 0)));
  const rowTop = offsets[idx];
  const rowBottom = rowTop + heights[idx];

  let target;
  if (strategy === "center") {
    target = Math.round(rowTop - vpH * 0.35);
  } else if (strategy === "nearest") {
    const cur = Math.max(0, Math.min(maxScrollPx, Math.round(Number(currentScrollPx) || 0)));
    if (rowTop >= cur && rowBottom <= cur + vpH) {
      return cur;
    }
    target = rowTop < cur ? rowTop : rowBottom - vpH;
  } else {
    target = rowTop;
  }

  return Math.max(0, Math.min(maxScrollPx, Math.round(target)));
}

/**
 * Compute proportional scrollbar metrics for the variable-height diff viewport.
 */
export function computeDiffScrollbarMetrics(totalHeightPx, scrollPx, viewportHeightPx, trackHeightPx) {
  const totalHeight = Math.max(0, Math.round(Number(totalHeightPx) || 0));
  const vpH = Math.max(20, Math.round(Number(viewportHeightPx) || 560));
  const trackHeight = Math.max(24, Math.round(Number(trackHeightPx) || vpH));
  if (totalHeight <= vpH) {
    return {
      visible: false,
      trackHeight,
      thumbHeight: trackHeight,
      thumbTop: 0,
      maxScrollPx: 0,
    };
  }
  const rawThumb = Math.round((vpH / totalHeight) * trackHeight);
  const thumbHeight = Math.max(24, Math.min(trackHeight, rawThumb));
  const maxScrollPx = Math.max(1, totalHeight - vpH);
  const clampedScroll = Math.max(0, Math.min(maxScrollPx, Math.round(Number(scrollPx) || 0)));
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
  const thumbTop = Math.round((clampedScroll / maxScrollPx) * maxThumbTop);
  return {
    visible: true,
    trackHeight,
    thumbHeight,
    thumbTop,
    maxScrollPx,
  };
}

/**
 * Convert GPUI scroll wheel event deltas into pixel scroll deltas (positive deltaY scrolls up -> negative scrollPx delta).
 */
export function resolveDiffWheelDeltaPx(deltaY, deltaLinesY = 0, lineHeightPx = 20) {
  const lh = Math.max(12, Math.round(Number(lineHeightPx) || 20));
  const linesY = Number(deltaLinesY);
  if (Number.isFinite(linesY) && linesY !== 0) {
    const scaled = -Math.round(linesY * lh * 3);
    return scaled !== 0 ? scaled : (linesY > 0 ? -lh : lh);
  }
  const dy = Number(deltaY);
  if (Number.isFinite(dy) && dy !== 0) {
    const px = -Math.round(dy);
    return px !== 0 ? px : (dy > 0 ? -1 : 1);
  }
  return 0;
}

/**
 * Map a scrollbar thumb top coordinate onto a clamped pixel scroll offset.
 */
export function resolveDiffScrollbarDragPx(thumbTopPx, trackHeightPx, thumbHeightPx, maxScrollPx) {
  const maxScroll = Math.max(0, Math.round(Number(maxScrollPx) || 0));
  if (maxScroll === 0) return 0;
  const trackH = Math.max(24, Math.round(Number(trackHeightPx) || 200));
  const thumbH = Math.max(1, Math.min(trackH, Math.round(Number(thumbHeightPx) || 24)));
  const maxThumbTop = Math.max(1, trackH - thumbH);
  const clampedThumbTop = Math.max(0, Math.min(maxThumbTop, Number(thumbTopPx) || 0));
  return Math.round((clampedThumbTop / maxThumbTop) * maxScroll);
}

export const DEFAULT_CONTEXT_EXPAND_STEP = 20;
export const MAX_CONTEXT_SOURCE_BYTES = 600_000;

const DIFF_HUNK_FULL_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Split raw file text into 0-indexed lines without CRs, capping memory for QuickJS safety.
 */
export function splitSourceFileLines(text, maxBytes = MAX_CONTEXT_SOURCE_BYTES) {
  if (typeof text !== "string" || text.includes("\0")) return null;
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.floor(Number(maxBytes))
    : MAX_CONTEXT_SOURCE_BYTES;
  const bounded = text.length > limit ? text.slice(0, limit) : text;
  if (!bounded) return [];
  const withoutFinalLf = bounded.endsWith("\n") ? bounded.slice(0, -1) : bounded;
  const raw = withoutFinalLf.split("\n");
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].endsWith("\r")) raw[i] = raw[i].slice(0, -1);
  }
  return raw;
}

/**
 * Annotate diff hunk rows (`kind === "@"`) with exact per-gap hidden line ranges
 * (`top`, `between`, and optional `bottom`) so each collapsed block expands independently.
 */
export function annotateDiffGaps(rows, { canExpandBottom = false, totalFileLines = null } = {}) {
  const src = Array.isArray(rows) ? rows : [];
  if (src.length === 0) return [];

  const out = new Array(src.length);
  let hunkCount = 0;
  let prevNewEnd = 0;
  let lastOldDelta = 0;
  let hasTruncationNotice = false;
  let hasRealHunk = false;
  let currentHunkNewEnd = 0;

  for (let i = 0; i < src.length; i += 1) {
    const row = src[i];
    if (!row || row.kind !== "@") {
      out[i] = row;
      if (row && (row.kind === " " || row.kind === "+") && Number.isFinite(row.number)) {
        if (row.number > currentHunkNewEnd) currentHunkNewEnd = row.number;
      }
      continue;
    }

    const text = String(row.text || "");
    const m = DIFF_HUNK_FULL_RE.exec(text);
    if (!m) {
      out[i] = { ...row, gap: null };
      continue;
    }

    const oldStart = Number(m[1]) || 0;
    const oldCount = m[2] !== undefined ? Number(m[2]) : 1;
    const newStart = Number(m[3]) || 0;
    const newCount = m[4] !== undefined ? Number(m[4]) : 1;

    if (oldStart === 0 && newStart === 0 && oldCount === 0 && newCount === 0) {
      hasTruncationNotice = true;
      out[i] = { ...row, gap: null };
      continue;
    }

    if (hunkCount > 0) {
      prevNewEnd = Math.max(prevNewEnd, currentHunkNewEnd);
    }

    let gap = null;
    if (newCount > 0 && newStart > 0) {
      hasRealHunk = true;
      if (hunkCount === 0) {
        if (newStart > 1) {
          gap = {
            id: "gap-top",
            position: "top",
            startLine: 1,
            endLine: newStart - 1,
            oldDelta: oldStart - newStart,
          };
        }
      } else if (newStart - 1 >= prevNewEnd + 1) {
        gap = {
          id: `gap-between-${hunkCount}`,
          position: "between",
          startLine: prevNewEnd + 1,
          endLine: newStart - 1,
          oldDelta: oldStart - newStart,
        };
      }
      currentHunkNewEnd = newStart + newCount - 1;
      lastOldDelta = (oldStart + oldCount) - (newStart + newCount);
      hunkCount += 1;
    } else if (newStart > 0 && hunkCount > 0 && newStart >= prevNewEnd + 1) {
      // Pure deletion hunk inside a modified file (newCount === 0, newStart is line immediately preceding deletion).
      hasRealHunk = true;
      gap = {
        id: `gap-between-${hunkCount}`,
        position: "between",
        startLine: prevNewEnd + 1,
        endLine: newStart,
        oldDelta: oldStart - newStart,
      };
      currentHunkNewEnd = newStart;
      lastOldDelta = (oldStart + oldCount) - newStart;
      hunkCount += 1;
    }

    out[i] = { ...row, gap };
  }

  const finalNewEnd = Math.max(prevNewEnd, currentHunkNewEnd);
  if (canExpandBottom && hasRealHunk && !hasTruncationNotice && finalNewEnd > 0) {
    if (Number.isFinite(totalFileLines)) {
      if (totalFileLines > finalNewEnd) {
        out.push({
          kind: "@",
          text: "",
          gap: {
            id: "gap-bottom",
            position: "bottom",
            startLine: finalNewEnd + 1,
            endLine: totalFileLines,
            oldDelta: lastOldDelta,
          },
        });
      }
    } else {
      out.push({
        kind: "@",
        text: "",
        gap: {
          id: "gap-bottom",
          position: "bottom",
          startLine: finalNewEnd + 1,
          endLine: null,
          oldDelta: lastOldDelta,
        },
      });
    }
  }

  return out;
}

/**
 * Resolve any open-ended trailing bottom gap once total file line count is known.
 */
export function syncBottomGapWithTotalLines(rows, totalFileLines) {
  if (!Array.isArray(rows) || rows.length === 0 || !Number.isFinite(totalFileLines)) {
    return rows;
  }
  const lastIdx = rows.length - 1;
  const last = rows[lastIdx];
  if (!last || last.kind !== "@" || last.gap?.position !== "bottom") {
    return rows;
  }
  if (last.gap.endLine === totalFileLines) {
    return rows;
  }
  if (last.gap.startLine > totalFileLines) {
    return rows.slice(0, lastIdx);
  }
  const next = rows.slice();
  next[lastIdx] = {
    ...last,
    gap: {
      ...last.gap,
      endLine: totalFileLines,
    },
  };
  return next;
}

/**
 * Expand a single collapsed diff gap (`up`, `down`, or `all`) without touching sibling gaps,
 * returning exact anchor indices so the caller can preserve visual scroll position pixel-for-pixel.
 */
export function expandDiffGapInRows(
  rows,
  gapIndex,
  direction,
  sourceLines,
  { step = DEFAULT_CONTEXT_EXPAND_STEP, filePath = "", anchorPreference = "below" } = {},
) {
  const src = Array.isArray(rows) ? rows : [];
  if (!Number.isInteger(gapIndex) || gapIndex < 0 || gapIndex >= src.length) {
    return { rows: src, changed: false, insertedCount: 0, removedGap: false, oldAnchorIndex: 0, newAnchorIndex: 0, remainingGap: null };
  }
  const gapRow = src[gapIndex];
  const gap = gapRow?.gap;
  if (!gap || !Array.isArray(sourceLines)) {
    return { rows: src, changed: false, insertedCount: 0, removedGap: false, oldAnchorIndex: gapIndex, newAnchorIndex: gapIndex, remainingGap: gap || null };
  }

  const totalLines = sourceLines.length;
  const startLine = Math.max(1, Math.floor(Number(gap.startLine) || 1));
  const endLine = gap.endLine != null
    ? Math.min(Math.floor(Number(gap.endLine)), totalLines)
    : totalLines;

  if (endLine < startLine) {
    const nextRows = [...src.slice(0, gapIndex), ...src.slice(gapIndex + 1)];
    const anchor = Math.max(0, gapIndex - 1);
    return {
      rows: nextRows,
      changed: true,
      insertedCount: 0,
      removedGap: true,
      oldAnchorIndex: anchor,
      newAnchorIndex: anchor,
      remainingGap: null,
    };
  }

  const safeStep = Math.max(1, Math.floor(Number(step) || DEFAULT_CONTEXT_EXPAND_STEP));
  const available = endLine - startLine + 1;
  let effDir;
  if (gap.position === "top") {
    effDir = direction === "all" ? "all" : "up";
  } else if (gap.position === "bottom") {
    effDir = direction === "all" ? "all" : "down";
  } else {
    effDir = direction === "down" || direction === "up" || direction === "all" ? direction : "up";
  }

  let sliceStart;
  let sliceEnd;
  let remainingGap = null;
  if (effDir === "all" || available <= safeStep) {
    sliceStart = startLine;
    sliceEnd = endLine;
    remainingGap = null;
  } else if (effDir === "up") {
    sliceStart = endLine - safeStep + 1;
    sliceEnd = endLine;
    remainingGap = { ...gap, startLine, endLine: sliceStart - 1 };
  } else {
    sliceStart = startLine;
    sliceEnd = startLine + safeStep - 1;
    remainingGap = { ...gap, startLine: sliceEnd + 1, endLine };
  }

  const ext = getFileExt(filePath);
  const mdState = isMarkdownExt(ext) ? createMarkdownState() : null;
  if (mdState) {
    for (let priorLine = 1; priorLine < sliceStart; priorLine += 1) {
      const priorRaw = sourceLines[priorLine - 1] ?? "";
      advanceMarkdownState(expandCodeTabs(priorRaw || " "), mdState);
    }
  }
  const newContextRows = [];
  for (let lineNo = sliceStart; lineNo <= sliceEnd; lineNo += 1) {
    const raw = sourceLines[lineNo - 1] ?? "";
    const code = expandCodeTabs(raw || " ");
    newContextRows.push({
      kind: " ",
      number: lineNo,
      text: code,
      tokens: tokenizeDiffLine(code, ext, mdState),
      expandedContext: true,
    });
  }

  let nextRows;
  if (!remainingGap) {
    nextRows = [...src.slice(0, gapIndex), ...newContextRows, ...src.slice(gapIndex + 1)];
  } else if (effDir === "up") {
    const updatedGapRow = { ...gapRow, gap: remainingGap };
    nextRows = [...src.slice(0, gapIndex), updatedGapRow, ...newContextRows, ...src.slice(gapIndex + 1)];
  } else {
    const updatedGapRow = { ...gapRow, gap: remainingGap };
    nextRows = [...src.slice(0, gapIndex), ...newContextRows, updatedGapRow, ...src.slice(gapIndex + 1)];
  }

  const hasBelow = gapIndex + 1 < src.length;
  const hasAbove = gapIndex > 0;
  let pinBelow;
  if (gap.position === "top") {
    pinBelow = hasBelow;
  } else if (gap.position === "bottom") {
    pinBelow = false;
  } else if (effDir === "up") {
    pinBelow = hasBelow;
  } else if (effDir === "down") {
    pinBelow = false;
  } else {
    pinBelow = anchorPreference === "below" && hasBelow;
  }

  let oldAnchorIndex;
  let newAnchorIndex;
  if (pinBelow) {
    oldAnchorIndex = gapIndex + 1;
    newAnchorIndex = oldAnchorIndex + newContextRows.length - (remainingGap ? 0 : 1);
  } else if (hasAbove) {
    oldAnchorIndex = gapIndex - 1;
    newAnchorIndex = oldAnchorIndex;
  } else {
    oldAnchorIndex = 0;
    newAnchorIndex = 0;
  }

  return {
    rows: nextRows,
    changed: true,
    insertedCount: newContextRows.length,
    removedGap: remainingGap === null,
    oldAnchorIndex,
    newAnchorIndex,
    remainingGap,
  };
}

/**
 * Compute new scrollPx that keeps `oldAnchorIndex` -> `newAnchorIndex` at the exact same
 * screen Y coordinate (`newOffset - newScrollPx === oldOffset - oldScrollPx`).
 */
export function computeAnchorPreservedScrollPx(
  oldLayout,
  newLayout,
  oldScrollPx,
  oldAnchorIndex,
  newAnchorIndex,
  viewportHeightPx = 560,
) {
  const oldOffset = oldLayout?.offsets?.[oldAnchorIndex] ?? 0;
  const newOffset = newLayout?.offsets?.[newAnchorIndex] ?? 0;
  const deltaPx = newOffset - oldOffset;
  const vpH = Math.max(20, Math.round(Number(viewportHeightPx) || 560));
  const oldMaxScrollPx = Math.max(0, (Number(oldLayout?.totalHeight) || 0) - vpH);
  const effectiveOldScrollPx = Math.max(0, Math.min(oldMaxScrollPx, Math.round(Number(oldScrollPx) || 0)));
  const newMaxScrollPx = Math.max(0, (Number(newLayout?.totalHeight) || 0) - vpH);
  return Math.max(0, Math.min(newMaxScrollPx, effectiveOldScrollPx + deltaPx));
}

/**
 * Format unified session review notes into a clean Markdown payload for agent dispatch
 * without trailing blank lines that can disrupt TUI bracketed-paste submission.
 */
export function formatReviewAgentMessage(
  sessionReviews,
  { workspaceRoot = "", fallbackRoot = "" } = {},
) {
  const list = Array.isArray(sessionReviews) ? sessionReviews : [];
  const parts = ["Review comments on session changes:", ""];

  const byService = new Map();
  for (const r of list) {
    if (!r) continue;
    const sId = r.serviceId || "default";
    if (!byService.has(sId)) byService.set(sId, []);
    byService.get(sId).push(r);
  }

  for (const [sId, revs] of byService) {
    const sName = revs[0].serviceName || sId;
    const sRoot = revs[0].repoRoot || workspaceRoot || fallbackRoot || "";
    const baseRef = revs[0].baseRef ? ` [vs ${revs[0].baseRef}]` : "";
    parts.push(`### Service: ${sName} (${sRoot})${baseRef}`, "");
    for (const r of revs) {
      const filePath = r.displayPath || r.file;
      const sideLabel = r.side === "old" ? " (removed line)" : "";
      parts.push(`- \`${filePath}:${r.line}\`${sideLabel}:`);
      const normalizedText = String(r.text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      for (const line of normalizedText.split("\n")) {
        parts.push(`  ${line}`);
      }
      if (r.snippet) {
        const cleanSnippet = String(r.snippet).replace(/\r?\n/g, " ").trim();
        if (cleanSnippet) {
          parts.push(`  > ${cleanSnippet}`);
        }
      }
      parts.push("");
    }
  }

  return parts.join("\n").replace(/\r\n/g, "\n").replace(/\n+$/, "");
}

/**
 * Safely parse JSON output emitted by `hc ... --json`.
 */
export function parseHcJsonOutput(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {}
    }
    return null;
  }
}

/**
 * Format an `hc` CLI error (including JSON `{error: {kind, message, hint}}` stderr) into a readable UI message.
 */
export function formatHcErrorMessage(execResult, fallback = "Failed to send review to agent") {
  const stderr = String(execResult?.stderr || "").trim();
  const stdout = String(execResult?.stdout || "").trim();
  const parsed = parseHcJsonOutput(stderr) || parseHcJsonOutput(stdout);
  const errObj = parsed?.error;
  if (errObj && typeof errObj === "object") {
    if (errObj.kind === "blocked") {
      return "Agent is blocked waiting for input. Respond to its prompt first.";
    }
    if (errObj.kind === "finished") {
      return "Target agent session has already finished.";
    }
    if (errObj.kind === "not_found") {
      return "Target agent terminal is no longer available.";
    }
    const msg = String(errObj.message || errObj.kind || "").trim();
    const hint = String(errObj.hint || "").trim();
    if (msg) return hint ? `${msg} (${hint})` : msg;
  }
  return stderr || stdout || fallback;
}

/**
 * Resolve the terminal's configured submit key from `hc get --json` (default `"enter"`).
 */
export function resolveAgentSubmitKey(terminalInfo) {
  const raw = typeof terminalInfo?.submit === "string" ? terminalInfo.submit.trim() : "";
  return raw || "enter";
}

const BLOCKED_PROMPT_PATTERNS = [
  /\bdo you want to proceed\b/i,
  /\ballow once\b/i,
  /\ballow always\b/i,
  /\bapprove this\b/i,
  /\bconfirm.*\((?:y\/n|yes\/no)\)/i,
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\byes,\s*allow\b/i,
];

const PASTE_CHIP_RE = /\[Pasted text #\d+|\[\d+\s+lines?\s+pasted|\bpasted\s+\d+\s+lines?\b/i;
const PROMPT_INPUT_LINE_RE = /^\s*(?:[❯›>│┃┆]|─+\s*[❯›>])/;

function getBottomNonEmptyLines(screenText, count = 14) {
  if (typeof screenText !== "string" || !screenText) return [];
  const lines = screenText.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < count; i -= 1) {
    const t = lines[i].trim();
    if (t) out.push(t);
  }
  out.reverse();
  return out;
}

/**
 * Guard against pressing Enter when an interactive confirmation or permission dialog is on screen.
 */
export function screenLooksBlockedOrPrompting(screenText) {
  const bottom = getBottomNonEmptyLines(screenText, 12);
  if (bottom.length === 0) return false;
  const joined = bottom.join("\n");
  return BLOCKED_PROMPT_PATTERNS.some((re) => re.test(joined));
}

/**
 * Detect whether a review paste is freshly sitting unsubmitted inside the agent's bottom input box.
 */
export function detectUnsubmittedReviewInScreen(preScreen, postScreen, message) {
  if (typeof postScreen !== "string" || !postScreen.trim()) return false;
  if (screenLooksBlockedOrPrompting(postScreen)) return false;

  const postBottom = getBottomNonEmptyLines(postScreen, 12);
  if (postBottom.length === 0) return false;
  const preBottom = getBottomNonEmptyLines(preScreen, 12);

  // 1. Collapsed bracketed-paste chip (e.g., Claude Code `[Pasted text #1 +34 lines]`) newly present in input area.
  const countChips = (arr) => arr.filter((l) => PASTE_CHIP_RE.test(l)).length;
  const postChips = countChips(postBottom);
  const preChips = countChips(preBottom);
  if (postChips > preChips) {
    return true;
  }

  // 2. Review header or last meaningful line freshly sitting on a prompt input line near the bottom.
  const msgLines = String(message || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const firstLine = msgLines[0] || "";
  const firstAnchor = firstLine.slice(0, 36);
  const lastLine = msgLines.length > 1 ? msgLines[msgLines.length - 1] : "";
  const lastAnchor = lastLine.length >= 12 ? lastLine.slice(0, 36) : "";

  const preBottomSet = new Set(preBottom);
  const inputRegion = postBottom.slice(-8);
  for (const line of inputRegion) {
    if (preBottomSet.has(line)) continue;
    const hasMarker =
      (firstAnchor && line.includes(firstAnchor)) ||
      (lastAnchor && line.includes(lastAnchor));
    if (hasMarker && (PROMPT_INPUT_LINE_RE.test(line) || inputRegion.indexOf(line) >= inputRegion.length - 4)) {
      return true;
    }
  }
  return false;
}

/**
 * Decide whether `sendReview` should send a follow-up submit key nudge after `hc send --json`.
 * Never nudges when the agent is working, blocked, errored, finished, already advanced a turn,
 * or showing a confirmation dialog.
 */
export function decideSendSubmitAction({
  sendResult = null,
  liveTerminal = null,
  preScreen = "",
  postScreen = "",
  message = "",
  requireScreenMatch = false,
} = {}) {
  const submitKey = resolveAgentSubmitKey(liveTerminal);
  if (liveTerminal?.state && liveTerminal.state !== "live") {
    return { shouldNudge: false, reason: "not-live", submitKey };
  }
  const liveStatus = liveTerminal?.status ?? null;
  if (liveStatus === "working") {
    return { shouldNudge: false, reason: "already-working", submitKey };
  }
  if (liveStatus === "blocked" || liveStatus === "error") {
    return { shouldNudge: false, reason: `status-${liveStatus}`, submitKey };
  }
  if (sendResult?.started === true) {
    return { shouldNudge: false, reason: "started-true", submitKey };
  }
  if (
    Number.isFinite(Number(sendResult?.turn)) &&
    Number.isFinite(Number(liveTerminal?.turn)) &&
    Number(liveTerminal.turn) > Number(sendResult.turn)
  ) {
    return { shouldNudge: false, reason: "turn-advanced", submitKey };
  }
  if (screenLooksBlockedOrPrompting(postScreen)) {
    return { shouldNudge: false, reason: "screen-blocked-prompt", submitKey };
  }

  const pasteVisible = detectUnsubmittedReviewInScreen(preScreen, postScreen, message);
  if (pasteVisible) {
    return { shouldNudge: true, reason: "screen-unsubmitted-paste", submitKey };
  }
  if (!requireScreenMatch && sendResult?.started === false) {
    return { shouldNudge: true, reason: "hc-reported-not-started", submitKey };
  }
  return { shouldNudge: false, reason: "no-unsubmitted-signal", submitKey };
}

/**
 * Compute monospace wrap columns for saved inline review comment rows.
 * Reserves extra horizontal chrome for the comment icon, spacing, and Edit label
 * relative to code rows without imposing an artificial narrow max-width cap.
 */
export function computeReviewCommentWrapCols(wrapCols) {
  const raw = Number(wrapCols);
  const baseCols = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 80;
  return Math.max(12, baseCols - 6);
}
