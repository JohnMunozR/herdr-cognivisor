// Pure Python (.py, .pyw, .pyi) code navigation analyzer and symbol summary extractor.
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
  computeBracketPairs,
} from "./code-nav-logic.js";

const PY_HARD_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

const PY_BUILTIN_NAMES = new Set([
  "object", "int", "float", "complex", "bool", "str", "bytes", "bytearray",
  "memoryview", "list", "tuple", "range", "dict", "set", "frozenset", "slice",
  "type", "super", "property", "classmethod", "staticmethod", "enumerate", "zip",
  "map", "filter", "reversed", "sorted", "len", "min", "max", "sum", "any",
  "all", "abs", "round", "pow", "divmod", "print", "input", "open", "id",
  "hash", "repr", "ascii", "ord", "chr", "bin", "oct", "hex", "format",
  "isinstance", "issubclass", "hasattr", "getattr", "setattr", "delattr",
  "callable", "iter", "next", "vars", "dir", "globals", "locals", "eval",
  "exec", "compile", "breakpoint", "NotImplemented", "Ellipsis", "__name__",
  "__file__", "__doc__", "__package__", "__all__", "__dict__", "__class__",
  "BaseException", "Exception", "ArithmeticError", "AssertionError",
  "AttributeError", "EOFError", "FloatingPointError", "GeneratorExit",
  "ImportError", "ModuleNotFoundError", "IndexError", "KeyError",
  "KeyboardInterrupt", "LookupError", "MemoryError", "NameError",
  "NotImplementedError", "OSError", "OverflowError", "RecursionError",
  "ReferenceError", "RuntimeError", "StopIteration", "StopAsyncIteration",
  "SyntaxError", "IndentationError", "TabError", "SystemError", "SystemExit",
  "TypeError", "UnboundLocalError", "ValueError", "ZeroDivisionError",
  "Warning", "UserWarning", "DeprecationWarning",
  // Common typing constructs if unimported
  "Any", "Union", "Optional", "Literal", "Final", "ClassVar", "Annotated",
  "Callable", "Sequence", "Mapping", "MutableMapping", "Iterable", "Iterator",
  "Generator", "Coroutine", "Awaitable", "AsyncIterator", "AsyncGenerator",
  "Self", "Never", "NoReturn", "TypeAlias", "TypeVar", "ParamSpec",
  "TypeVarTuple", "Generic", "Protocol", "TypedDict", "NamedTuple",
]);

const TYPE_WRAPPER_NAMES = new Set([
  "Optional", "Union", "Annotated", "Final", "ClassVar", "Required", "NotRequired",
  "ReadOnly", "typing.Optional", "typing.Union", "typing.Annotated",
  "typing.Final", "typing.ClassVar",
]);

const SUITE_KEYWORDS = new Set([
  "class", "def", "if", "elif", "else", "for", "while", "with", "try",
  "except", "finally", "match", "case",
]);

const AUGMENT_ASSIGN_OPS = new Set([
  "+=", "-=", "*=", "/=", "//=", "%=", "**=", "&=", "|=", "^=", ">>=", "<<=", "@=",
]);

const DEFAULT_ANALYZE_FALLBACK = "mod.py";
const MAX_SIGNATURE_CHARS = 220;
const PY_INIT_FILE_RE = /(?:^|[/\\])__init__\.pyi?$/i;

function isPyIdentStart(ch) {
  return Boolean(ch && ch !== "$" && isNavIdentStart(ch));
}

function isPyIdentPart(ch) {
  return Boolean(ch && ch !== "$" && isNavIdentPart(ch));
}

function isDigitChar(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function isWhitespaceChar(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isConstantIdent(name) {
  if (!name || name.length < 2) return false;
  let hasUpper = false;
  for (let i = 0; i < name.length; i += 1) {
    const c = name.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      hasUpper = true;
    } else if ((c >= 48 && c <= 57) || c === 95) {
      // digits & underscores allowed
    } else {
      return false;
    }
  }
  return hasUpper;
}

function collapseSignature(str) {
  let out = "";
  let inSpace = true;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (isWhitespaceChar(ch)) {
      if (!inSpace) {
        out += " ";
        inSpace = true;
      }
    } else {
      if (out.length >= MAX_SIGNATURE_CHARS) {
        return `${out.slice(0, MAX_SIGNATURE_CHARS - 3)}...`;
      }
      out += ch;
      inSpace = false;
    }
  }
  const trimmed = out.trim();
  return trimmed.length > MAX_SIGNATURE_CHARS
    ? `${trimmed.slice(0, MAX_SIGNATURE_CHARS - 3)}...`
    : trimmed;
}

function findFirstNonSpace(line) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== " ") return i;
  }
  return -1;
}

function findLastNonSpace(line) {
  for (let i = line.length - 1; i >= 0; i -= 1) {
    if (line[i] !== " ") return i;
  }
  return -1;
}

function isPosInSpan(line, col, startLine, startCol, endLine, endCol) {
  if (line < startLine || line > endLine) return false;
  if (line === startLine && col < startCol) return false;
  if (line === endLine && col > endCol) return false;
  return true;
}

/**
 * Group lines into logical Python statements preserving 1-based line and column mappings.
 * Also tracks non-blank raw line indentations (for docstrings / bodies) to compute accurate endLine.
 */
function collectLogicalStatements(lines, maskedLines) {
  const statements = [];
  const rawIndentLines = [];
  let current = null;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let li = 0; li < lines.length; li += 1) {
    const rawLine = lines[li] || "";
    const maskedLine = maskedLines[li] || "";
    const rawFirst = findFirstNonSpace(rawLine);
    const maskedFirst = findFirstNonSpace(maskedLine);

    if (rawFirst >= 0) {
      const trimmedRaw = rawLine.slice(rawFirst);
      if (!trimmedRaw.startsWith("#")) {
        rawIndentLines.push({ line: li + 1, indent: rawFirst });
      }
    }

    if (!current) {
      if (maskedFirst < 0) continue;
      current = {
        startLine0: li,
        endLine0: li,
        indent: maskedFirst,
        segments: [],
      };
    }

    let trailingBackslash = false;
    const lastNonSpace = findLastNonSpace(maskedLine);
    if (lastNonSpace >= 0 && maskedLine[lastNonSpace] === "\\") {
      trailingBackslash = true;
    }

    for (let c = 0; c < maskedLine.length; c += 1) {
      const ch = maskedLine[c];
      if (ch === "(") parenDepth += 1;
      else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (ch === "[") bracketDepth += 1;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
    }

    current.segments.push({
      line0: li,
      raw: rawLine,
      masked: trailingBackslash
        ? `${maskedLine.slice(0, lastNonSpace)} ${maskedLine.slice(lastNonSpace + 1)}`
        : maskedLine,
    });
    current.endLine0 = li;

    const totalDepth = parenDepth + bracketDepth + braceDepth;
    if (totalDepth === 0 && !trailingBackslash) {
      statements.push(buildStatementBuffer(current));
      current = null;
    }
  }

  if (current) {
    statements.push(buildStatementBuffer(current));
  }

  return { statements, rawIndentLines };
}

function buildStatementBuffer(stmt) {
  const lineStarts = [];
  const maskedParts = [];
  const rawParts = [];
  let offset = 0;

  for (let i = 0; i < stmt.segments.length; i += 1) {
    const seg = stmt.segments[i];
    lineStarts.push({
      offset,
      length: seg.masked.length,
      line: seg.line0 + 1,
    });
    maskedParts.push(seg.masked);
    rawParts.push(seg.raw);
    offset += seg.masked.length + 1;
  }

  return {
    startLine: stmt.startLine0 + 1,
    endLine: stmt.endLine0 + 1,
    indent: stmt.indent,
    text: maskedParts.join("\n"),
    rawText: rawParts.join("\n"),
    lineStarts,
  };
}

function offsetToLineCol(buf, offset) {
  const starts = buf.lineStarts;
  const len = starts.length;
  if (len === 0) return { line: buf.startLine, col: 1 };
  if (len === 1) {
    return offset >= starts[0].offset
      ? { line: starts[0].line, col: (offset - starts[0].offset) + 1 }
      : { line: buf.startLine, col: 1 };
  }
  let lo = 0;
  let hi = len - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid].offset <= offset) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best >= 0) {
    return {
      line: starts[best].line,
      col: (offset - starts[best].offset) + 1,
    };
  }
  return { line: buf.startLine, col: 1 };
}

function matchThreeCharOp(text, i) {
  if (text[i + 2] !== "=") return "";
  const c0 = text[i];
  const c1 = text[i + 1];
  if (c0 !== c1) return "";
  if (c0 === "*") return "**=";
  if (c0 === "/") return "//=";
  if (c0 === "<") return "<<=";
  if (c0 === ">") return ">>=";
  return "";
}

function matchTwoCharOp(text, i) {
  const c0 = text[i];
  const c1 = text[i + 1];
  if (c1 === "=") {
    if (c0 === "=") return "==";
    if (c0 === "!") return "!=";
    if (c0 === "<") return "<=";
    if (c0 === ">") return ">=";
    if (c0 === ":") return ":=";
    if (c0 === "+") return "+=";
    if (c0 === "-") return "-=";
    if (c0 === "*") return "*=";
    if (c0 === "/") return "/=";
    if (c0 === "%") return "%=";
    if (c0 === "&") return "&=";
    if (c0 === "|") return "|=";
    if (c0 === "^") return "^=";
    if (c0 === "@") return "@=";
    return "";
  }
  if (c0 === "-" && c1 === ">") return "->";
  if (c0 === "*" && c1 === "*") return "**";
  if (c0 === "/" && c1 === "/") return "//";
  if (c0 === "<" && c1 === "<") return "<<";
  if (c0 === ">" && c1 === ">") return ">>";
  return "";
}

