// Pure Java code-navigation analyzer: symbol summaries, block/class scopes, overload arity,
// Lombok/Spring heuristics, polymorphism resolution, and import hints (Node + QuickJS safe).
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

const MAX_SIGNATURE_CHARS = 220;

function capSignature(str) {
  const s = String(str || "").trim();
  return s.length > MAX_SIGNATURE_CHARS ? `${s.slice(0, MAX_SIGNATURE_CHARS - 3)}...` : s;
}

const JAVA_MODIFIERS = new Set([
  "public", "protected", "private", "abstract", "static", "final",
  "sealed", "strictfp", "synchronized", "native", "transient", "volatile", "default",
]);

const TYPE_DECL_KEYWORDS = new Set(["class", "interface", "enum", "record"]);

const STATEMENT_KEYWORDS = new Set([
  "return", "throw", "break", "continue", "case", "default", "assert", "yield",
  "package", "import", "if", "else", "for", "while", "do", "switch",
  "try", "catch", "finally", "synchronized", "new", "super", "this",
  "true", "false", "null", "instanceof", "throws", "extends", "implements", "permits",
]);

const JAVA_PRIMITIVE_TYPES = new Set([
  "void", "boolean", "byte", "short", "int", "long", "char", "float", "double", "var",
]);

const JAVA_LANG_TYPES = new Set([
  "String", "Object", "Class", "System", "Math", "StrictMath", "Runtime", "Process",
  "Integer", "Long", "Double", "Float", "Boolean", "Byte", "Short", "Character",
  "Number", "Void", "Enum", "Record", "Thread", "Runnable", "Comparable", "Iterable",
  "CharSequence", "Appendable", "AutoCloseable", "Cloneable", "StringBuilder", "StringBuffer",
  "Throwable", "Exception", "RuntimeException", "Error", "IllegalArgumentException",
  "IllegalStateException", "NullPointerException", "UnsupportedOperationException",
  "IndexOutOfBoundsException", "Override", "Deprecated", "SuppressWarnings",
  "FunctionalInterface", "SafeVarargs",
]);

const GENERIC_ALLOWED_KEYWORDS = new Set(["extends", "super"]);
const TYPE_CLAUSE_STOP_WORDS = new Set(["extends", "implements", "permits"]);

function isUpperStart(name) {
  if (!name) return false;
  const c = name.charCodeAt(0);
  return c >= 65 && c <= 90;
}

function decapitalize(name) {
  if (!name) return "";
  if (name.length > 1 && isUpperStart(name[0]) && isUpperStart(name[1])) {
    return name;
  }
  return name[0].toLowerCase() + name.slice(1);
}

export const BUILDER_TYPE_PREFIX = "__builderOf:";

export function stripGenericSuffix(typeName) {
  return String(typeName || "").replace(/<.*$/, "").trim();
}

export function parseGenericArgsFromTypeStr(typeName) {
  const s = String(typeName || "");
  const lt = s.indexOf("<");
  if (lt < 0) return [];
  const gt = s.lastIndexOf(">");
  if (gt <= lt + 1) return [];
  const inner = s.slice(lt + 1, gt);
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "<" || ch === "(" || ch === "[") depth += 1;
    else if (ch === ">" || ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      const part = inner.slice(start, i).trim();
      if (part) out.push(stripGenericSuffix(part));
      start = i + 1;
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) out.push(stripGenericSuffix(tail));
  return out;
}

const BOXED_TO_PRIMITIVE = {
  Integer: "int",
  Long: "long",
  Boolean: "boolean",
  Double: "double",
  Float: "float",
  Character: "char",
  Byte: "byte",
  Short: "short",
};

const KNOWN_JAVA_SUPERTYPES = {
  ArrayList: ["List", "Collection", "Iterable"],
  LinkedList: ["List", "Deque", "Queue", "Collection", "Iterable"],
  CopyOnWriteArrayList: ["List", "Collection", "Iterable"],
  HashSet: ["Set", "Collection", "Iterable"],
  LinkedHashSet: ["Set", "Collection", "Iterable"],
  TreeSet: ["Set", "Collection", "Iterable"],
  HashMap: ["Map"],
  LinkedHashMap: ["Map"],
  ConcurrentHashMap: ["Map"],
  TreeMap: ["Map"],
  List: ["Collection", "Iterable"],
  Set: ["Collection", "Iterable"],
  Queue: ["Collection", "Iterable"],
  Deque: ["Queue", "Collection", "Iterable"],
  String: ["CharSequence"],
  StringBuilder: ["CharSequence"],
  StringBuffer: ["CharSequence"],
  int: ["Number"],
  long: ["Number"],
  double: ["Number"],
  float: ["Number"],
  short: ["Number"],
  byte: ["Number"],
};

export function normalizeJavaSimpleType(typeName) {
  let clean = stripGenericSuffix(typeName);
  if (!clean) return "";
  const dot = clean.lastIndexOf(".");
  if (dot >= 0 && !clean.endsWith("[]")) clean = clean.slice(dot + 1);
  return BOXED_TO_PRIMITIVE[clean] || clean;
}

function isJavaArgCompatibleWithParam(argType, paramType, unit = null) {
  const a = normalizeJavaSimpleType(argType);
  const p = normalizeJavaSimpleType(paramType);
  if (!a || !p) return null;
  if (a === p) return "exact";
  if (p === "Object") return "object";
  if (a === "int" && (p === "long" || p === "double" || p === "float")) return "widening";
  if (a === "long" && (p === "double" || p === "float")) return "widening";
  if (a === "float" && p === "double") return "widening";
  const knownSupers = KNOWN_JAVA_SUPERTYPES[a];
  if (knownSupers && knownSupers.includes(p)) return "subtype";
  if (unit) {
    const aRec = findTypeByName(unit, a);
    if (aRec && hasJavaSupertypeName(unit, aRec, p)) {
      return "subtype";
    }
  }
  return "mismatch";
}

export function scoreJavaMethodParams(methodParams, hasVarArgs, callArgTypes, unit = null) {
  if (!Array.isArray(callArgTypes) || callArgTypes.length === 0 || !Array.isArray(methodParams)) {
    return 0;
  }
  let delta = 0;
  for (let i = 0; i < callArgTypes.length; i += 1) {
    const argT = callArgTypes[i];
    if (!argT) continue;
    const pRec = i < methodParams.length
      ? methodParams[i]
      : (hasVarArgs && methodParams.length > 0 ? methodParams[methodParams.length - 1] : null);
    if (!pRec) continue;
    const paramT = pRec.baseTypeName || pRec.typeName;
    const rel = isJavaArgCompatibleWithParam(argT, paramT, unit);
    if (rel === "exact") delta += 35;
    else if (rel === "subtype" || rel === "widening") delta += 22;
    else if (rel === "object") delta += 5;
    else if (rel === "mismatch") delta -= 30;
  }
  return delta;
}

export function hasLombokBuilder(typeRec) {
  if (!typeRec) return false;
  const anns = typeRec.annotations || [];
  if (anns.includes("Builder") || anns.includes("SuperBuilder")) return true;
  if ((typeRec.constructors || []).some((c) => (c.annotations || []).includes("Builder"))) return true;
  if ((typeRec.methods || []).some((m) => m.isStatic && (m.annotations || []).includes("Builder"))) return true;
  return false;
}

function advanceExternalContainerType(baseType, genericArgs, stepName) {
  if (!genericArgs || genericArgs.length === 0) return null;
  if (baseType === "Optional") {
    if (stepName === "get" || stepName === "orElse" || stepName === "orElseGet" || stepName === "orElseThrow") {
      return { typeName: genericArgs[0], genericArgs: [] };
    }
    if (stepName === "filter") {
      return { typeName: "Optional", genericArgs };
    }
  }
  if (
    baseType === "List" || baseType === "ArrayList" || baseType === "LinkedList" ||
    baseType === "CopyOnWriteArrayList" || baseType === "Collection"
  ) {
    if (stepName === "get" || stepName === "getFirst" || stepName === "getLast") {
      return { typeName: genericArgs[0], genericArgs: [] };
    }
    if (stepName === "stream" || stepName === "parallelStream") {
      return { typeName: "Stream", genericArgs };
    }
    if (stepName === "iterator") {
      return { typeName: "Iterator", genericArgs };
    }
  }
  if (
    baseType === "Set" || baseType === "HashSet" || baseType === "LinkedHashSet" ||
    baseType === "TreeSet" || baseType === "Iterable" || baseType === "Queue" || baseType === "Deque"
  ) {
    if (stepName === "stream" || stepName === "parallelStream") {
      return { typeName: "Stream", genericArgs };
    }
    if (stepName === "iterator") {
      return { typeName: "Iterator", genericArgs };
    }
  }
  if (baseType === "Stream") {
    if (stepName === "findFirst" || stepName === "findAny") {
      return { typeName: "Optional", genericArgs };
    }
    if (
      stepName === "filter" || stepName === "distinct" || stepName === "sorted" ||
      stepName === "limit" || stepName === "skip" || stepName === "peek"
    ) {
      return { typeName: "Stream", genericArgs };
    }
  }
  if ((baseType === "Iterator" || baseType === "Enumeration") && (stepName === "next" || stepName === "nextElement")) {
    return { typeName: genericArgs[0], genericArgs: [] };
  }
  if (baseType === "Map" || baseType === "HashMap" || baseType === "LinkedHashMap" || baseType === "TreeMap" || baseType === "ConcurrentHashMap") {
    if (stepName === "get" || stepName === "getOrDefault" || stepName === "remove") {
      return { typeName: genericArgs[genericArgs.length - 1], genericArgs: [] };
    }
  }
  if (baseType === "ArgumentCaptor") {
    if (stepName === "getValue") return { typeName: genericArgs[0], genericArgs: [] };
    if (stepName === "getAllValues") return { typeName: "List", genericArgs };
  }
  if ((baseType === "CompletableFuture" || baseType === "Future" || baseType === "CompletionStage") &&
      (stepName === "get" || stepName === "join" || stepName === "getNow")) {
    return { typeName: genericArgs[0], genericArgs: [] };
  }
  if ((baseType === "ResponseEntity" || baseType === "HttpEntity") && stepName === "getBody") {
    return { typeName: genericArgs[0], genericArgs: [] };
  }
  return null;
}

export function advanceJavaContainerOrBuilderType(curType, genericArgs, step, findTypeFn) {
  if (!curType || !step || !step.name) return null;
  if (curType.startsWith(BUILDER_TYPE_PREFIX)) {
    const builtType = curType.slice(BUILDER_TYPE_PREFIX.length);
    if (step.isCall && step.name === "build") {
      return { typeName: builtType, genericArgs: [] };
    }
    if (step.isCall) {
      return { typeName: curType, genericArgs: [] };
    }
    return null;
  }

  const baseType = stripGenericSuffix(curType);
  const effectiveArgs = Array.isArray(genericArgs) && genericArgs.length > 0
    ? genericArgs
    : parseGenericArgsFromTypeStr(curType);

  const tRec = typeof findTypeFn === "function" ? findTypeFn(baseType) : null;
  if (tRec) {
    if (step.isCall) {
      const wantArity = Number.isFinite(step.arity) ? step.arity : null;
      const methods = (tRec.methods || []).filter((m) => m.name === step.name);
      const picked = (wantArity !== null ? methods.find((m) => m.arity === wantArity) : null) || methods[0];
      if (picked && picked.returnType && picked.returnType !== "void") {
        return {
          typeName: picked._returnBaseType || picked.returnBaseType || stripGenericSuffix(picked.returnType),
          genericArgs: picked._returnGenericArgs || picked.returnGenericArgs || parseGenericArgsFromTypeStr(picked.returnType),
        };
      }
      if ((step.name === "builder" || step.name === "toBuilder") && (wantArity === 0 || wantArity === null) && hasLombokBuilder(tRec)) {
        return { typeName: `${BUILDER_TYPE_PREFIX}${tRec.name}`, genericArgs: [] };
      }
      const acc = findLombokOrRecordAccessorFields(tRec, step.name, wantArity);
      if (acc.length > 0) {
        const fld = acc[0];
        return {
          typeName: fld._baseTypeName || fld.baseTypeName || stripGenericSuffix(fld.typeName),
          genericArgs: fld._genericArgs || fld.genericArgs || parseGenericArgsFromTypeStr(fld.typeName),
        };
      }
    } else {
      const fld = (tRec.fields || []).find((f) => f.name === step.name);
      if (fld && fld.typeName) {
        return {
          typeName: fld._baseTypeName || fld.baseTypeName || stripGenericSuffix(fld.typeName),
          genericArgs: fld._genericArgs || fld.genericArgs || parseGenericArgsFromTypeStr(fld.typeName),
        };
      }
    }
    return null;
  }

  if (step.isCall) {
    return advanceExternalContainerType(baseType, effectiveArgs, step.name);
  }
  return null;
}

function countCallArityAt(tokens, match, openIdx) {
  if (openIdx < 0 || tokens[openIdx]?.text !== "(") return null;
  const closeIdx = match[openIdx];
  if (!(closeIdx > openIdx)) return null;
  if (closeIdx === openIdx + 1) return 0;
  let count = 1;
  let depth = 0;
  let k = openIdx + 1;
  while (k < closeIdx) {
    const tx = tokens[k].text;
    if (tx === "(" || tx === "[" || tx === "{") depth += 1;
    else if (tx === ")" || tx === "]" || tx === "}") depth = Math.max(0, depth - 1);
    else if (tx === "<" && depth === 0) {
      const afterGen = trySkipGenerics(tokens, match, k, closeIdx);
      if (afterGen > k) {
        k = afterGen;
        continue;
      }
    } else if (tx === "," && depth === 0) {
      count += 1;
    }
    k += 1;
  }
  return count;
}

function isTokenAtOrBefore(tok, line, col) {
  return tok.line < line || (tok.line === line && tok.col <= col);
}

function isCursorInsideRange(startTok, endTok, line, col) {
  if (!startTok || !endTok) return false;
  if (line < startTok.line || line > endTok.line) return false;
  if (line === startTok.line && col < startTok.col) return false;
  if (line === endTok.line && col > endTok.endCol) return false;
  return true;
}

function matchJavaTwoCharPunct(text, i) {
  const c0 = text[i];
  const c1 = text[i + 1];
  if (c1 === "=") {
    if (c0 === "=") return "==";
    if (c0 === "!") return "!=";
    if (c0 === "+") return "+=";
    if (c0 === "-") return "-=";
    if (c0 === "*") return "*=";
    if (c0 === "/") return "/=";
    return "";
  }
  if (c0 === ":" && c1 === ":") return "::";
  if (c0 === "-" && c1 === ">") return "->";
  if (c0 === "&" && c1 === "&") return "&&";
  if (c0 === "|" && c1 === "|") return "||";
  if (c0 === "+" && c1 === "+") return "++";
  if (c0 === "-" && c1 === "-") return "--";
  return "";
}

/**
 * Single-pass O(n) tokenizer over masked Java lines preserving exact 1-based line/col offsets.
 */
function tokenizeJavaMaskedLines(maskedLines) {
  const tokens = [];
  for (let li = 0; li < maskedLines.length; li += 1) {
    const text = maskedLines[li] || "";
    const len = text.length;
    const lineNum = li + 1;
    let i = 0;

    while (i < len) {
      const ch = text[i];
      if (ch === " " || ch === "\t") {
        i += 1;
        continue;
      }

      if (isNavIdentStart(ch)) {
        let end = i + 1;
        while (end < len && isNavIdentPart(text[end])) end += 1;
        tokens.push({
          kind: "ident",
          text: text.slice(i, end),
          line: lineNum,
          col: i + 1,
          endCol: end + 1,
        });
        i = end;
        continue;
      }

      if (ch >= "0" && ch <= "9") {
        let end = i + 1;
        while (end < len) {
          const cur = text[end];
          if (
            (cur >= "0" && cur <= "9") ||
            (cur >= "a" && cur <= "z") ||
            (cur >= "A" && cur <= "Z") ||
            cur === "_" ||
            (cur === "." && end + 1 < len && text[end + 1] >= "0" && text[end + 1] <= "9")
          ) {
            if ((cur === "e" || cur === "E") && (text[end + 1] === "+" || text[end + 1] === "-")) {
              end += 2;
              continue;
            }
            end += 1;
          } else {
            break;
          }
        }
        tokens.push({
          kind: "number",
          text: text.slice(i, end),
          line: lineNum,
          col: i + 1,
          endCol: end + 1,
        });
        i = end;
        continue;
      }

      // Multi-char punctuators (keep `<` and `>` separate so nested generics `>>` match cleanly)
      if (i + 1 < len) {
        const two = matchJavaTwoCharPunct(text, i);
        if (two) {
          tokens.push({
            kind: "punct",
            text: two,
            line: lineNum,
            col: i + 1,
            endCol: i + 3,
          });
          i += 2;
          continue;
        }
      }

      if (ch === "." && text[i + 1] === "." && text[i + 2] === ".") {
        tokens.push({
          kind: "punct",
          text: "...",
          line: lineNum,
          col: i + 1,
          endCol: i + 4,
        });
        i += 3;
        continue;
      }

      tokens.push({
        kind: "punct",
        text: ch,
        line: lineNum,
        col: i + 1,
        endCol: i + 2,
      });
      i += 1;
    }
  }
  return tokens;
}

function computeBracketMatches(tokens) {
  return computeBracketPairs(tokens, "text");
}

function skipBalanced(tokens, match, idx, limit = tokens.length) {
  if (idx >= limit) return idx;
  const m = match[idx];
  if (m >= 0 && m < limit) return m + 1;
  return idx + 1;
}

/**
 * Attempt to skip balanced `< ... >` generic type arguments/parameters starting at `idx`.
 * When `outArgs` is provided, extracts top-level base type argument names in the same single pass.
 * Returns token index right after `>`, or `-1` if `<` is not a valid generic bracket.
 */
