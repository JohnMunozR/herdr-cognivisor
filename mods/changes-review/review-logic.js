// Pure helper logic for changes-review: diff row parsing, linear syntax lexer, path normalization, watch filtering, and session baseline helpers.
import * as fsPromises from "fs/promises";
import { join } from "path";

export const DIFF_KEYWORDS = new Set([
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

export const DIFF_BOOLEANS = new Set(["true", "false", "True", "False"]);

export const DIFF_CONSTANTS = new Set([
  "null", "nil", "None", "undefined", "NaN", "Infinity",
]);

export const DIFF_SPECIAL_VARS = new Set(["this", "super", "self", "cls"]);

export const DIFF_BUILTIN_VARS = new Set([
  "console", "process", "window", "document", "globalThis", "module", "exports",
]);

export const DIFF_TYPES = new Set([
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
let cachedDiffPalette = null;

export function getDiffSyntaxPalette(t) {
  if (t && t === cachedDiffThemeRef && cachedDiffPalette) return cachedDiffPalette;
  const isDark = isDarkTheme(t);
  const warmAmber = isDark ? "#d19a66" : "#b35900";
  const cyan = pickTone(t?.ansi6, isDark ? "#56b6c2" : "#0e7490", isDark);
  const coral = pickTone(t?.ansi1, isDark ? "#e06c75" : "#cf222e", isDark);
  const palette = {
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
  if (t) {
    cachedDiffThemeRef = t;
    cachedDiffPalette = palette;
  }
  return palette;
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
      if (close > i + 2 && (isTemplate || /^[a-zA-Z0-9_.:-]+$/.test(slice.slice(i + 2, close)))) {
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
        const isPathOrSlf4j = allowPathVars && (inner === "" || (slice[i - 1] === "/" && /^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(inner)));
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
    } else if (/^-?(?:0x[0-9a-fA-F_]+|\d+(?:\.\d+)?)(?:ms|s|m|h|d|kb|mb|gb)?$/i.test(valTrim)) {
      pushSyntaxToken(tokens, "number", valTrim);
    } else {
      emitDiffStringSegments(tokens, valTrim, "string", { allowPathVars: false });
    }
  }
  if (tailWs) pushSyntaxToken(tokens, "plain", tailWs);
  return tokens;
}

export const MAX_DIFF_SYNTAX_LINE_CHARS = 1600;
export const MAX_DIFF_RENDER_LINE_CHARS = 4000;

export function expandCodeTabs(rawText) {
  if (!rawText) return "";
  const s = String(rawText);
  return s.indexOf("\t") !== -1 ? s.replace(/\t/g, "    ") : s;
}

// Linear single-pass lexer that preserves exact characters and avoids regex backtracking.
export function tokenizeDiffLine(rawText, ext) {
  if (!rawText) return null;
  const text = expandCodeTabs(rawText);
  if (text.length > MAX_DIFF_SYNTAX_LINE_CHARS || ext === "txt" || ext === "log") return null;

  if (PROP_EXTS.has(ext)) {
    return tokenizeDiffPropertiesLine(text, []);
  }

  const tokens = [];
  const len = text.length;
  const hashComments = HASH_COMMENT_EXTS.has(ext);
  const slashComments = !ext || SLASH_COMMENT_EXTS.has(ext);
  const markup = MARKUP_EXTS.has(ext);
  const isPython = ext === "py" || ext === "pyw" || ext === "pyi";
  const isJson = ext === "json" || ext === "jsonc" || ext === "json5";
  const isYaml = ext === "yml" || ext === "yaml";
  const isCss = ext === "css" || ext === "scss" || ext === "less";
  const isSql = ext === "sql";
  const isRust = ext === "rs";
  const isMd = ext === "md" || ext === "mdx";
  const docTagsEnabled = DOC_COMMENT_EXTS.has(ext);

  if (isMd && /^\s*#{1,6}\s/.test(text)) {
    return [["keyword", text]];
  }
  if (docTagsEnabled && /^\s*\*\s*(?:$|\*\/|@(?:param|returns?|throws|exception|see|since|deprecated|author|version|implSpec|implNote|apiNote|code|linkplain|link|value|inheritDoc)\b)/.test(text)) {
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

    // Markup <!-- comment -->
    if (markup && ch === "<" && text.startsWith("<!--", i)) {
      flushPlain(i);
      const close = text.indexOf("-->", i + 4);
      const end = close >= 0 ? close + 3 : len;
      pushSyntaxToken(tokens, "comment", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Line & block comments
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

    // Python prefixed strings (f"...", r"...", b"...", fr"...")
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

    // Strings ("...", '...', `...`, and """...""" / '''...''')
    if (ch === '"' || ch === "'" || ch === "`") {
      // Avoid treating Rust lifetimes ('a, 'static) as strings; Rust char literals only span 'x' or '\x..'
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
      pushSyntaxToken(tokens, "number", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Decorators / Annotations (@Override, @RestController, @app.get, CSS @media)
    if (ch === "@" && i + 1 < len && isIdentStart(text[i + 1]) && (i === 0 || !isIdentPart(text[i - 1]))) {
      let end = i + 2;
      while (end < len && (isIdentPart(text[end]) || text[end] === ".")) end++;
      flushPlain(i);
      pushSyntaxToken(tokens, isCss ? "keyword" : "annotation", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Markup / JSX tags (<div, </div, <MyComponent)
    if (ch === "<" && i + 1 < len && (markup || ext === "jsx" || ext === "tsx")) {
      let tagStart = i + 1;
      if (text[tagStart] === "/") tagStart++;
      if (tagStart < len && /[A-Za-z]/.test(text[tagStart])) {
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

    // Numbers (standalone, not trailing digits inside foo123)
    if (isDigit(ch) && (i === 0 || !isIdentPart(text[i - 1]))) {
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
      pushSyntaxToken(tokens, "number", text.slice(i, end));
      i = plainStart = end;
      continue;
    }

    // Operators & language arrows (->, =>, ::, ?., ??, ===, !==, <=, >=, ..., :=, &&, ||)
    if (
      (ch === "-" && text[i + 1] === ">") ||
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

    // Identifiers / Keywords / Types / Constants / Booleans / Special Vars / Function calls / Method refs / YAML keys
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
      } else if (DIFF_CONSTANTS.has(word) || (word.length > 1 && /^[A-Z][A-Z0-9_]+$/.test(word))) {
        kind = "constant";
      } else if (isPython && word === "type" && isCall) {
        kind = "function";
      } else if (DIFF_KEYWORDS.has(word)) {
        kind = "keyword";
      } else if (/^[A-Z][a-zA-Z0-9_]*$/.test(word) || (DIFF_TYPES.has(word) && !isCall)) {
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

// Numbers and syntax-tokenizes each diff line once so frames only draw visible rows.
export function diffRows(lines, filePath = "") {
  const ext = getFileExt(filePath);
  let old = 0, next = 0;
  return lines.map((rawLine) => {
    const line = typeof rawLine === "string" && rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") {
      const code = expandCodeTabs(line.slice(1) || " ");
      return { kind, number: old++, text: code, tokens: tokenizeDiffLine(code, ext) };
    }
    if (kind === "+") {
      const code = expandCodeTabs(line.slice(1) || " ");
      return { kind, number: next++, text: code, tokens: tokenizeDiffLine(code, ext) };
    }
    if (kind === " ") {
      old++;
      const code = expandCodeTabs(line.slice(1) || " ");
      return { kind, number: next++, text: code, tokens: tokenizeDiffLine(code, ext) };
    }
    return { kind: "", text: expandCodeTabs(line) };
  });
}

// Stack-safe pixel width estimation for horizontal diff scrolling.
export function computeDiffContentWidth(rows, { minWidth = 300, charPx = 7.8, gutterPx = 96 } = {}) {
  let maxCols = 0;
  for (const row of rows || []) {
    const raw = typeof row === "string" ? row : row?.text;
    if (!raw) continue;
    const expanded = expandCodeTabs(raw);
    const cols = Math.min(expanded.length, MAX_DIFF_RENDER_LINE_CHARS + 32);
    if (cols > maxCols) maxCols = cols;
  }
  return Math.max(minWidth, Math.ceil(maxCols * charPx) + gutterPx);
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
    activePanes.every((p) => !p.terminal && (p.mod === "changes-review" || p.mod === "files-search"))
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

export function pickNextDirtyService(sortedServices, currentServiceId, getServiceStatusFn) {
  if (!Array.isArray(sortedServices) || sortedServices.length === 0) return null;
  const getStatus = typeof getServiceStatusFn === "function" ? getServiceStatusFn : () => "pending";
  const curIdx = currentServiceId ? sortedServices.findIndex((s) => s?.id === currentServiceId) : -1;
  if (curIdx < 0) {
    for (const cand of sortedServices) {
      if (cand && (cand.workingCount || 0) > 0 && getStatus(cand.id, cand) !== "approved") {
        return cand;
      }
    }
    return null;
  }
  for (let offset = 1; offset < sortedServices.length; offset++) {
    const cand = sortedServices[(curIdx + offset) % sortedServices.length];
    if (cand && cand.id !== currentServiceId && (cand.workingCount || 0) > 0 && getStatus(cand.id, cand) !== "approved") {
      return cand;
    }
  }
  return null;
}

export function filterSessionCommits(commits, sessionStartedAt) {
  if (!Array.isArray(commits)) return [];
  const startedAtMs = Number(sessionStartedAt || 0);
  if (!startedAtMs || startedAtMs <= 0) return commits;
  const cutoffSec = Math.floor(startedAtMs / 1000);
  return commits.filter((c) => c && Number(c.timestamp || 0) >= cutoffSec);
}

export function filterSessionWorkingEntries(entries, baselineRepo, sessionStartedAt) {
  if (!Array.isArray(entries)) return [];
  const startedAtMs = Number(sessionStartedAt || 0);
  const dirtyFiles =
    baselineRepo && typeof baselineRepo === "object" && baselineRepo.dirtyFiles && typeof baselineRepo.dirtyFiles === "object"
      ? baselineRepo.dirtyFiles
      : null;

  return entries.filter((entry) => {
    if (!entry) return false;
    const relFile = entry.relFile ?? entry.path ?? "";
    const status = entry.status ?? "";
    const sig = entry.sig ?? "";
    const mtimeMs = Number(entry.mtimeMs || 0);

    if (dirtyFiles) {
      const base = dirtyFiles[relFile];
      if (base && typeof base === "object") {
        if ((base.status ?? "") === status && (base.sig ?? "") === sig) {
          return false;
        }
      }
      return true;
    }

    if (startedAtMs > 0) {
      return !mtimeMs || mtimeMs >= startedAtMs;
    }
    return true;
  });
}

function normBaselineRoot(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
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

export async function statFileEntry(fullPath, status, on = null, fsDeps = fsPromises) {
  if (on) return { sig: String(status || ""), mtimeMs: 0 };
  if (!fullPath) return { sig: "deleted", mtimeMs: 0 };
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
      if (err && err.code === "ENOENT") return { sig: "deleted", mtimeMs: 0 };
    }
  }
  if (typeof api.exists === "function") {
    try {
      const ok = await api.exists(fullPath);
      if (!ok) return { sig: "deleted", mtimeMs: 0 };
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
      if (err && err.code === "ENOENT") return { sig: "deleted", mtimeMs: 0 };
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
    repos[normRoot] = { dirtyFiles };
  }
  return {
    version: 1,
    startedAt: startedAtNum,
    workspaceRoot,
    repos,
  };
}

function baselineMatchesWorkspace(baseline, workspaceRoot) {
  const normWs = normBaselineRoot(workspaceRoot);
  if (!normWs || !baseline?.workspaceRoot) return true;
  return baseline.workspaceRoot === normWs;
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
  const baseDir = join(String(appHomeDir), "mesh", "sessions");
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
  const baseDir = join(String(appHomeDir), "mesh", "sessions");
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

function stripAnsiEscapes(text) {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

const RESUME_CMD_LINE_RE =
  /^(?:(?:[^\n]{0,60}?[$%>❯›•]\s+)|Running\s+)?(?:\/resume(?:\s+([a-zA-Z0-9_][a-zA-Z0-9._:/-]*))?|(?:claude|codex|gemini|opencode|antigravity)\s+(?:--)?resume(?:\s+([a-zA-Z0-9_][a-zA-Z0-9._:/-]*))?)\s*$/i;

export function extractResumeKeyFromTranscript(text, workspaceRoot) {
  const s = stripAnsiEscapes(text);
  if (!s) return "";
  const lines = s.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
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
  const { isAttributed = false, hasSessionCommits = false } = opts || {};

  if (hasAnyMtime) {
    const sessionFiles = filterSessionWorkingEntries(entries, null, startedAtMs);
    const backfillDirtyFiles = {};
    for (const item of entries) {
      const rel = item?.relFile ?? item?.path ?? "";
      if (!rel) continue;
      const mtimeMs = Number(item?.mtimeMs || 0);
      if (mtimeMs > 0 && startedAtMs > 0 && mtimeMs < startedAtMs) {
        backfillDirtyFiles[rel] = { status: String(item.status || ""), sig: String(item.sig || "") };
      }
    }
    return { sessionFiles, backfillDirtyFiles };
  }

  if (isAttributed || hasSessionCommits) {
    return {
      sessionFiles: filterSessionWorkingEntries(entries, null, startedAtMs),
      backfillDirtyFiles: {},
    };
  }

  const backfillDirtyFiles = {};
  for (const item of entries) {
    const rel = item?.relFile ?? item?.path ?? "";
    if (!rel) continue;
    backfillDirtyFiles[rel] = { status: String(item.status || ""), sig: String(item.sig || "") };
  }
  return { sessionFiles: [], backfillDirtyFiles };
}
