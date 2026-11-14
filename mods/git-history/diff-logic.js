// Pure zero-UI diff parsing, side-by-side alignment, syntax lexing, and theme palette helpers for git-history.
import { countWrappedLines, wrapPlainText, wrapStyledSpans } from "./code-wrap.js";

export const MAX_DIFF_SYNTAX_LINE_CHARS = 500;
export const MAX_VIEWER_DIFF_LINES = 1500;
export const DEFAULT_SBS_PAGE_ROWS = 180;
export const MAX_RENDER_TOKENS_PER_LINE = 28;
export const DIFF_ROW_HEIGHT = 24;
export const DIFF_HUNK_HEIGHT = 28;
export const DIFF_WAVE_GUTTER_WIDTH = 40;
export const DIFF_WAVE_MAX_CENTER_OFFSET_ROWS = 2;
const MAX_EXPANDED_VIEWER_DIFF_LINES = 4000;
const MAX_WIDTH_ESTIMATE_COLS = 4000;

export const DIFF_KEYWORDS = new Set([
  "abstract", "and", "as", "assert", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "crate", "debugger", "declare", "def", "default", "defer", "del",
  "delete", "do", "done", "dyn", "elif", "else", "enum", "esac", "except", "export",
  "extends", "fallthrough", "fi", "final", "finally", "fn", "for", "from", "fun", "func",
  "function", "get", "global", "go", "if", "impl", "implements", "import", "in",
  "instanceof", "interface", "is", "keyof", "lambda", "let", "local", "loop", "match",
  "mod", "move", "mut", "namespace", "native", "new", "nonlocal", "not", "of", "or",
  "override", "package", "pass", "permits", "private", "protected", "pub", "public",
  "raise", "range", "readonly", "record", "ref", "return", "satisfies", "sealed", "select",
  "set", "static", "strictfp", "struct", "switch", "synchronized", "then", "throw",
  "throws", "trait", "transient", "try", "type", "typeof", "unsafe", "unset", "use",
  "using", "val", "var", "virtual", "volatile", "where", "while", "with", "yield",
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY",
  "ORDER", "HAVING", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "ALTER",
  "DROP", "TABLE", "INDEX", "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "CASE", "WHEN",
  "THEN", "ELSE", "END", "DISTINCT", "LIMIT", "OFFSET", "UNION", "EXISTS", "RETURNING",
]);

const SQL_LOWER_KEYWORDS = new Set([
  "select", "from", "where", "join", "left", "right", "inner", "outer", "on", "group", "by",
  "order", "having", "insert", "into", "values", "update", "set", "delete", "create", "alter",
  "drop", "table", "index", "as", "and", "or", "not", "in", "is", "null", "case", "when",
  "then", "else", "end", "distinct", "limit", "offset", "union", "exists", "returning",
  "primary", "key", "foreign", "references", "default", "unique", "begin", "commit", "rollback",
]);

export const DIFF_BOOLEANS = new Set(["true", "false", "True", "False"]);

export const DIFF_CONSTANTS = new Set([
  "null", "nil", "None", "undefined", "NaN", "Infinity", "iota",
]);

export const DIFF_SPECIAL_VARS = new Set(["this", "super", "self", "Self", "cls"]);

export const DIFF_BUILTIN_VARS = new Set([
  "console", "process", "window", "document", "globalThis", "module", "exports",
]);

export const DIFF_TYPES = new Set([
  "void", "int", "long", "short", "byte", "float", "double", "boolean", "bool", "char",
  "string", "number", "any", "unknown", "never", "object", "symbol", "bigint", "str",
  "list", "dict", "set", "tuple", "frozenset", "bytes", "rune", "error", "uintptr",
  "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64",
  "complex64", "complex128",
  "usize", "isize", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32", "f64",
  "String", "Object", "Class", "Integer", "Long", "Double", "Float", "Boolean", "Character", "Byte", "Short",
  "Number", "BigDecimal", "BigInteger", "UUID", "Instant", "LocalDate", "LocalDateTime", "Duration",
  "List", "ArrayList", "Map", "HashMap", "LinkedHashMap", "Set", "HashSet", "Collection", "Iterable",
  "Stream", "Optional", "CompletableFuture", "Future", "ResponseEntity", "HttpStatus", "HttpHeaders",
  "Pageable", "Page", "Slice", "Sort", "Model", "Exception", "RuntimeException", "Throwable",
  "Promise", "Array", "Record", "Date", "RegExp", "Error", "Any", "Union", "Dict", "Tuple",
  "Sequence", "Mapping", "Callable", "Coroutine", "Vec", "Option", "Result", "Box", "Arc",
]);

export const HASH_COMMENT_EXTS = new Set([
  "py", "pyw", "pyi", "rb", "sh", "bash", "zsh", "fish", "yml", "yaml", "toml", "ps1", "psm1", "psd1",
  "r", "pl", "pm", "mk", "makefile", "dockerfile", "env", "ini", "conf", "cfg", "properties",
  "tf", "tfvars", "gitignore",
]);

export const SLASH_COMMENT_EXTS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "java", "kt", "kts", "cs",
  "go", "rs", "c", "cpp", "cc", "cxx", "h", "hpp", "swift", "scala", "groovy", "gradle",
  "php", "css", "scss", "less", "jsonc", "json5", "dart", "proto",
]);

export const MARKUP_EXTS = new Set(["html", "htm", "xml", "svg", "vue", "svelte"]);
const PROP_EXTS = new Set(["properties", "env", "ini", "conf", "cfg"]);
const DOC_COMMENT_EXTS = new Set(["java", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "kt", "kts", "groovy", "scala"]);
const DOC_TAG_RE = /@(?:param|returns?|throws|exception|see|since|deprecated|author|version|implSpec|implNote|apiNote|code|linkplain|link|value|inheritDoc)\b/g;

