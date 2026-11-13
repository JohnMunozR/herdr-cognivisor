// Pure helper logic for files-search: fuzzy scoring, directory-aware query ranking, text-search parsing, and git header parsing.

export const MAX_FILE_RESULTS = 50;
export const MAX_EMPTY_FILES = 30;
export const MAX_TEXT_RESULTS = 35;
export const FILE_SEARCH_CHUNK = 1200;
export const FILE_SEARCH_BUDGET_MS = 6;

export function escapeRegexStr(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function repoMatchesTranscript(service, files, transcript) {
  if (!transcript) return false;
  const normRoot = String(service.root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (normRoot && transcript.includes(normRoot)) return true;
  if (service.relPath && service.relPath.length >= 2) {
    const relRe = new RegExp(`(?:^|[\\s"'\`(:\\/])${escapeRegexStr(service.relPath)}/`);
    if (relRe.test(transcript)) return true;
  }
  if (service.name && service.name.length >= 3) {
    const nameRe = new RegExp(`(?:^|[\\s"'\`(:\\/])${escapeRegexStr(service.name)}/`);
    if (nameRe.test(transcript)) return true;
  }
  for (const f of files || []) {
    if (f?.name && f.name.length >= 5 && transcript.includes(f.name)) return true;
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

export function parseSearchOutputLines(stdout, q, prefix = "", cap = MAX_TEXT_RESULTS, out = []) {
  if (!stdout || out.length >= cap) return out;
  const lowerQ = q ? q.toLowerCase() : "";
  let start = 0;
  const len = stdout.length;
  while (start < len && out.length < cap) {
    let nl = stdout.indexOf("\n", start);
    if (nl === -1) nl = len;
    const rawLine = stdout.slice(start, nl);
    start = nl + 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) continue;
    const m = line.match(/^([^:]+):(\d+):(?:(\d+):)?(.*)$/);
    if (!m) continue;
    let normRel = m[1];
    if (normRel.indexOf("\\") !== -1) normRel = normRel.replace(/\\/g, "/");
    if (normRel.startsWith("./")) normRel = normRel.slice(2);
    let content = m[4].trim();
    if (content.length > 260) {
      const idx = lowerQ ? content.toLowerCase().indexOf(lowerQ) : -1;
      if (idx > 140) {
        const sliceStart = Math.max(0, idx - 60);
        content = (sliceStart > 0 ? "…" : "") + content.slice(sliceStart, sliceStart + 240) + "…";
      } else {
        content = content.slice(0, 240) + "…";
      }
    }
    out.push({
      kind: "text",
      path: prefix ? `${prefix}${normRel}` : normRel,
      line: parseInt(m[2], 10),
      content,
      matchedQuery: q,
    });
  }
  return out;
}

// Fast zero-allocation subsequence scorer matching fuzzy()'s ranking weights.
export function scoreSubseqFast(lower, qChars, qLen) {
  if (qLen >= 3 && lower.indexOf(qChars[qLen - 1]) === -1) return -Infinity;
  let score = 0;
  let at = 0;
  let run = 0;
  let matchedAny = false;
  for (let j = 0; j < qLen; j++) {
    const i = lower.indexOf(qChars[j], at);
    if (i < 0) return -Infinity;
    let start = i === 0;
    if (!start) {
      const prev = lower.charCodeAt(i - 1);
      start = prev === 47 || prev === 92 || prev === 95 || prev === 45 || prev === 46 || prev === 32 || prev === 58 || prev === 9;
    }
    run = matchedAny && i === at ? run + 1 : 0;
    matchedAny = true;
    const gap = i - at;
    score += 1 + (start ? 6 : 0) + run * 3 - (gap < 6 ? gap : 6) * 0.3;
    at = i + 1;
  }
  return score - lower.length * 0.02;
}

// Fuzzy score and hit indices for file matching (run on top winning rows).
export function fuzzy(q, text) {
  const t = text.toLowerCase();
  let score = 0, at = 0, run = 0;
  const hits = [];
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || /[\s:.\-_/]/.test(t[i - 1]);
    run = i === at && hits.length ? run + 1 : 0;
    score += 1 + (start ? 6 : 0) + run * 3 - Math.min(i - at, 6) * 0.3;
    hits.push(i);
    at = i + 1;
  }
  return { score: score - text.length * 0.02, hits };
}

export function prepareSearchQuery(rawQuery) {
  const rawQ = String(rawQuery || "").trim().toLowerCase();
  const q = rawQ.replace(/\s+/g, "");
  if (!q) return null;
  const qChars = Array.from(q);
  const qEndsSlash = q.endsWith("/") && q.length > 1;
  const dirQ = qEndsSlash ? q.slice(0, -1) : q;
  return {
    q,
    qChars,
    qLen: qChars.length,
    qEndsSlash,
    dirQ,
    hasSlash: q.indexOf("/") !== -1,
    dirHasSlash: dirQ.indexOf("/") !== -1,
    matchKey: qEndsSlash ? dirQ : q,
  };
}

export function scoreIndexEntry(entry, qs) {
  const isDir = entry.kind === "dir";
  const useEndsSlash = isDir && qs.qEndsSlash;
  const useChars = qs.qChars;
  const useLen = qs.qLen;
  const useHasSlash = isDir ? qs.dirHasSlash : qs.hasSlash;
  let score = -Infinity;
  let fromName = false;
  if (!useHasSlash) {
    const nameTarget = useEndsSlash ? `${entry.lowerName}/` : entry.lowerName;
    const ns = scoreSubseqFast(nameTarget, useChars, useLen);
    if (ns > -Infinity) {
      score = ns + 15;
      fromName = true;
    } else {
      const pathTarget = useEndsSlash ? `${entry.lowerPath}/` : entry.lowerPath;
      score = scoreSubseqFast(pathTarget, useChars, useLen);
    }
  } else {
    const pathTarget = useEndsSlash ? `${entry.lowerPath}/` : entry.lowerPath;
    score = scoreSubseqFast(pathTarget, useChars, useLen);
  }
  if (score > -Infinity) {
    score += isDir ? (qs.qEndsSlash ? 12 : -0.5) : 0.5;
  }
  return { score, fromName };
}

export function buildTopFileItems(top, q, withHits) {
  if (!top.length) return [];
  const sorted = top.slice().sort((a, b) => b.score - a.score);
  return sorted.map(({ entry, score, fromName }) => ({
    kind: entry.kind === "dir" ? "dir" : "file",
    path: entry.path,
    name: entry.name,
    score,
    hits: withHits && fromName ? (fuzzy(q, entry.name)?.hits || []) : [],
  }));
}

export function buildEmptyOverlayItems(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return entries.slice(0, MAX_EMPTY_FILES).map(e => ({
    kind: e.kind === "dir" ? "dir" : "file",
    path: e.path,
    name: e.name,
    score: 0,
    hits: [],
  }));
}
