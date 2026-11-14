// Pure dependency-free, single-pass O(n) Markdown syntax tokenizer shared across herdr-mesh mods.

const FENCE_LANG_ALIASES = {
  javascript: "js",
  ecmascript: "js",
  node: "js",
  typescript: "ts",
  python: "py",
  python3: "py",
  py3: "py",
  rust: "rs",
  golang: "go",
  kotlin: "kt",
  csharp: "cs",
  "c#": "cs",
  "c++": "cpp",
  cplusplus: "cpp",
  shell: "sh",
  shellscript: "sh",
  zsh: "zsh",
  bash: "bash",
  ruby: "rb",
  yml: "yaml",
  dockerfile: "dockerfile",
  makefile: "makefile",
  terraform: "tf",
  groovy: "groovy",
  powershell: "ps1",
  pwsh: "ps1",
  markdown: "md",
  text: "txt",
  plaintext: "txt",
  plain: "txt",
  console: "txt",
  output: "txt",
};

const PLAIN_FENCE_LANGS = new Set(["txt", "log", "text", "plaintext", "plain"]);

export function isMarkdownExt(ext) {
  if (typeof ext !== "string" || !ext) return false;
  const lower = ext.toLowerCase();
  return lower === "md" || lower === "mdx";
}

export function createMarkdownState() {
  return {
    lineIndex: 0,
    inFrontmatter: false,
    frontmatterClosed: false,
    fence: null,
    fenceLang: "",
  };
}

export function getMarkdownStateTag(state) {
  if (!state) return "";
  if (state.inFrontmatter) return "fm";
  if (state.fence) return `f:${state.fence}:${state.fenceLang}`;
  return "md";
}

function pushToken(tokens, kind, chunk) {
  if (!chunk) return;
  const last = tokens.length > 0 ? tokens[tokens.length - 1] : null;
  if (last && last[0] === kind) {
    last[1] += chunk;
  } else {
    tokens.push([kind, chunk]);
  }
}

function isHorizWs(ch) {
  return ch === " " || ch === "\t";
}

