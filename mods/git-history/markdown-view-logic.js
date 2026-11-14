// Pure dependency-free Markdown preview preparation, link validation, and diff planning engine
// shared across herdr-mesh mods. Keep free of gpui-kit, gpui-base, herdr, and Node imports.
import {
  isMarkdownExt,
  isFrontmatterDelimiter,
  parseFenceOpen,
  parseFenceClose,
} from "./markdown-syntax.js";

export const DEFAULT_MARKDOWN_MAX_CHARS = 240000;
const MAX_FRONTMATTER_LINES = 150;
const MAX_FRONTMATTER_CHARS = 16000;
const MAX_FRONTMATTER_ENTRIES = 10;
const MAX_FRONTMATTER_VALUE_CHARS = 96;
const TRUNCATE_LINE_BACKUP_LIMIT = 512;

export function getFileExtension(filePath) {
  if (typeof filePath !== "string" || !filePath) return "";
  const trimmed = filePath.trim();
  const slashIdx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed;
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === base.length - 1) return "";
  return base.slice(dotIdx + 1).toLowerCase();
}

export function isMarkdownFile(pathOrExt) {
  if (typeof pathOrExt !== "string" || !pathOrExt) return false;
  const trimmed = pathOrExt.trim();
  if (!trimmed) return false;
  const clean = trimmed.startsWith(".") && !trimmed.includes("/") && !trimmed.includes("\\")
    ? trimmed.slice(1)
    : trimmed;
  if (!clean.includes("/") && !clean.includes("\\") && !clean.includes(".")) {
    return isMarkdownExt(clean);
  }
  return isMarkdownExt(getFileExtension(trimmed));
}

function normalizeNewlines(text) {
  let clean = text;
  if (clean.charCodeAt(0) === 0xfeff) {
    clean = clean.slice(1);
  }
  if (!clean.includes("\r")) return clean;
  return clean.replace(/\r\n?/g, "\n");
}

function isLikelyMarkdownInterruptInFrontmatter(line) {
  let i = 0;
  const len = line.length;
  while (i < len && (line[i] === " " || line[i] === "\t")) i++;
  if (i >= len) return false;
  const ch = line[i];
  if (ch === "#" || ch === ">") {
    // Allow YAML comments (# comment) only after confirming non-heading or handle '# ' carefully:
    // YAML comments at column 0 are rare vs Markdown headings (# Title); treat "# " as heading interrupt.
    if (ch === "#") {
      return i + 1 < len && (line[i + 1] === " " || line[i + 1] === "\t" || line[i + 1] === "#");
    }
    return true;
  }
  return Boolean(parseFenceOpen(line));
}

function truncateInline(value, maxLen) {
  if (value.length <= maxLen) return value;
  let cut = maxLen - 1;
  if (cut > 0) {
    const code = value.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  return `${value.slice(0, cut)}…`;
}

function parseFrontmatterEntries(lines) {
  const entries = [];
  let totalKeys = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Top-level YAML key (no leading indentation)
    const first = line[0];
    if (first === " " || first === "\t" || first === "#" || first === "-") continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (!key) continue;
    let rawVal = line.slice(colonIdx + 1).trim();
    if (!rawVal) {
      // Collect inline preview for YAML list/block right below key
      const nested = [];
      let j = i + 1;
      while (j < lines.length) {
        const sub = lines[j];
        if (!sub) {
          j++;
          continue;
        }
        if (sub[0] !== " " && sub[0] !== "\t" && sub[0] !== "-") break;
        const trimmedSub = sub.trim();
        if (trimmedSub.startsWith("- ")) {
          nested.push(trimmedSub.slice(2).trim());
        } else if (nested.length === 0) {
          nested.push(trimmedSub);
        }
        j++;
        if (nested.length >= 3) break;
      }
      rawVal = nested.length > 0 ? nested.join(", ") : "…";
    }
    totalKeys += 1;
    if (entries.length < MAX_FRONTMATTER_ENTRIES) {
      entries.push({
        key: truncateInline(key, 32),
        value: truncateInline(rawVal, MAX_FRONTMATTER_VALUE_CHARS),
      });
    }
  }
  return {
    entries,
    extraEntriesCount: Math.max(0, totalKeys - entries.length),
  };
}

