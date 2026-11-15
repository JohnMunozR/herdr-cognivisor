// Pure JavaScript / TypeScript code navigation analyzer and symbol extractor.
// Zero GPUI / herdr / Node stdlib dependencies (runs identically in QuickJS and Node --test).
import {
  splitCodeLinesExpanded,
  maskNonCodeRegions,
  extractNavContext,
  isNavIdentStart,
  isNavIdentPart,
  normalizeNavCandidate,
  rankNavCandidates,
  isSameNavLocation,
  isNavSourceWithinLimits,
} from "./code-nav-logic.js";

const MAX_SIGNATURE_CHARS = 220;
const LINE_COL_STRIDE = 1000000;

const NO_SPACE_BEFORE_SET = new Set([".", ",", ">", ")", "]", "[", "<"]);
const NO_SPACE_AFTER_SET = new Set([".", "<", "(", "["]);
const STOP_COMMA_EQ = new Set([",", "="]);
const STOP_TYPE_EXPR = new Set([";", ",", ")", "]", "}", "as", "satisfies"]);
const STOP_BRACE_COMMA = new Set(["{", ","]);
const STOP_BRACE_SEMI = new Set(["{", ";"]);
const STOP_EQ_SEMI_BRACE = new Set(["=", ";", "}"]);
const STOP_BRACE_ONLY = new Set(["{"]);
const STOP_SEMI_COMMA_BRACE = new Set([";", ",", "}"]);
const STOP_EQ_COMMA_SEMI = new Set(["=", ",", ";"]);
const STOP_FOR_HEADER = new Set(["=", "of", "in", ";"]);
const STOP_CLOSE_PAREN = new Set([")"]);
const BRACKET_CLOSE_MAP = { "(": ")", "[": "]", "{": "}" };

const JS_PRIMITIVES_AND_GLOBALS = new Set([
  "string", "number", "boolean", "void", "any", "unknown", "never", "object",
  "symbol", "bigint", "null", "undefined", "this", "super",
]);

const STATEMENT_START_KEYWORDS = new Set([
  "import", "export", "const", "let", "var", "function", "class", "interface",
  "type", "enum", "return", "if", "else", "for", "while", "do", "switch",
  "case", "default", "try", "catch", "finally", "throw", "break", "continue",
  "debugger", "async", "abstract", "declare", "public", "private", "protected",
  "readonly", "static", "override", "namespace",
]);

const CLASS_MODIFIER_KEYWORDS = new Set([
  "public", "private", "protected", "readonly", "static", "abstract",
  "override", "declare", "async", "accessor",
]);

const OPERATOR_CONT_PREV = new Set([
  "=", "=>", ".", "?.", ",", ":", "+", "-", "*", "/", "%",
  "&&", "||", "??", "?", "&", "|", "^", "<", ">", "<=", ">=",
  "==", "===", "!=", "!==", "return", "await", "yield", "typeof",
  "new", "extends", "implements", "from", "as", "satisfies", "throw",
]);

const OPERATOR_CONT_CURR = new Set([
  ".", "?.", "=>", "?", ":", ",", "&&", "||", "??", "+", "-", "*", "/",
  "|", "&", "as", "satisfies", "extends", "implements", "instanceof", "in",
  "===", "!==", "==", "!=", "<=", ">=",
]);

const NON_ARROW_KEYWORD_IDENT = new Set([
  "return", "throw", "typeof", "await", "yield", "new", "delete", "void",
  "case", "else", "do", "in", "of", "extends", "implements", "as", "satisfies",
]);

const NON_METHOD_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "with", "else",
  "return", "throw", "await", "yield", "delete", "typeof", "new", "try", "finally",
]);

const MEMBER_STOP_SET = new Set([";", ",", "}", ")"]);

function toPos(line, col) {
  return (Number(line) || 0) * LINE_COL_STRIDE + (Number(col) || 0);
}

function isDigitChar(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isNumberPart(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 70) ||
    (c >= 97 && c <= 102) ||
    c === 95 || // _
    c === 120 || c === 88 || // x X
    c === 111 || c === 79 || // o O
    c === 98 || c === 66 || // b B
    c === 110 // n
  );
}

/**
 * Single-pass linear lexer over masked lines plus single-pass bracket matcher.
 */
function matchJsThreeCharPunct(lineText, i) {
  const c0 = lineText[i];
  const c1 = lineText[i + 1];
  const c2 = lineText[i + 2];
  if (c0 === "=" && c1 === "=" && c2 === "=") return "===";
  if (c0 === "!" && c1 === "=" && c2 === "=") return "!==";
  if (c0 === "." && c1 === "." && c2 === ".") return "...";
  return "";
}

function matchJsTwoCharPunct(lineText, i) {
  const c0 = lineText[i];
  const c1 = lineText[i + 1];
  if (c1 === "=") {
    if (c0 === "=") return "==";
    if (c0 === "!") return "!=";
    if (c0 === "<") return "<=";
    if (c0 === ">") return ">=";
    if (c0 === "+") return "+=";
    if (c0 === "-") return "-=";
    if (c0 === "*") return "*=";
    if (c0 === "/") return "/=";
    return "";
  }
  if (c0 === "=" && c1 === ">") return "=>";
  if (c0 === "?" && c1 === ".") return "?.";
  if (c0 === "&" && c1 === "&") return "&&";
  if (c0 === "|" && c1 === "|") return "||";
  if (c0 === "?" && c1 === "?") return "??";
  if (c0 === "+" && c1 === "+") return "++";
  if (c0 === "-" && c1 === "-") return "--";
  return "";
}

function tokenizeMaskedLines(maskedLines) {
  const tokens = [];
  let hasDynamicImport = false;

  for (let li = 0; li < maskedLines.length; li += 1) {
    const lineText = maskedLines[li] || "";
    const len = lineText.length;
    const line1 = li + 1;
    let i = 0;

    while (i < len) {
      const ch = lineText[i];
      if (ch === " " || ch === "\t") {
        i += 1;
        continue;
      }

      if (isNavIdentStart(ch)) {
        const start = i;
        i += 1;
        while (i < len && isNavIdentPart(lineText[i])) i += 1;
        tokens.push({
          type: "ident",
          value: lineText.slice(start, i),
          line: line1,
          col: start + 1,
          endCol: i + 1,
        });
        continue;
      }

      if (isDigitChar(ch)) {
        const start = i;
        i += 1;
        while (i < len) {
          if (isNumberPart(lineText[i])) {
            i += 1;
          } else if (lineText[i] === "." && lineText[i + 1] !== "." && isDigitChar(lineText[i + 1])) {
            i += 1;
          } else {
            break;
          }
        }
        tokens.push({
          type: "number",
          value: lineText.slice(start, i),
          line: line1,
          col: start + 1,
          endCol: i + 1,
        });
        continue;
      }

      if (i + 3 <= len) {
        const three = matchJsThreeCharPunct(lineText, i);
        if (three) {
          tokens.push({
            type: "punct",
            value: three,
            line: line1,
            col: i + 1,
            endCol: i + 4,
          });
          i += 3;
          continue;
        }
      }

      if (i + 2 <= len) {
        const two = matchJsTwoCharPunct(lineText, i);
        if (two) {
          tokens.push({
            type: "punct",
            value: two,
            line: line1,
            col: i + 1,
            endCol: i + 3,
          });
          i += 2;
          continue;
        }
      }

      if (ch === "(" && !hasDynamicImport && tokens.length > 0) {
        const prevTok = tokens[tokens.length - 1];
        if (prevTok.type === "ident" && prevTok.value === "import") {
          hasDynamicImport = true;
        }
      }

      tokens.push({
        type: "punct",
        value: ch,
        line: line1,
        col: i + 1,
        endCol: i + 2,
      });
      i += 1;
    }
  }

  const pairIndex = new Int32Array(tokens.length);
  pairIndex.fill(-1);
  const stack = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const v = tokens[i].value;
    if (v === "(" || v === "[" || v === "{") {
      stack.push(i);
    } else if (v === ")" || v === "]" || v === "}") {
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        const openIdx = stack[s];
        if (BRACKET_CLOSE_MAP[tokens[openIdx].value] === v) {
          stack.length = s;
          pairIndex[openIdx] = i;
          pairIndex[i] = openIdx;
          break;
        }
      }
    }
  }

  return { tokens, pairIndex, hasDynamicImport };
}

function buildSignature(rawLines, startLine, startCol, endLine, endCol) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) return "";
  const l0 = Math.max(0, Math.min(rawLines.length - 1, startLine - 1));
  const l1 = Math.max(l0, Math.min(rawLines.length - 1, endLine - 1));
  const maxLines = Math.min(l1, l0 + 8);
  const parts = [];
  for (let li = l0; li <= maxLines; li += 1) {
    const line = rawLines[li] || "";
    const fromC = li === l0 ? Math.max(0, startCol - 1) : 0;
    const toC = li === l1 ? Math.max(fromC, endCol - 1) : line.length;
    const slice = line.slice(fromC, toC).trim();
    if (slice) parts.push(slice);
  }
  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length <= MAX_SIGNATURE_CHARS) return joined;
  return joined.slice(0, MAX_SIGNATURE_CHARS - 3).trimEnd() + "...";
}

function extractQuotedStringInSpan(rawLines, startLine, startCol, endLine, endCol) {
  const l0 = Math.max(0, startLine - 1);
  const l1 = Math.min(rawLines.length - 1, endLine - 1);
  for (let li = l0; li <= l1; li += 1) {
    const raw = rawLines[li] || "";
    const minC = li === l0 ? Math.max(0, startCol - 1) : 0;
    const maxC = li === l1 ? Math.min(raw.length, Math.max(0, endCol - 1)) : raw.length;
    let i = minC;
    while (i < maxC) {
      const ch = raw[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const qStart = i;
        i += 1;
        let escaped = false;
        while (i < raw.length) {
          if (escaped) {
            escaped = false;
            i += 1;
            continue;
          }
          if (raw[i] === "\\") {
            escaped = true;
            i += 1;
            continue;
          }
          if (raw[i] === ch) {
            return {
              text: raw.slice(qStart + 1, i),
              line: li + 1,
              startCol: qStart + 2,
              endCol: i + 1,
            };
          }
          i += 1;
        }
        break;
      }
      i += 1;
    }
  }
  return null;
}

function isAsiBreak(tokens, idx, limitEnd, options = {}) {
  if (idx >= limitEnd) return true;
  const curr = tokens[idx];
  if (!curr || curr.value === ";" || curr.value === "}") return true;
  if (idx <= 0) return false;
  const prev = tokens[idx - 1];
  if (!prev || curr.line <= prev.line) return false;

  if (OPERATOR_CONT_PREV.has(prev.value)) return false;
  if (options.allowVerticalBars && (prev.value === "|" || prev.value === "&" || curr.value === "|" || curr.value === "&")) {
    return false;
  }
  if (OPERATOR_CONT_CURR.has(curr.value)) return false;
  if (curr.value === "(" && options.allowCallCont !== false) return false;
  if (curr.value === "[" && options.allowBracketCont !== false) return false;
  return true;
}

function findMatchingAngle(tokens, pairIndex, openIdx, limitEnd) {
  if (openIdx >= limitEnd || tokens[openIdx].value !== "<") return -1;
  const maxIdx = Math.min(limitEnd, openIdx + 128);
  let depth = 0;
  for (let i = openIdx; i < maxIdx; i += 1) {
    const v = tokens[i].value;
    if (v === "(" || v === "[" || v === "{") {
      const close = pairIndex[i];
      if (close > i && close < limitEnd) {
        i = close;
        continue;
      }
      return -1;
    }
    if (v === "<") {
      depth += 1;
    } else if (v === ">") {
      depth -= 1;
      if (depth === 0) return i;
    } else if (v === ";" || v === "}" || v === ")" || v === "]") {
      return -1;
    }
  }
  return -1;
}

function formatTypeTokens(tokens, startIdx, endIdx) {
  if (startIdx >= endIdx) return "";
  let out = "";
  let prevVal = "";
  for (let i = startIdx; i < endIdx; i += 1) {
    const v = tokens[i].value;
    if (out) {
      if (v === "<" && prevVal && isNavIdentPart(prevVal[prevVal.length - 1])) {
        // attach directly: Map<...
      } else if (NO_SPACE_BEFORE_SET.has(v) || NO_SPACE_AFTER_SET.has(prevVal)) {
        // no space
      } else if (v === "|" || v === "&" || v === "=>" || prevVal === "|" || prevVal === "&" || prevVal === "=>" || prevVal === "," || prevVal === ":") {
        out += " ";
      } else {
        out += " ";
      }
    }
    out += v;
    prevVal = v;
  }
  return out.trim();
}

function readTypeAnnotation(tokens, pairIndex, startIdx, limitEnd, stopValues = MEMBER_STOP_SET, options = {}) {
  let i = startIdx;
  const maxStep = Math.min(limitEnd, startIdx + 160);
  while (i < maxStep) {
    const tok = tokens[i];
    if (i > startIdx && isAsiBreak(tokens, i, limitEnd, { allowCallCont: false, allowBracketCont: false, allowVerticalBars: Boolean(options.allowVerticalBars) })) {
      break;
    }
    const v = tok.value;
    if (stopValues.has(v)) break;
    if (v === "=" && tokens[i + 1]?.value !== ">") break;
    if (v === "{" && options.stopOnBrace) break;
    if (v === "(" || v === "[" || v === "{") {
      const close = pairIndex[i];
      if (close > i && close < limitEnd) {
        i = close + 1;
        continue;
      }
      break;
    }
    if (v === "<") {
      const closeAngle = findMatchingAngle(tokens, pairIndex, i, limitEnd);
      if (closeAngle > i) {
        i = closeAngle + 1;
        continue;
      }
    }
    i += 1;
  }
  return {
    typeText: formatTypeTokens(tokens, startIdx, i) || null,
    endIdx: i,
  };
}

function splitTopLevelTypeList(typeStr, sepChar) {
  if (!typeStr) return [];
  const parts = [];
  let depthAngle = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let start = 0;
  for (let i = 0; i < typeStr.length; i += 1) {
    const ch = typeStr[i];
    if (ch === "<") depthAngle += 1;
    else if (ch === ">" && depthAngle > 0 && typeStr[i - 1] !== "=") depthAngle -= 1;
    else if (ch === "(") depthParen += 1;
    else if (ch === ")" && depthParen > 0) depthParen -= 1;
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]" && depthBracket > 0) depthBracket -= 1;
    else if (ch === "{") depthBrace += 1;
    else if (ch === "}" && depthBrace > 0) depthBrace -= 1;
    else if (ch === sepChar && depthAngle === 0 && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      parts.push(typeStr.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(typeStr.slice(start).trim());
  return parts.filter(Boolean);
}

function extractPrimaryTypeNames(typeStr, isAwaited = false) {
  if (!typeStr) return [];
  const raw = String(typeStr).trim();
  if (!raw) return [];

  let candidate = raw;
  if (isAwaited) {
    const parts = splitTopLevelTypeList(raw, "|");
    const unwrapped = [];
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i].trim();
      if (p.startsWith("Promise<") && p.endsWith(">")) {
        unwrapped.push(p.slice(8, -1).trim());
      } else {
        unwrapped.push(p);
      }
    }
    candidate = unwrapped.join(" | ");
  }

  const unions = splitTopLevelTypeList(candidate, "|");
  const out = [];
  const seen = new Set();

  for (let u = 0; u < unions.length; u += 1) {
    const parts = splitTopLevelTypeList(unions[u], "&");
    for (let p = 0; p < parts.length; p += 1) {
      let piece = parts[p].trim();
      if (!piece) continue;
      if (piece.startsWith("readonly ")) piece = piece.slice(9).trim();
      if (piece.endsWith("[]")) continue;
      if (piece.startsWith("(") || piece.startsWith("{") || piece.startsWith("[")) continue;
      const anglePos = piece.indexOf("<");
      if (anglePos > 0) piece = piece.slice(0, anglePos).trim();
      if (!piece || JS_PRIMITIVES_AND_GLOBALS.has(piece)) continue;
      const dotPos = piece.lastIndexOf(".");
      const baseIdent = dotPos >= 0 ? piece.slice(dotPos + 1) : piece;
      if (!baseIdent || !isNavIdentStart(baseIdent[0])) continue;
      if (!seen.has(piece)) {
        seen.add(piece);
        out.push(piece);
      }
    }
  }

  return out;
}

function readTypeIdentifierChain(tokens, pairIndex, startIdx, limitEnd) {
  let i = startIdx;
  if (i >= limitEnd || tokens[i].type !== "ident") return { name: "", endIdx: startIdx };
  let name = tokens[i].value;
  i += 1;
  while (i + 1 < limitEnd && tokens[i].value === "." && tokens[i + 1].type === "ident") {
    name += "." + tokens[i + 1].value;
    i += 2;
  }
  if (i < limitEnd && tokens[i].value === "<") {
    const closeAngle = findMatchingAngle(tokens, pairIndex, i, limitEnd);
    if (closeAngle > i) i = closeAngle + 1;
  }
  return { name, endIdx: i };
}

/**
 * Check if `(` at `openParenIdx` starts an arrow function `(params) [: ReturnType] => ...`.
 */
function detectArrowHeader(tokens, pairIndex, openParenIdx, limitEnd) {
  if (openParenIdx >= limitEnd || tokens[openParenIdx].value !== "(") return null;
  const closeParen = pairIndex[openParenIdx];
  if (closeParen < openParenIdx || closeParen >= limitEnd) return null;

  let after = closeParen + 1;
  if (after < limitEnd && tokens[after].value === "=>") {
    return { closeParen, returnType: null, arrowIdx: after };
  }
  if (after < limitEnd && tokens[after].value === ":") {
    const typeStart = after + 1;
    let scan = typeStart;
    const maxScan = Math.min(limitEnd, typeStart + 40);
    while (scan < maxScan) {
      const v = tokens[scan].value;
      if (v === "=>") {
        return {
          closeParen,
          returnType: formatTypeTokens(tokens, typeStart, scan) || null,
          arrowIdx: scan,
        };
      }
      if (v === ";" || v === "}" || v === ")" || v === "," || v === "=") return null;
      if (v === "(" || v === "[" || v === "{") {
        const close = pairIndex[scan];
        if (close > scan && close < limitEnd) {
          scan = close + 1;
          continue;
        }
        return null;
      }
      if (v === "<") {
        const closeA = findMatchingAngle(tokens, pairIndex, scan, limitEnd);
        if (closeA > scan) {
          scan = closeA + 1;
          continue;
        }
      }
      scan += 1;
    }
  }
  return null;
}

/**
 * Extract bound variable names from identifier, object destructuring `{ a, b: c = d }`,
 * or array destructuring `[a, , ...rest]`.
 */
function extractBindingPattern(tokens, pairIndex, startIdx, limitEnd) {
  const names = [];
  const defaultExprSpans = [];

  function walkPattern(idx, end) {
    if (idx >= end) return idx;
    const tok = tokens[idx];
    if (tok.value === "...") {
      return walkPattern(idx + 1, end);
    }
    if (tok.type === "ident") {
      names.push({
        name: tok.value,
        propName: tok.value,
        line: tok.line,
        col: tok.col,
        endCol: tok.endCol,
        declaredType: null,
      });
      return idx + 1;
    }
    if (tok.value === "{") {
      const close = pairIndex[idx];
      if (close < idx || close >= end) return idx + 1;
      let i = idx + 1;
      while (i < close) {
        if (tokens[i].value === ",") {
          i += 1;
          continue;
        }
        if (tokens[i].value === "...") {
          i += 1;
          if (i < close && tokens[i].type === "ident") {
            const t = tokens[i];
            names.push({
              name: t.value,
              propName: t.value,
              line: t.line,
              col: t.col,
              endCol: t.endCol,
              declaredType: null,
            });
            i += 1;
          }
          continue;
        }
        let propName = null;
        if (tokens[i].value === "[") {
          const closeBr = pairIndex[i];
          if (closeBr > i && closeBr < close) i = closeBr + 1;
          else i += 1;
        } else if (tokens[i].type === "ident" || tokens[i].type === "number") {
          propName = tokens[i].value;
          const keyTok = tokens[i];
          i += 1;
          if (i < close && tokens[i].value === ":") {
            i += 1;
            const beforeCount = names.length;
            i = walkPattern(i, close);
            if (names.length === beforeCount + 1 && propName) {
              names[beforeCount].propName = propName;
            }
          } else if (keyTok.type === "ident") {
            names.push({
              name: keyTok.value,
              propName: keyTok.value,
              line: keyTok.line,
              col: keyTok.col,
              endCol: keyTok.endCol,
              declaredType: null,
            });
          }
        } else {
          if (i < close && tokens[i].value === ":") {
            i += 1;
            i = walkPattern(i, close);
          } else {
            i += 1;
          }
        }
        if (i < close && tokens[i].value === "=") {
          const defStart = i + 1;
          i = skipDestructuringDefault(tokens, pairIndex, defStart, close);
          if (i > defStart) defaultExprSpans.push([defStart, i]);
        }
        while (i < close && tokens[i].value !== ",") i += 1;
        if (i < close && tokens[i].value === ",") i += 1;
      }
      return close + 1;
    }
    if (tok.value === "[") {
      const close = pairIndex[idx];
      if (close < idx || close >= end) return idx + 1;
      let i = idx + 1;
      while (i < close) {
        if (tokens[i].value === ",") {
          i += 1;
          continue;
        }
        i = walkPattern(i, close);
        if (i < close && tokens[i].value === "=") {
          const defStart = i + 1;
          i = skipDestructuringDefault(tokens, pairIndex, defStart, close);
          if (i > defStart) defaultExprSpans.push([defStart, i]);
        }
        while (i < close && tokens[i].value !== ",") i += 1;
        if (i < close && tokens[i].value === ",") i += 1;
      }
      return close + 1;
    }
    return idx + 1;
  }

  const endIdx = walkPattern(startIdx, limitEnd);
  return { names, defaultExprSpans, endIdx };
}