function isAsciiDigit(ch) {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

function normalizeFenceLang(raw) {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return FENCE_LANG_ALIASES[lower] || lower;
}

function isFrontmatterDelimiter(text) {
  const len = text.length;
  let i = 0;
  while (i < len && isHorizWs(text[i])) i++;
  if (i + 3 > len || text[i] !== "-" || text[i + 1] !== "-" || text[i + 2] !== "-") return false;
  i += 3;
  while (i < len) {
    const ch = text[i];
    if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
    i++;
  }
  return true;
}

function parseFenceOpen(text) {
  const len = text.length;
  let wsEnd = 0;
  while (wsEnd < len && isHorizWs(text[wsEnd])) wsEnd++;
  if (wsEnd + 2 >= len) return null;
  const fenceChar = text[wsEnd];
  if (fenceChar !== "`" && fenceChar !== "~") return null;

  let fenceEnd = wsEnd + 1;
  while (fenceEnd < len && text[fenceEnd] === fenceChar) fenceEnd++;
  if (fenceEnd - wsEnd < 3) return null;

  // CommonMark: backtick fence info strings cannot contain backticks (distinguishes ```inline```).
  if (fenceChar === "`" && text.indexOf("`", fenceEnd) !== -1) return null;

  let infoTextStart = fenceEnd;
  while (infoTextStart < len && isHorizWs(text[infoTextStart])) infoTextStart++;
  let infoTextEnd = len;
  while (infoTextEnd > infoTextStart) {
    const c = text[infoTextEnd - 1];
    if (c === " " || c === "\t" || c === "\r") {
      infoTextEnd--;
    } else {
      break;
    }
  }

  let langEnd = infoTextStart;
  while (langEnd < infoTextEnd) {
    const c = text[langEnd];
    if (c === " " || c === "\t" || c === "\r" || c === "{" || c === "," || c === ";") break;
    langEnd++;
  }
  const rawLang = langEnd > infoTextStart ? text.slice(infoTextStart, langEnd) : "";

  return {
    wsEnd,
    fenceEnd,
    fence: text.slice(wsEnd, fenceEnd),
    infoTextStart,
    infoTextEnd,
    lang: normalizeFenceLang(rawLang),
  };
}

function parseFenceClose(text, activeFence) {
  const len = text.length;
  const fenceChar = activeFence[0];
  const minLen = activeFence.length;
  let wsEnd = 0;
  while (wsEnd < len && isHorizWs(text[wsEnd])) wsEnd++;
  if (wsEnd + minLen > len || text[wsEnd] !== fenceChar) return null;

  let fenceEnd = wsEnd + 1;
  while (fenceEnd < len && text[fenceEnd] === fenceChar) fenceEnd++;
  if (fenceEnd - wsEnd < minLen) return null;

  let k = fenceEnd;
  while (k < len) {
    const c = text[k];
    if (c !== " " && c !== "\t" && c !== "\r") return null;
    k++;
  }
  return { wsEnd, fenceEnd };
}

function emitFenceOpenTokens(text, openInfo) {
  const tokens = [];
  const { wsEnd, fenceEnd, infoTextStart, infoTextEnd } = openInfo;
  if (wsEnd > 0) pushToken(tokens, "plain", text.slice(0, wsEnd));
  pushToken(tokens, "comment", text.slice(wsEnd, fenceEnd));
  if (infoTextEnd > infoTextStart) {
    if (infoTextStart > fenceEnd) pushToken(tokens, "plain", text.slice(fenceEnd, infoTextStart));
    pushToken(tokens, "type", text.slice(infoTextStart, infoTextEnd));
    if (infoTextEnd < text.length) pushToken(tokens, "plain", text.slice(infoTextEnd));
  } else if (fenceEnd < text.length) {
    pushToken(tokens, "plain", text.slice(fenceEnd));
  }
  return tokens;
}

function emitFenceCloseTokens(text, closeInfo) {
  const tokens = [];
  const { wsEnd, fenceEnd } = closeInfo;
  if (wsEnd > 0) pushToken(tokens, "plain", text.slice(0, wsEnd));
  pushToken(tokens, "comment", text.slice(wsEnd, fenceEnd));
  if (fenceEnd < text.length) pushToken(tokens, "plain", text.slice(fenceEnd));
  return tokens;
}

function tokenizeFrontmatterLine(text) {
  const len = text.length;
  let wsEnd = 0;
  while (wsEnd < len && isHorizWs(text[wsEnd])) wsEnd++;
  if (wsEnd >= len || (wsEnd === len - 1 && text[wsEnd] === "\r")) {
    return [["plain", text]];
  }
  if (text[wsEnd] === "#") {
    const tokens = [];
    if (wsEnd > 0) pushToken(tokens, "plain", text.slice(0, wsEnd));
    pushToken(tokens, "comment", text.slice(wsEnd));
    return tokens;
  }
  if (
    text[wsEnd] === "-" &&
    (wsEnd + 1 === len || text[wsEnd + 1] === " " || text[wsEnd + 1] === "\t" || text[wsEnd + 1] === "\r")
  ) {
    const tokens = [];
    if (wsEnd > 0) pushToken(tokens, "plain", text.slice(0, wsEnd));
    pushToken(tokens, "comment", "-");
    if (wsEnd + 1 < len) pushToken(tokens, "plain", text.slice(wsEnd + 1));
    return tokens;
  }

  let colonIdx = -1;
  const first = text[wsEnd];
  if (first !== "[" && first !== "{") {
    if (first === '"' || first === "'") {
      let q = wsEnd + 1;
      while (q < len) {
        if (text[q] === "\\") {
          q += 2;
          continue;
        }
        if (text[q] === first) {
          q++;
          break;
        }
        q++;
      }
      while (q < len && isHorizWs(text[q])) q++;
      if (q < len && text[q] === ":" && (q + 1 === len || text[q + 1] === " " || text[q + 1] === "\t" || text[q + 1] === "\r")) {
        colonIdx = q;
      }
    } else {
      for (let k = wsEnd; k < len; k++) {
        const c = text[k];
        if (c === "#" && (k === wsEnd || isHorizWs(text[k - 1]))) break;
        if (c === ":" && (k + 1 === len || text[k + 1] === " " || text[k + 1] === "\t" || text[k + 1] === "\r")) {
          colonIdx = k;
          break;
        }
      }
    }
  }

  if (colonIdx > wsEnd) {
    let keyEnd = colonIdx;
    while (keyEnd > wsEnd && isHorizWs(text[keyEnd - 1])) keyEnd--;
    if (keyEnd > wsEnd) {
      const tokens = [];
      if (wsEnd > 0) pushToken(tokens, "plain", text.slice(0, wsEnd));
      pushToken(tokens, "type", text.slice(wsEnd, keyEnd));
      if (keyEnd < colonIdx) pushToken(tokens, "plain", text.slice(keyEnd, colonIdx));
      pushToken(tokens, "comment", ":");
      if (colonIdx + 1 < len) pushToken(tokens, "plain", text.slice(colonIdx + 1));
      return tokens;
    }
  }

  return [["plain", text]];
}

function restoreTabsIfLossless(text, delegated) {
  let joined = "";
  for (let i = 0; i < delegated.length; i++) {
    joined += delegated[i][1];
  }
  if (joined === text) return delegated;

  const expanded = text.replace(/\t/g, "    ");
  if (joined !== expanded) return null;

  const out = [];
  let ti = 0;
  let tokIdx = 0;
  let tokOff = 0;

  while (ti < text.length && tokIdx < delegated.length) {
    const tok = delegated[tokIdx];
    const kind = tok[0];
    const val = tok[1];
    if (tokOff >= val.length) {
      tokIdx++;
      tokOff = 0;
      continue;
    }

    if (text[ti] === "\t") {
      // Advance 4 expanded spaces across tokens and emit literal tab under current token kind.
      let need = 4;
      while (need > 0 && tokIdx < delegated.length) {
        const avail = delegated[tokIdx][1].length - tokOff;
        const take = avail < need ? avail : need;
        tokOff += take;
        need -= take;
        if (tokOff >= delegated[tokIdx][1].length) {
          tokIdx++;
          tokOff = 0;
        }
      }
      pushToken(out, kind, "\t");
      ti++;
      continue;
    }

    // Consume contiguous non-tab characters up to next tab or end of current token.
    const nextTab = text.indexOf("\t", ti);
    const nonTabEnd = nextTab === -1 ? text.length : nextTab;
    const remainText = nonTabEnd - ti;
    const remainTok = val.length - tokOff;
    const step = remainText < remainTok ? remainText : remainTok;
    pushToken(out, kind, val.slice(tokOff, tokOff + step));
    ti += step;
    tokOff += step;
    if (tokOff >= val.length) {
      tokIdx++;
      tokOff = 0;
    }
  }

  return out;
}

function tokenizeFencedCodeBody(text, fenceLang, fallbackCodeTokenizer) {
  if (
    typeof fallbackCodeTokenizer === "function" &&
    fenceLang &&
    !isMarkdownExt(fenceLang) &&
    !PLAIN_FENCE_LANGS.has(fenceLang)
  ) {
    const delegated = fallbackCodeTokenizer(text, fenceLang);
    if (Array.isArray(delegated) && delegated.length > 0) {
      if (text.indexOf("\t") === -1) return delegated;
      const restored = restoreTabsIfLossless(text, delegated);
      if (restored) return restored;
    }
  }
  return [["plain", text]];
}

function tryTokenizeHeading(text) {
  const len = text.length;
  let wsEnd = 0;
  while (wsEnd < len && isHorizWs(text[wsEnd])) wsEnd++;
  if (wsEnd >= len || text[wsEnd] !== "#") return null;

  let hashEnd = wsEnd + 1;
  while (hashEnd < len && hashEnd - wsEnd < 7 && text[hashEnd] === "#") hashEnd++;
  const count = hashEnd - wsEnd;
  if (count < 1 || count > 6) return null;

  if (hashEnd < len) {
    const next = text[hashEnd];
    if (next !== " " && next !== "\t" && next !== "\r") return null;
  }

  const tokens = [];
  if (wsEnd > 0) pushToken(tokens, "plain", text.slice(0, wsEnd));
  pushToken(tokens, "keyword", text.slice(wsEnd, hashEnd));

  let afterWsEnd = hashEnd;
  while (afterWsEnd < len && isHorizWs(text[afterWsEnd])) afterWsEnd++;
  if (afterWsEnd > hashEnd) {
    pushToken(tokens, "plain", text.slice(hashEnd, afterWsEnd));
  }
  if (afterWsEnd < len) {
    const rest = text.slice(afterWsEnd);
    const hasTitle = rest !== "\r";
    pushToken(tokens, hasTitle ? "function" : "plain", rest);
  }
  return tokens;
}

function isHorizontalRule(text) {
  const len = text.length;
  let i = 0;
  while (i < len && isHorizWs(text[i])) i++;
  if (i >= len) return false;
  const marker = text[i];
  if (marker !== "-" && marker !== "*" && marker !== "_") return false;

  let count = 0;
  while (i < len) {
    const ch = text[i];
    if (ch === marker) {
      count++;
    } else if (ch !== " " && ch !== "\t" && ch !== "\r") {
      return false;
    }
    i++;
  }
  return count >= 3;
}

function tryTokenizeBlockquote(text) {
  const len = text.length;
  let wsEnd = 0;
  while (wsEnd < len && isHorizWs(text[wsEnd])) wsEnd++;
  if (wsEnd >= len || text[wsEnd] !== ">") return null;

  const tokens = [];
  if (wsEnd > 0) pushToken(tokens, "plain", text.slice(0, wsEnd));

  let i = wsEnd;
  while (i < len && text[i] === ">") {
    const mStart = i;
    while (i < len && text[i] === ">") i++;
    pushToken(tokens, "comment", text.slice(mStart, i));
    const spStart = i;
    while (i < len && isHorizWs(text[i])) i++;
    if (i > spStart) pushToken(tokens, "plain", text.slice(spStart, i));
  }

  if (i < len) {
    scanMarkdownInline(text, i, tokens);
  }
  return tokens;
}

function tryTokenizeList(text) {
  const len = text.length;
  let wsEnd = 0;
  while (wsEnd < len && isHorizWs(text[wsEnd])) wsEnd++;
  if (wsEnd >= len) return null;

  let markerEnd = -1;
  const ch = text[wsEnd];
  if ((ch === "-" || ch === "*" || ch === "+") && wsEnd + 1 < len && isHorizWs(text[wsEnd + 1])) {
    markerEnd = wsEnd + 1;
  } else if (isAsciiDigit(ch)) {
    let dEnd = wsEnd + 1;
    while (dEnd < len && isAsciiDigit(text[dEnd])) dEnd++;
    if (dEnd < len && (text[dEnd] === "." || text[dEnd] === ")") && dEnd + 1 < len && isHorizWs(text[dEnd + 1])) {
      markerEnd = dEnd + 1;
    }
  }
  if (markerEnd < 0) return null;

  let spEnd = markerEnd;
  while (spEnd < len && isHorizWs(text[spEnd])) spEnd++;

  const tokens = [];
  if (wsEnd > 0) pushToken(tokens, "plain", text.slice(0, wsEnd));
  pushToken(tokens, "comment", text.slice(wsEnd, markerEnd));
  pushToken(tokens, "plain", text.slice(markerEnd, spEnd));

  let cursor = spEnd;
  if (
    spEnd + 2 < len &&
    text[spEnd] === "[" &&
    text[spEnd + 2] === "]" &&
    (text[spEnd + 1] === " " || text[spEnd + 1] === "x" || text[spEnd + 1] === "X") &&
    (spEnd + 3 === len || isHorizWs(text[spEnd + 3]) || text[spEnd + 3] === "\r")
  ) {
    pushToken(tokens, text[spEnd + 1] === " " ? "comment" : "constant", text.slice(spEnd, spEnd + 3));
    cursor = spEnd + 3;
    let cbSpEnd = cursor;
    while (cbSpEnd < len && isHorizWs(text[cbSpEnd])) cbSpEnd++;
    if (cbSpEnd > cursor) {
      pushToken(tokens, "plain", text.slice(cursor, cbSpEnd));
      cursor = cbSpEnd;
    }
  }

  if (cursor < len) {
    scanMarkdownInline(text, cursor, tokens);
  }
  return tokens;
}

function findMatchingBacktickRun(text, from, len, tickLen) {
  let p = from;
  while (p < len) {
    const idx = text.indexOf("`", p);
    if (idx < 0) return -1;
    let end = idx + 1;
    while (end < len && text[end] === "`") end++;
    if (end - idx === tickLen) return end;
    p = end;
  }
  return -1;
}

function isHttpAutolinkPrefix(text, start, len) {
  if (start + 7 >= len) return false;
  const p7 = text.slice(start, start + 7).toLowerCase();
  if (p7 === "http://") return true;
  if (start + 8 < len && text.slice(start, start + 8).toLowerCase() === "https://") return true;
  return false;
}

function findAutolinkClose(text, start, len) {
  const minLen = text[start + 4] === "s" || text[start + 4] === "S" ? 8 : 7;
  for (let k = start + minLen; k < len; k++) {
    const c = text[k];
    if (c === ">") return k > start + minLen ? k : -1;
    if (c === " " || c === "\t" || c === "\r" || c === "<") return -1;
  }
  return -1;
}

function buildBracketMatchMap(text, from, len) {
  const map = new Map();
  const stack = [];
  let p = from;
  while (p < len) {
    const c = text[p];
    if (c === "\\" && p + 1 < len) {
      p += 2;
      continue;
    }
    if (c === "`") {
      let openEnd = p + 1;
      while (openEnd < len && text[openEnd] === "`") openEnd++;
      const closeEnd = findMatchingBacktickRun(text, openEnd, len, openEnd - p);
      p = closeEnd > 0 ? closeEnd : openEnd;
      continue;
    }
    if (c === "[") {
      stack.push(p);
    } else if (c === "]" && stack.length > 0) {
      map.set(stack.pop(), p);
    }
    p++;
  }
  return map;
}

function buildParenMatchMap(text, from, len) {
  const map = new Map();
  const stack = [];
  let p = from;
  while (p < len) {
    const c = text[p];
    if (c === "\\" && p + 1 < len) {
      p += 2;
      continue;
    }
    if (c === "(") {
      stack.push(p);
    } else if (c === ")" && stack.length > 0) {
      map.set(stack.pop(), p);
    }
    p++;
  }
  return map;
}

function tryParseLinkAt(text, bracketOpen, len, ctx) {
  if (ctx.noMoreJoins) return null;
  if (text.indexOf("](", bracketOpen + 1) < 0) {
    ctx.noMoreJoins = true;
    return null;
  }

  let bracketClose = -1;
  if (ctx.bracketMap) {
    bracketClose = ctx.bracketMap.get(bracketOpen) ?? -1;
  } else {
    let j = bracketOpen + 1;
    let depth = 1;
    while (j < len) {
      const c = text[j];
      if (c === "\\" && j + 1 < len) {
        j += 2;
        continue;
      }
      if (c === "`") {
        let openEnd = j + 1;
        while (openEnd < len && text[openEnd] === "`") openEnd++;
        const closeEnd = findMatchingBacktickRun(text, openEnd, len, openEnd - j);
        j = closeEnd > 0 ? closeEnd : openEnd;
        continue;
      }
      if (c === "[") {
        depth++;
      } else if (c === "]") {
        depth--;
        if (depth === 0) {
          bracketClose = j;
          break;
        }
      }
      j++;
    }
    if (bracketClose < 0 && j - bracketOpen > 64) {
      ctx.bracketMap = buildBracketMatchMap(text, bracketOpen, len);
      bracketClose = ctx.bracketMap.get(bracketOpen) ?? -1;
    }
  }

  if (bracketClose < 0 || bracketClose + 1 >= len || text[bracketClose + 1] !== "(") {
    return null;
  }

  const parenOpen = bracketClose + 1;
  let parenClose = -1;
  if (ctx.parenMap) {
    parenClose = ctx.parenMap.get(parenOpen) ?? -1;
  } else {
    let k = parenOpen + 1;
    let depth = 1;
    while (k < len) {
      const c = text[k];
      if (c === "\\" && k + 1 < len) {
        k += 2;
        continue;
      }
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) {
          parenClose = k;
          break;
        }
      }
      k++;
    }
    if (parenClose < 0 && k - parenOpen > 64) {
      ctx.parenMap = buildParenMatchMap(text, parenOpen, len);
      parenClose = ctx.parenMap.get(parenOpen) ?? -1;
    }
  }

  if (parenClose < 0) return null;

  return {
    labelStart: bracketOpen + 1,
    labelEnd: bracketClose,
    end: parenClose + 1,
  };
}

