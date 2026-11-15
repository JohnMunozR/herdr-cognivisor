// Shared single-pass O(n) syntax lexer, interactive token splitter, and theme-adaptive palettes (Node + QuickJS).
// Canonical source: shared/code-syntax.js -> synced to mods/{files-search,changes-review,git-history}/code-syntax.js.
import {
  isMarkdownExt,
  createMarkdownState,
  advanceMarkdownState,
  getMarkdownStateTag,
  tokenizeMarkdownLine,
} from "./markdown-syntax.js";

/**
 * Create a per-line stateful scanner state when rendering Markdown or multi-line code comments/text blocks.
 */
export function createCodeSyntaxState(ext = "") {
  const normExt = String(ext || "").toLowerCase();
  if (isMarkdownExt(normExt)) {
    return createMarkdownState();
  }
  const slashComments = !normExt || SLASH_COMMENT_EXTS.has(normExt);
  const isPython = normExt === "py" || normExt === "pyw" || normExt === "pyi";
  if (slashComments || isPython) {
    return { kind: "code", inBlockComment: false, tripleQuote: null };
  }
  return null;
}

/**
 * Serialize line syntax state into a compact cache key tag.
 */
export function getSyntaxStateTag(state) {
  if (!state || typeof state !== "object") return "";
  if (state.kind === "code") {
    const b = state.inBlockComment ? "b" : "";
    const t = state.tripleQuote === '"""' ? "D" : state.tripleQuote === "'''" ? "S" : "";
    const r = state.tripleQuoteRaw ? "R" : "";
    const f = state.tripleQuoteF ? "F" : "";
    return `${b}${t}${r}${f}`;
  }
  return getMarkdownStateTag(state);
}

/**
 * Clone a syntax state snapshot cleanly without aliasing nested fields.
 */
export function cloneSyntaxState(state) {
  if (!state || typeof state !== "object") return null;
  if (state.kind === "code") {
    return {
      kind: "code",
      inBlockComment: Boolean(state.inBlockComment),
      tripleQuote: state.tripleQuote || null,
      tripleQuoteRaw: Boolean(state.tripleQuoteRaw),
      tripleQuoteF: Boolean(state.tripleQuoteF),
    };
  }
  return { ...state };
}

/**
 * Advance a syntax state object across one raw/expanded source line without allocating tokens.
 */
export function advanceSyntaxState(rawText, state, ext = "") {
  if (!state || typeof state !== "object") return state;
  const normExt = String(ext || "").toLowerCase();
  const expanded = expandCodeTabs(rawText || "");
  if (state.kind === "code") {
    if (!expanded) return state;
    advanceCodeBlockState(expanded, state, normExt);
    return state;
  }
  if (isMarkdownExt(normExt)) {
    advanceMarkdownState(expanded, state);
  }
  return state;
}