function tokenizeBufferRange(text, start, end) {
  const tokens = [];
  let i = Math.max(0, start);
  const limit = Math.min(text.length, end);
  let hasSubScopeKw = false;
  let hasBracket = false;

  while (i < limit) {
    const ch = text[i];
    if (isWhitespaceChar(ch)) {
      i += 1;
      continue;
    }
    if (isPyIdentStart(ch)) {
      const s = i;
      i += 1;
      while (i < limit && isPyIdentPart(text[i])) i += 1;
      const val = text.slice(s, i);
      if (!hasSubScopeKw && (val === "lambda" || val === "for")) {
        hasSubScopeKw = true;
      }
      tokens.push({ kind: "ident", value: val, start: s, end: i });
      continue;
    }
    if (isDigitChar(ch)) {
      const s = i;
      i += 1;
      while (i < limit && (isDigitChar(text[i]) || isPyIdentPart(text[i]) || text[i] === ".")) {
        i += 1;
      }
      tokens.push({ kind: "number", value: text.slice(s, i), start: s, end: i });
      continue;
    }
    if (ch === "." && i + 2 < limit && text[i + 1] === "." && text[i + 2] === ".") {
      tokens.push({ kind: "ellipsis", value: "...", start: i, end: i + 3 });
      i += 3;
      continue;
    }
    if (i + 2 < limit) {
      const tri = matchThreeCharOp(text, i);
      if (tri) {
        tokens.push({ kind: "op", value: tri, start: i, end: i + 3 });
        i += 3;
        continue;
      }
    }
    if (i + 1 < limit) {
      const two = matchTwoCharOp(text, i);
      if (two) {
        if (two === ":=") hasSubScopeKw = true;
        tokens.push({ kind: "op", value: two, start: i, end: i + 2 });
        i += 2;
        continue;
      }
    }
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      hasBracket = true;
      tokens.push({ kind: "punct", value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === "," || ch === ":" || ch === ";" || ch === "." || ch === "@") {
      tokens.push({ kind: "punct", value: ch, start: i, end: i + 1 });
      i += 1;
      continue;
    }
    tokens.push({ kind: "op", value: ch, start: i, end: i + 1 });
    i += 1;
  }

  tokens._hasSubScopeKw = hasSubScopeKw;
  tokens._pairs = hasBracket ? computeBracketPairs(tokens, "value") : null;
  return tokens;
}

function findMatchingToken(tokens, openIdx) {
  const open = tokens[openIdx]?.value;
  if (open !== "(" && open !== "[" && open !== "{") return -1;
  if (tokens._pairs) {
    const paired = tokens._pairs[openIdx];
    return paired > openIdx ? paired : -1;
  }
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 1;
  for (let i = openIdx + 1; i < tokens.length; i += 1) {
    const v = tokens[i].value;
    if (v === open) depth += 1;
    else if (v === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTokensAtTopLevel(tokens, startIdx, endIdx, sepValue) {
  const chunks = [];
  let depth = 0;
  let chunkStart = startIdx;
  for (let i = startIdx; i < endIdx; i += 1) {
    const v = tokens[i].value;
    if (v === "(" || v === "[" || v === "{") depth += 1;
    else if (v === ")" || v === "]" || v === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && v === sepValue) {
      chunks.push([chunkStart, i]);
      chunkStart = i + 1;
    }
  }
  chunks.push([chunkStart, endIdx]);
  return chunks;
}

function findTopLevelToken(tokens, startIdx, endIdx, targetValue) {
  let depth = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    const v = tokens[i].value;
    if (v === "(" || v === "[" || v === "{") depth += 1;
    else if (v === ")" || v === "]" || v === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && v === targetValue) return i;
  }
  return -1;
}

/**
 * Split a statement token list by `;` at depth 0, and separate header `:` from inline suite.
 */
function expandSubStatements(buf, tokens) {
  const semicolonChunks = splitTokensAtTopLevel(tokens, 0, tokens.length, ";");
  const out = [];

  for (let ci = 0; ci < semicolonChunks.length; ci += 1) {
    const [sIdx, eIdx] = semicolonChunks[ci];
    if (sIdx >= eIdx) continue;

    let headIdx = sIdx;
    if (tokens[headIdx].value === "async" && headIdx + 1 < eIdx) {
      headIdx += 1;
    }
    const headWord = tokens[headIdx].kind === "ident" ? tokens[headIdx].value : "";
    if (SUITE_KEYWORDS.has(headWord)) {
      const colonIdx = findSuiteColonIndex(tokens, sIdx, eIdx, headWord);
      if (colonIdx >= 0 && colonIdx + 1 < eIdx) {
        out.push({ startIdx: sIdx, endIdx: colonIdx + 1, hasInlineSuite: true });
        // Split inline suite on `;` if present
        const inlineChunks = splitTokensAtTopLevel(tokens, colonIdx + 1, eIdx, ";");
        for (let k = 0; k < inlineChunks.length; k += 1) {
          if (inlineChunks[k][0] < inlineChunks[k][1]) {
            out.push({ startIdx: inlineChunks[k][0], endIdx: inlineChunks[k][1], isInlineSuiteBody: true });
          }
        }
        continue;
      }
    }

    out.push({ startIdx: sIdx, endIdx: eIdx, hasInlineSuite: false });
  }

  return out;
}

function findSuiteColonIndex(tokens, startIdx, endIdx, headWord) {
  let idx = startIdx;
  if (tokens[idx]?.value === "async") idx += 1;
  if (headWord === "def") {
    // def name [TypeParams]? (params) [-> ret]:
    idx += 2; // skip def + name
    if (idx < endIdx && tokens[idx].value === "[") {
      const closeBracket = findMatchingToken(tokens, idx);
      if (closeBracket < 0) return -1;
      idx = closeBracket + 1;
    }
    if (idx < endIdx && tokens[idx].value === "(") {
      const closeParen = findMatchingToken(tokens, idx);
      if (closeParen < 0) return -1;
      idx = closeParen + 1;
    }
    let depth = 0;
    for (let i = idx; i < endIdx; i += 1) {
      const v = tokens[i].value;
      if (v === "(" || v === "[" || v === "{") depth += 1;
      else if (v === ")" || v === "]" || v === "}") depth = Math.max(0, depth - 1);
      else if (depth === 0 && v === ":") return i;
    }
    return -1;
  }

  // For match/case/other keywords: ensure no depth-0 assignment `=` precedes `:`
  let depth = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    const v = tokens[i].value;
    if (v === "(" || v === "[" || v === "{") depth += 1;
    else if (v === ")" || v === "]" || v === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (v === "=") return -1;
      if (v === ":") return i;
    }
  }
  return -1;
}

/**
 * Extract quoted string literals within a character range of buf.rawText while ignoring # comments
 * (using buf.text which already has comments and string contents blanked appropriately).
 */
function extractStringLiteralsInRange(buf, startOffset, endOffset) {
  const results = [];
  const raw = buf.rawText;
  const masked = buf.text;
  let i = Math.max(0, startOffset);
  const limit = Math.min(raw.length, endOffset);

  while (i < limit) {
    const ch = raw[i];
    // Comments are spaces in masked and start with # in raw (when outside strings)
    if (ch === "#" && masked[i] === " ") {
      while (i < limit && raw[i] !== "\n") i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const isTriple = i + 2 < limit && raw[i + 1] === ch && raw[i + 2] === ch;
      const delimLen = isTriple ? 3 : 1;
      const contentStart = i + delimLen;
      i = contentStart;
      let val = "";
      let closed = false;
      while (i < limit) {
        if (raw[i] === "\\" && i + 1 < limit) {
          val += raw[i + 1];
          i += 2;
          continue;
        }
        if (isTriple) {
          if (i + 2 < limit && raw[i] === ch && raw[i + 1] === ch && raw[i + 2] === ch) {
            closed = true;
            i += 3;
            break;
          }
        } else if (raw[i] === ch) {
          closed = true;
          i += 1;
          break;
        }
        val += raw[i];
        i += 1;
      }
      if (closed) {
        const pos = offsetToLineCol(buf, contentStart);
        results.push({ value: val, line: pos.line, col: pos.col });
      }
      continue;
    }
    i += 1;
  }

  return results;
}

function extractSingleStringAnnotation(buf, startOffset, endOffset) {
  const lits = extractStringLiteralsInRange(buf, startOffset, endOffset);
  if (lits.length === 1) {
    const v = lits[0].value.trim();
    if (v) return v;
  }
  return null;
}

function extractPrimaryTypeNames(typeExpr) {
  if (!typeExpr || typeof typeExpr !== "string") return [];
  const out = [];
  const seen = new Set();

  function addName(n) {
    const clean = n.trim();
    if (!clean || clean === "None" || clean === "NoneType" || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  }

  function visit(expr) {
    const s = expr.trim();
    if (!s || s === "None" || s === "NoneType") return;

    // Split top-level union `A | B`
    const unionParts = splitTopLevelString(s, "|");
    if (unionParts.length > 1) {
      for (let i = 0; i < unionParts.length; i += 1) visit(unionParts[i]);
      return;
    }

    const brIdx = s.indexOf("[");
    if (brIdx > 0 && s.endsWith("]")) {
      const head = s.slice(0, brIdx).trim();
      const inner = s.slice(brIdx + 1, -1).trim();
      if (head === "Optional" || head === "typing.Optional" ||
          head === "Final" || head === "typing.Final" ||
          head === "ClassVar" || head === "typing.ClassVar" ||
          head === "Required" || head === "NotRequired" || head === "ReadOnly") {
        visit(inner);
        return;
      }
      if (head === "Annotated" || head === "typing.Annotated") {
        const args = splitTopLevelString(inner, ",");
        if (args.length > 0) visit(args[0]);
        return;
      }
      if (head === "Union" || head === "typing.Union") {
        const args = splitTopLevelString(inner, ",");
        for (let i = 0; i < args.length; i += 1) visit(args[i]);
        return;
      }
      if (!TYPE_WRAPPER_NAMES.has(head)) {
        addName(head);
        return;
      }
    }

    // Strip any trailing call/subscript if leftover
    const cleanHead = brIdx > 0 ? s.slice(0, brIdx).trim() : s;
    addName(cleanHead);
  }

  visit(typeExpr);
  return out;
}

function splitTopLevelString(str, sepChar) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === sepChar) {
      parts.push(str.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(str.slice(start));
  return parts;
}

function extractTypeStringFromSlice(buf, tokens, startIdx, endIdx) {
  if (startIdx >= endIdx) return null;
  const startOff = tokens[startIdx].start;
  const endOff = tokens[endIdx - 1].end;
  const maskedSlice = collapseSignature(buf.text.slice(startOff, endOff));
  if (maskedSlice) return maskedSlice;
  // Handle string forward reference e.g. -> "User"
  return extractSingleStringAnnotation(buf, startOff, endOff);
}

function inferExprType(buf, tokens, startIdx, endIdx, scope, knownFunctions) {
  if (startIdx >= endIdx) return null;

  // Unwrap outer parentheses `(Expr())`
  let s = startIdx;
  let e = endIdx;
  while (s + 1 < e && tokens[s].value === "(" && findMatchingToken(tokens, s) === e - 1) {
    s += 1;
    e -= 1;
  }
  if (s >= e) return null;

  const first = tokens[s];
  // await expr -> unwrap await
  if (first.kind === "ident" && first.value === "await" && s + 1 < e) {
    return inferExprType(buf, tokens, s + 1, e, scope, knownFunctions);
  }

  // Literal tokens
  if (e - s === 1) {
    if (first.kind === "ident") {
      if (first.value === "True" || first.value === "False") return "bool";
      if (first.value === "None") return null;
      // Variable/param lookup in scope
      const found = lookupInScopeChain(scope, first.value, true);
      if (found && found.binding) {
        return found.binding.declaredType || found.binding.initializerType || null;
      }
      return null;
    }
    if (first.kind === "number") {
      return first.value.includes(".") || first.value.includes("e") || first.value.includes("E")
        ? "float"
        : "int";
    }
  }

  // Container literals `[...]`, `{...}`
  if (first.value === "[" && findMatchingToken(tokens, s) === e - 1) {
    return "list";
  }
  if (first.value === "{" && findMatchingToken(tokens, s) === e - 1) {
    const hasColon = findTopLevelToken(tokens, s + 1, e - 1, ":") >= 0;
    return hasColon || e - s === 2 ? "dict" : "set";
  }

  // String literal check via rawText when masked slice is empty
  const masked = buf.text.slice(tokens[s].start, tokens[e - 1].end).trim();
  if (!masked) {
    const lits = extractStringLiteralsInRange(buf, tokens[s].start, tokens[e - 1].end);
    if (lits.length > 0) return "str";
  }

  // Call expression: <identChain> ( ... )
  if (tokens[e - 1].value === ")") {
    // Find matching open paren for trailing `)`
    let depth = 0;
    let openIdx = -1;
    for (let i = e - 1; i >= s; i -= 1) {
      const v = tokens[i].value;
      if (v === ")" || v === "]" || v === "}") depth += 1;
      else if (v === "(" || v === "[" || v === "{") {
        depth -= 1;
        if (depth === 0 && v === "(") {
          openIdx = i;
          break;
        }
      }
    }
    if (openIdx > s) {
      // Optional generic args `[...]` right before `(`
      let nameEnd = openIdx;
      if (nameEnd - 1 > s && tokens[nameEnd - 1].value === "]") {
        let bDepth = 0;
        for (let i = nameEnd - 1; i >= s; i -= 1) {
          if (tokens[i].value === "]") bDepth += 1;
          else if (tokens[i].value === "[") {
            bDepth -= 1;
            if (bDepth === 0) {
              nameEnd = i;
              break;
            }
          }
        }
      }
      // Check dotted chain `[ident, ., ident, ...]`
      const chain = [];
      let validChain = true;
      for (let i = s; i < nameEnd; i += 1) {
        if ((i - s) % 2 === 0) {
          if (tokens[i].kind === "ident") chain.push(tokens[i].value);
          else { validChain = false; break; }
        } else if (tokens[i].value !== ".") {
          validChain = false;
          break;
        }
      }
      if (validChain && chain.length === 1) {
        const callee = chain[0];
        if (callee === "TypeVar" || callee === "ParamSpec" || callee === "TypeVarTuple") {
          return callee;
        }
        const fnInfo = knownFunctions?.get(callee);
        if (fnInfo && fnInfo.returnType) return fnInfo.returnType;
        const bound = lookupInScopeChain(scope, callee, true);
        if (bound?.binding?.kind === "class") return callee;
        if (bound?.binding?.kind === "import") return callee;
        if (callee[0] >= "A" && callee[0] <= "Z" && !PY_BUILTIN_NAMES.has(callee)) {
          return callee;
        }
        if (callee === "list" || callee === "dict" || callee === "set" || callee === "tuple" ||
            callee === "str" || callee === "int" || callee === "float" || callee === "bool") {
          return callee;
        }
      } else if (validChain && chain.length >= 2) {
        const fullChain = chain.join(".");
        const leaf = chain[chain.length - 1];
        if (leaf[0] >= "A" && leaf[0] <= "Z" && !PY_BUILTIN_NAMES.has(leaf)) {
          return fullChain;
        }
        if (chain[0] === "self" && scope.enclosingClass) {
          const m = scope.enclosingClass.methods.find((it) => it.name === leaf);
          if (m && m.returnType) return m.returnType;
        }
      }
    }
  }

  return null;
}

/**
 * Create a lexical scope node.
 */
function createScope({ id, kind, name, parent, startLine, startCol, endLine, endCol, enclosingClass = null, headerEndLine = 0 }) {
  return {
    id,
    kind, // "module" | "class" | "function" | "lambda" | "comprehension"
    name,
    parent,
    startLine,
    startCol,
    endLine,
    endCol,
    headerEndLine,
    enclosingClass,
    bindings: new Map(), // name -> [binding]
    globals: new Set(),
    nonlocals: new Set(),
    moduleAliases: new Map(), // dotted modulePath -> importRecord (for `import a.b`)
    children: [],
    // Optional comprehension first-iterable exclusion range so `[x for x in x]` works cleanly
    firstIterSpan: null,
  };
}

function addBinding(scope, name, binding, allowMultiple = false) {
  if (!name || PY_HARD_KEYWORDS.has(name) || name === "/" || name === "*") return;
  let arr = scope.bindings.get(name);
  if (!arr) {
    arr = [];
    scope.bindings.set(name, arr);
    arr.push(binding);
    return;
  }
  if (allowMultiple) {
    arr.push(binding);
  }
}

function getNearestVarTargetScope(scope) {
  let cur = scope;
  while (cur && cur.kind === "comprehension") {
    cur = cur.parent;
  }
  return cur || scope;
}

function getNextLegbParent(scope) {
  let cur = scope.parent;
  // Inside functions/lambdas/comprehensions, Python skips enclosing `class` scopes in LEGB!
  if (scope.kind === "function" || scope.kind === "lambda" || scope.kind === "comprehension") {
    while (cur && cur.kind === "class") {
      cur = cur.parent;
    }
  }
  return cur;
}

function getModuleScope(scope) {
  let cur = scope;
  while (cur && cur.parent) cur = cur.parent;
  return cur;
}

function lookupInScopeChain(scope, name, allowModule = true, cursorLine = null, cursorCol = null) {
  if (!scope || !name) return null;
  if (scope.globals.has(name)) {
    const mod = getModuleScope(scope);
    const list = mod.bindings.get(name);
    return list && list.length > 0 ? { binding: pickBestBinding(list, cursorLine, cursorCol), scope: mod, isExactScope: mod === scope } : null;
  }
  if (scope.nonlocals.has(name)) {
    let cur = getNextLegbParent(scope);
    while (cur && cur.kind !== "module") {
      if (cur.globals.has(name)) {
        const mod = getModuleScope(cur);
        const list = mod.bindings.get(name);
        return list && list.length > 0 ? { binding: pickBestBinding(list, cursorLine, cursorCol), scope: mod, isExactScope: false } : null;
      }
      const list = cur.bindings.get(name);
      if (list && list.length > 0) {
        return { binding: pickBestBinding(list, cursorLine, cursorCol), scope: cur, isExactScope: false };
      }
      cur = getNextLegbParent(cur);
    }
    return null;
  }

  let cur = scope;
  let first = true;
  while (cur) {
    if (!allowModule && cur.kind === "module") break;
    if (!first && cur.globals.has(name)) {
      const mod = getModuleScope(cur);
      const list = mod.bindings.get(name);
      return list && list.length > 0 ? { binding: pickBestBinding(list, cursorLine, cursorCol), scope: mod, isExactScope: false } : null;
    }
    const list = cur.bindings.get(name);
    if (list && list.length > 0) {
      return { binding: pickBestBinding(list, cursorLine, cursorCol), scope: cur, isExactScope: first };
    }
    cur = getNextLegbParent(cur);
    first = false;
  }
  return null;
}

function pickBestBinding(list, cursorLine, cursorCol) {
  if (list.length === 1 || cursorLine == null) return list[0];
  // If multiple bindings (e.g. @overload + concrete def, or multiple except ... as err blocks):
  // 1. Prefer block-scoped match containing cursor (except blocks)
  for (let i = 0; i < list.length; i += 1) {
    const b = list[i];
    if (b.blockSpan && isPosInSpan(cursorLine, cursorCol || 1, b.blockSpan.startLine, 1, b.blockSpan.endLine, 1e9)) {
      return b;
    }
  }
  // 2. Prefer non-overload concrete function if available
  const concrete = list.find((b) => b.kind === "function" && !b.isOverload);
  if (concrete) return concrete;
  return list[0];
}

function parseImportStatement(buf, tokens, startIdx, endIdx, scope, analysis) {
  const head = tokens[startIdx]?.value;
  if (head === "import") {
    // import pkg.mod, pkg.other as alias
    const chunks = splitTokensAtTopLevel(tokens, startIdx + 1, endIdx, ",");
    const moduleTokens = [];
    for (let ci = 0; ci < chunks.length; ci += 1) {
      const [s, e] = chunks[ci];
      if (s >= e) continue;
      const asIdx = findTopLevelToken(tokens, s, e, "as");
      const modEnd = asIdx >= 0 ? asIdx : e;
      const modParts = [];
      let modStartOff = -1;
      let modEndOff = -1;
      for (let i = s; i < modEnd; i += 1) {
        if (tokens[i].kind === "ident") {
          if (modStartOff < 0) modStartOff = tokens[i].start;
          modEndOff = tokens[i].end;
          modParts.push(tokens[i].value);
        }
      }
      if (!modParts.length) continue;
      const moduleSpec = modParts.join(".");
      let localName = modParts[0];
      let bindTok = tokens[s];
      let aliasSpan = null;
      if (asIdx >= 0 && asIdx + 1 < e && tokens[asIdx + 1].kind === "ident") {
        localName = tokens[asIdx + 1].value;
        bindTok = tokens[asIdx + 1];
        aliasSpan = { startOff: bindTok.start, endOff: bindTok.end };
      }
      const pos = offsetToLineCol(buf, bindTok.start);
      const rec = {
        localName,
        importedName: null,
        moduleSpec,
        relativeLevel: 0,
        isStar: false,
        line: pos.line,
        column: pos.col,
        isModuleImport: true,
        isExplicitReExport: false,
      };
      if (scope.kind === "module") {
        analysis.imports.push(rec);
      }
      // Register dotted path in moduleAliases (so `pkg.mod.fn()` resolves to `pkg.mod`)
      scope.moduleAliases.set(moduleSpec, rec);
      if (asIdx >= 0) {
        scope.moduleAliases.set(localName, rec);
      }
      addBinding(scope, localName, {
        name: localName,
        kind: "import",
        line: pos.line,
        column: pos.col,
        signature: collapseSignature(buf.rawText.slice(tokens[startIdx].start, tokens[endIdx - 1].end)),
        importRecord: rec,
      });
      moduleTokens.push({
        startOff: modStartOff,
        endOff: modEndOff,
        aliasSpan,
        record: rec,
      });
    }
    analysis.importRegions.push({
      startLine: buf.startLine,
      endLine: buf.endLine,
      kind: "import",
      moduleStartOff: -1,
      moduleEndOff: -1,
      moduleSpec: "",
      relativeLevel: 0,
      items: [],
      moduleItems: moduleTokens,
      buf,
    });
    return;
  }

  if (head === "from") {
    const importKwIdx = findTopLevelToken(tokens, startIdx + 1, endIdx, "import");
    if (importKwIdx < 0) return;

    // Count leading dots and module path tokens between `from` and `import`
    let relativeLevel = 0;
    const modParts = [];
    let modStartOff = -1;
    let modEndOff = -1;
    for (let i = startIdx + 1; i < importKwIdx; i += 1) {
      const tok = tokens[i];
      if (tok.kind === "ellipsis") {
        if (modStartOff < 0) modStartOff = tok.start;
        modEndOff = tok.end;
        relativeLevel += 3;
      } else if (tok.value === ".") {
        if (modStartOff < 0) modStartOff = tok.start;
        modEndOff = tok.end;
        if (modParts.length === 0) relativeLevel += 1;
      } else if (tok.kind === "ident") {
        if (modStartOff < 0) modStartOff = tok.start;
        modEndOff = tok.end;
        modParts.push(tok.value);
      }
    }

    const prefixDots = ".".repeat(relativeLevel);
    const moduleSpec = prefixDots + modParts.join(".");

    let listStart = importKwIdx + 1;
    let listEnd = endIdx;
    if (listStart < listEnd && tokens[listStart].value === "(") {
      const close = findMatchingToken(tokens, listStart);
      if (close > listStart) {
        listStart += 1;
        listEnd = close;
      }
    }

    const chunks = splitTokensAtTopLevel(tokens, listStart, listEnd, ",");
    const items = [];
    const sigText = collapseSignature(buf.rawText.slice(tokens[startIdx].start, tokens[endIdx - 1].end));

    for (let ci = 0; ci < chunks.length; ci += 1) {
      const [s, e] = chunks[ci];
      if (s >= e) continue;
      if (tokens[s].value === "*") {
        const pos = offsetToLineCol(buf, tokens[s].start);
        const rec = {
          localName: "*",
          importedName: "*",
          moduleSpec,
          relativeLevel,
          isStar: true,
          line: pos.line,
          column: pos.col,
          isModuleImport: false,
          isExplicitReExport: false,
        };
        if (scope.kind === "module") {
          analysis.imports.push(rec);
        }
        items.push({
          startOff: tokens[s].start,
          endOff: tokens[s].end,
          record: rec,
        });
        continue;
      }

      if (tokens[s].kind !== "ident") continue;
      const origTok = tokens[s];
      const importedName = origTok.value;
      let localName = importedName;
      let bindTok = origTok;
      let isExplicitReExport = false;
      if (s + 2 < e && tokens[s + 1].value === "as" && tokens[s + 2].kind === "ident") {
        bindTok = tokens[s + 2];
        localName = bindTok.value;
        isExplicitReExport = importedName === localName;
      }

      const pos = offsetToLineCol(buf, bindTok.start);
      const rec = {
        localName,
        importedName,
        moduleSpec,
        relativeLevel,
        isStar: false,
        line: pos.line,
        column: pos.col,
        isModuleImport: false,
        isExplicitReExport,
      };
      if (scope.kind === "module") {
        analysis.imports.push(rec);
      }
      addBinding(scope, localName, {
        name: localName,
        kind: "import",
        line: pos.line,
        column: pos.col,
        signature: sigText,
        importRecord: rec,
      });
      items.push({
        startOff: origTok.start,
        endOff: bindTok.end,
        record: rec,
      });
    }

    analysis.importRegions.push({
      startLine: buf.startLine,
      endLine: buf.endLine,
      kind: "from",
      moduleStartOff: modStartOff,
      moduleEndOff: modEndOff,
      moduleSpec,
      relativeLevel,
      items,
      moduleItems: [],
      buf,
    });
  }
}

function parseParamList(buf, tokens, openParenIdx, closeParenIdx, scope, knownFunctions) {
  const params = [];
  if (openParenIdx < 0 || closeParenIdx <= openParenIdx + 1) return params;

  const chunks = splitTokensAtTopLevel(tokens, openParenIdx + 1, closeParenIdx, ",");
  for (let ci = 0; ci < chunks.length; ci += 1) {
    const [s, e] = chunks[ci];
    if (s >= e) continue;

    // Skip positional-only `/` and keyword-only bare `*`
    if (e - s === 1 && (tokens[s].value === "/" || tokens[s].value === "*")) {
      continue;
    }

    let idx = s;
    let isStarred = false;
    if (tokens[idx].value === "*" || tokens[idx].value === "**") {
      isStarred = true;
      idx += 1;
    }
    if (idx >= e || tokens[idx].kind !== "ident") continue;

    const nameTok = tokens[idx];
    const namePos = offsetToLineCol(buf, nameTok.start);

    const eqIdx = findTopLevelToken(tokens, idx + 1, e, "=");
    const typeSearchEnd = eqIdx >= 0 ? eqIdx : e;
    const colonIdx = findTopLevelToken(tokens, idx + 1, typeSearchEnd, ":");

    let declaredType = null;
    if (colonIdx >= 0 && colonIdx + 1 < typeSearchEnd) {
      declaredType = extractTypeStringFromSlice(buf, tokens, colonIdx + 1, typeSearchEnd);
      // Record type-context span for `: Type`
    }

    let initializerType = null;
    if (eqIdx >= 0 && eqIdx + 1 < e) {
      initializerType = inferExprType(buf, tokens, eqIdx + 1, e, scope.parent || scope, knownFunctions);
      scanExpressionSubScopes(buf, tokens, eqIdx + 1, e, scope.parent || scope, knownFunctions);
    }

    params.push({
      name: nameTok.value,
      line: namePos.line,
      col: namePos.col,
      startOff: nameTok.start,
      endOff: nameTok.end,
      declaredType,
      initializerType,
      isStarred,
    });
  }

  return params;
}

function extractPatternTargets(buf, tokens, startIdx, endIdx) {
  const targets = [];

  function walk(s, e) {
    if (s >= e) return;
    // Unwrap outer parens/brackets `(a, b)` or `[a, *b]`
    if ((tokens[s].value === "(" && findMatchingToken(tokens, s) === e - 1) ||
        (tokens[s].value === "[" && findMatchingToken(tokens, s) === e - 1)) {
      walk(s + 1, e - 1);
      return;
    }

    const chunks = splitTokensAtTopLevel(tokens, s, e, ",");
    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length; i += 1) {
        if (chunks[i][0] < chunks[i][1]) walk(chunks[i][0], chunks[i][1]);
      }
      return;
    }

    let idx = s;
    if (tokens[idx].value === "*") idx += 1;
    if (idx >= e) return;

    // Unwrap nested parens/brackets after comma split
    if ((tokens[idx].value === "(" && findMatchingToken(tokens, idx) === e - 1) ||
        (tokens[idx].value === "[" && findMatchingToken(tokens, idx) === e - 1)) {
      walk(idx + 1, e - 1);
      return;
    }

    // Simple identifier target `x`
    if (e - idx === 1 && tokens[idx].kind === "ident") {
      const pos = offsetToLineCol(buf, tokens[idx].start);
      targets.push({
        kind: "ident",
        name: tokens[idx].value,
        line: pos.line,
        col: pos.col,
      });
      return;
    }

    // `self.attr` target
    if (e - idx === 3 && tokens[idx].value === "self" &&
        tokens[idx + 1].value === "." && tokens[idx + 2].kind === "ident") {
      const pos = offsetToLineCol(buf, tokens[idx + 2].start);
      targets.push({
        kind: "self_attr",
        name: tokens[idx + 2].value,
        line: pos.line,
        col: pos.col,
      });
    }
  }

  walk(startIdx, endIdx);
  return targets;
}

/**
 * Scan expression tokens linearly for walrus `:=`, `lambda`, and comprehension sub-scopes.
 */
function scanExpressionSubScopes(buf, tokens, startIdx, endIdx, scope, knownFunctions, depth = 0) {
  if (!tokens || tokens._summaryOnly || tokens._hasSubScopeKw === false || depth > 64) return;
  let i = startIdx;
  while (i < endIdx) {
    const tok = tokens[i];

    // Walrus operator `ident := expr`
    if (tok.kind === "ident" && i + 1 < endIdx && tokens[i + 1].value === ":=") {
      const targetScope = getNearestVarTargetScope(scope);
      const pos = offsetToLineCol(buf, tok.start);
      const initType = inferExprType(buf, tokens, i + 2, endIdx, scope, knownFunctions);
      if (!targetScope.globals.has(tok.value) && !targetScope.nonlocals.has(tok.value)) {
        addBinding(targetScope, tok.value, {
          name: tok.value,
          kind: "variable",
          line: pos.line,
          column: pos.col,
          declaredType: null,
          initializerType: initType,
          signature: collapseSignature(buf.rawText.slice(tok.start, tokens[Math.min(endIdx - 1, i + 4)].end)),
        });
      }
      i += 2;
      continue;
    }

    // Lambda expression `lambda x, y=1: body`
    if (tok.kind === "ident" && tok.value === "lambda") {
      const colonIdx = findTopLevelToken(tokens, i + 1, endIdx, ":");
      if (colonIdx > i) {
        const bodyEndIdx = findLambdaBodyEnd(tokens, colonIdx + 1, endIdx);
        const startPos = offsetToLineCol(buf, tok.start);
        const endPos = offsetToLineCol(buf, tokens[bodyEndIdx - 1].end);
        const lamScope = createScope({
          id: `lambda:${startPos.line}:${startPos.col}`,
          kind: "lambda",
          name: "<lambda>",
          parent: scope,
          startLine: startPos.line,
          startCol: startPos.col,
          endLine: endPos.line,
          endCol: endPos.col + 1,
          enclosingClass: scope.enclosingClass,
        });
        scope.children.push(lamScope);

        // Parse lambda parameters between `lambda` and `:`
        const paramChunks = splitTokensAtTopLevel(tokens, i + 1, colonIdx, ",");
        for (let pi = 0; pi < paramChunks.length; pi += 1) {
          const [ps, pe] = paramChunks[pi];
          if (ps >= pe) continue;
          if (pe - ps === 1 && (tokens[ps].value === "/" || tokens[ps].value === "*")) continue;
          let pIdx = ps;
          if (tokens[pIdx].value === "*" || tokens[pIdx].value === "**") pIdx += 1;
          if (pIdx < pe && tokens[pIdx].kind === "ident") {
            const pPos = offsetToLineCol(buf, tokens[pIdx].start);
            addBinding(lamScope, tokens[pIdx].value, {
              name: tokens[pIdx].value,
              kind: "parameter",
              line: pPos.line,
              column: pPos.col,
              declaredType: null,
              initializerType: null,
              signature: collapseSignature(buf.rawText.slice(tokens[ps].start, tokens[pe - 1].end)),
            });
          }
        }

        // Recurse inside lambda body
        scanExpressionSubScopes(buf, tokens, colonIdx + 1, bodyEndIdx, lamScope, knownFunctions, depth + 1);
        i = bodyEndIdx;
        continue;
      }
    }

    // Comprehension / generator expression `[...]`, `{...}`, `(...)`
    if (tok.value === "[" || tok.value === "{" || tok.value === "(") {
      const closeIdx = findMatchingToken(tokens, i);
      if (closeIdx > i + 1 && closeIdx < endIdx) {
        const compInfo = detectComprehension(tokens, i, closeIdx);
        if (compInfo) {
          const openPos = offsetToLineCol(buf, tok.start);
          const closePos = offsetToLineCol(buf, tokens[closeIdx].end);
          const compScope = createScope({
            id: `comp:${openPos.line}:${openPos.col}`,
            kind: "comprehension",
            name: "<comp>",
            parent: scope,
            startLine: openPos.line,
            startCol: openPos.col,
            endLine: closePos.line,
            endCol: closePos.col,
            enclosingClass: scope.enclosingClass,
          });
          if (compInfo.firstIterStartIdx < compInfo.firstIterEndIdx) {
            const iterS = offsetToLineCol(buf, tokens[compInfo.firstIterStartIdx].start);
            const iterE = offsetToLineCol(buf, tokens[compInfo.firstIterEndIdx - 1].end);
            compScope.firstIterSpan = {
              startLine: iterS.line,
              startCol: iterS.col,
              endLine: iterE.line,
              endCol: iterE.col,
            };
          }
          scope.children.push(compScope);

          for (let ci = 0; ci < compInfo.clauses.length; ci += 1) {
            const cl = compInfo.clauses[ci];
            const targets = extractPatternTargets(buf, tokens, cl.targetStart, cl.targetEnd);
            for (let ti = 0; ti < targets.length; ti += 1) {
              const t = targets[ti];
              if (t.kind === "ident") {
                addBinding(compScope, t.name, {
                  name: t.name,
                  kind: "variable",
                  line: t.line,
                  column: t.col,
                  declaredType: null,
                  initializerType: null,
                  signature: collapseSignature(buf.rawText.slice(tokens[cl.targetStart].start, tokens[cl.targetEnd - 1].end)),
                });
              }
            }
          }

          // Scan inside comprehension for nested lambdas/walrus/comprehensions
          if (compInfo.firstIterStartIdx < compInfo.firstIterEndIdx) {
            scanExpressionSubScopes(buf, tokens, i + 1, compInfo.firstIterStartIdx, compScope, knownFunctions, depth + 1);
            scanExpressionSubScopes(buf, tokens, compInfo.firstIterStartIdx, compInfo.firstIterEndIdx, scope, knownFunctions, depth + 1);
            scanExpressionSubScopes(buf, tokens, compInfo.firstIterEndIdx, closeIdx, compScope, knownFunctions, depth + 1);
          } else {
            scanExpressionSubScopes(buf, tokens, i + 1, closeIdx, compScope, knownFunctions, depth + 1);
          }
          i = closeIdx + 1;
          continue;
        }
      }
    }

    i += 1;
  }
}

function findLambdaBodyEnd(tokens, startIdx, endIdx) {
  let depth = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    const v = tokens[i].value;
    if (v === "(" || v === "[" || v === "{") {
      depth += 1;
    } else if (v === ")" || v === "]" || v === "}") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (v === "," || v === ";")) {
      return i;
    }
  }
  return endIdx;
}