function skipDestructuringDefault(tokens, pairIndex, startIdx, limitEnd) {
  let i = startIdx;
  while (i < limitEnd) {
    const v = tokens[i].value;
    if (v === ",") break;
    if (v === "(" || v === "[" || v === "{") {
      const close = pairIndex[i];
      if (close > i && close < limitEnd) {
        i = close + 1;
        continue;
      }
      break;
    }
    i += 1;
  }
  return i;
}

/**
 * Parse `(param1, param2: Type = def, ...rest)` and compute arity.
 */
function parseParamList(tokens, pairIndex, openParenIdx, limitEnd) {
  const closeParen = pairIndex[openParenIdx];
  if (closeParen < openParenIdx || closeParen >= limitEnd) {
    return { params: [], arity: 0, minArity: 0, hasRest: false, paramProps: [], defaultExprSpans: [], endIdx: openParenIdx + 1 };
  }

  const params = [];
  const paramProps = [];
  const defaultExprSpans = [];
  let arity = 0;
  let minArity = 0;
  let hasRest = false;

  let i = openParenIdx + 1;
  while (i < closeParen) {
    while (i < closeParen && tokens[i].value === ",") i += 1;
    if (i >= closeParen) break;

    // Skip parameter decorators `@Dec(...)`
    while (i < closeParen && tokens[i].value === "@") {
      i += 1;
      while (i < closeParen && (tokens[i].type === "ident" || tokens[i].value === ".")) i += 1;
      if (i < closeParen && tokens[i].value === "(") {
        const c = pairIndex[i];
        if (c > i && c < closeParen) i = c + 1;
      }
    }
    if (i >= closeParen) break;

    // TS parameter properties (`public`/`private`/`protected`/`readonly`/`override`)
    let isParamProp = false;
    while (i < closeParen && (tokens[i].value === "public" || tokens[i].value === "private" || tokens[i].value === "protected" || tokens[i].value === "readonly" || tokens[i].value === "override")) {
      // Only treat as modifier if followed by another ident / pattern / ...
      if (i + 1 < closeParen && (tokens[i + 1].type === "ident" || tokens[i + 1].value === "{" || tokens[i + 1].value === "[" || tokens[i + 1].value === "...")) {
        isParamProp = true;
        i += 1;
      } else {
        break;
      }
    }

    // TS `this: Type` pseudo-parameter does not contribute to call arity
    if (tokens[i].value === "this" && (tokens[i + 1]?.value === ":" || tokens[i + 1]?.value === "," || i + 1 === closeParen)) {
      while (i < closeParen) {
        const v = tokens[i].value;
        if (v === ",") break;
        if (v === "(" || v === "[" || v === "{") {
          const c = pairIndex[i];
          if (c > i && c < closeParen) { i = c + 1; continue; }
        }
        i += 1;
      }
      continue;
    }

    let isRestParam = false;
    if (tokens[i].value === "...") {
      isRestParam = true;
      hasRest = true;
      i += 1;
    }

    const pat = extractBindingPattern(tokens, pairIndex, i, closeParen);
    for (let s = 0; s < pat.defaultExprSpans.length; s += 1) {
      defaultExprSpans.push(pat.defaultExprSpans[s]);
    }
    i = pat.endIdx;

    let isOptional = isRestParam;
    if (i < closeParen && tokens[i].value === "?") {
      isOptional = true;
      i += 1;
    }

    let declaredType = null;
    if (i < closeParen && tokens[i].value === ":") {
      const typeRes = readTypeAnnotation(tokens, pairIndex, i + 1, closeParen, STOP_COMMA_EQ);
      declaredType = typeRes.typeText;
      i = typeRes.endIdx;
    }

    if (i < closeParen && tokens[i].value === "=") {
      isOptional = true;
      const defStart = i + 1;
      i = skipDestructuringDefault(tokens, pairIndex, defStart, closeParen);
      if (i > defStart) defaultExprSpans.push([defStart, i]);
    }

    // Advance to comma if trailing tokens remain
    while (i < closeParen && tokens[i].value !== ",") {
      const v = tokens[i].value;
      if (v === "(" || v === "[" || v === "{") {
        const c = pairIndex[i];
        if (c > i && c < closeParen) { i = c + 1; continue; }
      }
      i += 1;
    }

    arity += 1;
    if (!isOptional) minArity += 1;

    const isDirectIdent = pat.names.length === 1 && tokens[pat.endIdx - 1]?.type === "ident";
    for (let n = 0; n < pat.names.length; n += 1) {
      const item = pat.names[n];
      const paramType = isDirectIdent ? declaredType : null;
      params.push({
        ...item,
        declaredType: paramType,
        parentPatternType: !isDirectIdent ? declaredType : null,
      });
      if (isParamProp && isDirectIdent) {
        paramProps.push({
          name: item.name,
          typeName: paramType,
          line: item.line,
          col: item.col,
        });
      }
    }
  }

  return {
    params,
    arity,
    minArity,
    hasRest,
    paramProps,
    defaultExprSpans,
    endIdx: closeParen + 1,
  };
}

/**
 * Parse full JS/TS source into symbol summary, scope tree, type registry, and statement ranges.
 */