function advanceCodeBlockState(text, state, normExt) {
  if (!state || state.kind !== "code") return;
  const isJava = normExt === "java";
  const isPython = normExt === "py" || normExt === "pyw" || normExt === "pyi";
  const isRust = normExt === "rs";
  const slashComments = !normExt || SLASH_COMMENT_EXTS.has(normExt);
  let i = 0;
  const len = text.length;
  if (state.inBlockComment && slashComments) {
    const close = text.indexOf("*/");
    if (close < 0) return;
    state.inBlockComment = false;
    i = close + 2;
  } else if (state.tripleQuote) {
    const delim = state.tripleQuote;
    let end = 0;
    let closed = false;
    while (end < len) {
      if (text[end] === "\\" && state.tripleQuoteRaw !== true) {
        end = end + 1 < len ? end + 2 : len;
        continue;
      }
      if (text.startsWith(delim, end)) {
        end += 3;
        closed = true;
        break;
      }
      end += 1;
    }
    if (!closed) return;
    state.tripleQuote = null;
    state.tripleQuoteRaw = false;
    state.tripleQuoteF = false;
    i = end;
  }
  while (i < len) {
    if (slashComments && text[i] === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) { state.inBlockComment = true; return; }
      i = close + 2;
      continue;
    }
    if (slashComments && text[i] === "/" && text[i + 1] === "/") return;
    if (isPython && text[i] === "#") return;
    if (isPython && (text[i] === "f" || text[i] === "F" || text[i] === "r" || text[i] === "R" || text[i] === "b" || text[i] === "B" || text[i] === "u" || text[i] === "U") && (i === 0 || !isIdentPartCh(text[i - 1]))) {
      let qOff = i + 1;
      if (qOff < len && (text[qOff] === "f" || text[qOff] === "F" || text[qOff] === "r" || text[qOff] === "R" || text[qOff] === "b" || text[qOff] === "B")) qOff += 1;
      const lowerPrefix = text.slice(i, qOff).toLowerCase();
      const q = text[qOff];
      if ((q === '"' || q === "'") && isPyStringPrefix(lowerPrefix) && text[qOff + 1] === q && text[qOff + 2] === q) {
        const delim = q + q + q;
        const isRaw = lowerPrefix.includes("r");
        let end = qOff + 3;
        let closed = false;
        while (end < len) {
          if (!isRaw && text[end] === "\\") { end = end + 1 < len ? end + 2 : len; continue; }
          if (text.startsWith(delim, end)) { end += 3; closed = true; break; }
          end += 1;
        }
        if (!closed) {
          state.tripleQuote = delim;
          state.tripleQuoteRaw = isRaw;
          state.tripleQuoteF = lowerPrefix.includes("f");
          return;
        }
        i = end;
        continue;
      }
    }
    if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const ch = text[i];
      if (isRust && ch === "'" && i + 1 < len && text[i + 1] !== "\\" && (i + 2 >= len || text[i + 2] !== "'")) {
        i += 1;
        continue;
      }
      if (ch === "'" && i > 0 && isIdentPartCh(text[i - 1])) {
        i += 1;
        continue;
      }
      const isTriple = (ch === '"' || ch === "'") && text[i + 1] === ch && text[i + 2] === ch;
      const step = isTriple ? 3 : 1;
      const delim = isTriple ? ch + ch + ch : ch;
      let end = i + step;
      let closed = false;
      while (end < len) {
        if (text[end] === "\\") { end = end + 1 < len ? end + 2 : len; continue; }
        if (isTriple ? text.startsWith(delim, end) : text[end] === ch) { end += step; closed = true; break; }
        end += 1;
      }
      if (isTriple && !closed && ((isJava && ch === '"') || isPython)) {
        state.tripleQuote = delim;
        state.tripleQuoteRaw = false;
        state.tripleQuoteF = false;
        return;
      }
      i = end;
      continue;
    }
    i += 1;
  }
}

export const MAX_PREVIEW_SYNTAX_LINE_CHARS = 1600;
export const MAX_PREVIEW_RENDER_LINE_CHARS = 4000;