export function splitMarkdownFrontmatter(rawText) {
  if (typeof rawText !== "string" || !rawText) {
    return {
      hasFrontmatter: false,
      frontmatterRaw: "",
      frontmatterEntries: [],
      extraEntriesCount: 0,
      body: "",
    };
  }

  const normalized = normalizeNewlines(rawText);
  const firstNl = normalized.indexOf("\n");
  const firstLine = firstNl === -1 ? normalized : normalized.slice(0, firstNl);
  if (firstNl === -1 || !isFrontmatterDelimiter(firstLine)) {
    return {
      hasFrontmatter: false,
      frontmatterRaw: "",
      frontmatterEntries: [],
      extraEntriesCount: 0,
      body: normalized,
    };
  }

  const fmLines = [];
  let lineCount = 0;
  let pos = firstNl + 1;
  let closedAt = -1;
  const maxPos = Math.min(normalized.length, firstNl + 1 + MAX_FRONTMATTER_CHARS);

  while (pos <= maxPos && lineCount < MAX_FRONTMATTER_LINES) {
    const nextNl = normalized.indexOf("\n", pos);
    const lineEnd = nextNl === -1 ? normalized.length : nextNl;
    const line = normalized.slice(pos, lineEnd);

    if (isFrontmatterDelimiter(line)) {
      closedAt = nextNl === -1 ? normalized.length : nextNl + 1;
      break;
    }
    if (isLikelyMarkdownInterruptInFrontmatter(line)) {
      break;
    }
    fmLines.push(line);
    lineCount += 1;
    if (nextNl === -1) break;
    pos = nextNl + 1;
  }

  if (closedAt === -1) {
    return {
      hasFrontmatter: false,
      frontmatterRaw: "",
      frontmatterEntries: [],
      extraEntriesCount: 0,
      body: normalized,
    };
  }

  let bodyStart = closedAt;
  while (bodyStart < normalized.length && normalized[bodyStart] === "\n") {
    bodyStart += 1;
  }
  const { entries, extraEntriesCount } = parseFrontmatterEntries(fmLines);

  return {
    hasFrontmatter: true,
    frontmatterRaw: fmLines.join("\n"),
    frontmatterEntries: entries,
    extraEntriesCount,
    body: normalized.slice(bodyStart),
  };
}

export function truncateMarkdownSafely(text, maxChars = DEFAULT_MARKDOWN_MAX_CHARS) {
  if (typeof text !== "string" || !text) {
    return { text: "", truncated: false, omittedChars: 0 };
  }
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MARKDOWN_MAX_CHARS;
  if (text.length <= limit) {
    return { text, truncated: false, omittedChars: 0 };
  }

  let cut = limit;
  if (cut > 0 && cut < text.length) {
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      cut -= 1;
    }
  }

  const minBackup = Math.max(0, cut - TRUNCATE_LINE_BACKUP_LIMIT);
  const lastNl = text.lastIndexOf("\n", cut);
  if (lastNl > minBackup) {
    cut = lastNl;
  }

  // Track any open fenced code block up to `cut` so truncation never breaks subsequent Markdown UI.
  let activeFence = null;
  let pos = 0;
  while (pos < cut) {
    const nextNl = text.indexOf("\n", pos);
    const lineEnd = nextNl === -1 || nextNl > cut ? cut : nextNl;
    const line = text.slice(pos, lineEnd);

    if (activeFence) {
      if (parseFenceClose(line, activeFence)) {
        activeFence = null;
      }
    } else {
      const openInfo = parseFenceOpen(line);
      if (openInfo) {
        activeFence = openInfo.fence;
      }
    }

    if (nextNl === -1 || nextNl >= cut) break;
    pos = nextNl + 1;
  }

  let out = text.slice(0, cut);
  if (activeFence) {
    if (!out.endsWith("\n")) out += "\n";
    out += `${activeFence}\n`;
  }

  return {
    text: out,
    truncated: true,
    omittedChars: Math.max(0, text.length - cut),
  };
}

function isMdxLineOutsideFence(line) {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) return true;
  if (trimmed[0] === "<") {
    const afterBracket = trimmed[1] === "/" ? trimmed.slice(2) : trimmed.slice(1);
    if (afterBracket.length > 0) {
      const code = afterBracket.charCodeAt(0);
      // PascalCase JSX component tag (<Alert>, </Tabs>)
      if (code >= 65 && code <= 90) {
        let j = 1;
        while (j < afterBracket.length) {
          const c = afterBracket.charCodeAt(j);
          const isIdent =
            (c >= 65 && c <= 90) ||
            (c >= 97 && c <= 122) ||
            (c >= 48 && c <= 57) ||
            c === 95 ||
            c === 46;
          if (!isIdent) break;
          j++;
        }
        const boundary = afterBracket[j];
        if (boundary === " " || boundary === "\t" || boundary === ">" || boundary === "/") {
          return true;
        }
      }
    }
  }
  return false;
}

export function detectMdxCues(markdownBody) {
  if (typeof markdownBody !== "string" || !markdownBody) return false;
  let activeFence = null;
  let pos = 0;
  const len = markdownBody.length;
  while (pos < len) {
    const nextNl = markdownBody.indexOf("\n", pos);
    const lineEnd = nextNl === -1 ? len : nextNl;
    const line = markdownBody.slice(pos, lineEnd);

    if (activeFence) {
      if (parseFenceClose(line, activeFence)) activeFence = null;
    } else {
      const openInfo = parseFenceOpen(line);
      if (openInfo) {
        activeFence = openInfo.fence;
      } else if (isMdxLineOutsideFence(line)) {
        return true;
      }
    }

    if (nextNl === -1) break;
    pos = nextNl + 1;
  }
  return false;
}

