// Pure helper logic for files-search: fuzzy scoring, directory-aware query ranking, text-search parsing, git header parsing, and syntax highlighting.
import { isMarkdownFile, resolveRelativeMarkdownPath } from "./markdown-view-logic.js";
import { wrapStyledSpans } from "./code-wrap.js";
import {
  MAX_PREVIEW_SYNTAX_LINE_CHARS,
  MAX_PREVIEW_RENDER_LINE_CHARS,
  getSyntaxExt,
  resolveEditorLanguage,
  getSyntaxPalette,
  getEditorSyntaxConfig,
  syntaxTokenStyle,
  expandCodeTabs,
  createCodeSyntaxState,
  tokenizeCodeLine,
  tokenizeInteractiveCodeLine,
} from "./code-syntax.js";

export const MAX_FILE_RESULTS = 50;
export const MAX_TEXT_RESULTS = 35;
export const FILE_SEARCH_CHUNK = 1200;
export const FILE_SEARCH_BUDGET_MS = 6;

export function escapeRegexStr(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function repoMatchesTranscript(service, files, transcript) {
  if (!transcript) return false;
  const normRoot = String(service.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (normRoot && transcript.includes(normRoot)) return true;
  if (service.relPath && service.relPath.length >= 2 && transcript.includes(`${service.relPath}/`)) {
    const relRe = new RegExp(`(?:^|[\\s"'\`(:\\/])${escapeRegexStr(service.relPath)}/`);
    if (relRe.test(transcript)) return true;
  }
  if (service.name && service.name.length >= 3 && transcript.includes(`${service.name}/`)) {
    const nameRe = new RegExp(`(?:^|[\\s"'\`(:\\/])${escapeRegexStr(service.name)}/`);
    if (nameRe.test(transcript)) return true;
  }
  for (const f of files || []) {
    if (f?.name && f.name.length >= 5 && transcript.includes(f.name)) return true;
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

export function parseSearchOutputLines(stdout, q, prefix = "", cap = MAX_TEXT_RESULTS, out = []) {
  if (!stdout || out.length >= cap) return out;
  const lowerQ = q ? q.toLowerCase() : "";
  let start = 0;
  const len = stdout.length;
  while (start < len && out.length < cap) {
    let nl = stdout.indexOf("\n", start);
    if (nl === -1) nl = len;
    const rawLine = stdout.slice(start, nl);
    start = nl + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) continue;
    const m = line.match(/^([^:]+):(\d+):(?:(\d+):)?(.*)$/);
    if (!m) continue;
    let normRel = m[1];
    if (normRel.indexOf("\\") !== -1) normRel = normRel.replace(/\\/g, "/");
    if (normRel.startsWith("./")) normRel = normRel.slice(2);
    let content = m[4].trim();
    if (content.length > 260) {
      const idx = lowerQ ? content.toLowerCase().indexOf(lowerQ) : -1;
      if (idx > 140) {
        const sliceStart = Math.max(0, idx - 60);
        content = (sliceStart > 0 ? "…" : "") + content.slice(sliceStart, sliceStart + 240) + "…";
      } else {
        content = content.slice(0, 240) + "…";
      }
    }
    out.push({
      kind: "text",
      path: prefix ? `${prefix}${normRel}` : normRel,
      line: parseInt(m[2], 10),
      content,
      matchedQuery: q,
    });
  }
  return out;
}

// Fast zero-allocation subsequence scorer matching fuzzy()'s ranking weights.
export function scoreSubseqFast(lower, qChars, qLen) {
  if (qLen >= 3 && lower.indexOf(qChars[qLen - 1]) === -1) return -Infinity;
  let score = 0;
  let at = 0;
  let run = 0;
  let matchedAny = false;
  for (let j = 0; j < qLen; j++) {
    const i = lower.indexOf(qChars[j], at);
    if (i < 0) return -Infinity;
    let start = i === 0;
    if (!start) {
      const prev = lower.charCodeAt(i - 1);
      start = prev === 47 || prev === 92 || prev === 95 || prev === 45 || prev === 46 || prev === 32 || prev === 58 || prev === 9;
    }
    run = matchedAny && i === at ? run + 1 : 0;
    matchedAny = true;
    const gap = i - at;
    score += 1 + (start ? 6 : 0) + run * 3 - (gap < 6 ? gap : 6) * 0.3;
    at = i + 1;
  }
  return score - lower.length * 0.02;
}

// Fuzzy score and hit indices for file matching (run on top winning rows).
export function fuzzy(q, text) {
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

export function prepareSearchQuery(rawQuery) {
  const rawQ = String(rawQuery || "").trim().toLowerCase();
  const q = rawQ.replace(/\s+/g, "");
  if (!q) return null;
  const qChars = Array.from(q);
  const qEndsSlash = q.endsWith("/") && q.length > 1;
  const dirQ = qEndsSlash ? q.slice(0, -1) : q;
  return {
    q,
    qChars,
    qLen: qChars.length,
    qEndsSlash,
    dirQ,
    hasSlash: q.indexOf("/") !== -1,
    dirHasSlash: dirQ.indexOf("/") !== -1,
    matchKey: qEndsSlash ? dirQ : q,
  };
}

export function scoreIndexEntry(entry, qs) {
  const isDir = entry.kind === "dir";
  const useEndsSlash = isDir && qs.qEndsSlash;
  const useChars = qs.qChars;
  const useLen = qs.qLen;
  const useHasSlash = isDir ? qs.dirHasSlash : qs.hasSlash;
  let score = -Infinity;
  let fromName = false;
  if (!useHasSlash) {
    const nameTarget = useEndsSlash ? (entry.lowerNameSlash || (entry.lowerNameSlash = `${entry.lowerName}/`)) : entry.lowerName;
    const ns = scoreSubseqFast(nameTarget, useChars, useLen);
    if (ns > -Infinity) {
      score = ns + 15;
      fromName = true;
    } else {
      const pathTarget = useEndsSlash ? (entry.lowerPathSlash || (entry.lowerPathSlash = `${entry.lowerPath}/`)) : entry.lowerPath;
      score = scoreSubseqFast(pathTarget, useChars, useLen);
    }
  } else {
    const pathTarget = useEndsSlash ? (entry.lowerPathSlash || (entry.lowerPathSlash = `${entry.lowerPath}/`)) : entry.lowerPath;
    score = scoreSubseqFast(pathTarget, useChars, useLen);
  }
  if (score > -Infinity) {
    score += isDir ? (qs.qEndsSlash ? 12 : -0.5) : 0.5;
  }
  return { score, fromName };
}

export function buildTopFileItems(top, q, withHits) {
  if (!top.length) return [];
  const sorted = top.slice().sort((a, b) => b.score - a.score);
  return sorted.map(({ entry, score, fromName }) => ({
    kind: entry.kind === "dir" ? "dir" : "file",
    path: entry.path,
    name: entry.name,
    score,
    hits: withHits && fromName ? (fuzzy(q, entry.name)?.hits || []) : [],
  }));
}

export {
  MAX_PREVIEW_SYNTAX_LINE_CHARS,
  MAX_PREVIEW_RENDER_LINE_CHARS,
  getSyntaxExt,
  resolveEditorLanguage,
  getSyntaxPalette,
  getEditorSyntaxConfig,
  syntaxTokenStyle,
  expandCodeTabs,
  tokenizeCodeLine,
  tokenizeInteractiveCodeLine,
};

const EXACT_FILE_ICONS = {
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

const EXT_FILE_ICONS = {
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

export function resolveFileIconSpec(filePath) {
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
  if (EXACT_FILE_ICONS[base]) return EXACT_FILE_ICONS[base];
  if (base.startsWith(".env")) return { kind: "settings", tone: "number" };
  const ext = getSyntaxExt(base);
  if (ext && EXT_FILE_ICONS[ext]) return EXT_FILE_ICONS[ext];
  return { kind: "file", tone: "muted" };
}

export function resolveFileIcon(filePath, t) {
  const spec = resolveFileIconSpec(filePath);
  const palette = getSyntaxPalette(t);
  return {
    kind: spec.kind,
    path: `mods/files-search/icons/file-types/${spec.kind}.svg`,
    color: palette[spec.tone] || palette.muted,
  };
}

// Stack-safe pixel width estimation for horizontal code preview scrolling.
export function computeCodeContentWidth(lines, { minWidth = 240, charPx = 7.6, gutterPx = 92 } = {}) {
  if (!Number.isFinite(charPx) || charPx <= 0) return minWidth;
  let maxCols = 0;
  const capCols = MAX_PREVIEW_RENDER_LINE_CHARS + 32;
  for (const line of lines || []) {
    if (!line) continue;
    let cols;
    if (line.length >= capCols) {
      cols = capCols;
    } else if (!line.includes("\t")) {
      cols = line.length;
    } else {
      const expanded = expandCodeTabs(line);
      cols = Math.min(expanded.length, capCols);
    }
    if (cols > maxCols) maxCols = cols;
  }
  return Math.max(minWidth, Math.ceil(maxCols * charPx) + gutterPx);
}

function normalizeViewerSlashes(rawPath) {
  const raw = String(rawPath || "");
  if (!raw) return "";
  const replaced = raw.replace(/\\/g, "/");
  const isUnc = replaced.startsWith("//") && !replaced.startsWith("///");
  const collapsed = replaced.replace(/\/+/g, "/");
  return isUnc ? `/${collapsed}` : collapsed;
}

function isAbsoluteViewerPath(normPath) {
  return normPath.startsWith("/") || /^[A-Za-z]:(?:\/|$)/.test(normPath);
}

function toTabIdSet(ids) {
  if (ids instanceof Set) return ids;
  if (Array.isArray(ids) || (ids && typeof ids[Symbol.iterator] === "function")) {
    return new Set(ids);
  }
  return new Set();
}

export function resolveViewerFilePath(root, filePath) {
  const rawFile = String(filePath || "");
  if (!rawFile.trim()) return "";

  const normFile = normalizeViewerSlashes(rawFile);
  const normRoot = normalizeViewerSlashes(root);
  let combined;

  if (isAbsoluteViewerPath(normFile) || !normRoot.trim()) {
    combined = normFile;
  } else if (normRoot === "/" || /^[A-Za-z]:\/$/.test(normRoot)) {
    combined = `${normRoot}${normFile}`;
  } else {
    combined = `${normRoot.replace(/\/+$/, "")}/${normFile}`;
  }

  let prefix = "";
  let rest = combined;
  const uncMatch = combined.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/);
  const uncRootMatch = !uncMatch ? combined.match(/^(\/\/[^/]*)(?:\/(.*))?$/) : null;
  const driveMatch = combined.match(/^([A-Za-z]:)(?:\/(.*))?$/);

  if (uncMatch) {
    prefix = uncMatch[1];
    rest = uncMatch[2] || "";
  } else if (uncRootMatch) {
    prefix = uncRootMatch[1];
    rest = uncRootMatch[2] || "";
  } else if (driveMatch) {
    prefix = `${driveMatch[1]}/`;
    rest = driveMatch[2] || "";
  } else if (combined.startsWith("/")) {
    prefix = "/";
    rest = combined.slice(1);
  }

  const stack = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!prefix) {
        stack.push("..");
      }
    } else {
      stack.push(seg);
    }
  }

  if (prefix === "/" || /^[A-Za-z]:\/$/.test(prefix)) {
    return `${prefix}${stack.join("/")}`;
  }
  if (prefix.startsWith("//")) {
    return stack.length > 0 ? `${prefix}/${stack.join("/")}` : prefix;
  }
  return stack.length > 0 ? stack.join("/") : ".";
}

export function buildFileViewerKey(root, filePath, isWin = false) {
  const resolved = resolveViewerFilePath(root, filePath);
  if (!resolved) return "";
  return isWin ? resolved.toLowerCase() : resolved;
}

export function formatFileTabTitle(filePath, serviceName = null, existingTitlesOrDuplicateHint = null) {
  const norm = normalizeViewerSlashes(filePath).replace(/\/+$/, "");
  const segs = norm.split("/").filter(Boolean);
  const base = segs.length > 0 ? segs[segs.length - 1] : "";
  if (!base) return "File";

  let existingSet = null;
  if (existingTitlesOrDuplicateHint instanceof Set) {
    existingSet = existingTitlesOrDuplicateHint;
  } else if (Array.isArray(existingTitlesOrDuplicateHint)) {
    existingSet = new Set(existingTitlesOrDuplicateHint.filter(Boolean).map(String));
  }

  const isDup = existingSet ? existingSet.has(base) : Boolean(existingTitlesOrDuplicateHint);
  if (!isDup) return base;

  const cleanSvc = typeof serviceName === "string" ? serviceName.trim() : "";
  const dirSegs = segs.slice(0, -1);
  const parent = dirSegs.length > 0 ? dirSegs[dirSegs.length - 1] : "";

  const candidates = [];
  if (cleanSvc && cleanSvc !== base) {
    candidates.push(`${base} · ${cleanSvc}`);
  }
  if (parent) {
    if (cleanSvc && parent !== cleanSvc) {
      candidates.push(`${base} · ${cleanSvc}/${parent}`);
    }
    candidates.push(`${base} · ${parent}`);
  }
  for (let depth = 2; depth <= Math.min(3, dirSegs.length); depth++) {
    candidates.push(`${base} · ${dirSegs.slice(-depth).join("/")}`);
  }

  for (const candidate of candidates) {
    if (!existingSet || !existingSet.has(candidate)) {
      return candidate;
    }
  }

  if (existingSet) {
    let idx = 2;
    while (existingSet.has(`${base} (${idx})`)) {
      idx++;
    }
    return `${base} (${idx})`;
  }
  return `${base} (2)`;
}

export function pruneOpenFileTabs(openTabsMap, allLiveTabIds, filePaneTabIds = null) {
  if (!openTabsMap || typeof openTabsMap !== "object" || Array.isArray(openTabsMap)) {
    return { tabs: {}, changed: Boolean(openTabsMap) };
  }
  const liveSet = toTabIdSet(allLiveTabIds);
  const paneSet = filePaneTabIds == null ? null : toTabIdSet(filePaneTabIds);
  const next = {};
  let changed = false;

  for (const [key, entry] of Object.entries(openTabsMap)) {
    if (!entry || typeof entry !== "object") {
      changed = true;
      continue;
    }
    const tabId = entry.tabId || key;
    if (!tabId || !liveSet.has(tabId) || (paneSet && !paneSet.has(tabId))) {
      changed = true;
      continue;
    }
    if (key !== tabId || entry.tabId !== tabId) {
      changed = true;
      next[tabId] = { ...entry, tabId };
    } else {
      next[tabId] = entry;
    }
  }
  return { tabs: next, changed };
}

export function findMatchingOpenFileTab(openTabsMap, spaceTabIds, filePaneTabIds, targetRoot, targetPath, isWin = false) {
  if (!openTabsMap || typeof openTabsMap !== "object" || Array.isArray(openTabsMap)) {
    return null;
  }
  const targetKey = buildFileViewerKey(targetRoot, targetPath, isWin);
  if (!targetKey) return null;

  const spaceSet = toTabIdSet(spaceTabIds);
  if (spaceSet.size === 0) return null;
  const paneSet = filePaneTabIds == null ? null : toTabIdSet(filePaneTabIds);

  for (const [key, entry] of Object.entries(openTabsMap)) {
    if (!entry || typeof entry !== "object") continue;
    const tabId = entry.tabId || key;
    if (!tabId || !spaceSet.has(tabId)) continue;
    if (paneSet && !paneSet.has(tabId)) continue;

    const absKey = entry.absPath ? buildFileViewerKey(entry.root || "", entry.absPath, isWin) : "";
    const relKey = entry.path ? buildFileViewerKey(entry.root || "", entry.path, isWin) : "";
    if ((absKey && absKey === targetKey) || (relKey && relKey === targetKey)) {
      return { tabId, entry };
    }
  }
  return null;
}

function hashPathShort(value) {
  const s = String(value || "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Determine whether the File Viewer Markdown toggle should stay active on file load.
 * Defaults to false when opening or switching targets; preserves toggle state when reloading the same file.
 */
export function resolveViewerMarkdownToggleOnLoad(prevTargetPath, nextTargetPath, prevRendered = false, isWin = false) {
  const nextKey = buildFileViewerKey("", nextTargetPath, isWin);
  if (!nextKey || !isMarkdownFile(nextTargetPath)) return false;
  const prevKey = buildFileViewerKey("", prevTargetPath, isWin);
  return Boolean(prevKey && prevKey === nextKey && prevRendered);
}

/**
 * Retain raw text in viewer state only when the loaded target is a valid non-binary Markdown file.
 */
export function selectViewerMarkdownRawText(targetPath, text, hasError = false) {
  if (hasError || typeof text !== "string" || text.includes("\0")) return null;
  return isMarkdownFile(targetPath) ? text : null;
}

/**
 * Retain raw text in viewer state for any valid non-binary text file (code, config, or Markdown).
 */
export function selectViewerRawText(text, hasError = false) {
  if (hasError || typeof text !== "string" || text.includes("\0")) return null;
  return text;
}

/**
 * Return true when an unmaterialized viewer open request was just dispatched and
 * `spaces()` may not have reflected the newly created tab yet.
 */
export function shouldReuseInFlightPendingViewerOpen(pendingEntry, now, windowMs = 400) {
  if (!pendingEntry || typeof pendingEntry !== "object") return false;
  const elapsed = Number(now) - Number(pendingEntry.ts);
  return Number.isFinite(elapsed) && elapsed >= 0 && elapsed < windowMs;
}

/**
 * Build cache key `${targetPath}|${viewerLoadSeq}` for the viewer's bounded Markdown preparation cache.
 */
export function buildViewerMarkdownCacheKey(targetPath, loadSeq = 0) {
  const cleanPath = String(targetPath || "").trim();
  if (!cleanPath) return "";
  const seq = Number.isFinite(Number(loadSeq)) ? Math.max(0, Math.floor(Number(loadSeq))) : 0;
  return `${cleanPath}|${seq}`;
}

/**
 * Derive stable GPUI element and scroll IDs scoped to viewer instance, target path, and load version.
 */
export function buildViewerMarkdownViewIds(viewerId, targetPath, loadSeq = 0) {
  const vId = String(viewerId || "viewer");
  const seq = Number.isFinite(Number(loadSeq)) ? Math.max(0, Math.floor(Number(loadSeq))) : 0;
  const pathHash = hashPathShort(targetPath);
  return {
    id: `viewer-md-text-${vId}-${pathHash}-${seq}`,
    scrollId: `viewer-md-scroll-${vId}-${pathHash}-${seq}`,
  };
}

/**
 * Resolve a relative Markdown href against the current viewer file path when it targets a different file.
 */
export function resolveRelativeMarkdownTarget(currentTargetPath, href, isWin = false) {
  const resolved = resolveRelativeMarkdownPath(currentTargetPath, href);
  if (!resolved) return null;
  const curKey = buildFileViewerKey("", currentTargetPath, isWin);
  const nextKey = buildFileViewerKey("", resolved, isWin);
  if (!nextKey || (curKey && curKey === nextKey)) return null;
  return resolved;
}

/**
 * Extract the previewable file path from a Search Everywhere result item (excluding directories).
 */
export function getPreviewMarkdownTargetPath(item) {
  if (!item || item.kind === "dir" || typeof item.path !== "string") return null;
  const clean = item.path.trim();
  return clean || null;
}

/**
 * Return true when changing the highlighted Search Everywhere item must reset rendered Markdown state.
 */
export function shouldResetPreviewMarkdown(prevItem, nextItem) {
  const prevPath = getPreviewMarkdownTargetPath(prevItem);
  const nextPath = getPreviewMarkdownTargetPath(nextItem);
  if (!nextPath) return Boolean(prevPath);
  return prevPath !== nextPath;
}

/**
 * Return true when toggling rendered Markdown preview in Search Everywhere requires fetching from line 1.
 */
export function shouldLoadFullMarkdownPreview(startLine = 1, hasMore = false) {
  if (hasMore) return true;
  const start = Number(startLine);
  if (!Number.isFinite(start)) return true;
  return start > 1;
}

/**
 * Derive stable GPUI element and scroll IDs for the Search Everywhere Markdown preview surface.
 */
export function buildPreviewMarkdownViewIds(targetPath, seq = 0, sourceTag = "chunk") {
  const s = Number.isFinite(Number(seq)) ? Math.max(0, Math.floor(Number(seq))) : 0;
  const pathHash = hashPathShort(targetPath);
  return {
    id: `preview-md-text-${pathHash}-${s}-${sourceTag}`,
    scrollId: `preview-md-scroll-${pathHash}-${s}-${sourceTag}`,
  };
}

/**
 * Determine whether the primary code-navigation modifier (Ctrl on Linux/Win, Cmd on macOS) is active.
 * Excludes AltGr combinations (`control && alt`) so international keyboard layouts do not misfire.
 */
export function isNavModifierActive(modifiers) {
  if (!modifiers || typeof modifiers !== "object") return false;
  if (modifiers.alt) return false;
  return Boolean(modifiers.control || modifiers.platform);
}

/**
 * Split code text cleanly into logical source lines without trailing carriage returns.
 */
export function splitCodeViewerLines(text) {
  if (text == null || text === "") return [""];
  const raw = String(text).split("\n");
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].endsWith("\r")) {
      raw[i] = raw[i].slice(0, -1);
    }
  }
  return raw;
}

function tokenizeViewerLineSpans(rawLine, ext, syntaxState) {
  const spans = tokenizeInteractiveCodeLine(rawLine || "", ext, syntaxState);
  if (Array.isArray(spans) && spans.length > 0) return spans;
  const str = String(rawLine || "");
  if (!str) return null;
  const clippedRaw = str.length > MAX_PREVIEW_RENDER_LINE_CHARS
    ? `${str.slice(0, MAX_PREVIEW_RENDER_LINE_CHARS)} …`
    : str;
  const expanded = expandCodeTabs(clippedRaw);
  if (!expanded) return null;
  const clipped = expanded.length > MAX_PREVIEW_RENDER_LINE_CHARS
    ? `${expanded.slice(0, MAX_PREVIEW_RENDER_LINE_CHARS)} …`
    : expanded;
  return [["plain", clipped, { col: 1, nav: false }]];
}

/**
 * Tokenize and soft-wrap one raw source line into interactive `[kind, text, { col, nav }]` visual rows.
 */
export function tokenizeInteractiveWrappedLine(rawLine, ext = "", mdState = null, maxCols = 88) {
  const limit = Math.max(8, Math.floor(Number(maxCols) || 88));
  const spans = tokenizeViewerLineSpans(rawLine, ext, mdState);
  if (!spans) {
    return [[["plain", "", { col: 1, nav: false }]]];
  }
  return wrapStyledSpans(spans, limit, { toNbsp: true });
}

/**
 * Build a soft-wrapped, interactive token-indexed code document for the windowed `#main` viewer.
 */
export function buildWrappedViewerDocument(text, filePath = "", maxCols = 88, options = {}) {
  const limit = Math.max(8, Math.floor(Number(maxCols) || 88));
  const ext = getSyntaxExt(filePath || "");
  const maxLines = Number.isFinite(options?.maxLines) && options.maxLines > 0
    ? Math.floor(options.maxLines)
    : Number.POSITIVE_INFINITY;

  const cachedTokenized = Array.isArray(options?.tokenizedLines) ? options.tokenizedLines : null;
  let lineLimit;
  let truncated;
  let tokenizedLines;
  let lines = null;
  let syntaxState = null;

  if (cachedTokenized) {
    tokenizedLines = cachedTokenized;
    lineLimit = Math.min(tokenizedLines.length, maxLines);
    truncated = Boolean(options?.truncated) || tokenizedLines.length > lineLimit;
  } else {
    syntaxState = createCodeSyntaxState(ext);
    lines = splitCodeViewerLines(text);
    lineLimit = Math.min(lines.length, maxLines);
    truncated = lines.length > lineLimit;
    tokenizedLines = new Array(lineLimit);
  }

  const rows = [];
  const lineFirstRowIndex = new Array(lineLimit);
  const lineRowCounts = new Array(lineLimit);

  for (let i = 0; i < lineLimit; i += 1) {
    const lineNum = i + 1;
    lineFirstRowIndex[i] = rows.length;
    let spans;
    if (cachedTokenized) {
      spans = cachedTokenized[i];
    } else {
      // tokenizeViewerLineSpans -> tokenizeInteractiveCodeLine advances syntaxState once per line.
      spans = tokenizeViewerLineSpans(lines[i], ext, syntaxState);
      tokenizedLines[i] = spans;
    }
    const wrappedRows = spans
      ? wrapStyledSpans(spans, limit, { toNbsp: true })
      : [[["plain", "", { col: 1, nav: false }]]];
    lineRowCounts[i] = wrappedRows.length;
    for (let r = 0; r < wrappedRows.length; r += 1) {
      rows.push({
        rowIndex: rows.length,
        lineNum,
        isFirstWrap: r === 0,
        segments: wrappedRows[r],
      });
    }
  }

  return {
    totalLines: lineLimit,
    truncated,
    ext,
    maxCols: limit,
    rows,
    lineFirstRowIndex,
    lineRowCounts,
    tokenizedLines,
  };
}

/**
 * Compute visible visual-row bounds for the windowed code viewer.
 */
export function computeWindowedViewerSlice(totalRows, scrollTopRows, viewportHeightPx, lineHeightPx = 20) {
  const total = Math.max(0, Math.floor(Number(totalRows) || 0));
  const lh = Math.max(12, Number(lineHeightPx) || 20);
  const vpH = Math.max(lh, Number(viewportHeightPx) || 400);
  const visibleCount = Math.max(1, Math.floor(vpH / lh));
  const maxScrollTop = Math.max(0, total - visibleCount);
  const scrollTop = Math.max(0, Math.min(maxScrollTop, Math.floor(Number(scrollTopRows) || 0)));
  const end = Math.min(total, scrollTop + visibleCount + 1);
  return {
    start: scrollTop,
    end,
    visibleCount,
    maxScrollTop,
    scrollTop,
  };
}

/**
 * Compute scroll row index that places `targetLine` comfortably inside the upper-middle viewport.
 */
export function computeTargetCenterScrollRow(doc, targetLine, viewportHeightPx, lineHeightPx = 20) {
  if (!doc || !Array.isArray(doc.rows) || doc.rows.length === 0) return 0;
  const lineIdx = Math.max(0, Math.min((doc.totalLines || 1) - 1, Math.floor(Number(targetLine) || 1) - 1));
  const firstRow = Number.isFinite(doc.lineFirstRowIndex?.[lineIdx]) ? doc.lineFirstRowIndex[lineIdx] : 0;
  const slice = computeWindowedViewerSlice(doc.rows.length, 0, viewportHeightPx, lineHeightPx);
  const leadRows = Math.floor(slice.visibleCount * 0.35);
  return Math.max(0, Math.min(slice.maxScrollTop, firstRow - leadRows));
}

/**
 * Compute proportional scrollbar track and thumb geometry for the windowed code viewer.
 */
export function computeScrollbarMetrics(totalRows, scrollTop, visibleCount, trackHeightPx) {
  const total = Math.max(0, Math.floor(Number(totalRows) || 0));
  const vis = Math.max(1, Math.floor(Number(visibleCount) || 1));
  const trackHeight = Math.max(24, Number(trackHeightPx) || 200);
  if (total <= vis) {
    return { visible: false, trackHeight, thumbHeight: trackHeight, thumbTop: 0 };
  }
  const rawThumb = Math.round((vis / total) * trackHeight);
  const thumbHeight = Math.max(24, Math.min(trackHeight, rawThumb));
  const maxScrollTop = Math.max(1, total - vis);
  const clampedTop = Math.max(0, Math.min(maxScrollTop, Number(scrollTop) || 0));
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
  const thumbTop = Math.round((clampedTop / maxScrollTop) * maxThumbTop);
  return {
    visible: true,
    trackHeight,
    thumbHeight,
    thumbTop,
  };
}

/**
 * Convert GPUI scroll wheel event deltas into row offsets (positive delta.y scrolls up).
 */
export function resolveWheelLineDelta(deltaY, deltaLinesY = 0) {
  const linesY = Number(deltaLinesY);
  if (Number.isFinite(linesY) && linesY !== 0) {
    const scaled = -Math.trunc(linesY * 3);
    return scaled !== 0 ? scaled : (linesY > 0 ? -1 : 1);
  }
  const dy = Number(deltaY);
  if (Number.isFinite(dy) && dy !== 0) {
    return dy > 0 ? -3 : 3;
  }
  return 0;
}

/**
 * Map a scrollbar track Y coordinate onto a clamped `scrollTop` row index.
 */
export function resolveClickScrollbarRow(offsetY, trackHeightPx, totalRows, visibleCount) {
  const total = Math.max(0, Math.floor(Number(totalRows) || 0));
  const vis = Math.max(1, Math.floor(Number(visibleCount) || 1));
  const maxScrollTop = Math.max(0, total - vis);
  if (maxScrollTop === 0) return 0;
  const trackHeight = Math.max(24, Number(trackHeightPx) || 200);
  const ratio = Math.max(0, Math.min(1, (Number(offsetY) || 0) / trackHeight));
  return Math.round(ratio * maxScrollTop);
}

/**
 * Build adaptive dropdown items for polymorphic / multi-candidate implementation disambiguation.
 */
export function buildDisambiguationDropdownItems(candidates, currentRoot = "", currentServiceName = "") {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const normCurrentRoot = normalizeViewerSlashes(currentRoot || "").replace(/\/+$/, "");

  return candidates.map((cand, idx) => {
    const normPath = normalizeViewerSlashes(cand?.filePath || cand?.path || "");
    const candRoot = normalizeViewerSlashes(cand?.root || cand?.serviceRoot || "").replace(/\/+$/, "");
    let relPath = normPath;
    if (candRoot && normPath.startsWith(`${candRoot}/`)) {
      relPath = normPath.slice(candRoot.length + 1);
    } else if (normCurrentRoot && normPath.startsWith(`${normCurrentRoot}/`)) {
      relPath = normPath.slice(normCurrentRoot.length + 1);
    }

    const baseName = relPath.split("/").filter(Boolean).pop() || relPath || "file";
    const sym = cand?.name || cand?.symbol || "";
    const container = cand?.containerName || "";
    const label = container && sym ? `${container}.${sym}` : (sym || baseName);
    const sig = typeof cand?.signature === "string" ? cand.signature.trim() : "";
    const meta = sig && sig !== label
      ? (sig.length > 64 ? `${sig.slice(0, 61)}...` : sig)
      : (cand?.kind || "");
    const svcName = cand?.serviceName || "";
    const badge = svcName && svcName !== currentServiceName ? svcName : "";
    const line = Math.max(1, Number(cand?.line) || 1);
    const column = Math.max(1, Number(cand?.column) || 1);

    return {
      id: `nav-cand-${idx}-${normPath}:${line}:${column}`,
      label,
      meta,
      subline: `${relPath}:${line}`,
      badge,
      rightText: `:${line}`,
      height: 44,
      fontMedium: true,
      selected: idx === 0,
      candidate: cand,
    };
  });
}

/**
 * Build descriptive header metadata for a code-navigation disambiguation popover.
 */
export function buildDisambiguationHeaderMeta({ symbol = "", mode = "", count = 0 } = {}) {
  const sym = typeof symbol === "string" ? symbol.trim() : "";
  const rawMode = String(mode || "").toLowerCase();
  let action = "Select target";
  if (rawMode === "implementations" || rawMode === "implementation") {
    action = sym ? `Implementations of ${sym}` : "Implementations";
  } else if (rawMode === "declarations" || rawMode === "declaration") {
    action = sym ? `Declarations of ${sym}` : "Declarations";
  } else if (rawMode === "references" || rawMode === "usages") {
    action = sym ? `Usages of ${sym}` : "Usages";
  } else if (sym) {
    action = `Go to ${sym}`;
  }
  const n = Math.max(0, Number(count) || 0);
  return {
    title: action,
    countText: `${n} ${n === 1 ? "match" : "matches"}`,
    hintText: "↑↓ · Enter · Esc",
  };
}

/**
 * Compute container-local anchor coordinates from a clicked token event's bounds/position.
 */
export function computeLocalAnchorRect(tokenInfo, containerBounds = null, lastPointer = null) {
  const tb = tokenInfo?.bounds;
  if (
    tb &&
    containerBounds &&
    Number.isFinite(Number(tb.x)) &&
    Number.isFinite(Number(tb.y)) &&
    Number.isFinite(Number(containerBounds.x)) &&
    Number.isFinite(Number(containerBounds.y))
  ) {
    const x = Number(tb.x) - Number(containerBounds.x);
    const y = Number(tb.y) - Number(containerBounds.y);
    const h = Number.isFinite(Number(tb.height)) && Number(tb.height) > 0 ? Number(tb.height) : 20;
    return { x, y, bottomY: y + h };
  }

  const pos = tokenInfo?.position;
  if (
    pos &&
    containerBounds &&
    Number.isFinite(Number(pos.x)) &&
    Number.isFinite(Number(pos.y)) &&
    Number.isFinite(Number(containerBounds.x)) &&
    Number.isFinite(Number(containerBounds.y))
  ) {
    const x = Number(pos.x) - Number(containerBounds.x);
    const y = Number(pos.y) - Number(containerBounds.y);
    return { x, y: y - 10, bottomY: y + 10 };
  }

  if (lastPointer && Number.isFinite(Number(lastPointer.x)) && Number.isFinite(Number(lastPointer.y))) {
    const x = Number(lastPointer.x);
    const y = Number(lastPointer.y);
    return { x, y: y - 10, bottomY: y + 10 };
  }

  return null;
}

/**
 * Build user-facing inline feedback for non-jump code-navigation outcomes.
 */
export function buildViewerNavigationNotice(navResult, context = null, intent = "") {
  const symbol = context?.symbol || navResult?.context?.symbol || "";
  if (!navResult || navResult.status === "not-found") {
    return {
      level: "warn",
      message: symbol
        ? `No declaration or implementation found for "${symbol}"`
        : "No declaration or implementation found",
    };
  }
  if (navResult.status === "external") {
    const pkg = navResult.externalPackage || symbol || "external library";
    return {
      level: "info",
      message: `External declaration (${pkg}) — outside workspace sources`,
    };
  }
  if (navResult.status === "already-there") {
    const label = intent === "implementation" ? "implementation" : "declaration";
    return {
      level: "info",
      message: symbol ? `Already at ${label} of "${symbol}"` : `Already at ${label}`,
    };
  }
  return null;
}

/**
 * Normalize optional column / highlight metadata onto an open file tab descriptor.
 */
export function applyTabNavMeta(tabEntry, navMeta = {}) {
  if (!tabEntry || typeof tabEntry !== "object") return tabEntry;
  const colNum = Number(navMeta?.column);
  const column = Number.isFinite(colNum) && colNum >= 1 ? Math.floor(colNum) : null;
  const highlightSymbol = typeof navMeta?.highlightSymbol === "string" && navMeta.highlightSymbol
    ? navMeta.highlightSymbol
    : null;
  const navSeqNum = Number(navMeta?.navSeq);
  const navSeq = Number.isFinite(navSeqNum) ? navSeqNum : (tabEntry.navSeq ?? null);
  return {
    ...tabEntry,
    column,
    highlightSymbol,
    navSeq,
  };
}

/**
 * Determine whether a resolved code-navigation target points outside the active file
 * and should therefore open or focus a dedicated viewer tab rather than replacing in-place.
 */
export function shouldOpenNavInNewTab(targetPath, currentPath, targetOn = null, currentOn = null, isWindows = false) {
  const normalizeCmp = (raw) => {
    const clean = String(raw || "").trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/(.)\/+$/, "$1");
    return isWindows ? clean.toLowerCase() : clean;
  };
  const left = normalizeCmp(targetPath);
  if (!left) return false;
  const right = normalizeCmp(currentPath);
  const sameOn = (targetOn ?? null) === (currentOn ?? null);
  return !(sameOn && left === right);
}

/**
 * Determine whether wheel/keyboard scrolling on the underlying code viewer,
 * preview pane, or search results list should run given current overlay state.
 */
export function shouldAllowUnderlyingScroll({
  closed = false,
  selectTextMode = false,
  hasDisambiguationPopover = false,
} = {}) {
  return !closed && !selectTextMode && !hasDisambiguationPopover;
}
