// Pure helper logic for changes-review: diff row parsing, linear syntax lexer, path normalization, watch filtering, and check command discovery.

export const DIFF_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "crate", "default", "defer", "def", "delete", "do", "elif", "else", "enum", "except",
  "export", "extends", "final", "finally", "fn", "for", "from", "function", "fun", "go",
  "if", "impl", "implements", "import", "in", "instanceof", "interface", "is", "lambda",
  "let", "match", "mod", "mut", "namespace", "new", "not", "or", "and", "override",
  "package", "pass", "private", "protected", "pub", "public", "raise", "return", "select",
  "self", "static", "struct", "super", "switch", "this", "throw", "throws", "trait", "try",
  "type", "typeof", "use", "using", "val", "var", "virtual", "where", "while", "with", "yield",
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP", "BY",
  "ORDER", "HAVING", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "ALTER",
  "DROP", "TABLE", "INDEX", "AS", "AND", "OR", "NOT", "IN", "IS", "NULL", "CASE", "WHEN",
  "THEN", "ELSE", "END", "DISTINCT", "LIMIT", "OFFSET", "UNION", "EXISTS", "RETURNING",
]);

export const DIFF_CONSTANTS = new Set([
  "true", "false", "null", "nil", "None", "True", "False", "undefined", "NaN", "Infinity",
]);

export const DIFF_TYPES = new Set([
  "void", "int", "long", "short", "byte", "float", "double", "boolean", "bool", "char",
  "string", "number", "any", "unknown", "never", "object", "symbol", "bigint", "str",
  "usize", "isize", "i8", "i16", "i32", "i64", "i128", "u8", "u16", "u32", "u64", "u128", "f32", "f64",
  "String", "Integer", "Long", "Double", "Boolean", "List", "Map", "Set", "Optional",
  "Promise", "Array", "Record", "Vec", "Option", "Result", "Box", "Arc", "Error",
]);

export const HASH_COMMENT_EXTS = new Set([
  "py", "rb", "sh", "bash", "zsh", "fish", "yml", "yaml", "toml", "ps1", "psm1", "psd1",
  "r", "pl", "pm", "mk", "makefile", "dockerfile", "env", "ini", "conf", "cfg", "properties",
  "tf", "tfvars", "gitignore",
]);

export const SLASH_COMMENT_EXTS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "java", "kt", "kts", "cs",
  "go", "rs", "c", "cpp", "cc", "cxx", "h", "hpp", "swift", "scala", "groovy", "gradle",
  "php", "css", "scss", "less", "jsonc", "json5", "dart", "proto",
]);

export const MARKUP_EXTS = new Set(["html", "htm", "xml", "svg", "vue", "svelte"]);

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

// Linear single-pass lexer that preserves exact characters and avoids regex backtracking.
export function tokenizeDiffLine(rawText, ext) {
  if (!rawText) return null;
  const text = rawText.indexOf("\t") !== -1 ? rawText.replace(/\t/g, "    ") : rawText;
  if (text.length > 500 || ext === "txt" || ext === "log") return null;

  const tokens = [];
  const len = text.length;
  const hashComments = HASH_COMMENT_EXTS.has(ext);
  const slashComments = !ext || SLASH_COMMENT_EXTS.has(ext);
  const markup = MARKUP_EXTS.has(ext);
  const isJson = ext === "json" || ext === "jsonc" || ext === "json5";
  const isYaml = ext === "yml" || ext === "yaml";
  const isCss = ext === "css" || ext === "scss" || ext === "less";
  const isSql = ext === "sql";
  const isRust = ext === "rs";
  const isMd = ext === "md" || ext === "mdx";

  if (isMd && /^\s*#{1,6}\s/.test(text)) {
    return [["keyword", text]];
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
        pushSyntaxToken(tokens, "comment", text.slice(i));
        return tokens;
      }
      if (next === "*") {
        flushPlain(i);
        const close = text.indexOf("*/", i + 2);
        const end = close >= 0 ? close + 2 : len;
        pushSyntaxToken(tokens, "comment", text.slice(i, end));
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

    // Strings ("...", '...', `...`)
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
      let end = i + 1;
      while (end < len) {
        if (text[end] === "\\") {
          end = end + 1 < len ? end + 2 : len;
          continue;
        }
        if (text[end] === ch) {
          end++;
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
      pushSyntaxToken(tokens, kind, text.slice(i, end));
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

    // Decorators / Annotations (@Override, @RestController)
    if (ch === "@" && i + 1 < len && isIdentStart(text[i + 1]) && (i === 0 || !isIdentPart(text[i - 1]))) {
      let end = i + 2;
      while (end < len && (isIdentPart(text[end]) || text[end] === ".")) end++;
      flushPlain(i);
      pushSyntaxToken(tokens, "type", text.slice(i, end));
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

    // Identifiers / Keywords / Types / Constants / Function calls / YAML keys
    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < len && (isIdentPart(text[end]) || (isYaml && text[end] === "-"))) end++;
      const word = text.slice(i, end);
      let kind = "plain";
      let look = end;
      while (look < len && text[look] === " ") look++;

      if (isYaml && text[look] === ":" && (look + 1 === len || text[look + 1] === " ")) {
        kind = "function";
      } else if (DIFF_KEYWORDS.has(word)) {
        kind = "keyword";
      } else if (DIFF_CONSTANTS.has(word) || (word.length > 1 && /^[A-Z][A-Z0-9_]+$/.test(word))) {
        kind = "constant";
      } else if (DIFF_TYPES.has(word) || /^[A-Z][a-zA-Z0-9_]*$/.test(word)) {
        kind = "type";
      } else if (text[look] === "(") {
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
      const code = line.slice(1) || " ";
      return { kind, number: old++, text: code, tokens: tokenizeDiffLine(code, ext) };
    }
    if (kind === "+") {
      const code = line.slice(1) || " ";
      return { kind, number: next++, text: code, tokens: tokenizeDiffLine(code, ext) };
    }
    if (kind === " ") {
      old++;
      const code = line.slice(1) || " ";
      return { kind, number: next++, text: code, tokens: tokenizeDiffLine(code, ext) };
    }
    return { kind: "", text: line };
  });
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