function trySkipGenerics(tokens, match, idx, limit = tokens.length, outArgs = null) {
  if (idx >= limit || tokens[idx].text !== "<") return -1;
  let depth = 0;
  let i = idx;
  const collected = outArgs ? [] : null;
  let expectingFirst = true;

  while (i < limit) {
    const tok = tokens[i];
    const t = tok.text;
    if (t === "<") {
      depth += 1;
      i += 1;
      continue;
    }
    if (t === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) {
        if (collected) {
          for (let k = 0; k < collected.length; k += 1) outArgs.push(collected[k]);
        }
        return i;
      }
      continue;
    }
    if (t === "@" && i + 1 < limit && tokens[i + 1].kind === "ident") {
      i += 2;
      while (i + 1 < limit && tokens[i].text === "." && tokens[i + 1].kind === "ident") i += 2;
      if (i < limit && tokens[i].text === "(") {
        i = skipBalanced(tokens, match, i, limit);
      }
      continue;
    }
    if (tok.kind === "ident") {
      if (STATEMENT_KEYWORDS.has(t) && !GENERIC_ALLOWED_KEYWORDS.has(t)) return -1;
      if (collected && depth === 1 && !GENERIC_ALLOWED_KEYWORDS.has(t) && expectingFirst) {
        let simple = t;
        let j = i + 1;
        while (j + 1 < limit && tokens[j].text === "." && tokens[j + 1].kind === "ident") {
          simple = tokens[j + 1].text;
          j += 2;
        }
        collected.push(simple);
        expectingFirst = false;
        i = j;
        continue;
      }
      i += 1;
      continue;
    }
    if (collected && depth === 1 && t === ",") {
      expectingFirst = true;
      i += 1;
      continue;
    }
    if (t === "." || t === "," || t === "?" || t === "&" || t === "[" || t === "]") {
      i += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

function readQualifiedIdent(tokens, idx, limit = tokens.length) {
  if (idx >= limit || tokens[idx].kind !== "ident") return null;
  const parts = [tokens[idx]];
  let i = idx + 1;
  while (i + 1 < limit && tokens[i].text === "." && tokens[i + 1].kind === "ident") {
    parts.push(tokens[i + 1]);
    i += 2;
  }
  return {
    parts,
    qualifiedName: parts.map((p) => p.text).join("."),
    simpleName: parts[parts.length - 1].text,
    firstTok: parts[0],
    lastTok: parts[parts.length - 1],
    nextIdx: i,
  };
}

/**
 * Read a Java type reference (`com.acme.Map<String, List<Order>>[]`) starting at `idx`.
 */
function readTypeRef(tokens, match, idx, limit = tokens.length) {
  if (idx >= limit) return null;
  let i = idx;
  // Skip leading type-use annotations
  while (i < limit && tokens[i].text === "@") {
    if (i + 1 < limit && tokens[i + 1].text === "interface") return null;
    const q = readQualifiedIdent(tokens, i + 1, limit);
    if (!q) break;
    i = q.nextIdx;
    if (i < limit && tokens[i].text === "(") i = skipBalanced(tokens, match, i, limit);
  }
  if (i >= limit || tokens[i].kind !== "ident") return null;
  if (STATEMENT_KEYWORDS.has(tokens[i].text)) return null;

  const firstTok = tokens[i];
  let simpleName = tokens[i].text;
  const qualParts = [simpleName];
  i += 1;

  while (i < limit && tokens[i].text === ".") {
    let peek = i + 1;
    while (peek < limit && tokens[peek].text === "@") {
      const q = readQualifiedIdent(tokens, peek + 1, limit);
      if (!q) break;
      peek = q.nextIdx;
      if (peek < limit && tokens[peek].text === "(") peek = skipBalanced(tokens, match, peek, limit);
    }
    if (peek >= limit || tokens[peek].kind !== "ident") break;
    simpleName = tokens[peek].text;
    qualParts.push(simpleName);
    i = peek + 1;
  }

  let genericArgs = [];
  if (i < limit && tokens[i].text === "<") {
    const afterGen = trySkipGenerics(tokens, match, i, limit, genericArgs);
    if (afterGen < 0) return null;
    i = afterGen;
  }

  let arrayDims = 0;
  let isVarArgs = false;
  while (i < limit) {
    if (tokens[i].text === "@" && i + 1 < limit) {
      const q = readQualifiedIdent(tokens, i + 1, limit);
      if (!q) break;
      i = q.nextIdx;
      if (i < limit && tokens[i].text === "(") i = skipBalanced(tokens, match, i, limit);
      continue;
    }
    if (tokens[i].text === "[" && i + 1 < limit && tokens[i + 1].text === "]") {
      arrayDims += 1;
      i += 2;
      continue;
    }
    break;
  }
  if (i < limit && tokens[i].text === "...") {
    isVarArgs = true;
    arrayDims += 1;
    i += 1;
  }

  const suffix = arrayDims > 0 ? "[]".repeat(arrayDims) : "";
  return {
    typeName: simpleName + suffix,
    baseTypeName: simpleName,
    qualifiedTypeName: qualParts.join(".") + suffix,
    genericArgs,
    arrayDims,
    isVarArgs,
    firstTok,
    nextIdx: i,
  };
}

function parseAnnotationsAndModifiers(tokens, match, idx, limit = tokens.length) {
  const annotations = [];
  const modifiers = new Set();
  let i = idx;
  let firstTok = null;

  while (i < limit) {
    const tok = tokens[i];
    if (tok.text === "@") {
      if (i + 1 < limit && tokens[i + 1].text === "interface") {
        break;
      }
      if (!firstTok) firstTok = tok;
      const q = readQualifiedIdent(tokens, i + 1, limit);
      if (!q) {
        i += 1;
        continue;
      }
      annotations.push({
        name: q.simpleName,
        qualifiedName: q.qualifiedName,
        line: q.lastTok.line,
        col: q.lastTok.col,
      });
      i = q.nextIdx;
      if (i < limit && tokens[i].text === "(") {
        i = skipBalanced(tokens, match, i, limit);
      }
      continue;
    }

    if (tok.kind === "ident" && JAVA_MODIFIERS.has(tok.text)) {
      if (!firstTok) firstTok = tok;
      modifiers.add(tok.text);
      i += 1;
      continue;
    }

    if (
      tok.kind === "ident" &&
      tok.text === "non" &&
      i + 2 < limit &&
      tokens[i + 1].text === "-" &&
      tokens[i + 2].text === "sealed"
    ) {
      if (!firstTok) firstTok = tok;
      modifiers.add("non-sealed");
      i += 3;
      continue;
    }

    break;
  }

  return {
    annotations,
    modifiers,
    firstTok: firstTok || (i < limit ? tokens[i] : null),
    nextIdx: i,
  };
}

function parseParamList(tokens, match, openParenIdx, limit = tokens.length) {
  if (openParenIdx >= limit || tokens[openParenIdx].text !== "(") {
    return { params: [], nextIdx: openParenIdx };
  }
  const closeIdx = match[openParenIdx];
  const end = closeIdx >= 0 && closeIdx < limit ? closeIdx : limit;
  const params = [];
  let i = openParenIdx + 1;

  while (i < end) {
    const { annotations, nextIdx } = parseAnnotationsAndModifiers(tokens, match, i, end);
    i = nextIdx;
    if (i >= end) break;
    if (tokens[i].text === ",") {
      i += 1;
      continue;
    }

    const typeRef = readTypeRef(tokens, match, i, end);
    if (!typeRef) {
      while (i < end && tokens[i].text !== ",") i += 1;
      if (i < end && tokens[i].text === ",") i += 1;
      continue;
    }
    i = typeRef.nextIdx;

    if (i >= end || tokens[i].kind !== "ident") {
      while (i < end && tokens[i].text !== ",") i += 1;
      if (i < end && tokens[i].text === ",") i += 1;
      continue;
    }

    const nameTok = tokens[i];
    i += 1;

    let extraDims = 0;
    while (i + 1 < end && tokens[i].text === "[" && tokens[i + 1].text === "]") {
      extraDims += 1;
      i += 2;
    }

    const typeName = extraDims > 0 ? typeRef.typeName + "[]".repeat(extraDims) : typeRef.typeName;
    params.push({
      name: nameTok.text,
      typeName,
      baseTypeName: typeRef.baseTypeName,
      genericArgs: typeRef.genericArgs,
      annotations: annotations.map((a) => a.name),
      isVarArgs: typeRef.isVarArgs,
      line: nameTok.line,
      column: nameTok.col,
    });

    while (i < end && tokens[i].text !== ",") i += 1;
    if (i < end && tokens[i].text === ",") i += 1;
  }

  return {
    params,
    nextIdx: closeIdx >= 0 ? closeIdx + 1 : end,
  };
}

function formatParamsSignature(params) {
  if (!params || params.length === 0) return "";
  let out = "";
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i];
    if (i > 0) out += ", ";
    out += `${p.typeName}${p.isVarArgs && !p.typeName.endsWith("[]") ? "..." : ""} ${p.name}`;
    if (out.length >= MAX_SIGNATURE_CHARS) {
      return `${out.slice(0, MAX_SIGNATURE_CHARS - 3)}...`;
    }
  }
  return out;
}

/**
 * Infer a Java type name from an initializer token slice (falling back to raw lines for string/char literals).
 */
function inferInitializerType(tokens, match, initStart, initEnd, rawLines, eqTok) {
  if (initStart >= initEnd) {
    // Blanked string/text block/char literal? Inspect raw line right after `=`
    if (eqTok && rawLines) {
      for (let li = eqTok.line - 1; li < Math.min(rawLines.length, eqTok.line + 1); li += 1) {
        const line = rawLines[li] || "";
        const startC = li === eqTok.line - 1 ? eqTok.endCol - 1 : 0;
        for (let c = startC; c < line.length; c += 1) {
          const ch = line[c];
          if (ch === " " || ch === "\t") continue;
          if (ch === '"') return { typeName: "String", baseTypeName: "String", genericArgs: [] };
          if (ch === "'") return { typeName: "char", baseTypeName: "char", genericArgs: [] };
          break;
        }
      }
    }
    return null;
  }

  let i = initStart;
  const first = tokens[i];

  // `new TypeName<...>(...)` or `new TypeName[...]`
  if (first.text === "new" && i + 1 < initEnd) {
    const q = readQualifiedIdent(tokens, i + 1, initEnd);
    if (q) {
      let genericArgs = [];
      let j = q.nextIdx;
      if (j < initEnd && tokens[j].text === "<") {
        const afterGen = trySkipGenerics(tokens, match, j, initEnd, genericArgs);
        if (afterGen > j) {
          j = afterGen;
        }
      }
      const isArray = j < initEnd && tokens[j].text === "[";
      return {
        typeName: isArray ? `${q.simpleName}[]` : q.simpleName,
        baseTypeName: q.simpleName,
        genericArgs,
      };
    }
  }

  // Cast `(TypeName) expr`
  if (first.text === "(" && match[i] > i && match[i] < initEnd) {
    const castClose = match[i];
    const castType = readTypeRef(tokens, match, i + 1, castClose);
    if (castType && castType.nextIdx === castClose) {
      return {
        typeName: castType.typeName,
        baseTypeName: castType.baseTypeName,
        genericArgs: castType.genericArgs,
      };
    }
  }

  if (first.text === "true" || first.text === "false") {
    return { typeName: "boolean", baseTypeName: "boolean", genericArgs: [] };
  }

  if (first.kind === "number") {
    const lastCh = first.text[first.text.length - 1];
    if (lastCh === "L" || lastCh === "l") return { typeName: "long", baseTypeName: "long", genericArgs: [] };
    if (lastCh === "f" || lastCh === "F") return { typeName: "float", baseTypeName: "float", genericArgs: [] };
    if (first.text.includes(".") || lastCh === "d" || lastCh === "D") {
      return { typeName: "double", baseTypeName: "double", genericArgs: [] };
    }
    return { typeName: "int", baseTypeName: "int", genericArgs: [] };
  }

  // Common factory methods like List.of(...) / Set.of(...) / Map.of(...) / Optional.of(...)
  if (first.kind === "ident" && i + 2 < initEnd && tokens[i + 1].text === ".") {
    const recv = first.text;
    const member = tokens[i + 2].text;
    if (
      (recv === "List" || recv === "Set" || recv === "Map" || recv === "Optional" || recv === "Stream") &&
      (member === "of" || member === "copyOf" || member === "empty" || member === "ofNullable")
    ) {
      return { typeName: recv, baseTypeName: recv, genericArgs: [] };
    }
    if (recv === "Collections") {
      if (member.includes("List")) return { typeName: "List", baseTypeName: "List", genericArgs: [] };
      if (member.includes("Set")) return { typeName: "Set", baseTypeName: "Set", genericArgs: [] };
      if (member.includes("Map")) return { typeName: "Map", baseTypeName: "Map", genericArgs: [] };
    }
  }

  // Expression reference (for lazy call/variable lookup during scope resolution)
  if (first.kind === "ident") {
    const chain = [];
    let j = i;
    while (j < initEnd) {
      if (tokens[j].kind === "ident") {
        const isCall = j + 1 < initEnd && tokens[j + 1].text === "(";
        chain.push({ name: tokens[j].text, isCall });
        j += 1;
        if (j < initEnd && tokens[j].text === "(") {
          j = skipBalanced(tokens, match, j, initEnd);
        }
        if (j < initEnd && tokens[j].text === ".") {
          j += 1;
          continue;
        }
      }
      break;
    }
    if (chain.length > 0 && j === initEnd) {
      return {
        typeName: null,
        baseTypeName: null,
        genericArgs: [],
        initExprChain: chain,
      };
    }
  }

  return null;
}

function parseTypeNameListClause(tokens, match, startIdx, stopWords) {
  const names = [];
  let i = startIdx;
  while (i < tokens.length) {
    const t = tokens[i].text;
    if (t === "{" || t === "(" || t === ";" || stopWords.has(t)) break;
    if (t === ",") {
      i += 1;
      continue;
    }
    const typeRef = readTypeRef(tokens, match, i, tokens.length);
    if (typeRef) {
      names.push(typeRef.baseTypeName);
      i = typeRef.nextIdx;
    } else {
      i += 1;
    }
  }
  return { names, nextIdx: i };
}

function parseEnumConstants(unit, typeRec, tokens, match, bodyStart, bodyEnd) {
  let i = bodyStart;
  while (i < bodyEnd) {
    const tok = tokens[i];
    if (tok.text === ";") return i + 1;
    if (tok.text === "}") return i;

    const { annotations, nextIdx } = parseAnnotationsAndModifiers(tokens, match, i, bodyEnd);
    i = nextIdx;
    if (i >= bodyEnd || tokens[i].text === ";" || tokens[i].text === "}") {
      return tokens[i]?.text === ";" ? i + 1 : i;
    }

    if (tokens[i].kind !== "ident") {
      i += 1;
      continue;
    }

    const constTok = tokens[i];
    typeRec.fields.push({
      name: constTok.text,
      typeName: typeRec.name,
      annotations: annotations.map((a) => a.name),
      line: constTok.line,
      column: constTok.col,
      signature: `${typeRec.name} ${constTok.text}`,
      isStatic: true,
      initializerType: typeRec.name,
      _baseTypeName: typeRec.name,
      _genericArgs: [],
      _isFinal: true,
    });
    i += 1;

    if (i < bodyEnd && tokens[i].text === "(") {
      i = skipBalanced(tokens, match, i, bodyEnd);
    }
    if (i < bodyEnd && tokens[i].text === "{") {
      const closeBrace = match[i];
      if (closeBrace > i && closeBrace < bodyEnd) {
        unit.executables.push({
          kind: "enumConstantBody",
          ownerType: typeRec,
          params: [],
          bodyStart: i + 1,
          bodyEnd: closeBrace,
          startTok: tokens[i],
          endTok: tokens[closeBrace],
        });
        i = closeBrace + 1;
      } else {
        i += 1;
      }
    }
    if (i < bodyEnd && tokens[i].text === ",") {
      i += 1;
      continue;
    }
    if (i < bodyEnd && tokens[i].text === ";") {
      return i + 1;
    }
  }
  return i;
}

function findStatementEnd(tokens, match, idx, limit) {
  let i = idx;
  while (i < limit) {
    const t = tokens[i].text;
    if (t === ";") return i;
    if (t === "(" || t === "{" || t === "[") {
      i = skipBalanced(tokens, match, i, limit);
      continue;
    }
    i += 1;
  }
  return limit;
}

function findNextCommaOrSemi(tokens, match, idx, limit) {
  let i = idx;
  while (i < limit) {
    const t = tokens[i].text;
    if (t === "," || t === ";") return i;
    if (t === "(" || t === "{" || t === "[") {
      i = skipBalanced(tokens, match, i, limit);
      continue;
    }
    i += 1;
  }
  return limit;
}