function detectComprehension(tokens, openIdx, closeIdx) {
  // Scan at local depth 0 inside (openIdx .. closeIdx) for `for <targets> in <iter>`
  const pairs = tokens._pairs;
  let depth = 0;
  const forIndices = [];
  let hasCommaAtZero = false;

  for (let i = openIdx + 1; i < closeIdx; i += 1) {
    const v = tokens[i].value;
    if (v === "(" || v === "[" || v === "{") {
      if (depth === 0 && pairs) {
        const jump = pairs[i];
        if (jump > i && jump < closeIdx) {
          i = jump;
          continue;
        }
      }
      depth += 1;
    } else if (v === ")" || v === "]" || v === "}") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (v === ",") hasCommaAtZero = true;
      else if (tokens[i].kind === "ident" && v === "for") {
        forIndices.push(i);
      }
    }
  }

  if (forIndices.length === 0) return null;
  if (hasCommaAtZero && tokens[openIdx].value === "(") return null;

  const clauses = [];
  let firstIterStartIdx = -1;
  let firstIterEndIdx = -1;

  for (let fi = 0; fi < forIndices.length; fi += 1) {
    const forIdx = forIndices[fi];
    // Find matching `in` at depth 0 after forIdx
    let d = 0;
    let inIdx = -1;
    const searchLimit = fi + 1 < forIndices.length ? forIndices[fi + 1] : closeIdx;
    for (let k = forIdx + 1; k < searchLimit; k += 1) {
      const v = tokens[k].value;
      if (v === "(" || v === "[" || v === "{") {
        if (d === 0 && pairs) {
          const jump = pairs[k];
          if (jump > k && jump < searchLimit) {
            k = jump;
            continue;
          }
        }
        d += 1;
      } else if (v === ")" || v === "]" || v === "}") {
        d = Math.max(0, d - 1);
      } else if (d === 0 && tokens[k].kind === "ident" && v === "in") {
        inIdx = k;
        break;
      }
    }
    if (inIdx > forIdx + 1) {
      clauses.push({ targetStart: forIdx + 1, targetEnd: inIdx });
      if (fi === 0) {
        // First iterable ends before next `for` or `if` at depth 0
        firstIterStartIdx = inIdx + 1;
        let iterEnd = searchLimit;
        let ld = 0;
        for (let k = inIdx + 1; k < searchLimit; k += 1) {
          const v = tokens[k].value;
          if (v === "(" || v === "[" || v === "{") {
            if (ld === 0 && pairs) {
              const jump = pairs[k];
              if (jump > k && jump < searchLimit) {
                k = jump;
                continue;
              }
            }
            ld += 1;
          } else if (v === ")" || v === "]" || v === "}") {
            ld = Math.max(0, ld - 1);
          } else if (ld === 0 && tokens[k].kind === "ident" && (v === "if" || v === "for" || v === "async")) {
            iterEnd = k;
            break;
          }
        }
        firstIterEndIdx = iterEnd;
      }
    }
  }

  if (clauses.length === 0) return null;
  return { clauses, firstIterStartIdx, firstIterEndIdx };
}