function parseJsModule(sourceText, filePath = "", options = {}) {
  const summaryOnly = Boolean(options?.summaryOnly);
  const lines = Array.isArray(options?.lines) ? options.lines : splitCodeLinesExpanded(sourceText);
  const maskedLines = Array.isArray(options?.maskedLines) ? options.maskedLines : maskNonCodeRegions(lines, "js");
  const { tokens, pairIndex, hasDynamicImport } = tokenizeMaskedLines(maskedLines);
  const skipBodiesForSummary = summaryOnly && !hasDynamicImport;

  const imports = [];
  const exportsList = [];
  const reExports = [];
  const types = [];
  const functions = [];
  const topVariables = [];

  const typeModels = new Map(); // name -> TypeModel[] (supports declaration merging)
  const importStatements = []; // { startPos, endPos, specRange, entries, isRequire }
  const reExportStatements = []; // { startPos, endPos, specRange, entries }
  let nextScopeId = 1;

  const endLine = Math.max(1, lines.length);
  const endCol = (lines[endLine - 1]?.length || 0) + 1;

  const rootScope = {
    id: nextScopeId++,
    kind: "module",
    name: null,
    parent: null,
    startPos: toPos(1, 1),
    endPos: toPos(endLine, endCol),
    bindings: new Map(),
    children: [],
    ownerType: null,
  };

  function createScope(kind, name, parent, startLine, startCol, sEndLine, sEndCol, ownerType = null) {
    const scope = {
      id: nextScopeId++,
      kind,
      name: name || null,
      parent,
      startPos: toPos(startLine, startCol),
      endPos: toPos(sEndLine, sEndCol),
      bindings: new Map(),
      children: [],
      ownerType,
    };
    if (parent) parent.children.push(scope);
    return scope;
  }

  function findHoistScope(scope) {
    let cur = scope;
    while (cur && cur.parent) {
      if (cur.kind === "function" || cur.kind === "method" || cur.kind === "constructor" || cur.kind === "arrow" || cur.kind === "module") {
        return cur;
      }
      cur = cur.parent;
    }
    return rootScope;
  }

  function addBinding(scope, name, binding, hoistToFunc = false) {
    if (!name || !scope) return;
    const targetScope = hoistToFunc ? findHoistScope(scope) : scope;
    let list = targetScope.bindings.get(name);
    if (!list) {
      list = [];
      targetScope.bindings.set(name, list);
    }
    list.push(binding);
  }

  function registerTypeModel(model) {
    types.push(model);
    let list = typeModels.get(model.name);
    if (!list) {
      list = [];
      typeModels.set(model.name, list);
    }
    list.push(model);
  }

  function inferExprType(startIdx, endIdx, scope) {
    if (startIdx >= endIdx) return { typeName: null, isAwaited: false, callName: null, inlineMembers: null };
    let i = startIdx;
    let isAwaited = false;
    while (i < endIdx && tokens[i].value === "(") {
      const c = pairIndex[i];
      if (c === endIdx - 1) {
        i += 1;
        endIdx -= 1;
      } else {
        break;
      }
    }
    if (i < endIdx && tokens[i].value === "await") {
      isAwaited = true;
      i += 1;
    }

    // Check trailing `as Type` or `satisfies Type` at depth 0
    for (let k = i; k < endIdx; k += 1) {
      const v = tokens[k].value;
      if (v === "(" || v === "[" || v === "{") {
        const c = pairIndex[k];
        if (c > k && c < endIdx) { k = c; continue; }
      }
      if ((v === "as" || v === "satisfies") && k + 1 < endIdx) {
        const typeRes = readTypeAnnotation(tokens, pairIndex, k + 1, endIdx, STOP_TYPE_EXPR);
        if (typeRes.typeText && typeRes.typeText !== "const") {
          const primary = extractPrimaryTypeNames(typeRes.typeText, false);
          return {
            typeName: primary[0] || typeRes.typeText,
            isAwaited,
            callName: null,
            inlineMembers: null,
          };
        }
      }
    }

    if (i < endIdx && tokens[i].value === "new" && i + 1 < endIdx && tokens[i + 1].type === "ident") {
      const chain = readTypeIdentifierChain(tokens, pairIndex, i + 1, endIdx);
      const short = chain.name.includes(".") ? chain.name.slice(chain.name.lastIndexOf(".") + 1) : chain.name;
      return { typeName: short || chain.name, isAwaited: false, callName: null, inlineMembers: null };
    }

    // Direct call `foo(...)` or `this.foo(...)` or `svc.foo(...)`
    if (i < endIdx && (tokens[i].type === "ident" || tokens[i].value === "this")) {
      let c = i;
      const parts = [tokens[c].value];
      c += 1;
      while (c + 1 < endIdx && (tokens[c].value === "." || tokens[c].value === "?.") && tokens[c + 1].type === "ident") {
        parts.push(tokens[c + 1].value);
        c += 2;
      }
      if (c < endIdx && tokens[c].value === "<") {
        const closeA = findMatchingAngle(tokens, pairIndex, c, endIdx);
        if (closeA > c) c = closeA + 1;
      }
      if (c < endIdx && tokens[c].value === "(") {
        return { typeName: null, isAwaited, callChain: parts, inlineMembers: null };
      }
      if (c === endIdx) {
        return { typeName: null, isAwaited, refChain: parts, inlineMembers: null };
      }
    }

    return { typeName: null, isAwaited, callChain: null, inlineMembers: null };
  }

  function scanExpressionForScopes(startIdx, endIdx, scope) {
    if (skipBodiesForSummary) return;
    let i = startIdx;
    while (i < endIdx) {
      const tok = tokens[i];
      const v = tok.value;

      // Dynamic `import("...")`
      if (v === "import" && tokens[i + 1]?.value === "(") {
        const closeP = pairIndex[i + 1];
        if (closeP > i + 1 && closeP < endIdx) {
          const str = extractQuotedStringInSpan(
            lines,
            tokens[i + 1].line,
            tokens[i + 1].endCol,
            tokens[closeP].line,
            tokens[closeP].col
          );
          if (str && str.text) {
            const impEntry = {
              localName: "",
              importedName: null,
              specifier: str.text,
              isDefault: false,
              isNamespace: false,
              isTypeOnly: false,
              isRequire: false,
              line: str.line,
              column: str.startCol,
            };
            imports.push(impEntry);
            importStatements.push({
              startPos: toPos(tok.line, tok.col),
              endPos: toPos(tokens[closeP].line, tokens[closeP].endCol),
              specRange: { line: str.line, startCol: str.startCol, endCol: str.endCol },
              entries: [{ entry: impEntry, localTok: null, importedTok: null }],
              isRequire: false,
            });
          }
        }
      }

      // Function expression `function [name](...) { ... }`
      if ((v === "async" && tokens[i + 1]?.value === "function") || v === "function") {
        const res = parseFunctionEntity(i, endIdx, scope, { isExported: false, isStatement: false });
        if (res.consumed > i) {
          i = res.consumed;
          continue;
        }
      }

      // Class expression `class [Name] ... { ... }`
      if (v === "class" && i + 1 < endIdx && (tokens[i + 1].value === "{" || tokens[i + 1].type === "ident" || tokens[i + 1].value === "extends")) {
        const res = parseClassEntity(i, endIdx, scope, { isExported: false, isAbstract: false, annotations: [], isStatement: false });
        if (res.consumed > i) {
          i = res.consumed;
          continue;
        }
      }

      // Arrow function: `[async] (<T>)?(...) [: R] => ...` or `[async] ident => ...`
      const isAsyncArrow = v === "async" && i + 1 < endIdx && (tokens[i + 1].value === "(" || tokens[i + 1].value === "<" || tokens[i + 1].type === "ident");
      const arrowStartTok = tok;
      let arrowHeadIdx = isAsyncArrow ? i + 1 : i;

      // Single unparenthesized param `x => ...`
      if (
        tokens[arrowHeadIdx]?.type === "ident" &&
        !NON_ARROW_KEYWORD_IDENT.has(tokens[arrowHeadIdx].value) &&
        tokens[arrowHeadIdx + 1]?.value === "=>"
      ) {
        const pTok = tokens[arrowHeadIdx];
        const arrowIdx = arrowHeadIdx + 1;
        const bodyEnd = findArrowBodyEnd(arrowIdx + 1, endIdx);
        const bodyEndTok = tokens[Math.max(arrowIdx + 1, bodyEnd - 1)] || pTok;
        const arrowScope = createScope("arrow", null, scope, arrowStartTok.line, arrowStartTok.col, bodyEndTok.line, bodyEndTok.endCol);
        addBinding(arrowScope, pTok.value, {
          name: pTok.value,
          kind: "parameter",
          line: pTok.line,
          column: pTok.col,
          signature: pTok.value,
          declaredType: null,
          initializerType: null,
          isFunction: false,
        });
        i = parseArrowBody(arrowIdx + 1, bodyEnd, arrowScope);
        continue;
      }

      // Generic `<T>(...) =>` or `(...) [: R] =>`
      let parenIdx = -1;
      if (tokens[arrowHeadIdx]?.value === "<") {
        const closeA = findMatchingAngle(tokens, pairIndex, arrowHeadIdx, endIdx);
        if (closeA > arrowHeadIdx && tokens[closeA + 1]?.value === "(") {
          parenIdx = closeA + 1;
        }
      } else if (tokens[arrowHeadIdx]?.value === "(") {
        parenIdx = arrowHeadIdx;
      }

      if (parenIdx >= 0) {
        const arrowHeader = detectArrowHeader(tokens, pairIndex, parenIdx, endIdx);
        if (arrowHeader) {
          const parsedParams = parseParamList(tokens, pairIndex, parenIdx, endIdx);
          const bodyStart = arrowHeader.arrowIdx + 1;
          const bodyEnd = findArrowBodyEnd(bodyStart, endIdx);
          const bodyEndTok = tokens[Math.max(bodyStart, bodyEnd - 1)] || tokens[arrowHeader.arrowIdx];
          const arrowScope = createScope("arrow", null, scope, arrowStartTok.line, arrowStartTok.col, bodyEndTok.line, bodyEndTok.endCol);
          for (let d = 0; d < parsedParams.defaultExprSpans.length; d += 1) {
            const [ds, de] = parsedParams.defaultExprSpans[d];
            scanExpressionForScopes(ds, de, arrowScope);
          }
          for (let p = 0; p < parsedParams.params.length; p += 1) {
            const pr = parsedParams.params[p];
            addBinding(arrowScope, pr.name, {
              name: pr.name,
              kind: "parameter",
              line: pr.line,
              column: pr.col,
              signature: pr.declaredType ? `${pr.name}: ${pr.declaredType}` : pr.name,
              declaredType: pr.declaredType,
              parentPatternType: pr.parentPatternType,
              initializerType: null,
              isFunction: false,
            });
          }
          i = parseArrowBody(bodyStart, bodyEnd, arrowScope);
          continue;
        }
      }

      // Object literal expression `{ prop: val, method(a) {} }`
      if (v === "{") {
        const closeB = pairIndex[i];
        if (closeB > i && closeB <= endIdx) {
          parseObjectLiteralMembers(i, closeB, scope);
          i = closeB + 1;
          continue;
        }
      }

      i += 1;
    }
  }

  function findArrowBodyEnd(bodyStartIdx, limitEnd) {
    if (bodyStartIdx >= limitEnd) return limitEnd;
    if (tokens[bodyStartIdx].value === "{") {
      const close = pairIndex[bodyStartIdx];
      if (close > bodyStartIdx && close < limitEnd) return close + 1;
    }
    let i = bodyStartIdx;
    while (i < limitEnd) {
      const v = tokens[i].value;
      if (v === ";" || v === "," || v === ")" || v === "]" || v === "}") break;
      if (i > bodyStartIdx && isAsiBreak(tokens, i, limitEnd)) break;
      if (v === "(" || v === "[" || v === "{") {
        const close = pairIndex[i];
        if (close > i && close < limitEnd) {
          i = close + 1;
          continue;
        }
        break;
      }
      i += 1;
    }
    return i;
  }

  function parseArrowBody(bodyStartIdx, bodyEndIdx, arrowScope) {
    if (bodyStartIdx < bodyEndIdx && tokens[bodyStartIdx].value === "{") {
      const close = pairIndex[bodyStartIdx];
      if (close > bodyStartIdx && close <= bodyEndIdx) {
        parseBlockStatements(bodyStartIdx + 1, close, arrowScope);
        return close + 1;
      }
    }
    scanExpressionForScopes(bodyStartIdx, bodyEndIdx, arrowScope);
    return bodyEndIdx;
  }

  function parseObjectLiteralMembers(openBraceIdx, closeBraceIdx, scope) {
    const members = new Map();
    let i = openBraceIdx + 1;
    while (i < closeBraceIdx) {
      if (tokens[i].value === ",") {
        i += 1;
        continue;
      }
      if (tokens[i].value === "...") {
        i += 1;
        const valEnd = skipObjectPropertyValue(i, closeBraceIdx);
        scanExpressionForScopes(i, valEnd, scope);
        i = valEnd;
        continue;
      }

      let isAsync = false;
      let kind = "field";
      if (tokens[i].value === "async" && i + 1 < closeBraceIdx && tokens[i + 1].value !== ":" && tokens[i + 1].value !== "," && tokens[i + 1].value !== "(") {
        isAsync = true;
        i += 1;
      }
      if ((tokens[i].value === "get" || tokens[i].value === "set") && i + 1 < closeBraceIdx && (tokens[i + 1].type === "ident" || tokens[i + 1].value === "[")) {
        kind = tokens[i].value === "get" ? "getter" : "setter";
        i += 1;
      }
      if (tokens[i]?.value === "*") {
        i += 1;
      }
      if (i >= closeBraceIdx) break;

      let keyName = null;
      let keyTok = null;
      if (tokens[i].value === "[") {
        const closeBr = pairIndex[i];
        if (closeBr > i && closeBr < closeBraceIdx) {
          scanExpressionForScopes(i + 1, closeBr, scope);
          i = closeBr + 1;
        } else {
          i += 1;
        }
      } else if (tokens[i].type === "ident" || tokens[i].type === "number") {
        keyTok = tokens[i];
        keyName = keyTok.value;
        i += 1;
      }

      // Object method shorthand `foo(a, b) { ... }`
      if (i < closeBraceIdx && (tokens[i].value === "(" || tokens[i].value === "<")) {
        let parenIdx = i;
        if (tokens[i].value === "<") {
          const closeA = findMatchingAngle(tokens, pairIndex, i, closeBraceIdx);
          if (closeA > i) parenIdx = closeA + 1;
        }
        if (parenIdx < closeBraceIdx && tokens[parenIdx].value === "(") {
          const parsedParams = parseParamList(tokens, pairIndex, parenIdx, closeBraceIdx);
          let bodyIdx = parsedParams.endIdx;
          let returnType = null;
          if (bodyIdx < closeBraceIdx && tokens[bodyIdx].value === ":") {
            const tr = readTypeAnnotation(tokens, pairIndex, bodyIdx + 1, closeBraceIdx, STOP_BRACE_COMMA, { stopOnBrace: true });
            returnType = tr.typeText;
            bodyIdx = tr.endIdx;
          }
          if (bodyIdx < closeBraceIdx && tokens[bodyIdx].value === "{") {
            const closeM = pairIndex[bodyIdx];
            if (closeM > bodyIdx && closeM <= closeBraceIdx) {
              const mScope = createScope(
                "method",
                keyName || null,
                scope,
                (keyTok || tokens[parenIdx]).line,
                (keyTok || tokens[parenIdx]).col,
                tokens[closeM].line,
                tokens[closeM].endCol
              );
              for (let d = 0; d < parsedParams.defaultExprSpans.length; d += 1) {
                const [ds, de] = parsedParams.defaultExprSpans[d];
                scanExpressionForScopes(ds, de, mScope);
              }
              for (let p = 0; p < parsedParams.params.length; p += 1) {
                const pr = parsedParams.params[p];
                addBinding(mScope, pr.name, {
                  name: pr.name,
                  kind: "parameter",
                  line: pr.line,
                  column: pr.col,
                  signature: pr.declaredType ? `${pr.name}: ${pr.declaredType}` : pr.name,
                  declaredType: pr.declaredType,
                  parentPatternType: pr.parentPatternType,
                  initializerType: null,
                  isFunction: false,
                });
              }
              parseBlockStatements(bodyIdx + 1, closeM, mScope);
              if (keyName && keyTok) {
                members.set(keyName, {
                  name: keyName,
                  kind: kind === "field" ? "method" : kind,
                  line: keyTok.line,
                  column: keyTok.col,
                  arity: parsedParams.arity,
                  isAsync,
                  returnType,
                  signature: buildSignature(lines, keyTok.line, keyTok.col, tokens[bodyIdx].line, tokens[bodyIdx].col),
                });
              }
              i = closeM + 1;
              continue;
            }
          }
        }
      }

      if (i < closeBraceIdx && tokens[i].value === ":") {
        const valStart = i + 1;
        const valEnd = skipObjectPropertyValue(valStart, closeBraceIdx);
        if (keyName && keyTok) {
          const inf = inferExprType(valStart, valEnd, scope);
          members.set(keyName, {
            name: keyName,
            kind: "field",
            line: keyTok.line,
            column: keyTok.col,
            typeName: inf.typeName || null,
            signature: buildSignature(lines, keyTok.line, keyTok.col, tokens[Math.max(valStart, valEnd - 1)].line, tokens[Math.max(valStart, valEnd - 1)].endCol),
          });
        }
        scanExpressionForScopes(valStart, valEnd, scope);
        i = valEnd;
        continue;
      }

      // Shorthand `{ a, b }`
      if (keyName && keyTok) {
        members.set(keyName, {
          name: keyName,
          kind: "field",
          line: keyTok.line,
          column: keyTok.col,
          typeName: null,
          signature: keyName,
          isShorthand: true,
        });
      }
      while (i < closeBraceIdx && tokens[i].value !== ",") i += 1;
      if (i < closeBraceIdx && tokens[i].value === ",") i += 1;
    }
    return members;
  }

  function skipObjectPropertyValue(startIdx, limitEnd) {
    let i = startIdx;
    while (i < limitEnd) {
      const v = tokens[i].value;
      if (v === ",") break;
      if (v === "(" || v === "[" || v === "{") {
        const c = pairIndex[i];
        if (c > i && c < limitEnd) {
          i = c + 1;
          continue;
        }
        break;
      }
      i += 1;
    }
    return i;
  }

  function parseImportStatement(startIdx, limitEnd) {
    const startTok = tokens[startIdx];
    let i = startIdx + 1;
    if (i >= limitEnd) return i;

    // Dynamic `import(...)` expression at statement start
    if (tokens[i].value === "(") {
      const endStmt = findStatementEnd(startIdx, limitEnd);
      scanExpressionForScopes(startIdx, endStmt, rootScope);
      return endStmt;
    }

    let isTypeOnly = false;
    if (tokens[i].value === "type" && i + 1 < limitEnd && (tokens[i + 1].type === "ident" || tokens[i + 1].value === "{" || tokens[i + 1].value === "*")) {
      // Distinguish `import type from "./x"` vs `import type Foo from "./x"` / `import type { A }`
      if (tokens[i + 1].value !== "from") {
        isTypeOnly = true;
        i += 1;
      }
    }

    // Legacy TS `import Foo = require("./foo")`
    if (tokens[i]?.type === "ident" && tokens[i + 1]?.value === "=" && tokens[i + 2]?.value === "require" && tokens[i + 3]?.value === "(") {
      const localTok = tokens[i];
      const closeP = pairIndex[i + 3];
      const endStmt = closeP > i + 3 ? findStatementEnd(closeP + 1, limitEnd) : findStatementEnd(i, limitEnd);
      const str = closeP > i + 3 ? extractQuotedStringInSpan(lines, tokens[i + 3].line, tokens[i + 3].endCol, tokens[closeP].line, tokens[closeP].col) : null;
      const spec = str ? str.text : "";
      if (spec) {
        const entry = {
          localName: localTok.value,
          importedName: "default",
          specifier: spec,
          isDefault: true,
          isNamespace: false,
          isTypeOnly,
          isRequire: true,
          line: localTok.line,
          column: localTok.col,
        };
        imports.push(entry);
        const endTok = tokens[Math.max(startIdx, endStmt - 1)] || localTok;
        importStatements.push({
          startPos: toPos(startTok.line, startTok.col),
          endPos: toPos(endTok.line, endTok.endCol),
          specRange: str ? { line: str.line, startCol: str.startCol, endCol: str.endCol } : null,
          entries: [{ entry, localTok, importedTok: localTok }],
          isRequire: true,
        });
        addBinding(rootScope, localTok.value, {
          name: localTok.value,
          kind: "import",
          line: localTok.line,
          column: localTok.col,
          importMeta: entry,
        });
      }
      return endStmt;
    }

    // Collect bindings before `from` (if any)
    const pendingEntries = [];
    let sawFrom = false;
    let fromTok = null;

    // Bare side-effect `import "./polyfill"` (tokens right after `import` are `;` or ASI break)
    while (i < limitEnd) {
      if (isAsiBreak(tokens, i, limitEnd, { allowCallCont: false, allowBracketCont: false })) break;
      const v = tokens[i].value;
      if (v === ";") { i += 1; break; }
      if (v === "from") {
        sawFrom = true;
        fromTok = tokens[i];
        i += 1;
        break;
      }
      if (v === "*") {
        if (tokens[i + 1]?.value === "as" && tokens[i + 2]?.type === "ident") {
          const nsTok = tokens[i + 2];
          pendingEntries.push({
            localName: nsTok.value,
            importedName: "*",
            isDefault: false,
            isNamespace: true,
            isTypeOnly,
            localTok: nsTok,
            importedTok: tokens[i],
          });
          i += 3;
          continue;
        }
        i += 1;
        continue;
      }
      if (v === "{") {
        const closeB = pairIndex[i];
        if (closeB > i && closeB < limitEnd) {
          let k = i + 1;
          while (k < closeB) {
            if (tokens[k].value === ",") { k += 1; continue; }
            let itemTypeOnly = isTypeOnly;
            if (tokens[k].value === "type" && k + 1 < closeB && tokens[k + 1].type === "ident" && tokens[k + 1].value !== "as") {
              itemTypeOnly = true;
              k += 1;
            }
            if (tokens[k].type === "ident") {
              const origTok = tokens[k];
              let aliasTok = origTok;
              k += 1;
              if (k + 1 < closeB && tokens[k].value === "as" && tokens[k + 1].type === "ident") {
                aliasTok = tokens[k + 1];
                k += 2;
              }
              pendingEntries.push({
                localName: aliasTok.value,
                importedName: origTok.value,
                isDefault: origTok.value === "default",
                isNamespace: false,
                isTypeOnly: itemTypeOnly,
                localTok: aliasTok,
                importedTok: origTok,
              });
            } else {
              k += 1;
            }
            while (k < closeB && tokens[k].value !== ",") k += 1;
            if (k < closeB && tokens[k].value === ",") k += 1;
          }
          i = closeB + 1;
          continue;
        }
      }
      if (tokens[i].type === "ident") {
        const defTok = tokens[i];
        pendingEntries.push({
          localName: defTok.value,
          importedName: "default",
          isDefault: true,
          isNamespace: false,
          isTypeOnly,
          localTok: defTok,
          importedTok: defTok,
        });
      }
      i += 1;
    }

    // Consume statement end after `from` (or side-effect string)
    let endStmt = i;
    while (endStmt < limitEnd) {
      if (tokens[endStmt].value === ";") { endStmt += 1; break; }
      if (isAsiBreak(tokens, endStmt, limitEnd, { allowCallCont: false, allowBracketCont: false })) break;
      endStmt += 1;
    }

    const spanStartTok = fromTok || startTok;
    const lastLine = Math.min(lines.length, (tokens[endStmt]?.line || spanStartTok.line));
    const spanEndLine = tokens[endStmt - 1]?.value === ";"
      ? tokens[endStmt - 1].line
      : spanStartTok.line;
    const spanEndCol = tokens[endStmt - 1]?.value === ";"
      ? tokens[endStmt - 1].col
      : (lines[Math.max(0, spanEndLine - 1)]?.length || 0) + 1;

    const str = extractQuotedStringInSpan(lines, spanStartTok.line, spanStartTok.endCol, Math.max(spanStartTok.line, Math.min(lastLine, spanEndLine)), spanEndCol);
    const specifier = str ? str.text : "";

    const endPosLine = str ? Math.max(spanEndLine, str.line) : spanEndLine;
    const endPosCol = str ? Math.max(spanEndCol, str.endCol + 1) : spanEndCol;

    if (specifier) {
      const stmtEntries = [];
      if (pendingEntries.length === 0 && !sawFrom) {
        const entry = {
          localName: "",
          importedName: null,
          specifier,
          isDefault: false,
          isNamespace: false,
          isTypeOnly,
          isRequire: false,
          line: str.line,
          column: str.startCol,
        };
        imports.push(entry);
        stmtEntries.push({ entry, localTok: null, importedTok: null });
      } else {
        for (let p = 0; p < pendingEntries.length; p += 1) {
          const item = pendingEntries[p];
          const entry = {
            localName: item.localName,
            importedName: item.importedName,
            specifier,
            isDefault: item.isDefault,
            isNamespace: item.isNamespace,
            isTypeOnly: item.isTypeOnly,
            isRequire: false,
            line: item.localTok.line,
            column: item.localTok.col,
          };
          imports.push(entry);
          stmtEntries.push({ entry, localTok: item.localTok, importedTok: item.importedTok });
          addBinding(rootScope, entry.localName, {
            name: entry.localName,
            kind: "import",
            line: entry.line,
            column: entry.column,
            importMeta: entry,
          });
        }
      }
      importStatements.push({
        startPos: toPos(startTok.line, startTok.col),
        endPos: toPos(endPosLine, endPosCol),
        specRange: str ? { line: str.line, startCol: str.startCol, endCol: str.endCol } : null,
        entries: stmtEntries,
        isRequire: false,
        isTypeOnly,
      });
    }

    return endStmt;
  }

  function parseExportStatement(startIdx, limitEnd, scope, pendingAnnotations) {
    const startTok = tokens[startIdx];
    let i = startIdx + 1;
    if (i >= limitEnd) return i;

    // `export * [as ns] from "./mod"`
    if (tokens[i].value === "*" || (tokens[i].value === "type" && tokens[i + 1]?.value === "*")) {
      if (tokens[i].value === "type") i += 1;
      const starTok = tokens[i];
      i += 1;
      let exportedName = "*";
      let aliasTok = starTok;
      if (tokens[i]?.value === "as" && tokens[i + 1]?.type === "ident") {
        aliasTok = tokens[i + 1];
        exportedName = aliasTok.value;
        i += 2;
      }
      let fromTok = tokens[i];
      if (tokens[i]?.value === "from") {
        fromTok = tokens[i];
        i += 1;
      }
      while (i < limitEnd && tokens[i].value !== ";" && !isAsiBreak(tokens, i, limitEnd, { allowCallCont: false, allowBracketCont: false })) {
        i += 1;
      }
      if (tokens[i]?.value === ";") i += 1;
      const endTok = tokens[Math.max(startIdx, i - 1)] || fromTok;
      const str = extractQuotedStringInSpan(lines, fromTok.line, fromTok.col, endTok.line, (lines[endTok.line - 1]?.length || 0) + 1);
      const specifier = str ? str.text : "";
      if (specifier) {
        const reEntry = {
          exportedName,
          localName: "*",
          specifier,
          isStar: true,
          line: aliasTok.line,
          column: aliasTok.col,
        };
        reExports.push(reEntry);
        reExportStatements.push({
          startPos: toPos(startTok.line, startTok.col),
          endPos: toPos(Math.max(endTok.line, str?.line || endTok.line), Math.max(endTok.endCol, (str?.endCol || 0) + 1)),
          specRange: str ? { line: str.line, startCol: str.startCol, endCol: str.endCol } : null,
          entries: [{ entry: reEntry, localTok: aliasTok, origTok: starTok }],
        });
      }
      return i;
    }

    // `export [type] { a, b as c } [from "./mod"]`
    const isExportTypeBlock = tokens[i].value === "type" && tokens[i + 1]?.value === "{";
    if (tokens[i].value === "{" || isExportTypeBlock) {
      const braceIdx = isExportTypeBlock ? i + 1 : i;
      const closeB = pairIndex[braceIdx];
      if (closeB > braceIdx && closeB < limitEnd) {
        const items = [];
        let k = braceIdx + 1;
        while (k < closeB) {
          if (tokens[k].value === ",") { k += 1; continue; }
          let itemType = isExportTypeBlock;
          if (tokens[k].value === "type" && k + 1 < closeB && tokens[k + 1].type === "ident" && tokens[k + 1].value !== "as") {
            itemType = true;
            k += 1;
          }
          if (tokens[k].type === "ident") {
            const origTok = tokens[k];
            let aliasTok = origTok;
            k += 1;
            if (k + 1 < closeB && tokens[k].value === "as" && tokens[k + 1].type === "ident") {
              aliasTok = tokens[k + 1];
              k += 2;
            }
            items.push({ origTok, aliasTok, isType: itemType });
          } else {
            k += 1;
          }
          while (k < closeB && tokens[k].value !== ",") k += 1;
          if (k < closeB && tokens[k].value === ",") k += 1;
        }

        let afterBrace = closeB + 1;
        if (afterBrace < limitEnd && tokens[afterBrace].value === "from") {
          const fromTok = tokens[afterBrace];
          let endStmt = afterBrace + 1;
          while (endStmt < limitEnd && tokens[endStmt].value !== ";" && !isAsiBreak(tokens, endStmt, limitEnd, { allowCallCont: false, allowBracketCont: false })) {
            endStmt += 1;
          }
          if (tokens[endStmt]?.value === ";") endStmt += 1;
          const endLineR = tokens[endStmt - 1]?.line || fromTok.line;
          const str = extractQuotedStringInSpan(lines, fromTok.line, fromTok.endCol, endLineR, (lines[endLineR - 1]?.length || 0) + 1);
          const specifier = str ? str.text : "";
          const stmtEntries = [];
          for (let x = 0; x < items.length; x += 1) {
            const it = items[x];
            const reEntry = {
              exportedName: it.aliasTok.value,
              localName: it.origTok.value,
              specifier,
              isStar: false,
              line: it.aliasTok.line,
              column: it.aliasTok.col,
            };
            reExports.push(reEntry);
            stmtEntries.push({ entry: reEntry, localTok: it.aliasTok, origTok: it.origTok });
          }
          if (specifier) {
            reExportStatements.push({
              startPos: toPos(startTok.line, startTok.col),
              endPos: toPos(Math.max(endLineR, str?.line || endLineR), Math.max(tokens[endStmt - 1]?.endCol || 1, (str?.endCol || 0) + 1)),
              specRange: str ? { line: str.line, startCol: str.startCol, endCol: str.endCol } : null,
              entries: stmtEntries,
            });
          }
          return endStmt;
        }

        // Local `export { a, b as c }`
        let endStmt = afterBrace;
        if (tokens[endStmt]?.value === ";") endStmt += 1;
        for (let x = 0; x < items.length; x += 1) {
          const it = items[x];
          exportsList.push({
            name: it.aliasTok.value,
            localName: it.origTok.value,
            kind: it.isType ? "type" : "named",
            isDefault: it.aliasTok.value === "default",
            line: it.origTok.line,
            column: it.origTok.col,
          });
        }
        return endStmt;
      }
    }

    // `export default ...`
    if (tokens[i].value === "default") {
      i += 1;
      if (i >= limitEnd) return i;
      if (tokens[i].value === "async" && tokens[i + 1]?.value === "function") {
        const res = parseFunctionEntity(i, limitEnd, scope, { isExported: true, isDefault: true, isStatement: true });
        return res.consumed;
      }
      if (tokens[i].value === "function") {
        const res = parseFunctionEntity(i, limitEnd, scope, { isExported: true, isDefault: true, isStatement: true });
        return res.consumed;
      }
      if (tokens[i].value === "abstract" && tokens[i + 1]?.value === "class") {
        const res = parseClassEntity(i + 1, limitEnd, scope, { isExported: true, isDefault: true, isAbstract: true, annotations: pendingAnnotations, isStatement: true });
        return res.consumed;
      }
      if (tokens[i].value === "class") {
        const res = parseClassEntity(i, limitEnd, scope, { isExported: true, isDefault: true, isAbstract: false, annotations: pendingAnnotations, isStatement: true });
        return res.consumed;
      }
      const exprStart = i;
      const exprEnd = findStatementEnd(exprStart, limitEnd);
      let localName = "";
      if (tokens[exprStart]?.type === "ident" && exprEnd - exprStart <= 2) {
        localName = tokens[exprStart].value;
      }
      exportsList.push({
        name: "default",
        localName,
        kind: "default",
        isDefault: true,
        line: tokens[exprStart]?.line || startTok.line,
        column: tokens[exprStart]?.col || startTok.col,
      });
      scanExpressionForScopes(exprStart, exprEnd, scope);
      return exprEnd;
    }

    // `export [declare] ...`
    if (tokens[i].value === "declare") {
      i += 1;
    }
    return parseDeclarationOrStatement(i, limitEnd, scope, { isExported: true, annotations: pendingAnnotations });
  }

  function findStatementEnd(startIdx, limitEnd) {
    let i = startIdx;
    while (i < limitEnd) {
      if (i > startIdx && isAsiBreak(tokens, i, limitEnd)) break;
      const v = tokens[i].value;
      if (v === ";") return i + 1;
      if (v === "}") break;
      if (v === "(" || v === "[" || v === "{") {
        const c = pairIndex[i];
        if (c > i && c < limitEnd) {
          i = c + 1;
          continue;
        }
        break;
      }
      i += 1;
    }
    return i;
  }

  function parseFunctionEntity(startIdx, limitEnd, scope, opts = {}) {
    const startTok = tokens[startIdx];
    let i = startIdx;
    let isAsync = false;
    if (tokens[i]?.value === "async") {
      isAsync = true;
      i += 1;
    }
    if (tokens[i]?.value !== "function") {
      return { consumed: startIdx + 1 };
    }
    i += 1;
    if (tokens[i]?.value === "*") i += 1;

    let nameTok = null;
    if (i < limitEnd && tokens[i].type === "ident") {
      nameTok = tokens[i];
      i += 1;
    }

    if (i < limitEnd && tokens[i].value === "<") {
      const closeA = findMatchingAngle(tokens, pairIndex, i, limitEnd);
      if (closeA > i) i = closeA + 1;
    }

    if (i >= limitEnd || tokens[i].value !== "(") {
      return { consumed: Math.max(startIdx + 1, i) };
    }

    const parsedParams = parseParamList(tokens, pairIndex, i, limitEnd);
    i = parsedParams.endIdx;

    let returnType = null;
    if (i < limitEnd && tokens[i].value === ":") {
      const tr = readTypeAnnotation(tokens, pairIndex, i + 1, limitEnd, STOP_BRACE_SEMI, { stopOnBrace: true });
      returnType = tr.typeText;
      i = tr.endIdx;
    }

    const hasBody = i < limitEnd && tokens[i].value === "{";
    const closeBrace = hasBody ? pairIndex[i] : -1;
    let endIdx = i;
    if (hasBody && closeBrace > i && closeBrace < limitEnd) {
      endIdx = closeBrace + 1;
    } else if (i < limitEnd && tokens[i].value === ";") {
      endIdx = i + 1;
    }

    const sigEndTok = hasBody ? tokens[i] : (tokens[Math.max(startIdx, endIdx - 1)] || startTok);
    const signature = buildSignature(lines, startTok.line, startTok.col, sigEndTok.line, sigEndTok.col);
    const fnName = nameTok ? nameTok.value : (opts.isDefault ? "default" : "");
    const fnLine = nameTok ? nameTok.line : startTok.line;
    const fnCol = nameTok ? nameTok.col : startTok.col;
    const fnEndLine = hasBody && closeBrace > i ? tokens[closeBrace].line : sigEndTok.line;
    const fnEndCol = hasBody && closeBrace > i ? tokens[closeBrace].endCol : sigEndTok.endCol;

    if (fnName && (opts.isStatement || scope === rootScope)) {
      const fnSummary = {
        name: fnName,
        kind: "function",
        line: fnLine,
        column: fnCol,
        endLine: fnEndLine,
        arity: parsedParams.arity,
        isAsync,
        isExported: Boolean(opts.isExported),
        returnType,
        signature,
      };
      if (scope === rootScope && (hasBody || !opts.isStatement)) {
        functions.push(fnSummary);
      } else if (scope === rootScope && !hasBody) {
        // Track overload/declare signatures carefully (will dedupe if body exists)
        functions.push({ ...fnSummary, _isBodylessOverload: true });
      }

      if (opts.isStatement) {
        addBinding(scope, fnName, {
          name: fnName,
          kind: "function",
          line: fnLine,
          column: fnCol,
          arity: parsedParams.arity,
          minArity: parsedParams.minArity,
          hasRest: parsedParams.hasRest,
          isAsync,
          isAbstract: !hasBody,
          returnType,
          signature,
          isFunction: true,
        }, scope === rootScope || scope.kind === "function" || scope.kind === "method" || scope.kind === "constructor" || scope.kind === "arrow");
      }

      if (opts.isExported && scope === rootScope) {
        exportsList.push({
          name: opts.isDefault ? "default" : fnName,
          localName: nameTok ? nameTok.value : "",
          kind: "function",
          isDefault: Boolean(opts.isDefault),
          line: fnLine,
          column: fnCol,
        });
      }
    }

    if (!skipBodiesForSummary) {
      const fnScope = createScope("function", fnName || null, scope, startTok.line, startTok.col, fnEndLine, fnEndCol);
      // Named function expressions bind their own name inside their own scope
      if (!opts.isStatement && nameTok) {
        addBinding(fnScope, nameTok.value, {
          name: nameTok.value,
          kind: "function",
          line: nameTok.line,
          column: nameTok.col,
          arity: parsedParams.arity,
          minArity: parsedParams.minArity,
          hasRest: parsedParams.hasRest,
          isAsync,
          isAbstract: !hasBody,
          returnType,
          signature,
          isFunction: true,
        });
      }
      for (let d = 0; d < parsedParams.defaultExprSpans.length; d += 1) {
        const [ds, de] = parsedParams.defaultExprSpans[d];
        scanExpressionForScopes(ds, de, fnScope);
      }
      for (let p = 0; p < parsedParams.params.length; p += 1) {
        const pr = parsedParams.params[p];
        addBinding(fnScope, pr.name, {
          name: pr.name,
          kind: "parameter",
          line: pr.line,
          column: pr.col,
          signature: pr.declaredType ? `${pr.name}: ${pr.declaredType}` : pr.name,
          declaredType: pr.declaredType,
          parentPatternType: pr.parentPatternType,
          initializerType: null,
          isFunction: false,
        });
      }

      if (hasBody && closeBrace > i && closeBrace < limitEnd) {
        parseBlockStatements(i + 1, closeBrace, fnScope);
      }
    }

    return { consumed: endIdx, fnName, arity: parsedParams.arity, returnType, isAsync };
  }

  function parseClassEntity(startIdx, limitEnd, scope, opts = {}) {
    const startTok = tokens[startIdx];
    let i = startIdx;
    let isAbstract = Boolean(opts.isAbstract);
    if (tokens[i]?.value === "abstract") {
      isAbstract = true;
      i += 1;
    }
    if (tokens[i]?.value !== "class") return { consumed: startIdx + 1 };
    i += 1;

    let nameTok = null;
    if (i < limitEnd && tokens[i].type === "ident" && tokens[i].value !== "extends" && tokens[i].value !== "implements") {
      nameTok = tokens[i];
      i += 1;
    }

    if (i < limitEnd && tokens[i].value === "<") {
      const closeA = findMatchingAngle(tokens, pairIndex, i, limitEnd);
      if (closeA > i) i = closeA + 1;
    }

    const extendsList = [];
    const implementsList = [];

    if (i < limitEnd && tokens[i].value === "extends") {
      i += 1;
      const baseStart = i;
      while (i < limitEnd && tokens[i].value !== "{" && tokens[i].value !== "implements") {
        if (tokens[i].value === "(" || tokens[i].value === "[" || tokens[i].value === "<") {
          if (tokens[i].value === "<") {
            const ca = findMatchingAngle(tokens, pairIndex, i, limitEnd);
            if (ca > i) { i = ca + 1; continue; }
          } else {
            const c = pairIndex[i];
            if (c > i && c < limitEnd) { i = c + 1; continue; }
          }
        }
        i += 1;
      }
      if (i > baseStart) {
        const res = readTypeIdentifierChain(tokens, pairIndex, baseStart, i);
        if (res.name) extendsList.push(res.name);
      }
    }

    if (i < limitEnd && tokens[i].value === "implements") {
      i += 1;
      while (i < limitEnd && tokens[i].value !== "{") {
        if (tokens[i].value === ",") { i += 1; continue; }
        const res = readTypeIdentifierChain(tokens, pairIndex, i, limitEnd);
        if (res.name) {
          implementsList.push(res.name);
          i = res.endIdx;
        } else {
          i += 1;
        }
      }
    }

    if (i >= limitEnd || tokens[i].value !== "{") {
      return { consumed: Math.max(startIdx + 1, i) };
    }

    const openBrace = i;
    const closeBrace = pairIndex[openBrace];
    if (closeBrace < openBrace || closeBrace >= limitEnd) {
      return { consumed: openBrace + 1 };
    }

    const className = nameTok ? nameTok.value : (opts.isDefault ? "default" : "");
    const classLine = nameTok ? nameTok.line : startTok.line;
    const classCol = nameTok ? nameTok.col : startTok.col;
    const classEndLine = tokens[closeBrace].line;
    const classEndCol = tokens[closeBrace].endCol;

    const typeModel = {
      name: className,
      kind: "class",
      line: classLine,
      column: classCol,
      endLine: classEndLine,
      isAbstract,
      isExported: Boolean(opts.isExported),
      extends: extendsList,
      implements: implementsList,
      annotations: Array.isArray(opts.annotations) ? opts.annotations.slice() : [],
      fields: [],
      constructors: [],
      methods: [],
    };

    if (className) {
      registerTypeModel(typeModel);
      if (opts.isStatement) {
        addBinding(scope, className, {
          name: className,
          kind: "class",
          line: classLine,
          column: classCol,
          signature: buildSignature(lines, startTok.line, startTok.col, tokens[openBrace].line, tokens[openBrace].col),
          typeModel,
          isType: true,
          isValue: true,
        });
      }
      if (opts.isExported && scope === rootScope) {
        exportsList.push({
          name: opts.isDefault ? "default" : className,
          localName: nameTok ? nameTok.value : "",
          kind: "class",
          isDefault: Boolean(opts.isDefault),
          line: classLine,
          column: classCol,
        });
      }
    }

    const classScope = createScope("class", className || null, scope, startTok.line, startTok.col, classEndLine, classEndCol, typeModel);
    if (!opts.isStatement && nameTok) {
      addBinding(classScope, nameTok.value, {
        name: nameTok.value,
        kind: "class",
        line: nameTok.line,
        column: nameTok.col,
        typeModel,
        isType: true,
        isValue: true,
      });
    }

    parseClassBody(openBrace + 1, closeBrace, classScope, typeModel);
    return { consumed: closeBrace + 1, typeModel };
  }

  function parseClassBody(startIdx, endIdx, classScope, typeModel) {
    let i = startIdx;
    while (i < endIdx) {
      if (tokens[i].value === ";") { i += 1; continue; }

      // Member decorators `@Decorator(...)`
      while (i < endIdx && tokens[i].value === "@") {
        i += 1;
        while (i < endIdx && (tokens[i].type === "ident" || tokens[i].value === ".")) i += 1;
        if (i < endIdx && tokens[i].value === "(") {
          const c = pairIndex[i];
          if (c > i && c < endIdx) {
            scanExpressionForScopes(i + 1, c, classScope);
            i = c + 1;
          }
        }
      }
      if (i >= endIdx) break;

      // Static block `static { ... }`
      if (tokens[i].value === "static" && tokens[i + 1]?.value === "{") {
        const openB = i + 1;
        const closeB = pairIndex[openB];
        if (closeB > openB && closeB <= endIdx) {
          const blockScope = createScope("block", null, classScope, tokens[openB].line, tokens[openB].col, tokens[closeB].line, tokens[closeB].endCol);
          parseBlockStatements(openB + 1, closeB, blockScope);
          i = closeB + 1;
          continue;
        }
      }

      // Index signature `[key: string]: unknown;`
      if (tokens[i].value === "[" && i + 1 < endIdx && tokens[i + 1].type === "ident" && tokens[i + 2]?.value === ":") {
        const closeBr = pairIndex[i];
        if (closeBr > i && closeBr < endIdx) {
          i = closeBr + 1;
          while (i < endIdx && tokens[i].value !== ";" && !isAsiBreak(tokens, i, endIdx, { allowCallCont: false, allowBracketCont: false })) {
            i += 1;
          }
          if (tokens[i]?.value === ";") i += 1;
          continue;
        }
      }

      const memberStartTok = tokens[i];
      let isStatic = false;
      let isAbstractMember = false;
      let isAsync = false;
      let methodKind = "method";

      while (i < endIdx && CLASS_MODIFIER_KEYWORDS.has(tokens[i].value)) {
        const nextVal = tokens[i + 1]?.value;
        // Only treat keyword as modifier if it's NOT the member name itself
        if (!nextVal || nextVal === "(" || nextVal === "<" || nextVal === ":" || nextVal === "=" || nextVal === ";" || nextVal === "?" || nextVal === "!") {
          break;
        }
        const kw = tokens[i].value;
        if (kw === "static") isStatic = true;
        else if (kw === "abstract") isAbstractMember = true;
        else if (kw === "async") isAsync = true;
        i += 1;
      }

      if (i < endIdx && (tokens[i].value === "get" || tokens[i].value === "set")) {
        const nextVal = tokens[i + 1]?.value;
        if (nextVal && nextVal !== "(" && nextVal !== "<" && nextVal !== ":" && nextVal !== "=" && nextVal !== ";" && nextVal !== "?" && nextVal !== "!") {
          methodKind = tokens[i].value === "get" ? "getter" : "setter";
          i += 1;
        }
      }

      if (i < endIdx && tokens[i].value === "*") i += 1;
      if (i >= endIdx) break;

      let memberName = "";
      let memberTok = tokens[i];
      if (tokens[i].value === "[") {
        const closeBr = pairIndex[i];
        if (closeBr > i && closeBr < endIdx) {
          scanExpressionForScopes(i + 1, closeBr, classScope);
          i = closeBr + 1;
        } else {
          i += 1;
        }
      } else if ((tokens[i].type === "ident" || tokens[i].type === "number") && !NON_METHOD_KEYWORDS.has(tokens[i].value)) {
        memberName = tokens[i].value;
        i += 1;
      } else {
        i += 1;
        continue;
      }

      // Optional `?` or definite `!`
      if (i < endIdx && (tokens[i].value === "?" || tokens[i].value === "!")) {
        i += 1;
      }

      // Check for generic `<...>` followed by `(` (generic method)
      let openParenIdx = -1;
      if (i < endIdx && tokens[i].value === "<") {
        const closeA = findMatchingAngle(tokens, pairIndex, i, endIdx);
        if (closeA > i && tokens[closeA + 1]?.value === "(") {
          openParenIdx = closeA + 1;
        }
      } else if (i < endIdx && tokens[i].value === "(") {
        openParenIdx = i;
      }

      if (openParenIdx >= 0) {
        const parsedParams = parseParamList(tokens, pairIndex, openParenIdx, endIdx);
        i = parsedParams.endIdx;
        let returnType = null;
        if (i < endIdx && tokens[i].value === ":") {
          const tr = readTypeAnnotation(tokens, pairIndex, i + 1, endIdx, STOP_BRACE_SEMI, { stopOnBrace: true });
          returnType = tr.typeText;
          i = tr.endIdx;
        }

        const hasBody = i < endIdx && tokens[i].value === "{";
        const closeBody = hasBody ? pairIndex[i] : -1;
        const sigEndTok = hasBody ? tokens[i] : (tokens[Math.max(0, i - 1)] || memberTok);
        const signature = buildSignature(lines, memberStartTok.line, memberStartTok.col, sigEndTok.line, sigEndTok.col);

        if (memberName === "constructor" && !isStatic) {
          typeModel.constructors.push({
            line: memberTok.line,
            column: memberTok.col,
            arity: parsedParams.arity,
            signature,
            _minArity: parsedParams.minArity,
            _hasRest: parsedParams.hasRest,
            _isAbstract: !hasBody,
          });
          for (let pp = 0; pp < parsedParams.paramProps.length; pp += 1) {
            const prop = parsedParams.paramProps[pp];
            typeModel.fields.push({
              name: prop.name,
              typeName: prop.typeName,
              line: prop.line,
              column: prop.col,
              signature: `${prop.name}${prop.typeName ? `: ${prop.typeName}` : ""}`,
              isStatic: false,
              initializerType: null,
            });
          }
        } else if (memberName) {
          typeModel.methods.push({
            name: memberName,
            kind: methodKind,
            line: memberTok.line,
            column: memberTok.col,
            arity: parsedParams.arity,
            isAbstract: isAbstractMember || !hasBody,
            isDefault: false,
            isStatic,
            returnType,
            signature,
            _minArity: parsedParams.minArity,
            _hasRest: parsedParams.hasRest,
            _isAsync: isAsync,
          });
        }

        if (hasBody && closeBody > i && closeBody < endIdx) {
          if (!skipBodiesForSummary) {
            const mScope = createScope(
              memberName === "constructor" ? "constructor" : "method",
              memberName || null,
              classScope,
              memberStartTok.line,
              memberStartTok.col,
              tokens[closeBody].line,
              tokens[closeBody].endCol
            );
            for (let d = 0; d < parsedParams.defaultExprSpans.length; d += 1) {
              const [ds, de] = parsedParams.defaultExprSpans[d];
              scanExpressionForScopes(ds, de, mScope);
            }
            for (let p = 0; p < parsedParams.params.length; p += 1) {
              const pr = parsedParams.params[p];
              addBinding(mScope, pr.name, {
                name: pr.name,
                kind: "parameter",
                line: pr.line,
                column: pr.col,
                signature: pr.declaredType ? `${pr.name}: ${pr.declaredType}` : pr.name,
                declaredType: pr.declaredType,
                parentPatternType: pr.parentPatternType,
                initializerType: null,
                isFunction: false,
              });
            }
            parseBlockStatements(i + 1, closeBody, mScope);
          }
          i = closeBody + 1;
        } else {
          if (i < endIdx && tokens[i].value === ";") i += 1;
        }
        continue;
      }

      // Field declaration: `[mods] name[?|!][: Type] [= expr]`
      let fieldTypeName = null;
      if (i < endIdx && tokens[i].value === ":") {
        const tr = readTypeAnnotation(tokens, pairIndex, i + 1, endIdx, STOP_EQ_SEMI_BRACE, { allowVerticalBars: true });
        fieldTypeName = tr.typeText;
        i = tr.endIdx;
      }

      let initializerType = null;
      let exprStart = -1;
      let exprEnd = i;
      if (i < endIdx && tokens[i].value === "=") {
        i += 1;
        exprStart = i;
        while (i < endIdx) {
          if (tokens[i].value === ";") break;
          if (i > exprStart && isAsiBreak(tokens, i, endIdx, { allowBracketCont: false })) break;
          const v = tokens[i].value;
          if (v === "(" || v === "[" || v === "{") {
            const c = pairIndex[i];
            if (c > i && c < endIdx) {
              i = c + 1;
              continue;
            }
            break;
          }
          i += 1;
        }
        exprEnd = i;

        // Check if field initializer is an arrow/function expression (`handleClick = (e) => ...`)
        const arrowField = detectArrowOrFuncInitializer(exprStart, exprEnd);
        if (arrowField && memberName) {
          typeModel.methods.push({
            name: memberName,
            kind: arrowField.kind,
            line: memberTok.line,
            column: memberTok.col,
            arity: arrowField.arity,
            isAbstract: false,
            isDefault: false,
            isStatic,
            returnType: arrowField.returnType || null,
            signature: buildSignature(lines, memberStartTok.line, memberStartTok.col, tokens[Math.max(exprStart, exprEnd - 1)].line, tokens[Math.max(exprStart, exprEnd - 1)].endCol),
            _minArity: arrowField.minArity,
            _hasRest: arrowField.hasRest,
            _isAsync: arrowField.isAsync,
          });
        } else {
          const inf = inferExprType(exprStart, exprEnd, classScope);
          initializerType = inf.typeName || null;
        }
        scanExpressionForScopes(exprStart, exprEnd, classScope);
      }

      const endTok = tokens[Math.max(0, (exprEnd > exprStart ? exprEnd : i) - 1)] || memberTok;
      if (memberName) {
        typeModel.fields.push({
          name: memberName,
          typeName: fieldTypeName,
          line: memberTok.line,
          column: memberTok.col,
          signature: buildSignature(lines, memberStartTok.line, memberStartTok.col, endTok.line, endTok.endCol),
          isStatic,
          initializerType,
        });
      }
      if (i < endIdx && tokens[i].value === ";") i += 1;
    }
  }

  function detectArrowOrFuncInitializer(exprStart, exprEnd) {
    if (exprStart >= exprEnd) return null;
    let i = exprStart;
    let isAsync = false;
    if (tokens[i].value === "async") {
      isAsync = true;
      i += 1;
    }
    if (i >= exprEnd) return null;
    if (tokens[i].value === "function") {
      i += 1;
      if (tokens[i]?.value === "*") i += 1;
      if (tokens[i]?.type === "ident") i += 1;
      if (tokens[i]?.value === "<") {
        const ca = findMatchingAngle(tokens, pairIndex, i, exprEnd);
        if (ca > i) i = ca + 1;
      }
      if (tokens[i]?.value === "(") {
        const pp = parseParamList(tokens, pairIndex, i, exprEnd);
        let ret = null;
        if (pp.endIdx < exprEnd && tokens[pp.endIdx].value === ":") {
          ret = readTypeAnnotation(tokens, pairIndex, pp.endIdx + 1, exprEnd, STOP_BRACE_ONLY, { stopOnBrace: true }).typeText;
        }
        return { kind: "function", arity: pp.arity, minArity: pp.minArity, hasRest: pp.hasRest, returnType: ret, isAsync };
      }
      return null;
    }

    if (tokens[i].type === "ident" && !NON_ARROW_KEYWORD_IDENT.has(tokens[i].value) && tokens[i + 1]?.value === "=>") {
      return { kind: "arrow", arity: 1, minArity: 1, hasRest: false, returnType: null, isAsync };
    }

    let parenIdx = -1;
    if (tokens[i].value === "<") {
      const ca = findMatchingAngle(tokens, pairIndex, i, exprEnd);
      if (ca > i && tokens[ca + 1]?.value === "(") parenIdx = ca + 1;
    } else if (tokens[i].value === "(") {
      parenIdx = i;
    }
    if (parenIdx >= 0) {
      const hdr = detectArrowHeader(tokens, pairIndex, parenIdx, exprEnd);
      if (hdr) {
        const pp = parseParamList(tokens, pairIndex, parenIdx, exprEnd);
        return { kind: "arrow", arity: pp.arity, minArity: pp.minArity, hasRest: pp.hasRest, returnType: hdr.returnType, isAsync };
      }
    }
    return null;
  }

  function parseInterfaceOrObjectTypeMembers(openBraceIdx, closeBraceIdx, typeModel) {
    let i = openBraceIdx + 1;
    while (i < closeBraceIdx) {
      if (tokens[i].value === ";" || tokens[i].value === ",") { i += 1; continue; }

      // Call signature `(...): R` or construct signature `new (...): R`
      if (tokens[i].value === "(" || tokens[i].value === "<" || (tokens[i].value === "new" && (tokens[i + 1]?.value === "(" || tokens[i + 1]?.value === "<"))) {
        while (i < closeBraceIdx && tokens[i].value !== ";" && tokens[i].value !== "," && !isAsiBreak(tokens, i, closeBraceIdx, { allowBracketCont: false })) {
          const v = tokens[i].value;
          if (v === "(" || v === "[" || v === "{") {
            const c = pairIndex[i];
            if (c > i && c < closeBraceIdx) { i = c + 1; continue; }
          }
          i += 1;
        }
        continue;
      }

      // Index signature `[key: string]: T`
      if (tokens[i].value === "[") {
        const closeBr = pairIndex[i];
        if (closeBr > i && closeBr < closeBraceIdx) {
          i = closeBr + 1;
          while (i < closeBraceIdx && tokens[i].value !== ";" && tokens[i].value !== "," && !isAsiBreak(tokens, i, closeBraceIdx, { allowBracketCont: false })) {
            const v = tokens[i].value;
            if (v === "(" || v === "[" || v === "{") {
              const c = pairIndex[i];
              if (c > i && c < closeBraceIdx) { i = c + 1; continue; }
            }
            i += 1;
          }
          continue;
        }
      }

      const memberStartTok = tokens[i];
      if (tokens[i].value === "readonly" && tokens[i + 1]?.type === "ident") {
        i += 1;
      }
      if (i >= closeBraceIdx || tokens[i].type !== "ident") {
        i += 1;
        continue;
      }

      const memberTok = tokens[i];
      const memberName = memberTok.value;
      i += 1;
      if (i < closeBraceIdx && tokens[i].value === "?") i += 1;

      let openParenIdx = -1;
      if (i < closeBraceIdx && tokens[i].value === "<") {
        const ca = findMatchingAngle(tokens, pairIndex, i, closeBraceIdx);
        if (ca > i && tokens[ca + 1]?.value === "(") openParenIdx = ca + 1;
      } else if (i < closeBraceIdx && tokens[i].value === "(") {
        openParenIdx = i;
      }

      if (openParenIdx >= 0) {
        const pp = parseParamList(tokens, pairIndex, openParenIdx, closeBraceIdx);
        i = pp.endIdx;
        let returnType = null;
        if (i < closeBraceIdx && tokens[i].value === ":") {
          const tr = readTypeAnnotation(tokens, pairIndex, i + 1, closeBraceIdx, STOP_SEMI_COMMA_BRACE, { allowVerticalBars: true });
          returnType = tr.typeText;
          i = tr.endIdx;
        }
        const endTok = tokens[Math.max(0, i - 1)] || memberTok;
        typeModel.methods.push({
          name: memberName,
          kind: "method",
          line: memberTok.line,
          column: memberTok.col,
          arity: pp.arity,
          isAbstract: true,
          isDefault: false,
          isStatic: false,
          returnType,
          signature: buildSignature(lines, memberStartTok.line, memberStartTok.col, endTok.line, endTok.endCol),
          _minArity: pp.minArity,
          _hasRest: pp.hasRest,
        });
        if (i < closeBraceIdx && (tokens[i].value === ";" || tokens[i].value === ",")) i += 1;
        continue;
      }

      let typeName = null;
      if (i < closeBraceIdx && tokens[i].value === ":") {
        const tr = readTypeAnnotation(tokens, pairIndex, i + 1, closeBraceIdx, STOP_SEMI_COMMA_BRACE, { allowVerticalBars: true });
        typeName = tr.typeText;
        i = tr.endIdx;
      }
      const endTok = tokens[Math.max(0, i - 1)] || memberTok;
      typeModel.fields.push({
        name: memberName,
        typeName,
        line: memberTok.line,
        column: memberTok.col,
        signature: buildSignature(lines, memberStartTok.line, memberStartTok.col, endTok.line, endTok.endCol),
        isStatic: false,
        initializerType: null,
      });
      if (i < closeBraceIdx && (tokens[i].value === ";" || tokens[i].value === ",")) i += 1;
    }
  }

  function parseInterfaceDeclaration(startIdx, limitEnd, scope, opts = {}) {
    const startTok = tokens[startIdx];
    let i = startIdx + 1;
    if (i >= limitEnd || tokens[i].type !== "ident") return startIdx + 1;
    const nameTok = tokens[i];
    i += 1;

    if (i < limitEnd && tokens[i].value === "<") {
      const ca = findMatchingAngle(tokens, pairIndex, i, limitEnd);
      if (ca > i) i = ca + 1;
    }

    const extendsList = [];
    if (i < limitEnd && tokens[i].value === "extends") {
      i += 1;
      while (i < limitEnd && tokens[i].value !== "{") {
        if (tokens[i].value === ",") { i += 1; continue; }
        const res = readTypeIdentifierChain(tokens, pairIndex, i, limitEnd);
        if (res.name) {
          extendsList.push(res.name);
          i = res.endIdx;
        } else {
          i += 1;
        }
      }
    }

    if (i >= limitEnd || tokens[i].value !== "{") return Math.max(startIdx + 1, i);
    const closeBrace = pairIndex[i];
    if (closeBrace < i || closeBrace >= limitEnd) return i + 1;

    const typeModel = {
      name: nameTok.value,
      kind: "interface",
      line: nameTok.line,
      column: nameTok.col,
      endLine: tokens[closeBrace].line,
      isAbstract: true,
      isExported: Boolean(opts.isExported),
      extends: extendsList,
      implements: [],
      annotations: Array.isArray(opts.annotations) ? opts.annotations.slice() : [],
      fields: [],
      constructors: [],
      methods: [],
    };
    parseInterfaceOrObjectTypeMembers(i, closeBrace, typeModel);
    registerTypeModel(typeModel);
    addBinding(scope, nameTok.value, {
      name: nameTok.value,
      kind: "interface",
      line: nameTok.line,
      column: nameTok.col,
      signature: buildSignature(lines, startTok.line, startTok.col, tokens[i].line, tokens[i].col),
      typeModel,
      isType: true,
      isValue: false,
    });

    if (opts.isExported && scope === rootScope) {
      exportsList.push({
        name: nameTok.value,
        localName: nameTok.value,
        kind: "interface",
        isDefault: false,
        line: nameTok.line,
        column: nameTok.col,
      });
    }

    return closeBrace + 1;
  }

  function parseTypeAliasDeclaration(startIdx, limitEnd, scope, opts = {}) {
    const startTok = tokens[startIdx];
    let i = startIdx + 1;
    if (i >= limitEnd || tokens[i].type !== "ident") return startIdx + 1;
    const nameTok = tokens[i];
    i += 1;

    if (i < limitEnd && tokens[i].value === "<") {
      const ca = findMatchingAngle(tokens, pairIndex, i, limitEnd);
      if (ca > i) i = ca + 1;
    }

    if (i >= limitEnd || tokens[i].value !== "=") {
      return Math.max(startIdx + 1, i);
    }
    i += 1;

    const rhsStart = i;
    while (i < limitEnd) {
      if (tokens[i].value === ";") break;
      if (i > rhsStart && isAsiBreak(tokens, i, limitEnd, { allowVerticalBars: true, allowBracketCont: false })) break;
      const v = tokens[i].value;
      if (v === "(" || v === "[" || v === "{") {
        const c = pairIndex[i];
        if (c > i && c < limitEnd) {
          i = c + 1;
          continue;
        }
        break;
      }
      i += 1;
    }
    const rhsEnd = i;
    if (tokens[i]?.value === ";") i += 1;

    const endTok = tokens[Math.max(rhsStart, rhsEnd - 1)] || nameTok;
    const typeModel = {
      name: nameTok.value,
      kind: "type",
      line: nameTok.line,
      column: nameTok.col,
      endLine: endTok.line,
      isAbstract: false,
      isExported: Boolean(opts.isExported),
      extends: [],
      implements: [],
      annotations: [],
      fields: [],
      constructors: [],
      methods: [],
    };

    if (rhsStart < rhsEnd && tokens[rhsStart].value === "{") {
      const closeObj = pairIndex[rhsStart];
      if (closeObj > rhsStart && closeObj <= rhsEnd) {
        parseInterfaceOrObjectTypeMembers(rhsStart, closeObj, typeModel);
      }
    }

    registerTypeModel(typeModel);
    addBinding(scope, nameTok.value, {
      name: nameTok.value,
      kind: "type",
      line: nameTok.line,
      column: nameTok.col,
      signature: buildSignature(lines, startTok.line, startTok.col, endTok.line, endTok.endCol),
      typeModel,
      isType: true,
      isValue: false,
    });

    if (opts.isExported && scope === rootScope) {
      exportsList.push({
        name: nameTok.value,
        localName: nameTok.value,
        kind: "type",
        isDefault: false,
        line: nameTok.line,
        column: nameTok.col,
      });
    }

    return i;
  }

  function parseEnumDeclaration(startIdx, limitEnd, scope, opts = {}) {
    const startTok = tokens[startIdx];
    let i = startIdx;
    if (tokens[i].value === "const") i += 1;
    if (tokens[i]?.value !== "enum") return startIdx + 1;
    i += 1;
    if (i >= limitEnd || tokens[i].type !== "ident") return startIdx + 1;
    const nameTok = tokens[i];
    i += 1;
    if (i >= limitEnd || tokens[i].value !== "{") return i;
    const closeBrace = pairIndex[i];
    if (closeBrace < i || closeBrace >= limitEnd) return i + 1;

    const typeModel = {
      name: nameTok.value,
      kind: "enum",
      line: nameTok.line,
      column: nameTok.col,
      endLine: tokens[closeBrace].line,
      isAbstract: false,
      isExported: Boolean(opts.isExported),
      extends: [],
      implements: [],
      annotations: [],
      fields: [],
      constructors: [],
      methods: [],
    };

    let m = i + 1;
    while (m < closeBrace) {
      if (tokens[m].value === ",") { m += 1; continue; }
      if (tokens[m].type === "ident") {
        const memTok = tokens[m];
        const mStart = m;
        m += 1;
        while (m < closeBrace && tokens[m].value !== ",") {
          const v = tokens[m].value;
          if (v === "(" || v === "[" || v === "{") {
            const c = pairIndex[m];
            if (c > m && c < closeBrace) { m = c + 1; continue; }
          }
          m += 1;
        }
        const mEndTok = tokens[Math.max(mStart, m - 1)] || memTok;
        typeModel.fields.push({
          name: memTok.value,
          typeName: nameTok.value,
          line: memTok.line,
          column: memTok.col,
          signature: buildSignature(lines, memTok.line, memTok.col, mEndTok.line, mEndTok.endCol),
          isStatic: true,
          initializerType: nameTok.value,
        });
      } else {
        m += 1;
      }
    }

    registerTypeModel(typeModel);
    addBinding(scope, nameTok.value, {
      name: nameTok.value,
      kind: "enum",
      line: nameTok.line,
      column: nameTok.col,
      signature: buildSignature(lines, startTok.line, startTok.col, tokens[i].line, tokens[i].col),
      typeModel,
      isType: true,
      isValue: true,
    });

    if (opts.isExported && scope === rootScope) {
      exportsList.push({
        name: nameTok.value,
        localName: nameTok.value,
        kind: "enum",
        isDefault: false,
        line: nameTok.line,
        column: nameTok.col,
      });
    }

    return closeBrace + 1;
  }

  function parseVariableDeclaration(startIdx, limitEnd, scope, opts = {}) {
    const startTok = tokens[startIdx];
    const declKind = startTok.value; // "const" | "let" | "var"
    const hoistVar = declKind === "var";
    let i = startIdx + 1;

    while (i < limitEnd) {
      if (tokens[i].value === ";") { i += 1; break; }
      if (i > startIdx + 1 && tokens[i - 1]?.value !== "," && isAsiBreak(tokens, i, limitEnd)) break;

      const pat = extractBindingPattern(tokens, pairIndex, i, limitEnd);
      if (pat.endIdx === i) break;
      for (let d = 0; d < pat.defaultExprSpans.length; d += 1) {
        const [ds, de] = pat.defaultExprSpans[d];
        scanExpressionForScopes(ds, de, scope);
      }
      i = pat.endIdx;

      if (i < limitEnd && tokens[i].value === "!") i += 1;

      let declaredType = null;
      if (i < limitEnd && tokens[i].value === ":") {
        const tr = readTypeAnnotation(tokens, pairIndex, i + 1, limitEnd, STOP_EQ_COMMA_SEMI, { allowVerticalBars: true });
        declaredType = tr.typeText;
        i = tr.endIdx;
      }

      let exprStart = -1;
      let exprEnd = i;
      if (i < limitEnd && tokens[i].value === "=") {
        i += 1;
        exprStart = i;
        while (i < limitEnd) {
          if (tokens[i].value === ";" || tokens[i].value === ",") break;
          if (i > exprStart && isAsiBreak(tokens, i, limitEnd)) break;
          const v = tokens[i].value;
          if (v === "(" || v === "[" || v === "{") {
            const c = pairIndex[i];
            if (c > i && c < limitEnd) { i = c + 1; continue; }
            break;
          }
          i += 1;
        }
        exprEnd = i;
      }

      // Check for CommonJS `require("...")` or `await import("...")`
      const cjsMatch = exprStart >= 0 ? detectRequireOrDynamicImport(exprStart, exprEnd) : null;
      if (cjsMatch && cjsMatch.specifier) {
        const stmtEntries = [];
        const isSingleDirectIdent = pat.names.length === 1 && tokens[pat.endIdx - 1]?.type === "ident";
        for (let n = 0; n < pat.names.length; n += 1) {
          const b = pat.names[n];
          const importedName = isSingleDirectIdent
            ? (cjsMatch.memberProp || (cjsMatch.isRequire ? "default" : "*"))
            : b.propName;
          const isDefault = isSingleDirectIdent && !cjsMatch.memberProp && cjsMatch.isRequire;
          const isNamespace = isSingleDirectIdent && !cjsMatch.memberProp && !cjsMatch.isRequire;
          const entry = {
            localName: b.name,
            importedName,
            specifier: cjsMatch.specifier,
            isDefault,
            isNamespace,
            isTypeOnly: false,
            isRequire: cjsMatch.isRequire,
            line: b.line,
            column: b.col,
          };
          imports.push(entry);
          stmtEntries.push({
            entry,
            localTok: { line: b.line, col: b.col, endCol: b.endCol, value: b.name },
            importedTok: { line: b.line, col: b.col, endCol: b.endCol, value: b.propName },
          });
          addBinding(scope, b.name, {
            name: b.name,
            kind: "import",
            line: b.line,
            column: b.col,
            importMeta: entry,
          }, hoistVar);
        }
        const endTok = tokens[Math.max(startIdx, exprEnd - 1)] || startTok;
        importStatements.push({
          startPos: toPos(startTok.line, startTok.col),
          endPos: toPos(endTok.line, endTok.endCol),
          specRange: cjsMatch.specRange,
          entries: stmtEntries,
          isRequire: cjsMatch.isRequire,
        });
      } else {
        // Check if single identifier bound to arrow/function/class initializer
        const isSingleIdent = pat.names.length === 1 && tokens[pat.endIdx - 1]?.type === "ident";
        const fnInit = isSingleIdent && exprStart >= 0 ? detectArrowOrFuncInitializer(exprStart, exprEnd) : null;

        if (isSingleIdent && fnInit) {
          const b = pat.names[0];
          const endTok = tokens[Math.max(exprStart, exprEnd - 1)] || startTok;
          const isBlockBody = findArrowOrFuncHeaderEnd(exprStart, exprEnd);
          const sigEndTok = isBlockBody || endTok;
          const signature = buildSignature(lines, startTok.line, startTok.col, sigEndTok.line, sigEndTok.col);
          const effectiveRet = fnInit.returnType || extractReturnTypeFromVarType(declaredType);

          if (scope === rootScope) {
            functions.push({
              name: b.name,
              kind: fnInit.kind,
              line: b.line,
              column: b.col,
              endLine: endTok.line,
              arity: fnInit.arity,
              isAsync: fnInit.isAsync,
              isExported: Boolean(opts.isExported),
              returnType: effectiveRet,
              signature,
            });
            if (opts.isExported) {
              exportsList.push({
                name: b.name,
                localName: b.name,
                kind: fnInit.kind,
                isDefault: false,
                line: b.line,
                column: b.col,
              });
            }
          }
          addBinding(scope, b.name, {
            name: b.name,
            kind: fnInit.kind,
            line: b.line,
            column: b.col,
            arity: fnInit.arity,
            minArity: fnInit.minArity,
            hasRest: fnInit.hasRest,
            isAsync: fnInit.isAsync,
            isAbstract: false,
            returnType: effectiveRet,
            declaredType,
            signature,
            isFunction: true,
          }, hoistVar);

          if (exprStart >= 0) scanExpressionForScopes(exprStart, exprEnd, scope);
        } else {
          // Regular variable or destructured variables
          const endTok = tokens[Math.max(startIdx, (exprEnd > exprStart ? exprEnd : i) - 1)] || startTok;
          const signature = buildSignature(lines, startTok.line, startTok.col, endTok.line, endTok.endCol);
          const inf = exprStart >= 0 ? inferExprType(exprStart, exprEnd, scope) : { typeName: null, isAwaited: false };

          let inlineMembers = null;
          if (isSingleIdent && exprStart >= 0 && tokens[exprStart]?.value === "{") {
            const closeObj = pairIndex[exprStart];
            if (closeObj > exprStart && closeObj <= exprEnd) {
              if (!skipBodiesForSummary) {
                inlineMembers = parseObjectLiteralMembers(exprStart, closeObj, scope);
              }
              // Skip re-scanning the object literal below since parseObjectLiteralMembers already scanned nested expressions
              exprStart = closeObj + 1;
            }
          }

          if (exprStart >= 0 && exprStart < exprEnd) {
            scanExpressionForScopes(exprStart, exprEnd, scope);
          }

          for (let n = 0; n < pat.names.length; n += 1) {
            const b = pat.names[n];
            const varDeclaredType = isSingleIdent ? declaredType : null;
            const varInitType = isSingleIdent ? inf.typeName : null;
            const varBinding = {
              name: b.name,
              kind: declKind,
              line: b.line,
              column: b.col,
              declaredType: varDeclaredType,
              initializerType: varInitType,
              initializerIsAwaited: isSingleIdent ? inf.isAwaited : false,
              initializerCallChain: isSingleIdent ? inf.callChain : null,
              initializerRefChain: isSingleIdent ? inf.refChain : null,
              destructureSourceChain: !isSingleIdent && inf.refChain ? inf.refChain : null,
              destructurePropName: !isSingleIdent ? b.propName : null,
              destructurePatternType: !isSingleIdent ? declaredType : null,
              inlineMembers: isSingleIdent ? inlineMembers : null,
              signature,
              isFunction: false,
            };
            addBinding(scope, b.name, varBinding, hoistVar);

            if (scope === rootScope) {
              topVariables.push({
                name: b.name,
                kind: declKind,
                line: b.line,
                column: b.col,
                isExported: Boolean(opts.isExported),
                declaredType: varDeclaredType,
                initializerType: varInitType,
                signature,
              });
              if (opts.isExported) {
                exportsList.push({
                  name: b.name,
                  localName: b.name,
                  kind: declKind,
                  isDefault: false,
                  line: b.line,
                  column: b.col,
                });
              }
            }
          }
        }
      }

      if (i < limitEnd && tokens[i].value === ",") {
        i += 1;
        continue;
      }
      if (i < limitEnd && tokens[i].value === ";") {
        i += 1;
      }
      break;
    }
    return i;
  }

  function findArrowOrFuncHeaderEnd(exprStart, exprEnd) {
    for (let k = exprStart; k < exprEnd; k += 1) {
      if (tokens[k].value === "{" && pairIndex[k] > k && pairIndex[k] < exprEnd) {
        return tokens[k];
      }
    }
    return null;
  }

  function extractReturnTypeFromVarType(declaredType) {
    if (!declaredType) return null;
    const arrowPos = declaredType.lastIndexOf("=>");
    if (arrowPos >= 0) {
      return declaredType.slice(arrowPos + 2).trim() || null;
    }
    return null;
  }

  function detectRequireOrDynamicImport(exprStart, exprEnd) {
    let i = exprStart;
    let isAwaited = false;
    if (i < exprEnd && tokens[i].value === "await") {
      isAwaited = true;
      i += 1;
    }
    if (i >= exprEnd) return null;
    const fnTok = tokens[i];
    const isReq = fnTok.value === "require";
    const isDynImp = fnTok.value === "import" && isAwaited;
    if (!isReq && !isDynImp) return null;
    if (i + 1 >= exprEnd || tokens[i + 1].value !== "(") return null;
    const closeP = pairIndex[i + 1];
    if (closeP < i + 1 || closeP >= exprEnd) return null;

    const str = extractQuotedStringInSpan(lines, tokens[i + 1].line, tokens[i + 1].endCol, tokens[closeP].line, tokens[closeP].col);
    if (!str || !str.text) return null;

    let memberProp = null;
    if (closeP + 2 < exprEnd && (tokens[closeP + 1].value === "." || tokens[closeP + 1].value === "?.") && tokens[closeP + 2].type === "ident") {
      memberProp = tokens[closeP + 2].value;
    }
    return {
      isRequire: isReq,
      specifier: str.text,
      specRange: { line: str.line, startCol: str.startCol, endCol: str.endCol },
      memberProp,
    };
  }

  function parseForStatement(startIdx, limitEnd, scope) {
    const startTok = tokens[startIdx];
    let i = startIdx + 1;
    if (i < limitEnd && tokens[i].value === "await") i += 1;
    if (i >= limitEnd || tokens[i].value !== "(") return startIdx + 1;

    const closeP = pairIndex[i];
    if (closeP < i || closeP >= limitEnd) return i + 1;

    const bodyStart = closeP + 1;
    let bodyEnd = bodyStart;
    if (bodyStart < limitEnd && tokens[bodyStart].value === "{") {
      const closeB = pairIndex[bodyStart];
      bodyEnd = closeB > bodyStart && closeB < limitEnd ? closeB + 1 : bodyStart + 1;
    } else {
      bodyEnd = findStatementEnd(bodyStart, limitEnd);
    }

    const bodyEndTok = tokens[Math.max(closeP, bodyEnd - 1)] || tokens[closeP];
    const forScope = createScope("for", null, scope, startTok.line, startTok.col, bodyEndTok.line, bodyEndTok.endCol);

    // Parse header declarations `(const x of items)` or `(let i = 0; i < n; i++)`
    let h = i + 1;
    if (h < closeP && (tokens[h].value === "const" || tokens[h].value === "let" || tokens[h].value === "var")) {
      const hKind = tokens[h].value;
      const hoistVar = hKind === "var";
      h += 1;
      const pat = extractBindingPattern(tokens, pairIndex, h, closeP);
      for (let d = 0; d < pat.defaultExprSpans.length; d += 1) {
        const [ds, de] = pat.defaultExprSpans[d];
        scanExpressionForScopes(ds, de, forScope);
      }
      h = pat.endIdx;
      let declaredType = null;
      if (h < closeP && tokens[h].value === ":") {
        const tr = readTypeAnnotation(tokens, pairIndex, h + 1, closeP, STOP_FOR_HEADER);
        declaredType = tr.typeText;
        h = tr.endIdx;
      }
      for (let n = 0; n < pat.names.length; n += 1) {
        const b = pat.names[n];
        addBinding(forScope, b.name, {
          name: b.name,
          kind: hKind,
          line: b.line,
          column: b.col,
          declaredType: pat.names.length === 1 ? declaredType : null,
          initializerType: null,
          signature: `${hKind} ${b.name}`,
          isFunction: false,
        }, hoistVar);
      }
      scanExpressionForScopes(h, closeP, forScope);
    } else {
      scanExpressionForScopes(h, closeP, forScope);
    }

    if (bodyStart < limitEnd && tokens[bodyStart].value === "{") {
      const closeB = pairIndex[bodyStart];
      if (closeB > bodyStart && closeB < limitEnd) {
        parseBlockStatements(bodyStart + 1, closeB, forScope);
        return closeB + 1;
      }
    }
    parseDeclarationOrStatement(bodyStart, bodyEnd, forScope, { isExported: false, annotations: [] });
    return bodyEnd;
  }

  function parseTryStatement(startIdx, limitEnd, scope) {
    let i = startIdx + 1;
    if (i < limitEnd && tokens[i].value === "{") {
      const closeTry = pairIndex[i];
      if (closeTry > i && closeTry < limitEnd) {
        const tryScope = createScope("block", null, scope, tokens[i].line, tokens[i].col, tokens[closeTry].line, tokens[closeTry].endCol);
        parseBlockStatements(i + 1, closeTry, tryScope);
        i = closeTry + 1;
      }
    }
    if (i < limitEnd && tokens[i].value === "catch") {
      const catchTok = tokens[i];
      i += 1;
      let paramTokens = [];
      let closeP = -1;
      if (i < limitEnd && tokens[i].value === "(") {
        closeP = pairIndex[i];
        if (closeP > i && closeP < limitEnd) {
          const pat = extractBindingPattern(tokens, pairIndex, i + 1, closeP);
          let pType = null;
          if (pat.endIdx < closeP && tokens[pat.endIdx].value === ":") {
            pType = readTypeAnnotation(tokens, pairIndex, pat.endIdx + 1, closeP, STOP_CLOSE_PAREN).typeText;
          }
          paramTokens = pat.names.map((n) => ({ ...n, declaredType: pat.names.length === 1 ? pType : null }));
          i = closeP + 1;
        }
      }
      if (i < limitEnd && tokens[i].value === "{") {
        const closeCatch = pairIndex[i];
        if (closeCatch > i && closeCatch < limitEnd) {
          const catchScope = createScope("catch", null, scope, catchTok.line, catchTok.col, tokens[closeCatch].line, tokens[closeCatch].endCol);
          for (let p = 0; p < paramTokens.length; p += 1) {
            const pt = paramTokens[p];
            addBinding(catchScope, pt.name, {
              name: pt.name,
              kind: "parameter",
              line: pt.line,
              column: pt.col,
              declaredType: pt.declaredType,
              initializerType: null,
              signature: pt.declaredType ? `${pt.name}: ${pt.declaredType}` : pt.name,
              isFunction: false,
            });
          }
          parseBlockStatements(i + 1, closeCatch, catchScope);
          i = closeCatch + 1;
        }
      }
    }
    if (i < limitEnd && tokens[i].value === "finally") {
      i += 1;
      if (i < limitEnd && tokens[i].value === "{") {
        const closeFin = pairIndex[i];
        if (closeFin > i && closeFin < limitEnd) {
          const finScope = createScope("block", null, scope, tokens[i].line, tokens[i].col, tokens[closeFin].line, tokens[closeFin].endCol);
          parseBlockStatements(i + 1, closeFin, finScope);
          i = closeFin + 1;
        }
      }
    }
    return i;
  }

  function parseCjsExportStatement(startIdx, limitEnd, scope) {
    const endStmt = findStatementEnd(startIdx, limitEnd);
    let i = startIdx;
    if (tokens[i].value === "module" && tokens[i + 1]?.value === "." && tokens[i + 2]?.value === "exports") {
      i += 3;
      if (tokens[i]?.value === "." && tokens[i + 1]?.type === "ident" && tokens[i + 2]?.value === "=") {
        const propTok = tokens[i + 1];
        const rhsStart = i + 3;
        const rhsIdent = rhsStart < endStmt && tokens[rhsStart].type === "ident" && endStmt - rhsStart <= 2 ? tokens[rhsStart].value : propTok.value;
        exportsList.push({
          name: propTok.value,
          localName: rhsIdent,
          kind: "cjs",
          isDefault: false,
          line: propTok.line,
          column: propTok.col,
        });
        scanExpressionForScopes(rhsStart, endStmt, scope);
        return endStmt;
      }
      if (tokens[i]?.value === "=") {
        const rhsStart = i + 1;
        if (tokens[rhsStart]?.value === "{") {
          const closeObj = pairIndex[rhsStart];
          if (closeObj > rhsStart && closeObj <= endStmt) {
            const members = parseObjectLiteralMembers(rhsStart, closeObj, scope);
            for (const [mName, mem] of members.entries()) {
              exportsList.push({
                name: mName,
                localName: mem.kind === "field" && !mem.isShorthand && tokens[rhsStart + 1]?.type === "ident" ? mName : mName,
                kind: mem.kind === "method" ? "method" : "cjs",
                isDefault: false,
                line: mem.line,
                column: mem.column,
              });
              if ((mem.kind === "method" || mem.kind === "getter" || mem.kind === "setter") && scope === rootScope) {
                functions.push({
                  name: mName,
                  kind: "method",
                  line: mem.line,
                  column: mem.column,
                  endLine: mem.line,
                  arity: mem.arity || 0,
                  isAsync: Boolean(mem.isAsync),
                  isExported: true,
                  returnType: mem.returnType || null,
                  signature: mem.signature || mName,
                });
              }
            }
            return endStmt;
          }
        }
        if (tokens[rhsStart]?.value === "class") {
          const res = parseClassEntity(rhsStart, endStmt, scope, { isExported: true, isDefault: true, isStatement: true });
          return Math.max(endStmt, res.consumed);
        }
        if (tokens[rhsStart]?.value === "function" || (tokens[rhsStart]?.value === "async" && tokens[rhsStart + 1]?.value === "function")) {
          const res = parseFunctionEntity(rhsStart, endStmt, scope, { isExported: true, isDefault: true, isStatement: true });
          return Math.max(endStmt, res.consumed);
        }
        const rhsTok = tokens[rhsStart];
        exportsList.push({
          name: "default",
          localName: rhsTok?.type === "ident" ? rhsTok.value : "",
          kind: "cjs",
          isDefault: true,
          line: rhsTok?.line || tokens[startIdx].line,
          column: rhsTok?.col || tokens[startIdx].col,
        });
        scanExpressionForScopes(rhsStart, endStmt, scope);
        return endStmt;
      }
    } else if (tokens[i].value === "exports" && tokens[i + 1]?.value === "." && tokens[i + 2]?.type === "ident" && tokens[i + 3]?.value === "=") {
      const propTok = tokens[i + 2];
      const rhsStart = i + 4;
      const rhsIdent = rhsStart < endStmt && tokens[rhsStart].type === "ident" && endStmt - rhsStart <= 2 ? tokens[rhsStart].value : propTok.value;
      exportsList.push({
        name: propTok.value,
        localName: rhsIdent,
        kind: "cjs",
        isDefault: false,
        line: propTok.line,
        column: propTok.col,
      });
      scanExpressionForScopes(rhsStart, endStmt, scope);
      return endStmt;
    }
    scanExpressionForScopes(startIdx, endStmt, scope);
    return endStmt;
  }

  function parseDeclarationOrStatement(startIdx, limitEnd, scope, opts = {}) {
    if (startIdx >= limitEnd) return startIdx;
    let i = startIdx;
    const pendingAnnotations = opts.annotations ? opts.annotations.slice() : [];

    // Collect leading `@Decorator(...)` annotations
    while (i < limitEnd && tokens[i].value === "@") {
      i += 1;
      let decName = "";
      if (i < limitEnd && tokens[i].type === "ident") {
        decName = tokens[i].value;
        i += 1;
        while (i + 1 < limitEnd && tokens[i].value === "." && tokens[i + 1].type === "ident") {
          decName += "." + tokens[i + 1].value;
          i += 2;
        }
      }
      if (decName) pendingAnnotations.push(decName);
      if (i < limitEnd && tokens[i].value === "(") {
        const closeP = pairIndex[i];
        if (closeP > i && closeP < limitEnd) {
          scanExpressionForScopes(i + 1, closeP, scope);
          i = closeP + 1;
        }
      }
    }

    if (i >= limitEnd) return i;
    const tok = tokens[i];
    const v = tok.value;

    if (v === ";") return i + 1;

    if (v === "{") {
      const closeB = pairIndex[i];
      if (closeB > i && closeB < limitEnd) {
        const blockScope = createScope("block", null, scope, tok.line, tok.col, tokens[closeB].line, tokens[closeB].endCol);
        parseBlockStatements(i + 1, closeB, blockScope);
        return closeB + 1;
      }
      return i + 1;
    }

    if (v === "import" && tokens[i + 1]?.value !== "(" && tokens[i + 1]?.value !== ".") {
      return parseImportStatement(i, limitEnd);
    }

    if (v === "export") {
      return parseExportStatement(i, limitEnd, scope, pendingAnnotations);
    }

    if (v === "declare" && i + 1 < limitEnd && STATEMENT_START_KEYWORDS.has(tokens[i + 1].value)) {
      return parseDeclarationOrStatement(i + 1, limitEnd, scope, { ...opts, annotations: pendingAnnotations });
    }

    if (v === "function" || (v === "async" && tokens[i + 1]?.value === "function")) {
      const res = parseFunctionEntity(i, limitEnd, scope, { isExported: opts.isExported, isStatement: true });
      return res.consumed;
    }

    if (v === "class" || (v === "abstract" && tokens[i + 1]?.value === "class")) {
      const res = parseClassEntity(i, limitEnd, scope, { isExported: opts.isExported, annotations: pendingAnnotations, isStatement: true });
      return res.consumed;
    }

    if (v === "interface") {
      return parseInterfaceDeclaration(i, limitEnd, scope, { isExported: opts.isExported, annotations: pendingAnnotations });
    }

    if (v === "type" && i + 2 < limitEnd && tokens[i + 1].type === "ident" && (tokens[i + 2].value === "=" || tokens[i + 2].value === "<")) {
      return parseTypeAliasDeclaration(i, limitEnd, scope, { isExported: opts.isExported });
    }

    if (v === "enum" || (v === "const" && tokens[i + 1]?.value === "enum")) {
      return parseEnumDeclaration(i, limitEnd, scope, { isExported: opts.isExported });
    }

    if (v === "const" || v === "let" || v === "var") {
      return parseVariableDeclaration(i, limitEnd, scope, { isExported: opts.isExported });
    }

    if (v === "for") {
      return parseForStatement(i, limitEnd, scope);
    }

    if (v === "try") {
      return parseTryStatement(i, limitEnd, scope);
    }

    if (v === "if" || v === "while" || v === "switch" || v === "with") {
      i += 1;
      if (i < limitEnd && tokens[i].value === "(") {
        const closeP = pairIndex[i];
        if (closeP > i && closeP < limitEnd) {
          scanExpressionForScopes(i + 1, closeP, scope);
          i = closeP + 1;
        }
      }
      if (i < limitEnd && tokens[i].value === "{") {
        const closeB = pairIndex[i];
        if (closeB > i && closeB < limitEnd) {
          const bScope = createScope("block", null, scope, tokens[i].line, tokens[i].col, tokens[closeB].line, tokens[closeB].endCol);
          parseBlockStatements(i + 1, closeB, bScope);
          return closeB + 1;
        }
      }
      return parseDeclarationOrStatement(i, limitEnd, scope, { isExported: false, annotations: [] });
    }

    if (v === "else") {
      i += 1;
      return parseDeclarationOrStatement(i, limitEnd, scope, { isExported: false, annotations: [] });
    }

    if (v === "do") {
      i += 1;
      return parseDeclarationOrStatement(i, limitEnd, scope, { isExported: false, annotations: [] });
    }

    if (v === "case" || v === "default") {
      while (i < limitEnd && tokens[i].value !== ":") i += 1;
      if (i < limitEnd && tokens[i].value === ":") i += 1;
      return i;
    }

    if (v === "namespace" && tokens[i + 1]?.type === "ident") {
      const nsTok = tokens[i + 1];
      let j = i + 2;
      if (j < limitEnd && tokens[j].value === "{") {
        const closeB = pairIndex[j];
        if (closeB > j && closeB < limitEnd) {
          const nsScope = createScope("block", nsTok.value, scope, tok.line, tok.col, tokens[closeB].line, tokens[closeB].endCol);
          parseBlockStatements(j + 1, closeB, nsScope);
          return closeB + 1;
        }
      }
    }

    // Bare `require("...")` statement
    if (v === "require" && tokens[i + 1]?.value === "(") {
      const closeP = pairIndex[i + 1];
      if (closeP > i + 1 && closeP < limitEnd) {
        const endStmt = findStatementEnd(closeP + 1, limitEnd);
        const str = extractQuotedStringInSpan(lines, tokens[i + 1].line, tokens[i + 1].endCol, tokens[closeP].line, tokens[closeP].col);
        if (str && str.text) {
          const entry = {
            localName: "",
            importedName: null,
            specifier: str.text,
            isDefault: false,
            isNamespace: false,
            isTypeOnly: false,
            isRequire: true,
            line: str.line,
            column: str.startCol,
          };
          imports.push(entry);
          importStatements.push({
            startPos: toPos(tok.line, tok.col),
            endPos: toPos(tokens[Math.max(i, endStmt - 1)].line, tokens[Math.max(i, endStmt - 1)].endCol),
            specRange: { line: str.line, startCol: str.startCol, endCol: str.endCol },
            entries: [{ entry, localTok: null, importedTok: null }],
            isRequire: true,
          });
        }
        return endStmt;
      }
    }

    // `module.exports = ...` / `exports.foo = ...`
    if ((v === "module" && tokens[i + 1]?.value === "." && tokens[i + 2]?.value === "exports") || (v === "exports" && tokens[i + 1]?.value === ".")) {
      return parseCjsExportStatement(i, limitEnd, scope);
    }

    const endStmt = findStatementEnd(i, limitEnd);
    const nextIdx = Math.max(i + 1, endStmt);
    scanExpressionForScopes(i, nextIdx, scope);
    return nextIdx;
  }

  function parseBlockStatements(startIdx, endIdx, scope) {
    let i = startIdx;
    while (i < endIdx) {
      const next = parseDeclarationOrStatement(i, endIdx, scope, { isExported: false, annotations: [] });
      if (next <= i) i += 1;
      else i = next;
    }
  }

  parseBlockStatements(0, tokens.length, rootScope);

  // Deduplicate overload-only function entries when a concrete implementation exists with the same name
  const concreteFuncNames = new Set();
  for (let i = 0; i < functions.length; i += 1) {
    if (!functions[i]._isBodylessOverload) concreteFuncNames.add(functions[i].name);
  }
  const cleanFunctions = [];
  for (let i = 0; i < functions.length; i += 1) {
    const fn = functions[i];
    if (fn._isBodylessOverload && concreteFuncNames.has(fn.name)) continue;
    const { _isBodylessOverload, ...rest } = fn;
    cleanFunctions.push(rest);
  }

  // Propagate `isExported` for `export { foo }` / `module.exports = { foo }`
  const exportedLocalNames = new Set();
  for (let i = 0; i < exportsList.length; i += 1) {
    if (exportsList[i].localName) exportedLocalNames.add(exportsList[i].localName);
  }
  for (let i = 0; i < types.length; i += 1) {
    if (exportedLocalNames.has(types[i].name)) types[i].isExported = true;
  }
  for (let i = 0; i < cleanFunctions.length; i += 1) {
    if (exportedLocalNames.has(cleanFunctions[i].name)) cleanFunctions[i].isExported = true;
  }
  for (let i = 0; i < topVariables.length; i += 1) {
    if (exportedLocalNames.has(topVariables[i].name)) topVariables[i].isExported = true;
  }

  return {
    summary: {
      lang: "js",
      path: filePath,
      packageName: "",
      imports,
      exports: exportsList,
      reExports,
      types,
      functions: cleanFunctions,
      topVariables,
    },
    lines,
    maskedLines,
    tokens,
    pairIndex,
    rootScope,
    typeModels,
    importStatements,
    reExportStatements,
  };
}

