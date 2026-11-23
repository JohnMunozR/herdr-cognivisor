// Shared pure code-navigation contracts, lexical masking, cursor context extraction, history stack, and ranking helpers.
// Zero GPUI / herdr / Node stdlib dependencies (runs identically in QuickJS and Node --test).
import { expandCodeTabs, CODE_KEYWORDS, CODE_BOOLEANS, CODE_CONSTANTS } from "./code-syntax.js";

export const NAV_HISTORY_LIMIT = 50;

const JS_EXTS = new Set(["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"]);
const PY_EXTS = new Set(["py", "pyw", "pyi"]);
const JAVA_EXTS = new Set(["java"]);

const NON_NAV_WORDS = new Set([
  ...CODE_KEYWORDS,
  ...CODE_BOOLEANS,
  ...CODE_CONSTANTS,
  "True",
  "False",
  "None",
]);

const EXTRA_PY_TYPE_CONTEXT_KW = new Set(["class", "def"]);
const JAVA_PRIMITIVES = new Set([
  "void", "boolean", "byte", "short", "int", "long", "char", "float", "double", "var",
]);

export function detectNavLanguage(filePathOrExt) {
  if (!filePathOrExt) return null;
  const s = String(filePathOrExt).trim().toLowerCase();
  if (s === "js" || s === "javascript" || s === "ts" || s === "typescript") return "js";
  if (s === "python" || s === "py") return "python";
  if (s === "java") return "java";
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : base;
  if (JS_EXTS.has(ext)) return "js";
  if (PY_EXTS.has(ext)) return "python";
  if (JAVA_EXTS.has(ext)) return "java";
  return null;
}

export function isNavIdentStart(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}

export function isNavIdentPart(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;
}

export function splitCodeLinesExpanded(sourceText) {
  if (Array.isArray(sourceText)) {
    return sourceText.map((l) => expandCodeTabs(l == null ? "" : String(l)));
  }
  const raw = String(sourceText || "");
  const parts = raw.split(/\r\n|\n|\r/);
  const out = new Array(parts.length);
  for (let i = 0; i < parts.length; i += 1) {
    out[i] = expandCodeTabs(parts[i]);
  }
  return out;
}

export function expandedColToRawCol(rawLine, expandedCol, tabSize = 4) {
  const s = String(rawLine || "");
  const target = Math.max(1, Number(expandedCol) || 1);
  let exp = 1;
  for (let i = 0; i < s.length; i += 1) {
    if (exp >= target) return i + 1;
    exp += s[i] === "\t" ? tabSize : 1;
  }
  return s.length + 1;
}

const NAV_SPACES_CACHE = ["", " ", "  ", "   ", "    ", "     ", "      ", "       ", "        "];

function makeSpaces(count) {
  if (count <= 0) return "";
  return count < NAV_SPACES_CACHE.length ? NAV_SPACES_CACHE[count] : " ".repeat(count);
}

/**
 * Produce space-masked lines preserving exact character length & 1-based column offsets
 * for code while blanking comments and string interiors (keeping JS `${...}` and Python f-string `{...}` code).
 */
