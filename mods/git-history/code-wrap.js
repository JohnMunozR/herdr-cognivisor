// Shared soft line-wrapping engine for Herdr Cognivisor viewers (Node + QuickJS).
// Canonical source: shared/code-wrap.js -> synced to mods/{files-search,changes-review,git-history}/code-wrap.js.

export const DEFAULT_TAB_SIZE = 4;

/**
 * Compute usable monospace columns for a viewer viewport.
 */
export function computeWrapColumns(options = {}) {
  const {
    viewportWidth = 0,
    gutterWidth = 0,
    rightPadding = 18,
    fontSize = 11.5,
    charPx,
    minCols = 8,
    maxCols = Number.POSITIVE_INFINITY,
    fallbackCols = 88,
  } = options || {};

  const upperBound = Number.isFinite(maxCols) && maxCols >= 1 ? Math.floor(maxCols) : Number.POSITIVE_INFINITY;
  const lowerBound = Math.max(1, Math.min(upperBound, Math.floor(minCols || 1)));
  const vp = Number(viewportWidth);
  if (!Number.isFinite(vp) || vp <= 0) {
    return Math.max(lowerBound, Math.min(upperBound, Math.floor(fallbackCols || 88)));
  }

  const effectiveCharPx =
    Number.isFinite(charPx) && charPx > 0
      ? charPx
      : Math.max(6.0, Number(fontSize || 11.5) * 0.64);
  const usable = Math.max(0, vp - Number(gutterWidth || 0) - Number(rightPadding || 0));
  const rawCols = Math.floor(usable / effectiveCharPx);
  return Math.max(lowerBound, Math.min(upperBound, rawCols));
}

function applyNbsp(text, toNbsp) {
  if (!toNbsp || !text || text.indexOf(" ") === -1) return text;
  return text.replace(/ /g, "\u00a0");
}

function isWrapPunctuationCode(code) {
  switch (code) {
    case 44:  // ','
    case 59:  // ';'
    case 41:  // ')'
    case 93:  // ']'
    case 125: // '}'
    case 46:  // '.'
    case 47:  // '/'
    case 58:  // ':'
    case 61:  // '='
    case 38:  // '&'
    case 124: // '|'
    case 63:  // '?'
      return true;
    default:
      return false;
  }
}

/**
 * Advance through UTF-16 string from `startIdx` for at most `maxCols` code points.
 * Never splits UTF-16 surrogate pairs and always advances at least 1 code point if `startIdx < str.length`.
 */
export function codeUnitEndForColumns(str, startIdx, maxCols) {
  const len = str.length;
  const limit = maxCols >= 1 ? (maxCols | 0) || Math.floor(maxCols) : 1;
  if (startIdx + limit >= len) return len;

  let idx = startIdx;
  let cols = 0;

  while (idx < len && cols < limit) {
    const code = str.charCodeAt(idx);
    if (code >= 0xd800 && code <= 0xdbff && idx + 1 < len) {
      const next = str.charCodeAt(idx + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        idx += 2;
        cols += 1;
        continue;
      }
    }
    idx += 1;
    cols += 1;
  }
  return idx;
}

const TAB_SPACES_CACHE = ["", " ", "  ", "   ", "    ", "     ", "      ", "       ", "        "];

function padSpaces(count) {
  return count < TAB_SPACES_CACHE.length ? TAB_SPACES_CACHE[count] : " ".repeat(count);
}

/**
 * Expand tabs cleanly using `tabSize` stops from an initial visual column, stripping stray CRs.
 */
