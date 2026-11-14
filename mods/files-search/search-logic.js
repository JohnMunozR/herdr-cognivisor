// Pure helper logic for files-search: fuzzy scoring, directory-aware query ranking, text-search parsing, git header parsing, and syntax highlighting.
import { isMarkdownExt, tokenizeMarkdownLine } from "./markdown-syntax.js";
import { isMarkdownFile, resolveRelativeMarkdownPath } from "./markdown-view-logic.js";

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
    const nameTarget = useEndsSlash ? `${entry.lowerName}/` : entry.lowerName;
    const ns = scoreSubseqFast(nameTarget, useChars, useLen);
    if (ns > -Infinity) {
      score = ns + 15;
      fromName = true;
    } else {
      const pathTarget = useEndsSlash ? `${entry.lowerPath}/` : entry.lowerPath;
      score = scoreSubseqFast(pathTarget, useChars, useLen);
    }
  } else {
    const pathTarget = useEndsSlash ? `${entry.lowerPath}/` : entry.lowerPath;
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

const EDITOR_LANG_ALIASES = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  pyw: "py",
  pyi: "py",
  toml: "yaml",
  jsonc: "json",
  json5: "json",
  svelte: "html",
  vue: "html",
  gradle: "groovy",
  env: "sh",
  gitignore: "sh",
};

const CODE_KEYWORDS = new Set([
  "abstract", "and", "as", "assert", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "crate", "debugger", "declare", "def", "default", "defer", "del",
  "delete", "do", "elif", "else", "enum", "except", "export", "extends", "final", "finally",
  "fn", "for", "from", "fun", "function", "get", "global", "go", "if", "impl", "implements",
  "import", "in", "instanceof", "interface", "is", "keyof", "lambda", "let", "match", "mod",
  "mut", "namespace", "native", "new", "nonlocal", "not", "of", "or", "override", "package",
  "pass", "permits", "private", "protected", "pub", "public", "raise", "readonly", "record",
  "return", "satisfies", "sealed", "select", "set", "static", "strictfp", "struct", "switch",
  "synchronized", "throw", "throws", "trait", "transient", "try", "type", "typeof", "use",
  "using", "val", "var", "virtual", "volatile", "where", "while", "with", "yield",
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY",
  "ORDER", "HAVING", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "ALTER",
  "DROP", "TABLE", "INDEX", "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "CASE", "WHEN",
  "THEN", "ELSE", "END", "DISTINCT", "LIMIT", "OFFSET", "UNION", "EXISTS", "RETURNING",
]);

const CODE_BOOLEANS = new Set(["true", "false", "True", "False"]);

const CODE_CONSTANTS = new Set(["null", "nil", "None", "undefined", "NaN", "Infinity"]);

const CODE_SPECIAL_VARS = new Set(["this", "super", "self", "cls"]);

const CODE_BUILTIN_VARS = new Set([
  "console", "process", "window", "document", "globalThis", "module", "exports",
]);

const CODE_TYPES = new Set([
  "void", "int", "long", "short", "byte", "float", "double", "boolean", "bool", "char",
  "string", "number", "any", "unknown", "never", "object", "symbol", "bigint", "str",
  "list", "dict", "set", "tuple", "frozenset", "bytes",
  "usize", "isize", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32", "f64",
  "String", "Object", "Class", "Integer", "Long", "Double", "Float", "Boolean", "Character", "Byte", "Short",
  "Number", "BigDecimal", "BigInteger", "UUID", "Instant", "LocalDate", "LocalDateTime", "Duration",
  "List", "ArrayList", "Map", "HashMap", "LinkedHashMap", "Set", "HashSet", "Collection", "Iterable",
  "Stream", "Optional", "CompletableFuture", "Future", "ResponseEntity", "HttpStatus", "HttpHeaders",
  "Pageable", "Page", "Slice", "Sort", "Model", "Exception", "RuntimeException", "Throwable",
  "Promise", "Array", "Record", "Date", "RegExp", "Error", "Any", "Union", "Dict", "Tuple",
  "Sequence", "Mapping", "Callable", "Coroutine", "Vec", "Option", "Result", "Box", "Arc",
]);