export function maskNonCodeRegions(linesInput, lang) {
  const lines = Array.isArray(linesInput) ? linesInput : splitCodeLinesExpanded(linesInput);
  const out = new Array(lines.length);

  if (lang === "python") {
    let inTripleQuote = null; // '"""' | "'''"
    let tripleIsF = false;
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      const len = line.length;
      if (!inTripleQuote && line.indexOf("#") === -1 && line.indexOf('"') === -1 && line.indexOf("'") === -1) {
        out[li] = line;
        continue;
      }
      let maskedOut = "";
      let copyFrom = 0;
      const maskSpan = (s, e) => {
        const ms = s > copyFrom ? s : copyFrom;
        const me = e < len ? e : len;
        if (ms > copyFrom) maskedOut += line.slice(copyFrom, ms);
        if (me > ms) {
          maskedOut += makeSpaces(me - ms);
          copyFrom = me;
        }
      };

      let i = 0;
      let noCurlyAfter = len;

      while (i < len) {
        if (inTripleQuote) {
          if (tripleIsF && line[i] === "{" && line[i + 1] !== "{" && i < noCurlyAfter) {
            const close = findBalancedCurlyEnd(line, i + 1);
            if (close > i) {
              maskSpan(i, i + 1);
              maskSpan(close, close + 1);
              i = close + 1;
              continue;
            }
            noCurlyAfter = i;
          }
          if (line[i] === "\\" && i + 1 < len) {
            maskSpan(i, i + 2);
            i += 2;
            continue;
          }
          if (line.startsWith(inTripleQuote, i)) {
            maskSpan(i, i + 3);
            inTripleQuote = null;
            tripleIsF = false;
            i += 3;
            continue;
          }
          maskSpan(i, i + 1);
          i += 1;
          continue;
        }

        const ch = line[i];
        if (ch === "#") {
          maskSpan(i, len);
          break;
        }

        // Check string literal (optional f/r/b/u prefix)
        let qStart = i;
        let prefix = "";
        if ((ch === "f" || ch === "F" || ch === "r" || ch === "R" || ch === "b" || ch === "B" || ch === "u" || ch === "U") &&
          (i === 0 || !isNavIdentPart(line[i - 1]))) {
          let pEnd = i + 1;
          if (pEnd < len && (line[pEnd] === "f" || line[pEnd] === "F" || line[pEnd] === "r" || line[pEnd] === "R" || line[pEnd] === "b" || line[pEnd] === "B")) {
            pEnd += 1;
          }
          if (line[pEnd] === '"' || line[pEnd] === "'") {
            prefix = line.slice(i, pEnd).toLowerCase();
            qStart = pEnd;
          }
        }

        const q = line[qStart];
        if (q === '"' || q === "'") {
          const isTriple = line[qStart + 1] === q && line[qStart + 2] === q;
          const isF = prefix.includes("f");
          const isRaw = prefix.includes("r");
          maskSpan(i, qStart + (isTriple ? 3 : 1));
          i = qStart + (isTriple ? 3 : 1);
          noCurlyAfter = len;
          if (isTriple) {
            const delim = q + q + q;
            let closedTriple = false;
            while (i < len) {
              if (!isRaw && line[i] === "\\" && i + 1 < len) {
                maskSpan(i, i + 2);
                i += 2;
                continue;
              }
              if (isF && line[i] === "{" && line[i + 1] !== "{" && i < noCurlyAfter) {
                const close = findBalancedCurlyEnd(line, i + 1);
                if (close > i) {
                  maskSpan(i, i + 1);
                  maskSpan(close, close + 1);
                  i = close + 1;
                  continue;
                }
                noCurlyAfter = i;
              }
              if (line.startsWith(delim, i)) {
                maskSpan(i, i + 3);
                i += 3;
                inTripleQuote = null;
                closedTriple = true;
                break;
              }
              maskSpan(i, i + 1);
              i += 1;
            }
            if (!closedTriple) {
              inTripleQuote = delim;
              tripleIsF = isF;
            }
          } else {
            while (i < len) {
              if (!isRaw && line[i] === "\\" && i + 1 < len) {
                maskSpan(i, i + 2);
                i += 2;
                continue;
              }
              if (isF && line[i] === "{") {
                if (line[i + 1] === "{") {
                  maskSpan(i, i + 2);
                  i += 2;
                  continue;
                }
                if (i < noCurlyAfter) {
                  const close = findBalancedCurlyEnd(line, i + 1);
                  if (close > i) {
                    maskSpan(i, i + 1);
                    maskSpan(close, close + 1);
                    i = close + 1;
                    continue;
                  }
                  noCurlyAfter = i;
                }
              }
              if (line[i] === q) {
                maskSpan(i, i + 1);
                i += 1;
                break;
              }
              maskSpan(i, i + 1);
              i += 1;
            }
          }
          continue;
        }

        i += 1;
      }

      out[li] = copyFrom === 0 ? line : (copyFrom < len ? maskedOut + line.slice(copyFrom) : maskedOut);
    }
    return out;
  }

  // C-style slash comments & quotes (JS / TS / Java)
  let inBlockComment = false;
  let inBacktick = false;
  let inJavaTextBlock = false;
  const tplBraceStack = [];
  const allowBackticks = lang === "js";
  const allowRegex = lang === "js";
  const allowTextBlock = lang === "java";
  let lastCodeChar = "";
  let lastCodeWord = "";
  let prevIncDec = false;

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const len = line.length;
    if (
      !inBlockComment &&
      !inBacktick &&
      !inJavaTextBlock &&
      tplBraceStack.length === 0 &&
      line.indexOf("/") === -1 &&
      line.indexOf('"') === -1 &&
      line.indexOf("'") === -1 &&
      (!allowBackticks || line.indexOf("`") === -1)
    ) {
      if (allowRegex) {
        let p = len - 1;
        while (p >= 0 && (line[p] === " " || line[p] === "\t")) p -= 1;
        if (p >= 0) {
          if (isNavIdentPart(line[p])) {
            let ws = p;
            while (ws > 0 && isNavIdentPart(line[ws - 1])) ws -= 1;
            let k = ws - 1;
            while (k >= 0 && (line[k] === " " || line[k] === "\t")) k -= 1;
            const afterDot = k >= 0 && line[k] === ".";
            lastCodeWord = afterDot ? "" : line.slice(ws, p + 1);
            lastCodeChar = line[p];
            prevIncDec = false;
          } else {
            lastCodeWord = "";
            lastCodeChar = line[p];
            prevIncDec = p > 0 && (lastCodeChar === "+" || lastCodeChar === "-") && line[p - 1] === lastCodeChar;
          }
        }
      }
      out[li] = line;
      continue;
    }

    let maskedOut = "";
    let copyFrom = 0;
    const maskSpan = (s, e) => {
      const ms = s > copyFrom ? s : copyFrom;
      const me = e < len ? e : len;
      if (ms > copyFrom) maskedOut += line.slice(copyFrom, ms);
      if (me > ms) {
        maskedOut += makeSpaces(me - ms);
        copyFrom = me;
      }
    };

    let i = 0;
    let identStart = -1;
    let identAfterDot = false;
    let lastRawCharWasOp = false;

    const flushIdent = (endIdx) => {
      if (identStart >= 0) {
        lastCodeWord = identAfterDot ? "" : line.slice(identStart, endIdx);
        lastCodeChar = line[endIdx - 1] || lastCodeChar;
        identStart = -1;
        identAfterDot = false;
      }
    };

    while (i < len) {
      if (inBlockComment) {
        const close = line.indexOf("*/", i);
        if (close >= 0) {
          maskSpan(i, close + 2);
          inBlockComment = false;
          i = close + 2;
          continue;
        }
        maskSpan(i, len);
        break;
      }

      if (inJavaTextBlock) {
        if (line[i] === "\\" && i + 1 < len) {
          maskSpan(i, i + 2);
          i += 2;
          continue;
        }
        if (line.startsWith('"""', i)) {
          maskSpan(i, i + 3);
          inJavaTextBlock = false;
          lastCodeChar = "expr";
          lastCodeWord = "";
          prevIncDec = false;
          i += 3;
          continue;
        }
        maskSpan(i, i + 1);
        i += 1;
        continue;
      }

      if (inBacktick) {
        if (line[i] === "\\" && i + 1 < len) {
          maskSpan(i, i + 2);
          i += 2;
          continue;
        }
        if (line[i] === "$" && line[i + 1] === "{") {
          maskSpan(i, i + 2);
          tplBraceStack.push(1);
          inBacktick = false;
          lastCodeChar = "{";
          lastCodeWord = "";
          prevIncDec = false;
          i += 2;
          continue;
        }
        if (line[i] === "`") {
          maskSpan(i, i + 1);
          inBacktick = false;
          lastCodeChar = "expr";
          lastCodeWord = "";
          prevIncDec = false;
          i += 1;
          continue;
        }
        maskSpan(i, i + 1);
        i += 1;
        continue;
      }

      const ch = line[i];
      if (tplBraceStack.length > 0) {
        if (ch === "{") {
          tplBraceStack[tplBraceStack.length - 1] += 1;
        } else if (ch === "}") {
          tplBraceStack[tplBraceStack.length - 1] -= 1;
          if (tplBraceStack[tplBraceStack.length - 1] === 0) {
            flushIdent(i);
            tplBraceStack.pop();
            maskSpan(i, i + 1);
            inBacktick = true;
            lastCodeChar = "expr";
            lastCodeWord = "";
            prevIncDec = false;
            i += 1;
            continue;
          }
        }
      }

      if (ch === "/" && line[i + 1] === "/") {
        flushIdent(i);
        maskSpan(i, len);
        break;
      }
      if (ch === "/" && line[i + 1] === "*") {
        flushIdent(i);
        const close = line.indexOf("*/", i + 2);
        if (close >= 0) {
          maskSpan(i, close + 2);
          i = close + 2;
          continue;
        }
        maskSpan(i, len);
        inBlockComment = true;
        break;
      }

      if (allowRegex && ch === "/") {
        flushIdent(i);
        const prevRaw = i > 0 ? line[i - 1] : "";
        if (prevRaw !== "<" && canStartJsRegex(lastCodeChar, lastCodeWord, prevIncDec)) {
          const regexEnd = findJsRegexLiteralEnd(line, i);
          if (regexEnd > i) {
            maskSpan(i, regexEnd);
            lastCodeChar = "expr";
            lastCodeWord = "";
            prevIncDec = false;
            lastRawCharWasOp = false;
            i = regexEnd;
            continue;
          }
        }
      }

      if (allowTextBlock && line.startsWith('"""', i)) {
        flushIdent(i);
        maskSpan(i, i + 3);
        inJavaTextBlock = true;
        lastRawCharWasOp = false;
        i += 3;
        continue;
      }

      if (allowBackticks && ch === "`") {
        flushIdent(i);
        maskSpan(i, i + 1);
        inBacktick = true;
        lastRawCharWasOp = false;
        i += 1;
        continue;
      }

      if (ch === '"' || ch === "'") {
        flushIdent(i);
        const strStart = i;
        i += 1;
        while (i < len) {
          if (line[i] === "\\" && i + 1 < len) {
            i += 2;
            continue;
          }
          const cur = line[i];
          i += 1;
          if (cur === ch) break;
        }
        maskSpan(strStart, i);
        lastCodeChar = "expr";
        lastCodeWord = "";
        prevIncDec = false;
        lastRawCharWasOp = false;
        continue;
      }

      if (ch === " " || ch === "\t") {
        flushIdent(i);
        lastRawCharWasOp = false;
        i += 1;
        continue;
      }

      if (isNavIdentPart(ch)) {
        if (identStart < 0) {
          identStart = i;
          identAfterDot = lastCodeChar === ".";
          lastCodeWord = "";
        }
        lastCodeChar = ch;
        prevIncDec = false;
        lastRawCharWasOp = false;
        i += 1;
        continue;
      }

      flushIdent(i);
      prevIncDec = lastRawCharWasOp && (ch === "+" || ch === "-") && lastCodeChar === ch;
      lastCodeChar = ch;
      lastCodeWord = "";
      lastRawCharWasOp = ch === "+" || ch === "-";
      i += 1;
    }

    flushIdent(len);
    out[li] = copyFrom === 0 ? line : (copyFrom < len ? maskedOut + line.slice(copyFrom) : maskedOut);
  }

  return out;
}