export function expandTabsFromColumn(text, startCol = 0, tabSize = DEFAULT_TAB_SIZE) {
  const raw = text == null ? "" : String(text);
  const size = Math.max(1, Math.floor(tabSize || DEFAULT_TAB_SIZE));
  let col = Math.max(0, Math.floor(startCol || 0));
  const len = raw.length;

  if (raw.indexOf("\t") === -1 && raw.indexOf("\r") === -1) {
    let i = 0;
    while (i < len) {
      const code = raw.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
        const next = raw.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          i += 2;
          col += 1;
          continue;
        }
      }
      i += 1;
      col += 1;
    }
    return { text: raw, endCol: col };
  }

  let out = "";
  let chunkStart = 0;
  let i = 0;
  while (i < len) {
    const code = raw.charCodeAt(i);
    if (code === 13) {
      if (i > chunkStart) out += raw.slice(chunkStart, i);
      i += 1;
      chunkStart = i;
      continue;
    }
    if (code === 9) {
      if (i > chunkStart) out += raw.slice(chunkStart, i);
      const spaces = size - (col % size);
      out += padSpaces(spaces);
      col += spaces;
      i += 1;
      chunkStart = i;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const next = raw.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        col += 1;
        i += 2;
        continue;
      }
    }
    col += 1;
    i += 1;
  }
  if (chunkStart < len) {
    out += chunkStart === 0 ? raw : raw.slice(chunkStart);
  }
  return { text: out, endCol: col };
}

export function expandTabs(text, tabSize = DEFAULT_TAB_SIZE) {
  const raw = text == null ? "" : String(text);
  if (raw.indexOf("\t") === -1 && raw.indexOf("\r") === -1) return raw;
  return expandTabsFromColumn(raw, 0, tabSize).text;
}

/**
 * Choose a clean split offset <= `hardEndIdx` inside `[startIdx + 1, hardEndIdx]`.
 * Prefers breaking after whitespace, then after separator punctuation, while keeping reasonable line fill.
 */
function chooseSplitIndex(str, startIdx, hardEndIdx) {
  if (hardEndIdx >= str.length) return str.length;
  const spanLen = hardEndIdx - startIdx;
  if (spanLen <= 4) return hardEndIdx;

  // Keep at least half the line width filled so leading indentation doesn't force tiny fragments.
  const minSplit = startIdx + Math.max(2, Math.floor(spanLen * 0.45));

  for (let i = hardEndIdx - 1; i >= minSplit - 1; i -= 1) {
    const code = str.charCodeAt(i);
    if (code === 32 || code === 160) {
      return i + 1;
    }
  }

  for (let i = hardEndIdx - 1; i >= minSplit; i -= 1) {
    if (isWrapPunctuationCode(str.charCodeAt(i)) && i + 1 <= hardEndIdx && i + 1 > startIdx) {
      return i + 1;
    }
  }

  return hardEndIdx;
}

/**
 * Compute `[start, end]` code-unit ranges wrapping `expanded` cleanly within `maxCols`.
 */
export function computeWrapRanges(expanded, maxCols) {
  const limit = Math.max(1, Math.floor(maxCols || 1));
  if (!expanded) return [[0, 0]];
  if (expanded.length <= limit) return [[0, expanded.length]];

  const ranges = [];
  let cursor = 0;
  const len = expanded.length;
  while (cursor < len) {
    const hardEnd = codeUnitEndForColumns(expanded, cursor, limit);
    const splitEnd = hardEnd >= len ? len : chooseSplitIndex(expanded, cursor, hardEnd);
    const safeEnd = splitEnd > cursor ? splitEnd : hardEnd;
    ranges.push([cursor, safeEnd]);
    cursor = safeEnd;
  }
  return ranges.length > 0 ? ranges : [[0, 0]];
}

/**
 * Count visual wrapped lines for `text` without allocating range arrays or substring slices.
 */