const CODE_HASH_COMMENT_EXTS = new Set([
  "py", "pyw", "pyi", "rb", "sh", "bash", "zsh", "fish", "yml", "yaml", "toml", "ps1", "psm1", "psd1",
  "r", "pl", "pm", "mk", "makefile", "dockerfile", "env", "ini", "conf", "cfg", "properties",
  "tf", "tfvars", "gitignore",
]);

const CODE_SLASH_COMMENT_EXTS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "java", "kt", "kts", "cs",
  "go", "rs", "c", "cpp", "cc", "cxx", "h", "hpp", "swift", "scala", "groovy", "gradle",
  "php", "css", "scss", "less", "jsonc", "json5", "dart", "proto",
]);

const CODE_MARKUP_EXTS = new Set(["html", "htm", "xml", "svg", "vue", "svelte"]);
const CODE_PROP_EXTS = new Set(["properties", "env", "ini", "conf", "cfg"]);
const CODE_DOC_COMMENT_EXTS = new Set(["java", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "kt", "kts", "groovy", "scala"]);
const DOC_TAG_RE = /@(?:param|returns?|throws|exception|see|since|deprecated|author|version|implSpec|implNote|apiNote|code|linkplain|link|value|inheritDoc)\b/g;

export function getSyntaxExt(filePath) {
  if (!filePath) return "";
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = (slash >= 0 ? filePath.slice(slash + 1) : filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base === ".gitignore" || base === ".dockerignore") return "gitignore";
  if (base.startsWith(".env")) return "env";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

export function resolveEditorLanguage(filePath) {
  const ext = getSyntaxExt(filePath);
  if (!ext) return "txt";
  return EDITOR_LANG_ALIASES[ext] ?? ext;
}

function parseHexColorRgb(hex) {
  if (typeof hex !== "string" || !hex.startsWith("#")) return null;
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  } else if (h.length !== 6 && h.length !== 8) {
    return null;
  }
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexPerceivedLuma(hex) {
  const rgb = parseHexColorRgb(hex);
  if (!rgb) return null;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

function detectDarkTheme(t) {
  if (!t) return true;
  if (typeof t.is_dark === "boolean") return t.is_dark;
  if (t.appearance === "light") return false;
  if (t.appearance === "dark") return true;
  const bg = hexPerceivedLuma(t.background);
  return bg === null ? true : bg < 0.5;
}

function pickSyntaxTone(candidate, fallback, isDark, minDarkLuma = 0.36, maxLightLuma = 0.58) {
  const luma = hexPerceivedLuma(candidate);
  if (luma === null) return fallback;
  if (isDark ? luma < minDarkLuma : luma > maxLightLuma) return fallback;
  return candidate;
}

let cachedPaletteTheme = null;
let cachedPaletteValue = null;

export function getSyntaxPalette(t) {
  if (t && t === cachedPaletteTheme && cachedPaletteValue) return cachedPaletteValue;
  const isDark = detectDarkTheme(t);
  const warmAmber = isDark ? "#d19a66" : "#b35900";
  const cyan = pickSyntaxTone(t?.ansi6, isDark ? "#56b6c2" : "#0e7490", isDark);
  const coral = pickSyntaxTone(t?.ansi1, isDark ? "#e06c75" : "#cf222e", isDark);
  const palette = {
    isDark,
    keyword: pickSyntaxTone(t?.ansi5, isDark ? "#c678dd" : "#8250df", isDark),
    string: pickSyntaxTone(t?.ansi2, isDark ? "#98c379" : "#116329", isDark),
    escape: cyan,
    comment: pickSyntaxTone(t?.dim, isDark ? "#7f848e" : "#6e7781", isDark, 0.34, 0.56),
    function: pickSyntaxTone(t?.ansi4, isDark ? "#61afef" : "#0969da", isDark),
    type: pickSyntaxTone(t?.ansi3, isDark ? "#e5c07b" : "#9a6700", isDark),
    annotation: coral,
    variable: coral,
    number: warmAmber,
    boolean: warmAmber,
    constant: warmAmber,
    operator: cyan,
    punctuation: isDark ? "#8b93a2" : "#57606a",
    plain: pickSyntaxTone(t?.foreground, isDark ? "#abb2bf" : "#24292f", isDark, 0.45, 0.45),
    muted: pickSyntaxTone(t?.muted || t?.dim, isDark ? "#8b93a2" : "#57606a", isDark, 0.34, 0.56),
  };
  if (t) {
    cachedPaletteTheme = t;
    cachedPaletteValue = palette;
  }
  return palette;
}

export function getEditorSyntaxConfig(t) {
  const p = getSyntaxPalette(t);
  return {
    keyword: p.keyword,
    string: p.string,
    "string.escape": p.escape,
    comment: p.comment,
    function: p.function,
    type: p.type,
    number: p.number,
    boolean: p.boolean,
    constant: p.constant,
    variable: p.variable,
    operator: p.operator,
    punctuation: p.punctuation,
  };
}

export function syntaxTokenStyle(kind, t, isTarget = true) {
  const p = getSyntaxPalette(t);
  switch (kind) {
    case "keyword": return { color: p.keyword, bold: true };
    case "annotation": return { color: p.annotation, bold: true };
    case "string": return { color: p.string, bold: false };
    case "string.escape": return { color: p.escape, bold: false };
    case "comment": return { color: p.comment, bold: false };
    case "function": return { color: p.function, bold: false };
    case "type": return { color: p.type, bold: false };
    case "number": return { color: p.number, bold: false };
    case "boolean": return { color: p.boolean, bold: false };
    case "constant": return { color: p.constant, bold: false };
    case "variable": return { color: p.variable, bold: false };
    case "operator": return { color: p.operator, bold: false };
    default: return { color: isTarget ? p.plain : p.muted, bold: false };
  }
}

function pushCodeToken(tokens, kind, text) {
  if (!text) return;
  const last = tokens.length ? tokens[tokens.length - 1] : null;
  if (last && last[0] === kind) {
    last[1] += text;
  } else {
    tokens.push([kind, text]);
  }
}

function isIdentStartCh(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

function isIdentPartCh(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;
}

function isDigitCh(ch) {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isPyStringPrefix(str) {
  const s = str.toLowerCase();
  return s === "f" || s === "r" || s === "b" || s === "u" || s === "fr" || s === "rf" || s === "br" || s === "rb";
}

function emitCommentTokens(tokens, slice, enableDocTags) {
  if (!enableDocTags || slice.indexOf("@") === -1) {
    pushCodeToken(tokens, "comment", slice);
    return;
  }
  DOC_TAG_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = DOC_TAG_RE.exec(slice)) !== null) {
    const idx = m.index;
    const prev = idx > 0 ? slice[idx - 1] : " ";
    if (prev !== " " && prev !== "\t" && prev !== "{" && prev !== "*") continue;
    if (idx > last) pushCodeToken(tokens, "comment", slice.slice(last, idx));
    pushCodeToken(tokens, "annotation", m[0]);
    last = idx + m[0].length;
  }
  if (last < slice.length) pushCodeToken(tokens, "comment", slice.slice(last));
}

function isSimplePlaceholder(inner) {
  return /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(inner);
}

function emitStringTokens(tokens, slice, baseKind, opts = {}) {
  if (baseKind !== "string") {
    pushCodeToken(tokens, baseKind, slice);
    return;
  }
  const { isTemplate = false, isFString = false, allowPathVars = false } = opts;
  const len = slice.length;
  let i = 0;
  let segStart = 0;
  const flushSeg = (end) => {
    if (end > segStart) pushCodeToken(tokens, "string", slice.slice(segStart, end));
    segStart = end;
  };
  while (i < len) {
    const ch = slice[i];
    if (ch === "\\") {
      flushSeg(i);
      const escEnd = Math.min(len, slice[i + 1] === "u" ? i + 6 : slice[i + 1] === "x" ? i + 4 : i + 2);
      pushCodeToken(tokens, "string.escape", slice.slice(i, escEnd));
      i = segStart = escEnd;
      continue;
    }
    if (ch === "$" && i + 1 < len && slice[i + 1] === "{") {
      const close = slice.indexOf("}", i + 2);
      if (close > i + 2 && (isTemplate || /^[a-zA-Z0-9_.:-]+$/.test(slice.slice(i + 2, close)))) {
        flushSeg(i);
        pushCodeToken(tokens, "string.escape", slice.slice(i, close + 1));
        i = segStart = close + 1;
        continue;
      }
    }
    if (ch === "{") {
      if (isFString && slice[i + 1] === "{") {
        flushSeg(i);
        pushCodeToken(tokens, "string.escape", "{{");
        i = segStart = i + 2;
        continue;
      }
      const close = slice.indexOf("}", i + 1);
      if (close > i) {
        const inner = slice.slice(i + 1, close);
        const isPathOrSlf4j = allowPathVars && (inner === "" || (slice[i - 1] === "/" && isSimplePlaceholder(inner)));
        const isPyInterp = isFString && inner.length > 0 && !inner.includes("\n");
        if (isPathOrSlf4j || isPyInterp) {
          flushSeg(i);
          pushCodeToken(tokens, "string.escape", slice.slice(i, close + 1));
          i = segStart = close + 1;
          continue;
        }
      }
    }
    if (isFString && ch === "}" && slice[i + 1] === "}") {
      flushSeg(i);
      pushCodeToken(tokens, "string.escape", "}}");
      i = segStart = i + 2;
      continue;
    }
    i++;
  }
  flushSeg(len);
}

function tokenizePropertiesLine(text, tokens) {
  let lead = 0;
  while (lead < text.length && text[lead] === " ") lead++;
  if (lead > 0) pushCodeToken(tokens, "plain", text.slice(0, lead));
  const trimmed = text.slice(lead);
  if (!trimmed) return tokens;
  if (trimmed[0] === "#" || trimmed[0] === "!") {
    pushCodeToken(tokens, "comment", trimmed);
    return tokens;
  }
  const eqIdx = text.indexOf("=", lead);
  const colIdx = text.indexOf(":", lead);
  const sep = eqIdx >= 0 && colIdx >= 0 ? Math.min(eqIdx, colIdx) : Math.max(eqIdx, colIdx);
  if (sep < 0) {
    pushCodeToken(tokens, "plain", trimmed);
    return tokens;
  }
  const keySlice = text.slice(lead, sep);
  const trimmedKey = keySlice.trimEnd();
  if (trimmedKey) pushCodeToken(tokens, "function", trimmedKey);
  if (trimmedKey.length < keySlice.length) {
    pushCodeToken(tokens, "plain", keySlice.slice(trimmedKey.length));
  }
  pushCodeToken(tokens, "operator", text[sep]);
  const valRaw = text.slice(sep + 1);
  let valLead = 0;
  while (valLead < valRaw.length && valRaw[valLead] === " ") valLead++;
  if (valLead > 0) pushCodeToken(tokens, "plain", valRaw.slice(0, valLead));
  const valBody = valRaw.slice(valLead);
  const valTrim = valBody.trimEnd();
  const tailWs = valBody.slice(valTrim.length);
  if (valTrim) {
    if (CODE_BOOLEANS.has(valTrim)) {
      pushCodeToken(tokens, "boolean", valTrim);
    } else if (CODE_CONSTANTS.has(valTrim)) {
      pushCodeToken(tokens, "constant", valTrim);
    } else if (/^-?(?:0x[0-9a-fA-F_]+|\d+(?:\.\d+)?)(?:ms|s|m|h|d|kb|mb|gb)?$/i.test(valTrim)) {
      pushCodeToken(tokens, "number", valTrim);
    } else {
      emitStringTokens(tokens, valTrim, "string", { allowPathVars: false });
    }
  }
  if (tailWs) pushCodeToken(tokens, "plain", tailWs);
  return tokens;
}

export const MAX_PREVIEW_SYNTAX_LINE_CHARS = 1600;
export const MAX_PREVIEW_RENDER_LINE_CHARS = 4000;

export function expandCodeTabs(rawText) {
  if (!rawText) return "";
  const s = String(rawText);
  return s.indexOf("\t") !== -1 ? s.replace(/\t/g, "    ") : s;
}

// Single-pass linear tokenizer shared by preview rendering (lossless on all chars).
export function tokenizeCodeLine(rawText, ext = "", mdState = null) {
  const isMd = isMarkdownExt(ext);
  if (!rawText) {
    if (mdState && isMd) return tokenizeMarkdownLine("", mdState, tokenizeCodeLine);
    return null;
  }
  const text = expandCodeTabs(rawText);
  if (text.length > MAX_PREVIEW_SYNTAX_LINE_CHARS || ext === "txt" || ext === "log") {
    if (mdState && isMd) mdState.lineIndex += 1;
    return null;
  }
  if (isMd) {
    return tokenizeMarkdownLine(text, mdState, tokenizeCodeLine);
  }

  if (CODE_PROP_EXTS.has(ext)) {
    return tokenizePropertiesLine(text, []);
  }

  const tokens = [];
  const len = text.length;
  const hashComments = CODE_HASH_COMMENT_EXTS.has(ext);
  const slashComments = !ext || CODE_SLASH_COMMENT_EXTS.has(ext);
  const markup = CODE_MARKUP_EXTS.has(ext);
  const isPython = ext === "py" || ext === "pyw" || ext === "pyi";
  const isJson = ext === "json" || ext === "jsonc" || ext === "json5";
  const isYaml = ext === "yml" || ext === "yaml";
  const isCss = ext === "css" || ext === "scss" || ext === "less";
  const isSql = ext === "sql";
  const isRust = ext === "rs";
  const docTagsEnabled = CODE_DOC_COMMENT_EXTS.has(ext);

  if (docTagsEnabled && /^\s*\*\s*(?:$|\*\/|@(?:param|returns?|throws|exception|see|since|deprecated|author|version|implSpec|implNote|apiNote|code|linkplain|link|value|inheritDoc)\b)/.test(text)) {
    emitCommentTokens(tokens, text, true);
    return tokens;
  }

  let i = 0;
  let plainStart = 0;
  const flushPlain = (end) => {
    if (end > plainStart) {
      pushCodeToken(tokens, "plain", text.slice(plainStart, end));
    }
    plainStart = end;
  };

  while (i < len) {
    const ch = text[i];

    // Markup <!-- comment -->
    if (markup && ch === "<" && text.startsWith("<!--", i)) {
      flushPlain(i);
      const close = text.indexOf("-->", i + 4);
      const end = close >= 0 ? close + 3 : len;
      pushCodeToken(tokens, "comment", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Line & block comments
    if (slashComments && ch === "/" && i + 1 < len) {
      const next = text[i + 1];
      if (next === "/") {
        flushPlain(i);
        emitCommentTokens(tokens, text.slice(i), docTagsEnabled);
        return tokens;
      }
      if (next === "*") {
        flushPlain(i);
        const close = text.indexOf("*/", i + 2);
        const end = close >= 0 ? close + 2 : len;
        emitCommentTokens(tokens, text.slice(i, end), docTagsEnabled);
        i = plainStart = end;
        continue;
      }
    }

    if (hashComments && ch === "#") {
      flushPlain(i);
      pushCodeToken(tokens, "comment", text.slice(i));
      return tokens;
    }

    if (isSql && ch === "-" && text[i + 1] === "-") {
      flushPlain(i);
      pushCodeToken(tokens, "comment", text.slice(i));
      return tokens;
    }

    // Python prefixed strings (f"...", r"...", b"...", fr"...")
    if (isPython && (ch === "f" || ch === "F" || ch === "r" || ch === "R" || ch === "b" || ch === "B" || ch === "u" || ch === "U") && (i === 0 || !isIdentPartCh(text[i - 1]))) {
      let qOff = i + 1;
      if (qOff < len && (text[qOff] === "f" || text[qOff] === "F" || text[qOff] === "r" || text[qOff] === "R" || text[qOff] === "b" || text[qOff] === "B")) {
        qOff++;
      }
      const prefix = text.slice(i, qOff);
      const quote = text[qOff];
      if ((quote === '"' || quote === "'") && isPyStringPrefix(prefix)) {
        const isTriple = text[qOff + 1] === quote && text[qOff + 2] === quote;
        const step = isTriple ? 3 : 1;
        const delim = isTriple ? quote + quote + quote : quote;
        let end = qOff + step;
        const isRaw = prefix.toLowerCase().includes("r");
        while (end < len) {
          if (!isRaw && text[end] === "\\") {
            end = end + 1 < len ? end + 2 : len;
            continue;
          }
          if (isTriple ? text.startsWith(delim, end) : text[end] === quote) {
            end += step;
            break;
          }
          end++;
        }
        flushPlain(i);
        pushCodeToken(tokens, "keyword", prefix);
        emitStringTokens(tokens, text.slice(qOff, end), "string", {
          isFString: prefix.toLowerCase().includes("f"),
        });
        i = plainStart = end;
        continue;
      }
    }

    // Strings ("...", '...', `...`, and """...""" / '''...''')
    if (ch === '"' || ch === "'" || ch === "`") {
      if (isRust && ch === "'" && i + 1 < len && text[i + 1] !== "\\" && (i + 2 >= len || text[i + 2] !== "'")) {
        i++;
        continue;
      }
      if (ch === "'" && i > 0 && isIdentPartCh(text[i - 1])) {
        i++;
        continue;
      }
      const isTriple = (ch === '"' || ch === "'") && text[i + 1] === ch && text[i + 2] === ch;
      const step = isTriple ? 3 : 1;
      const delim = isTriple ? ch + ch + ch : ch;
      let end = i + step;
      while (end < len) {
        if (text[end] === "\\") {
          end = end + 1 < len ? end + 2 : len;
          continue;
        }
        if (isTriple ? text.startsWith(delim, end) : text[end] === ch) {
          end += step;
          break;
        }
        end++;
      }
      flushPlain(i);
      let kind = "string";
      if (isJson && ch === '"') {
        let look = end;
        while (look < len && text[look] === " ") look++;
        if (look < len && text[look] === ":") kind = "function";
      }
      emitStringTokens(tokens, text.slice(i, end), kind, {
        isTemplate: ch === "`",
        allowPathVars: ch === '"',
      });
      i = plainStart = end;
      continue;
    }

    // CSS #hex color literals
    if (isCss && ch === "#" && i + 1 < len && /[0-9a-fA-F]/.test(text[i + 1])) {
      let end = i + 1;
      while (end < len && /[0-9a-fA-F]/.test(text[end])) end++;
      flushPlain(i);
      pushCodeToken(tokens, "number", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Decorators / Spring Annotations (@RestController, @GetMapping, @app.get, CSS @media)
    if (ch === "@" && i + 1 < len && isIdentStartCh(text[i + 1]) && (i === 0 || !isIdentPartCh(text[i - 1]))) {
      let end = i + 2;
      while (end < len && (isIdentPartCh(text[end]) || text[end] === ".")) end++;
      flushPlain(i);
      pushCodeToken(tokens, isCss ? "keyword" : "annotation", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Markup / JSX tags (<div, </div, <MyComponent)
    if (ch === "<" && i + 1 < len && (markup || ext === "jsx" || ext === "tsx")) {
      let tagStart = i + 1;
      if (text[tagStart] === "/") tagStart++;
      if (tagStart < len && /[A-Za-z]/.test(text[tagStart])) {
        let end = tagStart + 1;
        while (end < len && (isIdentPartCh(text[end]) || text[end] === "-" || text[end] === ":" || text[end] === ".")) end++;
        flushPlain(tagStart);
        const tagName = text.slice(tagStart, end);
        const isComponent = tagName[0] >= "A" && tagName[0] <= "Z";
        pushCodeToken(tokens, isComponent ? "type" : "keyword", tagName);
        i = plainStart = end;
        continue;
      }
    }

    // Numbers (standalone, not trailing digits inside foo123)
    if (isDigitCh(ch) && (i === 0 || !isIdentPartCh(text[i - 1]))) {
      let end = i + 1;
      if (ch === "0" && end < len && (text[end] === "x" || text[end] === "X" || text[end] === "b" || text[end] === "B")) {
        end++;
        while (end < len && /[0-9a-fA-F_]/.test(text[end])) end++;
      } else {
        while (end < len && /[0-9._]/.test(text[end])) end++;
        if (end < len && (text[end] === "e" || text[end] === "E") && end + 1 < len && /[0-9+\-]/.test(text[end + 1])) {
          end += 2;
          while (end < len && /[0-9_]/.test(text[end])) end++;
        }
        while (end < len && /[a-zA-Z%]/.test(text[end])) end++;
      }
      flushPlain(i);
      pushCodeToken(tokens, "number", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Operators & language arrows (->, =>, ::, ?., ??, ===, !==, <=, >=, ..., :=, &&, ||, arithmetic/comparisons)
    if (
      (ch === "-" && text[i + 1] === ">") ||
      (ch === "=" && text[i + 1] === ">") ||
      (ch === ":" && (text[i + 1] === ":" || text[i + 1] === "=")) ||
      (ch === "?" && (text[i + 1] === "." || text[i + 1] === "?")) ||
      (ch === "." && text[i + 1] === "." && text[i + 2] === ".")
    ) {
      const opLen = ch === "." ? 3 : 2;
      flushPlain(i);
      pushCodeToken(tokens, "operator", text.slice(i, i + opLen));
      i = plainStart = i + opLen;
      continue;
    }

    if ((ch === "<" || ch === ">") && (text[i + 1] === "=" || text[i + 1] === ch)) {
      let end = i + 2;
      if (ch === ">" && text[i + 1] === ">" && text[i + 2] === ">") end = i + 3;
      if (text[end] === "=") end++;
      flushPlain(i);
      pushCodeToken(tokens, "operator", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (
      ch === "=" || ch === "!" || ch === "&" || ch === "|" || ch === "+" ||
      ch === "-" || ch === "*" || ch === "/" || ch === "%" || ch === "^" || ch === "~"
    ) {
      let end = i + 1;
      while (end < len && (text[end] === "=" || text[end] === "&" || text[end] === "|" || text[end] === "*" || text[end] === "+")) {
        end++;
      }
      flushPlain(i);
      pushCodeToken(tokens, "operator", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Identifiers / Keywords / Types / Constants / Booleans / Special Vars / Function calls / Method refs / YAML keys
    if (isIdentStartCh(ch)) {
      let end = i + 1;
      while (end < len && (isIdentPartCh(text[end]) || (isYaml && text[end] === "-"))) end++;
      const word = text.slice(i, end);
      let kind = "plain";
      let look = end;
      while (look < len && text[look] === " ") look++;
      const isCall = text[look] === "(";
      const prevTwo = i >= 2 ? text.slice(i - 2, i) : "";

      if (isYaml && text[look] === ":" && (look + 1 === len || text[look + 1] === " ")) {
        kind = "function";
      } else if (prevTwo === "::" && word !== "new") {
        kind = "function";
      } else if (CODE_SPECIAL_VARS.has(word) || (!isPython && CODE_BUILTIN_VARS.has(word))) {
        kind = "variable";
      } else if (CODE_BOOLEANS.has(word)) {
        kind = "boolean";
      } else if (CODE_CONSTANTS.has(word) || (word.length > 1 && /^[A-Z][A-Z0-9_]+$/.test(word))) {
        kind = "constant";
      } else if (isPython && word === "type" && isCall) {
        kind = "function";
      } else if (CODE_KEYWORDS.has(word)) {
        kind = "keyword";
      } else if (/^[A-Z][a-zA-Z0-9_]*$/.test(word) || (CODE_TYPES.has(word) && !isCall)) {
        kind = "type";
      } else if (isCall || prevTwo === "::") {
        kind = "function";
      }

      if (kind !== "plain") {
        flushPlain(i);
        pushCodeToken(tokens, kind, word);
        i = plainStart = end;
        continue;
      }
      i = end;
      continue;
    }

    i++;
  }

  flushPlain(len);
  return tokens;
}

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
  let maxCols = 0;
  for (const line of lines || []) {
    if (!line) continue;
    const expanded = expandCodeTabs(line);
    const cols = Math.min(expanded.length, MAX_PREVIEW_RENDER_LINE_CHARS + 32);
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