function recordClassField(classRecord, fieldInfo) {
  const existing = classRecord.fieldMap.get(fieldInfo.name);
  if (!existing) {
    classRecord.fieldMap.set(fieldInfo.name, fieldInfo);
    classRecord.fields.push(fieldInfo);
  } else {
    // Enrich missing typeName if later assigned with an explicit annotation/type
    if (!existing.typeName && fieldInfo.typeName) {
      existing.typeName = fieldInfo.typeName;
    }
    if (!existing.initializerType && fieldInfo.initializerType) {
      existing.initializerType = fieldInfo.initializerType;
    }
  }
}

function parseDecoratorHeader(buf, tokens, startIdx, endIdx) {
  // `@dec` or `@pkg.dec(...)`
  let i = startIdx + 1;
  const parts = [];
  let startOff = -1;
  let endOff = -1;
  while (i < endIdx) {
    if (tokens[i].kind === "ident") {
      if (startOff < 0) startOff = tokens[i].start;
      endOff = tokens[i].end;
      parts.push(tokens[i].value);
      i += 1;
      if (i < endIdx && tokens[i].value === ".") {
        i += 1;
        continue;
      }
      break;
    }
    break;
  }
  if (!parts.length) return null;
  const pos = offsetToLineCol(buf, startOff);
  return {
    name: parts.join("."),
    leaf: parts[parts.length - 1],
    line: pos.line,
    col: pos.col,
  };
}

function parseClassHeader(buf, tokens, startIdx, endIdx, decorators) {
  // `class Name[T](Base1, Base2, metaclass=ABCMeta):`
  const nameTok = tokens[startIdx + 1];
  if (!nameTok || nameTok.kind !== "ident") return null;
  const namePos = offsetToLineCol(buf, nameTok.start);
  let idx = startIdx + 2;

  // Optional Python 3.12 type parameters `[T, U]`
  const typeParams = [];
  if (idx < endIdx && tokens[idx].value === "[") {
    const closeBr = findMatchingToken(tokens, idx);
    if (closeBr > idx) {
      const tpChunks = splitTokensAtTopLevel(tokens, idx + 1, closeBr, ",");
      for (let ti = 0; ti < tpChunks.length; ti += 1) {
        const [ts, te] = tpChunks[ti];
        if (ts < te && tokens[ts].kind === "ident") {
          const tpPos = offsetToLineCol(buf, tokens[ts].start);
          typeParams.push({ name: tokens[ts].value, line: tpPos.line, col: tpPos.col });
        }
      }
      idx = closeBr + 1;
    }
  }

  const baseClasses = [];
  let isAbstractByMeta = false;
  if (idx < endIdx && tokens[idx].value === "(") {
    const closeParen = findMatchingToken(tokens, idx);
    if (closeParen > idx) {
      const argChunks = splitTokensAtTopLevel(tokens, idx + 1, closeParen, ",");
      for (let ai = 0; ai < argChunks.length; ai += 1) {
        const [as, ae] = argChunks[ai];
        if (as >= ae) continue;
        const eqIdx = findTopLevelToken(tokens, as, ae, "=");
        if (eqIdx >= 0) {
          if (tokens[as].value === "metaclass" && eqIdx + 1 < ae) {
            const metaText = buf.text.slice(tokens[eqIdx + 1].start, tokens[ae - 1].end).trim();
            if (metaText === "ABCMeta" || metaText.endsWith(".ABCMeta")) {
              isAbstractByMeta = true;
            }
          }
          continue;
        }
        // Extract base class name (strip generic `[...]`)
        const parts = [];
        for (let k = as; k < ae; k += 1) {
          if (tokens[k].value === "[") break;
          if (tokens[k].kind === "ident") parts.push(tokens[k].value);
          else if (tokens[k].value !== ".") break;
        }
        if (parts.length > 0) {
          const baseName = parts.join(".");
          baseClasses.push(baseName);
          if (baseName === "ABC" || baseName === "abc.ABC" || baseName === "Protocol" || baseName === "typing.Protocol") {
            isAbstractByMeta = true;
          }
        }
      }
      idx = closeParen + 1;
    }
  }

  const colonIdx = findTopLevelToken(tokens, idx, endIdx, ":");
  const sigEndOffset = colonIdx >= 0 ? tokens[colonIdx].start : tokens[endIdx - 1].end;
  const signature = collapseSignature(buf.rawText.slice(tokens[startIdx].start, sigEndOffset));

  return {
    name: nameTok.value,
    line: namePos.line,
    column: namePos.col,
    headerEndLine: buf.endLine,
    extends: baseClasses,
    annotations: decorators.map((d) => d.name),
    isAbstract: isAbstractByMeta,
    isDataclass: decorators.some((d) => d.leaf === "dataclass"),
    signature,
    typeParams,
  };
}

function parseDefHeader(buf, tokens, startIdx, endIdx, decorators, scope, knownFunctions) {
  let idx = startIdx;
  let isAsync = false;
  if (tokens[idx]?.value === "async") {
    isAsync = true;
    idx += 1;
  }
  if (tokens[idx]?.value !== "def") return null;
  const nameTok = tokens[idx + 1];
  if (!nameTok || nameTok.kind !== "ident") return null;
  const namePos = offsetToLineCol(buf, nameTok.start);
  idx += 2;

  // Optional Python 3.12 type parameters `[T]`
  const typeParams = [];
  if (idx < endIdx && tokens[idx].value === "[") {
    const closeBr = findMatchingToken(tokens, idx);
    if (closeBr > idx) {
      const tpChunks = splitTokensAtTopLevel(tokens, idx + 1, closeBr, ",");
      for (let ti = 0; ti < tpChunks.length; ti += 1) {
        const [ts, te] = tpChunks[ti];
        if (ts < te && tokens[ts].kind === "ident") {
          const tpPos = offsetToLineCol(buf, tokens[ts].start);
          typeParams.push({ name: tokens[ts].value, line: tpPos.line, col: tpPos.col });
        }
      }
      idx = closeBr + 1;
    }
  }

  let openParenIdx = -1;
  let closeParenIdx = -1;
  if (idx < endIdx && tokens[idx].value === "(") {
    openParenIdx = idx;
    closeParenIdx = findMatchingToken(tokens, idx);
    if (closeParenIdx > openParenIdx) {
      idx = closeParenIdx + 1;
    }
  }

  let returnType = null;
  const colonIdx = findTopLevelToken(tokens, idx, endIdx, ":");
  const tailEnd = colonIdx >= 0 ? colonIdx : endIdx;
  if (idx < tailEnd && tokens[idx].value === "->") {
    returnType = extractTypeStringFromSlice(buf, tokens, idx + 1, tailEnd);
  }

  const sigEndOffset = colonIdx >= 0 ? tokens[colonIdx].start : tokens[endIdx - 1].end;
  const signature = collapseSignature(buf.rawText.slice(tokens[startIdx].start, sigEndOffset));

  const params = parseParamList(buf, tokens, openParenIdx, closeParenIdx, scope, knownFunctions);

  return {
    name: nameTok.value,
    line: namePos.line,
    column: namePos.col,
    headerEndLine: buf.endLine,
    isAsync,
    params,
    typeParams,
    returnType,
    signature,
    annotations: decorators.map((d) => d.name),
    decoratorLeaves: decorators.map((d) => d.leaf),
  };
}

function classifyMethodDecorators(decorators) {
  let kind = "method";
  let isAbstract = false;
  let isOverload = false;
  for (let i = 0; i < decorators.length; i += 1) {
    const d = decorators[i];
    const leaf = d.leaf;
    const full = d.name;
    if (leaf === "staticmethod") kind = "staticmethod";
    else if (leaf === "classmethod") kind = "classmethod";
    else if (leaf === "property" || leaf === "cached_property" || full.endsWith(".setter") || full.endsWith(".deleter")) {
      kind = "property";
    }
    if (leaf === "abstractmethod") isAbstract = true;
    if (leaf === "overload") isOverload = true;
  }
  return { kind, isAbstract, isOverload };
}

function parseAllListFromAssignment(buf, tokens, eqIdx, endIdx, analysis) {
  if (eqIdx + 1 >= endIdx) return;
  const openTok = tokens[eqIdx + 1];
  if (openTok.value !== "[" && openTok.value !== "(") return;
  const closeIdx = findMatchingToken(tokens, eqIdx + 1);
  if (closeIdx < 0) return;

  const lits = extractStringLiteralsInRange(buf, openTok.start, tokens[closeIdx].end);
  for (let i = 0; i < lits.length; i += 1) {
    const name = lits[i].value.trim();
    if (name && !analysis.allExportSet.has(name)) {
      analysis.allExportSet.add(name);
      analysis.allExportEntries.push({
        name,
        line: lits[i].line,
        column: lits[i].col,
      });
    }
  }
  analysis.hasAllExport = true;
}

function buildTopVarKind(name, declaredType, initializerType) {
  if (initializerType === "TypeVar" || initializerType === "ParamSpec" ||
      initializerType === "TypeVarTuple" || declaredType === "TypeAlias") {
    return "type";
  }
  if (isConstantIdent(name) || (declaredType && (declaredType === "Final" || declaredType.startsWith("Final[")))) {
    return "constant";
  }
  return "variable";
}