function scanMarkdownInline(text, startIdx, tokens) {
  const len = text.length;
  let i = startIdx;
  let plainStart = startIdx;
  let noCloseTickLens = null;
  const linkCtx = { noMoreJoins: false, bracketMap: null, parenMap: null };

  const flushPlain = (end) => {
    if (end > plainStart) {
      pushToken(tokens, "plain", text.slice(plainStart, end));
    }
    plainStart = end;
  };

  while (i < len) {
    const ch = text[i];

    // Escaped punctuation (\*, \`, \[, \], \\, \<, \!, etc.) stays plain.
    if (ch === "\\" && i + 1 < len) {
      i += 2;
      continue;
    }

    // Inline code spans (`...` or ``...``) without code-keyword lexing inside.
    if (ch === "`") {
      let openEnd = i + 1;
      while (openEnd < len && text[openEnd] === "`") openEnd++;
      const tickLen = openEnd - i;
      let closeEnd = -1;
      if (!noCloseTickLens || !noCloseTickLens.has(tickLen)) {
        closeEnd = findMatchingBacktickRun(text, openEnd, len, tickLen);
        if (closeEnd < 0) {
          if (!noCloseTickLens) noCloseTickLens = new Set();
          noCloseTickLens.add(tickLen);
        }
      }
      if (closeEnd > 0) {
        flushPlain(i);
        pushToken(tokens, "string", text.slice(i, closeEnd));
        i = plainStart = closeEnd;
        continue;
      }
      i = openEnd;
      continue;
    }

    // HTML comments (<!-- ... -->) and autolinks (<https://...> / <http://...>).
    if (ch === "<") {
      if (text.startsWith("<!--", i)) {
        flushPlain(i);
        const close = text.indexOf("-->", i + 4);
        const end = close >= 0 ? close + 3 : len;
        pushToken(tokens, "comment", text.slice(i, end));
        i = plainStart = end;
        continue;
      }
      if (isHttpAutolinkPrefix(text, i + 1, len)) {
        const close = findAutolinkClose(text, i + 1, len);
        if (close > 0) {
          flushPlain(i);
          pushToken(tokens, "function", text.slice(i, close + 1));
          i = plainStart = close + 1;
          continue;
        }
      }
    }

    // Images (![alt](url))
    if (ch === "!" && i + 1 < len && text[i + 1] === "[") {
      const parsed = tryParseLinkAt(text, i + 1, len, linkCtx);
      if (parsed) {
        flushPlain(i);
        pushToken(tokens, "comment", "![");
        if (parsed.labelEnd > parsed.labelStart) {
          pushToken(tokens, "function", text.slice(parsed.labelStart, parsed.labelEnd));
        }
        pushToken(tokens, "comment", text.slice(parsed.labelEnd, parsed.end));
        i = plainStart = parsed.end;
        continue;
      }
      i += 2;
      continue;
    }

    // Links ([label](url))
    if (ch === "[") {
      const parsed = tryParseLinkAt(text, i, len, linkCtx);
      if (parsed) {
        flushPlain(i);
        pushToken(tokens, "comment", "[");
        if (parsed.labelEnd > parsed.labelStart) {
          pushToken(tokens, "function", text.slice(parsed.labelStart, parsed.labelEnd));
        }
        pushToken(tokens, "comment", text.slice(parsed.labelEnd, parsed.end));
        i = plainStart = parsed.end;
        continue;
      }
      i += 1;
      continue;
    }

    i++;
  }

  flushPlain(len);
  return tokens;
}