/**
 * Strip internal metadata keys from summary objects for clean external output.
 */
function cleanSummaryForOutput(summary) {
  return {
    lang: summary.lang,
    path: summary.path,
    packageName: summary.packageName,
    imports: summary.imports,
    exports: summary.exports,
    reExports: summary.reExports,
    types: summary.types.map((t) => ({
      name: t.name,
      kind: t.kind,
      line: t.line,
      column: t.column,
      endLine: t.endLine,
      isAbstract: t.isAbstract,
      isExported: t.isExported,
      extends: t.extends,
      implements: t.implements,
      annotations: t.annotations,
      fields: t.fields,
      constructors: t.constructors.map((c) => ({
        line: c.line,
        column: c.column,
        arity: c.arity,
        signature: c.signature,
      })),
      methods: t.methods.map((m) => ({
        name: m.name,
        kind: m.kind,
        line: m.line,
        column: m.column,
        arity: m.arity,
        isAbstract: m.isAbstract,
        isDefault: m.isDefault,
        isStatic: m.isStatic,
        returnType: m.returnType,
        signature: m.signature,
      })),
    })),
    functions: summary.functions,
    topVariables: summary.topVariables,
  };
}

/**
 * Extract structured symbol summary for a JS/TS/JSX/TSX file.
 */