function handleRegularStatement(buf, tokens, startIdx, endIdx, curBlock, analysis) {
  if (startIdx >= endIdx) return;
  const scope = curBlock.scope;
  const firstTok = tokens[startIdx];
  const kw = firstTok.kind === "ident" ? firstTok.value : "";

  // `global a, b`
  if (kw === "global") {
    for (let i = startIdx + 1; i < endIdx; i += 1) {
      if (tokens[i].kind === "ident") {
        scope.globals.add(tokens[i].value);
      }
    }
    return;
  }

  // `nonlocal a, b`
  if (kw === "nonlocal") {
    for (let i = startIdx + 1; i < endIdx; i += 1) {
      if (tokens[i].kind === "ident") {
        scope.nonlocals.add(tokens[i].value);
      }
    }
    return;
  }

  // `type Alias = ...` (Python 3.12 soft keyword)
  if (kw === "type" && startIdx + 2 < endIdx && tokens[startIdx + 1].kind === "ident") {
    const eqPos = findTopLevelToken(tokens, startIdx + 2, endIdx, "=");
    if (eqPos === startIdx + 2 || (tokens[startIdx + 2].value === "[" && eqPos > startIdx + 2)) {
      const nameTok = tokens[startIdx + 1];
      const pos = offsetToLineCol(buf, nameTok.start);
      const sig = collapseSignature(buf.rawText.slice(firstTok.start, tokens[endIdx - 1].end));
      const binding = {
        name: nameTok.value,
        kind: "type",
        line: pos.line,
        column: pos.col,
        declaredType: "TypeAlias",
        initializerType: null,
        signature: sig,
      };
      addBinding(scope, nameTok.value, binding);
      if (scope.kind === "module") {
        analysis.topVariables.push({
          name: nameTok.value,
          kind: "type",
          line: pos.line,
          column: pos.col,
          isExported: !nameTok.value.startsWith("_"),
          declaredType: "TypeAlias",
          initializerType: null,
          signature: sig,
        });
      }
      scanExpressionSubScopes(buf, tokens, eqPos + 1, endIdx, scope, analysis.moduleFuncMap);
      return;
    }
  }

  // `for` / `async for`
  if (kw === "for" || (kw === "async" && tokens[startIdx + 1]?.value === "for")) {
    const forIdx = kw === "async" ? startIdx + 1 : startIdx;
    const inIdx = findTopLevelToken(tokens, forIdx + 1, endIdx, "in");
    if (inIdx > forIdx + 1) {
      const colonIdx = findTopLevelToken(tokens, inIdx + 1, endIdx, ":");
      const iterEnd = colonIdx >= 0 ? colonIdx : endIdx;
      const targets = extractPatternTargets(buf, tokens, forIdx + 1, inIdx);
      const sig = collapseSignature(buf.rawText.slice(tokens[forIdx].start, tokens[iterEnd - 1].end));
      for (let ti = 0; ti < targets.length; ti += 1) {
        const t = targets[ti];
        if (t.kind === "ident") {
          bindVarInScope(scope, t.name, {
            name: t.name,
            kind: "variable",
            line: t.line,
            column: t.col,
            declaredType: null,
            initializerType: null,
            signature: sig,
          }, analysis);
        }
      }
      scanExpressionSubScopes(buf, tokens, inIdx + 1, iterEnd, scope, analysis.moduleFuncMap);
    }
    return;
  }

  // `with` / `async with`
  if (kw === "with" || (kw === "async" && tokens[startIdx + 1]?.value === "with")) {
    const withIdx = kw === "async" ? startIdx + 1 : startIdx;
    const colonIdx = findTopLevelToken(tokens, withIdx + 1, endIdx, ":");
    const itemsEnd = colonIdx >= 0 ? colonIdx : endIdx;
    let itemStart = withIdx + 1;
    let itemEnd = itemsEnd;
    if (itemStart < itemEnd && tokens[itemStart].value === "(") {
      const close = findMatchingToken(tokens, itemStart);
      if (close === itemEnd - 1) {
        itemStart += 1;
        itemEnd = close;
      }
    }
    const items = splitTokensAtTopLevel(tokens, itemStart, itemEnd, ",");
    for (let ii = 0; ii < items.length; ii += 1) {
      const [is, ie] = items[ii];
      if (is >= ie) continue;
      const asIdx = findTopLevelToken(tokens, is, ie, "as");
      if (asIdx > is && asIdx + 1 < ie) {
        const exprType = inferExprType(buf, tokens, is, asIdx, scope, analysis.moduleFuncMap);
        const targets = extractPatternTargets(buf, tokens, asIdx + 1, ie);
        const sig = collapseSignature(buf.rawText.slice(tokens[is].start, tokens[ie - 1].end));
        for (let ti = 0; ti < targets.length; ti += 1) {
          const t = targets[ti];
          if (t.kind === "ident") {
            bindVarInScope(scope, t.name, {
              name: t.name,
              kind: "variable",
              line: t.line,
              column: t.col,
              declaredType: null,
              initializerType: targets.length === 1 ? exprType : null,
              signature: sig,
            }, analysis);
          }
        }
        scanExpressionSubScopes(buf, tokens, is, asIdx, scope, analysis.moduleFuncMap);
      } else {
        scanExpressionSubScopes(buf, tokens, is, ie, scope, analysis.moduleFuncMap);
      }
    }
    return;
  }

  // `except` / `except*`
  if (kw === "except") {
    const colonIdx = findTopLevelToken(tokens, startIdx + 1, endIdx, ":");
    const headerEnd = colonIdx >= 0 ? colonIdx : endIdx;
    const asIdx = findTopLevelToken(tokens, startIdx + 1, headerEnd, "as");
    if (asIdx > startIdx + 1 && asIdx + 1 < headerEnd && tokens[asIdx + 1].kind === "ident") {
      const nameTok = tokens[asIdx + 1];
      const pos = offsetToLineCol(buf, nameTok.start);
      let excStart = startIdx + 1;
      if (tokens[excStart]?.value === "*") excStart += 1;
      const excType = extractTypeStringFromSlice(buf, tokens, excStart, asIdx);
      const sig = collapseSignature(buf.rawText.slice(firstTok.start, tokens[headerEnd - 1].end));
      const binding = {
        name: nameTok.value,
        kind: "variable",
        line: pos.line,
        column: pos.col,
        declaredType: excType,
        initializerType: null,
        signature: sig,
        blockSpan: curBlock.exceptSpan || null,
      };
      addBinding(scope, nameTok.value, binding, true);
    }
    return;
  }

  // Other suite headers (`if`, `elif`, `while`, `match`, `case`) -> scan expression for walrus/lambda/comprehensions
  if (kw === "if" || kw === "elif" || kw === "while" || kw === "match" || kw === "case") {
    const colonIdx = findTopLevelToken(tokens, startIdx + 1, endIdx, ":");
    const exprEnd = colonIdx >= 0 ? colonIdx : endIdx;
    scanExpressionSubScopes(buf, tokens, startIdx + 1, exprEnd, scope, analysis.moduleFuncMap);
    return;
  }

  // Check for augmented assignment (`x += y`): scan RHS only, do not create a new binding unless unknown?
  // In Python `x += y` requires `x` to already be bound; keep existing declaration.
  for (let i = startIdx; i < endIdx; i += 1) {
    if (tokens[i].kind === "op" && AUGMENT_ASSIGN_OPS.has(tokens[i].value)) {
      // Special case: `__all__ += [...]`
      if (tokens[startIdx].kind === "ident" && tokens[startIdx].value === "__all__" &&
          tokens[i].value === "+=" && scope.kind === "module") {
        parseAllListFromAssignment(buf, tokens, i, endIdx, analysis);
        return;
      }
      scanExpressionSubScopes(buf, tokens, i + 1, endIdx, scope, analysis.moduleFuncMap);
      return;
    }
  }

  // Check for top-level assignment `=` or annotated assignment `:`
  const eqIndices = [];
  let depth = 0;
  for (let i = startIdx; i < endIdx; i += 1) {
    const v = tokens[i].value;
    if (v === "(" || v === "[" || v === "{") depth += 1;
    else if (v === ")" || v === "]" || v === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && v === "=") eqIndices.push(i);
  }

  const firstEq = eqIndices.length > 0 ? eqIndices[0] : -1;
  const lhsEnd = firstEq >= 0 ? firstEq : endIdx;
  const colonIdx = findTopLevelToken(tokens, startIdx, lhsEnd, ":");

  // Annotated target: `name: Type` or `name: Type = rhs` or `self.attr: Type [= rhs]`
  if (colonIdx > startIdx) {
    const sig = collapseSignature(buf.rawText.slice(firstTok.start, tokens[endIdx - 1].end));
    const typeEnd = firstEq >= 0 ? firstEq : endIdx;
    const declaredType = extractTypeStringFromSlice(buf, tokens, colonIdx + 1, typeEnd);
    const rhsStart = firstEq >= 0 ? firstEq + 1 : -1;
    const initType = rhsStart >= 0 ? inferExprType(buf, tokens, rhsStart, endIdx, scope, analysis.moduleFuncMap) : null;
    if (rhsStart >= 0) {
      scanExpressionSubScopes(buf, tokens, rhsStart, endIdx, scope, analysis.moduleFuncMap);
    }

    // Simple `ident: Type [= rhs]`
    if (colonIdx - startIdx === 1 && tokens[startIdx].kind === "ident") {
      const nameTok = tokens[startIdx];
      const name = nameTok.value;
      const pos = offsetToLineCol(buf, nameTok.start);
      if (name === "__all__" && scope.kind === "module" && firstEq >= 0) {
        parseAllListFromAssignment(buf, tokens, firstEq, endIdx, analysis);
        return;
      }
      if (scope.kind === "class" && curBlock.classRecord) {
        const isClassVar = Boolean(declaredType && (declaredType === "ClassVar" || declaredType.startsWith("ClassVar[")));
        const isStatic = curBlock.classRecord.isDataclass ? isClassVar : true;
        recordClassField(curBlock.classRecord, {
          name,
          typeName: declaredType || initType || null,
          line: pos.line,
          column: pos.col,
          signature: sig,
          isStatic,
          initializerType: initType,
        });
        addBinding(scope, name, {
          name,
          kind: "field",
          line: pos.line,
          column: pos.col,
          containerName: curBlock.classRecord.name,
          declaredType: declaredType || initType || null,
          initializerType: initType,
          signature: sig,
        });
        return;
      }
      const varKind = scope.kind === "module" ? buildTopVarKind(name, declaredType, initType) : "variable";
      bindVarInScope(scope, name, {
        name,
        kind: varKind,
        line: pos.line,
        column: pos.col,
        declaredType,
        initializerType: initType,
        signature: sig,
      }, analysis);
      return;
    }

    // `self.attr: Type [= rhs]`
    if (colonIdx - startIdx === 3 && tokens[startIdx].value === "self" &&
        tokens[startIdx + 1].value === "." && tokens[startIdx + 2].kind === "ident" &&
        scope.enclosingClass) {
      const attrTok = tokens[startIdx + 2];
      const pos = offsetToLineCol(buf, attrTok.start);
      recordClassField(scope.enclosingClass, {
        name: attrTok.value,
        typeName: declaredType || initType || null,
        line: pos.line,
        column: pos.col,
        signature: sig,
        isStatic: false,
        initializerType: initType,
      });
      return;
    }
  }

  // Plain or chained assignment `a = b = rhs` / `a, b = rhs` / `self.attr = rhs`
  if (eqIndices.length > 0) {
    const lastEq = eqIndices[eqIndices.length - 1];
    const rhsStart = lastEq + 1;
    const rhsEnd = endIdx;
    const sig = collapseSignature(buf.rawText.slice(firstTok.start, tokens[endIdx - 1].end));

    // `__all__ = [...]`
    if (eqIndices.length === 1 && firstEq - startIdx === 1 &&
        tokens[startIdx].kind === "ident" && tokens[startIdx].value === "__all__" &&
        scope.kind === "module") {
      parseAllListFromAssignment(buf, tokens, firstEq, endIdx, analysis);
      return;
    }

    const initType = inferExprType(buf, tokens, rhsStart, rhsEnd, scope, analysis.moduleFuncMap);
    scanExpressionSubScopes(buf, tokens, rhsStart, rhsEnd, scope, analysis.moduleFuncMap);

    let prevTargetStart = startIdx;
    for (let ei = 0; ei < eqIndices.length; ei += 1) {
      const eqPos = eqIndices[ei];
      const targets = extractPatternTargets(buf, tokens, prevTargetStart, eqPos);
      const singleTarget = targets.length === 1;
      for (let ti = 0; ti < targets.length; ti += 1) {
        const t = targets[ti];
        if (t.kind === "self_attr" && scope.enclosingClass) {
          let inferredFieldType = singleTarget ? initType : null;
          // If `self.repo = repo` and `repo` is a typed parameter or local variable
          if (!inferredFieldType && singleTarget && rhsEnd - rhsStart === 1 && tokens[rhsStart].kind === "ident") {
            const rhsFound = lookupInScopeChain(scope, tokens[rhsStart].value, true);
            if (rhsFound?.binding) {
              inferredFieldType = rhsFound.binding.declaredType || rhsFound.binding.initializerType || null;
            }
          }
          recordClassField(scope.enclosingClass, {
            name: t.name,
            typeName: inferredFieldType,
            line: t.line,
            column: t.col,
            signature: sig,
            isStatic: false,
            initializerType: singleTarget ? initType : null,
          });
        } else if (t.kind === "ident") {
          if (scope.kind === "class" && curBlock.classRecord) {
            recordClassField(curBlock.classRecord, {
              name: t.name,
              typeName: singleTarget ? initType : null,
              line: t.line,
              column: t.col,
              signature: sig,
              isStatic: true,
              initializerType: singleTarget ? initType : null,
            });
            addBinding(scope, t.name, {
              name: t.name,
              kind: "field",
              line: t.line,
              column: t.col,
              containerName: curBlock.classRecord.name,
              declaredType: null,
              initializerType: singleTarget ? initType : null,
              signature: sig,
            });
          } else {
            const varKind = scope.kind === "module" ? buildTopVarKind(t.name, null, singleTarget ? initType : null) : "variable";
            bindVarInScope(scope, t.name, {
              name: t.name,
              kind: varKind,
              line: t.line,
              column: t.col,
              declaredType: null,
              initializerType: singleTarget ? initType : null,
              signature: sig,
            }, analysis);
          }
        }
      }
      prevTargetStart = eqPos + 1;
    }
    return;
  }

  // Standalone expression (calls, comprehensions, walrus, lambdas, etc.)
  scanExpressionSubScopes(buf, tokens, startIdx, endIdx, scope, analysis.moduleFuncMap);
}

function bindVarInScope(scope, name, binding, analysis) {
  if (!name || PY_HARD_KEYWORDS.has(name)) return;
  if (scope.globals.has(name)) {
    const mod = getModuleScope(scope);
    if (!mod.bindings.has(name)) {
      addBinding(mod, name, binding);
      analysis.topVariables.push({
        name,
        kind: buildTopVarKind(name, binding.declaredType, binding.initializerType),
        line: binding.line,
        column: binding.column,
        isExported: !name.startsWith("_"),
        declaredType: binding.declaredType || null,
        initializerType: binding.initializerType || null,
        signature: binding.signature,
      });
    }
    return;
  }
  if (scope.nonlocals.has(name)) {
    return;
  }
  const existed = scope.bindings.has(name);
  addBinding(scope, name, binding);
  if (scope.kind === "module" && !existed) {
    analysis.topVariables.push({
      name,
      kind: binding.kind || "variable",
      line: binding.line,
      column: binding.column,
      isExported: !name.startsWith("_"),
      declaredType: binding.declaredType || null,
      initializerType: binding.initializerType || null,
      signature: binding.signature,
    });
  }
}

/**
 * Parse entire Python source into symbol summary + LEGB scope tree + lookup structures.
 */
function analyzePythonSource(sourceText, filePath = "", options = {}) {
  const summaryOnly = Boolean(options?.summaryOnly);
  const rawLines = Array.isArray(options?.lines) ? options.lines : splitCodeLinesExpanded(sourceText);
  const maskedLines = Array.isArray(options?.maskedLines) ? options.maskedLines : maskNonCodeRegions(rawLines, "python");
  const { statements, rawIndentLines } = collectLogicalStatements(rawLines, maskedLines);

  const moduleScope = createScope({
    id: "module",
    kind: "module",
    name: "",
    parent: null,
    startLine: 1,
    startCol: 1,
    endLine: Math.max(1, rawLines.length),
    endCol: 1e9,
  });

  const analysis = {
    filePath,
    summaryOnly,
    rawLines,
    maskedLines,
    moduleScope,
    imports: [],
    exports: [],
    reExports: [],
    types: [],
    functions: [],
    topVariables: [],
    classMap: new Map(), // name -> classRecord (top-level or local)
    moduleFuncMap: new Map(), // name -> fnRecord
    importRegions: [],
    defHeaderRegions: [],
    classHeaderRegions: [],
    allExportSet: new Set(),
    allExportEntries: [],
    hasAllExport: false,
  };

  const blockStack = [{
    indent: -1,
    kind: "module",
    scope: moduleScope,
    node: null,
    classRecord: null,
    startLine: 1,
    lastCodeLine: 1,
    pendingDecorators: [],
    exceptSpan: null,
  }];

  function updateLastCodeLine(upToLine) {
    for (let i = blockStack.length - 1; i >= 0; i -= 1) {
      if (upToLine > blockStack[i].lastCodeLine) {
        blockStack[i].lastCodeLine = upToLine;
      }
    }
  }

  function popBlock() {
    const popped = blockStack.pop();
    if (!popped) return;
    if (popped.node) {
      popped.node.endLine = Math.max(popped.node.line, popped.lastCodeLine);
    }
    if (popped.scope && popped.scope !== moduleScope) {
      popped.scope.endLine = Math.max(popped.scope.startLine, popped.lastCodeLine);
    }
    if (popped.exceptSpan) {
      popped.exceptSpan.endLine = Math.max(popped.exceptSpan.startLine, popped.lastCodeLine);
    }
  }

  // Also track raw indent lines (like docstrings) to advance lastCodeLine accurately
  let rawLineCursor = 0;
  function advanceRawLinesBefore(targetLine, nextStmtIndent) {
    while (rawLineCursor < rawIndentLines.length && rawIndentLines[rawLineCursor].line < targetLine) {
      const rl = rawIndentLines[rawLineCursor];
      rawLineCursor += 1;
      for (let i = blockStack.length - 1; i >= 1; i -= 1) {
        if (rl.indent > blockStack[i].indent) {
          if (rl.line > blockStack[i].lastCodeLine) {
            blockStack[i].lastCodeLine = rl.line;
          }
        }
      }
      // Also advance module block
      if (rl.line > blockStack[0].lastCodeLine) {
        blockStack[0].lastCodeLine = rl.line;
      }
    }
  }

  let skipNestedIndent = -1;
  for (let si = 0; si < statements.length; si += 1) {
    const buf = statements[si];
    advanceRawLinesBefore(buf.startLine, buf.indent);

    // Pop any indentation blocks with indent >= buf.indent
    while (blockStack.length > 1 && blockStack[blockStack.length - 1].indent >= buf.indent) {
      popBlock();
    }

    updateLastCodeLine(buf.endLine);

    if (summaryOnly && blockStack[blockStack.length - 1].scope.kind === "function") {
      if (skipNestedIndent >= 0) {
        if (buf.indent > skipNestedIndent) continue;
        skipNestedIndent = -1;
      }
      const txt = buf.text;
      if (
        txt.startsWith("def ", buf.indent) ||
        txt.startsWith("async def ", buf.indent) ||
        txt.startsWith("class ", buf.indent)
      ) {
        skipNestedIndent = buf.indent;
        if (!txt.includes("import")) continue;
      } else {
        const curBlock = blockStack[blockStack.length - 1];
        if (!txt.includes("import") && (!curBlock.classRecord || !txt.includes("self."))) {
          continue;
        }
      }
    } else {
      skipNestedIndent = -1;
    }

    const allTokens = tokenizeBufferRange(buf.text, 0, buf.text.length);
    if (allTokens.length === 0) continue;
    if (summaryOnly) allTokens._summaryOnly = true;

    // Decorator line (`@decorator`)
    if (allTokens[0].value === "@") {
      const dec = parseDecoratorHeader(buf, allTokens, 0, allTokens.length);
      if (dec) {
        blockStack[blockStack.length - 1].pendingDecorators.push(dec);
      }
      continue;
    }

    const subStmts = expandSubStatements(buf, allTokens);
    let inlineOpenedBlock = false;

    for (let ssi = 0; ssi < subStmts.length; ssi += 1) {
      const sub = subStmts[ssi];
      const curBlock = blockStack[blockStack.length - 1];
      const tokens = allTokens;
      const s = sub.startIdx;
      const e = sub.endIdx;
      if (s >= e) continue;

      const firstVal = tokens[s].kind === "ident" ? tokens[s].value : "";
      const secondVal = s + 1 < e && tokens[s + 1].kind === "ident" ? tokens[s + 1].value : "";

      // Imports
      if (firstVal === "import" || firstVal === "from") {
        curBlock.pendingDecorators = [];
        parseImportStatement(buf, tokens, s, e, curBlock.scope, analysis);
        continue;
      }

      // Class definition
      if (firstVal === "class" && secondVal) {
        const decorators = curBlock.pendingDecorators;
        curBlock.pendingDecorators = [];
        const cls = parseClassHeader(buf, tokens, s, e, decorators);
        if (cls) {
          const classRecord = {
            name: cls.name,
            kind: "class",
            line: cls.line,
            column: cls.column,
            endLine: buf.endLine,
            isAbstract: cls.isAbstract,
            isExported: !cls.name.startsWith("_"),
            extends: cls.extends,
            implements: [],
            annotations: cls.annotations,
            fields: [],
            constructors: [],
            methods: [],
            fieldMap: new Map(),
            isDataclass: cls.isDataclass,
            signature: cls.signature,
            headerStartLine: buf.startLine,
            headerEndLine: cls.headerEndLine,
            baseClassesLine: buf.startLine,
          };

          if (curBlock.scope.kind === "module") {
            analysis.types.push(classRecord);
            analysis.classMap.set(cls.name, classRecord);
          } else if (!analysis.classMap.has(cls.name)) {
            analysis.classMap.set(cls.name, classRecord);
          }

          addBinding(curBlock.scope, cls.name, {
            name: cls.name,
            kind: "class",
            line: cls.line,
            column: cls.column,
            signature: cls.signature,
            classRecord,
          });

          const clsScope = createScope({
            id: `class:${cls.name}:${cls.line}`,
            kind: "class",
            name: cls.name,
            parent: curBlock.scope,
            startLine: buf.endLine + 1,
            startCol: 1,
            endLine: rawLines.length + 1,
            endCol: 1e9,
            headerEndLine: buf.endLine,
            enclosingClass: classRecord,
          });
          curBlock.scope.children.push(clsScope);

          for (let ti = 0; ti < cls.typeParams.length; ti += 1) {
            const tp = cls.typeParams[ti];
            addBinding(clsScope, tp.name, {
              name: tp.name,
              kind: "type",
              line: tp.line,
              column: tp.col,
              signature: `type ${tp.name}`,
            });
          }

          analysis.classHeaderRegions.push({
            startLine: buf.startLine,
            endLine: buf.endLine,
            scope: curBlock.scope,
            classRecord,
          });

          blockStack.push({
            indent: buf.indent,
            kind: "class",
            scope: clsScope,
            node: classRecord,
            classRecord,
            startLine: buf.startLine,
            lastCodeLine: buf.endLine,
            pendingDecorators: [],
            exceptSpan: null,
          });
          if (sub.hasInlineSuite) inlineOpenedBlock = true;
        }
        continue;
      }

      // Function / Method definition (`def` or `async def`)
      if ((firstVal === "def" || (firstVal === "async" && secondVal === "def"))) {
        const decorators = curBlock.pendingDecorators;
        curBlock.pendingDecorators = [];
        const fn = parseDefHeader(buf, tokens, s, e, decorators, curBlock.scope, analysis.moduleFuncMap);
        if (fn) {
          const isMethod = Boolean(curBlock.kind === "class" && curBlock.classRecord);
          const ownerClass = isMethod ? curBlock.classRecord : null;
          const { kind: methodKind, isAbstract, isOverload } = classifyMethodDecorators(decorators);
          if (ownerClass && isAbstract) {
            ownerClass.isAbstract = true;
          }

          const implicitParamCount =
            isMethod && methodKind !== "staticmethod" && fn.params.length > 0 ? 1 : 0;
          const arity = Math.max(0, fn.params.length - implicitParamCount);

          let fnNode = null;
          if (isMethod && ownerClass) {
            if (fn.name === "__init__") {
              const ctorRecord = {
                line: fn.line,
                column: fn.column,
                arity,
                signature: fn.signature,
                endLine: buf.endLine,
              };
              ownerClass.constructors.push(ctorRecord);
              fnNode = ctorRecord;
            } else {
              const methodRecord = {
                name: fn.name,
                kind: methodKind,
                line: fn.line,
                column: fn.column,
                arity,
                isAbstract,
                isDefault: false,
                isStatic: methodKind === "staticmethod",
                returnType: fn.returnType,
                annotations: fn.annotations,
                signature: fn.signature,
                endLine: buf.endLine,
                isOverload,
              };
              ownerClass.methods.push(methodRecord);
              fnNode = methodRecord;
            }
          } else {
            const fnRecord = {
              name: fn.name,
              kind: "function",
              line: fn.line,
              column: fn.column,
              endLine: buf.endLine,
              arity,
              isAsync: fn.isAsync,
              isExported: !fn.name.startsWith("_"),
              returnType: fn.returnType,
              signature: fn.signature,
              isOverload,
            };
            if (curBlock.scope.kind === "module") {
              analysis.functions.push(fnRecord);
              // Keep non-overload function for return type lookup
              if (!analysis.moduleFuncMap.has(fn.name) || !isOverload) {
                analysis.moduleFuncMap.set(fn.name, fnRecord);
              }
            }
            addBinding(curBlock.scope, fn.name, {
              name: fn.name,
              kind: "function",
              line: fn.line,
              column: fn.col || fn.column,
              arity,
              signature: fn.signature,
              returnType: fn.returnType,
              isOverload,
              funcRecord: fnRecord,
            }, true);
            fnNode = fnRecord;
          }

          const fnScope = createScope({
            id: `def:${fn.name}:${fn.line}`,
            kind: "function",
            name: fn.name,
            parent: curBlock.scope,
            startLine: buf.startLine,
            startCol: 1,
            endLine: rawLines.length + 1,
            endCol: 1e9,
            headerEndLine: buf.endLine,
            enclosingClass: ownerClass,
          });
          curBlock.scope.children.push(fnScope);

          for (let ti = 0; ti < fn.typeParams.length; ti += 1) {
            const tp = fn.typeParams[ti];
            addBinding(fnScope, tp.name, {
              name: tp.name,
              kind: "type",
              line: tp.line,
              column: tp.col,
              signature: `type ${tp.name}`,
            });
          }

          const paramRanges = [];
          for (let pi = 0; pi < fn.params.length; pi += 1) {
            const p = fn.params[pi];
            paramRanges.push({ startLine: p.line, startCol: p.col, endCol: p.col + p.name.length - 1, name: p.name });
            addBinding(fnScope, p.name, {
              name: p.name,
              kind: "parameter",
              line: p.line,
              column: p.col,
              containerName: fn.name,
              declaredType: p.declaredType,
              initializerType: p.initializerType,
              signature: p.declaredType ? `${p.name}: ${p.declaredType}` : p.name,
            });
          }

          analysis.defHeaderRegions.push({
            startLine: buf.startLine,
            endLine: buf.endLine,
            headerScope: curBlock.scope,
            fnScope,
            fnName: fn.name,
            fnNameLine: fn.line,
            fnNameCol: fn.column,
            paramRanges,
            isMethod,
            ownerClass,
          });

          blockStack.push({
            indent: buf.indent,
            kind: "function",
            scope: fnScope,
            node: fnNode,
            classRecord: ownerClass,
            startLine: buf.startLine,
            lastCodeLine: buf.endLine,
            pendingDecorators: [],
            exceptSpan: null,
          });
          if (sub.hasInlineSuite) inlineOpenedBlock = true;
        }
        continue;
      }

      // Control blocks (`if`, `elif`, `else`, `for`, `while`, `with`, `try`, `except`, `finally`, `match`, `case`)
      const headControlKw = firstVal === "async" ? secondVal : firstVal;
      if (sub.hasInlineSuite || (
        (headControlKw === "if" || headControlKw === "elif" || headControlKw === "else" ||
         headControlKw === "for" || headControlKw === "while" || headControlKw === "with" ||
         headControlKw === "try" || headControlKw === "except" || headControlKw === "finally" ||
         headControlKw === "match" || headControlKw === "case") &&
        findSuiteColonIndex(tokens, s, e, headControlKw) >= 0
      )) {
        curBlock.pendingDecorators = [];
        const exceptSpan = headControlKw === "except"
          ? { startLine: buf.startLine, endLine: buf.endLine }
          : null;
        const ctrlBlock = {
          indent: buf.indent,
          kind: "control",
          scope: curBlock.scope,
          node: null,
          classRecord: curBlock.classRecord,
          startLine: buf.startLine,
          lastCodeLine: buf.endLine,
          pendingDecorators: [],
          exceptSpan,
        };
        handleRegularStatement(buf, tokens, s, e, ctrlBlock, analysis);
        blockStack.push(ctrlBlock);
        if (sub.hasInlineSuite) inlineOpenedBlock = true;
        continue;
      }

      curBlock.pendingDecorators = [];
      handleRegularStatement(buf, tokens, s, e, curBlock, analysis);
    }

    if (inlineOpenedBlock && blockStack.length > 1) {
      popBlock();
    }
  }

  // Advance remaining raw lines (e.g. trailing docstrings) and close remaining blocks
  advanceRawLinesBefore(rawLines.length + 1, 0);
  while (blockStack.length > 1) {
    popBlock();
  }

  finalizeExportsAndSummary(analysis);
  return analysis;
}