function parseHexRgb(hex) {
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

function hexLuma(hex) {
  const rgb = parseHexRgb(hex);
  if (!rgb) return null;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

function isDarkTheme(t) {
  if (!t) return true;
  if (typeof t.is_dark === "boolean") return t.is_dark;
  if (t.appearance === "light") return false;
  if (t.appearance === "dark") return true;
  const bg = hexLuma(t.background);
  return bg === null ? true : bg < 0.5;
}

function pickTone(candidate, fallback, isDark, minDarkLuma = 0.36, maxLightLuma = 0.58) {
  const luma = hexLuma(candidate);
  if (luma === null) return fallback;
  if (isDark ? luma < minDarkLuma : luma > maxLightLuma) return fallback;
  return candidate;
}

let cachedDiffThemeRef = null;
let cachedDiffThemeSig = "";
let cachedDiffPalette = null;

function buildThemePaletteSig(t) {
  if (!t || typeof t !== "object") return "default";
  return `${t.is_dark}|${t.appearance}|${t.background}|${t.foreground}|${t.dim}|${t.muted}|${t.ansi1}|${t.ansi2}|${t.ansi3}|${t.ansi4}|${t.ansi5}|${t.ansi6}`;
}

export function getDiffSyntaxPalette(t) {
  if (t && t === cachedDiffThemeRef && cachedDiffPalette) return cachedDiffPalette;
  if (t && t._isSyntaxPalette) return t;
  const sig = buildThemePaletteSig(t);
  if (cachedDiffPalette && sig === cachedDiffThemeSig) {
    if (t) cachedDiffThemeRef = t;
    return cachedDiffPalette;
  }
  const isDark = isDarkTheme(t);
  const warmAmber = isDark ? "#d19a66" : "#b35900";
  const cyan = pickTone(t?.ansi6, isDark ? "#56b6c2" : "#0e7490", isDark);
  const coral = pickTone(t?.ansi1, isDark ? "#e06c75" : "#cf222e", isDark);
  const palette = {
    _isSyntaxPalette: true,
    _sig: sig,
    isDark,
    keyword: pickTone(t?.ansi5, isDark ? "#c678dd" : "#8250df", isDark),
    string: pickTone(t?.ansi2, isDark ? "#98c379" : "#116329", isDark),
    escape: cyan,
    comment: pickTone(t?.dim || t?.muted, isDark ? "#7f848e" : "#6e7781", isDark, 0.34, 0.56),
    function: pickTone(t?.ansi4, isDark ? "#61afef" : "#0969da", isDark),
    type: pickTone(t?.ansi3, isDark ? "#e5c07b" : "#9a6700", isDark),
    annotation: coral,
    variable: coral,
    number: warmAmber,
    boolean: warmAmber,
    constant: warmAmber,
    operator: cyan,
    plain: pickTone(t?.foreground, isDark ? "#abb2bf" : "#24292f", isDark, 0.45, 0.45),
    muted: pickTone(t?.muted || t?.dim, isDark ? "#8b93a2" : "#57606a", isDark, 0.34, 0.56),
  };
  cachedDiffThemeSig = sig;
  cachedDiffPalette = palette;
  if (t) {
    cachedDiffThemeRef = t;
  }
  return palette;
}

export function diffSyntaxTokenColor(kind, t) {
  const p = t && t._isSyntaxPalette ? t : getDiffSyntaxPalette(t);
  switch (kind) {
    case "keyword": return p.keyword;
    case "string": return p.string;
    case "string.escape": return p.escape;
    case "comment": return p.comment;
    case "function": return p.function;
    case "type": return p.type;
    case "annotation": return p.annotation;
    case "variable": return p.variable;
    case "number": return p.number;
    case "boolean": return p.boolean;
    case "constant": return p.constant;
    case "operator": return p.operator;
    default: return p.plain;
  }
}

export function toNbspString(text) {
  if (!text) return "";
  const s = typeof text === "string" ? text : String(text);
  return s.indexOf(" ") === -1 ? s : s.replace(/ /g, "\u00a0");
}

/**
 * Resolves, caps, converts spaces to non-breaking spaces, and merges adjacent
 * identically colored syntax spans once so hot GPUI render loops allocate no
 * intermediate token arrays or regex replacements.
 */
export function prepareRenderLineData(tokens, plainText, paletteOrTheme, fallbackColor, maxTokens = MAX_RENDER_TOKENS_PER_LINE) {
  const palette = paletteOrTheme && paletteOrTheme._isSyntaxPalette
    ? paletteOrTheme
    : getDiffSyntaxPalette(paletteOrTheme);
  if (!Array.isArray(tokens) || tokens.length === 0) {
    const expanded = plainText ? expandCodeTabs(plainText) : " ";
    return {
      kind: "single",
      color: fallbackColor,
      text: toNbspString(expanded || " "),
    };
  }

  const tokList = capRenderTokens(tokens, maxTokens);
  if (tokList.length === 1) {
    const [tokKind, tokText] = tokList[0];
    return {
      kind: "single",
      color: diffSyntaxTokenColor(tokKind, palette),
      text: toNbspString(tokText || " "),
    };
  }

  const spans = [];
  for (let i = 0; i < tokList.length; i++) {
    const tok = tokList[i];
    const color = diffSyntaxTokenColor(tok[0], palette);
    const nbsp = toNbspString(tok[1] || "");
    if (!nbsp) continue;
    const prev = spans.length > 0 ? spans[spans.length - 1] : null;
    if (prev && prev[0] === color) {
      prev[1] += nbsp;
    } else {
      spans.push([color, nbsp]);
    }
  }

  if (spans.length === 0) {
    return { kind: "single", color: fallbackColor, text: "\u00a0" };
  }
  if (spans.length === 1) {
    return { kind: "single", color: spans[0][0], text: spans[0][1] };
  }
  return { kind: "multi", spans };
}

export function countCellVisualRows(text, wrapCols) {
  const cols = Number(wrapCols);
  if (!Number.isFinite(cols) || cols <= 0) return 1;
  return countWrappedLines(text, cols);
}

/**
 * Resolves syntax/plain tokens once and splits them into visual sub-rows fitting `wrapCols`
 * without losing colors or dropping whitespace.
 */
export function prepareWrappedRenderLines(tokens, plainText, paletteOrTheme, fallbackColor, wrapCols, maxTokens = MAX_RENDER_TOKENS_PER_LINE) {
  const base = prepareRenderLineData(tokens, plainText, paletteOrTheme, fallbackColor, maxTokens);
  const cols = Number(wrapCols);
  if (!Number.isFinite(cols) || cols <= 0) {
    return [base];
  }
  if (base.kind === "single") {
    const txt = base.text;
    if (txt.length <= cols && txt.indexOf("\t") === -1 && txt.indexOf("\r") === -1) {
      return [base];
    }
    const segs = wrapPlainText(txt, cols, { toNbsp: false });
    if (segs.length <= 1) {
      return [base];
    }
    const out = new Array(segs.length);
    for (let i = 0; i < segs.length; i += 1) {
      out[i] = {
        kind: "single",
        color: base.color,
        text: segs[i] || "\u00a0",
      };
    }
    return out;
  }

  let totalLen = 0;
  let hasTabOrCr = false;
  for (let i = 0; i < base.spans.length; i += 1) {
    const s = base.spans[i][1];
    totalLen += s.length;
    if (!hasTabOrCr && (s.indexOf("\t") !== -1 || s.indexOf("\r") !== -1)) {
      hasTabOrCr = true;
    }
    if (totalLen > cols && hasTabOrCr) break;
  }
  if (!hasTabOrCr && totalLen <= cols) {
    return [base];
  }

  const wrappedRows = wrapStyledSpans(base.spans, cols, { toNbsp: false });
  if (wrappedRows.length <= 1) {
    return [base];
  }
  const out = new Array(wrappedRows.length);
  for (let i = 0; i < wrappedRows.length; i += 1) {
    const rowSpans = wrappedRows[i];
    if (!rowSpans || rowSpans.length === 0) {
      out[i] = { kind: "single", color: fallbackColor, text: "\u00a0" };
    } else if (rowSpans.length === 1) {
      out[i] = { kind: "single", color: rowSpans[0][0], text: rowSpans[0][1] || "\u00a0" };
    } else {
      out[i] = { kind: "multi", spans: rowSpans };
    }
  }
  return out;
}

export function getFileExt(filePath) {
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

export function expandCodeTabs(text, tabSize = 4) {
  if (!text) return "";
  const s = String(text);
  if (s.indexOf("\t") === -1) return s;
  const size = Number.isFinite(Number(tabSize)) && Number(tabSize) > 0 ? Math.floor(Number(tabSize)) : 4;
  return s.replace(/\t/g, " ".repeat(size));
}

function pushSyntaxToken(tokens, kind, text) {
  if (!text) return;
  const last = tokens.length ? tokens[tokens.length - 1] : null;
  if (last && last[0] === kind) {
    last[1] += text;
  } else {
    tokens.push([kind, text]);
  }
}

function isIdentStart(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

function isIdentPart(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;
}

function isDigit(ch) {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isPyStringPrefix(str) {
  const s = str.toLowerCase();
  return s === "f" || s === "r" || s === "b" || s === "u" || s === "fr" || s === "rf" || s === "br" || s === "rb";
}

function emitDiffComment(tokens, slice, enableDocTags) {
  if (!enableDocTags || slice.indexOf("@") === -1) {
    pushSyntaxToken(tokens, "comment", slice);
    return;
  }
  DOC_TAG_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = DOC_TAG_RE.exec(slice)) !== null) {
    const idx = m.index;
    const prev = idx > 0 ? slice[idx - 1] : " ";
    if (prev !== " " && prev !== "\t" && prev !== "{" && prev !== "*") continue;
    if (idx > last) pushSyntaxToken(tokens, "comment", slice.slice(last, idx));
    pushSyntaxToken(tokens, "annotation", m[0]);
    last = idx + m[0].length;
  }
  if (last < slice.length) pushSyntaxToken(tokens, "comment", slice.slice(last));
}

const TPL_VAR_NAME_RE = /^[a-zA-Z0-9_.:-]+$/;
const PATH_VAR_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;
const PROP_NUMBER_RE = /^-?(?:0x[0-9a-fA-F_]+|\d+(?:\.\d+)?)(?:ms|s|m|h|d|kb|mb|gb)?$/i;
const MD_HEADING_RE = /^\s*#{1,6}\s/;
const DOC_LINE_START_RE = /^\s*\*\s*(?:$|\*\/|@(?:param|returns?|throws|exception|see|since|deprecated|author|version|implSpec|implNote|apiNote|code|linkplain|link|value|inheritDoc)\b)/;
const UPPER_CONST_RE = /^[A-Z][A-Z0-9_]+$/;
const PASCAL_TYPE_RE = /^[A-Z][a-zA-Z0-9_]*$/;

function isHexDigitChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function isAsciiAlphaChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isDigitUnderscoreChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || c === 95;
}

function isDecDotChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || c === 46 || c === 95;
}

function isNumSuffixChar(ch) {
  return isAsciiAlphaChar(ch) || ch === "%";
}

function emitDiffStringSegments(tokens, slice, baseKind, opts = {}) {
  if (baseKind !== "string") {
    pushSyntaxToken(tokens, baseKind, slice);
    return;
  }
  const { isTemplate = false, isFString = false, allowPathVars = false } = opts;
  const len = slice.length;
  let i = 0;
  let segStart = 0;
  const flushSeg = (end) => {
    if (end > segStart) pushSyntaxToken(tokens, "string", slice.slice(segStart, end));
    segStart = end;
  };
  while (i < len) {
    const ch = slice[i];
    if (ch === "\\") {
      flushSeg(i);
      const escEnd = Math.min(len, slice[i + 1] === "u" ? i + 6 : slice[i + 1] === "x" ? i + 4 : i + 2);
      pushSyntaxToken(tokens, "string.escape", slice.slice(i, escEnd));
      i = segStart = escEnd;
      continue;
    }
    if (ch === "$" && i + 1 < len && slice[i + 1] === "{") {
      const close = slice.indexOf("}", i + 2);
      if (close > i + 2 && (isTemplate || TPL_VAR_NAME_RE.test(slice.slice(i + 2, close)))) {
        flushSeg(i);
        pushSyntaxToken(tokens, "string.escape", slice.slice(i, close + 1));
        i = segStart = close + 1;
        continue;
      }
    }
    if (ch === "{") {
      if (isFString && slice[i + 1] === "{") {
        flushSeg(i);
        pushSyntaxToken(tokens, "string.escape", "{{");
        i = segStart = i + 2;
        continue;
      }
      const close = slice.indexOf("}", i + 1);
      if (close > i) {
        const inner = slice.slice(i + 1, close);
        const isPathOrSlf4j = allowPathVars && (inner === "" || (slice[i - 1] === "/" && PATH_VAR_NAME_RE.test(inner)));
        const isPyInterp = isFString && inner.length > 0 && !inner.includes("\n");
        if (isPathOrSlf4j || isPyInterp) {
          flushSeg(i);
          pushSyntaxToken(tokens, "string.escape", slice.slice(i, close + 1));
          i = segStart = close + 1;
          continue;
        }
      }
    }
    if (isFString && ch === "}" && slice[i + 1] === "}") {
      flushSeg(i);
      pushSyntaxToken(tokens, "string.escape", "}}");
      i = segStart = i + 2;
      continue;
    }
    i++;
  }
  flushSeg(len);
}

function tokenizeDiffPropertiesLine(text, tokens) {
  let lead = 0;
  while (lead < text.length && text[lead] === " ") lead++;
  if (lead > 0) pushSyntaxToken(tokens, "plain", text.slice(0, lead));
  const trimmed = text.slice(lead);
  if (!trimmed) return tokens;
  if (trimmed[0] === "#" || trimmed[0] === "!") {
    pushSyntaxToken(tokens, "comment", trimmed);
    return tokens;
  }
  const eqIdx = text.indexOf("=", lead);
  const colIdx = text.indexOf(":", lead);
  const sep = eqIdx >= 0 && colIdx >= 0 ? Math.min(eqIdx, colIdx) : Math.max(eqIdx, colIdx);
  if (sep < 0) {
    pushSyntaxToken(tokens, "plain", trimmed);
    return tokens;
  }
  const keySlice = text.slice(lead, sep);
  const trimmedKey = keySlice.trimEnd();
  if (trimmedKey) pushSyntaxToken(tokens, "function", trimmedKey);
  if (trimmedKey.length < keySlice.length) {
    pushSyntaxToken(tokens, "plain", keySlice.slice(trimmedKey.length));
  }
  pushSyntaxToken(tokens, "operator", text[sep]);
  const valRaw = text.slice(sep + 1);
  let valLead = 0;
  while (valLead < valRaw.length && valRaw[valLead] === " ") valLead++;
  if (valLead > 0) pushSyntaxToken(tokens, "plain", valRaw.slice(0, valLead));
  const valBody = valRaw.slice(valLead);
  const valTrim = valBody.trimEnd();
  const tailWs = valBody.slice(valTrim.length);
  if (valTrim) {
    if (DIFF_BOOLEANS.has(valTrim)) {
      pushSyntaxToken(tokens, "boolean", valTrim);
    } else if (DIFF_CONSTANTS.has(valTrim)) {
      pushSyntaxToken(tokens, "constant", valTrim);
    } else if (PROP_NUMBER_RE.test(valTrim)) {
      pushSyntaxToken(tokens, "number", valTrim);
    } else {
      emitDiffStringSegments(tokens, valTrim, "string", { allowPathVars: false });
    }
  }
  if (tailWs) pushSyntaxToken(tokens, "plain", tailWs);
  return tokens;
}

export function tokenizeDiffLine(line, ext) {
  if (!line) return null;
  const text = expandCodeTabs(line);
  if (text.length > MAX_DIFF_SYNTAX_LINE_CHARS || ext === "txt" || ext === "log") return null;

  const normExt = String(ext || "").toLowerCase();
  if (PROP_EXTS.has(normExt)) {
    return tokenizeDiffPropertiesLine(text, []);
  }

  const tokens = [];
  const len = text.length;
  const hashComments = HASH_COMMENT_EXTS.has(normExt);
  const slashComments = !normExt || SLASH_COMMENT_EXTS.has(normExt);
  const markup = MARKUP_EXTS.has(normExt);
  const isPython = normExt === "py" || normExt === "pyw" || normExt === "pyi";
  const isJson = normExt === "json" || normExt === "jsonc" || normExt === "json5";
  const isYaml = normExt === "yml" || normExt === "yaml";
  const isCss = normExt === "css" || normExt === "scss" || normExt === "less";
  const isSql = normExt === "sql";
  const isRust = normExt === "rs";
  const isShell = normExt === "sh" || normExt === "bash" || normExt === "zsh" || normExt === "fish";
  const isMd = normExt === "md" || normExt === "mdx";
  const docTagsEnabled = DOC_COMMENT_EXTS.has(normExt);

  if (isMd && MD_HEADING_RE.test(text)) {
    return [["keyword", text]];
  }
  if (docTagsEnabled && DOC_LINE_START_RE.test(text)) {
    emitDiffComment(tokens, text, true);
    return tokens;
  }

  let i = 0;
  let plainStart = 0;
  const flushPlain = (end) => {
    if (end > plainStart) {
      pushSyntaxToken(tokens, "plain", text.slice(plainStart, end));
    }
    plainStart = end;
  };

  while (i < len) {
    const ch = text[i];

    if (markup && ch === "<" && text.startsWith("<!--", i)) {
      flushPlain(i);
      const close = text.indexOf("-->", i + 4);
      const end = close >= 0 ? close + 3 : len;
      pushSyntaxToken(tokens, "comment", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (slashComments && ch === "/" && i + 1 < len) {
      const next = text[i + 1];
      if (next === "/") {
        flushPlain(i);
        emitDiffComment(tokens, text.slice(i), docTagsEnabled);
        return tokens;
      }
      if (next === "*") {
        flushPlain(i);
        const close = text.indexOf("*/", i + 2);
        const end = close >= 0 ? close + 2 : len;
        emitDiffComment(tokens, text.slice(i, end), docTagsEnabled);
        i = plainStart = end;
        continue;
      }
    }

    if (hashComments && ch === "#") {
      flushPlain(i);
      pushSyntaxToken(tokens, "comment", text.slice(i));
      return tokens;
    }

    if (isSql && ch === "-" && text[i + 1] === "-") {
      flushPlain(i);
      pushSyntaxToken(tokens, "comment", text.slice(i));
      return tokens;
    }

    if (isPython && (ch === "f" || ch === "F" || ch === "r" || ch === "R" || ch === "b" || ch === "B" || ch === "u" || ch === "U") && (i === 0 || !isIdentPart(text[i - 1]))) {
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
        pushSyntaxToken(tokens, "keyword", prefix);
        emitDiffStringSegments(tokens, text.slice(qOff, end), "string", {
          isFString: prefix.toLowerCase().includes("f"),
        });
        i = plainStart = end;
        continue;
      }
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      if (isRust && ch === "'" && i + 1 < len && text[i + 1] !== "\\" && (i + 2 >= len || text[i + 2] !== "'")) {
        i++;
        continue;
      }
      if (ch === "'" && (isMd || (i > 0 && isIdentPart(text[i - 1])))) {
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
      emitDiffStringSegments(tokens, text.slice(i, end), kind, {
        isTemplate: ch === "`" || (isShell && ch === '"'),
        allowPathVars: ch === '"',
      });
      i = plainStart = end;
      continue;
    }

    if (isShell && ch === "$" && i + 1 < len && (text[i + 1] === "{" || isIdentStart(text[i + 1]))) {
      let end = i + 1;
      if (text[end] === "{") {
        const close = text.indexOf("}", end + 1);
        end = close > end ? close + 1 : len;
      } else {
        end++;
        while (end < len && isIdentPart(text[end])) end++;
      }
      flushPlain(i);
      pushSyntaxToken(tokens, "variable", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (isCss && ch === "#" && i + 1 < len && isHexDigitChar(text[i + 1])) {
      let end = i + 1;
      while (end < len && isHexDigitChar(text[end])) end++;
      flushPlain(i);
      pushSyntaxToken(tokens, "number", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (ch === "@" && i + 1 < len && isIdentStart(text[i + 1]) && (i === 0 || !isIdentPart(text[i - 1]))) {
      let end = i + 2;
      while (end < len && (isIdentPart(text[end]) || text[end] === ".")) end++;
      flushPlain(i);
      pushSyntaxToken(tokens, isCss ? "keyword" : "annotation", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (ch === "<" && i + 1 < len && (markup || normExt === "jsx" || normExt === "tsx")) {
      let tagStart = i + 1;
      if (text[tagStart] === "/") tagStart++;
      if (tagStart < len && isAsciiAlphaChar(text[tagStart])) {
        let end = tagStart + 1;
        while (end < len && (isIdentPart(text[end]) || text[end] === "-" || text[end] === ":" || text[end] === ".")) end++;
        flushPlain(tagStart);
        const tagName = text.slice(tagStart, end);
        const isComponent = tagName[0] >= "A" && tagName[0] <= "Z";
        pushSyntaxToken(tokens, isComponent ? "type" : "keyword", tagName);
        i = plainStart = end;
        continue;
      }
    }

    if (isDigit(ch) && (i === 0 || !isIdentPart(text[i - 1]))) {
      let end = i + 1;
      if (ch === "0" && end < len && (text[end] === "x" || text[end] === "X" || text[end] === "b" || text[end] === "B")) {
        end++;
        while (end < len && (isHexDigitChar(text[end]) || text[end] === "_")) end++;
      } else {
        while (end < len && isDecDotChar(text[end])) end++;
        if (
          end < len &&
          (text[end] === "e" || text[end] === "E") &&
          end + 1 < len &&
          (isDigit(text[end + 1]) || text[end + 1] === "+" || text[end + 1] === "-")
        ) {
          end += 2;
          while (end < len && isDigitUnderscoreChar(text[end])) end++;
        }
        while (end < len && isNumSuffixChar(text[end])) end++;
      }
      flushPlain(i);
      pushSyntaxToken(tokens, "number", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (
      (ch === "-" && text[i + 1] === ">") ||
      (ch === "<" && text[i + 1] === "-") ||
      (ch === "=" && text[i + 1] === ">") ||
      (ch === ":" && (text[i + 1] === ":" || text[i + 1] === "=")) ||
      (ch === "?" && (text[i + 1] === "." || text[i + 1] === "?")) ||
      (ch === "." && text[i + 1] === "." && text[i + 2] === ".")
    ) {
      const opLen = ch === "." ? 3 : 2;
      flushPlain(i);
      pushSyntaxToken(tokens, "operator", text.slice(i, i + opLen));
      i = plainStart = i + opLen;
      continue;
    }

    if ((ch === "<" || ch === ">") && (text[i + 1] === "=" || text[i + 1] === ch)) {
      let end = i + 2;
      if (ch === ">" && text[i + 1] === ">" && text[i + 2] === ">") end = i + 3;
      if (text[end] === "=") end++;
      flushPlain(i);
      pushSyntaxToken(tokens, "operator", text.slice(i, end));
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
      pushSyntaxToken(tokens, "operator", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && (isIdentPart(text[end]) || (isYaml && text[end] === "-"))) end++;
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
      } else if (DIFF_SPECIAL_VARS.has(word) || (!isPython && DIFF_BUILTIN_VARS.has(word))) {
        kind = "variable";
      } else if (DIFF_BOOLEANS.has(word)) {
        kind = "boolean";
      } else if (DIFF_CONSTANTS.has(word) || (word.length > 1 && UPPER_CONST_RE.test(word) && !(isSql && DIFF_KEYWORDS.has(word)))) {
        kind = "constant";
      } else if (isPython && word === "type" && isCall) {
        kind = "function";
      } else if (DIFF_KEYWORDS.has(word) || (isSql && SQL_LOWER_KEYWORDS.has(word.toLowerCase()))) {
        kind = "keyword";
      } else if (PASCAL_TYPE_RE.test(word) || (DIFF_TYPES.has(word) && !isCall)) {
        kind = "type";
      } else if (isCall || prevTwo === "::") {
        kind = "function";
      }

      if (kind !== "plain") {
        flushPlain(i);
        pushSyntaxToken(tokens, kind, word);
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

function unquoteGitPath(raw) {
  const s = String(raw || "");
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\" || i + 1 >= inner.length) {
      for (const b of new TextEncoder().encode(ch)) bytes.push(b);
      continue;
    }
    const next = inner[++i];
    if (next >= "0" && next <= "7") {
      let oct = next;
      if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") oct += inner[++i];
      if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") oct += inner[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else {
      const escMap = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
      const code = escMap[next];
      if (code !== undefined) {
        bytes.push(code);
      } else {
        for (const b of new TextEncoder().encode(next)) bytes.push(b);
      }
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

function joinRenameSegments(prefix, mid, suffix) {
  let out = `${prefix}${mid}${suffix}`;
  if (mid === "") {
    if (prefix.endsWith("/") && suffix.startsWith("/")) {
      out = `${prefix}${suffix.slice(1)}`;
    } else if (!prefix && suffix.startsWith("/")) {
      out = suffix.slice(1);
    } else if (prefix.endsWith("/") && !suffix) {
      out = prefix.slice(0, -1);
    }
  }
  return out;
}

function expandNumstatRenamePath(raw) {
  const s = String(raw || "").trim();
  const braceIdx = s.indexOf("{");
  if (braceIdx >= 0) {
    const closeIdx = s.indexOf("}", braceIdx);
    const arrowIdx = closeIdx > braceIdx ? s.indexOf(" => ", braceIdx) : -1;
    if (arrowIdx > braceIdx && arrowIdx < closeIdx) {
      const prefix = s.slice(0, braceIdx);
      const oldMid = s.slice(braceIdx + 1, arrowIdx);
      const newMid = s.slice(arrowIdx + 4, closeIdx);
      const suffix = s.slice(closeIdx + 1);
      return {
        oldPath: unquoteGitPath(joinRenameSegments(prefix, oldMid, suffix)),
        path: unquoteGitPath(joinRenameSegments(prefix, newMid, suffix)),
      };
    }
  }
  const plainArrow = s.indexOf(" => ");
  if (plainArrow > 0) {
    return {
      oldPath: unquoteGitPath(s.slice(0, plainArrow).trim()),
      path: unquoteGitPath(s.slice(plainArrow + 4).trim()),
    };
  }
  return { oldPath: null, path: unquoteGitPath(s) };
}

const VALID_COMMIT_STATUSES = new Set(["M", "A", "D", "R", "C", "T"]);

function normalizeCommitStatus(raw) {
  const ch = String(raw || "M").trim()[0]?.toUpperCase() || "M";
  return VALID_COMMIT_STATUSES.has(ch) ? ch : "M";
}

function parseNumstatEntries(numstatOut) {
  if (typeof numstatOut !== "string" || !numstatOut) return [];
  const entries = [];
  if (numstatOut.includes("\0")) {
    const tokens = numstatOut.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(tok);
      if (!m) continue;
      const binary = m[1] === "-" || m[2] === "-";
      const added = binary ? 0 : parseInt(m[1], 10) || 0;
      const deleted = binary ? 0 : parseInt(m[2], 10) || 0;
      if (m[3] === "") {
        const oldPath = unquoteGitPath(tokens[++i] || "");
        const newPath = unquoteGitPath(tokens[++i] || "");
        if (newPath) entries.push({ path: newPath, oldPath: oldPath || null, added, deleted, binary });
      } else {
        entries.push({ path: unquoteGitPath(m[3]), oldPath: null, added, deleted, binary });
      }
    }
    return entries;
  }

  for (const rawLine of numstatOut.split(/\r?\n/)) {
    if (!rawLine) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(rawLine);
    if (!m) continue;
    const binary = m[1] === "-" || m[2] === "-";
    const added = binary ? 0 : parseInt(m[1], 10) || 0;
    const deleted = binary ? 0 : parseInt(m[2], 10) || 0;
    const { oldPath, path } = expandNumstatRenamePath(m[3]);
    if (path) entries.push({ path, oldPath, added, deleted, binary });
  }
  return entries;
}

function parseRenameArrowPair(text) {
  const arrowIdx = text.indexOf(" -> ");
  if (arrowIdx >= 0) {
    return {
      oldPath: unquoteGitPath(text.slice(0, arrowIdx).trim()),
      path: unquoteGitPath(text.slice(arrowIdx + 4).trim()),
    };
  }
  const fatArrowIdx = text.indexOf(" => ");
  if (fatArrowIdx >= 0) {
    return {
      oldPath: unquoteGitPath(text.slice(0, fatArrowIdx).trim()),
      path: unquoteGitPath(text.slice(fatArrowIdx + 4).trim()),
    };
  }
  return null;
}

function parseNameStatusEntries(nameStatusOut) {
  if (typeof nameStatusOut !== "string" || !nameStatusOut) return [];
  const entries = [];
  if (nameStatusOut.includes("\0")) {
    const tokens = nameStatusOut.split("\0");
    for (let i = 0; i < tokens.length; i++) {
      let tok = tokens[i];
      if (!tok) continue;
      if (tok.includes("\n")) {
        tok = tok.slice(tok.lastIndexOf("\n") + 1);
      }
      const rawStatus = tok.trim();
      if (!rawStatus) continue;
      const status = normalizeCommitStatus(rawStatus);
      if (status === "R" || status === "C") {
        const oldPath = unquoteGitPath(tokens[++i] || "");
        const newPath = unquoteGitPath(tokens[++i] || "");
        if (newPath) entries.push({ status, oldPath: oldPath || null, path: newPath });
      } else {
        const filePath = unquoteGitPath(tokens[++i] || "");
        if (filePath) entries.push({ status, oldPath: null, path: filePath });
      }
    }
    return entries;
  }

  for (const rawLine of nameStatusOut.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes("\t")) {
      const parts = line.split("\t");
      const status = normalizeCommitStatus(parts[0]);
      if ((status === "R" || status === "C") && parts.length >= 3) {
        const oldPath = unquoteGitPath(parts[1]);
        const newPath = unquoteGitPath(parts[2]);
        if (newPath) entries.push({ status, oldPath: oldPath || null, path: newPath });
      } else if ((status === "R" || status === "C") && parts.length === 2) {
        const pair = parseRenameArrowPair(parts[1]);
        if (pair && pair.path) {
          entries.push({ status, oldPath: pair.oldPath || null, path: pair.path });
        } else if (parts[1]) {
          entries.push({ status, oldPath: null, path: unquoteGitPath(parts[1]) });
        }
      } else if (parts[1]) {
        entries.push({ status, oldPath: null, path: unquoteGitPath(parts[1]) });
      }
      continue;
    }

    const m = /^([ACDMRTUXB]\d*)\s+(.+)$/.exec(line);
    if (!m) continue;
    const status = normalizeCommitStatus(m[1]);
    const rest = m[2].trim();
    if (status === "R" || status === "C") {
      const pair = parseRenameArrowPair(rest);
      if (pair && pair.path) {
        entries.push({ status, oldPath: pair.oldPath || null, path: pair.path });
        continue;
      }
    }
    entries.push({ status, oldPath: null, path: unquoteGitPath(rest) });
  }
  return entries;
}

export function parseCommitFiles(numstatOut, nameStatusOut) {
  const numstatList = parseNumstatEntries(numstatOut);
  const nameStatusList = parseNameStatusEntries(nameStatusOut);

  const statByPair = new Map();
  const statByPath = new Map();
  const usedStats = new Set();

  for (let i = 0; i < numstatList.length; i++) {
    const st = numstatList[i];
    if (st.oldPath) {
      statByPair.set(`${st.oldPath}\0${st.path}`, i);
    }
    if (!statByPath.has(st.path)) {
      statByPath.set(st.path, i);
    }
  }

  const out = [];
  if (nameStatusList.length > 0) {
    for (const ns of nameStatusList) {
      let stIdx = ns.oldPath ? statByPair.get(`${ns.oldPath}\0${ns.path}`) : undefined;
      if (stIdx === undefined) stIdx = statByPath.get(ns.path);
      const st = stIdx !== undefined && !usedStats.has(stIdx) ? numstatList[stIdx] : null;
      if (stIdx !== undefined) usedStats.add(stIdx);

      const isRenameOrCopy = ns.status === "R" || ns.status === "C";
      const oldPath = isRenameOrCopy ? (ns.oldPath || st?.oldPath || null) : null;
      const displayPath = oldPath && oldPath !== ns.path ? `${oldPath} -> ${ns.path}` : ns.path;
      out.push({
        path: ns.path,
        oldPath,
        status: ns.status,
        added: st ? st.added : 0,
        deleted: st ? st.deleted : 0,
        binary: st ? st.binary : false,
        displayPath,
      });
    }
    for (let i = 0; i < numstatList.length; i++) {
      if (usedStats.has(i)) continue;
      const st = numstatList[i];
      const status = st.oldPath ? "R" : "M";
      const oldPath = st.oldPath || null;
      const displayPath = oldPath && oldPath !== st.path ? `${oldPath} -> ${st.path}` : st.path;
      out.push({
        path: st.path,
        oldPath,
        status,
        added: st.added,
        deleted: st.deleted,
        binary: st.binary,
        displayPath,
      });
    }
    return out;
  }

  for (const st of numstatList) {
    const status = st.oldPath ? "R" : "M";
    const oldPath = st.oldPath || null;
    const displayPath = oldPath && oldPath !== st.path ? `${oldPath} -> ${st.path}` : st.path;
    out.push({
      path: st.path,
      oldPath,
      status,
      added: st.added,
      deleted: st.deleted,
      binary: st.binary,
      displayPath,
    });
  }
  return out;
}

const BINARY_PATCH_MARKER_RE = /^(?:GIT binary patch|Binary files .* differ)$/m;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function resolveMaxDiffLines(options) {
  const rawMax = options?.maxLines;
  if (typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0) {
    return Math.floor(rawMax);
  }
  return options?.expanded ? MAX_EXPANDED_VIEWER_DIFF_LINES : MAX_VIEWER_DIFF_LINES;
}

export function tokenizeDeferredRow(row, ext) {
  if (!row || typeof row !== "object") return row;
  if (row.kind === "pair") {
    const left = row.left;
    const right = row.right;
    if (left && right && left.kind === "ctx" && right.kind === "ctx") {
      if (left._tokPending || right._tokPending) {
        const toks = tokenizeDiffLine(left.text, ext);
        left.tokens = toks;
        right.tokens = toks;
        left._tokPending = false;
        right._tokPending = false;
      }
      return row;
    }
    if (left && left._tokPending) {
      left.tokens = tokenizeDiffLine(left.text, ext);
      left._tokPending = false;
    }
    if (right && right._tokPending) {
      right.tokens = tokenizeDiffLine(right.text, ext);
      right._tokPending = false;
    }
    return row;
  }
  if (row._tokPending) {
    row.tokens = tokenizeDiffLine(row.text, ext);
    row._tokPending = false;
  }
  return row;
}

export function tokenizeSideBySidePage(rows, ext) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  for (let i = 0; i < rows.length; i++) {
    tokenizeDeferredRow(rows[i], ext);
  }
  return rows;
}

export function buildSideBySideRows(patchText, filePath = "", options = {}) {
  if (typeof patchText !== "string" || !patchText) {
    return { rows: [], isBinary: false, truncated: false, totalLines: 0, leftMaxChars: 0, rightMaxChars: 0 };
  }
  if (options?.isBinary || BINARY_PATCH_MARKER_RE.test(patchText)) {
    return { rows: [], isBinary: true, truncated: false, totalLines: 0, leftMaxChars: 0, rightMaxChars: 0 };
  }

  const ext = getFileExt(filePath);
  const deferTokens = Boolean(options?.deferTokens);
  const allRows = [];
  const rawLines = patchText.split("\n");

  let inHunk = false;
  let hunkIndex = 0;
  let oldLine = 0;
  let newLine = 0;
  let dels = [];
  let adds = [];

  const flushChangeBlock = () => {
    const pairCount = Math.max(dels.length, adds.length);
    for (let k = 0; k < pairCount; k++) {
      let left;
      if (k < dels.length) {
        const text = expandCodeTabs(dels[k]);
        left = deferTokens
          ? { lineNo: oldLine++, text, kind: "del", tokens: null, _tokPending: true }
          : { lineNo: oldLine++, text, kind: "del", tokens: tokenizeDiffLine(text, ext) };
      } else {
        left = { lineNo: null, text: "", kind: "empty", tokens: null };
      }
      let right;
      if (k < adds.length) {
        const text = expandCodeTabs(adds[k]);
        right = deferTokens
          ? { lineNo: newLine++, text, kind: "add", tokens: null, _tokPending: true }
          : { lineNo: newLine++, text, kind: "add", tokens: tokenizeDiffLine(text, ext) };
      } else {
        right = { lineNo: null, text: "", kind: "empty", tokens: null };
      }
      allRows.push({ kind: "pair", left, right });
    }
    dels = [];
    adds = [];
  };

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      flushChangeBlock();
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
      allRows.push({
        kind: "hunk",
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        hunkIndex: hunkIndex++,
      });
      oldLine = oldStart;
      newLine = newStart;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;

    const prefix = line[0];
    if (prefix === "-") {
      if (adds.length > 0) flushChangeBlock();
      dels.push(line.slice(1));
    } else if (prefix === "+") {
      adds.push(line.slice(1));
    } else if (prefix === " " || line === "") {
      if (line === "" && i === rawLines.length - 1) continue;
      flushChangeBlock();
      const text = expandCodeTabs(line === "" ? "" : line.slice(1));
      if (deferTokens) {
        allRows.push({
          kind: "pair",
          left: { lineNo: oldLine++, text, kind: "ctx", tokens: null, _tokPending: true },
          right: { lineNo: newLine++, text, kind: "ctx", tokens: null, _tokPending: true },
        });
      } else {
        const tokens = tokenizeDiffLine(text, ext);
        allRows.push({
          kind: "pair",
          left: { lineNo: oldLine++, text, kind: "ctx", tokens },
          right: { lineNo: newLine++, text, kind: "ctx", tokens },
        });
      }
    }
  }
  flushChangeBlock();

  const maxLines = resolveMaxDiffLines(options);
  const totalLines = allRows.length;
  const truncated = totalLines > maxLines;
  const rows = truncated ? allRows.slice(0, maxLines) : allRows;

  let leftMaxChars = 0;
  let rightMaxChars = 0;
  for (const row of rows) {
    if (row.kind !== "pair") continue;
    if (row.left.text.length > leftMaxChars) leftMaxChars = row.left.text.length;
    if (row.right.text.length > rightMaxChars) rightMaxChars = row.right.text.length;
  }

  return { rows, isBinary: false, truncated, totalLines, leftMaxChars, rightMaxChars };
}

export function buildUnifiedRows(patchText, filePath = "", options = {}) {
  if (typeof patchText !== "string" || !patchText) {
    return { rows: [], isBinary: false, truncated: false, totalLines: 0, maxChars: 0 };
  }
  if (options?.isBinary || BINARY_PATCH_MARKER_RE.test(patchText)) {
    return { rows: [], isBinary: true, truncated: false, totalLines: 0, maxChars: 0 };
  }

  const ext = getFileExt(filePath);
  const deferTokens = Boolean(options?.deferTokens);
  const allRows = [];
  const rawLines = patchText.split("\n");

  let inHunk = false;
  let hunkIndex = 0;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
      allRows.push({
        kind: "hunk",
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        hunkIndex: hunkIndex++,
      });
      oldLine = oldStart;
      newLine = newStart;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("\\")) continue;

    const prefix = line[0];
    if (prefix === "-") {
      const text = expandCodeTabs(line.slice(1));
      allRows.push({
        kind: "del",
        oldLineNo: oldLine++,
        newLineNo: null,
        text,
        tokens: deferTokens ? null : tokenizeDiffLine(text, ext),
        ...(deferTokens ? { _tokPending: true } : {}),
      });
    } else if (prefix === "+") {
      const text = expandCodeTabs(line.slice(1));
      allRows.push({
        kind: "add",
        oldLineNo: null,
        newLineNo: newLine++,
        text,
        tokens: deferTokens ? null : tokenizeDiffLine(text, ext),
        ...(deferTokens ? { _tokPending: true } : {}),
      });
    } else if (prefix === " " || line === "") {
      if (line === "" && i === rawLines.length - 1) continue;
      const text = expandCodeTabs(line === "" ? "" : line.slice(1));
      allRows.push({
        kind: "ctx",
        oldLineNo: oldLine++,
        newLineNo: newLine++,
        text,
        tokens: deferTokens ? null : tokenizeDiffLine(text, ext),
        ...(deferTokens ? { _tokPending: true } : {}),
      });
    }
  }

  const maxLines = resolveMaxDiffLines(options);
  const totalLines = allRows.length;
  const truncated = totalLines > maxLines;
  const rows = truncated ? allRows.slice(0, maxLines) : allRows;

  let maxChars = 0;
  for (const row of rows) {
    const len = row.kind === "hunk" ? row.header.length : (row.text?.length || 0);
    if (len > maxChars) maxChars = len;
  }

  return { rows, isBinary: false, truncated, totalLines, maxChars };
}

function expandedLineCols(text) {
  if (!text) return 0;
  if (typeof text === "string" && text.indexOf("\t") === -1) {
    return text.length > MAX_WIDTH_ESTIMATE_COLS ? MAX_WIDTH_ESTIMATE_COLS : text.length;
  }
  return Math.min(expandCodeTabs(text).length, MAX_WIDTH_ESTIMATE_COLS);
}

export function computeDiffColumnWidths(rows, charPx = 7.2) {
  const pxPerChar = Number.isFinite(Number(charPx)) && Number(charPx) > 0 ? Number(charPx) : 7.2;
  let leftCols = 0;
  let rightCols = 0;
  let unifiedCols = 0;

  for (const row of rows || []) {
    if (!row) continue;
    if (row.kind === "pair") {
      const lLen = expandedLineCols(row.left?.text);
      const rLen = expandedLineCols(row.right?.text);
      if (lLen > leftCols) leftCols = lLen;
      if (rLen > rightCols) rightCols = rLen;
      if (lLen > unifiedCols) unifiedCols = lLen;
      if (rLen > unifiedCols) unifiedCols = rLen;
    } else if (row.kind === "hunk") {
      const hLen = expandedLineCols(row.header);
      if (hLen > leftCols) leftCols = hLen;
      if (hLen > unifiedCols) unifiedCols = hLen;
    } else if (typeof row.text === "string") {
      const tLen = expandedLineCols(row.text);
      if (tLen > unifiedCols) unifiedCols = tLen;
      if (row.kind === "del" || row.kind === "ctx") {
        if (tLen > leftCols) leftCols = tLen;
      }
      if (row.kind === "add" || row.kind === "ctx") {
        if (tLen > rightCols) rightCols = tLen;
      }
    }
  }

  return {
    leftWidth: leftCols > 0 ? Math.max(260, Math.ceil(leftCols * pxPerChar) + 92) : 260,
    rightWidth: rightCols > 0 ? Math.max(260, Math.ceil(rightCols * pxPerChar) + 92) : 260,
    unifiedWidth: unifiedCols > 0 ? Math.max(300, Math.ceil(unifiedCols * pxPerChar) + 120) : 300,
  };
}

/**
 * Resolves whether a wheel event should horizontally scroll a diff column.
 * Plain vertical wheel is never hijacked so vertical sync remains undisturbed;
 * Shift+Wheel (on either delta.y or delta.x depending on OS) or explicit horizontal
 * trackpad swipes scroll only the hovered column horizontally.
 */
export function computeHorizontalWheelDelta(event) {
  const dx = Number(event?.delta?.x) || 0;
  const dy = Number(event?.delta?.y) || 0;
  if (event?.modifiers?.shift) {
    const raw = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    return {
      handled: true,
      deltaX: raw === 0 ? 0 : -raw,
    };
  }
  if (dx !== 0 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    return {
      handled: true,
      deltaX: -dx,
    };
  }
  return { handled: false, deltaX: 0 };
}

/**
 * Computes clamped horizontal scroll position and thumb geometry for a column.
 */
export function computeHorizontalScrollbarMetrics(contentWidth, viewportWidth, scrollX = 0, trackWidth = null) {
  const cW = Number.isFinite(Number(contentWidth)) ? Math.max(0, Number(contentWidth)) : 0;
  const vW = Number.isFinite(Number(viewportWidth)) ? Math.max(0, Number(viewportWidth)) : 0;
  const maxScroll = vW > 0 ? Math.max(0, Math.ceil(cW - vW)) : 0;
  const rawScroll = Number.isFinite(Number(scrollX)) ? Number(scrollX) : 0;
  const clampedScroll = Math.max(0, Math.min(Math.round(rawScroll), maxScroll));
  const usableTrackW = Math.max(
    0,
    Math.floor(Number.isFinite(Number(trackWidth)) && Number(trackWidth) > 0 ? Number(trackWidth) : vW)
  );
  if (vW <= 0 || maxScroll <= 1 || usableTrackW <= 0) {
    return {
      visible: false,
      maxScroll: 0,
      scrollX: 0,
      trackW: usableTrackW,
      thumbX: 0,
      thumbW: 0,
      travelW: 0,
    };
  }
  const thumbW = Math.max(24, Math.min(usableTrackW, Math.round((vW / Math.max(1, cW)) * usableTrackW)));
  const travelW = Math.max(0, usableTrackW - thumbW);
  const thumbX = travelW > 0 ? Math.round((clampedScroll / maxScroll) * travelW) : 0;
  return {
    visible: true,
    maxScroll,
    scrollX: clampedScroll,
    trackW: usableTrackW,
    thumbX,
    thumbW,
    travelW,
  };
}

/**
 * Maps a click position inside a horizontal scrollbar track to a centered scroll offset.
 */
export function computeScrollXFromTrackClick(localX, contentWidth, viewportWidth, trackWidth = null) {
  const metrics = computeHorizontalScrollbarMetrics(contentWidth, viewportWidth, 0, trackWidth);
  if (!metrics.visible || metrics.travelW <= 0 || metrics.maxScroll <= 0) return 0;
  const x = Number.isFinite(Number(localX)) ? Number(localX) : 0;
  const targetThumbLeft = Math.max(0, Math.min(metrics.travelW, x - metrics.thumbW / 2));
  return Math.max(0, Math.min(metrics.maxScroll, Math.round((targetThumbLeft / metrics.travelW) * metrics.maxScroll)));
}

const EXACT_GIT_FILE_ICONS = {
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

const EXT_GIT_FILE_ICONS = {
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

function resolveGitFileIconSpec(filePath) {
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
  if (EXACT_GIT_FILE_ICONS[base]) return EXACT_GIT_FILE_ICONS[base];
  if (base.startsWith(".env")) return { kind: "settings", tone: "number" };
  const ext = getFileExt(base);
  if (ext && EXT_GIT_FILE_ICONS[ext]) return EXT_GIT_FILE_ICONS[ext];
  return { kind: "file", tone: "muted" };
}

export function resolveGitFileIcon(filePath, themeObj) {
  const spec = resolveGitFileIconSpec(filePath);
  const palette = getDiffSyntaxPalette(themeObj);
  return {
    kind: spec.kind,
    path: `mods/git-history/icons/file-types/${spec.kind}.svg`,
    color: palette[spec.tone] || palette.muted,
  };
}

export function computeViewerLoadedKey(diff) {
  if (!diff || typeof diff !== "object") return "empty";
  const fileKey = diff.openFileKey || diff.openFile?.path || "";
  if (!diff.commitHash || !fileKey) return "empty";
  return `${diff.requestSeq || 0}::${diff.repoRoot || ""}::${diff.commitHash}::${fileKey}::${diff.expanded ? 1 : 0}`;
}

export function formatGitTabTitle(commit, file) {
  const shortHash = typeof commit === "string"
    ? commit.trim().slice(0, 7)
    : String(commit?.shortHash || (commit?.hash ? String(commit.hash).slice(0, 7) : "")).trim();
  const rawFile = typeof file === "string"
    ? file
    : (file?.path || file?.displayPath || file?.name || "");
  const cleanFile = String(rawFile || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = cleanFile.lastIndexOf("/");
  const baseName = slash >= 0 ? cleanFile.slice(slash + 1) : cleanFile;
  if (shortHash && baseName) return `${shortHash} · ${baseName}`;
  if (baseName) return `Git · ${baseName}`;
  if (shortHash) return `Git · ${shortHash}`;
  return "Git History";
}

export function paginateDiffRows(rows, pageIndex = 0, pageSize = DEFAULT_SBS_PAGE_ROWS) {
  const list = Array.isArray(rows) ? rows : [];
  const totalRows = list.length;
  const size = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.floor(Number(pageSize))
    : DEFAULT_SBS_PAGE_ROWS;
  if (totalRows === 0) {
    return {
      rows: [],
      pageIndex: 0,
      totalPages: 1,
      totalRows: 0,
      startRow: 0,
      endRow: 0,
      hasPrev: false,
      hasNext: false,
    };
  }
  const totalPages = Math.max(1, Math.ceil(totalRows / size));
  const rawIdx = Number.isFinite(Number(pageIndex)) ? Math.floor(Number(pageIndex)) : 0;
  const clampedIdx = Math.max(0, Math.min(totalPages - 1, rawIdx));
  const start = clampedIdx * size;
  const end = Math.min(totalRows, start + size);
  return {
    rows: list.slice(start, end),
    pageIndex: clampedIdx,
    totalPages,
    totalRows,
    startRow: start + 1,
    endRow: end,
    hasPrev: clampedIdx > 0,
    hasNext: clampedIdx + 1 < totalPages,
  };
}

export function capRenderTokens(tokens, maxTokens = MAX_RENDER_TOKENS_PER_LINE) {
  if (!Array.isArray(tokens)) return tokens;
  const limit = Number.isFinite(Number(maxTokens)) && Number(maxTokens) >= 2
    ? Math.floor(Number(maxTokens))
    : MAX_RENDER_TOKENS_PER_LINE;
  if (tokens.length <= limit) return tokens;
  const head = tokens.slice(0, limit - 1);
  let tailText = "";
  for (let i = limit - 1; i < tokens.length; i++) {
    tailText += String(tokens[i]?.[1] || "");
  }
  if (tailText) {
    head.push(["plain", tailText]);
  }
  return head;
}

function layoutWaveSide(items, entries, blockH, cursorY, maxOffsetPx, markerKindOnZero) {
  if (entries.length === 0) {
    const markerY = Math.min(Math.floor(blockH / 2), maxOffsetPx);
    items.push({ type: "spacer", height: blockH, markerOffsetY: markerY, markerKind: markerKindOnZero });
    return {
      top: cursorY + markerY,
      bot: cursorY + markerY,
      localTop: markerY,
      localBot: markerY,
    };
  }
  let sideH = 0;
  for (let i = 0; i < entries.length; i++) {
    sideH += entries[i].height;
  }
  const topPad = sideH < blockH ? Math.min(Math.floor((blockH - sideH) / 2), maxOffsetPx) : 0;
  const botPad = blockH - sideH - topPad;
  if (topPad > 0) {
    items.push({ type: "spacer", height: topPad, markerOffsetY: null, markerKind: null });
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    items.push({ type: "line", height: entry.height, rowCount: entry.rowCount, cell: entry.cell });
  }
  if (botPad > 0) {
    items.push({ type: "spacer", height: botPad, markerOffsetY: null, markerKind: null });
  }
  return {
    top: cursorY + topPad,
    bot: cursorY + topPad + sideH,
    localTop: topPad,
    localBot: topPad + sideH,
  };
}

/**
 * Computes compact, aligned Left/Right column items, per-block center gutter items,
 * and bezier wave ribbon geometry for a bounded page of side-by-side diff rows,
 * accounting for wrapped sub-row heights on both sides so wave bands stay height-synced.
 */
export function buildWaveDiffLayout(pageRows, options = {}) {
  const rows = Array.isArray(pageRows) ? pageRows : [];
  const rowHeight = Number.isFinite(Number(options?.rowHeight)) && Number(options.rowHeight) > 0
    ? Math.floor(Number(options.rowHeight))
    : DIFF_ROW_HEIGHT;
  const hunkHeight = Number.isFinite(Number(options?.hunkHeight)) && Number(options.hunkHeight) > 0
    ? Math.floor(Number(options.hunkHeight))
    : DIFF_HUNK_HEIGHT;
  const maxCenterOffsetRows =
    Number.isFinite(Number(options?.maxCenterOffsetRows)) && Number(options.maxCenterOffsetRows) >= 0
      ? Math.floor(Number(options.maxCenterOffsetRows))
      : DIFF_WAVE_MAX_CENTER_OFFSET_ROWS;
  const leftCols = Number.isFinite(Number(options?.leftCols)) && Number(options.leftCols) > 0
    ? Math.floor(Number(options.leftCols))
    : 0;
  const rightCols = Number.isFinite(Number(options?.rightCols)) && Number(options.rightCols) > 0
    ? Math.floor(Number(options.rightCols))
    : 0;
  const hunkCols = Number.isFinite(Number(options?.hunkCols)) && Number(options.hunkCols) > 0
    ? Math.floor(Number(options.hunkCols))
    : (leftCols > 0 ? Math.max(12, leftCols) : 0);
  const maxOffsetPx = maxCenterOffsetRows * rowHeight;

  const leftItems = [];
  const rightItems = [];
  const gutterItems = [];
  const hunkBands = [];
  const waves = [];
  let cursorY = 0;
  let pendingDels = [];
  let pendingAdds = [];

  const measureEntry = (cell, cols) => {
    const rowCount = cols > 0 ? countCellVisualRows(cell?.text || "", cols) : 1;
    return { cell, rowCount, height: rowCount * rowHeight };
  };

  const flushChange = () => {
    const dCount = pendingDels.length;
    const aCount = pendingAdds.length;
    if (dCount === 0 && aCount === 0) return;

    let leftSideH = 0;
    for (let i = 0; i < dCount; i++) leftSideH += pendingDels[i].height;
    let rightSideH = 0;
    for (let i = 0; i < aCount; i++) rightSideH += pendingAdds[i].height;
    const blockH = Math.max(leftSideH, rightSideH);

    const leftSpan = layoutWaveSide(leftItems, pendingDels, blockH, cursorY, maxOffsetPx, "add");
    const rightSpan = layoutWaveSide(rightItems, pendingAdds, blockH, cursorY, maxOffsetPx, "del");
    const kind = dCount > 0 && aCount > 0 ? "mod" : dCount === 0 ? "add" : "del";
    waves.push({
      kind,
      leftTop: leftSpan.top,
      leftBot: leftSpan.bot,
      rightTop: rightSpan.top,
      rightBot: rightSpan.bot,
    });
    gutterItems.push({
      type: "wave",
      height: blockH,
      kind,
      leftTop: leftSpan.localTop,
      leftBot: leftSpan.localBot,
      rightTop: rightSpan.localTop,
      rightBot: rightSpan.localBot,
    });
    cursorY += blockH;
    pendingDels = [];
    pendingAdds = [];
  };

  for (const row of rows) {
    if (!row) continue;
    if (row.kind === "hunk") {
      flushChange();
      const hSubRows = hunkCols > 0 ? countCellVisualRows(row.header || "", hunkCols) : 1;
      const bandH = Math.max(hunkHeight, hSubRows * rowHeight);
      leftItems.push({
        type: "hunk",
        height: bandH,
        header: row.header || "",
        hunkIndex: row.hunkIndex,
        wrapCols: hunkCols,
      });
      rightItems.push({
        type: "hunk",
        height: bandH,
      });
      gutterItems.push({
        type: "hunk",
        height: bandH,
      });
      hunkBands.push({ y: cursorY, height: bandH });
      cursorY += bandH;
      continue;
    }

    if (row.kind !== "pair") continue;
    const left = row.left || { kind: "empty", lineNo: null, text: "", tokens: null };
    const right = row.right || { kind: "empty", lineNo: null, text: "", tokens: null };

    if (left.kind === "ctx" && right.kind === "ctx") {
      flushChange();
      const leftRows = leftCols > 0 ? countCellVisualRows(left.text || "", leftCols) : 1;
      const rightRows = rightCols > 0 ? countCellVisualRows(right.text || "", rightCols) : 1;
      const pairRows = Math.max(1, leftRows, rightRows);
      const pairH = pairRows * rowHeight;
      leftItems.push({ type: "line", height: pairH, rowCount: leftRows, cell: left });
      rightItems.push({ type: "line", height: pairH, rowCount: rightRows, cell: right });
      gutterItems.push({ type: "ctx", height: pairH });
      cursorY += pairH;
      continue;
    }

    if (left.kind !== "empty") pendingDels.push(measureEntry(left, leftCols));
    if (right.kind !== "empty") pendingAdds.push(measureEntry(right, rightCols));
  }
  flushChange();

  return {
    leftItems,
    rightItems,
    gutterItems,
    hunkBands,
    waves,
    totalHeight: cursorY,
  };
}

export function computeUnifiedRowHeights(rows, wrapCols, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const rowHeight = Number.isFinite(Number(options?.rowHeight)) && Number(options.rowHeight) > 0
    ? Math.floor(Number(options.rowHeight))
    : DIFF_ROW_HEIGHT;
  const hunkHeight = Number.isFinite(Number(options?.hunkHeight)) && Number(options.hunkHeight) > 0
    ? Math.floor(Number(options.hunkHeight))
    : DIFF_HUNK_HEIGHT;
  const cols = Number.isFinite(Number(wrapCols)) && Number(wrapCols) > 0
    ? Math.floor(Number(wrapCols))
    : 0;
  const hunkCols = Number.isFinite(Number(options?.hunkWrapCols)) && Number(options.hunkWrapCols) > 0
    ? Math.floor(Number(options.hunkWrapCols))
    : (cols > 0 ? Math.max(12, cols - 2) : 0);

  return list.map((row) => {
    if (!row) return rowHeight;
    if (row.kind === "hunk") {
      const subRows = hunkCols > 0 ? countCellVisualRows(row.header || "", hunkCols) : 1;
      return Math.max(hunkHeight, subRows * rowHeight);
    }
    const subRows = cols > 0 ? countCellVisualRows(row.text || "", cols) : 1;
    return Math.max(1, subRows) * rowHeight;
  });
}

/**
 * Groups an aligned `buildWaveDiffLayout` output into vertically disjoint aligned blocks
 * (one per `gutterItems` entry) so Side-by-Side panes and the center wave gutter can be
 * virtually scrolled in lockstep via `v_virtual_list`.
 */
export function buildWaveDiffBlocks(waveLayout) {
  const leftItems = Array.isArray(waveLayout?.leftItems) ? waveLayout.leftItems : [];
  const rightItems = Array.isArray(waveLayout?.rightItems) ? waveLayout.rightItems : [];
  const gutterItems = Array.isArray(waveLayout?.gutterItems) ? waveLayout.gutterItems : [];

  const blocks = [];
  const blockHeights = [];
  let lIdx = 0;
  let rIdx = 0;

  for (let g = 0; g < gutterItems.length; g += 1) {
    const gutter = gutterItems[g];
    if (!gutter) continue;
    const targetH = Math.max(0, Number(gutter.height) || 0);

    const lStart = lIdx;
    let lSum = 0;
    while (lIdx < leftItems.length) {
      lSum += Number(leftItems[lIdx]?.height) || 0;
      lIdx += 1;
      if (lSum >= targetH) break;
    }

    const rStart = rIdx;
    let rSum = 0;
    while (rIdx < rightItems.length) {
      rSum += Number(rightItems[rIdx]?.height) || 0;
      rIdx += 1;
      if (rSum >= targetH) break;
    }

    blocks.push({
      type: gutter.type,
      height: targetH,
      gutter,
      leftItems: leftItems.slice(lStart, lIdx),
      rightItems: rightItems.slice(rStart, rIdx),
    });
    blockHeights.push(targetH);
  }

  let totalHeight = Number(waveLayout?.totalHeight);
  if (!Number.isFinite(totalHeight)) {
    totalHeight = 0;
    for (let i = 0; i < blockHeights.length; i += 1) totalHeight += blockHeights[i];
  }

  return {
    blocks,
    blockHeights,
    totalHeight,
  };
}