export function countWrappedLines(text, maxCols, tabSize = DEFAULT_TAB_SIZE) {
  const limit = Math.max(1, Math.floor(maxCols || 1));
  const raw = text == null ? "" : String(text);
  if (!raw) return 1;
  const hasTabOrCr = raw.indexOf("\t") !== -1 || raw.indexOf("\r") !== -1;
  if (!hasTabOrCr && raw.length <= limit) return 1;

  const expanded = hasTabOrCr ? expandTabsFromColumn(raw, 0, tabSize).text : raw;
  const len = expanded.length;
  if (len === 0 || len <= limit) return 1;

  let lines = 0;
  let cursor = 0;
  while (cursor < len) {
    const hardEnd = codeUnitEndForColumns(expanded, cursor, limit);
    const splitEnd = hardEnd >= len ? len : chooseSplitIndex(expanded, cursor, hardEnd);
    const safeEnd = splitEnd > cursor ? splitEnd : hardEnd;
    lines += 1;
    cursor = safeEnd;
  }
  return lines > 0 ? lines : 1;
}

/**
 * Soft-wrap plain code text into an array of display line strings (never drops characters).
 */
export function wrapPlainText(text, maxCols, options = {}) {
  const { tabSize = DEFAULT_TAB_SIZE, toNbsp = false } = options || {};
  const limit = Math.max(1, Math.floor(maxCols || 1));
  const raw = text == null ? "" : String(text);

  if (!raw) return [""];
  if (raw.length <= limit && !raw.includes("\t") && !raw.includes("\r")) {
    return [applyNbsp(raw, toNbsp)];
  }

  const expanded = expandTabsFromColumn(raw, 0, tabSize).text;
  if (!expanded) return [""];

  const ranges = computeWrapRanges(expanded, limit);
  const out = new Array(ranges.length);
  for (let i = 0; i < ranges.length; i += 1) {
    const [start, end] = ranges[i];
    out[i] = applyNbsp(expanded.slice(start, end), toNbsp);
  }
  return out;
}

function makeSpanSlice(template, sliceText, sliceColDelta = 0) {
  if (Array.isArray(template)) {
    const next = template.slice();
    next[1] = sliceText;
    if (sliceColDelta > 0 && next.length > 2 && next[2] && typeof next[2] === "object" && Number.isFinite(next[2].col)) {
      next[2] = { ...next[2], col: next[2].col + sliceColDelta };
    }
    return next;
  }
  if (sliceColDelta > 0 && template && typeof template === "object" && Number.isFinite(template.col)) {
    return { ...template, text: sliceText, col: template.col + sliceColDelta };
  }
  return { ...template, text: sliceText };
}

/**
 * Soft-wrap syntax-highlighted or styled spans into visual rows while preserving styling cleanly.
 * Supports both `[kindOrColor, text]` tuples and `{ text, ...style }` objects.
 */