export function advanceMarkdownState(text, state) {
  if (!state) return state;
  const lineIdx = state.lineIndex++;
  if (!text) return state;

  if (lineIdx === 0 && !state.frontmatterClosed && !state.inFrontmatter && !state.fence) {
    if (isFrontmatterDelimiter(text)) {
      state.inFrontmatter = true;
    }
    return state;
  }
  if (state.inFrontmatter) {
    if (isFrontmatterDelimiter(text)) {
      state.inFrontmatter = false;
      state.frontmatterClosed = true;
    }
    return state;
  }
  if (state.fence) {
    if (parseFenceClose(text, state.fence)) {
      state.fence = null;
      state.fenceLang = "";
    }
    return state;
  }
  const openInfo = parseFenceOpen(text);
  if (openInfo) {
    state.fence = openInfo.fence;
    state.fenceLang = openInfo.lang;
  }
  return state;
}

export function tokenizeMarkdownLine(text, state = null, fallbackCodeTokenizer = null) {
  if (!text) {
    if (state) state.lineIndex += 1;
    return null;
  }

  const lineIdx = state ? state.lineIndex++ : -1;

  // 1. YAML Frontmatter (--- on lineIndex === 0 until closing ---)
  if (state) {
    if (lineIdx === 0 && !state.frontmatterClosed && !state.inFrontmatter && !state.fence) {
      if (isFrontmatterDelimiter(text)) {
        state.inFrontmatter = true;
        return [["comment", text]];
      }
    } else if (state.inFrontmatter) {
      if (isFrontmatterDelimiter(text)) {
        state.inFrontmatter = false;
        state.frontmatterClosed = true;
        return [["comment", text]];
      }
      return tokenizeFrontmatterLine(text);
    }
  }

  // 2. Active fenced code block body / closing fence
  if (state && state.fence) {
    const closeInfo = parseFenceClose(text, state.fence);
    if (closeInfo) {
      state.fence = null;
      state.fenceLang = "";
      return emitFenceCloseTokens(text, closeInfo);
    }
    return tokenizeFencedCodeBody(text, state.fenceLang, fallbackCodeTokenizer);
  }

  // Opening fenced code block line (```lang or ~~~lang)
  const openInfo = parseFenceOpen(text);
  if (openInfo) {
    if (state) {
      state.fence = openInfo.fence;
      state.fenceLang = openInfo.lang;
    }
    return emitFenceOpenTokens(text, openInfo);
  }

  // 3. ATX Headings (^\s*#{1,6}(\s|$))
  const headingTokens = tryTokenizeHeading(text);
  if (headingTokens) return headingTokens;

  // 4. Horizontal Rules (---, ***, ___)
  if (isHorizontalRule(text)) {
    return [["comment", text]];
  }

  // 5. Blockquotes (^\s*>+)
  const quoteTokens = tryTokenizeBlockquote(text);
  if (quoteTokens) return quoteTokens;

  // 6. Lists & Task Checkboxes
  const listTokens = tryTokenizeList(text);
  if (listTokens) return listTokens;

  // 7. Inline Markdown prose
  const tokens = [];
  scanMarkdownInline(text, 0, tokens);
  return tokens;
}