export function extractFileSymbolSummary(sourceText, filePath = "") {
  const text = typeof sourceText === "string" ? sourceText : "";
  if (!isNavSourceWithinLimits(text)) {
    return {
      lang: "js",
      path: filePath || "",
      packageName: "",
      imports: [],
      exports: [],
      reExports: [],
      types: [],
      functions: [],
      topVariables: [],
    };
  }
  const parsed = parseJsModule(text, filePath, { summaryOnly: true });
  return cleanSummaryForOutput(parsed.summary);
}

function findEnclosingScope(rootScope, line, col) {
  const pos = toPos(line, col);
  let cur = rootScope;
  while (cur && cur.children && cur.children.length > 0) {
    let matched = null;
    for (let i = 0; i < cur.children.length; i += 1) {
      const ch = cur.children[i];
      if (pos >= ch.startPos && pos <= ch.endPos) {
        if (!matched || (ch.endPos - ch.startPos) < (matched.endPos - matched.startPos)) {
          matched = ch;
        }
      }
    }
    if (!matched) break;
    cur = matched;
  }
  return cur;
}

function getEnclosingContainerName(scope) {
  let cur = scope;
  let nearestFunc = null;
  while (cur && cur.kind !== "module") {
    if (cur.kind === "class" && cur.name) return cur.name;
    if (!nearestFunc && (cur.kind === "function" || cur.kind === "arrow" || cur.kind === "method") && cur.name) {
      nearestFunc = cur.name;
    }
    cur = cur.parent;
  }
  return nearestFunc;
}