export function wrapStyledSpans(spans, maxCols, options = {}) {
  const { tabSize = DEFAULT_TAB_SIZE, toNbsp = false } = options || {};
  const limit = Math.max(1, Math.floor(maxCols || 1));

  if (!Array.isArray(spans) || spans.length === 0) {
    return [[]];
  }

  if (spans.length === 1) {
    const span = spans[0];
    const isTuple = Array.isArray(span);
    const rawText = isTuple
      ? (span[1] == null ? "" : String(span[1]))
      : (span?.text == null ? "" : String(span.text));
    if (!rawText) return [[]];
    const needsExpandSingle = rawText.indexOf("\t") !== -1 || rawText.indexOf("\r") !== -1;
    const expanded = needsExpandSingle ? expandTabsFromColumn(rawText, 0, tabSize).text : rawText;
    if (!expanded) return [[]];
    if (expanded.length <= limit) {
      const nbsp = toNbsp && expanded.indexOf(" ") !== -1 ? applyNbsp(expanded, true) : expanded;
      if (!needsExpandSingle && nbsp === rawText) {
        return [[span]];
      }
      return [[makeSpanSlice(span, nbsp)]];
    }
    const ranges = computeWrapRanges(expanded, limit);
    const rows = new Array(ranges.length);
    for (let r = 0; r < ranges.length; r += 1) {
      const [s, e] = ranges[r];
      const slice = expanded.slice(s, e);
      rows[r] = [makeSpanSlice(span, toNbsp ? applyNbsp(slice, true) : slice, s)];
    }
    return rows;
  }

  let fastTotalChars = 0;
  let needsExpand = false;
  let hasAnyContent = false;
  let hasEmptySpan = false;
  let hasAnySpace = false;
  const spanCount = spans.length;

  for (let i = 0; i < spanCount; i += 1) {
    const span = spans[i];
    const rawText = Array.isArray(span)
      ? (span[1] == null ? "" : String(span[1]))
      : (span?.text == null ? "" : String(span.text));
    if (rawText.length > 0) hasAnyContent = true;
    else hasEmptySpan = true;
    fastTotalChars += rawText.length;
    if (!needsExpand && (rawText.indexOf("\t") !== -1 || rawText.indexOf("\r") !== -1)) {
      needsExpand = true;
    }
    if (toNbsp && !hasAnySpace && rawText.indexOf(" ") !== -1) {
      hasAnySpace = true;
    }
  }

  if (!hasAnyContent) {
    return [[]];
  }

  // Zero-wrap fast path when expanded code units fit inside `limit`.
  if (!needsExpand && fastTotalChars <= limit) {
    if (!hasEmptySpan && (!toNbsp || !hasAnySpace)) {
      return [spans.slice()];
    }
    const singleRow = [];
    for (let i = 0; i < spanCount; i += 1) {
      const span = spans[i];
      const rawText = Array.isArray(span)
        ? (span[1] == null ? "" : String(span[1]))
        : (span?.text == null ? "" : String(span.text));
      if (!rawText) continue;
      if (toNbsp && rawText.indexOf(" ") !== -1) {
        singleRow.push(makeSpanSlice(span, applyNbsp(rawText, true)));
      } else {
        singleRow.push(span);
      }
    }
    return [singleRow.length > 0 ? singleRow : []];
  }

  let col = 0;
  let flat = "";
  const expandedOffsets = [];
  for (let i = 0; i < spanCount; i += 1) {
    const span = spans[i];
    const rawText = Array.isArray(span)
      ? (span[1] == null ? "" : String(span[1]))
      : (span?.text == null ? "" : String(span.text));
    if (!rawText) continue;
    let expText = rawText;
    if (needsExpand) {
      const expanded = expandTabsFromColumn(rawText, col, tabSize);
      expText = expanded.text;
      col = expanded.endCol;
      if (!expText) continue;
    }
    const start = flat.length;
    flat += expText;
    expandedOffsets.push({ span, text: expText, start, end: flat.length });
  }

  if (!flat) return [[]];

  const ranges = computeWrapRanges(flat, limit);
  if (ranges.length === 1) {
    const singleRow = new Array(expandedOffsets.length);
    for (let i = 0; i < expandedOffsets.length; i += 1) {
      const item = expandedOffsets[i];
      singleRow[i] = makeSpanSlice(item.span, toNbsp ? applyNbsp(item.text, true) : item.text);
    }
    return [singleRow];
  }

  const rows = new Array(ranges.length);
  let spanIdx = 0;
  const offLen = expandedOffsets.length;
  for (let r = 0; r < ranges.length; r += 1) {
    const [segStart, segEnd] = ranges[r];
    const rowSpans = [];
    while (spanIdx < offLen && expandedOffsets[spanIdx].end <= segStart) {
      spanIdx += 1;
    }
    let k = spanIdx;
    while (k < offLen && expandedOffsets[k].start < segEnd) {
      const item = expandedOffsets[k];
      const sliceStart = Math.max(0, segStart - item.start);
      const sliceEnd = Math.min(item.text.length, segEnd - item.start);
      if (sliceEnd > sliceStart) {
        const piece = (sliceStart === 0 && sliceEnd === item.text.length)
          ? item.text
          : item.text.slice(sliceStart, sliceEnd);
        rowSpans.push(makeSpanSlice(item.span, toNbsp ? applyNbsp(piece, true) : piece, sliceStart));
      }
      if (item.end <= segEnd) {
        k += 1;
      } else {
        break;
      }
    }
    rows[r] = rowSpans;
    spanIdx = k;
  }

  return rows;
}
