// Pure zero-UI diff parsing, side-by-side alignment, syntax lexing, and theme palette helpers for git-history.
import { countWrappedLines, wrapPlainText, wrapStyledSpans } from "./code-wrap.js";
import {
  isMarkdownExt,
  createMarkdownState,
  advanceMarkdownState,
} from "./markdown-syntax.js";
import {
  CODE_KEYWORDS,
  EXTRA_DIFF_KEYWORDS,
  CODE_BOOLEANS,
  CODE_CONSTANTS,
  CODE_SPECIAL_VARS,
  CODE_BUILTIN_VARS,
  CODE_TYPES,
  EXTRA_DIFF_TYPES,
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

export const DIFF_KEYWORDS = new Set([...CODE_KEYWORDS, ...EXTRA_DIFF_KEYWORDS]);
export const DIFF_BOOLEANS = CODE_BOOLEANS;
export const DIFF_CONSTANTS = new Set([...CODE_CONSTANTS, "iota"]);
export const DIFF_SPECIAL_VARS = new Set([...CODE_SPECIAL_VARS, "Self"]);
export const DIFF_BUILTIN_VARS = CODE_BUILTIN_VARS;
export const DIFF_TYPES = new Set([...CODE_TYPES, ...EXTRA_DIFF_TYPES]);

export {
  HASH_COMMENT_EXTS,
  SLASH_COMMENT_EXTS,
  MARKUP_EXTS,
  getDiffSyntaxPalette,
  diffSyntaxTokenColor,
};

const UTF8_DECODER = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;
const GIT_ESCAPE_MAP = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

function pushUtf8CodePoint(cp, bytes) {
  if (cp < 0x80) {
    bytes.push(cp);
  } else if (cp < 0x800) {
    bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  } else if (cp >= 0xd800 && cp <= 0xdfff) {
    // Unpaired UTF-16 surrogate -> UTF-8 replacement char U+FFFD
    bytes.push(0xef, 0xbf, 0xbd);
  } else if (cp < 0x10000) {
    bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  } else {
    bytes.push(
      0xf0 | (cp >> 18),
      0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f),
      0x80 | (cp & 0x3f),
    );
  }
}

function decodeUtf8Bytes(bytes) {
  if (UTF8_DECODER) return UTF8_DECODER.decode(new Uint8Array(bytes));
  // Pure-JS UTF-8 decoder fallback for QuickJS runtimes without global TextDecoder
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0 && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) {
      const cp = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      out += cp >= 0x80 ? String.fromCharCode(cp) : "\ufffd";
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0 && i + 2 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
      const cp = ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      out += cp >= 0x800 && (cp < 0xd800 || cp > 0xdfff) ? String.fromCharCode(cp) : "\ufffd";
      i += 3;
    } else if ((b0 & 0xf8) === 0xf0 && i + 3 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80 && (bytes[i + 3] & 0xc0) === 0x80) {
      const cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += cp >= 0x10000 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";
      i += 4;
    } else {
      out += "\ufffd";
      i += 1;
    }
  }
  return out;
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
  let runColor = null;
  let runRaw = "";
  for (let i = 0; i < tokList.length; i++) {
    const tok = tokList[i];
    const txt = tok[1];
    if (!txt) continue;
    const color = diffSyntaxTokenColor(tok[0], palette);
    if (runColor === null) {
      runColor = color;
      runRaw = txt;
    } else if (runColor === color) {
      runRaw += txt;
    } else {
      const nbsp = toNbspString(runRaw);
      if (nbsp) spans.push([runColor, nbsp]);
      runColor = color;
      runRaw = txt;
    }
  }
  if (runColor !== null && runRaw) {
    const nbsp = toNbspString(runRaw);
    if (nbsp) spans.push([runColor, nbsp]);
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

export {
  getFileExt,
  expandCodeTabs,
};

export function tokenizeDiffLine(line, ext, mdState = null) {
  return tokenizeCodeLine(line, ext, mdState, {
    maxLineChars: MAX_DIFF_SYNTAX_LINE_CHARS,
    allowShellVars: true,
    allowSqlLowerKeywords: true,
    extraKeywords: true,
    extraTypes: true,
    includeSelfUpper: true,
    includeIota: true,
  });
}

function unquoteGitPath(raw) {
  const s = String(raw || "");
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  if (inner.indexOf("\\") === -1) return inner;
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\" || i + 1 >= inner.length) {
      const code = inner.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else {
        const cp = inner.codePointAt(i);
        pushUtf8CodePoint(cp, bytes);
        if (cp > 0xffff) i += 1;
      }
      continue;
    }
    const next = inner[++i];
    if (next >= "0" && next <= "7") {
      let oct = next;
      if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") oct += inner[++i];
      if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") oct += inner[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else {
      const code = GIT_ESCAPE_MAP[next];
      if (code !== undefined) {
        bytes.push(code);
      } else {
        const nextCode = next.charCodeAt(0);
        if (nextCode < 0x80) {
          bytes.push(nextCode);
        } else {
          const cp = inner.codePointAt(i);
          pushUtf8CodePoint(cp, bytes);
          if (cp > 0xffff) i += 1;
        }
      }
    }
  }
  return decodeUtf8Bytes(bytes);
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