export function prepareMarkdownForRender(rawText, { filePath = "", maxChars = DEFAULT_MARKDOWN_MAX_CHARS } = {}) {
  const ext = getFileExtension(filePath);
  const isMdx = ext === "mdx";

  if (typeof rawText !== "string" || !rawText.trim()) {
    return {
      markdown: "",
      hasFrontmatter: false,
      frontmatterRaw: "",
      frontmatterEntries: [],
      extraEntriesCount: 0,
      truncated: false,
      omittedChars: 0,
      isMdx,
      hasMdxSyntax: false,
      isEmpty: true,
    };
  }

  const fm = splitMarkdownFrontmatter(rawText);
  const body = fm.body;
  const trunc = truncateMarkdownSafely(body, maxChars);
  const hasMdxSyntax = isMdx && detectMdxCues(trunc.text);
  const isEmpty = !fm.hasFrontmatter && !trunc.text.trim();

  return {
    markdown: trunc.text,
    hasFrontmatter: fm.hasFrontmatter,
    frontmatterRaw: fm.frontmatterRaw,
    frontmatterEntries: fm.frontmatterEntries,
    extraEntriesCount: fm.extraEntriesCount,
    truncated: trunc.truncated,
    omittedChars: trunc.omittedChars,
    isMdx,
    hasMdxSyntax,
    isEmpty,
  };
}

function extractUriScheme(url) {
  const limit = Math.min(url.length, 32);
  for (let i = 0; i < limit; i++) {
    const ch = url[i];
    if (ch === "/" || ch === "?" || ch === "#") return "";
    if (ch === ":") {
      return i > 0 ? url.slice(0, i).toLowerCase() : "";
    }
    const code = ch.charCodeAt(0);
    const valid =
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (i > 0 && ((code >= 48 && code <= 57) || ch === "+" || ch === "-" || ch === "."));
    if (!valid) return "";
  }
  return "";
}

function hasWhitespace(str) {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c <= 32) return true;
  }
  return false;
}

export function classifyMarkdownLink(url) {
  if (typeof url !== "string") return { kind: "unsupported", url: "" };
  const trimmed = url.trim();
  if (!trimmed) return { kind: "unsupported", url: "" };
  if (trimmed.startsWith("#")) return { kind: "anchor", url: trimmed };

  const scheme = extractUriScheme(trimmed);
  if (!scheme) {
    return hasWhitespace(trimmed)
      ? { kind: "unsupported", url: trimmed }
      : { kind: "relative", url: trimmed };
  }

  if (scheme === "http" || scheme === "https") {
    const rest = trimmed.slice(scheme.length + 1);
    if (!rest.startsWith("//") || hasWhitespace(trimmed)) {
      return { kind: "unsupported", url: trimmed };
    }
    const authorityPlus = rest.slice(2);
    if (!authorityPlus) return { kind: "unsupported", url: trimmed };
    const slashOrQuery = authorityPlus.search(/[/?#]/);
    const host = slashOrQuery === -1 ? authorityPlus : authorityPlus.slice(0, slashOrQuery);
    if (!host || host === "." || host === "..") {
      return { kind: "unsupported", url: trimmed };
    }
    return { kind: "external", url: trimmed };
  }

  return { kind: "unsupported", url: trimmed };
}

export function isSafeExternalUrl(url) {
  return classifyMarkdownLink(url).kind === "external";
}

export function resolveRelativeMarkdownPath(currentFilePath, href) {
  if (typeof href !== "string" || typeof currentFilePath !== "string") return null;
  const classified = classifyMarkdownLink(href);
  if (classified.kind !== "relative") return null;

  let target = classified.url;
  const hashIdx = target.indexOf("#");
  if (hashIdx >= 0) target = target.slice(0, hashIdx);
  const queryIdx = target.indexOf("?");
  if (queryIdx >= 0) target = target.slice(0, queryIdx);
  if (!target) return null;

  target = target.replace(/\\/g, "/");
  const curNorm = currentFilePath.replace(/\\/g, "/");

  if (target.startsWith("/")) {
    const parts = [];
    for (const seg of target.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") {
        if (parts.length > 0) parts.pop();
        continue;
      }
      parts.push(seg);
    }
    return `/${parts.join("/")}`;
  }

  const lastSlash = curNorm.lastIndexOf("/");
  const baseDir = lastSlash >= 0 ? curNorm.slice(0, lastSlash) : "";
  const isAbsBase = baseDir.startsWith("/");
  const baseParts = baseDir.split("/").filter(Boolean);

  for (const seg of target.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (baseParts.length > 0) {
        baseParts.pop();
      } else if (!isAbsBase) {
        return null;
      }
      continue;
    }
    baseParts.push(seg);
  }

  if (baseParts.length === 0) return null;
  return isAbsBase ? `/${baseParts.join("/")}` : baseParts.join("/");
}

export function getDiffMarkdownPlan(status) {
  const clean = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (clean === "D" || clean.startsWith("D")) {
    return {
      mode: "before",
      isDeleted: true,
      notice: "Deleted in this change — showing previous version",
    };
  }
  return {
    mode: "after",
    isDeleted: false,
    notice: "",
  };
}