export const EDITOR_LANG_ALIASES = {
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

export const CODE_KEYWORDS = new Set([
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

export const EXTRA_DIFF_KEYWORDS = new Set([
  "done", "dyn", "esac", "fallthrough", "fi", "func", "local", "loop", "move",
  "range", "ref", "then", "unsafe", "unset",
]);

export const SQL_LOWER_KEYWORDS = new Set([
  "select", "from", "where", "join", "left", "right", "inner", "outer", "on", "group", "by",
  "order", "having", "insert", "into", "values", "update", "set", "delete", "create", "alter",
  "drop", "table", "index", "as", "and", "or", "not", "in", "is", "null", "case", "when",
  "then", "else", "end", "distinct", "limit", "offset", "union", "exists", "returning",
  "primary", "key", "foreign", "references", "default", "unique", "begin", "commit", "rollback",
]);

export const CODE_BOOLEANS = new Set(["true", "false", "True", "False"]);
export const CODE_CONSTANTS = new Set(["null", "nil", "None", "undefined", "NaN", "Infinity"]);
export const CODE_SPECIAL_VARS = new Set(["this", "super", "self", "cls"]);
export const CODE_BUILTIN_VARS = new Set([
  "console", "process", "window", "document", "globalThis", "module", "exports",
]);

export const CODE_TYPES = new Set([
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

export const EXTRA_DIFF_TYPES = new Set([
  "rune", "error", "uintptr", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64", "complex64", "complex128",
]);

export const PRIMITIVE_TYPES = new Set([
  "void", "int", "long", "short", "byte", "float", "double", "boolean", "bool", "char",
  "string", "number", "any", "unknown", "never", "object", "symbol", "bigint", "str",
  "list", "dict", "set", "tuple", "frozenset", "bytes",
  "usize", "isize", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32", "f64",
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

function buildThemePaletteSig(t, includeMutedFallback) {
  if (!t || typeof t !== "object") return includeMutedFallback ? "diff:default" : "code:default";
  return `${includeMutedFallback ? "diff" : "code"}|${t.is_dark}|${t.appearance}|${t.background}|${t.foreground}|${t.dim}|${t.muted}|${t.ansi1}|${t.ansi2}|${t.ansi3}|${t.ansi4}|${t.ansi5}|${t.ansi6}`;
}

let cachedCodeThemeRef = null;
let cachedCodeThemeSig = "";
let cachedCodePalette = null;

let cachedDiffThemeRef = null;
let cachedDiffThemeSig = "";
let cachedDiffPalette = null;

export function getSyntaxPalette(t, opts = {}) {
  const includeMutedFallback = Boolean(opts?.diffMode);
  if (t && t._isSyntaxPalette) return t;
  const sig = buildThemePaletteSig(t, includeMutedFallback);
  if (includeMutedFallback) {
    if (t && t === cachedDiffThemeRef && cachedDiffPalette && cachedDiffPalette._sig === sig) return cachedDiffPalette;
    if (cachedDiffPalette && sig === cachedDiffThemeSig) {
      if (t) cachedDiffThemeRef = t;
      return cachedDiffPalette;
    }
  } else {
    if (t && t === cachedCodeThemeRef && cachedCodePalette && cachedCodePalette._sig === sig) return cachedCodePalette;
    if (cachedCodePalette && sig === cachedCodeThemeSig) {
      if (t) cachedCodeThemeRef = t;
      return cachedCodePalette;
    }
  }

  const isDark = detectDarkTheme(t);
  const warmAmber = isDark ? "#d19a66" : "#b35900";
  const cyan = pickSyntaxTone(t?.ansi6, isDark ? "#56b6c2" : "#0e7490", isDark);
  const coral = pickSyntaxTone(t?.ansi1, isDark ? "#e06c75" : "#cf222e", isDark);
  const commentSrc = includeMutedFallback ? (t?.dim || t?.muted) : t?.dim;

  const palette = {
    _isSyntaxPalette: true,
    _sig: sig,
    isDark,
    keyword: pickSyntaxTone(t?.ansi5, isDark ? "#c678dd" : "#8250df", isDark),
    string: pickSyntaxTone(t?.ansi2, isDark ? "#98c379" : "#116329", isDark),
    escape: cyan,
    comment: pickSyntaxTone(commentSrc, isDark ? "#7f848e" : "#6e7781", isDark, 0.34, 0.56),
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
  palette._styles = {
    keyword: { color: palette.keyword, bold: true },
    annotation: { color: palette.annotation, bold: true },
    string: { color: palette.string, bold: false },
    "string.escape": { color: palette.escape, bold: false },
    comment: { color: palette.comment, bold: false },
    function: { color: palette.function, bold: false },
    type: { color: palette.type, bold: false },
    number: { color: palette.number, bold: false },
    boolean: { color: palette.boolean, bold: false },
    constant: { color: palette.constant, bold: false },
    variable: { color: palette.variable, bold: false },
    operator: { color: palette.operator, bold: false },
    _plainTarget: { color: palette.plain, bold: false },
    _plainMuted: { color: palette.muted, bold: false },
  };

  if (includeMutedFallback) {
    cachedDiffThemeSig = sig;
    cachedDiffPalette = palette;
    if (t) cachedDiffThemeRef = t;
  } else {
    cachedCodeThemeSig = sig;
    cachedCodePalette = palette;
    if (t) cachedCodeThemeRef = t;
  }
  return palette;
}

export function getDiffSyntaxPalette(t) {
  return getSyntaxPalette(t, { diffMode: true });
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
  const styles = p._styles;
  if (styles) {
    if (Object.prototype.hasOwnProperty.call(styles, kind) && kind !== "_plainTarget" && kind !== "_plainMuted") {
      return styles[kind];
    }
    return isTarget ? styles._plainTarget : styles._plainMuted;
  }
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

export function diffSyntaxTokenColor(kind, t) {
  const p = getDiffSyntaxPalette(t);
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

export function expandCodeTabs(rawText, tabSize = 4) {
  if (!rawText) return "";
  const s = String(rawText);
  if (s.indexOf("\t") === -1) return s;
  const size = Number.isFinite(Number(tabSize)) && Number(tabSize) > 0 ? Math.floor(Number(tabSize)) : 4;
  return s.replace(/\t/g, size === 4 ? "    " : " ".repeat(size));
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

function isHexDigitChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function isAsciiAlphaChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isPyStringPrefix(str) {
  const s = str.toLowerCase();
  return s === "f" || s === "r" || s === "b" || s === "u" || s === "fr" || s === "rf" || s === "br" || s === "rb";
}

function isUpperConstIdent(word) {
  if (word.length <= 1) return false;
  const first = word.charCodeAt(0);
  if (first < 65 || first > 90) return false;
  for (let i = 1; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
}

function isPascalTypeIdent(word) {
  if (!word) return false;
  const first = word.charCodeAt(0);
  if (first < 65 || first > 90) return false;
  for (let i = 1; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return false;
  }
  return true;
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
  if (!inner) return false;
  if (!isAsciiAlphaChar(inner[0]) && inner[0] !== "_") return false;
  for (let i = 1; i < inner.length; i++) {
    const ch = inner[i];
    if (!isIdentPartCh(ch) && ch !== "." && ch !== "-") return false;
  }
  return true;
}

const DOLLAR_PLACEHOLDER_RE = /^[a-zA-Z0-9_.:-]+$/;
const PROP_NUMBER_RE = /^-?(?:0x[0-9a-fA-F_]+|\d+(?:\.\d+)?)(?:ms|s|m|h|d|kb|mb|gb)?$/i;

function emitStringTokens(tokens, slice, baseKind, opts = {}) {
  if (baseKind !== "string") {
    pushCodeToken(tokens, baseKind, slice);
    return;
  }
  const { isTemplate = false, isFString = false, allowPathVars = false } = opts;
  const checkCurly = isFString || allowPathVars;
  const len = slice.length;
  let i = 0;
  let segStart = 0;
  let noDollarBrace = false;
  let noCurlyBrace = !checkCurly;
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
    if (!noDollarBrace && ch === "$" && i + 1 < len && slice[i + 1] === "{") {
      const close = slice.indexOf("}", i + 2);
      if (close < 0) {
        noDollarBrace = true;
      } else if (close > i + 2) {
        const inner = slice.slice(i + 2, close);
        if (isTemplate || DOLLAR_PLACEHOLDER_RE.test(inner)) {
          flushSeg(i);
          pushCodeToken(tokens, "string.escape", slice.slice(i, close + 1));
          i = segStart = close + 1;
          continue;
        }
      }
    }
    if (ch === "{") {
      if (isFString && slice[i + 1] === "{") {
        flushSeg(i);
        pushCodeToken(tokens, "string.escape", "{{");
        i = segStart = i + 2;
        continue;
      }
      if (!noCurlyBrace) {
        const close = slice.indexOf("}", i + 1);
        if (close < 0) {
          noCurlyBrace = true;
        } else if (close > i) {
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
    } else if (PROP_NUMBER_RE.test(valTrim)) {
      pushCodeToken(tokens, "number", valTrim);
    } else {
      emitStringTokens(tokens, valTrim, "string", { allowPathVars: false });
    }
  }
  if (tailWs) pushCodeToken(tokens, "plain", tailWs);
  return tokens;
}

const DOC_LINE_START_RE = /^\s*\*\s*(?:$|\*\/|@(?:param|returns?|throws|exception|see|since|deprecated|author|version|implSpec|implNote|apiNote|code|linkplain|link|value|inheritDoc)\b)/;

/**
 * Single-pass linear tokenizer shared across code and diff viewers (lossless on all chars).
 */
export function tokenizeCodeLine(rawText, ext = "", mdState = null, options = {}) {
  const normExt = String(ext || "").toLowerCase();
  const {
    maxLineChars = MAX_PREVIEW_SYNTAX_LINE_CHARS,
    allowShellVars = false,
    allowSqlLowerKeywords = false,
    extraKeywords = false,
    extraTypes = false,
    includeSelfUpper = false,
    includeIota = false,
    alreadyExpanded = false,
  } = options || {};

  const isMd = isMarkdownExt(normExt);
  if (!rawText) {
    if (mdState && isMd) {
      return tokenizeMarkdownLine("", mdState, (line, e, s) => tokenizeCodeLine(line, e, s, options));
    }
    return null;
  }

  const rawStr = typeof rawText === "string" ? rawText : String(rawText);
  if (!alreadyExpanded && (normExt === "txt" || normExt === "log" || (rawStr.length > maxLineChars && rawStr.indexOf("\t") === -1))) {
    if (mdState && isMd) advanceMarkdownState(expandCodeTabs(rawStr), mdState);
    else if (mdState?.kind === "code") advanceCodeBlockState(rawStr, mdState, normExt);
    return null;
  }
  const text = alreadyExpanded ? rawStr : expandCodeTabs(rawStr);
  if (text.length > maxLineChars || normExt === "txt" || normExt === "log") {
    if (mdState && isMd) advanceMarkdownState(text, mdState);
    else if (mdState?.kind === "code") advanceCodeBlockState(text, mdState, normExt);
    return null;
  }
  if (isMd) {
    return tokenizeMarkdownLine(text, mdState, (line, e, s) => tokenizeCodeLine(line, e, s, options));
  }
  if (PROP_EXTS.has(normExt)) {
    return tokenizePropertiesLine(text, []);
  }

  const tokens = [];
  const len = text.length;
  const hashComments = HASH_COMMENT_EXTS.has(normExt);
  const slashComments = !normExt || SLASH_COMMENT_EXTS.has(normExt);
  const markup = MARKUP_EXTS.has(normExt);
  const isJava = normExt === "java";
  const isPython = normExt === "py" || normExt === "pyw" || normExt === "pyi";
  const isJson = normExt === "json" || normExt === "jsonc" || normExt === "json5";
  const isYaml = normExt === "yml" || normExt === "yaml";
  const isCss = normExt === "css" || normExt === "scss" || normExt === "less";
  const isSql = normExt === "sql";
  const isRust = normExt === "rs";
  const isShell = allowShellVars && (normExt === "sh" || normExt === "bash" || normExt === "zsh" || normExt === "fish");
  const docTagsEnabled = DOC_COMMENT_EXTS.has(normExt);

  const codeState = mdState?.kind === "code" ? mdState : null;

  let i = 0;
  let plainStart = 0;
  const flushPlain = (end) => {
    if (end > plainStart) {
      pushCodeToken(tokens, "plain", text.slice(plainStart, end));
    }
    plainStart = end;
  };

  if (codeState && codeState.inBlockComment && slashComments) {
    const close = text.indexOf("*/");
    if (close < 0) {
      emitCommentTokens(tokens, text, docTagsEnabled);
      return tokens;
    }
    emitCommentTokens(tokens, text.slice(0, close + 2), docTagsEnabled);
    codeState.inBlockComment = false;
    i = plainStart = close + 2;
  } else if (codeState && codeState.tripleQuote) {
    const delim = codeState.tripleQuote;
    let end = 0;
    let closed = false;
    while (end < len) {
      if (!isPython && text[end] === "\\") {
        end = end + 1 < len ? end + 2 : len;
        continue;
      }
      if (isPython && text[end] === "\\" && codeState.tripleQuoteRaw !== true) {
        end = end + 1 < len ? end + 2 : len;
        continue;
      }
      if (text.startsWith(delim, end)) {
        end += 3;
        closed = true;
        break;
      }
      end += 1;
    }
    emitStringTokens(tokens, text.slice(0, closed ? end : len), "string", {
      isFString: Boolean(codeState.tripleQuoteF),
      allowPathVars: delim === '"""',
    });
    if (!closed) {
      return tokens;
    }
    codeState.tripleQuote = null;
    codeState.tripleQuoteRaw = false;
    codeState.tripleQuoteF = false;
    i = plainStart = end;
  } else if (docTagsEnabled && DOC_LINE_START_RE.test(text)) {
    emitCommentTokens(tokens, text, true);
    return tokens;
  }

  while (i < len) {
    const ch = text[i];

    if (markup && ch === "<" && text.startsWith("<!--", i)) {
      flushPlain(i);
      const close = text.indexOf("-->", i + 4);
      const end = close >= 0 ? close + 3 : len;
      pushCodeToken(tokens, "comment", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

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
        if (close < 0 && codeState) {
          codeState.inBlockComment = true;
        }
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

    if (isPython && (ch === "f" || ch === "F" || ch === "r" || ch === "R" || ch === "b" || ch === "B" || ch === "u" || ch === "U") && (i === 0 || !isIdentPartCh(text[i - 1]))) {
      let qOff = i + 1;
      if (qOff < len && (text[qOff] === "f" || text[qOff] === "F" || text[qOff] === "r" || text[qOff] === "R" || text[qOff] === "b" || text[qOff] === "B")) {
        qOff++;
      }
      const lowerPrefix = text.slice(i, qOff).toLowerCase();
      const quote = text[qOff];
      if ((quote === '"' || quote === "'") && isPyStringPrefix(lowerPrefix)) {
        const isTriple = text[qOff + 1] === quote && text[qOff + 2] === quote;
        const step = isTriple ? 3 : 1;
        const delim = isTriple ? quote + quote + quote : quote;
        let end = qOff + step;
        const isRaw = lowerPrefix.includes("r");
        const isF = lowerPrefix.includes("f");
        let closed = false;
        while (end < len) {
          if (!isRaw && text[end] === "\\") {
            end = end + 1 < len ? end + 2 : len;
            continue;
          }
          if (isTriple ? text.startsWith(delim, end) : text[end] === quote) {
            end += step;
            closed = true;
            break;
          }
          end++;
        }
        if (isTriple && !closed && codeState) {
          codeState.tripleQuote = delim;
          codeState.tripleQuoteRaw = isRaw;
          codeState.tripleQuoteF = isF;
        }
        flushPlain(i);
        pushCodeToken(tokens, "keyword", text.slice(i, qOff));
        emitStringTokens(tokens, text.slice(qOff, end), "string", {
          isFString: isF,
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
      if (ch === "'" && i > 0 && isIdentPartCh(text[i - 1])) {
        i++;
        continue;
      }
      const isTriple = (ch === '"' || ch === "'") && text[i + 1] === ch && text[i + 2] === ch;
      const step = isTriple ? 3 : 1;
      const delim = isTriple ? ch + ch + ch : ch;
      let end = i + step;
      let closed = false;
      while (end < len) {
        if (text[end] === "\\") {
          end = end + 1 < len ? end + 2 : len;
          continue;
        }
        if (isTriple ? text.startsWith(delim, end) : text[end] === ch) {
          end += step;
          closed = true;
          break;
        }
        end++;
      }
      if (isTriple && !closed && codeState && ((isJava && ch === '"') || isPython)) {
        codeState.tripleQuote = delim;
        codeState.tripleQuoteRaw = false;
        codeState.tripleQuoteF = false;
      }
      flushPlain(i);
      let kind = "string";
      if (isJson && ch === '"') {
        let look = end;
        while (look < len && text[look] === " ") look++;
        if (look < len && text[look] === ":") kind = "function";
      }
      emitStringTokens(tokens, text.slice(i, end), kind, {
        isTemplate: ch === "`" || (isShell && ch === '"'),
        allowPathVars: ch === '"',
      });
      i = plainStart = end;
      continue;
    }

    if (isShell && ch === "$" && i + 1 < len && (text[i + 1] === "{" || isIdentStartCh(text[i + 1]))) {
      let end = i + 1;
      if (text[end] === "{") {
        const close = text.indexOf("}", end + 1);
        end = close > end ? close + 1 : len;
      } else {
        end++;
        while (end < len && isIdentPartCh(text[end])) end++;
      }
      flushPlain(i);
      pushCodeToken(tokens, "variable", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (isCss && ch === "#" && i + 1 < len && isHexDigitChar(text[i + 1])) {
      let end = i + 1;
      while (end < len && isHexDigitChar(text[end])) end++;
      flushPlain(i);
      pushCodeToken(tokens, "number", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (ch === "@" && i + 1 < len && isIdentStartCh(text[i + 1]) && (i === 0 || !isIdentPartCh(text[i - 1]))) {
      let end = i + 2;
      while (end < len && (isIdentPartCh(text[end]) || text[end] === ".")) end++;
      flushPlain(i);
      pushCodeToken(tokens, isCss ? "keyword" : "annotation", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (ch === "<" && i + 1 < len && (markup || normExt === "jsx" || normExt === "tsx")) {
      let tagStart = i + 1;
      if (text[tagStart] === "/") tagStart++;
      if (tagStart < len && isAsciiAlphaChar(text[tagStart])) {
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

    if (isDigitCh(ch) && (i === 0 || !isIdentPartCh(text[i - 1]))) {
      let end = i + 1;
      if (ch === "0" && end < len && (text[end] === "x" || text[end] === "X" || text[end] === "b" || text[end] === "B")) {
        end++;
        while (end < len && (isHexDigitChar(text[end]) || text[end] === "_")) end++;
      } else {
        while (end < len && (isDigitCh(text[end]) || text[end] === "." || text[end] === "_")) end++;
        if (end < len && (text[end] === "e" || text[end] === "E") && end + 1 < len && (isDigitCh(text[end + 1]) || text[end + 1] === "+" || text[end + 1] === "-")) {
          end += 2;
          while (end < len && (isDigitCh(text[end]) || text[end] === "_")) end++;
        }
        while (end < len && (isAsciiAlphaChar(text[end]) || text[end] === "%")) end++;
      }
      flushPlain(i);
      pushCodeToken(tokens, "number", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    if (
      (ch === "-" && text[i + 1] === ">") ||
      (extraKeywords && ch === "<" && text[i + 1] === "-") ||
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
      } else if (CODE_SPECIAL_VARS.has(word) || (includeSelfUpper && word === "Self") || (!isPython && CODE_BUILTIN_VARS.has(word))) {
        kind = "variable";
      } else if (CODE_BOOLEANS.has(word)) {
        kind = "boolean";
      } else if (CODE_CONSTANTS.has(word) || (includeIota && word === "iota") || (isUpperConstIdent(word) && !(isSql && CODE_KEYWORDS.has(word)))) {
        kind = "constant";
      } else if (isPython && word === "type" && isCall) {
        kind = "function";
      } else if (CODE_KEYWORDS.has(word) || (extraKeywords && EXTRA_DIFF_KEYWORDS.has(word)) || (allowSqlLowerKeywords && isSql && SQL_LOWER_KEYWORDS.has(word.toLowerCase()))) {
        kind = "keyword";
      } else if (isPascalTypeIdent(word) || ((CODE_TYPES.has(word) || (extraTypes && EXTRA_DIFF_TYPES.has(word))) && !isCall)) {
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

function isNavImportLine(text) {
  const t = text.trimStart();
  if (!t) return false;
  return (
    t.startsWith("import ") ||
    t.startsWith("import{") ||
    t.startsWith("export ") ||
    t.startsWith("from ") ||
    t.includes("require(")
  );
}

function isNavigableTokenKind(kind, text, ext, lineHasImport) {
  if (!text) return false;
  if (kind === "function" || kind === "annotation") return true;
  if (kind === "type") return !PRIMITIVE_TYPES.has(text);
  if (kind === "constant") return !CODE_CONSTANTS.has(text);
  if (kind === "variable") {
    return !CODE_BUILTIN_VARS.has(text);
  }
  if (kind === "string" && lineHasImport) {
    const isJsOrPy = ext === "js" || ext === "mjs" || ext === "cjs" || ext === "jsx" || ext === "ts" || ext === "tsx" || ext === "mts" || ext === "cts" || ext === "py" || ext === "pyw" || ext === "pyi";
    return isJsOrPy && text.length >= 3;
  }
  return false;
}

/**
 * Tokenize a code line into `[kind, text, { col, nav }]` spans where plain identifiers
 * are isolated into individual navigable spans with 1-based tab-expanded `col` positions.
 */
export function tokenizeInteractiveCodeLine(rawText, ext = "", mdState = null) {
  const normExt = String(ext || "").toLowerCase();
  const isMd = isMarkdownExt(normExt);
  const allowNav = !isMd;
  const expanded = expandCodeTabs(rawText || "");
  if (!expanded) {
    if (mdState && isMd) {
      const mdToks = tokenizeCodeLine("", normExt, mdState, { alreadyExpanded: true });
      return mdToks ? mdToks.map(([k, v]) => [k, v, { col: 1, nav: false }]) : null;
    }
    return null;
  }

  const baseTokens = tokenizeCodeLine(expanded, normExt, mdState, { alreadyExpanded: true });
  if (!baseTokens) {
    // Plain un-highlighted fallback still splits identifiers for navigable languages when short enough.
    if (expanded.length <= MAX_PREVIEW_SYNTAX_LINE_CHARS) {
      return splitPlainWithNavOffsets(expanded, 1, allowNav && !mdState?.inBlockComment && !mdState?.tripleQuote);
    }
    return null;
  }

  const lineHasImport = allowNav && isNavImportLine(expanded);
  const out = [];
  let col = 1;

  for (let idx = 0; idx < baseTokens.length; idx += 1) {
    const [kind, text] = baseTokens[idx];
    if (!text) continue;
    if (kind === "plain") {
      const split = splitPlainWithNavOffsets(text, col, allowNav);
      for (let s = 0; s < split.length; s += 1) {
        out.push(split[s]);
      }
    } else {
      const nav = allowNav && isNavigableTokenKind(kind, text, normExt, lineHasImport);
      out.push([kind, text, { col, nav }]);
    }
    col += text.length;
  }

  return out;
}

const MAX_INTERACTIVE_SPANS_PER_LINE = 400;

function splitPlainWithNavOffsets(text, startCol, allowNav = true) {
  const out = [];
  const len = text.length;
  let i = 0;
  let nonIdentStart = 0;
  let col = startCol;

  while (i < len) {
    if (out.length >= MAX_INTERACTIVE_SPANS_PER_LINE) break;
    if (isIdentStartCh(text[i])) {
      if (i > nonIdentStart) {
        const chunk = text.slice(nonIdentStart, i);
        out.push(["plain", chunk, { col, nav: false }]);
        col += chunk.length;
      }
      let end = i + 1;
      while (end < len && isIdentPartCh(text[end])) end += 1;
      const ident = text.slice(i, end);
      out.push(["plain", ident, { col, nav: Boolean(allowNav) }]);
      col += ident.length;
      i = nonIdentStart = end;
      continue;
    }
    i += 1;
  }

  if (nonIdentStart < len) {
    const tail = text.slice(nonIdentStart);
    out.push(["plain", tail, { col, nav: false }]);
  }
  return out;
}