function sameMdState(a, b) {
  if (!a || !b) return Boolean(a) === Boolean(b);
  return (
    a.inFrontmatter === b.inFrontmatter &&
    a.fence === b.fence &&
    a.fenceLang === b.fenceLang &&
    (a.lineIndex === 0) === (b.lineIndex === 0)
  );
}

function resetMdStateForLine(state, lineNo) {
  state.lineIndex = Math.max(0, lineNo - 1);
  state.inFrontmatter = false;
  state.frontmatterClosed = lineNo > 1;
  state.fence = null;
  state.fenceLang = "";
}

export function tokenizeDeferredRow(row, ext, leftMdState = null, rightMdState = null) {
  if (!row || typeof row !== "object") return row;
  if (row.kind === "pair") {
    const left = row.left;
    const right = row.right;
    if (left && right && left.kind === "ctx" && right.kind === "ctx") {
      if (left._tokPending || right._tokPending) {
        if (left._mdState || right._mdState) {
          let lState = left._mdState ? { ...left._mdState } : null;
          let rState = right._mdState ? { ...right._mdState } : null;
          if (leftMdState && left._mdState) {
            Object.assign(leftMdState, left._mdState);
            lState = leftMdState;
          }
          if (rightMdState && right._mdState) {
            Object.assign(rightMdState, right._mdState);
            rState = rightMdState;
          }
          if (sameMdState(lState, rState)) {
            const toks = tokenizeDiffLine(left.text, ext, lState);
            if (rState && rState !== lState) advanceMarkdownState(left.text, rState);
            left.tokens = toks;
            right.tokens = toks;
          } else {
            left.tokens = tokenizeDiffLine(left.text, ext, lState || leftMdState);
            right.tokens = tokenizeDiffLine(right.text, ext, rState || rightMdState);
          }
          delete left._mdState;
          delete right._mdState;
        } else if (leftMdState || rightMdState) {
          if (sameMdState(leftMdState, rightMdState)) {
            const toks = tokenizeDiffLine(left.text, ext, leftMdState);
            if (rightMdState && rightMdState !== leftMdState) {
              advanceMarkdownState(left.text, rightMdState);
            }
            left.tokens = toks;
            right.tokens = toks;
          } else {
            left.tokens = tokenizeDiffLine(left.text, ext, leftMdState);
            right.tokens = tokenizeDiffLine(right.text, ext, rightMdState);
          }
        } else {
          const toks = tokenizeDiffLine(left.text, ext);
          left.tokens = toks;
          right.tokens = toks;
        }
        left._tokPending = false;
        right._tokPending = false;
      }
      return row;
    }
    if (left && left._tokPending) {
      let st = leftMdState;
      if (left._mdState) {
        if (leftMdState) {
          Object.assign(leftMdState, left._mdState);
          st = leftMdState;
        } else {
          st = { ...left._mdState };
        }
        delete left._mdState;
      }
      left.tokens = tokenizeDiffLine(left.text, ext, st);
      left._tokPending = false;
    }
    if (right && right._tokPending) {
      let st = rightMdState;
      if (right._mdState) {
        if (rightMdState) {
          Object.assign(rightMdState, right._mdState);
          st = rightMdState;
        } else {
          st = { ...right._mdState };
        }
        delete right._mdState;
      }
      right.tokens = tokenizeDiffLine(right.text, ext, st);
      right._tokPending = false;
    }
    return row;
  }
  if (row._tokPending) {
    const baseState = row.kind === "del" ? leftMdState : rightMdState;
    let st = baseState;
    if (row._mdState) {
      if (baseState) {
        Object.assign(baseState, row._mdState);
        st = baseState;
      } else {
        st = { ...row._mdState };
      }
      delete row._mdState;
    }
    row.tokens = tokenizeDiffLine(row.text, ext, st);
    row._tokPending = false;
  }
  return row;
}