const JS_REGEX_PREFIX_CHARS = new Set([
  "", "(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "^", "~", "+", "-", "*", "%", ">", "`", "/",
]);

const JS_REGEX_PREFIX_WORDS = new Set([
  "return", "throw", "case", "yield", "await", "typeof", "void",
  "delete", "in", "instanceof", "of", "else", "do", "export", "default", "new",
]);

function canStartJsRegex(lastCodeChar, lastCodeWord, prevIncDec) {
  if (prevIncDec) return false;
  if (lastCodeWord) return JS_REGEX_PREFIX_WORDS.has(lastCodeWord);
  return JS_REGEX_PREFIX_CHARS.has(lastCodeChar);
}

function findJsRegexLiteralEnd(line, slashIdx) {
  const len = line.length;
  let j = slashIdx + 1;
  let inClass = false;
  while (j < len) {
    const c = line[j];
    if (c === "\\" && j + 1 < len) {
      j += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      j += 1;
      continue;
    }
    if (c === "[") {
      inClass = true;
      j += 1;
      continue;
    }
    if (c === "/") {
      j += 1;
      while (j < len && isNavIdentPart(line[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

function findBalancedCurlyEnd(str, startIdx) {
  let depth = 1;
  let quote = null;
  for (let i = startIdx; i < str.length; i += 1) {
    const ch = str[i];
    if (quote) {
      if (ch === "\\" && i + 1 < str.length) {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Count argument expressions starting immediately after `(` at `(line0, openParenCol0)`.
 * When `rawLines` is provided, masked string literals (`foo("a")`) still count as an
 * argument expression while masked block/line comments do not.
 */
export function countCallArity(maskedLines, line0, openParenCol0, rawLines = null, lang = null) {
  if (!Array.isArray(maskedLines) || line0 < 0 || line0 >= maskedLines.length) return null;
  let depth = 1;
  let sawToken = false;
  let commas = 0;
  let inBlockComment = false;
  const maxLine = Math.min(maskedLines.length - 1, line0 + 12);
  const allowHashComment = lang == null || lang === "python";
  const allowSlashComment = lang == null || lang === "js" || lang === "java";

  for (let li = line0; li <= maxLine; li += 1) {
    const text = maskedLines[li] || "";
    const raw = Array.isArray(rawLines) ? (rawLines[li] || "") : null;
    const startC = li === line0 ? openParenCol0 + 1 : 0;
    for (let c = startC; c < text.length; c += 1) {
      if (inBlockComment && raw) {
        if (raw[c] === "*" && raw[c + 1] === "/") {
          inBlockComment = false;
          c += 1;
        }
        continue;
      }
      const ch = text[c];
      if (ch === "(" || ch === "[" || ch === "{") {
        sawToken = true;
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0 && ch === ")") {
          return sawToken ? commas + 1 : 0;
        }
        if (depth < 0) return null;
      } else if (ch === "," && depth === 1) {
        commas += 1;
        sawToken = true;
      } else if (ch !== " " && ch !== "\t") {
        sawToken = true;
      } else if (raw && !sawToken) {
        const rch = raw[c];
        if (!rch || rch === " " || rch === "\t") continue;
        if (allowSlashComment && rch === "/" && raw[c + 1] === "*") {
          inBlockComment = true;
          c += 1;
          continue;
        }
        if (allowSlashComment && rch === "/" && raw[c + 1] === "/") {
          break;
        }
        if (allowHashComment && rch === "#") {
          break;
        }
        sawToken = true;
      }
    }
  }
  return null;
}

/**
 * Count formal parameters in a method/function declaration signature starting at `(`.
 * Tracks angle brackets `<...>` in addition to `()`, `[]`, `{}` so Java generics like
 * `Map<String, Object> params` count as a single parameter.
 */
export function countDeclarationParamArity(maskedLines, line0, openParenCol0) {
  if (!Array.isArray(maskedLines) || line0 < 0 || line0 >= maskedLines.length) return null;
  let depth = 1;
  let angleDepth = 0;
  let sawToken = false;
  let commas = 0;
  const maxLine = Math.min(maskedLines.length - 1, line0 + 16);

  for (let li = line0; li <= maxLine; li += 1) {
    const text = maskedLines[li] || "";
    const startC = li === line0 ? openParenCol0 + 1 : 0;
    for (let c = startC; c < text.length; c += 1) {
      const ch = text[c];
      if (ch === "(" || ch === "[" || ch === "{") {
        sawToken = true;
        depth += 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0 && ch === ")") {
          return sawToken ? commas + 1 : 0;
        }
        if (depth < 0) return null;
      } else if (ch === "<") {
        sawToken = true;
        angleDepth += 1;
      } else if (ch === ">") {
        if (angleDepth > 0) angleDepth -= 1;
      } else if (ch === "," && depth === 1 && angleDepth === 0) {
        commas += 1;
        sawToken = true;
      } else if (ch !== " " && ch !== "\t") {
        sawToken = true;
      }
    }
  }
  return null;
}

function extractStringLiteralAt(rawLine, col0) {
  const len = rawLine.length;
  let i = 0;
  while (i < len) {
    const ch = rawLine[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      i += 1;
      while (i < len) {
        if (rawLine[i] === "\\" && i + 1 < len) {
          i += 2;
          continue;
        }
        if (rawLine[i] === ch) {
          const end = i;
          if (col0 >= start && col0 <= end) {
            return {
              text: rawLine.slice(start + 1, end),
              startCol: start + 1,
            };
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return null;
}

const PY_FROM_IMPORT_RE = /^from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\b/;
const PY_IMPORT_RE = /^import\s+([A-Za-z0-9_.]+)/;
const JS_FROM_RE = /\bfrom\s+(['"`])([^'"`]+)\1/;
const JS_REQ_IMPORT_RE = /\b(?:require|import)\s*\(\s*(['"`])([^'"`]+)\1\s*\)/;
const JS_SIDE_EFFECT_IMPORT_RE = /^\s*import\s+(['"`])([^'"`]+)\1/;
const JAVA_IMPORT_RE = /^\s*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;/;
const TRAILING_IDENT_RE = /([A-Za-z_$][A-Za-z0-9_$]*)$/;
const DECL_SKIP_HEAD_RE = /^(?:if|for|while|switch|catch|return|await|yield|throw|new)\b/;
const DECL_ALLOW_HEAD_RE = /^[A-Za-z_$@<]/;
const THROWS_PREFIX_RE = /^throws\b/;
const CLAUSE_KEYWORDS_RE = /\b(?:implements|extends|permits|throws)\b/;
const CASE_LINE_RE = /^\s*case\b/;
const ANNOTATION_BEFORE_PAREN_RE = /@([A-Za-z_][A-Za-z0-9_]*)$/;

export const MAX_NAV_ANALYZE_BYTES = 512 * 1024;
export const MAX_NAV_SINGLE_LINE_CHARS = 65536;

/**
 * Guard code-navigation entrypoints against multi-MB or single-line minified bundles.
 */
export function isNavSourceWithinLimits(sourceText) {
  if (typeof sourceText !== "string") return false;
  if (sourceText.length === 0 || sourceText.length > MAX_NAV_ANALYZE_BYTES) return false;
  if (sourceText.length > MAX_NAV_SINGLE_LINE_CHARS && sourceText.indexOf("\n") === -1 && sourceText.indexOf("\r") === -1) {
    return false;
  }
  return true;
}

/**
 * Precompute O(1) matching bracket index pairs (`()`, `[]`, `{}`) across token streams.
 */
export function computeBracketPairs(tokens, valueKey = "text") {
  const len = Array.isArray(tokens) ? tokens.length : 0;
  const pairs = new Int32Array(len);
  pairs.fill(-1);
  const stack = [];
  const stackKinds = [];
  for (let i = 0; i < len; i += 1) {
    const val = tokens[i]?.[valueKey];
    if (val === "(" || val === "[" || val === "{") {
      stack.push(i);
      stackKinds.push(val === "(" ? ")" : val === "[" ? "]" : "}");
    } else if (val === ")" || val === "]" || val === "}") {
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stackKinds[s] === val) {
          const openIdx = stack[s];
          pairs[openIdx] = i;
          pairs[i] = openIdx;
          stack.length = s;
          stackKinds.length = s;
          break;
        }
      }
    }
  }
  return pairs;
}

function extractImportModuleSpecifier(rawLine, lang) {
  if (!rawLine) return null;
  if (lang === "python") {
    const trimmed = rawLine.trim();
    let m = PY_FROM_IMPORT_RE.exec(trimmed);
    if (m) return m[1];
    m = PY_IMPORT_RE.exec(trimmed);
    if (m) return m[1];
    return null;
  }
  if (lang === "js") {
    let m = JS_FROM_RE.exec(rawLine);
    if (m) return m[2];
    m = JS_REQ_IMPORT_RE.exec(rawLine);
    if (m) return m[2];
    m = JS_SIDE_EFFECT_IMPORT_RE.exec(rawLine);
    if (m) return m[2];
    return null;
  }
  if (lang === "java") {
    const m = JAVA_IMPORT_RE.exec(rawLine);
    return m ? m[1] : null;
  }
  return null;
}

function extractAnnotationAt(maskedLine, col0) {
  if (col0 < 0 || col0 >= maskedLine.length) return null;
  let i = col0;
  while (i > 0 && (isNavIdentPart(maskedLine[i - 1]) || maskedLine[i - 1] === ".")) i -= 1;
  if (i > 0 && maskedLine[i - 1] === "@") {
    const start = i - 1;
    let end = col0 + 1;
    while (end < maskedLine.length && (isNavIdentPart(maskedLine[end]) || maskedLine[end] === ".")) end += 1;
    const raw = maskedLine.slice(start, end);
    const full = raw.slice(1);
    const parts = full.split(".").filter(Boolean);
    const clickedLeaf = (() => {
      let s = col0;
      let e = col0;
      while (s > start + 1 && isNavIdentPart(maskedLine[s - 1])) s -= 1;
      while (e < end && isNavIdentPart(maskedLine[e])) e += 1;
      return maskedLine.slice(s, e);
    })();
    if (!parts.length) return null;
    return {
      symbol: clickedLeaf || parts[parts.length - 1],
      col: start + 2,
      parts,
      isAnnotation: true,
    };
  }
  return null;
}

/**
 * Extract structured navigation cursor context at 1-based `(line, col)`.
 */
export function extractNavContext(sourceText, line1Based, col1Based, langOrPath) {
  const lang = detectNavLanguage(langOrPath);
  if (!lang) return null;

  const lines = splitCodeLinesExpanded(sourceText);
  const line = Math.floor(Number(line1Based) || 0);
  const col = Math.floor(Number(col1Based) || 0);
  if (line < 1 || line > lines.length || col < 1) return null;

  const line0 = line - 1;
  const rawExpanded = lines[line0] || "";
  if (!rawExpanded) return null;
  const col0 = Math.min(rawExpanded.length - 1, Math.max(0, col - 1));
  if (col0 < 0) return null;

  const maskedLines = maskNonCodeRegions(lines, lang);
  const maskedLine = maskedLines[line0] || "";
  const trimmedRaw = rawExpanded.trimStart();
  const isImportLine = (
    trimmedRaw.startsWith("import ") ||
    trimmedRaw.startsWith("import{") ||
    trimmedRaw.startsWith("export ") ||
    trimmedRaw.startsWith("from ") ||
    trimmedRaw.includes("require(") ||
    (lang === "java" && trimmedRaw.startsWith("package "))
  );

  // Import specifier string click in JS/Python
  const importSpec = isImportLine ? extractImportModuleSpecifier(rawExpanded, lang) : null;
  if (maskedLine[col0] === " ") {
    const strAt = isImportLine ? extractStringLiteralAt(rawExpanded, col0) : null;
    if (strAt && strAt.text) {
      return {
        lang,
        line,
        col: strAt.startCol,
        tokenCol: strAt.startCol,
        symbol: strAt.text,
        lineText: rawExpanded,
        qualifierChain: [],
        memberIndex: -1,
        isCall: false,
        isNewExpr: false,
        isAnnotation: false,
        isTypeContext: false,
        isImportLine: true,
        importModuleSpec: strAt.text,
        intent: "declaration",
        arity: null,
        maskedLines,
        lines,
      };
    }
    return null;
  }

  // Extract annotation (@Override, @app.get)
  const ann = extractAnnotationAt(maskedLine, col0);
  if (ann && !NON_NAV_WORDS.has(ann.symbol)) {
    return {
      lang,
      line,
      col: ann.col,
      tokenCol: ann.col,
      symbol: ann.symbol,
      lineText: rawExpanded,
      qualifierChain: ann.parts,
      memberIndex: Math.max(0, ann.parts.indexOf(ann.symbol)),
      isCall: true,
      isNewExpr: false,
      isAnnotation: true,
      isTypeContext: lang === "java",
      isImportLine: false,
      importModuleSpec: null,
      intent: lang === "python" ? "implementation" : "declaration",
      arity: null,
      maskedLines,
      lines,
    };
  }

  // Extract identifier around col0
  let s0 = col0;
  let e0 = col0;
  if (!isNavIdentPart(maskedLine[col0])) return null;
  while (s0 > 0 && isNavIdentPart(maskedLine[s0 - 1])) s0 -= 1;
  if (!isNavIdentStart(maskedLine[s0])) return null;
  while (e0 < maskedLine.length && isNavIdentPart(maskedLine[e0])) e0 += 1;

  const symbol = maskedLine.slice(s0, e0);
  if (!symbol) return null;
  if (NON_NAV_WORDS.has(symbol) && symbol !== "this" && symbol !== "self" && symbol !== "super") {
    return null;
  }
  if (lang === "java" && JAVA_PRIMITIVES.has(symbol)) return null;

  // Walk qualifier chain backwards/forwards across `.` / `?.` / `::` (single-line)
  let chainStart = s0;
  while (chainStart > 0) {
    let p = chainStart - 1;
    while (p >= 0 && maskedLine[p] === " ") p -= 1;
    if (p >= 0 && maskedLine[p] === ".") {
      p -= 1;
      if (p >= 0 && maskedLine[p] === "?") p -= 1;
    } else if (p >= 1 && maskedLine[p] === ":" && maskedLine[p - 1] === ":") {
      p -= 2;
    } else {
      break;
    }
    while (p >= 0 && maskedLine[p] === " ") p -= 1;
    if (p < 0 || !isNavIdentPart(maskedLine[p])) break;
    let tokS = p;
    while (tokS > 0 && isNavIdentPart(maskedLine[tokS - 1])) tokS -= 1;
    if (!isNavIdentStart(maskedLine[tokS])) break;
    chainStart = tokS;
  }

  let chainEnd = e0;
  while (chainEnd < maskedLine.length) {
    let p = chainEnd;
    while (p < maskedLine.length && maskedLine[p] === " ") p += 1;
    if (maskedLine[p] === "." && maskedLine[p + 1] !== ".") {
      p += 1;
    } else if (maskedLine[p] === "?" && maskedLine[p + 1] === ".") {
      p += 2;
    } else if (maskedLine[p] === ":" && maskedLine[p + 1] === ":") {
      p += 2;
    } else {
      break;
    }
    while (p < maskedLine.length && maskedLine[p] === " ") p += 1;
    if (p >= maskedLine.length || !isNavIdentStart(maskedLine[p])) break;
    let tokE = p + 1;
    while (tokE < maskedLine.length && isNavIdentPart(maskedLine[tokE])) tokE += 1;
    chainEnd = tokE;
  }

  const qualifierChain = [];
  let memberIndex = 0;
  let scan = chainStart;
  while (scan < chainEnd) {
    if (isNavIdentStart(maskedLine[scan])) {
      let end = scan + 1;
      while (end < chainEnd && isNavIdentPart(maskedLine[end])) end += 1;
      if (scan === s0) memberIndex = qualifierChain.length;
      qualifierChain.push(maskedLine.slice(scan, end));
      scan = end;
    } else {
      scan += 1;
    }
  }

  // Look right of clicked identifier for `(`, `?.(`, generic `<...>(`, or `::` method ref
  let after = e0;
  while (after < maskedLine.length && maskedLine[after] === " ") after += 1;
  if (maskedLine[after] === "?" && maskedLine[after + 1] === ".") after += 2;
  let isGenericCall = false;
  if (maskedLine[after] === "<") {
    let depth = 1;
    let g = after + 1;
    while (g < maskedLine.length && depth > 0) {
      if (maskedLine[g] === "<") depth += 1;
      else if (maskedLine[g] === ">") depth -= 1;
      g += 1;
    }
    if (depth === 0) {
      while (g < maskedLine.length && maskedLine[g] === " ") g += 1;
      if (maskedLine[g] === "(") {
        after = g;
        isGenericCall = true;
      }
    }
  }

  const openParenCol0 = maskedLine[after] === "(" ? after : -1;
  const beforeSlice = maskedLine.slice(0, chainStart).trimEnd();
  const prevTwo = s0 >= 2 ? maskedLine.slice(s0 - 2, s0) : "";
  const prevWordMatch = TRAILING_IDENT_RE.exec(beforeSlice);
  const prevWord = prevWordMatch ? prevWordMatch[1] : "";
  const isNewExpr = prevWord === "new" || (lang === "js" && beforeSlice.endsWith("new"));
  const isMethodRef = prevTwo === "::" || (s0 >= 3 && maskedLine.slice(0, s0).trimEnd().endsWith("::"));

  // Distinguish declaration header `function foo(`, `def foo(`, `method foo(`, `class Foo(` vs call `foo(`
  const beforeIdentTrimmed = maskedLine.slice(0, s0).trimEnd();
  const immediatePrevWordMatch = TRAILING_IDENT_RE.exec(beforeIdentTrimmed);
  const immediatePrevWord = immediatePrevWordMatch ? immediatePrevWordMatch[1] : "";
  const isDefKeywordPrefix = immediatePrevWord === "function" || immediatePrevWord === "def" || immediatePrevWord === "class" || immediatePrevWord === "interface" || immediatePrevWord === "enum" || immediatePrevWord === "record";

  // Arrow/method declaration lines (TS/Java/JS) have `)` followed by `:` / `{` / `=>` / `throws` / `;`
  let isDeclarationSignature = false;
  if (openParenCol0 >= 0 && !isNewExpr) {
    if (isDefKeywordPrefix) {
      isDeclarationSignature = true;
    } else if ((lang === "js" || lang === "java") && !beforeIdentTrimmed.endsWith(".") && !beforeIdentTrimmed.endsWith("=")) {
      if (hasDeclarationSignatureTail(maskedLines, line0, openParenCol0, beforeIdentTrimmed, trimmedRaw, lang)) {
        isDeclarationSignature = true;
      }
    }
  }

  const isCall = Boolean((openParenCol0 >= 0 || isGenericCall || isMethodRef || isNewExpr) && !isDefKeywordPrefix && !(isDeclarationSignature && !isNewExpr));

  const isTypeContext = computeIsTypeContext({
    lang,
    maskedLine,
    chainStart,
    isNewExpr,
    immediatePrevWord,
  });

  const enclosingAnnotation =
    lang === "java" && !isCall && memberIndex === 0
      ? detectAnnotationMemberTarget(maskedLines, line0, s0, e0)
      : null;

  const arity =
    openParenCol0 >= 0
      ? isCall
        ? countCallArity(maskedLines, line0, openParenCol0, lines, lang)
        : isDeclarationSignature
          ? countDeclarationParamArity(maskedLines, line0, openParenCol0)
          : null
      : null;
  const intent = isCall || (isDeclarationSignature && openParenCol0 >= 0) ? "implementation" : "declaration";

  return {
    lang,
    line,
    col: s0 + 1,
    tokenCol: s0 + 1,
    symbol,
    lineText: rawExpanded,
    qualifierChain,
    memberIndex,
    isCall,
    isNewExpr,
    isMethodRef,
    isDeclarationSignature,
    isAnnotation: false,
    enclosingAnnotation,
    isTypeContext,
    isImportLine,
    importModuleSpec: importSpec,
    intent,
    arity,
    maskedLines,
    lines,
  };
}

function hasDeclarationSignatureTail(maskedLines, startLineIdx0, openParenCol0, beforeIdentTrimmed, trimmedRaw, lang) {
  if (DECL_SKIP_HEAD_RE.test(trimmedRaw)) return false;
  if (!DECL_ALLOW_HEAD_RE.test(trimmedRaw) || beforeIdentTrimmed.includes("=")) return false;

  let depth = 0;
  let closeLine = -1;
  let closeCol = -1;
  const maxScan = Math.min(maskedLines.length, startLineIdx0 + 16);
  for (let ln = startLineIdx0; ln < maxScan; ln += 1) {
    const txt = maskedLines[ln] || "";
    const startC = ln === startLineIdx0 ? openParenCol0 : 0;
    for (let c = startC; c < txt.length; c += 1) {
      if (txt[c] === "(") depth += 1;
      else if (txt[c] === ")") {
        depth -= 1;
        if (depth === 0) {
          closeLine = ln;
          closeCol = c;
          break;
        }
      }
    }
    if (closeLine >= 0) break;
  }
  if (closeLine < 0) return false;

  let tail = (maskedLines[closeLine] || "").slice(closeCol + 1).trimStart();
  for (let probeLn = closeLine + 1; !tail && probeLn < Math.min(maskedLines.length, closeLine + 4); probeLn += 1) {
    tail = (maskedLines[probeLn] || "").trimStart();
  }
  if (tail.startsWith("{") || tail.startsWith("=>") || THROWS_PREFIX_RE.test(tail)) {
    return true;
  }
  if (lang === "js" && (tail.startsWith(":") || (tail.endsWith("{") && !beforeIdentTrimmed))) {
    return true;
  }
  if (lang === "java" && tail.startsWith(";")) {
    if (beforeIdentTrimmed.length > 0 && !beforeIdentTrimmed.endsWith(".")) {
      return true;
    }
    if (beforeIdentTrimmed.length === 0) {
      // Spotless / wrapped Java interface signature where return type is on the preceding line
      for (let prevLn = startLineIdx0 - 1; prevLn >= Math.max(0, startLineIdx0 - 3); prevLn -= 1) {
        const prevTxt = (maskedLines[prevLn] || "").trim();
        if (!prevTxt) continue;
        if (!/[;{},=]$/.test(prevTxt)) {
          return true;
        }
        break;
      }
    }
  }
  return false;
}

function computeIsTypeContext({ lang, maskedLine, chainStart, isNewExpr, immediatePrevWord }) {
  if (
    isNewExpr ||
    immediatePrevWord === "extends" ||
    immediatePrevWord === "implements" ||
    immediatePrevWord === "permits" ||
    immediatePrevWord === "instanceof" ||
    immediatePrevWord === "throws" ||
    immediatePrevWord === "as" ||
    EXTRA_PY_TYPE_CONTEXT_KW.has(immediatePrevWord)
  ) {
    return true;
  }

  const prefix = maskedLine.slice(0, chainStart).trimEnd();
  if (!prefix) return false;
  const lastCh = prefix[prefix.length - 1];

  if (lastCh === "<") {
    return true;
  }

  if (lastCh === ",") {
    // Only comma inside `<A, B>` generics or header clauses (`implements A, B`, `throws A, B`) is a type context,
    // never call arguments `foo(a, b)` or array literals `[a, b]`.
    let parenDepth = 0;
    let angleDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    for (let i = prefix.length - 2; i >= 0; i -= 1) {
      const ch = prefix[i];
      if (ch === ")") parenDepth += 1;
      else if (ch === "(") {
        if (parenDepth === 0) return false;
        parenDepth -= 1;
      } else if (ch === "]") bracketDepth += 1;
      else if (ch === "[") {
        if (bracketDepth === 0) return false;
        bracketDepth -= 1;
      } else if (ch === "}") braceDepth += 1;
      else if (ch === "{") {
        if (braceDepth === 0) return false;
        braceDepth -= 1;
      } else if (ch === ">") {
        if (i === 0 || (prefix[i - 1] !== "=" && prefix[i - 1] !== "-")) angleDepth += 1;
      } else if (ch === "<") {
        if (angleDepth === 0 && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return true;
        if (angleDepth > 0) angleDepth -= 1;
      } else if (ch === ";" || ch === "=") {
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) return false;
      }
    }
    return CLAUSE_KEYWORDS_RE.test(prefix);
  }

  if (lastCh === ":") {
    if (prefix.endsWith("::")) return false;
    if (lang === "java") return false;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    for (let i = prefix.length - 2; i >= 0; i -= 1) {
      const ch = prefix[i];
      if (ch === ")") parenDepth += 1;
      else if (ch === "(") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "]") bracketDepth += 1;
      else if (ch === "[") {
        if (bracketDepth === 0 && lang === "python") return false;
        bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (ch === "}") braceDepth += 1;
      else if (ch === "{") {
        if (braceDepth === 0 && lang === "python") return false;
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (ch === "?" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && lang === "js") {
        return false;
      } else if (ch === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        break;
      }
    }
    if (CASE_LINE_RE.test(prefix)) return false;
    return true;
  }

  return false;
}

function detectAnnotationMemberTarget(maskedLines, lineIdx0, s0, e0) {
  const line = maskedLines[lineIdx0] || "";
  let after = e0;
  while (after < line.length && line[after] === " ") after += 1;
  if (line[after] !== "=" || line[after + 1] === "=") return null;

  let parenDepth = 0;
  const minLine = Math.max(0, lineIdx0 - 8);
  for (let ln = lineIdx0; ln >= minLine; ln -= 1) {
    const txt = maskedLines[ln] || "";
    const startC = ln === lineIdx0 ? s0 - 1 : txt.length - 1;
    for (let c = startC; c >= 0; c -= 1) {
      const ch = txt[c];
      if (ch === ")") parenDepth += 1;
      else if (ch === "(") {
        if (parenDepth === 0) {
          const left = txt.slice(0, c).trimEnd();
          const m = ANNOTATION_BEFORE_PAREN_RE.exec(left);
          return m ? m[1] : null;
        }
        parenDepth -= 1;
      } else if (ch === ";" || ch === "{") {
        return null;
      }
    }
  }
  return null;
}

function findMatchingParenOnLine(line, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < line.length; i += 1) {
    if (line[i] === "(") depth += 1;
    else if (line[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Navigation history stack helpers (`<-` Back / `->` Forward).
 */
export function createNavHistoryState(maxEntries = NAV_HISTORY_LIMIT) {
  return {
    entries: [],
    index: -1,
    maxEntries: Math.max(2, Number(maxEntries) || NAV_HISTORY_LIMIT),
  };
}

function sameNavLoc(a, b) {
  if (!a || !b) return false;
  return (
    (a.root || "") === (b.root || "") &&
    (a.path || "") === (b.path || "") &&
    (a.on || null) === (b.on || null) &&
    Number(a.line || 1) === Number(b.line || 1) &&
    Number(a.column || 1) === Number(b.column || 1)
  );
}

function cloneNavEntry(entry) {
  if (!entry || !entry.path) return null;
  return {
    root: entry.root || "",
    path: entry.path || "",
    on: entry.on || null,
    serviceId: entry.serviceId || "",
    serviceName: entry.serviceName || "",
    line: Math.max(1, Number(entry.line) || 1),
    column: Math.max(1, Number(entry.column) || 1),
    symbol: entry.symbol || "",
    label: entry.label || `${entry.path}:${Math.max(1, Number(entry.line) || 1)}`,
  };
}

export function pushNavHistory(state, originEntry, targetEntry) {
  const base = state && Array.isArray(state.entries)
    ? state
    : createNavHistoryState();
  const limit = Math.max(2, base.maxEntries || NAV_HISTORY_LIMIT);
  const origin = cloneNavEntry(originEntry);
  const target = cloneNavEntry(targetEntry);
  if (!target) return base;

  const entries = base.index >= 0
    ? base.entries.slice(0, base.index + 1)
    : [];

  if (origin) {
    const cur = entries.length > 0 ? entries[entries.length - 1] : null;
    if (!cur || !sameNavLoc(cur, origin)) {
      entries.push(origin);
    }
  }

  const last = entries.length > 0 ? entries[entries.length - 1] : null;
  if (!last || !sameNavLoc(last, target)) {
    entries.push(target);
  }

  while (entries.length > limit) {
    entries.shift();
  }

  return {
    entries,
    index: entries.length - 1,
    maxEntries: limit,
  };
}

export function canStepNavBack(state) {
  return Boolean(state && Array.isArray(state.entries) && state.index > 0);
}

export function canStepNavForward(state) {
  return Boolean(state && Array.isArray(state.entries) && state.index >= 0 && state.index + 1 < state.entries.length);
}

export function stepNavBack(state) {
  if (!canStepNavBack(state)) return { state, entry: null };
  const nextIdx = state.index - 1;
  return {
    state: { ...state, index: nextIdx },
    entry: state.entries[nextIdx] || null,
  };
}

export function stepNavForward(state) {
  if (!canStepNavForward(state)) return { state, entry: null };
  const nextIdx = state.index + 1;
  return {
    state: { ...state, index: nextIdx },
    entry: state.entries[nextIdx] || null,
  };
}

export function normalizeNavCandidate(cand, extra = {}) {
  if (!cand || !Number.isFinite(Number(cand.line))) return null;
  return {
    filePath: cand.filePath || extra.filePath || "",
    root: cand.root || extra.root || "",
    on: cand.on !== undefined ? cand.on : (extra.on ?? null),
    serviceId: cand.serviceId || extra.serviceId || "",
    serviceName: cand.serviceName || extra.serviceName || "",
    line: Math.max(1, Math.floor(Number(cand.line))),
    column: Math.max(1, Math.floor(Number(cand.column || 1))),
    name: cand.name || "",
    kind: cand.kind || "variable",
    containerName: cand.containerName || "",
    signature: String(cand.signature || "").trim(),
    isAbstract: Boolean(cand.isAbstract),
    isDefault: Boolean(cand.isDefault),
    isPrivate: Boolean(cand.isPrivate),
    arity: Number.isFinite(cand.arity) ? cand.arity : null,
    lang: cand.lang || extra.lang || "",
    exactScope: Boolean(cand.exactScope),
    score: Number.isFinite(cand.score) ? cand.score : 0,
  };
}

export function dedupeNavCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const seen = new Map();
  for (let i = 0; i < candidates.length; i += 1) {
    const c = normalizeNavCandidate(candidates[i]);
    if (!c) continue;
    const key = `${c.root}|${c.filePath}|${c.line}|${c.column}|${c.name}`;
    const prev = seen.get(key);
    if (!prev || c.score > prev.score) {
      seen.set(key, c);
    }
  }
  return Array.from(seen.values());
}

export function rankNavCandidates(candidates, context = null) {
  const deduped = dedupeNavCandidates(candidates);
  const wantImpl = context?.intent === "implementation";
  const wantArity = Number.isFinite(context?.arity) ? context.arity : null;

  return deduped.sort((a, b) => {
    const aScore = a.score
      + (a.exactScope ? 40 : 0)
      + (wantImpl && !a.isAbstract ? 35 : 0)
      + (wantArity !== null && a.arity === wantArity ? 25 : 0);
    const bScore = b.score
      + (b.exactScope ? 40 : 0)
      + (wantImpl && !b.isAbstract ? 35 : 0)
      + (wantArity !== null && b.arity === wantArity ? 25 : 0);
    if (bScore !== aScore) return bScore - aScore;
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
}

export function isSameNavLocation(cand, line, col) {
  if (!cand) return false;
  return Number(cand.line) === Number(line) && Math.abs(Number(cand.column || 1) - Number(col || 1)) <= 1;
}