function finalizeExportsAndSummary(analysis) {
  const {
    imports,
    exports,
    reExports,
    types,
    functions,
    topVariables,
    allExportSet,
    allExportEntries,
    hasAllExport,
    filePath,
  } = analysis;

  const isInitFile = PY_INIT_FILE_RE.test(filePath || "");
  const importByLocal = new Map();
  for (let i = 0; i < imports.length; i += 1) {
    if (imports[i].localName !== "*") {
      importByLocal.set(imports[i].localName, imports[i]);
    }
  }

  // Build maps of local top-level definitions
  const localDefMap = new Map();
  for (let i = 0; i < types.length; i += 1) {
    localDefMap.set(types[i].name, { kind: "class", line: types[i].line, column: types[i].column, ref: types[i] });
  }
  for (let i = 0; i < functions.length; i += 1) {
    if (!localDefMap.has(functions[i].name) || !functions[i].isOverload) {
      localDefMap.set(functions[i].name, { kind: "function", line: functions[i].line, column: functions[i].column, ref: functions[i] });
    }
  }
  for (let i = 0; i < topVariables.length; i += 1) {
    if (!localDefMap.has(topVariables[i].name)) {
      localDefMap.set(topVariables[i].name, { kind: topVariables[i].kind, line: topVariables[i].line, column: topVariables[i].column, ref: topVariables[i] });
    }
  }

  if (hasAllExport) {
    for (let i = 0; i < types.length; i += 1) types[i].isExported = allExportSet.has(types[i].name);
    for (let i = 0; i < functions.length; i += 1) functions[i].isExported = allExportSet.has(functions[i].name);
    for (let i = 0; i < topVariables.length; i += 1) topVariables[i].isExported = allExportSet.has(topVariables[i].name);

    for (let i = 0; i < allExportEntries.length; i += 1) {
      const entry = allExportEntries[i];
      const def = localDefMap.get(entry.name);
      const imp = importByLocal.get(entry.name);
      if (def) {
        exports.push({
          name: entry.name,
          localName: entry.name,
          kind: def.kind,
          line: def.line,
          column: def.column,
        });
      } else if (imp) {
        reExports.push({
          exportedName: entry.name,
          localName: imp.importedName || imp.localName,
          specifier: imp.moduleSpec,
          isStar: Boolean(imp.isStar),
          line: imp.line,
          column: imp.column,
        });
        exports.push({
          name: entry.name,
          localName: imp.localName,
          kind: "reexport",
          line: imp.line,
          column: imp.column,
        });
      } else {
        exports.push({
          name: entry.name,
          localName: entry.name,
          kind: "variable",
          line: entry.line,
          column: entry.column,
        });
      }
    }
  } else {
    for (let i = 0; i < types.length; i += 1) {
      if (types[i].isExported) {
        exports.push({ name: types[i].name, localName: types[i].name, kind: "class", line: types[i].line, column: types[i].column });
      }
    }
    for (let i = 0; i < functions.length; i += 1) {
      if (functions[i].isExported) {
        exports.push({ name: functions[i].name, localName: functions[i].name, kind: "function", line: functions[i].line, column: functions[i].column });
      }
    }
    for (let i = 0; i < topVariables.length; i += 1) {
      if (topVariables[i].isExported) {
        exports.push({ name: topVariables[i].name, localName: topVariables[i].name, kind: topVariables[i].kind, line: topVariables[i].line, column: topVariables[i].column });
      }
    }
    for (let i = 0; i < imports.length; i += 1) {
      const imp = imports[i];
      if (imp.isExplicitReExport || (imp.isStar && isInitFile)) {
        reExports.push({
          exportedName: imp.isStar ? "*" : imp.localName,
          localName: imp.isStar ? "*" : (imp.importedName || imp.localName),
          specifier: imp.moduleSpec,
          isStar: Boolean(imp.isStar),
          line: imp.line,
          column: imp.column,
        });
      }
    }
  }
}

/**
 * Extract strict public FileSymbolSummary matching repository contract.
 */