export function tokenizeSideBySidePage(rows, ext) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const isMd = isMarkdownExt(ext);
  let leftMdState = null;
  let rightMdState = null;
  if (isMd) {
    leftMdState = createMarkdownState();
    rightMdState = createMarkdownState();
    const first = rows[0];
    if (first?.kind === "pair") {
      if (first.left?.lineNo > 1) {
        leftMdState.lineIndex = first.left.lineNo - 1;
        leftMdState.frontmatterClosed = true;
      }
      if (first.right?.lineNo > 1) {
        rightMdState.lineIndex = first.right.lineNo - 1;
        rightMdState.frontmatterClosed = true;
      }
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (isMd && row?.kind === "hunk") {
      resetMdStateForLine(leftMdState, row.oldStart || 1);
      resetMdStateForLine(rightMdState, row.newStart || 1);
      continue;
    }
    if (isMd && row?.kind === "pair") {
      const leftAlreadyDone = Boolean(row.left && !row.left._tokPending && row.left.kind !== "empty");
      const rightAlreadyDone = Boolean(row.right && !row.right._tokPending && row.right.kind !== "empty");
      if (leftAlreadyDone) {
        if (row.left._mdState) {
          Object.assign(leftMdState, row.left._mdState);
          delete row.left._mdState;
        }
        advanceMarkdownState(row.left.text, leftMdState);
      }
      if (rightAlreadyDone) {
        if (row.right._mdState) {
          Object.assign(rightMdState, row.right._mdState);
          delete row.right._mdState;
        }
        advanceMarkdownState(row.right.text, rightMdState);
      }
      if (leftAlreadyDone && rightAlreadyDone) continue;
    }
    tokenizeDeferredRow(row, ext, leftMdState, rightMdState);
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
  const isMd = isMarkdownExt(ext);
  const deferTokens = Boolean(options?.deferTokens);
  const maxLines = resolveMaxDiffLines(options);
  const rows = [];
  const leftMdState = isMd ? createMarkdownState() : null;
  const rightMdState = isMd ? createMarkdownState() : null;

  let inHunk = false;
  let hunkIndex = 0;
  let oldLine = 0;
  let newLine = 0;
  let totalEmitted = 0;
  let dels = [];
  let adds = [];
  let delCount = 0;
  let addCount = 0;

  const flushChangeBlock = () => {
    const pairCount = Math.max(delCount, addCount);
    if (pairCount === 0) return;
    totalEmitted += pairCount;
    const room = maxLines - rows.length;
    if (room > 0) {
      const take = Math.min(pairCount, room);
      for (let k = 0; k < take; k++) {
        let left;
        if (k < dels.length) {
          const text = expandCodeTabs(dels[k]);
          if (deferTokens) {
            left = { lineNo: oldLine++, text, kind: "del", tokens: null, _tokPending: true };
            if (isMd) {
              if (leftMdState.inFrontmatter || leftMdState.fence) {
                left._mdState = { ...leftMdState };
              }
              advanceMarkdownState(text, leftMdState);
            }
          } else {
            left = { lineNo: oldLine++, text, kind: "del", tokens: tokenizeDiffLine(text, ext, leftMdState) };
          }
        } else {
          left = { lineNo: null, text: "", kind: "empty", tokens: null };
        }
        let right;
        if (k < adds.length) {
          const text = expandCodeTabs(adds[k]);
          if (deferTokens) {
            right = { lineNo: newLine++, text, kind: "add", tokens: null, _tokPending: true };
            if (isMd) {
              if (rightMdState.inFrontmatter || rightMdState.fence) {
                right._mdState = { ...rightMdState };
              }
              advanceMarkdownState(text, rightMdState);
            }
          } else {
            right = { lineNo: newLine++, text, kind: "add", tokens: tokenizeDiffLine(text, ext, rightMdState) };
          }
        } else {
          right = { lineNo: null, text: "", kind: "empty", tokens: null };
        }
        rows.push({ kind: "pair", left, right });
      }
    }
    if (dels.length > 0) dels = [];
    if (adds.length > 0) adds = [];
    delCount = 0;
    addCount = 0;
  };

  const patchLen = patchText.length;
  let pos = 0;
  while (pos <= patchLen) {
    const nl = patchText.indexOf("\n", pos);
    const hasNext = nl !== -1;
    const rawEnd = hasNext ? nl : patchLen;
    const lineEnd = rawEnd > pos && patchText.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    const lineStart = pos;
    pos = hasNext ? nl + 1 : patchLen + 1;

    const lineLen = lineEnd - lineStart;
    if (lineLen === 0 && !hasNext) break;

    const c0 = lineLen > 0 ? patchText.charCodeAt(lineStart) : 0;
    if (c0 === 64 && lineLen >= 10 && patchText.charCodeAt(lineStart + 1) === 64) {
      const line = patchText.slice(lineStart, lineEnd);
      const hunkMatch = HUNK_HEADER_RE.exec(line);
      if (hunkMatch) {
        flushChangeBlock();
        totalEmitted += 1;
        inHunk = true;
        if (rows.length < maxLines) {
          const oldStart = parseInt(hunkMatch[1], 10);
          const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
          const newStart = parseInt(hunkMatch[3], 10);
          const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
          rows.push({
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
          if (isMd) {
            resetMdStateForLine(leftMdState, oldStart);
            resetMdStateForLine(rightMdState, newStart);
          }
        }
        continue;
      }
    }

    if (!inHunk) continue;
    if (c0 === 92) continue;

    if (c0 === 45) {
      if (addCount > 0) flushChangeBlock();
      if (dels.length < maxLines - rows.length) {
        dels.push(patchText.slice(lineStart + 1, lineEnd));
      }
      delCount += 1;
    } else if (c0 === 43) {
      if (adds.length < maxLines - rows.length) {
        adds.push(patchText.slice(lineStart + 1, lineEnd));
      }
      addCount += 1;
    } else if (c0 === 32 || lineLen === 0) {
      flushChangeBlock();
      totalEmitted += 1;
      if (rows.length < maxLines) {
        const text = lineLen === 0 ? "" : expandCodeTabs(patchText.slice(lineStart + 1, lineEnd));
        if (deferTokens) {
          const leftCell = { lineNo: oldLine++, text, kind: "ctx", tokens: null, _tokPending: true };
          const rightCell = { lineNo: newLine++, text, kind: "ctx", tokens: null, _tokPending: true };
          if (isMd) {
            if (leftMdState.inFrontmatter || leftMdState.fence) leftCell._mdState = { ...leftMdState };
            if (rightMdState.inFrontmatter || rightMdState.fence) rightCell._mdState = { ...rightMdState };
            advanceMarkdownState(text, leftMdState);
            advanceMarkdownState(text, rightMdState);
          }
          rows.push({ kind: "pair", left: leftCell, right: rightCell });
        } else if (isMd) {
          if (sameMdState(leftMdState, rightMdState)) {
            const tokens = tokenizeDiffLine(text, ext, leftMdState);
            advanceMarkdownState(text, rightMdState);
            rows.push({
              kind: "pair",
              left: { lineNo: oldLine++, text, kind: "ctx", tokens },
              right: { lineNo: newLine++, text, kind: "ctx", tokens },
            });
          } else {
            rows.push({
              kind: "pair",
              left: { lineNo: oldLine++, text, kind: "ctx", tokens: tokenizeDiffLine(text, ext, leftMdState) },
              right: { lineNo: newLine++, text, kind: "ctx", tokens: tokenizeDiffLine(text, ext, rightMdState) },
            });
          }
        } else {
          const tokens = tokenizeDiffLine(text, ext);
          rows.push({
            kind: "pair",
            left: { lineNo: oldLine++, text, kind: "ctx", tokens },
            right: { lineNo: newLine++, text, kind: "ctx", tokens },
          });
        }
      }
    }
  }
  flushChangeBlock();

  const totalLines = totalEmitted;
  const truncated = totalLines > maxLines;

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
  const isMd = isMarkdownExt(ext);
  const deferTokens = Boolean(options?.deferTokens);
  const maxLines = resolveMaxDiffLines(options);
  const rows = [];
  const oldMdState = isMd ? createMarkdownState() : null;
  const newMdState = isMd ? createMarkdownState() : null;

  let inHunk = false;
  let hunkIndex = 0;
  let oldLine = 0;
  let newLine = 0;
  let totalEmitted = 0;

  const patchLen = patchText.length;
  let pos = 0;
  while (pos <= patchLen) {
    const nl = patchText.indexOf("\n", pos);
    const hasNext = nl !== -1;
    const rawEnd = hasNext ? nl : patchLen;
    const lineEnd = rawEnd > pos && patchText.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    const lineStart = pos;
    pos = hasNext ? nl + 1 : patchLen + 1;

    const lineLen = lineEnd - lineStart;
    if (lineLen === 0 && !hasNext) break;

    const c0 = lineLen > 0 ? patchText.charCodeAt(lineStart) : 0;
    if (c0 === 64 && lineLen >= 10 && patchText.charCodeAt(lineStart + 1) === 64) {
      const line = patchText.slice(lineStart, lineEnd);
      const hunkMatch = HUNK_HEADER_RE.exec(line);
      if (hunkMatch) {
        totalEmitted += 1;
        inHunk = true;
        if (rows.length < maxLines) {
          const oldStart = parseInt(hunkMatch[1], 10);
          const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
          const newStart = parseInt(hunkMatch[3], 10);
          const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
          rows.push({
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
          if (isMd) {
            resetMdStateForLine(oldMdState, oldStart);
            resetMdStateForLine(newMdState, newStart);
          }
        }
        continue;
      }
    }

    if (!inHunk) continue;
    if (c0 === 92) continue;

    if (c0 === 45) {
      totalEmitted += 1;
      if (rows.length < maxLines) {
        const text = expandCodeTabs(patchText.slice(lineStart + 1, lineEnd));
        const row = {
          kind: "del",
          oldLineNo: oldLine++,
          newLineNo: null,
          text,
          tokens: deferTokens ? null : tokenizeDiffLine(text, ext, oldMdState),
          ...(deferTokens ? { _tokPending: true } : {}),
        };
        if (deferTokens && isMd) {
          if (oldMdState.inFrontmatter || oldMdState.fence) row._mdState = { ...oldMdState };
          advanceMarkdownState(text, oldMdState);
        }
        rows.push(row);
      }
    } else if (c0 === 43) {
      totalEmitted += 1;
      if (rows.length < maxLines) {
        const text = expandCodeTabs(patchText.slice(lineStart + 1, lineEnd));
        const row = {
          kind: "add",
          oldLineNo: null,
          newLineNo: newLine++,
          text,
          tokens: deferTokens ? null : tokenizeDiffLine(text, ext, newMdState),
          ...(deferTokens ? { _tokPending: true } : {}),
        };
        if (deferTokens && isMd) {
          if (newMdState.inFrontmatter || newMdState.fence) row._mdState = { ...newMdState };
          advanceMarkdownState(text, newMdState);
        }
        rows.push(row);
      }
    } else if (c0 === 32 || lineLen === 0) {
      totalEmitted += 1;
      if (rows.length < maxLines) {
        const text = lineLen === 0 ? "" : expandCodeTabs(patchText.slice(lineStart + 1, lineEnd));
        let tokens = null;
        let mdSnap = null;
        if (deferTokens) {
          if (isMd) {
            if (newMdState.inFrontmatter || newMdState.fence) mdSnap = { ...newMdState };
            advanceMarkdownState(text, oldMdState);
            advanceMarkdownState(text, newMdState);
          }
        } else {
          if (isMd) advanceMarkdownState(text, oldMdState);
          tokens = tokenizeDiffLine(text, ext, newMdState);
        }
        const row = {
          kind: "ctx",
          oldLineNo: oldLine++,
          newLineNo: newLine++,
          text,
          tokens,
          ...(deferTokens ? { _tokPending: true } : {}),
        };
        if (mdSnap) row._mdState = mdSnap;
        rows.push(row);
      }
    }
  }

  const totalLines = totalEmitted;
  const truncated = totalLines > maxLines;

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

/**
 * Resolves the read-only git object spec (`rev:path`), preview notice, or
 * unavailability reason for rendering a commit file as Markdown.
 */
export function resolveHistoryMarkdownBlobSpec(commit, file) {
  const plan = getDiffMarkdownPlan(typeof file === "string" ? "M" : file?.status);
  const rawPath = typeof file === "string" ? file : (typeof file?.path === "string" ? file.path : "");
  const rawOldPath = typeof file === "string" ? "" : (typeof file?.oldPath === "string" ? file.oldPath : "");
  const filePath = rawPath.trim() ? rawPath : "";
  const oldPath = rawOldPath.trim() ? rawOldPath : "";
  const targetPath = plan.isDeleted ? (oldPath || filePath) : filePath;

  if (!targetPath) {
    return {
      ok: false,
      mode: plan.mode,
      isDeleted: plan.isDeleted,
      rev: "",
      path: "",
      blobSpec: null,
      notice: plan.notice,
      unavailableReason: "Missing file path for Markdown preview",
    };
  }

  const commitHash =
    typeof commit?.hash === "string"
      ? commit.hash.trim()
      : typeof commit?.commitHash === "string"
        ? commit.commitHash.trim()
        : "";
  const rawParents = Array.isArray(commit?.parents)
    ? commit.parents
    : Array.isArray(commit?.parentHashes)
      ? commit.parentHashes
      : [];
  const firstParent = rawParents.find((p) => typeof p === "string" && p.trim())?.trim() || "";

  if (plan.isDeleted) {
    if (!firstParent) {
      return {
        ok: false,
        mode: plan.mode,
        isDeleted: true,
        rev: "",
        path: targetPath,
        blobSpec: null,
        notice: plan.notice,
        unavailableReason: "Deleted file has no parent commit snapshot to preview",
      };
    }
    return {
      ok: true,
      mode: plan.mode,
      isDeleted: true,
      rev: firstParent,
      path: targetPath,
      blobSpec: `${firstParent}:${targetPath}`,
      notice: plan.notice,
      unavailableReason: "",
    };
  }

  if (!commitHash) {
    return {
      ok: false,
      mode: plan.mode,
      isDeleted: false,
      rev: "",
      path: targetPath,
      blobSpec: null,
      notice: "",
      unavailableReason: "Missing commit hash for Markdown preview",
    };
  }

  return {
    ok: true,
    mode: plan.mode,
    isDeleted: false,
    rev: commitHash,
    path: targetPath,
    blobSpec: `${commitHash}:${targetPath}`,
    notice: "",
    unavailableReason: "",
  };
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