function parseTypeBody(unit, typeRec, tokens, match, bodyStart, bodyEnd) {
  let i = bodyStart;
  if (typeRec.kind === "enum") {
    i = parseEnumConstants(unit, typeRec, tokens, match, i, bodyEnd);
  }

  while (i < bodyEnd) {
    if (tokens[i].text === ";") {
      i += 1;
      continue;
    }

    const { annotations, modifiers, firstTok, nextIdx } = parseAnnotationsAndModifiers(tokens, match, i, bodyEnd);
    i = nextIdx;
    if (i >= bodyEnd) break;

    if (tokens[i].text === ";") {
      i += 1;
      continue;
    }

    // Static or instance initializer block: `{ ... }`
    if (tokens[i].text === "{") {
      const closeBrace = match[i];
      const execEnd = closeBrace > i && closeBrace < bodyEnd ? closeBrace : bodyEnd;
      unit.executables.push({
        kind: "initializer",
        name: modifiers.has("static") ? "<clinit>" : "<init>",
        ownerType: typeRec,
        isStatic: modifiers.has("static"),
        params: [],
        bodyStart: i + 1,
        bodyEnd: execEnd,
        startTok: tokens[i],
        endTok: tokens[execEnd] || tokens[bodyEnd - 1],
      });
      i = execEnd + 1;
      continue;
    }

    // Nested type declaration (`class`, `interface`, `enum`, `record`, `@interface`)
    if (
      (tokens[i].kind === "ident" && TYPE_DECL_KEYWORDS.has(tokens[i].text)) ||
      (tokens[i].text === "@" && i + 1 < bodyEnd && tokens[i + 1].text === "interface")
    ) {
      i = parseTypeDecl(unit, tokens, match, i, bodyEnd, typeRec, annotations, modifiers, firstTok);
      continue;
    }

    // Optional generic method/constructor type parameters `<T, U>`
    if (tokens[i].text === "<") {
      const afterGen = trySkipGenerics(tokens, match, i, bodyEnd);
      if (afterGen > i) i = afterGen;
    }
    if (i >= bodyEnd) break;

    // Compact record constructor: `public RecordName { ... }`
    if (
      typeRec.kind === "record" &&
      tokens[i].kind === "ident" &&
      tokens[i].text === typeRec.name &&
      i + 1 < bodyEnd &&
      tokens[i + 1].text === "{"
    ) {
      const nameTok = tokens[i];
      const openBrace = i + 1;
      const closeBrace = match[openBrace];
      const execEnd = closeBrace > openBrace && closeBrace < bodyEnd ? closeBrace : bodyEnd;
      const params = typeRec._recordComponents.map((c) => ({ ...c }));
      const sig = capSignature(`${typeRec.name}(${formatParamsSignature(params)})`);
      typeRec.constructors.push({
        line: nameTok.line,
        column: nameTok.col,
        arity: params.length,
        params,
        annotations: annotations.map((a) => a.name),
        signature: sig,
        _hasVarArgs: params.some((p) => p.isVarArgs),
      });
      unit.executables.push({
        kind: "constructor",
        name: typeRec.name,
        ownerType: typeRec,
        isStatic: false,
        params,
        bodyStart: openBrace + 1,
        bodyEnd: execEnd,
        headerStartTok: firstTok || nameTok,
        startTok: tokens[openBrace],
        endTok: tokens[execEnd] || tokens[bodyEnd - 1],
      });
      i = execEnd + 1;
      continue;
    }

    // Constructor: `ClassName(...)`
    if (
      tokens[i].kind === "ident" &&
      tokens[i].text === typeRec.name &&
      i + 1 < bodyEnd &&
      tokens[i + 1].text === "("
    ) {
      const nameTok = tokens[i];
      const { params, nextIdx: afterParams } = parseParamList(tokens, match, i + 1, bodyEnd);
      let j = afterParams;
      if (j < bodyEnd && tokens[j].text === "throws") {
        j += 1;
        while (j < bodyEnd && tokens[j].text !== "{" && tokens[j].text !== ";") j += 1;
      }
      const sig = capSignature(`${typeRec.name}(${formatParamsSignature(params)})`);
      typeRec.constructors.push({
        line: nameTok.line,
        column: nameTok.col,
        arity: params.length,
        params,
        annotations: annotations.map((a) => a.name),
        signature: sig,
        _hasVarArgs: params.some((p) => p.isVarArgs),
      });
      if (j < bodyEnd && tokens[j].text === "{") {
        const closeBrace = match[j];
        const execEnd = closeBrace > j && closeBrace < bodyEnd ? closeBrace : bodyEnd;
        unit.executables.push({
          kind: "constructor",
          name: typeRec.name,
          ownerType: typeRec,
          isStatic: false,
          params,
          bodyStart: j + 1,
          bodyEnd: execEnd,
          headerStartTok: firstTok || nameTok,
          startTok: tokens[j],
          endTok: tokens[execEnd] || tokens[bodyEnd - 1],
        });
        i = execEnd + 1;
      } else {
        i = j < bodyEnd && tokens[j].text === ";" ? j + 1 : j;
      }
      continue;
    }

    // Method or Field: starts with a TypeRef
    const typeRef = readTypeRef(tokens, match, i, bodyEnd);
    if (!typeRef) {
      i += 1;
      continue;
    }
    let j = typeRef.nextIdx;
    if (j >= bodyEnd || tokens[j].kind !== "ident") {
      i = findStatementEnd(tokens, match, i, bodyEnd) + 1;
      continue;
    }

    const memberTok = tokens[j];
    j += 1;

    // Method declaration: `ReturnType methodName ( params ) ...`
    if (j < bodyEnd && tokens[j].text === "(") {
      const { params, nextIdx: afterParams } = parseParamList(tokens, match, j, bodyEnd);
      j = afterParams;
      let extraDims = 0;
      while (j + 1 < bodyEnd && tokens[j].text === "[" && tokens[j + 1].text === "]") {
        extraDims += 1;
        j += 2;
      }
      if (j < bodyEnd && tokens[j].text === "throws") {
        j += 1;
        while (j < bodyEnd && tokens[j].text !== "{" && tokens[j].text !== ";" && tokens[j].text !== "default") {
          j += 1;
        }
      }
      // Annotation member default value: `String value() default "";`
      if (j < bodyEnd && tokens[j].text === "default") {
        j = findStatementEnd(tokens, match, j + 1, bodyEnd);
      }

      const hasBody = j < bodyEnd && tokens[j].text === "{";
      const isStatic = modifiers.has("static");
      const isDefault = modifiers.has("default");
      const isAbstract =
        modifiers.has("abstract") ||
        (!hasBody && !isStatic && !isDefault && !modifiers.has("native") && (typeRec.kind === "interface" || typeRec.kind === "@interface"));
      const returnType = extraDims > 0 ? typeRef.typeName + "[]".repeat(extraDims) : typeRef.typeName;
      const modPrefix = Array.from(modifiers).join(" ");
      const sig = capSignature(`${modPrefix ? modPrefix + " " : ""}${returnType} ${memberTok.text}(${formatParamsSignature(params)})`);
      const annNames = annotations.map((a) => a.name);

      const methodRec = {
        name: memberTok.text,
        kind: "method",
        line: memberTok.line,
        column: memberTok.col,
        arity: params.length,
        isAbstract,
        isDefault,
        isStatic,
        returnType,
        annotations: annNames,
        signature: sig,
        _returnBaseType: typeRef.baseTypeName,
        _returnGenericArgs: typeRef.genericArgs,
        _hasVarArgs: params.some((p) => p.isVarArgs),
        _isPrivate: modifiers.has("private"),
        _params: params,
      };
      typeRec.methods.push(methodRec);
      unit.functions.push({
        methodRec,
        containerName: typeRec._qualifiedContainerName,
      });

      if (hasBody) {
        const closeBrace = match[j];
        const execEnd = closeBrace > j && closeBrace < bodyEnd ? closeBrace : bodyEnd;
        unit.executables.push({
          kind: "method",
          name: memberTok.text,
          ownerType: typeRec,
          isStatic,
          params,
          bodyStart: j + 1,
          bodyEnd: execEnd,
          headerStartTok: firstTok || memberTok,
          startTok: tokens[j],
          endTok: tokens[execEnd] || tokens[bodyEnd - 1],
        });
        i = execEnd + 1;
      } else {
        i = j < bodyEnd && tokens[j].text === ";" ? j + 1 : j;
      }
      continue;
    }

    // Field declaration(s): `Type f1 [= init1], f2 [= init2];`
    const isStaticField = modifiers.has("static") || typeRec.kind === "interface" || typeRec.kind === "@interface";
    const isFinalField = modifiers.has("final") || typeRec.kind === "interface" || typeRec.kind === "@interface";
    const annNames = annotations.map((a) => a.name);
    const modPrefix = Array.from(modifiers).join(" ");
    let curFieldTok = memberTok;
    let cur = j;

    while (cur <= bodyEnd) {
      let extraDims = 0;
      while (cur + 1 < bodyEnd && tokens[cur].text === "[" && tokens[cur + 1].text === "]") {
        extraDims += 1;
        cur += 2;
      }
      const fieldType = extraDims > 0 ? typeRef.typeName + "[]".repeat(extraDims) : typeRef.typeName;
      const declEnd = findNextCommaOrSemi(tokens, match, cur, bodyEnd);
      let initializerType = null;
      let initInfo = null;
      if (cur < declEnd && tokens[cur].text === "=") {
        const eqTok = tokens[cur];
        initInfo = inferInitializerType(tokens, match, cur + 1, declEnd, unit.rawLines, eqTok);
        if (initInfo && initInfo.typeName) initializerType = initInfo.typeName;
        // Record field initializer spans containing braces/lambdas so local scope works inside them
        if (cur + 1 < declEnd) {
          unit.fieldInitializers.push({
            kind: "fieldInitializer",
            name: curFieldTok.text,
            ownerType: typeRec,
            isStatic: isStaticField,
            params: [],
            bodyStart: cur + 1,
            bodyEnd: declEnd,
            startTok: tokens[cur + 1],
            endTok: tokens[declEnd - 1],
          });
        }
      }

      const sig = `${modPrefix ? modPrefix + " " : ""}${fieldType} ${curFieldTok.text}`.trim();
      typeRec.fields.push({
        name: curFieldTok.text,
        typeName: fieldType,
        annotations: annNames,
        line: curFieldTok.line,
        column: curFieldTok.col,
        signature: sig,
        isStatic: isStaticField,
        initializerType,
        _baseTypeName: typeRef.baseTypeName,
        _genericArgs: typeRef.genericArgs.length ? typeRef.genericArgs : (initInfo?.genericArgs || []),
        _isFinal: isFinalField,
        _isPrivate: modifiers.has("private"),
        _initInfo: initInfo,
      });

      if (declEnd >= bodyEnd || tokens[declEnd].text === ";") {
        i = declEnd + 1;
        break;
      }
      // Next comma-separated declarator
      cur = declEnd + 1;
      if (cur < bodyEnd && tokens[cur].kind === "ident") {
        curFieldTok = tokens[cur];
        cur += 1;
      } else {
        i = findStatementEnd(tokens, match, cur, bodyEnd) + 1;
        break;
      }
    }
  }
}

function parseTypeDecl(
  unit,
  tokens,
  match,
  kwIdx,
  limit,
  parentType = null,
  preAnns = [],
  preMods = new Set(),
  preFirstTok = null
) {
  let i = kwIdx;
  let kind = null;
  if (tokens[i].text === "@" && i + 1 < limit && tokens[i + 1].text === "interface") {
    kind = "@interface";
    i += 2;
  } else if (TYPE_DECL_KEYWORDS.has(tokens[i].text)) {
    kind = tokens[i].text;
    i += 1;
  } else {
    return kwIdx + 1;
  }

  if (i >= limit || tokens[i].kind !== "ident") return i;
  const nameTok = tokens[i];
  i += 1;

  if (i < limit && tokens[i].text === "<") {
    const afterGen = trySkipGenerics(tokens, match, i, limit);
    if (afterGen > i) i = afterGen;
  }

  const recordComponents = [];
  if (kind === "record" && i < limit && tokens[i].text === "(") {
    const parsed = parseParamList(tokens, match, i, limit);
    for (let k = 0; k < parsed.params.length; k += 1) {
      recordComponents.push(parsed.params[k]);
    }
    i = parsed.nextIdx;
  }

  const extendsList = [];
  const implementsList = [];

  while (i < limit && tokens[i].text !== "{" && tokens[i].text !== ";") {
    const t = tokens[i].text;
    if (t === "extends") {
      const res = parseTypeNameListClause(tokens, match, i + 1, TYPE_CLAUSE_STOP_WORDS);
      extendsList.push(...res.names);
      i = res.nextIdx;
      continue;
    }
    if (t === "implements") {
      const res = parseTypeNameListClause(tokens, match, i + 1, TYPE_CLAUSE_STOP_WORDS);
      implementsList.push(...res.names);
      i = res.nextIdx;
      continue;
    }
    if (t === "permits") {
      const res = parseTypeNameListClause(tokens, match, i + 1, TYPE_CLAUSE_STOP_WORDS);
      i = res.nextIdx;
      continue;
    }
    i += 1;
  }

  const bodyOpen = i < limit && tokens[i].text === "{" ? i : -1;
  const bodyClose = bodyOpen >= 0 && match[bodyOpen] >= 0 && match[bodyOpen] < limit ? match[bodyOpen] : (bodyOpen >= 0 ? limit - 1 : i);
  const endLine = bodyClose >= 0 && bodyClose < tokens.length ? tokens[bodyClose].line : nameTok.line;

  const isExported =
    preMods.has("public") ||
    Boolean(parentType && parentType.kind === "interface" && !preMods.has("private") && !preMods.has("protected"));
  const isAbstract = kind === "interface" || kind === "@interface" || preMods.has("abstract");
  const qualifiedContainer = parentType ? `${parentType._qualifiedContainerName}.${nameTok.text}` : nameTok.text;

  const typeRec = {
    name: nameTok.text,
    kind,
    line: nameTok.line,
    column: nameTok.col,
    endLine,
    isAbstract,
    isExported,
    extends: extendsList,
    implements: implementsList,
    annotations: preAnns.map((a) => a.name),
    fields: [],
    constructors: [],
    methods: [],
    _parentType: parentType,
    _isStaticMember: preMods.has("static") || Boolean(parentType && (parentType.kind === "interface" || kind === "interface" || kind === "enum" || kind === "record")),
    _qualifiedContainerName: qualifiedContainer,
    _recordComponents: recordComponents,
    _startTok: preFirstTok || nameTok,
    _endTok: bodyClose >= 0 && bodyClose < tokens.length ? tokens[bodyClose] : nameTok,
  };

  if (kind === "record") {
    for (let k = 0; k < recordComponents.length; k += 1) {
      const rc = recordComponents[k];
      typeRec.fields.push({
        name: rc.name,
        typeName: rc.typeName,
        annotations: rc.annotations,
        line: rc.line,
        column: rc.column,
        signature: `${rc.typeName} ${rc.name}`,
        isStatic: false,
        initializerType: null,
        _baseTypeName: rc.baseTypeName,
        _genericArgs: rc.genericArgs,
        _isFinal: true,
        _isRecordComponent: true,
      });
    }
  }

  unit.types.push(typeRec);
  if (isExported) {
    unit.exports.push(typeRec);
  }

  if (bodyOpen >= 0) {
    parseTypeBody(unit, typeRec, tokens, match, bodyOpen + 1, bodyClose);
    if (kind === "record" && typeRec.constructors.length === 0) {
      typeRec.constructors.push({
        line: nameTok.line,
        column: nameTok.col,
        arity: recordComponents.length,
        params: recordComponents.map((c) => ({ ...c })),
        signature: capSignature(`${nameTok.text}(${formatParamsSignature(recordComponents)})`),
        _hasVarArgs: recordComponents.some((p) => p.isVarArgs),
      });
    }
    return bodyClose + 1;
  }

  return i < limit && tokens[i].text === ";" ? i + 1 : i;
}

function parseJavaUnit(sourceText, filePath = "", preLines = null, preMaskedLines = null) {
  const rawLines = preLines || splitCodeLinesExpanded(sourceText);
  const maskedLines = preMaskedLines || maskNonCodeRegions(rawLines, "java");
  const tokens = tokenizeJavaMaskedLines(maskedLines);
  const match = computeBracketMatches(tokens);

  const unit = {
    lang: "java",
    path: filePath,
    packageName: "",
    imports: [],
    exports: [],
    reExports: [],
    types: [],
    functions: [],
    topVariables: [],
    rawLines,
    maskedLines,
    tokens,
    match,
    executables: [],
    fieldInitializers: [],
  };

  const n = tokens.length;
  let i = 0;

  while (i < n) {
    if (tokens[i].text === ";") {
      i += 1;
      continue;
    }

    const { annotations, modifiers, firstTok, nextIdx } = parseAnnotationsAndModifiers(tokens, match, i, n);
    i = nextIdx;
    if (i >= n) break;

    if (tokens[i].text === ";") {
      i += 1;
      continue;
    }

    // `package com.acme.orders;`
    if (tokens[i].text === "package") {
      const q = readQualifiedIdent(tokens, i + 1, n);
      if (q) {
        unit.packageName = q.qualifiedName;
        i = findStatementEnd(tokens, match, q.nextIdx, n) + 1;
        continue;
      }
    }

    // `import [static] a.b.Cls;` or `import [static] a.b.*;`
    if (tokens[i].text === "import") {
      const stmtEnd = findStatementEnd(tokens, match, i + 1, n);
      let j = i + 1;
      let isStatic = false;
      if (j < stmtEnd && tokens[j].text === "static") {
        isStatic = true;
        j += 1;
      }
      const q = readQualifiedIdent(tokens, j, stmtEnd);
      if (q) {
        let isWildcard = false;
        let qualifiedName = q.qualifiedName;
        let simpleName = q.simpleName;
        let col = q.lastTok.col;
        let line = q.lastTok.line;
        if (q.nextIdx + 1 < stmtEnd && tokens[q.nextIdx].text === "." && tokens[q.nextIdx + 1].text === "*") {
          isWildcard = true;
          qualifiedName = `${q.qualifiedName}.*`;
          simpleName = "*";
          line = q.firstTok.line;
          col = q.firstTok.col;
        }
        unit.imports.push({
          simpleName,
          qualifiedName,
          isStatic,
          isWildcard,
          line,
          column: col,
          _stmtLine: tokens[i].line,
          _ownerTypeFqn: isStatic && !isWildcard && q.parts.length >= 2
            ? q.parts.slice(0, -1).map((p) => p.text).join(".")
            : (isWildcard ? q.qualifiedName : qualifiedName),
          _ownerSimpleName: isStatic && !isWildcard && q.parts.length >= 2
            ? q.parts[q.parts.length - 2].text
            : (isWildcard && isStatic ? q.simpleName : simpleName),
        });
      }
      i = stmtEnd + 1;
      continue;
    }

    // Type declaration
    if (
      (tokens[i].kind === "ident" && TYPE_DECL_KEYWORDS.has(tokens[i].text)) ||
      (tokens[i].text === "@" && i + 1 < n && tokens[i + 1].text === "interface")
    ) {
      i = parseTypeDecl(unit, tokens, match, i, n, null, annotations, modifiers, firstTok);
      continue;
    }

    i += 1;
  }

  return unit;
}

function toPublicField(f) {
  return {
    name: f.name,
    typeName: f.typeName,
    baseTypeName: f._baseTypeName || f.baseTypeName || stripGenericSuffix(f.typeName),
    genericArgs: Array.isArray(f._genericArgs) ? [...f._genericArgs] : [],
    annotations: f.annotations,
    line: f.line,
    column: f.column,
    signature: f.signature,
    isStatic: Boolean(f.isStatic),
    isFinal: Boolean(f._isFinal ?? f.isFinal),
    isPrivate: Boolean(f._isPrivate ?? f.isPrivate),
    isRecordComponent: Boolean(f._isRecordComponent ?? f.isRecordComponent),
    initializerType: f.initializerType ?? null,
  };
}

function toPublicConstructor(c) {
  return {
    line: c.line,
    column: c.column,
    arity: c.arity,
    annotations: Array.isArray(c.annotations) ? [...c.annotations] : [],
    hasVarArgs: Boolean(c._hasVarArgs ?? c.hasVarArgs),
    params: c.params.map((p) => ({
      name: p.name,
      typeName: p.typeName,
      baseTypeName: p.baseTypeName || stripGenericSuffix(p.typeName),
      annotations: p.annotations,
      isVarArgs: Boolean(p.isVarArgs),
      line: p.line,
      column: p.column,
    })),
    signature: c.signature,
  };
}

function toPublicMethod(m) {
  return {
    name: m.name,
    kind: "method",
    line: m.line,
    column: m.column,
    arity: m.arity,
    isAbstract: Boolean(m.isAbstract),
    isDefault: Boolean(m.isDefault),
    isStatic: Boolean(m.isStatic),
    isPrivate: Boolean(m._isPrivate ?? m.isPrivate),
    returnType: m.returnType,
    returnBaseType: m._returnBaseType || m.returnBaseType || stripGenericSuffix(m.returnType),
    returnGenericArgs: Array.isArray(m._returnGenericArgs) ? [...m._returnGenericArgs] : [],
    hasVarArgs: Boolean(m._hasVarArgs ?? m.hasVarArgs),
    params: Array.isArray(m._params)
      ? m._params.map((p) => ({
          name: p.name,
          typeName: p.typeName || null,
          baseTypeName: p.baseTypeName || stripGenericSuffix(p.typeName),
          isVarArgs: Boolean(p.isVarArgs),
          line: p.line,
          column: p.column,
        }))
      : [],
    annotations: m.annotations,
    signature: m.signature,
  };
}

function toPublicType(t, pubMethodMap = null) {
  return {
    name: t.name,
    kind: t.kind,
    line: t.line,
    column: t.column,
    endLine: t.endLine,
    isAbstract: Boolean(t.isAbstract),
    isExported: Boolean(t.isExported),
    extends: [...t.extends],
    implements: [...t.implements],
    annotations: [...t.annotations],
    fields: t.fields.map(toPublicField),
    constructors: t.constructors.map(toPublicConstructor),
    methods: t.methods.map((m) => {
      const pm = toPublicMethod(m);
      if (pubMethodMap) pubMethodMap.set(m, pm);
      return pm;
    }),
  };
}

/**
 * Extract structured symbol summary for a Java file.
 */