function findEnclosingClassScope(scope) {
  let cur = scope;
  while (cur) {
    if (cur.kind === "class" && cur.ownerType) return cur;
    // Regular non-arrow function expressions/declarations rebind `this`
    if (cur.kind === "function") return null;
    cur = cur.parent;
  }
  return null;
}

function lookupBindingsInScopeChain(scope, name, isTypeContext) {
  let cur = scope;
  while (cur) {
    const list = cur.bindings.get(name);
    if (list && list.length > 0) {
      if (list.length === 1) return { scope: cur, bindings: list };
      // If TS value+type declaration merging exists in same scope, prefer matching namespace
      const filtered = list.filter((b) => (isTypeContext ? (b.isType || b.kind === "import") : (b.isValue !== false || b.kind === "import")));
      return { scope: cur, bindings: filtered.length > 0 ? filtered : list };
    }
    cur = cur.parent;
  }
  return null;
}

function buildImportHint(opts) {
  return {
    typeName: opts.typeName || null,
    memberName: opts.memberName || null,
    importedName: opts.importedName !== undefined ? opts.importedName : null,
    specifier: opts.specifier || "",
    qualifiedName: opts.qualifiedName || null,
    isDefault: Boolean(opts.isDefault),
    isNamespace: Boolean(opts.isNamespace),
    isTypeOnly: Boolean(opts.isTypeOnly),
    isRequire: Boolean(opts.isRequire),
    isTypeContext: Boolean(opts.isTypeContext),
    arity: Number.isFinite(opts.arity) ? opts.arity : null,
    fallbackLine: Math.max(1, Number(opts.fallbackLine) || 1),
    fallbackColumn: Math.max(1, Number(opts.fallbackColumn) || 1),
  };
}