export function extractFileSymbolSummary(sourceText, filePath = "") {
  const text = typeof sourceText === "string" ? sourceText : "";
  if (!isNavSourceWithinLimits(text)) {
    return {
      lang: "python",
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
  const analysis = analyzePythonSource(text, filePath || "", { summaryOnly: true });
  return {
    lang: "python",
    path: filePath || "",
    packageName: "",
    imports: analysis.imports.map((imp) => ({
      localName: imp.localName,
      importedName: imp.importedName,
      moduleSpec: imp.moduleSpec,
      relativeLevel: imp.relativeLevel,
      isStar: imp.isStar,
      line: imp.line,
      column: imp.column,
    })),
    exports: analysis.exports,
    reExports: analysis.reExports,
    types: analysis.types.map((cls) => ({
      name: cls.name,
      kind: "class",
      line: cls.line,
      column: cls.column,
      endLine: cls.endLine,
      isAbstract: cls.isAbstract,
      isExported: cls.isExported,
      extends: cls.extends,
      implements: [],
      annotations: cls.annotations,
      fields: cls.fields.map((f) => ({
        name: f.name,
        typeName: f.typeName,
        line: f.line,
        column: f.column,
        signature: f.signature,
        isStatic: f.isStatic,
        initializerType: f.initializerType,
      })),
      constructors: cls.constructors.map((c) => ({
        line: c.line,
        column: c.column,
        arity: c.arity,
        signature: c.signature,
      })),
      methods: cls.methods.map((m) => ({
        name: m.name,
        kind: m.kind,
        line: m.line,
        column: m.column,
        arity: m.arity,
        isAbstract: m.isAbstract,
        isDefault: false,
        isStatic: m.isStatic,
        returnType: m.returnType,
        annotations: m.annotations,
        signature: m.signature,
      })),
    })),
    functions: analysis.functions.map((fn) => ({
      name: fn.name,
      kind: "function",
      line: fn.line,
      column: fn.column,
      endLine: fn.endLine,
      arity: fn.arity,
      isAsync: fn.isAsync,
      isExported: fn.isExported,
      returnType: fn.returnType,
      signature: fn.signature,
    })),
    topVariables: analysis.topVariables.map((v) => ({
      name: v.name,
      kind: v.kind,
      line: v.line,
      column: v.column,
      isExported: v.isExported,
      declaredType: v.declaredType,
      initializerType: v.initializerType,
      signature: v.signature,
    })),
  };
}

// ---------------------------------------------------------------------------
// Resolution helpers for resolveInFile
// ---------------------------------------------------------------------------

function findScopeAtPosition(analysis, line, col) {
  let best = analysis.moduleScope;

  function visit(scope) {
    if (!isPosInSpan(line, col, scope.startLine, scope.startCol, scope.endLine, scope.endCol)) {
      return;
    }
    if (scope.firstIterSpan && isPosInSpan(
      line, col,
      scope.firstIterSpan.startLine, scope.firstIterSpan.startCol,
      scope.firstIterSpan.endLine, scope.firstIterSpan.endCol
    )) {
      return;
    }
    best = scope;
    for (let i = 0; i < scope.children.length; i += 1) {
      visit(scope.children[i]);
    }
  }

  for (let i = 0; i < analysis.moduleScope.children.length; i += 1) {
    visit(analysis.moduleScope.children[i]);
  }
  return best;
}

function getEnclosingContainerName(analysis, scope, line, col) {
  // Check if cursor is on a def header line
  for (let i = 0; i < analysis.defHeaderRegions.length; i += 1) {
    const dr = analysis.defHeaderRegions[i];
    if (line >= dr.startLine && line <= dr.endLine) {
      if (dr.fnNameLine === line && col >= dr.fnNameCol && col < dr.fnNameCol + dr.fnName.length) {
        return dr.ownerClass ? dr.ownerClass.name : null;
      }
      return dr.fnName;
    }
  }
  // Check if cursor is on a class header line
  for (let i = 0; i < analysis.classHeaderRegions.length; i += 1) {
    const cr = analysis.classHeaderRegions[i];
    if (line >= cr.startLine && line <= cr.endLine) {
      const parentScope = cr.scope;
      return parentScope && (parentScope.kind === "class" || parentScope.kind === "function")
        ? parentScope.name
        : null;
    }
  }

  let cur = scope;
  while (cur) {
    if (cur.kind === "function" || cur.kind === "class") {
      return cur.name;
    }
    cur = cur.parent;
  }
  return null;
}

function resolveScopeForCursor(analysis, line, col) {
  const rawScope = findScopeAtPosition(analysis, line, col);
  // Check if cursor sits on a `def` header line
  for (let i = 0; i < analysis.defHeaderRegions.length; i += 1) {
    const dr = analysis.defHeaderRegions[i];
    if (line >= dr.startLine && line <= dr.endLine) {
      // On the function name itself -> resolve in headerScope (which holds the function binding)
      if (dr.fnNameLine === line && col >= dr.fnNameCol && col < dr.fnNameCol + dr.fnName.length) {
        return { lookupScope: dr.headerScope, isDefParamName: false, defRegion: dr };
      }
      // On a parameter name -> resolve inside fnScope
      for (let pi = 0; pi < dr.paramRanges.length; pi += 1) {
        const pr = dr.paramRanges[pi];
        if (line === pr.startLine && col >= pr.startCol && col <= pr.endCol) {
          return { lookupScope: dr.fnScope, isDefParamName: true, defRegion: dr };
        }
      }
      // Type annotations / default values on def header -> evaluate in headerScope (enclosing class/fn/module)
      // unless inside a lambda/comprehension nested within default arg
      if (rawScope.kind === "lambda" || rawScope.kind === "comprehension") {
        return { lookupScope: rawScope, isDefParamName: false, defRegion: dr };
      }
      return { lookupScope: dr.headerScope, isDefParamName: false, defRegion: dr };
    }
  }
  return { lookupScope: rawScope, isDefParamName: false, defRegion: null };
}

function detectPyTypeContext(analysis, context) {
  if (context.isAnnotation) return false;
  if (context.isImportLine) return false;
  const lineIdx = context.line - 1;
  const maskedLine = analysis.maskedLines[lineIdx] || "";
  const col0 = Math.max(0, context.col - 1);
  // Find start of qualifier chain on this line
  let s0 = col0;
  while (s0 > 0 && (isPyIdentPart(maskedLine[s0 - 1]) || maskedLine[s0 - 1] === "." || maskedLine[s0 - 1] === " ")) {
    if (maskedLine[s0 - 1] === " ") {
      let j = s0 - 1;
      while (j >= 0 && maskedLine[j] === " ") j -= 1;
      if (j >= 0 && maskedLine[j] === ".") { s0 = j; continue; }
      break;
    }
    s0 -= 1;
  }
  const left = maskedLine.slice(0, s0).trimEnd();
  if (left.endsWith("->") || left.endsWith("|")) return true;
  // Base class list `class Child(Base):`
  for (let i = 0; i < analysis.classHeaderRegions.length; i += 1) {
    const cr = analysis.classHeaderRegions[i];
    if (context.line >= cr.startLine && context.line <= cr.endLine) {
      if (context.line !== cr.classRecord.line || context.col > cr.classRecord.column + cr.classRecord.name.length) {
        return true;
      }
    }
  }
  // Inside def header parameter annotation or return annotation
  for (let i = 0; i < analysis.defHeaderRegions.length; i += 1) {
    const dr = analysis.defHeaderRegions[i];
    if (context.line >= dr.startLine && context.line <= dr.endLine) {
      if (left.endsWith(":") || left.endsWith("->") || left.endsWith("[") || left.endsWith(",") || left.endsWith("|")) {
        // Distinguish `: Type` from `dict` or default value after `=`
        if (!left.endsWith("=") && context.col > dr.fnNameCol + dr.fnName.length) {
          return true;
        }
      }
    }
  }
  // Normal `isTypeContext` from extractNavContext (except `def` / `as` on import)
  if (context.isTypeContext) {
    if (left.endsWith("def") || left.endsWith("async def") || left.endsWith("as")) return false;
    return true;
  }
  return false;
}

function makeImportHint({
  typeName = null,
  memberName = null,
  importedName = null,
  specifier = null,
  relativeLevel = 0,
  qualifiedName = null,
  isTypeContext = false,
  isAnnotation = false,
  arity = null,
  fallbackLine = null,
  fallbackColumn = null,
}) {
  return {
    typeName,
    memberName,
    importedName,
    specifier,
    relativeLevel,
    qualifiedName,
    isTypeContext: Boolean(isTypeContext),
    isAnnotation: Boolean(isAnnotation),
    arity: Number.isFinite(arity) ? arity : null,
    fallbackLine: fallbackLine != null ? fallbackLine : null,
    fallbackColumn: fallbackColumn != null ? fallbackColumn : null,
  };
}

function resolveImportCursor(analysis, line, col, context) {
  for (let i = 0; i < analysis.importRegions.length; i += 1) {
    const reg = analysis.importRegions[i];
    if (line < reg.startLine || line > reg.endLine) continue;

    // Find char offset in reg.buf corresponding to (line, col)
    const starts = reg.buf.lineStarts;
    let seg = null;
    if (starts.length === 1) {
      if (starts[0].line === line) seg = starts[0];
    } else {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const sl = starts[mid].line;
        if (sl === line) {
          seg = starts[mid];
          break;
        }
        if (sl < line) lo = mid + 1;
        else hi = mid - 1;
      }
    }
    if (!seg) continue;
    const offset = seg.offset + (col - 1);

    if (reg.kind === "from") {
      if (reg.moduleStartOff >= 0 && offset >= reg.moduleStartOff && offset <= reg.moduleEndOff) {
        return makeImportHint({
          importedName: null,
          specifier: reg.moduleSpec,
          relativeLevel: reg.relativeLevel,
          qualifiedName: reg.moduleSpec,
          isTypeContext: false,
          isAnnotation: false,
          arity: null,
          fallbackLine: line,
          fallbackColumn: col,
        });
      }
      for (let j = 0; j < reg.items.length; j += 1) {
        const it = reg.items[j];
        if (offset >= it.startOff && offset <= it.endOff) {
          return makeImportHint({
            importedName: it.record.importedName,
            specifier: it.record.moduleSpec,
            relativeLevel: it.record.relativeLevel,
            qualifiedName: it.record.importedName
              ? `${it.record.moduleSpec}.${it.record.importedName}`
              : it.record.moduleSpec,
            isTypeContext: false,
            isAnnotation: false,
            arity: null,
            fallbackLine: it.record.line,
            fallbackColumn: it.record.column,
          });
        }
      }
      // Fallback if cursor is on `from` line symbol
      if (context.symbol) {
        const match = reg.items.find(
          (it) => it.record.localName === context.symbol || it.record.importedName === context.symbol
        );
        if (match) {
          return makeImportHint({
            importedName: match.record.importedName,
            specifier: match.record.moduleSpec,
            relativeLevel: match.record.relativeLevel,
            qualifiedName: `${match.record.moduleSpec}.${match.record.importedName}`,
            isTypeContext: false,
            isAnnotation: false,
            arity: null,
            fallbackLine: match.record.line,
            fallbackColumn: match.record.column,
          });
        }
      }
    }

    if (reg.kind === "import") {
      for (let j = 0; j < reg.moduleItems.length; j += 1) {
        const mi = reg.moduleItems[j];
        const inMod = mi.startOff >= 0 && offset >= mi.startOff && offset <= mi.endOff;
        const inAlias = mi.aliasSpan && offset >= mi.aliasSpan.startOff && offset <= mi.aliasSpan.endOff;
        if (inMod || inAlias) {
          return makeImportHint({
            importedName: null,
            specifier: mi.record.moduleSpec,
            relativeLevel: 0,
            qualifiedName: mi.record.moduleSpec,
            isTypeContext: false,
            isAnnotation: false,
            arity: null,
            fallbackLine: mi.record.line,
            fallbackColumn: mi.record.column,
          });
        }
      }
    }
  }
  return null;
}

/**
 * Inspect text immediately left of `chainStart` for `super().` / `Class().` / `fn().` patterns.
 */
function detectPrecedingCallReceiver(maskedLines, line1Based, col1Based) {
  const lineIdx = line1Based - 1;
  const line = maskedLines[lineIdx] || "";
  let p = Math.max(0, col1Based - 2);
  while (p >= 0 && line[p] === " ") p -= 1;
  if (p < 0 || line[p] !== ".") return null;
  p -= 1;

  // Walk backwards across whitespace/newlines to find `)`
  let curLine = lineIdx;
  let curCol = p;
  while (curLine >= 0) {
    const l = maskedLines[curLine] || "";
    while (curCol >= 0 && l[curCol] === " ") curCol -= 1;
    if (curCol >= 0) break;
    curLine -= 1;
    curCol = curLine >= 0 ? (maskedLines[curLine] || "").length - 1 : -1;
  }
  if (curLine < 0 || maskedLines[curLine][curCol] !== ")") return null;

  // Match backwards to opening `(`
  let depth = 1;
  curCol -= 1;
  while (curLine >= 0 && depth > 0) {
    const l = maskedLines[curLine] || "";
    while (curCol >= 0 && depth > 0) {
      const ch = l[curCol];
      if (ch === ")") depth += 1;
      else if (ch === "(") depth -= 1;
      if (depth === 0) break;
      curCol -= 1;
    }
    if (depth === 0) break;
    curLine -= 1;
    curCol = curLine >= 0 ? (maskedLines[curLine] || "").length - 1 : -1;
  }
  if (depth !== 0 || curLine < 0) return null;

  // Read identifier chain immediately before `(`
  const openLine = maskedLines[curLine] || "";
  let end = curCol - 1;
  while (end >= 0 && openLine[end] === " ") end -= 1;
  if (end < 0 || !isPyIdentPart(openLine[end])) return null;

  const chain = [];
  while (end >= 0) {
    let start = end;
    while (start > 0 && isPyIdentPart(openLine[start - 1])) start -= 1;
    if (!isPyIdentStart(openLine[start])) break;
    chain.unshift(openLine.slice(start, end + 1));
    let dotPos = start - 1;
    while (dotPos >= 0 && openLine[dotPos] === " ") dotPos -= 1;
    if (dotPos >= 0 && openLine[dotPos] === ".") {
      dotPos -= 1;
      while (dotPos >= 0 && openLine[dotPos] === " ") dotPos -= 1;
      if (dotPos >= 0 && isPyIdentPart(openLine[dotPos])) {
        end = dotPos;
        continue;
      }
    }
    break;
  }

  return chain.length > 0 ? chain : null;
}

function findChainStartCol1Based(maskedLine, col1Based, qualifierChain, memberIndex) {
  let col0 = Math.max(0, Math.min(maskedLine.length - 1, col1Based - 1));
  while (col0 > 0 && isPyIdentPart(maskedLine[col0 - 1])) col0 -= 1;
  let stepsLeft = memberIndex;
  let p = col0;
  while (stepsLeft > 0 && p > 0) {
    p -= 1;
    while (p >= 0 && maskedLine[p] === " ") p -= 1;
    if (p >= 0 && maskedLine[p] === ".") p -= 1;
    while (p >= 0 && maskedLine[p] === " ") p -= 1;
    while (p > 0 && isPyIdentPart(maskedLine[p - 1])) p -= 1;
    stepsLeft -= 1;
  }
  return p + 1;
}

function buildCandidateFromBinding(binding, filePath, score = 80, exactScope = true) {
  return normalizeNavCandidate({
    filePath,
    line: binding.line,
    column: binding.column,
    name: binding.name,
    kind: binding.kind || "variable",
    containerName: binding.containerName || "",
    signature: binding.signature || "",
    isAbstract: Boolean(binding.isOverload || binding.classRecord?.isAbstract),
    isDefault: false,
    arity: Number.isFinite(binding.arity) ? binding.arity : null,
    lang: "python",
    exactScope,
    score,
  });
}

function findMemberOnClass(classRecord, memberName, analysis, visited = new Set()) {
  if (!classRecord || visited.has(classRecord.name)) return null;
  visited.add(classRecord.name);

  if (memberName === "__init__") {
    if (classRecord.constructors.length > 0) {
      const c = classRecord.constructors[0];
      return {
        kind: "constructor",
        node: { ...c, name: "__init__" },
        ownerClass: classRecord,
        isInherited: visited.size > 1,
      };
    }
  }

  for (let i = 0; i < classRecord.methods.length; i += 1) {
    if (classRecord.methods[i].name === memberName) {
      return {
        kind: classRecord.methods[i].kind,
        node: classRecord.methods[i],
        ownerClass: classRecord,
        isInherited: visited.size > 1,
      };
    }
  }

  for (let i = 0; i < classRecord.fields.length; i += 1) {
    if (classRecord.fields[i].name === memberName) {
      return {
        kind: "field",
        node: classRecord.fields[i],
        ownerClass: classRecord,
        isInherited: visited.size > 1,
      };
    }
  }

  // Search base classes
  for (let bi = 0; bi < classRecord.extends.length; bi += 1) {
    const baseName = classRecord.extends[bi];
    const localBase = analysis.classMap.get(baseName);
    if (localBase) {
      const hit = findMemberOnClass(localBase, memberName, analysis, visited);
      if (hit) return hit;
    } else {
      return { kind: "external_base", baseName, ownerClass: classRecord };
    }
  }

  return null;
}

function resolveBaseClassImport(baseName, scope, analysis) {
  const rootName = baseName.split(".")[0];
  const found = lookupInScopeChain(scope, rootName, true);
  if (found?.binding?.kind === "import") {
    return found.binding.importRecord;
  }
  const modAlias = scope.moduleAliases.get(baseName) || analysis.moduleScope.moduleAliases.get(baseName);
  if (modAlias) return modAlias;
  return null;
}

function buildImportHintForTypeMember({
  typeName,
  memberName,
  scope,
  analysis,
  isTypeContext,
  isAnnotation,
  arity,
  fallbackLine,
  fallbackColumn,
}) {
  if (!typeName) return null;
  const parts = typeName.split(".");
  const rootIdent = parts[0];
  if (PY_BUILTIN_NAMES.has(rootIdent) && !lookupInScopeChain(scope, rootIdent, true)) {
    return null;
  }

  const foundRoot = lookupInScopeChain(scope, rootIdent, true);
  if (foundRoot?.binding?.kind === "import") {
    const imp = foundRoot.binding.importRecord;
    const cleanType = parts.length > 1
      ? `${imp.importedName || imp.localName}.${parts.slice(1).join(".")}`
      : (imp.importedName || imp.localName);
    return makeImportHint({
      typeName: cleanType,
      memberName,
      importedName: imp.importedName || imp.localName,
      specifier: imp.moduleSpec,
      relativeLevel: imp.relativeLevel,
      qualifiedName: memberName ? `${cleanType}.${memberName}` : cleanType,
      isTypeContext,
      isAnnotation,
      arity,
      fallbackLine: imp.line,
      fallbackColumn: imp.column,
    });
  }

  // Check dotted module import like `models.User`
  if (parts.length >= 2) {
    const modPrefix = parts.slice(0, parts.length - 1).join(".");
    const modImp = scope.moduleAliases.get(modPrefix) || analysis.moduleScope.moduleAliases.get(modPrefix);
    if (modImp) {
      const clsName = parts[parts.length - 1];
      return makeImportHint({
        typeName: clsName,
        memberName,
        importedName: clsName,
        specifier: modImp.moduleSpec,
        relativeLevel: modImp.relativeLevel,
        qualifiedName: memberName ? `${clsName}.${memberName}` : clsName,
        isTypeContext,
        isAnnotation,
        arity,
        fallbackLine: modImp.line,
        fallbackColumn: modImp.column,
      });
    }
  }

  // Type name is not locally defined and not a builtin (e.g. `svc: OrderService` without import)
  return makeImportHint({
    typeName,
    memberName,
    importedName: null,
    specifier: null,
    relativeLevel: 0,
    qualifiedName: memberName ? `${typeName}.${memberName}` : typeName,
    isTypeContext,
    isAnnotation,
    arity,
    fallbackLine,
    fallbackColumn,
  });
}

function getTypesFromBinding(binding) {
  if (!binding) return [];
  const raw = binding.declaredType || binding.initializerType || "";
  if (!raw) return [];
  return extractPrimaryTypeNames(raw);
}

function getTypesFromMemberNode(hit) {
  if (!hit || !hit.node) return [];
  if (hit.kind === "field") {
    return extractPrimaryTypeNames(hit.node.typeName || hit.node.initializerType || "");
  }
  if (hit.node.returnType) {
    return extractPrimaryTypeNames(hit.node.returnType);
  }
  return [];
}

function findDottedModulePrefix(chain, maxLen, scope, analysis) {
  // Try longest prefix in `chain[0..maxLen]` that matches an `import a.b` statement
  for (let len = Math.min(chain.length, maxLen); len >= 1; len -= 1) {
    const prefix = chain.slice(0, len).join(".");
    const rec = scope.moduleAliases.get(prefix) || analysis.moduleScope.moduleAliases.get(prefix);
    if (rec) return { length: len, record: rec };
  }
  return null;
}

/**
 * Resolve navigation target at cursor context or `{ line, col }` within Python file.
 */
export function resolveInFile(sourceText, contextOrPos, filePath = "") {
  const empty = {
    resolved: [],
    importHint: null,
    memberTypeHints: [],
    enclosingContainer: null,
  };
  const text = typeof sourceText === "string" ? sourceText : "";
  if (!isNavSourceWithinLimits(text)) return empty;

  let context = contextOrPos;
  if (!context || typeof context !== "object" || !context.symbol) {
    const pos = contextOrPos && typeof contextOrPos === "object" ? contextOrPos : {};
    const col = pos.col ?? pos.column;
    context = extractNavContext(text, pos.line, col, filePath || DEFAULT_ANALYZE_FALLBACK);
  }
  if (!context || !context.symbol) return empty;

  const analysis = analyzePythonSource(text, filePath || "", {
    lines: context.lines,
    maskedLines: context.maskedLines,
  });
  const effectivePath = filePath || "";
  const { lookupScope } = resolveScopeForCursor(analysis, context.line, context.col);
  const enclosingContainer = getEnclosingContainerName(analysis, lookupScope, context.line, context.col);
  const isPyTypeCtx = detectPyTypeContext(analysis, context);
  const isAnn = Boolean(context.isAnnotation);

  // 1. Check if cursor is on an import statement (single-line or multi-line)
  const importLineHint = resolveImportCursor(analysis, context.line, context.col, context);
  if (importLineHint) {
    return {
      resolved: [],
      importHint: importLineHint,
      memberTypeHints: [],
      enclosingContainer,
    };
  }

  const chain = Array.isArray(context.qualifierChain) && context.qualifierChain.length > 0
    ? context.qualifierChain
    : [context.symbol];
  const memberIdx = Number.isInteger(context.memberIndex) && context.memberIndex >= 0
    ? Math.min(context.memberIndex, chain.length - 1)
    : 0;
  const targetSym = chain[memberIdx];

  const candidates = [];
  const memberTypeHints = [];
  const hintSeen = new Set();
  function addTypeHint(t) {
    if (t && !hintSeen.has(t)) {
      hintSeen.add(t);
      memberTypeHints.push(t);
    }
  }

  // 2. Check for preceding call receiver like `super().method()` or `UserService().save()`
  const maskedLine = analysis.maskedLines[context.line - 1] || "";
  const chainStartCol = findChainStartCol1Based(maskedLine, context.col, chain, memberIdx);
  const precedingCall = detectPrecedingCallReceiver(analysis.maskedLines, context.line, chainStartCol);

  if (precedingCall) {
    let receiverTypes = [];
    if (precedingCall.length === 1 && precedingCall[0] === "super") {
      const cls = lookupScope.enclosingClass;
      if (cls) {
        receiverTypes = cls.extends.slice();
      }
    } else if (precedingCall.length === 1) {
      const callee = precedingCall[0];
      const foundCallee = lookupInScopeChain(lookupScope, callee, true, context.line, context.col);
      if (foundCallee?.binding?.kind === "class") {
        receiverTypes = [callee];
      } else if (foundCallee?.binding?.kind === "function" && foundCallee.binding.returnType) {
        receiverTypes = extractPrimaryTypeNames(foundCallee.binding.returnType);
      } else if (foundCallee?.binding?.kind === "import") {
        receiverTypes = [callee];
      }
    } else if (precedingCall[0] === "self" && lookupScope.enclosingClass) {
      let curCls = lookupScope.enclosingClass;
      for (let i = 1; i < precedingCall.length && curCls; i += 1) {
        const hit = findMemberOnClass(curCls, precedingCall[i], analysis);
        if (!hit || hit.kind === "external_base") {
          curCls = null;
          break;
        }
        const nextTypes = getTypesFromMemberNode(hit);
        if (i === precedingCall.length - 1) {
          receiverTypes = nextTypes;
        } else {
          curCls = nextTypes.length > 0 ? analysis.classMap.get(nextTypes[0]) || null : null;
        }
      }
    }

    for (let i = 0; i < receiverTypes.length; i += 1) addTypeHint(receiverTypes[i]);

    // Walk remaining chain from 0..memberIdx starting at receiverTypes
    return resolveFromTypeList({
      receiverTypes,
      chain,
      startStep: 0,
      targetStep: memberIdx,
      fallbackLine: lookupScope.enclosingClass?.line || context.line,
      fallbackColumn: lookupScope.enclosingClass?.column || context.col,
      lookupScope,
      analysis,
      effectivePath,
      context,
      isPyTypeCtx,
      isAnn,
      memberTypeHints,
      enclosingContainer,
    });
  }

  // 3. Check dotted module import prefixes (e.g. `import pkg.mod` -> `pkg.mod.func()`)
  const modPrefix = findDottedModulePrefix(chain, chain.length, lookupScope, analysis);
  if (modPrefix && modPrefix.record.isModuleImport) {
    const rec = modPrefix.record;
    if (memberIdx < modPrefix.length) {
      return {
        resolved: [],
        importHint: makeImportHint({
          importedName: null,
          specifier: rec.moduleSpec,
          relativeLevel: rec.relativeLevel,
          qualifiedName: rec.moduleSpec,
          isTypeContext: isPyTypeCtx,
          isAnnotation: isAnn,
          arity: null,
          fallbackLine: rec.line,
          fallbackColumn: rec.column,
        }),
        memberTypeHints,
        enclosingContainer,
      };
    }
    if (memberIdx === modPrefix.length) {
      return {
        resolved: [],
        importHint: makeImportHint({
          typeName: null,
          memberName: targetSym,
          importedName: targetSym,
          specifier: rec.moduleSpec,
          relativeLevel: rec.relativeLevel,
          qualifiedName: `${rec.moduleSpec}.${targetSym}`,
          isTypeContext: isPyTypeCtx,
          isAnnotation: isAnn,
          arity: context.arity,
          fallbackLine: rec.line,
          fallbackColumn: rec.column,
        }),
        memberTypeHints,
        enclosingContainer,
      };
    }
    // Deeper chain like `pkg.mod.UserService.create`
    const clsName = chain[modPrefix.length];
    addTypeHint(clsName);
    return {
      resolved: [],
      importHint: makeImportHint({
        typeName: clsName,
        memberName: chain.slice(modPrefix.length + 1, memberIdx + 1).join("."),
        importedName: clsName,
        specifier: rec.moduleSpec,
        relativeLevel: rec.relativeLevel,
        qualifiedName: `${clsName}.${chain.slice(modPrefix.length + 1, memberIdx + 1).join(".")}`,
        isTypeContext: isPyTypeCtx,
        isAnnotation: isAnn,
        arity: context.arity,
        fallbackLine: rec.line,
        fallbackColumn: rec.column,
      }),
      memberTypeHints,
      enclosingContainer,
    };
  }

  // 4. Special keywords `self`, `cls`, `super`
  const headSym = chain[0];
  if ((headSym === "self" || headSym === "cls") && lookupScope.enclosingClass) {
    const cls = lookupScope.enclosingClass;
    addTypeHint(cls.name);
    if (memberIdx === 0) {
      candidates.push(normalizeNavCandidate({
        filePath: effectivePath,
        line: cls.line,
        column: cls.column,
        name: cls.name,
        kind: "class",
        signature: cls.signature,
        isAbstract: cls.isAbstract,
        lang: "python",
        exactScope: true,
        score: 95,
      }));
      return {
        resolved: rankNavCandidates(candidates, context),
        importHint: null,
        memberTypeHints,
        enclosingContainer,
      };
    }
    return resolveFromTypeList({
      receiverTypes: [cls.name],
      chain,
      startStep: 1,
      targetStep: memberIdx,
      fallbackLine: cls.line,
      fallbackColumn: cls.column,
      lookupScope,
      analysis,
      effectivePath,
      context,
      isPyTypeCtx,
      isAnn,
      memberTypeHints,
      enclosingContainer,
    });
  }

  if (headSym === "super" && memberIdx === 0 && lookupScope.enclosingClass) {
    const cls = lookupScope.enclosingClass;
    for (let bi = 0; bi < cls.extends.length; bi += 1) {
      const baseName = cls.extends[bi];
      addTypeHint(baseName);
      const localBase = analysis.classMap.get(baseName);
      if (localBase) {
        candidates.push(normalizeNavCandidate({
          filePath: effectivePath,
          line: localBase.line,
          column: localBase.column,
          name: localBase.name,
          kind: "class",
          signature: localBase.signature,
          isAbstract: localBase.isAbstract,
          lang: "python",
          exactScope: true,
          score: 90,
        }));
      } else {
        const imp = resolveBaseClassImport(baseName, lookupScope, analysis);
        if (imp) {
          return {
            resolved: [],
            importHint: makeImportHint({
              typeName: baseName,
              memberName: null,
              importedName: imp.importedName || imp.localName,
              specifier: imp.moduleSpec,
              relativeLevel: imp.relativeLevel,
              qualifiedName: baseName,
              isTypeContext: true,
              isAnnotation: false,
              arity: null,
              fallbackLine: imp.line,
              fallbackColumn: imp.column,
            }),
            memberTypeHints,
            enclosingContainer,
          };
        }
      }
    }
    if (candidates.length > 0) {
      return {
        resolved: rankNavCandidates(candidates, context),
        importHint: null,
        memberTypeHints,
        enclosingContainer,
      };
    }
  }

  // 5. General LEGB lookup for `chain[0]`
  const foundHead = lookupInScopeChain(lookupScope, headSym, true, context.line, context.col);
  if (!foundHead) {
    return {
      resolved: [],
      importHint: null,
      memberTypeHints,
      enclosingContainer,
    };
  }

  const headBinding = foundHead.binding;

  // 5a. Head is an imported symbol
  if (headBinding.kind === "import") {
    const imp = headBinding.importRecord;
    if (memberIdx === 0) {
      return {
        resolved: [],
        importHint: makeImportHint({
          typeName: null,
          memberName: null,
          importedName: imp.importedName,
          specifier: imp.moduleSpec,
          relativeLevel: imp.relativeLevel,
          qualifiedName: imp.importedName ? `${imp.moduleSpec}.${imp.importedName}` : imp.moduleSpec,
          isTypeContext: isPyTypeCtx,
          isAnnotation: isAnn,
          arity: context.isCall ? context.arity : null,
          fallbackLine: imp.line,
          fallbackColumn: imp.column,
        }),
        memberTypeHints,
        enclosingContainer,
      };
    }
    const baseName = imp.importedName || imp.localName;
    addTypeHint(baseName);
    const memberPath = chain.slice(1, memberIdx + 1).join(".");
    return {
      resolved: [],
      importHint: makeImportHint({
        typeName: baseName,
        memberName: memberPath,
        importedName: imp.importedName || imp.localName,
        specifier: imp.moduleSpec,
        relativeLevel: imp.relativeLevel,
        qualifiedName: `${baseName}.${memberPath}`,
        isTypeContext: isPyTypeCtx,
        isAnnotation: isAnn,
        arity: context.arity,
        fallbackLine: imp.line,
        fallbackColumn: imp.column,
      }),
      memberTypeHints,
      enclosingContainer,
    };
  }

  // 5b. Clicking the head symbol itself (`memberIdx === 0`)
  if (memberIdx === 0) {
    // If calling a local class constructor (`User("Alice")`), jump to `__init__` if present
    if (headBinding.kind === "class" && headBinding.classRecord &&
        context.isCall && !isPyTypeCtx && !isAnn) {
      const cls = headBinding.classRecord;
      if (cls.constructors.length > 0) {
        const ctor = cls.constructors[0];
        candidates.push(normalizeNavCandidate({
          filePath: effectivePath,
          line: ctor.line,
          column: ctor.column,
          name: "__init__",
          kind: "constructor",
          containerName: cls.name,
          signature: ctor.signature,
          isAbstract: false,
          arity: ctor.arity,
          lang: "python",
          exactScope: foundHead.isExactScope,
          score: 100,
        }));
        return {
          resolved: rankNavCandidates(candidates, context),
          importHint: null,
          memberTypeHints,
          enclosingContainer,
        };
      }
    }

    // Include overloaded/concrete sibling candidates if function in same scope
    const sameScopeList = foundHead.scope.bindings.get(headSym) || [headBinding];
    if (headBinding.kind === "function" && sameScopeList.length > 1) {
      for (let i = 0; i < sameScopeList.length; i += 1) {
        if (sameScopeList[i].kind === "function") {
          candidates.push(buildCandidateFromBinding(sameScopeList[i], effectivePath, 90, foundHead.isExactScope));
        }
      }
    } else {
      candidates.push(buildCandidateFromBinding(headBinding, effectivePath, 95, foundHead.isExactScope));
    }

    return {
      resolved: rankNavCandidates(candidates, context),
      importHint: null,
      memberTypeHints,
      enclosingContainer,
    };
  }

  // 5c. Member access (`memberIdx >= 1`) on local class or typed variable/parameter
  let receiverTypes = [];
  if (headBinding.kind === "class" && headBinding.classRecord) {
    receiverTypes = [headBinding.classRecord.name];
  } else {
    receiverTypes = getTypesFromBinding(headBinding);
  }
  for (let i = 0; i < receiverTypes.length; i += 1) addTypeHint(receiverTypes[i]);

  return resolveFromTypeList({
    receiverTypes,
    chain,
    startStep: 1,
    targetStep: memberIdx,
    fallbackLine: headBinding.line,
    fallbackColumn: headBinding.column,
    lookupScope,
    analysis,
    effectivePath,
    context,
    isPyTypeCtx,
    isAnn,
    memberTypeHints,
    enclosingContainer,
  });
}

function resolveFromTypeList({
  receiverTypes,
  chain,
  startStep,
  targetStep,
  fallbackLine,
  fallbackColumn,
  lookupScope,
  analysis,
  effectivePath,
  context,
  isPyTypeCtx,
  isAnn,
  memberTypeHints,
  enclosingContainer,
}) {
  if (receiverTypes.length === 0) {
    return {
      resolved: [],
      importHint: null,
      memberTypeHints,
      enclosingContainer,
    };
  }

  let currentTypes = receiverTypes;
  const resolvedCands = [];
  let pendingImportHint = null;

  for (let step = startStep; step <= targetStep; step += 1) {
    const memberName = chain[step];
    const isFinalStep = step === targetStep;
    const nextTypes = [];

    for (let ti = 0; ti < currentTypes.length; ti += 1) {
      const tName = currentTypes[ti];
      const localCls = analysis.classMap.get(tName);
      if (localCls) {
        const hit = findMemberOnClass(localCls, memberName, analysis);
        if (hit && hit.kind === "external_base") {
          if (isFinalStep) {
            if (!memberTypeHints.includes(hit.baseName)) memberTypeHints.push(hit.baseName);
            pendingImportHint = buildImportHintForTypeMember({
              typeName: hit.baseName,
              memberName,
              scope: lookupScope,
              analysis,
              isTypeContext: isPyTypeCtx,
              isAnnotation: isAnn,
              arity: context.arity,
              fallbackLine: hit.ownerClass.line,
              fallbackColumn: hit.ownerClass.column,
            });
          }
        } else if (hit) {
          if (isFinalStep) {
            resolvedCands.push(normalizeNavCandidate({
              filePath: effectivePath,
              line: hit.node.line,
              column: hit.node.column,
              name: memberName,
              kind: hit.kind,
              containerName: hit.ownerClass.name,
              signature: hit.node.signature || "",
              isAbstract: Boolean(hit.node.isAbstract),
              isDefault: false,
              arity: Number.isFinite(hit.node.arity) ? hit.node.arity : null,
              lang: "python",
              exactScope: !hit.isInherited,
              score: hit.isInherited ? 85 : 100,
            }));
          } else {
            const memberTypes = getTypesFromMemberNode(hit);
            for (let mti = 0; mti < memberTypes.length; mti += 1) {
              if (!nextTypes.includes(memberTypes[mti])) nextTypes.push(memberTypes[mti]);
            }
          }
        }
      } else {
        // Non-local type (imported or unimported external class)
        if (isFinalStep) {
          const restPath = chain.slice(step, targetStep + 1).join(".");
          pendingImportHint = buildImportHintForTypeMember({
            typeName: tName,
            memberName: restPath,
            scope: lookupScope,
            analysis,
            isTypeContext: isPyTypeCtx,
            isAnnotation: isAnn,
            arity: context.arity,
            fallbackLine,
            fallbackColumn,
          });
        }
        break;
      }
    }

    if (!isFinalStep) {
      if (nextTypes.length === 0) break;
      currentTypes = nextTypes;
      // Update memberTypeHints to reflect the immediate receiver type at the clicked step!
      if (step === targetStep - 1) {
        memberTypeHints.length = 0;
        for (let ni = 0; ni < nextTypes.length; ni += 1) memberTypeHints.push(nextTypes[ni]);
      }
    }
  }

  if (resolvedCands.length > 0) {
    return {
      resolved: rankNavCandidates(resolvedCands, context),
      importHint: null,
      memberTypeHints,
      enclosingContainer,
    };
  }

  return {
    resolved: [],
    importHint: pendingImportHint,
    memberTypeHints,
    enclosingContainer,
  };
}