export function extractFileSymbolSummary(sourceText, filePath = "") {
  const text = typeof sourceText === "string" ? sourceText : "";
  if (!isNavSourceWithinLimits(text)) {
    return {
      lang: "java",
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
  const unit = parseJavaUnit(text, filePath);
  const pubMethodMap = new Map();
  const publicTypes = [];
  const publicExports = [];
  for (let i = 0; i < unit.types.length; i += 1) {
    const pubType = toPublicType(unit.types[i], pubMethodMap);
    publicTypes.push(pubType);
    if (unit.types[i].isExported) {
      publicExports.push(pubType);
    }
  }
  const imports = unit.imports.map((imp) => ({
    simpleName: imp.simpleName,
    qualifiedName: imp.qualifiedName,
    isStatic: Boolean(imp.isStatic),
    isWildcard: Boolean(imp.isWildcard),
    line: imp.line,
    column: imp.column,
  }));
  const functions = unit.functions.map((fn) => {
    const rawMethod = fn.methodRec || fn;
    const pubMethod = pubMethodMap.get(rawMethod) || toPublicMethod(rawMethod);
    return {
      ...pubMethod,
      containerName: fn.containerName,
    };
  });

  return {
    lang: "java",
    path: filePath,
    packageName: unit.packageName,
    imports,
    exports: publicExports,
    reExports: [],
    types: publicTypes,
    functions,
    topVariables: [],
  };
}

// =============================================================================
// On-demand Local Scope Tree Builder (Executable Bodies & Block Scopes)
// =============================================================================

function createScopeNode(parent, startIdx, endIdx, startTok, endTok) {
  return {
    parent,
    startIdx,
    endIdx,
    startTok,
    endTok,
    vars: [],
    children: [],
  };
}

function findStatementBlockEnd(tokens, match, startIdx, limit) {
  if (startIdx >= limit) return startIdx;
  if (tokens[startIdx].text === "{") {
    const close = match[startIdx];
    return close > startIdx && close < limit ? close + 1 : limit;
  }
  return Math.min(limit, findStatementEnd(tokens, match, startIdx, limit) + 1);
}

function findLambdaBodyEnd(tokens, match, startIdx, limit) {
  if (startIdx >= limit) return startIdx;
  if (tokens[startIdx].text === "{") {
    const close = match[startIdx];
    return close > startIdx && close < limit ? close + 1 : limit;
  }
  let i = startIdx;
  while (i < limit) {
    const t = tokens[i].text;
    if (t === "," || t === ";" || t === ")" || t === "}") return i;
    if (t === "(" || t === "{" || t === "[") {
      i = skipBalanced(tokens, match, i, limit);
      continue;
    }
    i += 1;
  }
  return limit;
}

function parseVarDeclsInRange(unit, scope, tokens, match, startIdx, endIdx, allowSemicolonStop = true) {
  let i = startIdx;
  const { modifiers, nextIdx } = parseAnnotationsAndModifiers(tokens, match, i, endIdx);
  if (modifiers.size > 0 && !modifiers.has("final")) return -1;
  i = nextIdx;
  if (i >= endIdx) return -1;

  const typeRef = readTypeRef(tokens, match, i, endIdx);
  if (!typeRef) return -1;
  let j = typeRef.nextIdx;
  if (j >= endIdx || tokens[j].kind !== "ident") return -1;
  if (STATEMENT_KEYWORDS.has(tokens[j].text)) return -1;

  // Peek after identifier + optional [] to verify `=`, `;`, `,`, or `:`
  let peek = j + 1;
  while (peek + 1 < endIdx && tokens[peek].text === "[" && tokens[peek + 1].text === "]") peek += 2;
  if (peek >= endIdx) return -1;
  const afterIdent = tokens[peek].text;
  if (afterIdent !== "=" && afterIdent !== ";" && afterIdent !== "," && afterIdent !== ":") {
    return -1;
  }

  let curTok = tokens[j];
  let cur = j + 1;
  while (cur < endIdx) {
    let extraDims = 0;
    while (cur + 1 < endIdx && tokens[cur].text === "[" && tokens[cur + 1].text === "]") {
      extraDims += 1;
      cur += 2;
    }
    const declEnd = allowSemicolonStop ? findNextCommaOrSemi(tokens, match, cur, endIdx) : endIdx;
    let initInfo = null;
    let resolvedTypeName = typeRef.typeName + (extraDims > 0 ? "[]".repeat(extraDims) : "");
    let baseTypeName = typeRef.baseTypeName;
    let genericArgs = typeRef.genericArgs;
    let initExprChain = null;

    if (cur < declEnd && tokens[cur].text === "=") {
      const eqTok = tokens[cur];
      initInfo = inferInitializerType(tokens, match, cur + 1, declEnd, unit.rawLines, eqTok);
      if (resolvedTypeName === "var" && initInfo) {
        if (initInfo.typeName) {
          resolvedTypeName = initInfo.typeName;
          baseTypeName = initInfo.baseTypeName;
        }
        if (initInfo.genericArgs?.length) genericArgs = initInfo.genericArgs;
        if (initInfo.initExprChain) initExprChain = initInfo.initExprChain;
      } else if (initInfo?.genericArgs?.length && genericArgs.length === 0) {
        genericArgs = initInfo.genericArgs;
      }
      // Scan initializer expression for nested lambdas/anonymous classes!
      if (cur + 1 < declEnd) {
        scanTokensIntoScopeTree(unit, scope, tokens, match, cur + 1, declEnd, false);
      }
    }

    scope.vars.push({
      name: curTok.text,
      kind: "variable",
      typeName: resolvedTypeName === "var" ? null : resolvedTypeName,
      baseTypeName: baseTypeName === "var" ? null : baseTypeName,
      genericArgs,
      unionTypes: null,
      initializerType: initInfo?.typeName || null,
      initExprChain,
      line: curTok.line,
      column: curTok.col,
      signature: `${typeRef.typeName} ${curTok.text}`,
    });

    if (declEnd >= endIdx || tokens[declEnd].text === ";" || tokens[declEnd].text === ":") {
      return declEnd < endIdx ? declEnd + 1 : endIdx;
    }
    cur = declEnd + 1;
    if (cur < endIdx && tokens[cur].kind === "ident" && !STATEMENT_KEYWORDS.has(tokens[cur].text)) {
      curTok = tokens[cur];
      cur += 1;
    } else {
      return declEnd + 1;
    }
  }
  return endIdx;
}

function parseCatchHeader(scope, tokens, match, openIdx, closeIdx) {
  const { nextIdx } = parseAnnotationsAndModifiers(tokens, match, openIdx + 1, closeIdx);
  let i = nextIdx;
  const unionTypes = [];
  while (i < closeIdx) {
    const typeRef = readTypeRef(tokens, match, i, closeIdx);
    if (!typeRef) break;
    unionTypes.push(typeRef.baseTypeName);
    i = typeRef.nextIdx;
    if (i < closeIdx && tokens[i].text === "|") {
      i += 1;
      continue;
    }
    break;
  }
  if (i < closeIdx && tokens[i].kind === "ident") {
    const varTok = tokens[i];
    scope.vars.push({
      name: varTok.text,
      kind: "parameter",
      typeName: unionTypes[0] || null,
      baseTypeName: unionTypes[0] || null,
      genericArgs: [],
      unionTypes: unionTypes.length > 1 ? unionTypes : null,
      initializerType: null,
      initExprChain: null,
      line: varTok.line,
      column: varTok.col,
      signature: `${unionTypes.join(" | ")} ${varTok.text}`.trim(),
    });
  }
}

function extractPatternInstanceofVars(tokens, match, startIdx, endIdx) {
  const vars = [];
  let i = startIdx;
  while (i + 2 < endIdx) {
    if (tokens[i].text === "instanceof") {
      let j = i + 1;
      if (j < endIdx && tokens[j].text === "final") j += 1;
      const typeRef = readTypeRef(tokens, match, j, endIdx);
      if (typeRef && typeRef.nextIdx < endIdx && tokens[typeRef.nextIdx].kind === "ident") {
        const varTok = tokens[typeRef.nextIdx];
        if (!STATEMENT_KEYWORDS.has(varTok.text)) {
          vars.push({
            name: varTok.text,
            kind: "variable",
            typeName: typeRef.typeName,
            baseTypeName: typeRef.baseTypeName,
            genericArgs: typeRef.genericArgs,
            unionTypes: null,
            initializerType: null,
            initExprChain: null,
            line: varTok.line,
            column: varTok.col,
            signature: `${typeRef.typeName} ${varTok.text}`,
          });
          i = typeRef.nextIdx + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return vars;
}

function parseLambdaAt(unit, parentScope, tokens, match, startIdx, limit) {
  // Pattern 1: single unparenthesized param `ident -> ...` (must not be `case ident ->`)
  if (
    tokens[startIdx].kind === "ident" &&
    !STATEMENT_KEYWORDS.has(tokens[startIdx].text) &&
    startIdx + 1 < limit &&
    tokens[startIdx + 1].text === "->"
  ) {
    const prevText = startIdx > 0 ? tokens[startIdx - 1].text : "";
    if (prevText === "case" || prevText === "default") return -1;
    const paramTok = tokens[startIdx];
    const bodyStart = startIdx + 2;
    const bodyEnd = findLambdaBodyEnd(tokens, match, bodyStart, limit);
    const lScope = createScopeNode(
      parentScope,
      startIdx,
      bodyEnd,
      paramTok,
      tokens[Math.min(tokens.length - 1, bodyEnd - 1)]
    );
    lScope.vars.push({
      name: paramTok.text,
      kind: "parameter",
      typeName: null,
      baseTypeName: null,
      genericArgs: [],
      unionTypes: null,
      initializerType: null,
      initExprChain: null,
      line: paramTok.line,
      column: paramTok.col,
      signature: paramTok.text,
    });
    parentScope.children.push(lScope);
    if (bodyStart < bodyEnd && tokens[bodyStart].text === "{") {
      scanTokensIntoScopeTree(unit, lScope, tokens, match, bodyStart + 1, bodyEnd - 1, true);
    } else {
      scanTokensIntoScopeTree(unit, lScope, tokens, match, bodyStart, bodyEnd, false);
    }
    return bodyEnd;
  }

  // Pattern 2: parenthesized `(a, b) -> ...` or `(Type a, Type b) -> ...`
  if (tokens[startIdx].text === "(") {
    const closeIdx = match[startIdx];
    if (closeIdx > startIdx && closeIdx + 1 < limit && tokens[closeIdx + 1].text === "->") {
      const bodyStart = closeIdx + 2;
      const bodyEnd = findLambdaBodyEnd(tokens, match, bodyStart, limit);
      const lScope = createScopeNode(
        parentScope,
        startIdx,
        bodyEnd,
        tokens[startIdx],
        tokens[Math.min(tokens.length - 1, bodyEnd - 1)]
      );
      // Parse lambda params inside (startIdx + 1 .. closeIdx)
      let p = startIdx + 1;
      while (p < closeIdx) {
        const { nextIdx } = parseAnnotationsAndModifiers(tokens, match, p, closeIdx);
        p = nextIdx;
        if (p >= closeIdx) break;
        if (tokens[p].text === ",") {
          p += 1;
          continue;
        }
        if (p < closeIdx && tokens[p].kind === "ident" && (p + 1 === closeIdx || (p + 1 < closeIdx && tokens[p + 1].text === ","))) {
          const pTok = tokens[p];
          lScope.vars.push({
            name: pTok.text,
            kind: "parameter",
            typeName: null,
            baseTypeName: null,
            genericArgs: [],
            unionTypes: null,
            initializerType: null,
            initExprChain: null,
            line: pTok.line,
            column: pTok.col,
            signature: pTok.text,
          });
          p += 1;
          continue;
        }
        const typeRef = readTypeRef(tokens, match, p, closeIdx);
        if (typeRef && typeRef.nextIdx < closeIdx && tokens[typeRef.nextIdx].kind === "ident") {
          const pTok = tokens[typeRef.nextIdx];
          lScope.vars.push({
            name: pTok.text,
            kind: "parameter",
            typeName: typeRef.typeName === "var" ? null : typeRef.typeName,
            baseTypeName: typeRef.baseTypeName === "var" ? null : typeRef.baseTypeName,
            genericArgs: typeRef.genericArgs,
            unionTypes: null,
            initializerType: null,
            initExprChain: null,
            line: pTok.line,
            column: pTok.col,
            signature: `${typeRef.typeName} ${pTok.text}`,
          });
          p = typeRef.nextIdx + 1;
        }
        while (p < closeIdx && tokens[p].text !== ",") p += 1;
        if (p < closeIdx && tokens[p].text === ",") p += 1;
      }
      parentScope.children.push(lScope);
      if (bodyStart < bodyEnd && tokens[bodyStart].text === "{") {
        scanTokensIntoScopeTree(unit, lScope, tokens, match, bodyStart + 1, bodyEnd - 1, true);
      } else {
        scanTokensIntoScopeTree(unit, lScope, tokens, match, bodyStart, bodyEnd, false);
      }
      return bodyEnd;
    }
  }
  return -1;
}

function scanTokensIntoScopeTree(unit, parentScope, tokens, match, startIdx, endIdx, atStatementBoundary = true) {
  let i = startIdx;
  let stmtStart = atStatementBoundary;

  while (i < endIdx) {
    const tok = tokens[i];
    const t = tok.text;

    if (t === ";") {
      stmtStart = true;
      i += 1;
      continue;
    }

    // Nested block `{ ... }`
    if (t === "{") {
      const close = match[i];
      const bEnd = close > i && close < endIdx ? close : endIdx - 1;
      const bScope = createScopeNode(parentScope, i, bEnd + 1, tok, tokens[bEnd] || tok);
      parentScope.children.push(bScope);
      scanTokensIntoScopeTree(unit, bScope, tokens, match, i + 1, bEnd, true);
      stmtStart = true;
      i = bEnd + 1;
      continue;
    }

    // Lambda expressions (`x -> ...` or `(a, b) -> ...`)
    const lambdaNext = parseLambdaAt(unit, parentScope, tokens, match, i, endIdx);
    if (lambdaNext > i) {
      stmtStart = false;
      i = lambdaNext;
      continue;
    }

    // `for (...) stmt`
    if (t === "for" && i + 1 < endIdx && tokens[i + 1].text === "(") {
      const openP = i + 1;
      const closeP = match[openP] > openP && match[openP] < endIdx ? match[openP] : openP + 1;
      const bodyEnd = findStatementBlockEnd(tokens, match, closeP + 1, endIdx);
      const forScope = createScopeNode(parentScope, i, bodyEnd, tok, tokens[Math.min(tokens.length - 1, bodyEnd - 1)]);
      parentScope.children.push(forScope);

      // Detect `;` vs `:` at depth 0 inside `(openP + 1 .. closeP)`
      let semiPos = -1;
      let colonPos = -1;
      let p = openP + 1;
      while (p < closeP) {
        if (tokens[p].text === "(" || tokens[p].text === "{" || tokens[p].text === "[") {
          p = skipBalanced(tokens, match, p, closeP);
          continue;
        }
        if (tokens[p].text === ";") {
          semiPos = p;
          break;
        }
        if (tokens[p].text === ":") {
          colonPos = p;
          break;
        }
        p += 1;
      }

      if (semiPos > openP) {
        parseVarDeclsInRange(unit, forScope, tokens, match, openP + 1, semiPos + 1, true);
        scanTokensIntoScopeTree(unit, forScope, tokens, match, semiPos + 1, closeP, false);
      } else if (colonPos > openP) {
        const res = parseVarDeclsInRange(unit, forScope, tokens, match, openP + 1, colonPos + 1, false);
        if (res > 0 && forScope.vars.length > 0 && colonPos + 1 < closeP) {
          const v = forScope.vars[forScope.vars.length - 1];
          // Record iterable expression chain so `for (var item : items)` can resolve `OrderItem`!
          const iterTok = tokens[colonPos + 1];
          if (iterTok && iterTok.kind === "ident") {
            const chain = [];
            let k = colonPos + 1;
            while (k < closeP && tokens[k].kind === "ident") {
              const isCall = k + 1 < closeP && tokens[k + 1].text === "(";
              chain.push({ name: tokens[k].text, isCall });
              k += 1;
              if (k < closeP && tokens[k].text === "(") k = skipBalanced(tokens, match, k, closeP);
              if (k < closeP && tokens[k].text === ".") k += 1;
              else break;
            }
            v._iterableChain = chain;
          }
          scanTokensIntoScopeTree(unit, forScope, tokens, match, colonPos + 1, closeP, false);
        }
      }

      if (closeP + 1 < bodyEnd && tokens[closeP + 1].text === "{") {
        scanTokensIntoScopeTree(unit, forScope, tokens, match, closeP + 2, bodyEnd - 1, true);
      } else {
        scanTokensIntoScopeTree(unit, forScope, tokens, match, closeP + 1, bodyEnd, true);
      }
      stmtStart = true;
      i = bodyEnd;
      continue;
    }

    // `try (resources) { ... }`
    if (t === "try" && i + 1 < endIdx && tokens[i + 1].text === "(") {
      const openP = i + 1;
      const closeP = match[openP] > openP && match[openP] < endIdx ? match[openP] : openP + 1;
      const bodyEnd = findStatementBlockEnd(tokens, match, closeP + 1, endIdx);
      const tryScope = createScopeNode(parentScope, i, bodyEnd, tok, tokens[Math.min(tokens.length - 1, bodyEnd - 1)]);
      parentScope.children.push(tryScope);

      // Split resources by `;` at top level of `(openP + 1 .. closeP)`
      let rStart = openP + 1;
      while (rStart < closeP) {
        let rEnd = rStart;
        while (rEnd < closeP && tokens[rEnd].text !== ";") {
          if (tokens[rEnd].text === "(" || tokens[rEnd].text === "{" || tokens[rEnd].text === "[") {
            rEnd = skipBalanced(tokens, match, rEnd, closeP);
            continue;
          }
          rEnd += 1;
        }
        parseVarDeclsInRange(unit, tryScope, tokens, match, rStart, rEnd < closeP ? rEnd + 1 : closeP, true);
        rStart = rEnd + 1;
      }

      if (closeP + 1 < bodyEnd && tokens[closeP + 1].text === "{") {
        scanTokensIntoScopeTree(unit, tryScope, tokens, match, closeP + 2, bodyEnd - 1, true);
      }
      stmtStart = true;
      i = bodyEnd;
      continue;
    }

    // `catch (ExA | ExB ex) { ... }`
    if (t === "catch" && i + 1 < endIdx && tokens[i + 1].text === "(") {
      const openP = i + 1;
      const closeP = match[openP] > openP && match[openP] < endIdx ? match[openP] : openP + 1;
      const bodyEnd = findStatementBlockEnd(tokens, match, closeP + 1, endIdx);
      const catchScope = createScopeNode(parentScope, i, bodyEnd, tok, tokens[Math.min(tokens.length - 1, bodyEnd - 1)]);
      parentScope.children.push(catchScope);
      parseCatchHeader(catchScope, tokens, match, openP, closeP);
      if (closeP + 1 < bodyEnd && tokens[closeP + 1].text === "{") {
        scanTokensIntoScopeTree(unit, catchScope, tokens, match, closeP + 2, bodyEnd - 1, true);
      }
      stmtStart = true;
      i = bodyEnd;
      continue;
    }

    // `if (...) stmt` or `while (...) stmt` with optional `instanceof Type var`
    if ((t === "if" || t === "while") && i + 1 < endIdx && tokens[i + 1].text === "(") {
      const openP = i + 1;
      const closeP = match[openP] > openP && match[openP] < endIdx ? match[openP] : openP + 1;
      const bodyEnd = findStatementBlockEnd(tokens, match, closeP + 1, endIdx);
      const patternVars = extractPatternInstanceofVars(tokens, match, openP + 1, closeP);
      if (patternVars.length > 0 && openP + 1 < closeP) {
        const condScope = createScopeNode(
          parentScope,
          openP + 1,
          closeP,
          tokens[openP + 1],
          tokens[closeP]
        );
        condScope.vars.push(...patternVars);
        parentScope.children.push(condScope);
        scanTokensIntoScopeTree(unit, condScope, tokens, match, openP + 1, closeP, false);
      } else {
        scanTokensIntoScopeTree(unit, parentScope, tokens, match, openP + 1, closeP, false);
      }
      if (closeP + 1 < bodyEnd) {
        const bodyScope = createScopeNode(
          parentScope,
          closeP + 1,
          bodyEnd,
          tokens[closeP + 1],
          tokens[bodyEnd - 1]
        );
        if (patternVars.length > 0) bodyScope.vars.push(...patternVars);
        parentScope.children.push(bodyScope);
        if (tokens[closeP + 1].text === "{") {
          scanTokensIntoScopeTree(unit, bodyScope, tokens, match, closeP + 2, bodyEnd - 1, true);
        } else {
          scanTokensIntoScopeTree(unit, bodyScope, tokens, match, closeP + 1, bodyEnd, true);
        }
      }
      stmtStart = true;
      i = bodyEnd;
      continue;
    }

    // Anonymous class method bodies inside `new Type(...) { public void run(...) { ... } }`
    if (t === "new" && i + 1 < endIdx) {
      let j = i + 1;
      const q = readQualifiedIdent(tokens, j, endIdx);
      if (q) {
        j = q.nextIdx;
        if (j < endIdx && tokens[j].text === "<") {
          const ag = trySkipGenerics(tokens, match, j, endIdx);
          if (ag > j) j = ag;
        }
        if (j < endIdx && tokens[j].text === "(") {
          j = skipBalanced(tokens, match, j, endIdx);
          if (j < endIdx && tokens[j].text === "{") {
            const anonClose = match[j] > j && match[j] < endIdx ? match[j] : endIdx - 1;
            const anonScope = createScopeNode(parentScope, j, anonClose + 1, tokens[j], tokens[anonClose]);
            parentScope.children.push(anonScope);
            scanAnonClassMembers(unit, anonScope, tokens, match, j + 1, anonClose);
            stmtStart = false;
            i = anonClose + 1;
            continue;
          }
        }
      }
    }

    // Local variable declaration at statement boundary (or after `else`/`do`/label `:`)
    if (stmtStart) {
      const nextAfterVar = parseVarDeclsInRange(unit, parentScope, tokens, match, i, endIdx, true);
      if (nextAfterVar > i) {
        stmtStart = true;
        i = nextAfterVar;
        continue;
      }
    }

    if (t === "else" || t === "do" || t === ":") {
      stmtStart = true;
      i += 1;
      continue;
    }

    // Step inside `(` or `[` so nested lambdas/calls get scanned
    if (t === "(" || t === "[") {
      const close = match[i];
      if (close > i && close < endIdx) {
        scanTokensIntoScopeTree(unit, parentScope, tokens, match, i + 1, close, false);
        stmtStart = false;
        i = close + 1;
        continue;
      }
    }

    // `->` (e.g. switch rule `case X -> ...`) resets statement boundary
    if (t === "->") {
      stmtStart = true;
      i += 1;
      continue;
    }

    stmtStart = false;
    i += 1;
  }
}

function scanAnonClassMembers(unit, anonScope, tokens, match, startIdx, endIdx) {
  let i = startIdx;
  while (i < endIdx) {
    if (tokens[i].text === ";") {
      i += 1;
      continue;
    }
    const { nextIdx } = parseAnnotationsAndModifiers(tokens, match, i, endIdx);
    i = nextIdx;
    if (i >= endIdx) break;
    if (tokens[i].text === "<") {
      const ag = trySkipGenerics(tokens, match, i, endIdx);
      if (ag > i) i = ag;
    }
    const typeRef = readTypeRef(tokens, match, i, endIdx);
    if (typeRef && typeRef.nextIdx + 1 < endIdx && tokens[typeRef.nextIdx].kind === "ident" && tokens[typeRef.nextIdx + 1].text === "(") {
      const { params, nextIdx: afterP } = parseParamList(tokens, match, typeRef.nextIdx + 1, endIdx);
      let j = afterP;
      while (j < endIdx && tokens[j].text !== "{" && tokens[j].text !== ";") j += 1;
      if (j < endIdx && tokens[j].text === "{") {
        const mClose = match[j] > j && match[j] < endIdx ? match[j] : endIdx - 1;
        const mScope = createScopeNode(anonScope, j, mClose + 1, tokens[j], tokens[mClose]);
        for (let k = 0; k < params.length; k += 1) {
          const p = params[k];
          mScope.vars.push({
            name: p.name,
            kind: "parameter",
            typeName: p.typeName,
            baseTypeName: p.baseTypeName,
            genericArgs: p.genericArgs,
            unionTypes: null,
            initializerType: null,
            initExprChain: null,
            line: p.line,
            column: p.column,
            signature: `${p.typeName} ${p.name}`,
          });
        }
        anonScope.children.push(mScope);
        scanTokensIntoScopeTree(unit, mScope, tokens, match, j + 1, mClose, true);
        i = mClose + 1;
        continue;
      }
    }
    // Fallback: parse as normal statement/field
    const next = parseVarDeclsInRange(unit, anonScope, tokens, match, i, endIdx, true);
    if (next > i) {
      i = next;
    } else {
      i = findStatementEnd(tokens, match, i, endIdx) + 1;
    }
  }
}

function buildExecutableScopeTree(unit, exec) {
  const root = createScopeNode(
    null,
    exec.bodyStart,
    exec.bodyEnd,
    exec.startTok,
    exec.endTok
  );
  for (let i = 0; i < exec.params.length; i += 1) {
    const p = exec.params[i];
    root.vars.push({
      name: p.name,
      kind: "parameter",
      typeName: p.typeName,
      baseTypeName: p.baseTypeName,
      genericArgs: p.genericArgs,
      unionTypes: null,
      initializerType: null,
      initExprChain: null,
      line: p.line,
      column: p.column,
      signature: `${p.typeName} ${p.name}`,
    });
  }
  scanTokensIntoScopeTree(unit, root, unit.tokens, unit.match, exec.bodyStart, exec.bodyEnd, true);
  return root;
}

function findInnermostScopeAt(scope, line, col) {
  if (!scope) return null;
  for (let i = 0; i < scope.children.length; i += 1) {
    const child = scope.children[i];
    if (isCursorInsideRange(child.startTok, child.endTok, line, col)) {
      return findInnermostScopeAt(child, line, col) || child;
    }
  }
  return scope;
}

// =============================================================================
// Resolution Logic (Scopes, Types, Polymorphism, Lombok/Spring, Import Hints)
// =============================================================================

function findEnclosingPositionInfo(unit, line, col) {
  let enclosingType = null;
  for (let i = 0; i < unit.types.length; i += 1) {
    const t = unit.types[i];
    if (isCursorInsideRange(t._startTok, t._endTok, line, col)) {
      enclosingType = t; // deepest nested type wins since types are pushed outer-then-inner
    }
  }

  let enclosingExec = null;
  for (let i = 0; i < unit.executables.length; i += 1) {
    const ex = unit.executables[i];
    const startTok = ex.headerStartTok || ex.startTok;
    if (isCursorInsideRange(startTok, ex.endTok, line, col)) {
      enclosingExec = ex;
    }
  }
  if (!enclosingExec) {
    for (let i = 0; i < unit.fieldInitializers.length; i += 1) {
      const fi = unit.fieldInitializers[i];
      if (isCursorInsideRange(fi.startTok, fi.endTok, line, col)) {
        enclosingExec = fi;
      }
    }
  }

  // Also check if cursor is on an executable header/parameter line (e.g. method signature itself)
  let container = null;
  if (enclosingType) {
    if (enclosingExec && enclosingExec.kind === "method") {
      container = `${enclosingType._qualifiedContainerName}.${enclosingExec.name}`;
    } else if (enclosingExec && enclosingExec.kind === "constructor") {
      container = `${enclosingType._qualifiedContainerName}.${enclosingExec.name}`;
    } else {
      container = enclosingType._qualifiedContainerName;
    }
  }

  return { enclosingType, enclosingExec, enclosingContainer: container };
}

function findTokenIndexAt(tokens, line, col) {
  // Binary search by (line, col)
  let lo = 0;
  let hi = tokens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const tok = tokens[mid];
    if (line < tok.line || (line === tok.line && col < tok.col)) {
      hi = mid - 1;
    } else if (line > tok.line || (line === tok.line && col >= tok.endCol)) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

function ensureUnitTypeCache(unit) {
  if (unit._typeCache && unit._typeCacheCount === unit.types.length) {
    return unit._typeCache;
  }
  const byName = new Map();
  const nestedByParent = new Map();
  const subtypesByParent = new Map();
  for (let i = 0; i < unit.types.length; i += 1) {
    const t = unit.types[i];
    if (!byName.has(t.name)) byName.set(t.name, t);
    if (t._parentType) {
      let nMap = nestedByParent.get(t._parentType);
      if (!nMap) {
        nMap = new Map();
        nestedByParent.set(t._parentType, nMap);
      }
      if (!nMap.has(t.name)) nMap.set(t.name, t);
    }
    const ext = t.extends;
    for (let j = 0; j < ext.length; j += 1) {
      let arr = subtypesByParent.get(ext[j]);
      if (!arr) {
        arr = [];
        subtypesByParent.set(ext[j], arr);
      }
      arr.push(t);
    }
    const imp = t.implements;
    for (let j = 0; j < imp.length; j += 1) {
      let arr = subtypesByParent.get(imp[j]);
      if (!arr) {
        arr = [];
        subtypesByParent.set(imp[j], arr);
      }
      arr.push(t);
    }
  }
  const cache = {
    byName,
    nestedByParent,
    subtypesByParent,
    subtypesResult: new Map(),
    supertypesWithSelf: new Map(),
    supertypesNoSelf: new Map(),
    extParents: new Map(),
    superNamesNoSelf: new Map(),
    extParentNames: new Map(),
  };
  unit._typeCache = cache;
  unit._typeCacheCount = unit.types.length;
  return cache;
}

function findTypeByName(unit, typeName, fromType = null) {
  if (!typeName) return null;
  const clean = typeName.endsWith("[]") ? typeName.slice(0, -2) : typeName;
  const cache = ensureUnitTypeCache(unit);
  if (fromType) {
    const nested = cache.nestedByParent.get(fromType)?.get(clean);
    if (nested) return nested;
  }
  return cache.byName.get(clean) || null;
}

function findImportForSymbol(unit, name, opts = {}) {
  if (!name) return null;
  const { preferStatic = false, isType = false } = opts;

  // 1. Exact non-wildcard imports
  let exactTypeImp = null;
  let exactStaticImp = null;
  let wildcardTypeImp = null;
  let wildcardStaticImp = null;

  for (let i = 0; i < unit.imports.length; i += 1) {
    const imp = unit.imports[i];
    if (!imp.isWildcard && imp.simpleName === name) {
      if (imp.isStatic) exactStaticImp = exactStaticImp || imp;
      else exactTypeImp = exactTypeImp || imp;
    } else if (imp.isWildcard) {
      if (imp.isStatic) wildcardStaticImp = wildcardStaticImp || imp;
      else wildcardTypeImp = wildcardTypeImp || imp;
    }
  }

  if (preferStatic && exactStaticImp) return exactStaticImp;
  if (exactTypeImp) return exactTypeImp;
  if (exactStaticImp) return exactStaticImp;

  // Built-in java.lang types beat wildcard imports
  if (!preferStatic && JAVA_LANG_TYPES.has(name)) {
    return {
      simpleName: name,
      qualifiedName: `java.lang.${name}`,
      isStatic: false,
      isWildcard: false,
      line: null,
      column: null,
      _ownerTypeFqn: `java.lang.${name}`,
      _ownerSimpleName: name,
      _isBuiltin: true,
    };
  }

  if (preferStatic && wildcardStaticImp) return wildcardStaticImp;
  if ((isType || isUpperStart(name)) && wildcardTypeImp) return wildcardTypeImp;
  if (!isType && wildcardStaticImp) return wildcardStaticImp;

  return null;
}

function buildExternalHint(unit, typeName, memberName = null, opts = {}) {
  const {
    isAnnotation = false,
    isTypeContext = false,
    arity = null,
    explicitQualifiedName = null,
  } = opts;

  if (explicitQualifiedName) {
    const parts = explicitQualifiedName.split(".");
    const resolvedTypeName = typeName || parts[parts.length - 1] || null;
    return {
      typeName: resolvedTypeName,
      memberName: memberName || null,
      importedName: memberName || resolvedTypeName,
      simpleName: memberName || resolvedTypeName,
      specifier: explicitQualifiedName,
      qualifiedName: explicitQualifiedName,
      isStatic: false,
      isWildcard: false,
      isAnnotation: Boolean(isAnnotation),
      isTypeContext: Boolean(isTypeContext),
      arity: Number.isFinite(arity) ? arity : null,
      fallbackLine: null,
      fallbackColumn: null,
    };
  }

  if (!typeName && !memberName) return null;

  // Static import lookup when resolving an unqualified call/constant like `helper()`
  if (!typeName && memberName) {
    const imp = findImportForSymbol(unit, memberName, { preferStatic: true, isType: false });
    if (!imp) return null;
    const ownerSimple = imp._ownerSimpleName || null;
    const ownerFqn = imp._ownerTypeFqn || imp.qualifiedName;
    return {
      typeName: ownerSimple,
      memberName,
      importedName: memberName,
      simpleName: memberName,
      specifier: ownerFqn,
      qualifiedName: imp.isWildcard ? `${ownerFqn}.${memberName}` : imp.qualifiedName,
      isStatic: Boolean(imp.isStatic),
      isWildcard: Boolean(imp.isWildcard),
      isAnnotation: Boolean(isAnnotation),
      isTypeContext: Boolean(isTypeContext),
      arity: Number.isFinite(arity) ? arity : null,
      fallbackLine: imp.line || null,
      fallbackColumn: imp.column || null,
    };
  }

  const cleanType = typeName.endsWith("[]") ? typeName.slice(0, -2) : typeName;
  if (JAVA_PRIMITIVE_TYPES.has(cleanType)) return null;

  const imp = findImportForSymbol(unit, cleanType, { preferStatic: false, isType: true });
  if (imp) {
    const fqn = imp.isWildcard
      ? `${imp.qualifiedName.replace(/\.\*$/, "")}.${cleanType}`
      : (imp._ownerTypeFqn || imp.qualifiedName);
    return {
      typeName: cleanType,
      memberName: memberName || null,
      importedName: cleanType,
      simpleName: cleanType,
      specifier: imp.isWildcard ? imp.qualifiedName : fqn,
      qualifiedName: fqn,
      isStatic: Boolean(imp.isStatic),
      isWildcard: Boolean(imp.isWildcard),
      isAnnotation: Boolean(isAnnotation),
      isTypeContext: Boolean(isTypeContext),
      arity: Number.isFinite(arity) ? arity : null,
      fallbackLine: imp.line || null,
      fallbackColumn: imp.column || null,
    };
  }

  // Same-package fallback for unimported types in the same Java package
  const pkgFqn = unit.packageName ? `${unit.packageName}.${cleanType}` : cleanType;
  return {
    typeName: cleanType,
    memberName: memberName || null,
    importedName: cleanType,
    simpleName: cleanType,
    specifier: pkgFqn,
    qualifiedName: pkgFqn,
    isStatic: false,
    isWildcard: false,
    isAnnotation: Boolean(isAnnotation),
    isTypeContext: Boolean(isTypeContext),
    arity: Number.isFinite(arity) ? arity : null,
    fallbackLine: null,
    fallbackColumn: null,
  };
}

function getAllSameFileSubtypes(unit, baseTypeName) {
  const cache = ensureUnitTypeCache(unit);
  const cached = cache.subtypesResult.get(baseTypeName);
  if (cached) return cached;
  const result = [];
  const visited = new Set([baseTypeName]);
  const queue = [baseTypeName];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const direct = cache.subtypesByParent.get(cur);
    if (!direct) continue;
    for (let i = 0; i < direct.length; i += 1) {
      const t = direct[i];
      if (visited.has(t.name)) continue;
      visited.add(t.name);
      result.push(t);
      queue.push(t.name);
    }
  }
  cache.subtypesResult.set(baseTypeName, result);
  return result;
}

function getAllSameFileSupertypes(unit, typeRec, includeSelf = true) {
  if (!typeRec) return [];
  const cache = ensureUnitTypeCache(unit);
  const memo = includeSelf ? cache.supertypesWithSelf : cache.supertypesNoSelf;
  const cached = memo.get(typeRec);
  if (cached) return cached;

  const result = [];
  const visited = new Set();
  const queue = [];
  let head = 0;
  if (includeSelf) {
    visited.add(typeRec.name);
    result.push(typeRec);
    queue.push(typeRec);
  } else {
    visited.add(typeRec.name);
    for (let i = 0; i < typeRec.extends.length; i += 1) {
      const pType = findTypeByName(unit, typeRec.extends[i]);
      if (pType && !visited.has(pType.name)) {
        visited.add(pType.name);
        result.push(pType);
        queue.push(pType);
      }
    }
    for (let i = 0; i < typeRec.implements.length; i += 1) {
      const pType = findTypeByName(unit, typeRec.implements[i]);
      if (pType && !visited.has(pType.name)) {
        visited.add(pType.name);
        result.push(pType);
        queue.push(pType);
      }
    }
  }

  while (head < queue.length) {
    const cur = queue[head++];
    for (let i = 0; i < cur.extends.length; i += 1) {
      const pType = findTypeByName(unit, cur.extends[i]);
      if (pType && !visited.has(pType.name)) {
        visited.add(pType.name);
        result.push(pType);
        queue.push(pType);
      }
    }
    for (let i = 0; i < cur.implements.length; i += 1) {
      const pType = findTypeByName(unit, cur.implements[i]);
      if (pType && !visited.has(pType.name)) {
        visited.add(pType.name);
        result.push(pType);
        queue.push(pType);
      }
    }
  }
  memo.set(typeRec, result);
  return result;
}

function collectExternalParents(unit, typeRec) {
  if (!typeRec) return [];
  const cache = ensureUnitTypeCache(unit);
  const cached = cache.extParents.get(typeRec);
  if (cached) return cached;

  const externals = [];
  const visited = new Set([typeRec.name]);
  const queue = [typeRec];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (let pass = 0; pass < 2; pass += 1) {
      const list = pass === 0 ? cur.extends : cur.implements;
      for (let i = 0; i < list.length; i += 1) {
        const pName = list[i];
        const sameFile = findTypeByName(unit, pName);
        if (sameFile) {
          if (!visited.has(sameFile.name)) {
            visited.add(sameFile.name);
            queue.push(sameFile);
          }
        } else {
          externals.push(pName);
        }
      }
    }
  }
  cache.extParents.set(typeRec, externals);
  return externals;
}

function hasJavaSupertypeName(unit, typeRec, targetName) {
  const cache = ensureUnitTypeCache(unit);
  let superSet = cache.superNamesNoSelf.get(typeRec);
  if (!superSet) {
    const supers = getAllSameFileSupertypes(unit, typeRec, false);
    superSet = new Set();
    for (let i = 0; i < supers.length; i += 1) superSet.add(supers[i].name);
    cache.superNamesNoSelf.set(typeRec, superSet);
  }
  if (superSet.has(targetName)) return true;
  let extSet = cache.extParentNames.get(typeRec);
  if (!extSet) {
    const exts = collectExternalParents(unit, typeRec);
    extSet = new Set(exts);
    cache.extParentNames.set(typeRec, extSet);
  }
  return extSet.has(targetName);
}

function resolveLocalScopeSymbol(unit, scope, symbol, cursorLine, cursorCol, visitedLocal = new Set()) {
  let cur = scope;
  let depthDist = 0;
  while (cur) {
    // Walk backward in vars so later shadowing declarations in same scope win
    for (let i = cur.vars.length - 1; i >= 0; i -= 1) {
      const v = cur.vars[i];
      if (v.name !== symbol) continue;
      if (!isTokenAtOrBefore({ line: v.line, col: v.column }, cursorLine, cursorCol)) continue;
      const inferred = resolveLocalVarTypes(unit, cur, v, cursorLine, cursorCol, visitedLocal);
      return {
        varRec: v,
        typeNames: inferred.typeNames,
        genericArgs: inferred.genericArgs,
        baseTypeName: inferred.baseTypeName,
        exactScope: depthDist === 0,
      };
    }
    cur = cur.parent;
    depthDist += 1;
  }
  return null;
}

function resolveExprChainType(unit, scope, enclosingType, chain, cursorLine, cursorCol, visited = new Set()) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const first = chain[0];
  let curType = null;
  let genericArgs = [];

  if (first.name === "this" && enclosingType) {
    curType = enclosingType.name;
  } else if (first.name === "super" && enclosingType) {
    curType = stripGenericSuffix(enclosingType.extends[0]) || null;
  } else if (first.isCall) {
    const m = findMethodReturnTypeInHierarchy(unit, enclosingType, first.name, first.arity);
    if (m) {
      curType = stripGenericSuffix(m.returnType);
      genericArgs = m.genericArgs;
    } else if (
      enclosingType &&
      (first.name === "builder" || first.name === "toBuilder") &&
      (first.arity === 0 || first.arity == null) &&
      hasLombokBuilder(enclosingType)
    ) {
      curType = `${BUILDER_TYPE_PREFIX}${enclosingType.name}`;
    } else if (enclosingType) {
      const acc = findLombokOrRecordAccessorFields(enclosingType, first.name, first.arity ?? null);
      if (acc.length > 0) {
        curType = acc[0]._baseTypeName || stripGenericSuffix(acc[0].typeName);
        genericArgs = acc[0]._genericArgs || [];
      }
    }
  } else {
    const localMatch = scope ? resolveLocalScopeSymbol(unit, scope, first.name, cursorLine, cursorCol, visited) : null;
    if (localMatch && localMatch.typeNames.length > 0) {
      curType = stripGenericSuffix(localMatch.baseTypeName || localMatch.typeNames[0]);
      genericArgs = localMatch.genericArgs;
    } else if (enclosingType) {
      const fld = findFieldInTypeChain(unit, enclosingType, first.name);
      if (fld) {
        curType = fld._baseTypeName || stripGenericSuffix(fld.typeName);
        genericArgs = fld._genericArgs || [];
      }
    }
    if (!curType && (findTypeByName(unit, first.name) || findImportForSymbol(unit, first.name, { isType: true }) || isUpperStart(first.name))) {
      curType = first.name;
    }
  }

  let crossFileChain = null;
  const findLocal = (n) => findTypeByName(unit, n);

  for (let i = 1; i < chain.length && curType; i += 1) {
    const step = chain[i];
    const tRec = !curType.startsWith(BUILDER_TYPE_PREFIX) ? findTypeByName(unit, curType) : null;

    if (tRec) {
      if (step.isCall) {
        const m = findMethodReturnTypeInHierarchy(unit, tRec, step.name, step.arity);
        if (m && m.returnType && m.returnType !== "void") {
          curType = stripGenericSuffix(m.returnType);
          genericArgs = m.genericArgs;
          continue;
        }
      } else {
        const fld = findFieldInTypeChain(unit, tRec, step.name);
        if (fld && fld.typeName) {
          curType = fld._baseTypeName || stripGenericSuffix(fld.typeName);
          genericArgs = fld._genericArgs || [];
          continue;
        }
      }
    }

    const advanced = advanceJavaContainerOrBuilderType(curType, genericArgs, step, findLocal);
    if (advanced && advanced.typeName) {
      curType = stripGenericSuffix(advanced.typeName);
      genericArgs = advanced.genericArgs || [];
      continue;
    }

    // Preserve root type & remaining chain so symbol-index.js can resolve across files or report external library
    crossFileChain = {
      rootType: stripGenericSuffix(curType),
      rootGenericArgs: [...genericArgs],
      steps: chain.slice(i),
    };
    curType = null;
    genericArgs = [];
    break;
  }

  if (curType && !curType.startsWith(BUILDER_TYPE_PREFIX) && !findTypeByName(unit, curType) && !crossFileChain) {
    crossFileChain = {
      rootType: stripGenericSuffix(curType),
      rootGenericArgs: [...genericArgs],
      steps: [],
    };
  }

  return curType || crossFileChain
    ? { typeName: curType, genericArgs, crossFileChain }
    : null;
}

function resolveLocalVarTypes(unit, scope, v, cursorLine, cursorCol, visited = new Set()) {
  if (v.unionTypes && v.unionTypes.length > 0) {
    const bases = v.unionTypes.map(stripGenericSuffix);
    return { typeNames: bases, genericArgs: [], baseTypeName: bases[0] };
  }
  if (v.typeName) {
    const base = v.baseTypeName || stripGenericSuffix(v.typeName);
    const genArgs = v.genericArgs && v.genericArgs.length > 0
      ? v.genericArgs
      : parseGenericArgsFromTypeStr(v.typeName);
    return {
      typeNames: [base],
      genericArgs: genArgs,
      baseTypeName: base,
    };
  }
  const visitKey = `${v.line}:${v.column}:${v.name}`;
  if (visited.has(visitKey)) return { typeNames: [], genericArgs: [], baseTypeName: null };
  visited.add(visitKey);

  const { enclosingType } = findEnclosingPositionInfo(unit, v.line, v.column);
  if (v._iterableChain) {
    const colRes = resolveExprChainType(unit, scope, enclosingType, v._iterableChain, v.line, v.column, visited);
    if (colRes) {
      if (colRes.genericArgs && colRes.genericArgs.length > 0) {
        const elem = stripGenericSuffix(colRes.genericArgs[0]);
        return { typeNames: [elem], genericArgs: [], baseTypeName: elem };
      }
      if (colRes.typeName && colRes.typeName.endsWith("[]")) {
        const elem = colRes.typeName.slice(0, -2);
        return { typeNames: [elem], genericArgs: [], baseTypeName: elem };
      }
    }
  }
  if (v.initExprChain) {
    const exprRes = resolveExprChainType(unit, scope, enclosingType, v.initExprChain, v.line, v.column, visited);
    if (exprRes && exprRes.typeName) {
      const base = stripGenericSuffix(exprRes.typeName);
      return {
        typeNames: [base],
        genericArgs: exprRes.genericArgs || [],
        baseTypeName: base,
      };
    }
  }
  return { typeNames: [], genericArgs: [], baseTypeName: null };
}

function findFieldInTypeChain(unit, typeRec, fieldName) {
  const hierarchy = getAllSameFileSupertypes(unit, typeRec, true);
  for (let i = 0; i < hierarchy.length; i += 1) {
    const t = hierarchy[i];
    for (let f = 0; f < t.fields.length; f += 1) {
      if (t.fields[f].name === fieldName) return t.fields[f];
    }
  }
  // Enclosing outer type fields for non-static inner classes
  let outer = typeRec?._parentType;
  let mustBeStatic = Boolean(typeRec?._isStaticMember);
  while (outer) {
    for (let f = 0; f < outer.fields.length; f += 1) {
      const fld = outer.fields[f];
      if (fld.name === fieldName && (!mustBeStatic || fld.isStatic)) return fld;
    }
    mustBeStatic = mustBeStatic || Boolean(outer._isStaticMember);
    outer = outer._parentType;
  }
  return null;
}

function findMethodReturnTypeInHierarchy(unit, typeRec, methodName, arity = null) {
  if (!typeRec) return null;
  const hierarchy = getAllSameFileSupertypes(unit, typeRec, true);
  for (let i = 0; i < hierarchy.length; i += 1) {
    const t = hierarchy[i];
    let firstMatch = null;
    for (let m = 0; m < t.methods.length; m += 1) {
      const meth = t.methods[m];
      if (meth.name === methodName) {
        if (arity !== null && arity !== undefined && meth.arity === arity) {
          return {
            returnType: meth.returnType,
            genericArgs: meth._returnGenericArgs || [],
          };
        }
        if (!firstMatch) firstMatch = meth;
      }
    }
    if (firstMatch) {
      return {
        returnType: firstMatch.returnType,
        genericArgs: firstMatch._returnGenericArgs || [],
      };
    }
  }
  return null;
}

function hasLombokGetterForField(typeRec, fieldRec) {
  const anns = typeRec.annotations || [];
  const classHasGetter =
    anns.includes("Data") ||
    anns.includes("Getter") ||
    anns.includes("Value");
  const fieldHasGetter = (fieldRec.annotations || []).includes("Getter");
  return classHasGetter || fieldHasGetter;
}

function hasLombokSetterForField(typeRec, fieldRec) {
  const anns = typeRec.annotations || [];
  const classHasSetter =
    anns.includes("Data") ||
    anns.includes("Setter");
  const fieldHasSetter = (fieldRec.annotations || []).includes("Setter");
  const isFinal = Boolean(fieldRec._isFinal ?? fieldRec.isFinal);
  return !isFinal && (classHasSetter || fieldHasSetter);
}

export function findLombokOrRecordAccessorFields(typeRec, methodName, arity) {
  const matches = [];
  if (!typeRec) return matches;
  const wantArity = Number.isFinite(arity) ? arity : null;

  // Record implicit accessors: `record Point(int x)` -> `point.x()`
  if (typeRec.kind === "record" && (wantArity === 0 || wantArity === null)) {
    for (let i = 0; i < (typeRec.fields || []).length; i += 1) {
      const f = typeRec.fields[i];
      if ((f._isRecordComponent ?? f.isRecordComponent) && f.name === methodName) {
        matches.push(f);
      }
    }
  }

  // Lombok `@Data` / `@Getter` / `@Value`: `getOrderId()`, `isActive()`
  if ((wantArity === 0 || wantArity === null) && (methodName.startsWith("get") || methodName.startsWith("is"))) {
    const isBoolPrefix = methodName.startsWith("is");
    const prefixLen = isBoolPrefix ? 2 : 3;
    if (methodName.length > prefixLen) {
      const rest = methodName.slice(prefixLen);
      const targetName = decapitalize(rest);
      const lowerRest = rest.toLowerCase();
      for (let i = 0; i < (typeRec.fields || []).length; i += 1) {
        const f = typeRec.fields[i];
        if (f.isStatic || !hasLombokGetterForField(typeRec, f)) continue;
        if (isBoolPrefix) {
          if (f.name === methodName || f.name === targetName || f.name.toLowerCase() === lowerRest) {
            matches.push(f);
          }
        } else if (f.name === targetName || f.name.toLowerCase() === lowerRest) {
          matches.push(f);
        }
      }
    }
  }

  // Lombok `@Data` / `@Setter`: `setOrderId(val)`
  if ((wantArity === 1 || wantArity === null) && methodName.startsWith("set") && methodName.length > 3) {
    const rest = methodName.slice(3);
    const targetName = decapitalize(rest);
    const lowerRest = rest.toLowerCase();
    for (let i = 0; i < (typeRec.fields || []).length; i += 1) {
      const f = typeRec.fields[i];
      if (f.isStatic || !hasLombokSetterForField(typeRec, f)) continue;
      if (f.name === targetName || f.name.toLowerCase() === lowerRest) {
        matches.push(f);
      }
    }
  }

  return matches;
}

export function findJavaSummaryMemberCandidates(typeRec, memberName, filePath, context = {}) {
  const cands = [];
  if (!typeRec || !memberName) return cands;
  const wantArity = Number.isFinite(context?.arity) ? context.arity : null;
  const callArgTypes = Array.isArray(context?.callArgTypes) ? context.callArgTypes : null;

  // Synthetic `@Builder` fluent receiver (`__builderOf:TypeName`)
  if (context?.builderTarget) {
    if (memberName === "build" && (wantArity === 0 || wantArity === null)) {
      const bMethod = (typeRec.methods || []).find((m) => m.isStatic && (m.annotations || []).includes("Builder"));
      if (bMethod) {
        cands.push(
          normalizeNavCandidate(
            {
              filePath,
              line: bMethod.line,
              column: bMethod.column,
              name: bMethod.name,
              kind: "method",
              containerName: typeRec.name,
              signature: bMethod.signature || "",
              arity: bMethod.arity ?? null,
              lang: "java",
              score: 175,
            },
            { filePath, lang: "java" }
          )
        );
        return cands;
      }
      const bCtor = (typeRec.constructors || []).find((c) => (c.annotations || []).includes("Builder"));
      if (bCtor) {
        cands.push(
          normalizeNavCandidate(
            {
              filePath,
              line: bCtor.line,
              column: bCtor.column,
              name: typeRec.name,
              kind: "constructor",
              containerName: typeRec.name,
              signature: bCtor.signature || "",
              arity: bCtor.arity ?? null,
              lang: "java",
              score: 175,
            },
            { filePath, lang: "java" }
          )
        );
        return cands;
      }
      cands.push(
        normalizeNavCandidate(
          {
            filePath,
            line: typeRec.line,
            column: typeRec.column,
            name: typeRec.name,
            kind: typeRec.kind || "class",
            containerName: "",
            isAbstract: Boolean(typeRec.isAbstract),
            lang: "java",
            score: 170,
          },
          { filePath, lang: "java" }
        )
      );
      return cands;
    }

    const bMethod = (typeRec.methods || []).find((m) => m.isStatic && (m.annotations || []).includes("Builder"));
    const bCtor = (typeRec.constructors || []).find((c) => (c.annotations || []).includes("Builder"));
    const customParams = bMethod?.params || bCtor?.params || null;
    if (customParams && (wantArity === 1 || wantArity === null)) {
      for (const p of customParams) {
        if (p.name === memberName) {
          cands.push(
            normalizeNavCandidate(
              {
                filePath,
                line: p.line,
                column: p.column,
                name: p.name,
                kind: "parameter",
                containerName: typeRec.name,
                signature: `${p.typeName || ""} ${p.name}`.trim(),
                arity: wantArity,
                lang: "java",
                score: 170,
              },
              { filePath, lang: "java" }
            )
          );
        }
      }
    }
    if (cands.length === 0 && (wantArity === 1 || wantArity === null) && hasLombokBuilder(typeRec)) {
      for (const f of typeRec.fields || []) {
        if (!f.isStatic && f.name === memberName) {
          cands.push(
            normalizeNavCandidate(
              {
                filePath,
                line: f.line,
                column: f.column,
                name: f.name,
                kind: "field",
                containerName: typeRec.name,
                signature: f.signature || "",
                arity: wantArity,
                lang: "java",
                score: 168,
              },
              { filePath, lang: "java" }
            )
          );
        }
      }
    }
    if (cands.length > 0) return cands;
  }

  // Explicit methods on type
  for (const m of typeRec.methods || []) {
    if (m.name !== memberName) continue;
    let score = 160;
    if (wantArity !== null) {
      const hasVarArgs = Boolean(m.hasVarArgs ?? m._hasVarArgs);
      if (m.arity === wantArity) score += 60;
      else if (hasVarArgs && wantArity >= Math.max(0, m.arity - 1)) score += 45;
      else score -= 15;
    }
    score += scoreJavaMethodParams(m.params || m._params, Boolean(m.hasVarArgs ?? m._hasVarArgs), callArgTypes, null);
    if (m.isAbstract) score -= 10;
    cands.push(
      normalizeNavCandidate(
        {
          filePath,
          line: m.line,
          column: m.column,
          name: m.name,
          kind: m.kind || "method",
          containerName: typeRec._qualifiedContainerName || typeRec.name,
          signature: m.signature || "",
          isAbstract: Boolean(m.isAbstract),
          isDefault: Boolean(m.isDefault),
          isPrivate: Boolean(m.isPrivate ?? m._isPrivate),
          arity: m.arity ?? null,
          lang: "java",
          score,
        },
        { filePath, lang: "java" }
      )
    );
  }

  // Fields or Lombok `@Data`/`@Getter`/`@Setter`/`@Value` / `@Builder` / record accessors
  if (!context?.isCall || cands.length === 0) {
    for (const f of typeRec.fields || []) {
      if (f.name !== memberName) continue;
      cands.push(
        normalizeNavCandidate(
          {
            filePath,
            line: f.line,
            column: f.column,
            name: f.name,
            kind: "field",
            containerName: typeRec._qualifiedContainerName || typeRec.name,
            signature: f.signature || "",
            isPrivate: Boolean(f.isPrivate ?? f._isPrivate),
            lang: "java",
            score: 145,
          },
          { filePath, lang: "java" }
        )
      );
    }
    if (cands.length === 0) {
      const accFields = findLombokOrRecordAccessorFields(typeRec, memberName, wantArity);
      for (const f of accFields) {
        cands.push(
          normalizeNavCandidate(
            {
              filePath,
              line: f.line,
              column: f.column,
              name: f.name,
              kind: "field",
              containerName: typeRec._qualifiedContainerName || typeRec.name,
              signature: f.signature || "",
              isPrivate: Boolean(f.isPrivate ?? f._isPrivate),
              arity: wantArity,
              lang: "java",
              score: 145,
            },
            { filePath, lang: "java" }
          )
        );
      }
    }
    if (cands.length === 0 && (memberName === "builder" || memberName === "build") && (wantArity === 0 || wantArity === null) && hasLombokBuilder(typeRec)) {
      cands.push(
        normalizeNavCandidate(
          {
            filePath,
            line: typeRec.line,
            column: typeRec.column,
            name: typeRec.name,
            kind: typeRec.kind || "class",
            containerName: "",
            isAbstract: Boolean(typeRec.isAbstract),
            lang: "java",
            score: 155,
          },
          { filePath, lang: "java" }
        )
      );
    }
  }
  return cands;
}

function makeTypeCandidate(t, filePath, score = 100) {
  return normalizeNavCandidate(
    {
      filePath,
      line: t.line,
      column: t.column,
      name: t.name,
      kind: t.kind,
      containerName: t._parentType ? t._parentType._qualifiedContainerName : "",
      signature: `${t.kind} ${t.name}`,
      isAbstract: t.isAbstract,
      isDefault: false,
      arity: null,
      lang: "java",
      exactScope: false,
      score,
    },
    { filePath, lang: "java" }
  );
}

function makeFieldCandidate(f, containerName, filePath, score = 100, exactScope = false, arity = null) {
  return normalizeNavCandidate(
    {
      filePath,
      line: f.line,
      column: f.column,
      name: f.name,
      kind: "field",
      containerName,
      signature: f.signature,
      isAbstract: false,
      isDefault: false,
      isPrivate: Boolean(f._isPrivate ?? f.isPrivate),
      arity,
      lang: "java",
      exactScope,
      score,
    },
    { filePath, lang: "java" }
  );
}

function makeConstructorCandidate(c, typeRec, filePath, score = 100, exactScope = false) {
  return normalizeNavCandidate(
    {
      filePath,
      line: c.line,
      column: c.column,
      name: typeRec.name,
      kind: "constructor",
      containerName: typeRec._qualifiedContainerName,
      signature: c.signature,
      isAbstract: false,
      isDefault: false,
      arity: c.arity,
      lang: "java",
      exactScope,
      score,
    },
    { filePath, lang: "java" }
  );
}

function makeMethodCandidate(m, containerName, filePath, score = 100, exactScope = false) {
  return normalizeNavCandidate(
    {
      filePath,
      line: m.line,
      column: m.column,
      name: m.name,
      kind: "method",
      containerName,
      signature: m.signature,
      isAbstract: m.isAbstract,
      isDefault: m.isDefault,
      isPrivate: Boolean(m._isPrivate ?? m.isPrivate),
      arity: m.arity,
      lang: "java",
      exactScope,
      score,
    },
    { filePath, lang: "java" }
  );
}

function makeLocalCandidate(v, containerName, filePath, exactScope) {
  return normalizeNavCandidate(
    {
      filePath,
      line: v.line,
      column: v.column,
      name: v.name,
      kind: v.kind || "variable",
      containerName: containerName || "",
      signature: v.signature,
      isAbstract: false,
      isDefault: false,
      arity: null,
      lang: "java",
      exactScope,
      score: exactScope ? 140 : 115,
    },
    { filePath, lang: "java" }
  );
}

function inferExprRangeType(unit, scope, enclosingType, tokens, match, s, e, cursorLine, cursorCol) {
  if (s >= e) {
    // Check blanked string/char literal between tokens[s - 1] and tokens[e]
    const prevTok = s > 0 ? tokens[s - 1] : null;
    const nextTok = e < tokens.length ? tokens[e] : null;
    if (prevTok && nextTok && prevTok.line === nextTok.line && unit.rawLines?.[prevTok.line - 1]) {
      const slice = unit.rawLines[prevTok.line - 1].slice(prevTok.endCol - 1, Math.max(0, nextTok.col - 1)).trim();
      if (slice.startsWith('"')) return "String";
      if (slice.startsWith("'")) return "char";
    }
    return null;
  }
  const first = tokens[s];
  if (first.text === "null") return null;
  if (first.text === "true" || first.text === "false") return "boolean";
  if (first.kind === "number") {
    const ch = first.text[first.text.length - 1];
    if (ch === "L" || ch === "l") return "long";
    if (ch === "f" || ch === "F") return "float";
    if (first.text.includes(".") || ch === "d" || ch === "D") return "double";
    return "int";
  }
  if (first.text === "new" && s + 1 < e) {
    const q = readQualifiedIdent(tokens, s + 1, e);
    return q ? q.simpleName : null;
  }
  if (first.text === "(" && match[s] > s && match[s] < e) {
    const castType = readTypeRef(tokens, match, s + 1, match[s]);
    if (castType && castType.nextIdx === match[s]) return castType.baseTypeName;
  }
  if (first.text === "this" && s + 1 === e && enclosingType) {
    return enclosingType.name;
  }
  if (first.kind === "ident" || first.text === "this" || first.text === "super") {
    const chain = [];
    let k = s;
    while (k < e) {
      if (tokens[k].kind !== "ident" && tokens[k].text !== "this" && tokens[k].text !== "super") break;
      const nm = tokens[k].text;
      k += 1;
      let isCall = false;
      let arity = null;
      if (k < e && tokens[k].text === "(") {
        isCall = true;
        arity = countCallArityAt(tokens, match, k);
        k = skipBalanced(tokens, match, k, e);
      }
      chain.push({ name: nm, isCall, arity });
      if (k < e && (tokens[k].text === "." || tokens[k].text === "::")) {
        k += 1;
        continue;
      }
      break;
    }
    if (chain.length > 0 && k === e) {
      const res = resolveExprChainType(unit, scope, enclosingType, chain, cursorLine, cursorCol);
      return res?.typeName ? stripGenericSuffix(res.typeName) : null;
    }
  }
  return null;
}

function extractCallArgTypesAtCursor(unit, scope, enclosingType, context) {
  if (!context?.isCall || context?.isDeclarationSignature) return null;
  const tokIdx = findTokenIndexAt(unit.tokens, context.line, context.col);
  if (tokIdx < 0) return null;
  const tokens = unit.tokens;
  const match = unit.match;
  let openP = tokIdx + 1;
  if (openP < tokens.length && tokens[openP].text === "<") {
    openP = trySkipGenerics(tokens, match, openP, tokens.length);
  }
  if (openP >= tokens.length || tokens[openP].text !== "(") return null;
  const closeP = match[openP];
  if (!(closeP > openP)) return null;
  if (closeP === openP + 1) return [];

  const argTypes = [];
  let segStart = openP + 1;
  let depth = 0;
  let k = openP + 1;
  while (k < closeP) {
    const tx = tokens[k].text;
    if (tx === "(" || tx === "[" || tx === "{") depth += 1;
    else if (tx === ")" || tx === "]" || tx === "}") depth = Math.max(0, depth - 1);
    else if (tx === "<" && depth === 0) {
      const afterGen = trySkipGenerics(tokens, match, k, closeP);
      if (afterGen > k) {
        k = afterGen;
        continue;
      }
    } else if (tx === "," && depth === 0) {
      argTypes.push(inferExprRangeType(unit, scope, enclosingType, tokens, match, segStart, k, context.line, context.col));
      segStart = k + 1;
    }
    k += 1;
  }
  argTypes.push(inferExprRangeType(unit, scope, enclosingType, tokens, match, segStart, closeP, context.line, context.col));
  return argTypes;
}

function collectMethodCandidatesOnType(unit, targetType, methodName, context, filePath, opts = {}) {
  const { includeSubtypes = true, staticOnly = false } = opts;
  const wantArity = Number.isFinite(context.arity) ? context.arity : null;
  const wantImpl = context.intent === "implementation";
  const cursorCol = context.tokenCol || context.col || 1;
  const callArgTypes = Array.isArray(context.callArgTypes) ? context.callArgTypes : null;
  const cands = [];
  const seenTypeMethods = new Set();

  const addFromType = (t, baseScore) => {
    for (let i = 0; i < t.methods.length; i += 1) {
      const m = t.methods[i];
      if (m.name !== methodName) continue;
      if (staticOnly && !m.isStatic) continue;
      const key = `${t._qualifiedContainerName}:${m.line}:${m.column}`;
      if (seenTypeMethods.has(key)) continue;
      seenTypeMethods.add(key);

      let score = baseScore;
      if (m.line === context.line && Math.abs(cursorCol - m.column) <= 1) {
        score += 140;
      }
      if (wantArity !== null) {
        if (m.arity === wantArity) score += 60;
        else if (m._hasVarArgs && wantArity >= Math.max(0, m.arity - 1)) score += 45;
        else score -= 15;
      }
      score += scoreJavaMethodParams(m._params, m._hasVarArgs, callArgTypes, unit);
      if (wantImpl && !m.isAbstract) score += 40;
      cands.push(makeMethodCandidate(m, t._qualifiedContainerName, filePath, score, false));
    }
  };

  // Target type & its supertypes (inherited concrete / default / abstract methods)
  const hierarchy = getAllSameFileSupertypes(unit, targetType, true);
  for (let i = 0; i < hierarchy.length; i += 1) {
    addFromType(hierarchy[i], i === 0 ? 110 : 95);
  }

  // Concrete implementations in same file (`implements` / `extends` subtypes)
  if (includeSubtypes && wantImpl) {
    const subtypes = getAllSameFileSubtypes(unit, targetType.name);
    for (let i = 0; i < subtypes.length; i += 1) {
      addFromType(subtypes[i], 130);
    }
  }

  // Fallback to Lombok @Getter/@Data/@Builder or record components if no explicit method found
  if (cands.length === 0) {
    for (let i = 0; i < hierarchy.length; i += 1) {
      const t = hierarchy[i];
      const fields = findLombokOrRecordAccessorFields(t, methodName, wantArity);
      for (let f = 0; f < fields.length; f += 1) {
        cands.push(makeFieldCandidate(fields[f], t._qualifiedContainerName, filePath, 90, false, wantArity));
      }
      if (fields.length === 0 && (methodName === "builder" || methodName === "toBuilder") && (wantArity === 0 || wantArity === null) && hasLombokBuilder(t)) {
        const bCtor = t.constructors.find((c) => (c.annotations || []).includes("Builder"));
        if (bCtor) cands.push(makeConstructorCandidate(bCtor, t, filePath, 100, false));
        else cands.push(makeTypeCandidate(t, filePath, 100));
      }
    }
  }

  return cands;
}

function resolveImportLine(unit, context) {
  const trimmed = (context.lineText || "").trimStart();
  if (trimmed.startsWith("package ")) {
    return {
      resolved: [],
      importHint: null,
      memberTypeHints: [],
      enclosingContainer: null,
    };
  }

  let matchedImp = null;
  for (let i = 0; i < unit.imports.length; i += 1) {
    const imp = unit.imports[i];
    if (imp._stmtLine === context.line || imp.line === context.line) {
      matchedImp = imp;
      break;
    }
  }

  const spec = matchedImp?.qualifiedName || context.importModuleSpec || context.qualifierChain.join(".");
  const parts = spec.replace(/\.\*$/, "").split(".").filter(Boolean);
  const isStatic = Boolean(matchedImp?.isStatic);
  const isWildcard = Boolean(matchedImp?.isWildcard || spec.endsWith(".*"));

  let typeName = parts[parts.length - 1] || null;
  let memberName = null;
  let importedName = matchedImp?.simpleName || typeName;
  let specifier = spec;
  let qualifiedName = spec;
  let isTypeContext = !isStatic;

  if (isStatic) {
    if (isWildcard) {
      typeName = parts[parts.length - 1] || null;
      specifier = parts.join(".");
      importedName = context.symbol || typeName;
      isTypeContext = true;
    } else if (parts.length >= 2) {
      const ownerFqn = parts.slice(0, -1).join(".");
      const ownerSimple = parts[parts.length - 2];
      const staticMember = parts[parts.length - 1];
      if (context.symbol === ownerSimple && context.memberIndex < context.qualifierChain.length - 1) {
        typeName = ownerSimple;
        memberName = null;
        importedName = ownerSimple;
        specifier = ownerFqn;
        qualifiedName = ownerFqn;
        isTypeContext = true;
      } else {
        typeName = ownerSimple;
        memberName = staticMember;
        importedName = staticMember;
        specifier = ownerFqn;
        qualifiedName = spec;
        isTypeContext = false;
      }
    }
  } else if (isWildcard) {
    typeName = null;
    memberName = null;
    importedName = "*";
    specifier = spec;
    qualifiedName = spec;
    isTypeContext = true;
  } else {
    typeName = parts[parts.length - 1] || context.symbol;
    importedName = typeName;
    specifier = spec;
    qualifiedName = spec;
    isTypeContext = true;
  }

  return {
    resolved: [],
    importHint: {
      typeName,
      memberName,
      importedName,
      simpleName: importedName,
      specifier,
      qualifiedName,
      isStatic,
      isWildcard,
      isAnnotation: false,
      isTypeContext,
      arity: null,
      fallbackLine: matchedImp?.line || context.line,
      fallbackColumn: matchedImp?.column || context.col,
    },
    memberTypeHints: [],
    enclosingContainer: null,
  };
}

/**
 * Resolve backward expression right before `.<member>` when `extractNavContext` stopped at `)` or `]`,
 * e.g. `getService().save(o)` or `orderRepo\n  .findById(id)`.
 */
function inferPrecedingDotReceiver(unit, scope, enclosingType, context) {
  const tokIdx = findTokenIndexAt(unit.tokens, context.line, context.col);
  if (tokIdx <= 1) return null;
  const sep = unit.tokens[tokIdx - 1];
  if (sep.text !== "." && sep.text !== "::") return null;

  let endExpr = tokIdx - 1;
  // Walk backward through chained `.foo` or `.foo(...)` or `[idx]`
  const chain = [];
  let cursor = endExpr - 1;
  while (cursor >= 0) {
    const tok = unit.tokens[cursor];
    let isCall = false;
    let arity = null;
    if (tok.text === ")" || tok.text === "]") {
      isCall = tok.text === ")";
      const openIdx = unit.match[cursor];
      if (openIdx < 0 || openIdx === 0) break;
      if (isCall) arity = countCallArityAt(unit.tokens, unit.match, openIdx);
      cursor = openIdx - 1;
      // Optional generic args `<...>` before `(`
      if (cursor >= 0 && unit.tokens[cursor].text === ">") {
        let gDepth = 1;
        let g = cursor - 1;
        while (g >= 0 && gDepth > 0) {
          if (unit.tokens[g].text === ">") gDepth += 1;
          else if (unit.tokens[g].text === "<") gDepth -= 1;
          g -= 1;
        }
        if (gDepth === 0) cursor = g;
      }
    }
    if (cursor >= 0 && unit.tokens[cursor].kind === "ident") {
      chain.unshift({ name: unit.tokens[cursor].text, isCall, arity });
      if (cursor >= 2 && (unit.tokens[cursor - 1].text === "." || unit.tokens[cursor - 1].text === "::")) {
        cursor -= 2;
        continue;
      }
    }
    break;
  }

  if (chain.length === 0) return null;
  const resolved = resolveExprChainType(unit, scope, enclosingType, chain, context.line, context.col);
  return {
    chain,
    typeName: resolved?.typeName || null,
    crossFileChain: resolved?.crossFileChain || null,
    isStaticReceiver: chain.length === 1 && !chain[0].isCall && Boolean(findTypeByName(unit, chain[0].name) || findImportForSymbol(unit, chain[0].name, { isType: true })),
    isSuperReceiver: chain.length === 1 && chain[0].name === "super",
    isThisReceiver: chain.length === 1 && chain[0].name === "this",
  };
}

function resolveReceiverTypes(unit, scope, enclosingType, context) {
  const chain = context.qualifierChain || [];
  const memberIdx = Number(context.memberIndex) || 0;
  if (memberIdx <= 0) {
    const preDot = inferPrecedingDotReceiver(unit, scope, enclosingType, context);
    if (!preDot) return null;
    return {
      types: preDot.typeName ? [preDot.typeName] : [],
      crossFileChain: preDot.crossFileChain || null,
      isThis: preDot.isThisReceiver,
      isSuper: preDot.isSuperReceiver,
      isStatic: preDot.isStaticReceiver,
      packagePrefixFqn: null,
    };
  }

  const recvSteps = chain.slice(0, memberIdx);
  const first = recvSteps[0];

  // Check if receiver is a package-qualified class name like `com.acme.OrderService.create()`
  const firstIsLocal = scope && resolveLocalScopeSymbol(unit, scope, first, context.line, context.col);
  const firstIsField = enclosingType && findFieldInTypeChain(unit, enclosingType, first);
  const firstIsType = findTypeByName(unit, first) || findImportForSymbol(unit, first, { isType: true });

  if (first !== "this" && first !== "super" && !firstIsLocal && !firstIsField && !firstIsType && recvSteps.length >= 2) {
    // Package-qualified reference `a.b.TypeName`
    const lastRecv = recvSteps[recvSteps.length - 1];
    if (isUpperStart(lastRecv) || recvSteps.length >= 2) {
      return {
        types: [lastRecv],
        crossFileChain: null,
        isThis: false,
        isSuper: false,
        isStatic: true,
        packagePrefixFqn: recvSteps.join("."),
      };
    }
  }

  let currentTypes = [];
  let currentGenericArgs = [];
  let isThis = false;
  let isSuper = false;
  let isStatic = false;
  let crossFileChain = null;

  if (first === "this") {
    isThis = memberIdx === 1;
    if (enclosingType) currentTypes = [enclosingType.name];
  } else if (first === "super") {
    isSuper = memberIdx === 1;
    if (enclosingType && enclosingType.extends.length > 0) {
      currentTypes = enclosingType.extends.map(stripGenericSuffix);
    }
  } else if (firstIsLocal) {
    currentTypes = firstIsLocal.typeNames.map(stripGenericSuffix);
    currentGenericArgs = firstIsLocal.genericArgs || [];
  } else if (firstIsField) {
    const fBase = firstIsField._baseTypeName || stripGenericSuffix(firstIsField.typeName);
    currentTypes = fBase ? [fBase] : [];
    currentGenericArgs = firstIsField._genericArgs || [];
  } else if (firstIsType) {
    isStatic = true;
    currentTypes = [first];
  } else if (isUpperStart(first)) {
    isStatic = true;
    currentTypes = [first];
  }

  for (let s = 1; s < recvSteps.length && currentTypes.length > 0; s += 1) {
    const stepName = recvSteps[s];
    const nextTypes = [];
    let stepIsStatic = false;
    let nextGenArgs = [];
    let unresolvedCrossRoot = null;
    for (let ti = 0; ti < currentTypes.length; ti += 1) {
      const curName = currentTypes[ti];
      const tRec = findTypeByName(unit, curName);
      if (!tRec) {
        if (!unresolvedCrossRoot) unresolvedCrossRoot = curName;
        continue;
      }
      const nested = findTypeByName(unit, stepName, tRec);
      if (nested) {
        nextTypes.push(nested.name);
        stepIsStatic = true;
        continue;
      }
      const fld = findFieldInTypeChain(unit, tRec, stepName);
      if (fld && fld.typeName) {
        nextTypes.push(fld._baseTypeName || stripGenericSuffix(fld.typeName));
        nextGenArgs = fld._genericArgs || [];
        continue;
      }
    }
    if (nextTypes.length === 0 && unresolvedCrossRoot) {
      crossFileChain = {
        rootType: stripGenericSuffix(unresolvedCrossRoot),
        rootGenericArgs: [...currentGenericArgs],
        steps: recvSteps.slice(s).map((nm) => ({ name: nm, isCall: false, arity: null })),
      };
      currentTypes = [];
      break;
    }
    currentTypes = nextTypes;
    currentGenericArgs = nextGenArgs;
    isStatic = stepIsStatic;
  }

  // Deduplicate preserving order
  const deduped = [];
  const seen = new Set();
  for (let i = 0; i < currentTypes.length; i += 1) {
    const tName = currentTypes[i];
    if (tName && !seen.has(tName)) {
      seen.add(tName);
      deduped.push(tName);
    }
  }

  return {
    types: deduped,
    genericArgs: currentGenericArgs,
    crossFileChain,
    isThis,
    isSuper,
    isStatic,
    packagePrefixFqn: null,
  };
}

function isTokenAtTypePosition(unit, line, col) {
  const tokIdx = findTokenIndexAt(unit.tokens, line, col);
  if (tokIdx < 0) return false;
  const tok = unit.tokens[tokIdx];
  const next = unit.tokens[tokIdx + 1];
  const prev = tokIdx > 0 ? unit.tokens[tokIdx - 1] : null;
  if (prev && (prev.text === "new" || prev.text === "extends" || prev.text === "implements" || prev.text === "instanceof" || prev.text === "throws" || prev.text === "@")) {
    return true;
  }
  if (next && (next.text === "<" || next.text === "[" || next.text === "..." || (next.kind === "ident" && !STATEMENT_KEYWORDS.has(next.text)))) {
    return true;
  }
  if (next && next.text === "." && unit.tokens[tokIdx + 2]?.text === "class") {
    return true;
  }
  if (next && next.text === "::") {
    return isUpperStart(tok.text);
  }
  return false;
}

/**
 * Resolve symbol navigation candidates and cross-file import hints inside a Java file.
 */
export function resolveInFile(sourceText, contextOrPos, filePath = "") {
  const emptyResult = {
    resolved: [],
    importHint: null,
    memberTypeHints: [],
    enclosingContainer: null,
  };

  if (!isNavSourceWithinLimits(sourceText)) return emptyResult;

  let context = contextOrPos;
  if (!context || !context.symbol) {
    if (contextOrPos && Number.isFinite(Number(contextOrPos.line))) {
      const colVal = contextOrPos.col ?? contextOrPos.column ?? 1;
      context = extractNavContext(sourceText, contextOrPos.line, colVal, filePath || "Main.java");
    } else {
      context = null;
    }
  }
  if (!context || !context.symbol) return emptyResult;

  const lines = Array.isArray(context.lines) ? context.lines : splitCodeLinesExpanded(sourceText);
  const maskedLines = Array.isArray(context.maskedLines)
    ? context.maskedLines
    : maskNonCodeRegions(lines, "java");

  // 1. Click inside an `import ...;` or `package ...;` line (fast path before full parse)
  if (context.isImportLine) {
    const trimmed = (context.lineText || "").trimStart();
    if (trimmed.startsWith("package ")) return emptyResult;
    if (trimmed.startsWith("import ") && trimmed.includes(";")) {
      const singleUnit = parseJavaUnit("", filePath, [lines[context.line - 1] || ""], [maskedLines[context.line - 1] || ""]);
      if (singleUnit.imports.length > 0) {
        singleUnit.imports[0].line = context.line;
        singleUnit.imports[0]._stmtLine = context.line;
        return resolveImportLine(singleUnit, context);
      }
    }
    const importUnit = parseJavaUnit(sourceText, filePath, lines, maskedLines);
    return resolveImportLine(importUnit, context);
  }

  const unit = parseJavaUnit(sourceText, filePath, lines, maskedLines);

  const { enclosingType, enclosingExec, enclosingContainer } = findEnclosingPositionInfo(
    unit,
    context.line,
    context.col
  );

  let scope = null;
  if (enclosingExec) {
    const scopeTree = buildExecutableScopeTree(unit, enclosingExec);
    scope = findInnermostScopeAt(scopeTree, context.line, context.col) || scopeTree;
  }

  const callArgTypes = (!context.isDeclarationSignature && context.isCall)
    ? extractCallArgTypesAtCursor(unit, scope, enclosingType, context)
    : null;
  const evalContext = callArgTypes && !context.callArgTypes
    ? { ...context, callArgTypes }
    : context;

  const symbol = evalContext.symbol;
  const chain = evalContext.qualifierChain || [symbol];
  const memberIdx = Number.isFinite(evalContext.memberIndex) ? evalContext.memberIndex : 0;
  const candidates = [];
  let importHint = null;
  let memberTypeHints = [];

  // 2. Annotation reference (`@Service`, `@RequiredArgsConstructor`, `@Override`, etc.)
  if (evalContext.isAnnotation) {
    const annType = findTypeByName(unit, symbol);
    if (annType && annType.kind === "@interface") {
      candidates.push(makeTypeCandidate(annType, filePath, 150));
    } else {
      const explicitFqn = chain.length > 1 ? chain.join(".") : null;
      importHint = buildExternalHint(unit, symbol, null, {
        isAnnotation: true,
        isTypeContext: true,
        arity: null,
        explicitQualifiedName: explicitFqn,
      });
    }
    return {
      resolved: rankNavCandidates(candidates, evalContext),
      importHint,
      memberTypeHints: [],
      callArgTypes,
      enclosingContainer,
    };
  }

  // 2b. Annotation attribute name (`@Column(name = "...")`, `@Table(name = "...")`)
  if (evalContext.enclosingAnnotation) {
    const annType = findTypeByName(unit, evalContext.enclosingAnnotation);
    if (annType && annType.kind === "@interface") {
      const attrCands = collectMethodCandidatesOnType(unit, annType, symbol, evalContext, filePath, {
        includeSubtypes: false,
        staticOnly: false,
      });
      if (attrCands.length > 0) {
        return {
          resolved: rankNavCandidates(attrCands, evalContext),
          importHint: null,
          memberTypeHints: [],
          callArgTypes,
          enclosingContainer,
        };
      }
      return {
        resolved: [makeTypeCandidate(annType, filePath, 130)],
        importHint: null,
        memberTypeHints: [],
        callArgTypes,
        enclosingContainer,
      };
    }
    importHint = buildExternalHint(unit, evalContext.enclosingAnnotation, symbol, {
      isAnnotation: true,
      isTypeContext: false,
      arity: null,
    });
    return {
      resolved: [],
      importHint,
      memberTypeHints: [],
      callArgTypes,
      enclosingContainer,
    };
  }

  // 3. `this` or `super` keyword directly clicked
  if (symbol === "this") {
    if (enclosingType) {
      if (context.isCall && enclosingType.constructors.length > 0) {
        for (let i = 0; i < enclosingType.constructors.length; i += 1) {
          const c = enclosingType.constructors[i];
          const matchScore = context.arity !== null && c.arity === context.arity ? 150 : 100;
          candidates.push(makeConstructorCandidate(c, enclosingType, filePath, matchScore, true));
        }
      }
      candidates.push(makeTypeCandidate(enclosingType, filePath, context.isCall ? 80 : 140));
    }
    return {
      resolved: rankNavCandidates(candidates, context),
      importHint: null,
      memberTypeHints: enclosingType ? [enclosingType.name] : [],
      enclosingContainer,
    };
  }

  if (symbol === "super") {
    const parentName = enclosingType?.extends?.[0] || null;
    if (parentName) {
      memberTypeHints = [parentName];
      const parentType = findTypeByName(unit, parentName);
      if (parentType) {
        if (context.isCall && parentType.constructors.length > 0) {
          for (let i = 0; i < parentType.constructors.length; i += 1) {
            const c = parentType.constructors[i];
            const matchScore = context.arity !== null && c.arity === context.arity ? 150 : 100;
            candidates.push(makeConstructorCandidate(c, parentType, filePath, matchScore, true));
          }
        }
        candidates.push(makeTypeCandidate(parentType, filePath, context.isCall ? 80 : 140));
      } else {
        importHint = buildExternalHint(unit, parentName, null, {
          isTypeContext: true,
          arity: context.isCall ? context.arity : null,
        });
      }
    }
    return {
      resolved: rankNavCandidates(candidates, context),
      importHint,
      memberTypeHints,
      enclosingContainer,
    };
  }

  // 4. `new ...` constructor expression (`new OrderService(...)`, `new com.acme.OrderService(...)`, `new Outer.Inner(...)`)
  if (context.isNewExpr) {
    if (memberIdx > 0) {
      const recv = resolveReceiverTypes(unit, scope, enclosingType, context);
      if (recv?.packagePrefixFqn) {
        const fqn = `${recv.packagePrefixFqn}.${symbol}`;
        importHint = buildExternalHint(unit, symbol, null, {
          isTypeContext: true,
          arity: context.arity,
          explicitQualifiedName: fqn,
        });
        return {
          resolved: [],
          importHint,
          memberTypeHints: recv.types,
          enclosingContainer,
        };
      }
      if (recv && recv.types.length > 0) {
        memberTypeHints = recv.types;
        const ownerType = findTypeByName(unit, recv.types[0]);
        const nested = ownerType ? findTypeByName(unit, symbol, ownerType) : null;
        if (nested) {
          addConstructorOrTypeCandidates(nested, context, filePath, candidates);
        } else {
          importHint = buildExternalHint(unit, symbol, null, {
            isTypeContext: true,
            arity: context.arity,
          });
        }
        return {
          resolved: rankNavCandidates(candidates, context),
          importHint,
          memberTypeHints,
          enclosingContainer,
        };
      }
    }

    const targetType = findTypeByName(unit, symbol);
    if (targetType) {
      addConstructorOrTypeCandidates(targetType, context, filePath, candidates);
    } else {
      importHint = buildExternalHint(unit, symbol, null, {
        isTypeContext: true,
        arity: context.arity,
      });
    }
    return {
      resolved: rankNavCandidates(candidates, context),
      importHint,
      memberTypeHints: [],
      enclosingContainer,
    };
  }

  // 5. Qualified member access (`this.field`, `super.method`, `repo.save`, `Foo::bar`, `getService().save`, `a.b.c`)
  const recvInfo = resolveReceiverTypes(unit, scope, enclosingType, evalContext);
  if (recvInfo) {
    memberTypeHints = recvInfo.types;

    // Package-qualified external reference `com.acme.Foo` or `com.acme.Util.helper()`
    if (recvInfo.packagePrefixFqn) {
      const fullFqn = `${recvInfo.packagePrefixFqn}.${symbol}`;
      if (isUpperStart(symbol) && !evalContext.isCall) {
        importHint = buildExternalHint(unit, symbol, null, {
          isTypeContext: true,
          explicitQualifiedName: fullFqn,
        });
      } else {
        importHint = buildExternalHint(unit, recvInfo.types[0], symbol, {
          isTypeContext: false,
          arity: evalContext.arity,
          explicitQualifiedName: recvInfo.packagePrefixFqn,
        });
      }
      return {
        resolved: [],
        importHint,
        memberTypeHints,
        callArgTypes,
        enclosingContainer,
      };
    }

    for (let ti = 0; ti < recvInfo.types.length; ti += 1) {
      const recvTypeName = recvInfo.types[ti];
      if (recvTypeName && recvTypeName.startsWith(BUILDER_TYPE_PREFIX)) {
        const realTypeName = recvTypeName.slice(BUILDER_TYPE_PREFIX.length);
        const realType = findTypeByName(unit, realTypeName);
        if (realType) {
          candidates.push(
            ...findJavaSummaryMemberCandidates(realType, symbol, filePath, {
              ...evalContext,
              builderTarget: true,
            })
          );
        }
        continue;
      }

      const recvType = findTypeByName(unit, recvTypeName);

      if (recvType) {
        // Nested type (`Outer.Inner`)
        const nested = findTypeByName(unit, symbol, recvType);
        if (nested && !evalContext.isCall) {
          candidates.push(makeTypeCandidate(nested, filePath, 130));
        }

        if (evalContext.isCall) {
          const methodCands = collectMethodCandidatesOnType(unit, recvType, symbol, evalContext, filePath, {
            includeSubtypes: !recvInfo.isSuper,
            staticOnly: false,
          });
          candidates.push(...methodCands);
        } else {
          const fld = findFieldInTypeChain(unit, recvType, symbol);
          if (fld) {
            candidates.push(makeFieldCandidate(fld, recvType._qualifiedContainerName, filePath, 130, recvInfo.isThis));
          }
          // Non-call method reference `Foo::bar`? Usually `isCall` is true for `::`, fallback just in case
          if (candidates.length === 0) {
            const methodCands = collectMethodCandidatesOnType(unit, recvType, symbol, evalContext, filePath, {
              includeSubtypes: !recvInfo.isSuper,
              staticOnly: false,
            });
            candidates.push(...methodCands);
          }
        }
      }
    }

    const ranked = rankNavCandidates(candidates, evalContext);
    const hasConcrete = ranked.some((c) => !c.isAbstract);

    // If not resolved concretely in same file, check external parents or external/cross-file receiver types
    if (ranked.length === 0 || (evalContext.intent === "implementation" && !hasConcrete)) {
      let extType = null;
      for (let ti = 0; ti < recvInfo.types.length; ti += 1) {
        const rawRecvName = recvInfo.types[ti];
        const recvTypeName = rawRecvName && rawRecvName.startsWith(BUILDER_TYPE_PREFIX)
          ? rawRecvName.slice(BUILDER_TYPE_PREFIX.length)
          : rawRecvName;
        const sameFileRecv = findTypeByName(unit, recvTypeName);
        if (!sameFileRecv) {
          extType = recvTypeName;
          break;
        }
        if (ranked.length === 0) {
          const extParents = collectExternalParents(unit, sameFileRecv);
          if (extParents.length > 0) {
            extType = extParents[0];
            break;
          }
        }
      }
      if (!extType && ranked.length > 0 && ranked[0].isAbstract && recvInfo.types.length > 0) {
        const r0 = recvInfo.types[0];
        extType = r0 && r0.startsWith(BUILDER_TYPE_PREFIX) ? r0.slice(BUILDER_TYPE_PREFIX.length) : r0;
      }
      if (!extType && recvInfo.crossFileChain?.rootType) {
        extType = recvInfo.crossFileChain.rootType;
      }
      if (extType) {
        importHint = buildExternalHint(unit, extType, symbol, {
          isTypeContext: false,
          arity: evalContext.arity,
        });
        if (importHint && recvInfo.crossFileChain) {
          importHint.receiverChain = recvInfo.crossFileChain;
        }
      }
    }

    return {
      resolved: ranked,
      importHint,
      memberTypeHints,
      callArgTypes,
      enclosingContainer,
    };
  }

  // 6. Unqualified `OrderService::new` when clicking `OrderService`
  if (memberIdx === 0 && chain.length >= 2 && chain[1] === "new") {
    const targetType = findTypeByName(unit, symbol);
    if (targetType) {
      addConstructorOrTypeCandidates(targetType, evalContext, filePath, candidates);
    } else {
      importHint = buildExternalHint(unit, symbol, null, { isTypeContext: true, arity: null });
    }
    return {
      resolved: rankNavCandidates(candidates, evalContext),
      importHint,
      memberTypeHints: [],
      callArgTypes,
      enclosingContainer,
    };
  }

  // 7. Unqualified call or method declaration (`helper()`, `getOrderId()`, `public void save(...)`)
  const atTypePos = isTokenAtTypePosition(unit, evalContext.line, evalContext.col);
  if ((evalContext.isCall || evalContext.isDeclarationSignature) && !evalContext.isTypeContext && !atTypePos) {
    // Constructor declaration click (`public OrderService(...)`)
    if (enclosingType && symbol === enclosingType.name && evalContext.isDeclarationSignature) {
      addConstructorOrTypeCandidates(enclosingType, evalContext, filePath, candidates);
      return {
        resolved: rankNavCandidates(candidates, evalContext),
        importHint: null,
        memberTypeHints: [],
        callArgTypes,
        enclosingContainer,
      };
    }

    // Search enclosing class hierarchy (and enclosing outer class if nested)
    let curType = enclosingType;
    let mustBeStatic = Boolean(enclosingExec?.isStatic);
    while (curType) {
      const methodCands = collectMethodCandidatesOnType(unit, curType, symbol, evalContext, filePath, {
        includeSubtypes: true,
        staticOnly: mustBeStatic,
      });
      candidates.push(...methodCands);
      if (candidates.length > 0) break;
      mustBeStatic = mustBeStatic || Boolean(curType._isStaticMember);
      curType = curType._parentType;
    }

    const ranked = rankNavCandidates(candidates, evalContext);
    const hasConcrete = ranked.some((c) => !c.isAbstract);

    if (ranked.length === 0) {
      // Static import (`import static ...`)
      importHint = buildExternalHint(unit, null, symbol, {
        isTypeContext: false,
        arity: evalContext.arity,
      });
      // Or inherited method on external superclass/interface
      if (!importHint && enclosingType) {
        const extParents = collectExternalParents(unit, enclosingType);
        if (extParents.length > 0) {
          importHint = buildExternalHint(unit, extParents[0], symbol, {
            isTypeContext: false,
            arity: evalContext.arity,
          });
        }
      }
    } else if (evalContext.intent === "implementation" && !hasConcrete && enclosingType) {
      // Abstract/interface method declaration in same file with no same-file concrete impl
      importHint = buildExternalHint(unit, enclosingType.name, symbol, {
        isTypeContext: false,
        arity: evalContext.arity,
      });
    }

    return {
      resolved: ranked,
      importHint,
      memberTypeHints: [],
      callArgTypes,
      enclosingContainer,
    };
  }

  // 8. Unqualified variable / parameter / field / type reference
  const forceTypeLookup = Boolean(evalContext.isTypeContext || atTypePos);

  if (!forceTypeLookup) {
    // 8a. Lexical block scopes (innermost -> outer -> parameters)
    if (scope) {
      const localMatch = resolveLocalScopeSymbol(unit, scope, symbol, evalContext.line, evalContext.col);
      if (localMatch) {
        candidates.push(makeLocalCandidate(localMatch.varRec, enclosingContainer, filePath, localMatch.exactScope));
      }
    }

    // 8b. Enclosing class fields (and same-file parents / outer enclosing classes)
    if (candidates.length === 0 && enclosingType) {
      const fld = findFieldInTypeChain(unit, enclosingType, symbol);
      if (fld) {
        candidates.push(makeFieldCandidate(fld, enclosingType._qualifiedContainerName, filePath, 110, false));
      }
    }

    // 8c. Enclosing class methods (e.g. clicking method name on a multi-line signature)
    if (candidates.length === 0 && enclosingType) {
      const methodCands = collectMethodCandidatesOnType(unit, enclosingType, symbol, evalContext, filePath, {
        includeSubtypes: true,
        staticOnly: false,
      });
      candidates.push(...methodCands);
    }
  }

  // 8d. Same-file type declarations
  if (candidates.length === 0) {
    const tRec = findTypeByName(unit, symbol);
    if (tRec) {
      candidates.push(makeTypeCandidate(tRec, filePath, 120));
    }
  }

  // 8e. External import / static constant / same-package hint
  if (candidates.length === 0) {
    const looksLikeType = forceTypeLookup || isUpperStart(symbol);
    if (looksLikeType) {
      importHint = buildExternalHint(unit, symbol, null, {
        isTypeContext: true,
        arity: null,
      });
    } else {
      // Static imported constant (`import static com.acme.Const.MAX;`)
      importHint = buildExternalHint(unit, null, symbol, {
        isTypeContext: false,
        arity: null,
      });
      if (!importHint && enclosingType) {
        const extParents = collectExternalParents(unit, enclosingType);
        if (extParents.length > 0) {
          importHint = buildExternalHint(unit, extParents[0], symbol, {
            isTypeContext: false,
            arity: null,
          });
        }
      }
    }
  }

  return {
    resolved: rankNavCandidates(candidates, evalContext),
    importHint,
    memberTypeHints,
    callArgTypes,
    enclosingContainer,
  };
}

function addConstructorOrTypeCandidates(targetType, context, filePath, candidates) {
  const wantArity = Number.isFinite(context.arity) ? context.arity : null;
  const cursorCol = context.tokenCol || context.col || 1;
  const callArgTypes = Array.isArray(context.callArgTypes) ? context.callArgTypes : null;
  let hasExactArity = false;

  if (targetType.constructors.length > 0) {
    for (let i = 0; i < targetType.constructors.length; i += 1) {
      const c = targetType.constructors[i];
      const selfBonus = c.line === context.line && Math.abs(cursorCol - c.column) <= 1 ? 140 : 0;
      const argScore = scoreJavaMethodParams(c.params, c._hasVarArgs, callArgTypes, null);
      if (wantArity !== null && c.arity === wantArity) {
        hasExactArity = true;
        candidates.push(makeConstructorCandidate(c, targetType, filePath, 150 + selfBonus + argScore, true));
      } else if (wantArity !== null && c._hasVarArgs && wantArity >= Math.max(0, c.arity - 1)) {
        hasExactArity = true;
        candidates.push(makeConstructorCandidate(c, targetType, filePath, 135 + selfBonus + argScore, true));
      } else if (wantArity === null) {
        candidates.push(makeConstructorCandidate(c, targetType, filePath, 130 + selfBonus + argScore, false));
      }
    }
  }

  if (wantArity !== null && !hasExactArity) {
    // Fallback to class/record declaration when no constructor matches arity (e.g. default / Lombok ctor)
    candidates.push(makeTypeCandidate(targetType, filePath, 140));
    for (let i = 0; i < targetType.constructors.length; i += 1) {
      candidates.push(makeConstructorCandidate(targetType.constructors[i], targetType, filePath, 90, false));
    }
  } else {
    candidates.push(makeTypeCandidate(targetType, filePath, targetType.constructors.length === 0 ? 140 : 85));
  }
}