function findImportOrReExportAtCursor(parsed, line, col, symbol) {
  const pos = toPos(line, col);

  for (let i = 0; i < parsed.importStatements.length; i += 1) {
    const st = parsed.importStatements[i];
    if (pos < st.startPos || pos > st.endPos) continue;
    if (st.specRange && line === st.specRange.line && col >= st.specRange.startCol - 1 && col <= st.specRange.endCol + 1) {
      return {
        isSpecifierClick: true,
        specifier: st.entries[0]?.entry.specifier || "",
        isRequire: st.isRequire,
        isTypeOnly: Boolean(st.isTypeOnly),
        line: st.specRange.line,
        column: st.specRange.startCol,
      };
    }
    if (symbol === "require" && st.isRequire) {
      return {
        isSpecifierClick: true,
        specifier: st.entries[0]?.entry.specifier || "",
        isRequire: true,
        isTypeOnly: false,
        line,
        column: col,
      };
    }
    for (let e = 0; e < st.entries.length; e += 1) {
      const item = st.entries[e];
      if (item.localTok && item.localTok.line === line && Math.abs(item.localTok.col - col) <= 1) {
        return { isSpecifierClick: false, entry: item.entry, line: item.localTok.line, column: item.localTok.col };
      }
      if (item.importedTok && item.importedTok.line === line && Math.abs(item.importedTok.col - col) <= 1) {
        return { isSpecifierClick: false, entry: item.entry, line: item.importedTok.line, column: item.importedTok.col };
      }
    }
    for (let e = 0; e < st.entries.length; e += 1) {
      const item = st.entries[e];
      if (item.entry.localName === symbol || item.entry.importedName === symbol) {
        return { isSpecifierClick: false, entry: item.entry, line, column: col };
      }
    }
  }

  for (let i = 0; i < parsed.reExportStatements.length; i += 1) {
    const st = parsed.reExportStatements[i];
    if (pos < st.startPos || pos > st.endPos) continue;
    if (st.specRange && line === st.specRange.line && col >= st.specRange.startCol - 1 && col <= st.specRange.endCol + 1) {
      return {
        isSpecifierClick: true,
        specifier: st.entries[0]?.entry.specifier || "",
        isRequire: false,
        isTypeOnly: false,
        line: st.specRange.line,
        column: st.specRange.startCol,
      };
    }
    for (let e = 0; e < st.entries.length; e += 1) {
      const item = st.entries[e];
      if (
        (item.localTok && item.localTok.line === line && Math.abs(item.localTok.col - col) <= 1) ||
        (item.origTok && item.origTok.line === line && Math.abs(item.origTok.col - col) <= 1) ||
        item.entry.exportedName === symbol ||
        item.entry.localName === symbol
      ) {
        return {
          isSpecifierClick: false,
          entry: {
            localName: item.entry.exportedName,
            importedName: item.entry.localName,
            specifier: item.entry.specifier,
            isDefault: item.entry.localName === "default",
            isNamespace: item.entry.isStar,
            isTypeOnly: false,
            isRequire: false,
            line,
            column: col,
          },
          line,
          column: col,
        };
      }
    }
  }

  return null;
}

function findSpecClickFallback(parsed, line, col) {
  const all = [...parsed.importStatements, ...parsed.reExportStatements];
  for (let i = 0; i < all.length; i += 1) {
    const st = all[i];
    if (st.specRange && line === st.specRange.line && col >= st.specRange.startCol - 1 && col <= st.specRange.endCol + 1) {
      return {
        specifier: st.entries[0]?.entry.specifier || "",
        isRequire: Boolean(st.isRequire),
        isTypeOnly: Boolean(st.isTypeOnly),
        line: st.specRange.line,
        column: st.specRange.startCol,
      };
    }
  }
  return null;
}

/**
 * Resolve concrete / interface / inherited members on a local TypeModel.
 */
function resolveLocalTypeMembers(typeModel, memberName, parsed, ctx, filePath, visited = new Set(), depth = 0) {
  if (!typeModel || visited.has(typeModel)) return { candidates: [], importedBase: null };
  visited.add(typeModel);

  const candidates = [];
  const depthPenalty = depth * 10;

  for (let i = 0; i < typeModel.methods.length; i += 1) {
    const m = typeModel.methods[i];
    if (m.name !== memberName) continue;
    const baseScore = (ctx.isCall ? (m.isAbstract ? 80 : 100) : 90) - depthPenalty;
    candidates.push(normalizeNavCandidate({
      filePath,
      line: m.line,
      column: m.column,
      name: m.name,
      kind: m.kind,
      containerName: typeModel.name,
      signature: m.signature,
      isAbstract: m.isAbstract,
      isDefault: m.isDefault,
      arity: m.arity,
      lang: "js",
      exactScope: depth === 0,
      score: baseScore,
    }));
  }

  for (let i = 0; i < typeModel.fields.length; i += 1) {
    const f = typeModel.fields[i];
    if (f.name !== memberName) continue;
    const baseScore = (ctx.isCall ? 65 : 100) - depthPenalty;
    candidates.push(normalizeNavCandidate({
      filePath,
      line: f.line,
      column: f.column,
      name: f.name,
      kind: typeModel.kind === "enum" ? "enumMember" : "field",
      containerName: typeModel.name,
      signature: f.signature,
      isAbstract: false,
      isDefault: false,
      arity: null,
      lang: "js",
      exactScope: depth === 0,
      score: baseScore,
    }));
  }

  // Polymorphic lookup: if `typeModel` is an interface or abstract class and cursor is a call,
  // find local concrete classes implementing or extending it.
  if (depth === 0 && (typeModel.isAbstract || typeModel.kind === "interface")) {
    const implModels = findLocalImplementations(typeModel.name, parsed);
    for (let k = 0; k < implModels.length; k += 1) {
      const impl = implModels[k];
      for (let mIdx = 0; mIdx < impl.methods.length; mIdx += 1) {
        const m = impl.methods[mIdx];
        if (m.name !== memberName || m.isAbstract) continue;
        candidates.push(normalizeNavCandidate({
          filePath,
          line: m.line,
          column: m.column,
          name: m.name,
          kind: m.kind,
          containerName: impl.name,
          signature: m.signature,
          isAbstract: false,
          isDefault: false,
          arity: m.arity,
          lang: "js",
          exactScope: false,
          score: 100,
        }));
      }
    }
  }

  // Walk base `extends` chain
  let importedBase = null;
  for (let e = 0; e < typeModel.extends.length; e += 1) {
    const baseName = typeModel.extends[e];
    const shortBase = baseName.includes(".") ? baseName.slice(baseName.lastIndexOf(".") + 1) : baseName;
    const baseModels = parsed.typeModels.get(shortBase) || parsed.typeModels.get(baseName);
    if (baseModels && baseModels.length > 0) {
      for (let b = 0; b < baseModels.length; b += 1) {
        const sub = resolveLocalTypeMembers(baseModels[b], memberName, parsed, ctx, filePath, visited, depth + 1);
        candidates.push(...sub.candidates);
        if (!importedBase && sub.importedBase) importedBase = sub.importedBase;
      }
    } else if (!importedBase) {
      const impFound = lookupBindingsInScopeChain(parsed.rootScope, shortBase, true);
      if (impFound && impFound.bindings[0]?.kind === "import") {
        importedBase = { baseName: shortBase, binding: impFound.bindings[0] };
      }
    }
  }

  return { candidates, importedBase };
}

function getJsSubtypeMap(parsed) {
  if (parsed._subtypeMap) return parsed._subtypeMap;
  const map = new Map();
  const allTypes = parsed.summary.types;
  for (let i = 0; i < allTypes.length; i += 1) {
    const t = allTypes[i];
    const ext = t.extends;
    for (let j = 0; j < ext.length; j += 1) {
      const p = ext[j];
      const short = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1) : p;
      let list = map.get(p);
      if (!list) { list = []; map.set(p, list); }
      list.push(t);
      if (short !== p) {
        let sList = map.get(short);
        if (!sList) { sList = []; map.set(short, sList); }
        sList.push(t);
      }
    }
    const imp = t.implements;
    for (let j = 0; j < imp.length; j += 1) {
      const p = imp[j];
      const short = p.includes(".") ? p.slice(p.lastIndexOf(".") + 1) : p;
      let list = map.get(p);
      if (!list) { list = []; map.set(p, list); }
      list.push(t);
      if (short !== p) {
        let sList = map.get(short);
        if (!sList) { sList = []; map.set(short, sList); }
        sList.push(t);
      }
    }
  }
  parsed._subtypeMap = map;
  return map;
}

function findLocalImplementations(targetName, parsed) {
  const queue = [targetName];
  let head = 0;
  const seen = new Set([targetName]);
  const results = [];
  const subtypeMap = getJsSubtypeMap(parsed);

  while (head < queue.length) {
    const cur = queue[head++];
    const children = subtypeMap.get(cur);
    if (!children) continue;
    for (let i = 0; i < children.length; i += 1) {
      const t = children[i];
      if (!seen.has(t.name)) {
        seen.add(t.name);
        queue.push(t.name);
        if (!t.isAbstract && t.kind === "class") {
          results.push(t);
        }
      }
    }
  }
  return results;
}

function resolveBindingTypeNames(binding, scope, parsed, depth = 0) {
  if (!binding || depth > 4) return [];
  const out = [];
  const addType = (name) => {
    if (name && !out.includes(name)) out.push(name);
  };

  if (binding.declaredType) {
    const prims = extractPrimaryTypeNames(binding.declaredType, false);
    for (let i = 0; i < prims.length; i += 1) addType(prims[i]);
  }
  if (binding.initializerType) {
    const prims = extractPrimaryTypeNames(binding.initializerType, Boolean(binding.initializerIsAwaited));
    for (let i = 0; i < prims.length; i += 1) addType(prims[i]);
  }
  if (out.length > 0) return out;

  // Destructured binding from typed parameter pattern e.g. `({ repo }: Options)`
  if (binding.destructurePatternType && binding.destructurePropName) {
    const patTypes = extractPrimaryTypeNames(binding.destructurePatternType, false);
    for (let t = 0; t < patTypes.length; t += 1) {
      const models = parsed.typeModels.get(patTypes[t]);
      if (!models) continue;
      for (let m = 0; m < models.length; m += 1) {
        const field = models[m].fields.find((f) => f.name === binding.destructurePropName);
        if (field && (field.typeName || field.initializerType)) {
          const fTypes = extractPrimaryTypeNames(field.typeName || field.initializerType, false);
          for (let ft = 0; ft < fTypes.length; ft += 1) addType(fTypes[ft]);
        }
      }
    }
    if (out.length > 0) return out;
  }

  // `const u = await fetchUser(1)` -> resolve `fetchUser` return type
  if (binding.initializerCallChain && binding.initializerCallChain.length > 0) {
    const ret = resolveChainReturnTypes(binding.initializerCallChain, Boolean(binding.initializerIsAwaited), scope, parsed, depth + 1);
    for (let i = 0; i < ret.length; i += 1) addType(ret[i]);
  }

  // `const x = otherVar` or `const x = this.field`
  if (binding.initializerRefChain && binding.initializerRefChain.length > 0) {
    const refTypes = resolveChainValueTypes(binding.initializerRefChain, scope, parsed, depth + 1);
    for (let i = 0; i < refTypes.length; i += 1) addType(refTypes[i]);
  }

  // `const { repo } = this` or `const { repo } = svc`
  if (binding.destructureSourceChain && binding.destructurePropName) {
    const srcTypes = resolveChainValueTypes(binding.destructureSourceChain, scope, parsed, depth + 1);
    for (let s = 0; s < srcTypes.length; s += 1) {
      const models = parsed.typeModels.get(srcTypes[s]);
      if (!models) continue;
      for (let m = 0; m < models.length; m += 1) {
        const field = models[m].fields.find((f) => f.name === binding.destructurePropName);
        if (field && (field.typeName || field.initializerType)) {
          const fTypes = extractPrimaryTypeNames(field.typeName || field.initializerType, false);
          for (let ft = 0; ft < fTypes.length; ft += 1) addType(fTypes[ft]);
        }
      }
    }
  }

  return out;
}

function resolveChainReturnTypes(chain, isAwaited, scope, parsed, depth) {
  if (depth > 4 || !chain || chain.length === 0) return [];
  if (chain.length === 1) {
    const found = lookupBindingsInScopeChain(scope, chain[0], false);
    if (!found) return [];
    const out = [];
    for (let i = 0; i < found.bindings.length; i += 1) {
      const b = found.bindings[i];
      if (b.returnType) {
        const prims = extractPrimaryTypeNames(b.returnType, isAwaited);
        for (let p = 0; p < prims.length; p += 1) {
          if (!out.includes(prims[p])) out.push(prims[p]);
        }
      }
    }
    return out;
  }

  const recvTypes = resolveChainValueTypes(chain.slice(0, -1), scope, parsed, depth + 1);
  const methodName = chain[chain.length - 1];
  const out = [];
  for (let t = 0; t < recvTypes.length; t += 1) {
    const models = parsed.typeModels.get(recvTypes[t]);
    if (!models) continue;
    for (let m = 0; m < models.length; m += 1) {
      const meth = models[m].methods.find((x) => x.name === methodName);
      if (meth && meth.returnType) {
        const prims = extractPrimaryTypeNames(meth.returnType, isAwaited);
        for (let p = 0; p < prims.length; p += 1) {
          if (!out.includes(prims[p])) out.push(prims[p]);
        }
      }
    }
  }
  return out;
}

function resolveChainValueTypes(chain, scope, parsed, depth = 0) {
  if (depth > 4 || !chain || chain.length === 0) return [];
  let currentTypes = [];
  let startIdx = 1;

  if (chain[0] === "this") {
    const clsScope = findEnclosingClassScope(scope);
    if (clsScope && clsScope.ownerType?.name) {
      currentTypes = [clsScope.ownerType.name];
    }
  } else if (chain[0] === "super") {
    const clsScope = findEnclosingClassScope(scope);
    if (clsScope && clsScope.ownerType?.extends?.length > 0) {
      currentTypes = [clsScope.ownerType.extends[0]];
    }
  } else {
    const found = lookupBindingsInScopeChain(scope, chain[0], false);
    if (found) {
      for (let i = 0; i < found.bindings.length; i += 1) {
        const b = found.bindings[i];
        if (b.kind === "class" || b.kind === "interface" || b.kind === "enum") {
          currentTypes.push(b.name);
        } else {
          const inf = resolveBindingTypeNames(b, found.scope, parsed, depth + 1);
          for (let k = 0; k < inf.length; k += 1) {
            if (!currentTypes.includes(inf[k])) currentTypes.push(inf[k]);
          }
        }
      }
    }
  }

  for (let idx = startIdx; idx < chain.length; idx += 1) {
    const member = chain[idx];
    const nextTypes = [];
    for (let t = 0; t < currentTypes.length; t += 1) {
      const models = parsed.typeModels.get(currentTypes[t]);
      if (!models) continue;
      for (let m = 0; m < models.length; m += 1) {
        const model = models[m];
        const field = model.fields.find((f) => f.name === member);
        if (field && (field.typeName || field.initializerType)) {
          const fTypes = extractPrimaryTypeNames(field.typeName || field.initializerType, false);
          for (let ft = 0; ft < fTypes.length; ft += 1) {
            if (!nextTypes.includes(fTypes[ft])) nextTypes.push(fTypes[ft]);
          }
        }
        const getter = model.methods.find((x) => x.name === member && x.kind === "getter");
        if (getter && getter.returnType) {
          const gTypes = extractPrimaryTypeNames(getter.returnType, false);
          for (let gt = 0; gt < gTypes.length; gt += 1) {
            if (!nextTypes.includes(gTypes[gt])) nextTypes.push(gTypes[gt]);
          }
        }
      }
    }
    currentTypes = nextTypes;
    if (currentTypes.length === 0) break;
  }

  return currentTypes;
}

function buildBindingCandidate(binding, filePath, ctx) {
  const isTypeLike = binding.kind === "class" || binding.kind === "interface" || binding.kind === "type" || binding.kind === "enum";
  let score = 90;
  if (ctx.isTypeContext && isTypeLike) score += 20;
  if (!ctx.isTypeContext && !isTypeLike) score += 15;
  if (ctx.isCall && binding.isFunction) score += 15;

  return normalizeNavCandidate({
    filePath,
    line: binding.line,
    column: binding.column,
    name: binding.name,
    kind: binding.kind,
    containerName: "",
    signature: binding.signature || binding.name,
    isAbstract: Boolean(binding.isAbstract || binding.kind === "interface"),
    isDefault: false,
    arity: Number.isFinite(binding.arity) ? binding.arity : null,
    lang: "js",
    exactScope: true,
    score,
  });
}

function extractPrecedingCallChain(maskedLine, tokenCol1Based) {
  let pos = tokenCol1Based - 2;
  while (pos >= 0 && maskedLine[pos] === " ") pos -= 1;
  if (pos < 0 || maskedLine[pos] !== ".") return null;
  pos -= 1;
  if (pos >= 0 && maskedLine[pos] === "?") pos -= 1;
  while (pos >= 0 && maskedLine[pos] === " ") pos -= 1;
  if (pos < 0 || maskedLine[pos] !== ")") return null;

  let depth = 1;
  pos -= 1;
  while (pos >= 0 && depth > 0) {
    if (maskedLine[pos] === ")") depth += 1;
    else if (maskedLine[pos] === "(") depth -= 1;
    pos -= 1;
  }
  if (depth !== 0) return null;
  while (pos >= 0 && maskedLine[pos] === " ") pos -= 1;
  if (pos < 0 || !isNavIdentPart(maskedLine[pos])) return null;

  // Walk dotted identifier chain backwards
  const chain = [];
  let firstIdentStart = -1;
  while (pos >= 0) {
    let end = pos + 1;
    let start = pos;
    while (start > 0 && isNavIdentPart(maskedLine[start - 1])) start -= 1;
    if (!isNavIdentStart(maskedLine[start])) break;
    firstIdentStart = start;
    chain.unshift(maskedLine.slice(start, end));
    let p = start - 1;
    while (p >= 0 && maskedLine[p] === " ") p -= 1;
    if (p >= 0 && maskedLine[p] === ".") {
      p -= 1;
      if (p >= 0 && maskedLine[p] === "?") p -= 1;
      while (p >= 0 && maskedLine[p] === " ") p -= 1;
      if (p >= 0 && isNavIdentPart(maskedLine[p])) {
        pos = p;
        continue;
      }
    }
    break;
  }

  if (chain.length === 0 || firstIdentStart < 0) return null;
  const beforeStr = maskedLine.slice(0, firstIdentStart).trimEnd();
  const isAwaited = beforeStr.endsWith("await");
  return { chain, isAwaited };
}

/**
 * Resolve cursor target inside `sourceText` at `contextOrPos` (context object or `{ line, col }`).
 */
export function resolveInFile(sourceText, contextOrPos, filePath = "") {
  const emptyResult = (enclosingContainer = null) => ({
    resolved: [],
    importHint: null,
    memberTypeHints: [],
    enclosingContainer,
  });

  const text = typeof sourceText === "string" ? sourceText : "";
  if (!isNavSourceWithinLimits(text) || !contextOrPos || typeof contextOrPos !== "object") {
    return emptyResult(null);
  }

  const effectivePath = filePath || "";
  let ctx = contextOrPos;
  let parsed = null;
  if (!ctx.symbol && !ctx.importModuleSpec) {
    const reqLine = Number(ctx.line || 0);
    const reqCol = Number(ctx.col ?? ctx.column ?? 1);
    const extracted = extractNavContext(text, reqLine, reqCol, effectivePath || "file.ts");
    if (!extracted) {
      parsed = parseJsModule(text, filePath);
      const scopeAtPos = reqLine >= 1 ? findEnclosingScope(parsed.rootScope, reqLine, reqCol) : null;
      const enc = getEnclosingContainerName(scopeAtPos);
      const specHit = findSpecClickFallback(parsed, reqLine, reqCol);
      if (specHit && specHit.specifier) {
        return {
          resolved: [],
          importHint: buildImportHint({
            specifier: specHit.specifier,
            importedName: null,
            isRequire: specHit.isRequire,
            isTypeOnly: specHit.isTypeOnly,
            fallbackLine: specHit.line,
            fallbackColumn: specHit.column,
          }),
          memberTypeHints: [],
          enclosingContainer: enc,
        };
      }
      return emptyResult(enc);
    }
    ctx = extracted;
  }

  if (!parsed) {
    parsed = parseJsModule(text, filePath, {
      lines: ctx.lines,
      maskedLines: ctx.maskedLines,
    });
  }

  const innermostScope = findEnclosingScope(parsed.rootScope, ctx.line, ctx.col);
  const enclosingContainer = getEnclosingContainerName(innermostScope);

  // 1. Direct click inside an import/re-export/require statement or specifier string
  if (ctx.importModuleSpec && (!ctx.symbol || ctx.symbol === ctx.importModuleSpec || ctx.symbol.includes("/"))) {
    const stmtMatch = findImportOrReExportAtCursor(parsed, ctx.line, ctx.col, ctx.symbol);
    return {
      resolved: [],
      importHint: buildImportHint({
        specifier: ctx.importModuleSpec,
        importedName: null,
        isRequire: Boolean(stmtMatch?.isRequire || (ctx.lineText && ctx.lineText.includes("require("))),
        isTypeOnly: Boolean(stmtMatch?.isTypeOnly),
        isTypeContext: Boolean(ctx.isTypeContext),
        arity: ctx.arity,
        fallbackLine: ctx.line,
        fallbackColumn: ctx.col,
      }),
      memberTypeHints: [],
      enclosingContainer,
    };
  }

  const importLineHit = findImportOrReExportAtCursor(parsed, ctx.line, ctx.col, ctx.symbol);
  if (importLineHit) {
    if (importLineHit.isSpecifierClick) {
      return {
        resolved: [],
        importHint: buildImportHint({
          specifier: importLineHit.specifier,
          importedName: null,
          isRequire: importLineHit.isRequire,
          isTypeOnly: importLineHit.isTypeOnly,
          isTypeContext: Boolean(ctx.isTypeContext),
          arity: ctx.arity,
          fallbackLine: importLineHit.line,
          fallbackColumn: importLineHit.column,
        }),
        memberTypeHints: [],
        enclosingContainer,
      };
    }
    const ent = importLineHit.entry;
    return {
      resolved: [],
      importHint: buildImportHint({
        typeName: null,
        memberName: null,
        importedName: ent.importedName,
        specifier: ent.specifier,
        qualifiedName: null,
        isDefault: ent.isDefault,
        isNamespace: ent.isNamespace,
        isTypeOnly: ent.isTypeOnly,
        isRequire: ent.isRequire,
        isTypeContext: Boolean(ctx.isTypeContext || ent.isTypeOnly),
        arity: ctx.arity,
        fallbackLine: importLineHit.line,
        fallbackColumn: importLineHit.column,
      }),
      memberTypeHints: [],
      enclosingContainer,
    };
  }

  const qualifierChain = Array.isArray(ctx.qualifierChain) && ctx.qualifierChain.length > 0
    ? ctx.qualifierChain
    : [ctx.symbol];
  const memberIndex = Number.isInteger(ctx.memberIndex) && ctx.memberIndex >= 0
    ? ctx.memberIndex
    : 0;
  const receiverChain = qualifierChain.slice(0, memberIndex);

  // 2. Chained call expression receiver fallback e.g. `getService().save()`
  if (receiverChain.length === 0) {
    const lineForCall = (ctx.maskedLines && ctx.maskedLines[ctx.line - 1]) || parsed.maskedLines[ctx.line - 1] || "";
    const preceding = extractPrecedingCallChain(lineForCall, ctx.col);
    if (preceding) {
      const retTypes = resolveChainReturnTypes(preceding.chain, preceding.isAwaited, innermostScope, parsed, 0);
      if (retTypes.length > 0) {
        return resolveMemberOnTypeNames(retTypes, ctx.symbol, parsed, ctx, effectivePath, enclosingContainer);
      }
    }
  }

  // 3. Receiver chain member resolution (`this.repo.find`, `svc.save`, `ns.helper`, `Status.Active`)
  if (receiverChain.length > 0) {
    // Check if receiverChain[0] is an imported namespace / require module / imported value
    if (receiverChain[0] !== "this" && receiverChain[0] !== "super") {
      const firstFound = lookupBindingsInScopeChain(innermostScope, receiverChain[0], false);
      if (firstFound && firstFound.bindings[0]?.kind === "import") {
        const imp = firstFound.bindings[0].importMeta;
        if (receiverChain.length === 1 && (imp.isNamespace || imp.isRequire)) {
          return {
            resolved: [],
            importHint: buildImportHint({
              typeName: null,
              memberName: ctx.symbol,
              importedName: ctx.symbol,
              specifier: imp.specifier,
              qualifiedName: `${imp.localName}.${ctx.symbol}`,
              isDefault: false,
              isNamespace: imp.isNamespace,
              isTypeOnly: imp.isTypeOnly,
              isRequire: imp.isRequire,
              isTypeContext: Boolean(ctx.isTypeContext),
              arity: ctx.arity,
              fallbackLine: imp.line,
              fallbackColumn: imp.column,
            }),
            memberTypeHints: [],
            enclosingContainer,
          };
        }
        if (receiverChain.length === 1) {
          // Imported symbol `UserService.create()` or `userApi.fetchUser()`
          const isTypeLike = /^[A-Z]/.test(imp.localName);
          return {
            resolved: [],
            importHint: buildImportHint({
              typeName: isTypeLike ? imp.localName : null,
              memberName: ctx.symbol,
              importedName: imp.importedName,
              specifier: imp.specifier,
              qualifiedName: `${imp.localName}.${ctx.symbol}`,
              isDefault: imp.isDefault,
              isNamespace: imp.isNamespace,
              isTypeOnly: imp.isTypeOnly,
              isRequire: imp.isRequire,
              isTypeContext: Boolean(ctx.isTypeContext),
              arity: ctx.arity,
              fallbackLine: imp.line,
              fallbackColumn: imp.column,
            }),
            memberTypeHints: isTypeLike ? [imp.localName] : [],
            enclosingContainer,
          };
        }
      }

      // Check inline object literal members (`const api = { fetchUser() {} }; api.fetchUser()`)
      if (receiverChain.length === 1 && firstFound && firstFound.bindings[0]?.inlineMembers) {
        const mem = firstFound.bindings[0].inlineMembers.get(ctx.symbol);
        if (mem) {
          const cand = normalizeNavCandidate({
            filePath: effectivePath,
            line: mem.line,
            column: mem.column,
            name: mem.name,
            kind: mem.kind,
            containerName: firstFound.bindings[0].name,
            signature: mem.signature,
            arity: Number.isFinite(mem.arity) ? mem.arity : null,
            lang: "js",
            exactScope: true,
            score: 100,
          });
          const filtered = cand && !isSameNavLocation(cand, ctx.line, ctx.col) ? [cand] : [];
          return {
            resolved: rankNavCandidates(filtered, ctx),
            importHint: null,
            memberTypeHints: [],
            enclosingContainer,
          };
        }
      }
    }

    const receiverTypeNames = resolveChainValueTypes(receiverChain, innermostScope, parsed);
    if (receiverTypeNames.length > 0) {
      return resolveMemberOnTypeNames(receiverTypeNames, ctx.symbol, parsed, ctx, effectivePath, enclosingContainer);
    }

    return {
      resolved: [],
      importHint: null,
      memberTypeHints: [],
      enclosingContainer,
    };
  }

  // 4. Bare identifier resolution (`memberIndex === 0`)
  if (ctx.symbol === "this") {
    const clsScope = findEnclosingClassScope(innermostScope);
    if (clsScope && clsScope.ownerType) {
      const clsCand = normalizeNavCandidate({
        filePath: effectivePath,
        line: clsScope.ownerType.line,
        column: clsScope.ownerType.column,
        name: clsScope.ownerType.name,
        kind: "class",
        containerName: "",
        signature: `class ${clsScope.ownerType.name}`,
        isAbstract: clsScope.ownerType.isAbstract,
        lang: "js",
        exactScope: true,
        score: 100,
      });
      const filtered = clsCand && !isSameNavLocation(clsCand, ctx.line, ctx.col) ? [clsCand] : [];
      return {
        resolved: rankNavCandidates(filtered, ctx),
        importHint: null,
        memberTypeHints: [],
        enclosingContainer,
      };
    }
    return emptyResult(enclosingContainer);
  }

  if (ctx.symbol === "super") {
    const clsScope = findEnclosingClassScope(innermostScope);
    const baseName = clsScope?.ownerType?.extends?.[0];
    if (baseName) {
      const shortBase = baseName.includes(".") ? baseName.slice(baseName.lastIndexOf(".") + 1) : baseName;
      return resolveBareSymbol(shortBase, parsed.rootScope, parsed, { ...ctx, symbol: shortBase, isNewExpr: true }, effectivePath, enclosingContainer);
    }
    return emptyResult(enclosingContainer);
  }

  return resolveBareSymbol(ctx.symbol, innermostScope, parsed, ctx, effectivePath, enclosingContainer);
}

function resolveMemberOnTypeNames(receiverTypeNames, memberName, parsed, ctx, filePath, enclosingContainer) {
  const candidates = [];
  let importedHint = null;

  for (let i = 0; i < receiverTypeNames.length; i += 1) {
    const rawType = receiverTypeNames[i];
    const shortType = rawType.includes(".") ? rawType.slice(rawType.lastIndexOf(".") + 1) : rawType;
    const models = parsed.typeModels.get(shortType) || parsed.typeModels.get(rawType);
    if (models && models.length > 0) {
      for (let m = 0; m < models.length; m += 1) {
        const res = resolveLocalTypeMembers(models[m], memberName, parsed, ctx, filePath);
        candidates.push(...res.candidates);
        if (!importedHint && res.importedBase && res.candidates.length === 0) {
          const imp = res.importedBase.binding.importMeta;
          importedHint = buildImportHint({
            typeName: res.importedBase.baseName,
            memberName,
            importedName: imp.importedName,
            specifier: imp.specifier,
            qualifiedName: `${res.importedBase.baseName}.${memberName}`,
            isDefault: imp.isDefault,
            isNamespace: imp.isNamespace,
            isTypeOnly: imp.isTypeOnly,
            isRequire: imp.isRequire,
            isTypeContext: Boolean(ctx.isTypeContext),
            arity: ctx.arity,
            fallbackLine: imp.line,
            fallbackColumn: imp.column,
          });
        }
      }
    } else if (!importedHint) {
      const impFound = lookupBindingsInScopeChain(parsed.rootScope, shortType, true);
      if (impFound && impFound.bindings[0]?.kind === "import") {
        const imp = impFound.bindings[0].importMeta;
        importedHint = buildImportHint({
          typeName: shortType,
          memberName,
          importedName: imp.importedName,
          specifier: imp.specifier,
          qualifiedName: `${shortType}.${memberName}`,
          isDefault: imp.isDefault,
          isNamespace: imp.isNamespace,
          isTypeOnly: imp.isTypeOnly,
          isRequire: imp.isRequire,
          isTypeContext: Boolean(ctx.isTypeContext),
          arity: ctx.arity,
          fallbackLine: imp.line,
          fallbackColumn: imp.column,
        });
      }
    }
  }

  const nonSelf = candidates.filter((c) => !isSameNavLocation(c, ctx.line, ctx.col));
  if (nonSelf.length > 0) {
    return {
      resolved: rankNavCandidates(nonSelf, ctx),
      importHint: null,
      memberTypeHints: receiverTypeNames,
      enclosingContainer,
    };
  }

  return {
    resolved: [],
    importHint: importedHint,
    memberTypeHints: receiverTypeNames,
    enclosingContainer,
  };
}

function resolveBareSymbol(symbol, innermostScope, parsed, ctx, filePath, enclosingContainer) {
  const found = lookupBindingsInScopeChain(innermostScope, symbol, Boolean(ctx.isTypeContext));
  if (!found || found.bindings.length === 0) {
    // Check if cursor is on an interface/abstract method declaration itself to jump to concrete implementations
    const ownerClsScope = findEnclosingClassScope(innermostScope);
    if (ownerClsScope && ownerClsScope.ownerType && (ownerClsScope.ownerType.isAbstract || ownerClsScope.ownerType.kind === "interface")) {
      const impls = findLocalImplementations(ownerClsScope.ownerType.name, parsed);
      const implCands = [];
      for (let i = 0; i < impls.length; i += 1) {
        const meths = impls[i].methods.filter((m) => m.name === symbol && !m.isAbstract);
        for (let m = 0; m < meths.length; m += 1) {
          implCands.push(normalizeNavCandidate({
            filePath,
            line: meths[m].line,
            column: meths[m].column,
            name: meths[m].name,
            kind: meths[m].kind,
            containerName: impls[i].name,
            signature: meths[m].signature,
            isAbstract: false,
            arity: meths[m].arity,
            lang: "js",
            exactScope: true,
            score: 100,
          }));
        }
      }
      const filteredImpls = implCands.filter((c) => !isSameNavLocation(c, ctx.line, ctx.col));
      if (filteredImpls.length > 0) {
        return {
          resolved: rankNavCandidates(filteredImpls, ctx),
          importHint: null,
          memberTypeHints: [],
          enclosingContainer,
        };
      }
    }

    return {
      resolved: [],
      importHint: null,
      memberTypeHints: [],
      enclosingContainer,
    };
  }

  const first = found.bindings[0];
  if (first.kind === "import") {
    const imp = first.importMeta;
    const isConstructorOrType = Boolean(ctx.isNewExpr || ctx.isTypeContext || imp.isTypeOnly);
    return {
      resolved: [],
      importHint: buildImportHint({
        typeName: isConstructorOrType && !imp.isNamespace ? imp.localName : null,
        memberName: null,
        importedName: imp.importedName,
        specifier: imp.specifier,
        qualifiedName: isConstructorOrType && !imp.isNamespace ? imp.localName : null,
        isDefault: imp.isDefault,
        isNamespace: imp.isNamespace,
        isTypeOnly: imp.isTypeOnly,
        isRequire: imp.isRequire,
        isTypeContext: isConstructorOrType,
        arity: ctx.arity,
        fallbackLine: imp.line,
        fallbackColumn: imp.column,
      }),
      memberTypeHints: [],
      enclosingContainer,
    };
  }

  const candidates = [];
  for (let i = 0; i < found.bindings.length; i += 1) {
    const b = found.bindings[i];
    if (b.kind === "import") continue;

    // `new MyClass(...)` -> `constructor` if defined, else `class MyClass`
    if (ctx.isNewExpr && b.typeModel && b.typeModel.kind === "class") {
      if (b.typeModel.constructors.length > 0) {
        for (let c = 0; c < b.typeModel.constructors.length; c += 1) {
          const ctor = b.typeModel.constructors[c];
          candidates.push(normalizeNavCandidate({
            filePath,
            line: ctor.line,
            column: ctor.column,
            name: "constructor",
            kind: "constructor",
            containerName: b.typeModel.name,
            signature: ctor.signature,
            isAbstract: Boolean(ctor._isAbstract),
            arity: ctor.arity,
            lang: "js",
            exactScope: true,
            score: ctor._isAbstract ? 80 : 100,
          }));
        }
        continue;
      }
    }

    // `interface` clicked in implementation/value context or declaration -> include concrete `implements` classes if `isTypeContext`?
    // Wait: for `new Foo` or `class`, return candidate directly; for overloads/merged bindings, include all.
    const cand = buildBindingCandidate(b, filePath, ctx);
    if (cand) {
      if (b.kind === "function" && b.isAbstract) cand.score = 80;
      else if (b.kind === "function" || b.kind === "arrow") cand.score = 100;
      candidates.push(cand);
    }
  }

  // If clicking directly on an `interface` name at its declaration site or `implements`, don't self-jump
  const nonSelf = candidates.filter((c) => !isSameNavLocation(c, ctx.line, ctx.col));
  if (nonSelf.length > 0) {
    return {
      resolved: rankNavCandidates(nonSelf, ctx),
      importHint: null,
      memberTypeHints: [],
      enclosingContainer,
    };
  }

  return {
    resolved: [],
    importHint: null,
    memberTypeHints: [],
    enclosingContainer,
  };
}
