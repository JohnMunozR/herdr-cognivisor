// Cross-file and multi-service code navigation engine + workspace symbol index for JS/TS, Python, and Java.
import { appHome, exec, readTextFile } from "herdr";
import * as fsPromises from "fs/promises";

const { mkdir, readFile, writeFile } = fsPromises;
const fsStat = typeof fsPromises.stat === "function" ? fsPromises.stat : null;
import * as jsNav from "./code-nav-js.js";
import * as pythonNav from "./code-nav-python.js";
import * as javaNav from "./code-nav-java.js";
import {
  detectNavLanguage,
  extractNavContext,
  maskNonCodeRegions,
  normalizeNavCandidate,
  dedupeNavCandidates,
  rankNavCandidates,
} from "./code-nav-logic.js";
import {
  READ_GIT,
  COMMON_IGNORE_GLOBS,
  MAX_OVERLAY_FILES,
  isRgAvailable,
  markRgAvailable,
  normPathStr,
  runInBatches,
} from "./indexer.js";

const ANALYZERS = {
  js: jsNav,
  python: pythonNav,
  java: javaNav,
};

const JS_PROBE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_INDEX_FILES = ["index.ts", "index.tsx", "index.mts", "index.js", "index.jsx", "index.mjs"];
const SOURCE_GLOB = "*.{js,mjs,cjs,jsx,ts,tsx,mts,cts,py,pyw,pyi,java}";
const LANG_RG_GLOBS = {
  js: ["*.js", "*.mjs", "*.cjs", "*.jsx", "*.ts", "*.tsx", "*.mts", "*.cts"],
  python: ["*.py", "*.pyw", "*.pyi"],
  java: ["*.java"],
};
const LANG_GIT_PATHSPECS = {
  js: ["--", "*.js", "*.mjs", "*.cjs", "*.jsx", "*.ts", "*.tsx", "*.mts", "*.cts"],
  python: ["--", "*.py", "*.pyw", "*.pyi"],
  java: ["--", "*.java"],
};

const MAX_INDEXED_SERVICES = 4;
const MAX_INDEXED_FILES_PER_SERVICE = 2500;
const MAX_INDEXED_FILE_BYTES = 192 * 1024;
const MAX_GREP_MATCH_FILES = 25;
const FILE_SUMMARY_CACHE_MAX = 80;
const SOURCE_PROBE_CACHE_MAX = 32;
const SOURCE_PROBE_TTL_MS = 15000;
const JS_CONFIG_CACHE_MAX = 64;
const INDEX_CACHE_VERSION = 2;

const KNOWN_BUILTIN_RECEIVERS = {
  js: new Set([
    "console", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean",
    "Date", "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Error",
    "TypeError", "RangeError", "SyntaxError", "ReferenceError", "Symbol", "Reflect",
    "Proxy", "Intl", "URL", "URLSearchParams", "TextEncoder", "TextDecoder",
    "AbortController", "window", "document", "navigator", "chrome", "browser",
    "globalThis", "global", "process", "Buffer", "fetch", "setTimeout", "setInterval",
    "clearTimeout", "clearInterval", "queueMicrotask", "structuredClone", "crypto",
    "performance", "localStorage", "sessionStorage", "Infinity", "NaN", "undefined",
  ]),
  python: new Set([
    "os", "sys", "re", "json", "math", "time", "datetime", "pathlib", "logging",
    "typing", "collections", "itertools", "functools", "asyncio", "subprocess",
    "threading", "multiprocessing", "shutil", "tempfile", "hashlib", "base64",
    "urllib", "http", "email", "io", "csv", "sqlite3", "dataclasses", "enum",
    "abc", "contextlib", "traceback", "warnings", "unittest", "pytest",
    "print", "len", "range", "enumerate", "zip", "dict", "list", "tuple",
    "str", "int", "float", "bool", "bytes", "isinstance", "issubclass",
    "getattr", "setattr", "hasattr", "Exception", "ValueError", "TypeError", "KeyError",
  ]),
  java: new Set([
    "System", "Math", "Objects", "Arrays", "Collections", "Collectors", "Optional",
    "Stream", "String", "StringBuilder", "StringBuffer", "Integer", "Long",
    "Double", "Float", "Boolean", "Character", "Byte", "Short", "BigDecimal",
    "BigInteger", "List", "ArrayList", "LinkedList", "Map", "HashMap",
    "ConcurrentHashMap", "LinkedHashMap", "Set", "HashSet", "TreeSet", "Queue",
    "Deque", "ArrayDeque", "Instant", "LocalDate", "LocalDateTime", "Duration",
    "Period", "ZoneId", "UUID", "Pattern", "Matcher", "Paths", "Files",
    "Thread", "CompletableFuture", "Runtime", "Throwable", "Exception",
    "RuntimeException", "IllegalArgumentException", "IllegalStateException",
  ]),
};

function getKnownBuiltinRoot(context, lang) {
  const set = KNOWN_BUILTIN_RECEIVERS[lang];
  if (!set || !context) return "";
  const chain = Array.isArray(context.qualifierChain) ? context.qualifierChain : [];
  const rootSym = String(chain[0] || context.symbol || "").trim();
  if (!rootSym) return "";
  return set.has(rootSym) ? rootSym : "";
}

const SERVICE_INDEX_MAP = new Map();
const FILE_SUMMARY_CACHE = new Map();
const SOURCE_PROBE_CACHE = new Map();
const JS_CONFIG_CACHE = new Map();
const READ_TEXT_INFLIGHT = new Map();

const KNOWN_JAVA_EXTERNAL_PREFIXES = [
  "java.",
  "javax.",
  "jakarta.",
  "jdk.",
  "sun.",
  "org.w3c.",
  "org.xml.",
  "org.ietf.",
];

const KNOWN_PY_STDLIB = new Set([
  "abc", "argparse", "asyncio", "base64", "collections", "concurrent", "contextlib",
  "copy", "csv", "ctypes", "dataclasses", "datetime", "decimal", "enum", "functools",
  "glob", "hashlib", "heapq", "http", "importlib", "inspect", "io", "itertools",
  "json", "logging", "math", "multiprocessing", "operator", "os", "pathlib", "pickle",
  "re", "shutil", "signal", "socket", "sqlite3", "ssl", "statistics", "string",
  "subprocess", "sys", "tempfile", "threading", "time", "traceback", "types",
  "typing", "typing_extensions", "unittest", "urllib", "uuid", "warnings", "weakref", "xml", "zipfile",
]);

function setBoundedMap(map, key, value, maxSize) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

export function resetSymbolIndexCache() {
  SERVICE_INDEX_MAP.clear();
  FILE_SUMMARY_CACHE.clear();
  SOURCE_PROBE_CACHE.clear();
  JS_CONFIG_CACHE.clear();
  READ_TEXT_INFLIGHT.clear();
}

export function getNavLanguageAnalyzer(langOrPath) {
  const lang = ANALYZERS[langOrPath] ? langOrPath : detectNavLanguage(langOrPath);
  return lang ? { lang, analyzer: ANALYZERS[lang] } : null;
}

function hashTextSig(text) {
  const s = String(text || "");
  let h = 0x811c9dc5;
  const step = s.length > 8192 ? Math.floor(s.length / 2048) : 1;
  for (let i = 0; i < s.length; i += step) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

function dirnameFs(p) {
  const norm = normPathStr(p);
  if (!norm) return "";
  const idx = norm.lastIndexOf("/");
  if (idx < 0) return "";
  if (idx === 0) return "/";
  if (idx === 2 && /^[A-Za-z]:\//.test(norm)) return norm.slice(0, 3);
  return norm.slice(0, idx);
}

function basenameFs(p) {
  const norm = normPathStr(p);
  if (!norm) return "";
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function joinFsPath(base, rel) {
  const b = normPathStr(base);
  const r = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!b) return r;
  if (!r) return b;
  if (b === "/") return `/${r}`;
  return `${b}/${r}`;
}

function resolveRelativeFsPath(baseDir, relPath) {
  const normBase = normPathStr(baseDir);
  const rawRel = String(relPath || "").replace(/\\/g, "/");
  let prefix = "";
  let seed = normBase;
  if (rawRel.startsWith("/")) {
    const mDrive = rawRel.match(/^([A-Za-z]:)(\/.*)$/);
    if (mDrive) {
      prefix = mDrive[1];
      seed = "";
    } else if (/^[A-Za-z]:/.test(normBase)) {
      prefix = normBase.slice(0, 2);
      seed = "";
    } else {
      prefix = "/";
      seed = "";
    }
  } else {
    const mBaseDrive = seed.match(/^([A-Za-z]:)(\/.*)?$/);
    if (mBaseDrive) {
      prefix = mBaseDrive[1];
      seed = mBaseDrive[2] || "";
    } else if (seed.startsWith("//")) {
      prefix = "//";
      seed = seed.slice(2);
    } else if (seed.startsWith("/")) {
      prefix = "/";
      seed = seed.slice(1);
    }
  }

  const stack = seed.split("/").filter(Boolean);
  const segs = rawRel.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (seg === ".") continue;
    if (seg === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(seg);
  }
  if (prefix === "/") return `/${stack.join("/")}`;
  if (prefix === "//") return `//${stack.join("/")}`;
  if (/^[A-Za-z]:$/.test(prefix)) return `${prefix}/${stack.join("/")}`;
  return stack.join("/");
}

function isAbsoluteFsPath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  return s.startsWith("/") || /^[A-Za-z]:\//.test(s);
}

function isPathInsideRoot(filePath, rootPath) {
  const f = normPathStr(filePath);
  const r = normPathStr(rootPath);
  if (!f || !r) return false;
  if (f === r) return true;
  if (r === "/") return f.startsWith("/");
  return f.startsWith(`${r}/`);
}

function toServiceRelPath(serviceRoot, filePath) {
  const r = normPathStr(serviceRoot);
  const f = normPathStr(filePath);
  if (!f) return "";
  if (!r) return f.replace(/^\/+/, "");
  if (f === r) return "";
  if (r === "/" && f.startsWith("/")) return f.slice(1);
  if (f.startsWith(`${r}/`)) return f.slice(r.length + 1);
  return f;
}

function makeServiceKey(root, on = null) {
  return `${on || "local"}:${normPathStr(root)}`;
}

function fnv1aHex(str) {
  let h = 0x811c9dc5;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function getSymbolCacheFilePath(serviceRoot, on = null, appHomeDir = null) {
  let home = appHomeDir;
  if (!home) {
    try {
      home = typeof appHome === "function" ? appHome() : "";
    } catch {
      home = "";
    }
  }
  const cleanHome = normPathStr(home);
  const cleanRoot = normPathStr(serviceRoot);
  if (!cleanHome || !cleanRoot) return null;
  const cleanOn = typeof on === "string" && on.trim() ? on.trim() : "";
  const hashInput = cleanOn ? `${cleanRoot}::${cleanOn}` : cleanRoot;
  const base = basenameFs(cleanRoot).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ws";
  return `${cleanHome}/cognivisor/workspaces/${base}-${fnv1aHex(hashInput)}/symbols-index.json`;
}

function parseJsonc(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  let out = "";
  let inStr = false;
  let esc = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") {
      i += 2;
      while (i < s.length && s[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const close = s.indexOf("*/", i + 2);
      i = close >= 0 ? close + 2 : s.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  const clean = out.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function defaultReadText(filePath, opts) {
  return typeof readTextFile === "function" ? readTextFile(filePath, opts) : Promise.reject(new Error("readTextFile unavailable"));
}

async function readTextCached(
  filePath,
  { on = null, openFilesTextMap = null, readTextFn = null, bypassNegativeCache = false, skipCache = false } = {}
) {
  const norm = normPathStr(filePath);
  if (!norm) return null;
  if (openFilesTextMap && typeof openFilesTextMap.get === "function") {
    const mem = openFilesTextMap.get(norm);
    if (typeof mem === "string") return mem;
  }
  const cacheKey = `${on || "local"}:${norm}`;
  const now = Date.now();
  const cached = SOURCE_PROBE_CACHE.get(cacheKey);
  if (cached && now - cached.ts < SOURCE_PROBE_TTL_MS) {
    if (cached.text !== null || !bypassNegativeCache) return cached.text;
  }
  const inflightKey = !readTextFn ? `${cacheKey}:${bypassNegativeCache ? 1 : 0}` : "";
  if (inflightKey) {
    const existing = READ_TEXT_INFLIGHT.get(inflightKey);
    if (existing) return existing;
  }
  const reader = readTextFn || defaultReadText;
  const runRead = (async () => {
    try {
      const text = await reader(norm, on ? { on } : {});
      const val = typeof text === "string" && text.length <= MAX_INDEXED_FILE_BYTES ? text : null;
      if (!skipCache) {
        setBoundedMap(SOURCE_PROBE_CACHE, cacheKey, { text: val, ts: Date.now() }, SOURCE_PROBE_CACHE_MAX);
      }
      return val;
    } catch {
      if (!skipCache) {
        setBoundedMap(SOURCE_PROBE_CACHE, cacheKey, { text: null, ts: Date.now() }, SOURCE_PROBE_CACHE_MAX);
      }
      return null;
    } finally {
      if (inflightKey) READ_TEXT_INFLIGHT.delete(inflightKey);
    }
  })();
  if (inflightKey) READ_TEXT_INFLIGHT.set(inflightKey, runRead);
  return runRead;
}

function summarizeFileCached(filePath, sourceText, { skipCache = false } = {}) {
  const resolved = getNavLanguageAnalyzer(filePath);
  if (!resolved || typeof sourceText !== "string") return null;
  const sig = `${resolved.lang}:${normPathStr(filePath)}:${hashTextSig(sourceText)}`;
  const hit = FILE_SUMMARY_CACHE.get(sig);
  if (hit) return hit;
  const summary = resolved.analyzer.extractFileSymbolSummary(sourceText, filePath);
  if (!skipCache) {
    setBoundedMap(FILE_SUMMARY_CACHE, sig, summary, FILE_SUMMARY_CACHE_MAX);
  }
  return summary;
}

function normalizeServiceList(services, currentRoot, currentPath, on = null) {
  const list = Array.isArray(services) ? services.filter(Boolean) : [];
  const dedup = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const s = list[i];
    const root = normPathStr(s.root || "");
    if (!root) continue;
    const key = makeServiceKey(root, s.on ?? on ?? null);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push({
      id: s.id || root,
      name: s.name || basenameFs(root) || root,
      root,
      relPath: normPathStr(s.relPath || ""),
      on: s.on ?? on ?? null,
    });
  }
  const fallbackRoot = normPathStr(currentRoot || dirnameFs(currentPath));
  if (fallbackRoot) {
    const key = makeServiceKey(fallbackRoot, on);
    if (!seen.has(key)) {
      dedup.unshift({
        id: fallbackRoot,
        name: basenameFs(fallbackRoot) || "workspace",
        root: fallbackRoot,
        relPath: "",
        on,
      });
    }
  }
  return dedup;
}

export function findOwningService(filePath, currentRoot, services = [], on = null) {
  const normFile = normPathStr(filePath);
  const all = normalizeServiceList(services, currentRoot, filePath, on);
  let best = null;
  for (let i = 0; i < all.length; i += 1) {
    const s = all[i];
    if (isPathInsideRoot(normFile, s.root)) {
      if (!best || s.root.length > best.root.length) best = s;
    }
  }
  if (best) return best;
  if (all.length > 0) return all[0];
  const root = normPathStr(currentRoot || dirnameFs(normFile));
  return { id: root || "workspace", name: basenameFs(root) || "workspace", root, relPath: "", on };
}

function attachServiceMeta(candidate, service) {
  const normRoot = normPathStr(service?.root || candidate.root || "");
  const rawPath = normPathStr(candidate.filePath || "");
  const absPath = isAbsoluteFsPath(rawPath) || !normRoot ? rawPath : joinFsPath(normRoot, rawPath);
  const relPath = normRoot ? toServiceRelPath(normRoot, absPath) : rawPath;
  return normalizeNavCandidate(
    {
      ...candidate,
      filePath: absPath,
      relPath,
      root: normRoot,
      on: service?.on ?? candidate.on ?? null,
      serviceId: service?.id || candidate.serviceId || normRoot,
      serviceName: service?.name || candidate.serviceName || basenameFs(normRoot),
    },
    { filePath: absPath, root: normRoot, lang: candidate.lang }
  );
}

// ---------- Service Symbol Index Store ----------

function createEmptyServiceIndex(service) {
  const root = normPathStr(service.root);
  const key = makeServiceKey(root, service.on ?? null);
  return {
    key,
    root,
    id: service.id || root,
    name: service.name || basenameFs(root),
    on: service.on ?? null,
    loadedFromDisk: false,
    indexingPromise: null,
    warmed: false,
    warmedTs: 0,
    saveTimer: null,
    dirty: false,
    files: new Map(),
    symbolNames: new Map(),
    typesByName: new Map(),
    packageTypes: new Map(),
    subtypesByParent: new Map(),
  };
}

function getOrCreateServiceIndex(service) {
  const key = makeServiceKey(service.root, service.on ?? null);
  let idx = SERVICE_INDEX_MAP.get(key);
  if (!idx) {
    idx = createEmptyServiceIndex(service);
    setBoundedMap(SERVICE_INDEX_MAP, key, idx, MAX_INDEXED_SERVICES);
  }
  return idx;
}

function addMapSet(map, key, val) {
  if (!key) return;
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(val);
}

function delMapSet(map, key, val) {
  if (!key) return;
  const set = map.get(key);
  if (!set) return;
  set.delete(val);
  if (set.size === 0) map.delete(key);
}

function extractCompactIndexSymbols(summary) {
  const symbols = new Set();
  for (const t of summary.types || []) {
    if (t.name) symbols.add(t.name);
    for (const m of t.methods || []) {
      if (m.name) symbols.add(m.name);
    }
    for (const f of t.fields || []) {
      if (f.name) symbols.add(f.name);
    }
  }
  for (const fn of summary.functions || []) {
    if (fn.name) symbols.add(fn.name);
  }
  for (const v of summary.topVariables || []) {
    if (v.name) symbols.add(v.name);
  }
  for (const e of summary.exports || []) {
    if (e.name && e.name !== "default") symbols.add(e.name);
    if (e.localName) symbols.add(e.localName);
  }
  return Array.from(symbols);
}

function removeIndexedFile(idx, relPath) {
  const existing = idx.files.get(relPath);
  if (!existing) return;
  idx.files.delete(relPath);
  for (const sym of existing.symbolList || []) {
    delMapSet(idx.symbolNames, sym, relPath);
  }
  const summary = existing.summary;
  if (summary) {
    for (const t of summary.types || []) {
      const bucket = idx.typesByName.get(t.name);
      if (bucket) {
        const filtered = bucket.filter((entry) => entry.relPath !== relPath);
        if (filtered.length > 0) idx.typesByName.set(t.name, filtered);
        else idx.typesByName.delete(t.name);
      }
      if (summary.packageName) {
        const pkgMap = idx.packageTypes.get(summary.packageName);
        if (pkgMap && pkgMap.get(t.name) === relPath) {
          pkgMap.delete(t.name);
          if (pkgMap.size === 0) idx.packageTypes.delete(summary.packageName);
        }
      }
      for (const p of [...(t.extends || []), ...(t.implements || [])]) {
        const baseParent = String(p).replace(/<.*$/, "").split(".").pop();
        delMapSet(idx.subtypesByParent, baseParent, relPath);
      }
    }
  }
}

async function statLocalFileSafe(absPath) {
  if (!absPath || !fsStat) return null;
  try {
    const st = await fsStat(absPath);
    if (!st || (typeof st.isFile === "function" && !st.isFile())) return null;
    const mtimeMs = Number(st.mtimeMs);
    const size = Number(st.size);
    return {
      mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
      size: Number.isFinite(size) ? size : null,
    };
  } catch {
    return null;
  }
}

async function batchStatLocalFiles(root, files, execFn = null) {
  const statMap = new Map();
  if (!root || !Array.isArray(files) || files.length === 0) return statMap;
  if (fsStat) {
    await runInBatches(files, 16, async (rel) => {
      const st = await statLocalFileSafe(joinFsPath(root, rel));
      if (st) statMap.set(rel, st);
    });
    return statMap;
  }
  // Live QuickJS fallback: batched GNU stat (or BSD stat -f fallback) across local files when fsPromises.stat is unavailable
  const run = execFn || exec;
  const CHUNK = 250;
  const chunks = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    chunks.push(files.slice(i, i + CHUNK));
  }
  await runInBatches(chunks, 4, async (slice) => {
    let res = await run("stat", ["-L", "-c", "%Y:%s", "--", ...slice], { cwd: root, timeout: 4000 }).catch(() => null);
    if (!res || res.code !== 0 || !res.stdout) {
      res = await run("stat", ["-L", "-f", "%m:%z", "--", ...slice], { cwd: root, timeout: 4000 }).catch(() => null);
    }
    if (!res || res.code !== 0 || !res.stdout) return;
    const lines = String(res.stdout).trimEnd().split(/\r?\n/);
    if (lines.length !== slice.length) return;
    for (let j = 0; j < slice.length; j += 1) {
      const colonIdx = lines[j].indexOf(":");
      if (colonIdx <= 0) continue;
      const mtimeSec = Number(lines[j].slice(0, colonIdx));
      const size = Number(lines[j].slice(colonIdx + 1));
      if (Number.isFinite(mtimeSec) && Number.isFinite(size)) {
        statMap.set(slice[j], { mtimeMs: mtimeSec * 1000, size });
      }
    }
  });
  return statMap;
}

function scheduleServiceDiskSave(idx, appHomeDir = null) {
  if (!idx || !idx.root || !idx.dirty || (!idx.warmed && !idx.loadedFromDisk)) return;
  if (idx.saveTimer) {
    clearTimeout(idx.saveTimer);
    idx.saveTimer = null;
  }
  const timer = setTimeout(() => {
    idx.saveTimer = null;
    if (idx.dirty) {
      saveServiceDiskIndex(idx, appHomeDir).catch(() => {});
    }
  }, 800);
  if (typeof timer?.unref === "function") timer.unref();
  idx.saveTimer = timer;
}

function upsertIndexedFile(idx, relPath, sig, summary, statMeta = null) {
  if (!idx || !relPath || !summary) return;
  if (idx.files.has(relPath)) removeIndexedFile(idx, relPath);
  if (idx.files.size >= MAX_INDEXED_FILES_PER_SERVICE) return;

  const symbolList = extractCompactIndexSymbols(summary);
  idx.files.set(relPath, {
    relPath,
    sig,
    mtimeMs: Number.isFinite(statMeta?.mtimeMs) ? statMeta.mtimeMs : null,
    size: Number.isFinite(statMeta?.size) ? statMeta.size : null,
    lang: summary.lang,
    summary,
    symbolList,
  });

  for (let i = 0; i < symbolList.length; i += 1) {
    addMapSet(idx.symbolNames, symbolList[i], relPath);
  }
  for (const t of summary.types || []) {
    let bucket = idx.typesByName.get(t.name);
    if (!bucket) {
      bucket = [];
      idx.typesByName.set(t.name, bucket);
    }
    bucket.push({ relPath, typeRec: t });
    if (summary.packageName) {
      let pkgMap = idx.packageTypes.get(summary.packageName);
      if (!pkgMap) {
        pkgMap = new Map();
        idx.packageTypes.set(summary.packageName, pkgMap);
      }
      pkgMap.set(t.name, relPath);
    }
    for (const p of [...(t.extends || []), ...(t.implements || [])]) {
      const baseParent = String(p).replace(/<.*$/, "").split(".").pop();
      addMapSet(idx.subtypesByParent, baseParent, relPath);
    }
  }
}

function clearCachesForRoot(normRoot) {
  for (const k of SOURCE_PROBE_CACHE.keys()) {
    const colonIdx = k.indexOf(":");
    const pathPart = colonIdx >= 0 ? k.slice(colonIdx + 1) : k;
    if (!normRoot || isPathInsideRoot(pathPart, normRoot)) {
      SOURCE_PROBE_CACHE.delete(k);
    }
  }
  for (const k of JS_CONFIG_CACHE.keys()) {
    const colonIdx = k.indexOf(":");
    const pathPart = colonIdx >= 0 ? k.slice(colonIdx + 1) : k;
    if (!normRoot || isPathInsideRoot(pathPart, normRoot)) {
      JS_CONFIG_CACHE.delete(k);
    }
  }
  for (const k of FILE_SUMMARY_CACHE.keys()) {
    const parts = k.split(":");
    const filePart = parts.slice(1, -2).join(":");
    if (!normRoot || isPathInsideRoot(filePart, normRoot)) {
      FILE_SUMMARY_CACHE.delete(k);
    }
  }
}

export function invalidateIndexedFiles(root, changedPaths = [], on = null) {
  const normRoot = normPathStr(root);
  const list = Array.isArray(changedPaths) ? changedPaths : [changedPaths].filter(Boolean);

  if (list.length === 0) {
    clearCachesForRoot(normRoot);
    for (const [key, idx] of SERVICE_INDEX_MAP.entries()) {
      if (normRoot && idx.root !== normRoot && !isPathInsideRoot(normRoot, idx.root) && !isPathInsideRoot(idx.root, normRoot)) {
        continue;
      }
      if (on !== null && (idx.on ?? null) !== (on ?? null)) continue;
      if (idx.saveTimer) {
        clearTimeout(idx.saveTimer);
        idx.saveTimer = null;
      }
      SERVICE_INDEX_MAP.delete(key);
    }
    return;
  }

  const targetPaths = new Set();
  let shouldClearJsConfig = false;
  for (let i = 0; i < list.length; i += 1) {
    const clean = normPathStr(list[i]);
    if (!clean) continue;
    targetPaths.add(clean);
    if (normRoot && !isAbsoluteFsPath(clean)) {
      targetPaths.add(joinFsPath(normRoot, clean.replace(/^\.\//, "")));
    }
    if (/(?:^|\/)(?:tsconfig(?:\.[^/]+)?|jsconfig(?:\.[^/]+)?|package)\.json$/i.test(clean)) {
      shouldClearJsConfig = true;
    }
  }

  const targetOn = on !== null ? on || "local" : null;
  for (const k of SOURCE_PROBE_CACHE.keys()) {
    const colonIdx = k.indexOf(":");
    const keyOn = colonIdx >= 0 ? k.slice(0, colonIdx) : "local";
    const pathPart = colonIdx >= 0 ? k.slice(colonIdx + 1) : k;
    if (targetOn !== null && keyOn !== targetOn) continue;
    if (targetPaths.has(pathPart)) SOURCE_PROBE_CACHE.delete(k);
  }
  for (const k of FILE_SUMMARY_CACHE.keys()) {
    const firstColon = k.indexOf(":");
    const lastColon = k.lastIndexOf(":");
    const secondLastColon = lastColon > firstColon ? k.lastIndexOf(":", lastColon - 1) : -1;
    const filePart = firstColon >= 0 && secondLastColon > firstColon ? k.slice(firstColon + 1, secondLastColon) : k;
    if (targetPaths.has(filePart)) FILE_SUMMARY_CACHE.delete(k);
  }
  if (shouldClearJsConfig) {
    for (const k of JS_CONFIG_CACHE.keys()) {
      const colonIdx = k.indexOf(":");
      const pathPart = colonIdx >= 0 ? k.slice(colonIdx + 1) : k;
      if (!normRoot || isPathInsideRoot(pathPart, normRoot)) JS_CONFIG_CACHE.delete(k);
    }
  }

  for (const idx of SERVICE_INDEX_MAP.values()) {
    if (normRoot && idx.root !== normRoot && !isPathInsideRoot(normRoot, idx.root) && !isPathInsideRoot(idx.root, normRoot)) {
      continue;
    }
    if (on !== null && (idx.on ?? null) !== (on ?? null)) continue;
    for (let i = 0; i < list.length; i += 1) {
      const raw = normPathStr(list[i]);
      if (!raw) continue;
      const inside = isPathInsideRoot(raw, idx.root);
      const rel = inside ? toServiceRelPath(idx.root, raw) : raw.replace(/^\/+/, "");
      if (idx.files.has(rel)) {
        removeIndexedFile(idx, rel);
        idx.dirty = true;
      } else if ((inside || !isAbsoluteFsPath(raw)) && detectNavLanguage(rel)) {
        idx.dirty = true;
      }
    }
  }
}

async function loadServiceDiskIndex(idx, appHomeDir = null) {
  if (idx.loadedFromDisk) return false;
  idx.loadedFromDisk = true;
  const cachePath = getSymbolCacheFilePath(idx.root, idx.on ?? null, appHomeDir);
  if (!cachePath) return false;
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== INDEX_CACHE_VERSION ||
      parsed.root !== idx.root ||
      (parsed.on ?? null) !== (idx.on ?? null) ||
      !Array.isArray(parsed.entries)
    ) {
      return false;
    }
    for (let i = 0; i < parsed.entries.length && idx.files.size < MAX_INDEXED_FILES_PER_SERVICE; i += 1) {
      const ent = parsed.entries[i];
      if (!ent || !ent.relPath || !ent.summary) continue;
      if (!idx.files.has(ent.relPath)) {
        upsertIndexedFile(idx, ent.relPath, ent.sig || "", ent.summary, {
          mtimeMs: ent.mtimeMs ?? null,
          size: ent.size ?? null,
        });
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function saveServiceDiskIndex(idx, appHomeDir = null) {
  const cachePath = getSymbolCacheFilePath(idx.root, idx.on ?? null, appHomeDir);
  if (!cachePath) return false;
  try {
    await mkdir(dirnameFs(cachePath), { recursive: true });
    const entries = [];
    for (const [relPath, ent] of idx.files.entries()) {
      entries.push({
        relPath,
        sig: ent.sig,
        mtimeMs: ent.mtimeMs ?? null,
        size: ent.size ?? null,
        summary: ent.summary,
      });
    }
    await writeFile(cachePath, JSON.stringify({ version: INDEX_CACHE_VERSION, root: idx.root, on: idx.on ?? null, entries }), "utf8");
    idx.dirty = false;
    return true;
  } catch {
    return false;
  }
}

function splitOutputLines(stdout, cap = MAX_INDEXED_FILES_PER_SERVICE) {
  const out = [];
  if (!stdout) return out;
  const lines = String(stdout).split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < cap; i += 1) {
    let p = lines[i].trim().replace(/\\/g, "/");
    if (!p) continue;
    if (p.startsWith("./")) p = p.slice(2);
    if (detectNavLanguage(p)) out.push(p);
  }
  return out;
}

export async function listServiceIndexableFiles({ root, on = null, execFn = null, maxFiles = MAX_INDEXED_FILES_PER_SERVICE } = {}) {
  const normRoot = normPathStr(root);
  if (!normRoot) return [];
  const run = execFn || exec;
  const trackRg = !execFn;
  const onKey = on ?? "local";

  if (!trackRg || isRgAvailable(onKey) !== false) {
    const rgRes = await run(
      "rg",
      [
        "--files",
        "--hidden",
        "--no-heading",
        "--color=never",
        "--path-separator",
        "/",
        "--max-filesize",
        "512K",
        "--threads",
        "4",
        ...COMMON_IGNORE_GLOBS,
        "--glob",
        "!*.min.js",
        "--glob",
        "!*.bundle.js",
        "--glob",
        SOURCE_GLOB,
      ],
      { cwd: normRoot, on, timeout: 8000 }
    ).catch(() => null);
    if (rgRes && rgRes.code === 0) {
      if (trackRg) markRgAvailable(onKey, true);
      if (rgRes.stdout) return splitOutputLines(rgRes.stdout, maxFiles);
    } else if (trackRg && (!rgRes || (rgRes.code !== 0 && rgRes.code !== 1))) {
      const probe = await run("rg", ["--version"], { cwd: normRoot, on, timeout: 1500 }).catch(() => null);
      markRgAvailable(onKey, Boolean(probe && probe.code === 0));
    }
  }

  const gitRes = await run(
    "git",
    [...READ_GIT, "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: normRoot, on, timeout: 6000 }
  ).catch(() => null);
  if (gitRes && gitRes.code === 0 && gitRes.stdout) {
    return splitOutputLines(gitRes.stdout, maxFiles);
  }

  const findRes = await run(
    "sh",
    [
      "-c",
      'find . -not -path "*/.*" -not -path "*/node_modules/*" -not -path "*/target/*" -not -path "*/build/*" -not -path "*/dist/*" -not -path "*/.venv/*" -not -path "*/venv/*" -type f \\( -name "*.js" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" -o -name "*.mts" -o -name "*.cts" -o -name "*.py" -o -name "*.pyw" -o -name "*.pyi" -o -name "*.java" \\) | head -n ' +
        String(maxFiles) +
        ' | sed "s|^./||"',
    ],
    { cwd: normRoot, on, timeout: 8000 }
  ).catch(() => null);
  if (findRes && findRes.code === 0 && findRes.stdout) {
    return splitOutputLines(findRes.stdout, maxFiles);
  }
  return [];
}

export async function warmServiceSymbolIndex({
  service,
  on = null,
  appHomeDir = null,
  readTextFn = null,
  execFn = null,
  maxFiles = MAX_INDEXED_FILES_PER_SERVICE,
  yieldFn = null,
  skipIfFreshMs = 0,
} = {}) {
  if (!service?.root) return null;
  const svc = { ...service, root: normPathStr(service.root), on: service.on ?? on ?? null };
  const idx = getOrCreateServiceIndex(svc);
  if (idx.indexingPromise) return idx.indexingPromise;
  if (skipIfFreshMs > 0 && idx.warmed && !idx.dirty && idx.warmedTs > 0 && Date.now() - idx.warmedTs < skipIfFreshMs) {
    return idx;
  }

  idx.indexingPromise = (async () => {
    await loadServiceDiskIndex(idx, appHomeDir);
    const files = await listServiceIndexableFiles({ root: svc.root, on: svc.on, execFn, maxFiles });
    const presentSet = new Set(files);
    for (const oldRel of Array.from(idx.files.keys())) {
      if (!presentSet.has(oldRel)) {
        removeIndexedFile(idx, oldRel);
        idx.dirty = true;
      }
    }

    const useLocalStat = !svc.on && !readTextFn;
    const statMap = useLocalStat ? await batchStatLocalFiles(svc.root, files, execFn) : new Map();
    const toParse = [];
    if (useLocalStat) {
      for (const rel of files) {
        const st = statMap.get(rel) || null;
        if (st && Number.isFinite(st.size) && st.size > MAX_INDEXED_FILE_BYTES) continue;
        const existing = idx.files.get(rel);
        if (!existing) {
          toParse.push(rel);
        } else if (
          st &&
          (existing.mtimeMs == null ||
            existing.size == null ||
            existing.mtimeMs !== st.mtimeMs ||
            existing.size !== st.size)
        ) {
          toParse.push(rel);
        }
      }
    } else {
      for (const rel of files) {
        if (!idx.files.has(rel)) toParse.push(rel);
      }
    }

    if (toParse.length > 0) {
      let processed = 0;
      await runInBatches(toParse, 2, async (relPath) => {
        const abs = joinFsPath(svc.root, relPath);
        const text = await readTextCached(abs, { on: svc.on, readTextFn, skipCache: true });
        if (typeof text === "string") {
          const summary = summarizeFileCached(abs, text, { skipCache: true });
          if (summary) {
            const st = statMap.get(relPath) || (useLocalStat ? await statLocalFileSafe(abs) : null);
            upsertIndexedFile(idx, relPath, hashTextSig(text), summary, st);
            idx.dirty = true;
          }
        }
        processed += 1;
        if (yieldFn && processed % 6 === 0) {
          await yieldFn();
        }
      });
    }

    idx.warmed = true;
    idx.warmedTs = Date.now();
    if (idx.dirty) {
      if (idx.saveTimer) {
        clearTimeout(idx.saveTimer);
        idx.saveTimer = null;
      }
      await saveServiceDiskIndex(idx, appHomeDir);
      idx.dirty = false;
    }
    return idx;
  })();

  try {
    return await idx.indexingPromise;
  } finally {
    idx.indexingPromise = null;
  }
}

export async function warmAllServiceSymbolIndices({ services = [], currentRoot = "", on = null, maxServices = MAX_INDEXED_SERVICES, ...opts } = {}) {
  const normalized = normalizeServiceList(services, currentRoot, "", on);
  if (normalized.length === 0) return;
  const normCurrent = normPathStr(currentRoot);
  if (normCurrent) {
    normalized.sort((a, b) => (a.root === normCurrent ? -1 : b.root === normCurrent ? 1 : 0));
  }
  const limit = Number.isFinite(Number(maxServices)) && Number(maxServices) > 0
    ? Math.trunc(Number(maxServices))
    : MAX_INDEXED_SERVICES;
  const targets = normalized.slice(0, limit);
  await runInBatches(targets, 1, async (svc) => {
    await warmServiceSymbolIndex({ service: svc, on: svc.on ?? on, ...opts });
  });
}

async function analyzeFileAtPath(absPath, service, ioOpts) {
  const text = await readTextCached(absPath, {
    on: service?.on ?? ioOpts.on ?? null,
    openFilesTextMap: ioOpts.openFilesTextMap,
    readTextFn: ioOpts.readTextFn,
  });
  if (typeof text !== "string") return null;
  const summary = summarizeFileCached(absPath, text);
  if (!summary) return null;
  if (service?.root && isPathInsideRoot(absPath, service.root)) {
    const idx = getOrCreateServiceIndex(service);
    const rel = toServiceRelPath(service.root, absPath);
    const sig = hashTextSig(text);
    const existing = idx.files.get(rel);
    const useLocalStat = !service?.on && !ioOpts?.on && !ioOpts?.readTextFn;
    const st = useLocalStat ? await statLocalFileSafe(absPath) : null;
    if (
      !existing ||
      existing.sig !== sig ||
      (st && (existing.mtimeMs !== st.mtimeMs || existing.size !== st.size))
    ) {
      upsertIndexedFile(idx, rel, sig, summary, st);
      idx.dirty = true;
      scheduleServiceDiskSave(idx, ioOpts?.appHomeDir || null);
    }
  }
  return { absPath, text, summary };
}

export function peekCachedSourceText(filePath, on = null) {
  const norm = normPathStr(filePath);
  if (!norm) return null;
  const cached = SOURCE_PROBE_CACHE.get(`${on || "local"}:${norm}`);
  if (!cached || Date.now() - cached.ts >= SOURCE_PROBE_TTL_MS) return null;
  return typeof cached.text === "string" ? cached.text : null;
}

export function isServiceIndexWarmed(root, on = null) {
  const norm = normPathStr(root);
  if (!norm) return false;
  return Boolean(SERVICE_INDEX_MAP.get(makeServiceKey(norm, on ?? null))?.warmed);
}

export async function warmFileImports({
  filePath,
  sourceText = null,
  currentRoot = "",
  services = [],
  on = null,
  openFilesTextMap = null,
  indexedFilesByRoot = null,
  appHomeDir = null,
  readTextFn = null,
  execFn = null,
} = {}) {
  const langInfo = getNavLanguageAnalyzer(filePath);
  if (!langInfo) return 0;
  const normFile = normPathStr(filePath);
  const owningService = findOwningService(normFile, currentRoot, services, on);
  const allServices = normalizeServiceList(services, owningService.root, normFile, on);
  const ioOpts = {
    on: owningService.on ?? on ?? null,
    openFilesTextMap,
    indexedFilesByRoot,
    appHomeDir,
    readTextFn,
    execFn,
    allowUnindexedFallback: false,
  };

  const text = typeof sourceText === "string" ? sourceText : await readTextCached(normFile, ioOpts);
  if (typeof text !== "string") return 0;
  if (typeof sourceText === "string" && text.length <= MAX_INDEXED_FILE_BYTES) {
    setBoundedMap(
      SOURCE_PROBE_CACHE,
      `${ioOpts.on || "local"}:${normFile}`,
      { text, ts: Date.now() },
      SOURCE_PROBE_CACHE_MAX
    );
  }

  const summary = summarizeFileCached(normFile, text);
  if (!summary) return 0;

  let warmedCount = 0;
  const visitedTargets = new Set();

  if (summary.lang === "js") {
    const specs = [];
    for (const imp of summary.imports || []) {
      const spec = String(imp?.specifier || "").trim();
      if (!spec || spec.startsWith("node:") || visitedTargets.has(spec)) continue;
      visitedTargets.add(spec);
      specs.push(spec);
      if (specs.length >= 20) break;
    }
    await runInBatches(specs, 4, async (spec) => {
      const loaded = await resolveJsModuleFile(spec, normFile, owningService, allServices, ioOpts).catch(() => null);
      if (loaded?.absPath) warmedCount += 1;
    });
  } else if (summary.lang === "python") {
    const imports = [];
    for (const imp of summary.imports || []) {
      const modSpec = String(imp?.moduleSpec || "").trim();
      const relLevel = Number(imp?.relativeLevel || 0);
      if (!modSpec && relLevel === 0) continue;
      const topPkg = modSpec.split(".")[0];
      if (relLevel === 0 && topPkg && (KNOWN_BUILTIN_RECEIVERS.python.has(topPkg) || KNOWN_PY_STDLIB.has(topPkg))) continue;
      const key = `${relLevel}:${modSpec}:${imp?.importedName || ""}`;
      if (visitedTargets.has(key)) continue;
      visitedTargets.add(key);
      imports.push(imp);
      if (imports.length >= 20) break;
    }
    await runInBatches(imports, 4, async (imp) => {
      const res = await resolvePythonImportChain({
        specifier: imp.moduleSpec || "",
        relativeLevel: imp.relativeLevel || 0,
        importedName: imp.importedName || null,
        memberName: null,
        fromFilePath: normFile,
        service: owningService,
        allServices,
        ioOpts,
        context: { lang: "python", symbol: imp.importedName || imp.localName || "", line: imp.line || 1 },
      }).catch(() => null);
      if (res?.candidates?.length > 0) warmedCount += 1;
    });
  } else if (summary.lang === "java") {
    const hints = [];
    for (const imp of summary.imports || []) {
      const fqn = String(imp?.qualifiedName || "").trim();
      if (!fqn || visitedTargets.has(fqn)) continue;
      if (KNOWN_JAVA_EXTERNAL_PREFIXES.some((p) => fqn.startsWith(p))) continue;
      visitedTargets.add(fqn);
      hints.push(imp);
      if (hints.length >= 20) break;
    }
    await runInBatches(hints, 4, async (imp) => {
      const res = await resolveJavaImportHint({
        importHint: {
          qualifiedName: imp.qualifiedName,
          simpleName: imp.simpleName,
          importedName: imp.simpleName,
          typeName: imp.simpleName,
          isStatic: Boolean(imp.isStatic),
          isWildcard: Boolean(imp.isWildcard),
        },
        currentSummary: summary,
        fromFilePath: normFile,
        service: owningService,
        allServices,
        ioOpts,
        context: { lang: "java", symbol: imp.simpleName || "", line: imp.line || 1 },
      }).catch(() => null);
      if (res?.candidates?.length > 0) warmedCount += 1;
    });
  }

  return warmedCount;
}

function buildProbeSetChecker(service, ioOpts) {
  const root = normPathStr(service?.root || "");
  const raw = root && ioOpts.indexedFilesByRoot?.get ? ioOpts.indexedFilesByRoot.get(root) : null;
  if (!raw) return null;
  let overlaySet = null;
  let size = 0;
  if (raw instanceof Set) {
    if (raw.size === 0) return null;
    overlaySet = raw;
    size = raw.size;
  } else if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    overlaySet = new Set();
    for (let i = 0; i < raw.length; i++) {
      const clean = normPathStr(raw[i]).replace(/^\.\//, "");
      if (clean) overlaySet.add(clean);
    }
    if (overlaySet.size === 0) return null;
    size = overlaySet.size;
  } else if (typeof raw.has === "function") {
    if (typeof raw.size === "number") {
      if (raw.size === 0) return null;
      size = raw.size;
    }
    overlaySet = raw;
  } else {
    return null;
  }
  return {
    has: (absCandidate) => {
      const rel = toServiceRelPath(root, absCandidate);
      return overlaySet.has(rel);
    },
    complete: size > 0 && size < MAX_OVERLAY_FILES,
  };
}

async function probeFirstReadablePath(candidateAbsPaths, service, ioOpts) {
  if (!Array.isArray(candidateAbsPaths) || candidateAbsPaths.length === 0) return null;
  const normRoot = normPathStr(service?.root || "");
  const idx = normRoot ? SERVICE_INDEX_MAP.get(makeServiceKey(normRoot, service?.on ?? ioOpts?.on ?? null)) : null;
  const hasKnownFile = buildProbeSetChecker(service, ioOpts);
  const openMap = ioOpts?.openFilesTextMap && typeof ioOpts.openFilesTextMap.has === "function" ? ioOpts.openFilesTextMap : null;

  const prioritized = [];
  const secondary = [];
  for (let i = 0; i < candidateAbsPaths.length; i += 1) {
    const cand = candidateAbsPaths[i];
    const normCand = normPathStr(cand);
    const rel = normRoot ? toServiceRelPath(normRoot, normCand) : "";
    if ((idx && rel && idx.files.has(rel)) || (openMap && openMap.has(normCand))) {
      prioritized.push(cand);
    } else if (hasKnownFile && hasKnownFile.has(cand)) {
      secondary.push(cand);
    }
  }

  const ordered = prioritized.length > 0 && secondary.length > 0
    ? [...prioritized, ...secondary]
    : prioritized.length > 0
      ? prioritized
      : secondary;
  if (ordered.length === 0) {
    if (hasKnownFile && (ioOpts?.allowUnindexedFallback === false || hasKnownFile.complete)) {
      return null;
    }
    if (
      !hasKnownFile &&
      ioOpts?.allowUnindexedFallback === false &&
      idx?.warmed &&
      !idx.dirty &&
      idx.files.size < MAX_INDEXED_FILES_PER_SERVICE
    ) {
      return null;
    }
  }
  const fallback = ordered.length > 0 ? ordered : candidateAbsPaths;
  for (let i = 0; i < fallback.length; i += 1) {
    const loaded = await analyzeFileAtPath(fallback[i], service, ioOpts);
    if (loaded) return loaded;
  }
  return null;
}

// ---------- JS/TS Config & Module Specifier Resolution ----------

async function readJsProjectConfigs(startDir, serviceRoot, on, ioOpts) {
  const dirs = [];
  let cur = normPathStr(startDir);
  const stop = normPathStr(serviceRoot) || "/";
  for (let depth = 0; depth < 12 && cur; depth += 1) {
    dirs.push(cur);
    if (cur === stop || cur === "/" || /^[A-Za-z]:\/$/.test(cur)) break;
    const parent = dirnameFs(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }

  let tsConfig = null;
  let pkgConfig = null;
  for (let i = 0; i < dirs.length; i += 1) {
    const dir = dirs[i];
    const cacheKey = `${on || "local"}:${dir}`;
    let cached = JS_CONFIG_CACHE.get(cacheKey);
    if (!cached) {
      let tsconfigData = null;
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const raw = await readTextCached(joinFsPath(dir, name), { on, readTextFn: ioOpts.readTextFn });
        if (raw) {
          const parsed = parseJsonc(raw);
          if (parsed && typeof parsed === "object") {
            let merged = parsed;
            if (typeof parsed.extends === "string" && parsed.extends.startsWith(".")) {
              const extRaw = await readTextCached(resolveRelativeFsPath(dir, parsed.extends), {
                on,
                readTextFn: ioOpts.readTextFn,
              });
              const extParsed = extRaw ? parseJsonc(extRaw) : null;
              if (extParsed && typeof extParsed === "object") {
                merged = {
                  ...extParsed,
                  ...parsed,
                  compilerOptions: { ...(extParsed.compilerOptions || {}), ...(parsed.compilerOptions || {}) },
                };
              }
            }
            tsconfigData = { dir, compilerOptions: merged.compilerOptions || {} };
            break;
          }
        }
      }
      let pkgData = null;
      const pkgRaw = await readTextCached(joinFsPath(dir, "package.json"), { on, readTextFn: ioOpts.readTextFn });
      if (pkgRaw) {
        const parsedPkg = parseJsonc(pkgRaw);
        if (parsedPkg && typeof parsedPkg === "object") {
          pkgData = { dir, pkg: parsedPkg };
        }
      }
      cached = { tsconfigData, pkgData };
      setBoundedMap(JS_CONFIG_CACHE, cacheKey, cached, JS_CONFIG_CACHE_MAX);
    }
    if (!tsConfig && cached.tsconfigData) tsConfig = cached.tsconfigData;
    if (!pkgConfig && cached.pkgData) pkgConfig = cached.pkgData;
    if (tsConfig && pkgConfig) break;
  }
  return { tsConfig, pkgConfig };
}

function expandJsCandidatePaths(baseAbs) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const n = normPathStr(p);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };

  // TypeScript ESM imports often write `import "./foo.js"` when `./foo.ts` or `./foo.tsx` is on disk.
  const mExt = baseAbs.match(/^(.*)\.(m?js|c?js|jsx)$/i);
  if (mExt) {
    const stem = mExt[1];
    for (const ext of [".ts", ".tsx", ".mts", ".cts"]) push(`${stem}${ext}`);
    push(baseAbs);
    return out;
  }

  if (/\.(ts|tsx|mts|cts|py|pyi|java)$/i.test(baseAbs)) {
    push(baseAbs);
    return out;
  }

  for (const ext of JS_PROBE_EXTS) push(`${baseAbs}${ext}`);
  for (const idx of JS_INDEX_FILES) push(`${baseAbs}/${idx}`);
  return out;
}

function matchPattern(pattern, specifier) {
  const starIdx = pattern.indexOf("*");
  if (starIdx < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  if (specifier.length < prefix.length + suffix.length) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function extractPkgTargetString(target) {
  if (!target) return null;
  if (typeof target === "string") return target;
  if (Array.isArray(target)) {
    for (const item of target) {
      const r = extractPkgTargetString(item);
      if (r) return r;
    }
    return null;
  }
  if (typeof target === "object") {
    for (const key of ["types", "import", "module", "default", "require", "browser", "node"]) {
      if (key in target) {
        const r = extractPkgTargetString(target[key]);
        if (r) return r;
      }
    }
  }
  return null;
}

function resolvePackageExportsTarget(pkg, subpathSpec) {
  if (!pkg || typeof pkg !== "object") return [];
  const results = [];
  if (pkg.exports && typeof pkg.exports === "object") {
    const expKey = subpathSpec === "." ? "." : `./${subpathSpec.replace(/^\.\//, "")}`;
    if (typeof pkg.exports === "string") {
      if (expKey === ".") results.push(pkg.exports);
    } else if (expKey in pkg.exports) {
      const s = extractPkgTargetString(pkg.exports[expKey]);
      if (s) results.push(s);
    } else {
      for (const [pat, val] of Object.entries(pkg.exports)) {
        const star = matchPattern(pat, expKey);
        if (star !== null) {
          const s = extractPkgTargetString(val);
          if (s) results.push(s.replace("*", star));
        }
      }
    }
  }
  if (subpathSpec === ".") {
    for (const f of [pkg.source, pkg.module, pkg.types, pkg.typings, pkg.main]) {
      if (typeof f === "string" && f.trim()) results.push(f.trim());
    }
  }
  return results;
}

function buildJsConfigCandidateBases(specifier, tsConfig, pkgConfig) {
  const bases = [];
  if (tsConfig?.compilerOptions) {
    const opts = tsConfig.compilerOptions;
    const baseDir = opts.baseUrl ? resolveRelativeFsPath(tsConfig.dir, opts.baseUrl) : tsConfig.dir;
    const paths = opts.paths && typeof opts.paths === "object" ? opts.paths : null;
    if (paths) {
      for (const [pat, targets] of Object.entries(paths)) {
        const captured = matchPattern(pat, specifier);
        if (captured === null || !Array.isArray(targets)) continue;
        for (const t of targets) {
          const replaced = String(t || "").replace("*", captured);
          if (replaced) bases.push(resolveRelativeFsPath(baseDir, replaced));
        }
      }
    }
    if (opts.baseUrl && !specifier.startsWith(".")) {
      bases.push(resolveRelativeFsPath(baseDir, specifier));
    }
  }

  if (pkgConfig?.pkg) {
    const { dir, pkg } = pkgConfig;
    if (specifier.startsWith("#") && pkg.imports && typeof pkg.imports === "object") {
      for (const [pat, target] of Object.entries(pkg.imports)) {
        const captured = matchPattern(pat, specifier);
        if (captured === null) continue;
        const resolved = extractPkgTargetString(target);
        if (resolved) bases.push(resolveRelativeFsPath(dir, resolved.replace("*", captured)));
      }
    }
    if (pkg.name && (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`))) {
      const sub = specifier === pkg.name ? "." : specifier.slice(pkg.name.length + 1);
      for (const rel of resolvePackageExportsTarget(pkg, sub)) {
        bases.push(resolveRelativeFsPath(dir, rel));
      }
      if (sub !== ".") bases.push(resolveRelativeFsPath(dir, sub));
    }
  }
  return bases;
}

function findExportedSymbolInJsSummary(summary, filePath, wantedName, isDefault, context) {
  if (!summary) return [];
  if (!wantedName) {
    return [
      normalizeNavCandidate(
        { filePath, line: 1, column: 1, name: basenameFs(filePath), kind: "file", lang: "js", score: 120 },
        { filePath, lang: "js" }
      ),
    ];
  }
  const cands = [];
  if (isDefault) {
    for (const exp of summary.exports || []) {
      if (exp.isDefault || exp.name === "default") {
        cands.push({ name: exp.localName || exp.name || "default", kind: exp.kind || "export", line: exp.line, column: exp.column, score: 150 });
      }
    }
  } else {
    for (const exp of summary.exports || []) {
      if (exp.name === wantedName) {
        cands.push({ name: exp.name, kind: exp.kind || "export", line: exp.line, column: exp.column, score: 155 });
      }
    }
    for (const t of summary.types || []) {
      if (t.name === wantedName) {
        cands.push({ name: t.name, kind: t.kind || "class", line: t.line, column: t.column, isAbstract: Boolean(t.isAbstract), score: 145 });
      }
    }
    for (const fn of summary.functions || []) {
      if (fn.name === wantedName) {
        cands.push({ name: fn.name, kind: fn.kind || "function", line: fn.line, column: fn.column, arity: fn.arity, signature: fn.signature, score: 145 });
      }
    }
    for (const v of summary.topVariables || []) {
      if (v.name === wantedName) {
        cands.push({ name: v.name, kind: v.kind || "variable", line: v.line, column: v.column, signature: v.signature, score: 135 });
      }
    }
  }
  return cands.map((c) => normalizeNavCandidate({ ...c, filePath, lang: "js" }, { filePath, lang: "js" }));
}

function findMemberInTypeRecord(t, memberName, filePath, lang, context) {
  if (lang === "java" && typeof javaNav.findJavaSummaryMemberCandidates === "function") {
    return javaNav.findJavaSummaryMemberCandidates(t, memberName, filePath, context);
  }
  const cands = [];
  const wantArity = Number.isFinite(context?.arity) ? context.arity : null;
  for (const m of t.methods || []) {
    if (m.name !== memberName) continue;
    let score = 160;
    if (wantArity !== null) {
      if (m.arity === wantArity) score += 40;
      else score -= 15;
    }
    if (m.isAbstract) score -= 10;
    cands.push(
      normalizeNavCandidate(
        {
          filePath,
          line: m.line,
          column: m.column,
          name: m.name,
          kind: m.kind || "method",
          containerName: t.name,
          signature: m.signature || "",
          isAbstract: Boolean(m.isAbstract),
          isDefault: Boolean(m.isDefault),
          arity: m.arity ?? null,
          lang,
          score,
        },
        { filePath, lang }
      )
    );
  }
  if (!context?.isCall || cands.length === 0) {
    for (const f of t.fields || []) {
      if (f.name !== memberName) continue;
      cands.push(
        normalizeNavCandidate(
          {
            filePath,
            line: f.line,
            column: f.column,
            name: f.name,
            kind: "field",
            containerName: t.name,
            signature: f.signature || "",
            lang,
            score: 145,
          },
          { filePath, lang }
        )
      );
    }
  }
  return cands;
}

async function resolveJsModuleFile(specifier, fromFilePath, service, allServices, ioOpts) {
  const on = service?.on ?? ioOpts.on ?? null;
  const fromDir = dirnameFs(fromFilePath);
  if (specifier.startsWith(".")) {
    const targetBase = resolveRelativeFsPath(fromDir, specifier);
    const loaded = await probeFirstReadablePath(expandJsCandidatePaths(targetBase), service, ioOpts);
    if (loaded) return { ...loaded, service };
    return null;
  }
  if (specifier.startsWith("/")) {
    const loaded = await probeFirstReadablePath(expandJsCandidatePaths(specifier), service, ioOpts);
    if (loaded) return { ...loaded, service };
  }

  const { tsConfig, pkgConfig } = await readJsProjectConfigs(fromDir, service?.root, on, ioOpts);
  const cfgBases = buildJsConfigCandidateBases(specifier, tsConfig, pkgConfig);
  for (let i = 0; i < cfgBases.length; i += 1) {
    const loaded = await probeFirstReadablePath(expandJsCandidatePaths(cfgBases[i]), service, ioOpts);
    if (loaded) return { ...loaded, service };
  }

  // Probe sibling Cognivisor services if specifier names a workspace service package
  for (let i = 0; i < allServices.length; i += 1) {
    const other = allServices[i];
    if (other.root === service.root) continue;
    const otherCfg = await readJsProjectConfigs(other.root, other.root, other.on ?? on, ioOpts);
    const otherPkg = otherCfg.pkgConfig?.pkg;
    if (!otherPkg?.name) continue;
    if (specifier === otherPkg.name || specifier.startsWith(`${otherPkg.name}/`)) {
      const sub = specifier === otherPkg.name ? "." : specifier.slice(otherPkg.name.length + 1);
      const targets = resolvePackageExportsTarget(otherPkg, sub);
      if (sub !== ".") targets.push(sub);
      for (const rel of targets) {
        const base = resolveRelativeFsPath(other.root, rel);
        const loaded = await probeFirstReadablePath(expandJsCandidatePaths(base), other, ioOpts);
        if (loaded) return { ...loaded, service: other };
      }
    }
  }
  return null;
}

async function resolveJsImportChain({
  specifier,
  importedName,
  memberName = null,
  isDefault = false,
  isNamespace = false,
  isTypeOnly = false,
  fromFilePath,
  service,
  allServices,
  ioOpts,
  context,
  depth = 0,
  visited = new Set(),
}) {
  if (!specifier || depth > 4) return { candidates: [], externalPackage: null };
  const loaded = await resolveJsModuleFile(specifier, fromFilePath, service, allServices, ioOpts);
  if (!loaded) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      const pkg = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      return { candidates: [], externalPackage: pkg };
    }
    return { candidates: [], externalPackage: null };
  }

  const visitKey = `${loaded.absPath}:${importedName || "*"}:${memberName || ""}`;
  if (visited.has(visitKey)) return { candidates: [], externalPackage: null };
  visited.add(visitKey);

  if (isNamespace && !memberName) {
    return {
      candidates: [
        attachServiceMeta(
          { filePath: loaded.absPath, line: 1, column: 1, name: basenameFs(loaded.absPath), kind: "module", lang: "js", score: 130 },
          loaded.service
        ),
      ],
      externalPackage: null,
    };
  }

  const { summary, absPath, service: owningSvc } = loaded;
  if (memberName) {
    const typeRec = (summary.types || []).find((t) => t.name === importedName);
    if (typeRec) {
      const memberCands = findMemberInTypeRecord(typeRec, memberName, absPath, "js", context).map((c) =>
        attachServiceMeta(c, owningSvc)
      );
      if (memberCands.length > 0) return { candidates: memberCands, externalPackage: null };
    }
  }

  const directName = isNamespace ? (memberName || "") : importedName;
  const direct = findExportedSymbolInJsSummary(summary, absPath, directName, isDefault, context).map((c) =>
    attachServiceMeta(c, owningSvc)
  );
  if (direct.length > 0) return { candidates: direct, externalPackage: null };

  // Follow barrel re-exports (`export { foo } from "./bar"` or `export * from "./sub"`)
  const targetName = isDefault ? "default" : importedName;
  for (const re of summary.reExports || []) {
    if (!re.specifier) continue;
    if (re.isStar) {
      const subRes = await resolveJsImportChain({
        specifier: re.specifier,
        importedName: targetName,
        memberName,
        isDefault: false,
        fromFilePath: absPath,
        service: owningSvc,
        allServices,
        ioOpts,
        context,
        depth: depth + 1,
        visited,
      });
      if (subRes.candidates.length > 0) return subRes;
    } else if (re.exportedName === targetName) {
      const subRes = await resolveJsImportChain({
        specifier: re.specifier,
        importedName: re.localName || targetName,
        memberName,
        isDefault: (re.localName || targetName) === "default",
        fromFilePath: absPath,
        service: owningSvc,
        allServices,
        ioOpts,
        context,
        depth: depth + 1,
        visited,
      });
      if (subRes.candidates.length > 0) return subRes;
    }
  }

  // Fallback: file itself if named symbol wasn't matched cleanly
  if (!isTypeOnly && direct.length === 0 && (summary.reExports || []).length === 0 && importedName) {
    return {
      candidates: [
        attachServiceMeta(
          { filePath: absPath, line: 1, column: 1, name: importedName, kind: "module", lang: "js", score: 85 },
          owningSvc
        ),
      ],
      externalPackage: null,
    };
  }
  return { candidates: [], externalPackage: null };
}

// ---------- Python Module & Import Resolution ----------

function parseLeadingDots(spec) {
  let count = 0;
  while (count < spec.length && spec[count] === ".") count += 1;
  return { dots: count, remainder: spec.slice(count) };
}

function buildPythonModuleCandidates(baseDir, remainder, importedName = null) {
  const parts = String(remainder || "").split(".").filter(Boolean);
  const probes = [];
  const modDir = parts.length > 0 ? resolveRelativeFsPath(baseDir, parts.join("/")) : normPathStr(baseDir);
  if (parts.length > 0) {
    probes.push(`${modDir}.py`, `${modDir}.pyi`, `${modDir}/__init__.py`, `${modDir}/__init__.pyi`);
  } else {
    probes.push(`${modDir}/__init__.py`, `${modDir}/__init__.pyi`);
  }
  if (importedName && importedName !== "*") {
    const subBase = joinFsPath(modDir, importedName);
    probes.push(`${subBase}.py`, `${subBase}.pyi`, `${subBase}/__init__.py`);
  }
  return probes;
}

async function resolvePythonAnchors(fromFilePath, service, ioOpts) {
  const anchors = [];
  const seen = new Set();
  const addAnchor = (dir) => {
    const n = normPathStr(dir);
    if (n && !seen.has(n)) {
      seen.add(n);
      anchors.push(n);
    }
  };
  let cur = dirnameFs(fromFilePath);
  const root = normPathStr(service?.root || "");
  for (let i = 0; i < 8 && cur; i += 1) {
    const init = await readTextCached(joinFsPath(cur, "__init__.py"), { on: service?.on ?? ioOpts.on ?? null, readTextFn: ioOpts.readTextFn });
    if (init === null) {
      addAnchor(cur);
      break;
    }
    const parent = dirnameFs(cur);
    if (!parent || parent === cur || (root && !isPathInsideRoot(parent, root) && cur === root)) {
      addAnchor(parent || cur);
      break;
    }
    cur = parent;
  }
  if (root) {
    addAnchor(root);
    addAnchor(joinFsPath(root, "src"));
    addAnchor(joinFsPath(root, "app"));
  }
  return anchors;
}

function findPythonSymbolInSummary(summary, absPath, targetName, memberName, context) {
  if (!summary) return [];
  if (memberName) {
    const cls = (summary.types || []).find((t) => t.name === targetName);
    if (cls) {
      const mCands = findMemberInTypeRecord(cls, memberName, absPath, "python", context);
      if (mCands.length > 0) return mCands;
    }
  }
  if (!targetName || targetName === "*") {
    return [
      normalizeNavCandidate(
        { filePath: absPath, line: 1, column: 1, name: basenameFs(absPath), kind: "module", lang: "python", score: 120 },
        { filePath: absPath, lang: "python" }
      ),
    ];
  }
  const out = [];
  for (const t of summary.types || []) {
    if (t.name === targetName) {
      out.push({ name: t.name, kind: "class", line: t.line, column: t.column, isAbstract: Boolean(t.isAbstract), score: 155 });
    }
  }
  for (const fn of summary.functions || []) {
    if (fn.name === targetName && !fn.containerName) {
      out.push({ name: fn.name, kind: fn.kind || "function", line: fn.line, column: fn.column, arity: fn.arity, signature: fn.signature, score: 155 });
    }
  }
  for (const v of summary.topVariables || []) {
    if (v.name === targetName) {
      out.push({ name: v.name, kind: v.kind || "variable", line: v.line, column: v.column, signature: v.signature, score: 140 });
    }
  }
  return out.map((c) => normalizeNavCandidate({ ...c, filePath: absPath, lang: "python" }, { filePath: absPath, lang: "python" }));
}

async function resolvePythonImportChain({
  specifier,
  relativeLevel = 0,
  importedName = null,
  memberName = null,
  fromFilePath,
  service,
  allServices,
  ioOpts,
  context,
  depth = 0,
  visited = new Set(),
}) {
  const spec = String(specifier || "");
  if ((!spec && !relativeLevel) || depth > 4) return { candidates: [], externalPackage: null };
  const parsed = parseLeadingDots(spec);
  const relLvl = relativeLevel || parsed.dots;
  const remainder = parsed.remainder;

  let loaded = null;
  if (relLvl > 0) {
    let baseDir = dirnameFs(fromFilePath);
    for (let up = 1; up < relLvl && baseDir; up += 1) {
      baseDir = dirnameFs(baseDir);
    }
    const probes = buildPythonModuleCandidates(baseDir, remainder, importedName);
    const res = await probeFirstReadablePath(probes, service, ioOpts);
    if (res) loaded = { ...res, service };
  } else {
    const anchors = await resolvePythonAnchors(fromFilePath, service, ioOpts);
    const candidateServices = [service, ...allServices.filter((s) => s.root !== service.root)];
    for (let si = 0; si < candidateServices.length && !loaded; si += 1) {
      const svc = candidateServices[si];
      const svcAnchors = si === 0 ? anchors : [svc.root, joinFsPath(svc.root, "src"), joinFsPath(svc.root, "app")];
      const probes = [];
      for (const a of svcAnchors) probes.push(...buildPythonModuleCandidates(a, remainder, importedName));
      const res = await probeFirstReadablePath(probes, svc, ioOpts);
      if (res) loaded = { ...res, service: svc };
    }
  }

  if (!loaded) {
    const topPkg = remainder.split(".")[0];
    if (relLvl === 0 && topPkg && KNOWN_PY_STDLIB.has(topPkg)) {
      return { candidates: [], externalPackage: topPkg };
    }
    return { candidates: [], externalPackage: relLvl === 0 && topPkg ? topPkg : null };
  }

  const visitKey = `${loaded.absPath}:${importedName || ""}:${memberName || ""}`;
  if (visited.has(visitKey)) return { candidates: [], externalPackage: null };
  visited.add(visitKey);

  let pyTargetName = importedName;
  const matchedModuleSelf =
    memberName &&
    pyTargetName &&
    (basenameFs(loaded.absPath).replace(/\.pyi?$/, "") === pyTargetName ||
      (basenameFs(loaded.absPath).startsWith("__init__.py") && basenameFs(dirnameFs(loaded.absPath)) === pyTargetName));
  if (matchedModuleSelf) {
    pyTargetName = memberName;
  }
  const cands = findPythonSymbolInSummary(loaded.summary, loaded.absPath, pyTargetName, matchedModuleSelf ? null : memberName, context).map((c) =>
    attachServiceMeta(c, loaded.service)
  );
  if (cands.length > 0) return { candidates: cands, externalPackage: null };

  // Follow `__init__.py` re-exported imports (`from .models import User`) or submodule (`from . import helpers`)
  if (basenameFs(loaded.absPath).startsWith("__init__.py") && importedName) {
    const reImp = (loaded.summary.imports || []).find((imp) => imp.localName === importedName || imp.importedName === importedName);
    if (reImp) {
      const nested = await resolvePythonImportChain({
        specifier: reImp.moduleSpec || "",
        relativeLevel: reImp.relativeLevel || 0,
        importedName: reImp.importedName,
        memberName,
        fromFilePath: loaded.absPath,
        service: loaded.service,
        allServices,
        ioOpts,
        context,
        depth: depth + 1,
        visited,
      });
      if (nested.candidates.length > 0) return nested;
    }

    if (importedName !== "*") {
      const subProbes = buildPythonModuleCandidates(dirnameFs(loaded.absPath), importedName, null);
      const subLoaded = await probeFirstReadablePath(subProbes, loaded.service, ioOpts);
      if (subLoaded) {
        if (memberName) {
          const subCands = findPythonSymbolInSummary(subLoaded.summary, subLoaded.absPath, memberName, null, context).map((c) =>
            attachServiceMeta(c, loaded.service)
          );
          if (subCands.length > 0) return { candidates: subCands, externalPackage: null };
        }
        return {
          candidates: [
            attachServiceMeta(
              { filePath: subLoaded.absPath, line: 1, column: 1, name: importedName, kind: "module", lang: "python", score: 135 },
              loaded.service
            ),
          ],
          externalPackage: null,
        };
      }
    }
  }

  return {
    candidates: [
      attachServiceMeta(
        { filePath: loaded.absPath, line: 1, column: 1, name: importedName || basenameFs(loaded.absPath), kind: "module", lang: "python", score: 90 },
        loaded.service
      ),
    ],
    externalPackage: null,
  };
}

// ---------- Java Package & Import Resolution ----------

function inferJavaSourceRoots(currentFilePath, packageName, serviceRoot) {
  const roots = [];
  const seen = new Set();
  const add = (r) => {
    const n = normPathStr(r);
    if (n && !seen.has(n)) {
      seen.add(n);
      roots.push(n);
    }
  };
  if (packageName && currentFilePath) {
    const normFile = normPathStr(currentFilePath);
    const pkgRelDir = packageName.replace(/\./g, "/");
    const suffix = `/${pkgRelDir}/${basenameFs(normFile)}`;
    if (normFile.endsWith(suffix)) {
      add(normFile.slice(0, normFile.length - suffix.length) || "/");
    }
  }
  const sRoot = normPathStr(serviceRoot);
  if (sRoot) {
    for (const rel of ["src/main/java", "src/test/java", "src", ""]) {
      add(rel ? joinFsPath(sRoot, rel) : sRoot);
    }
  }
  return roots;
}

function resolveJavaTypeFqnInSummary(typeName, summary) {
  const clean = javaNav.stripGenericSuffix ? javaNav.stripGenericSuffix(typeName) : String(typeName || "").replace(/<.*$/, "").trim();
  if (!clean || !summary) return clean;
  for (const imp of summary.imports || []) {
    if (!imp.isWildcard && imp.simpleName === clean) {
      return imp.qualifiedName;
    }
  }
  if (KNOWN_BUILTIN_RECEIVERS.java.has(clean)) {
    return `java.lang.${clean}`;
  }
  for (const imp of summary.imports || []) {
    if (imp.isWildcard && !imp.isStatic && imp.qualifiedName) {
      return `${imp.qualifiedName.replace(/\.\*$/, "")}.${clean}`;
    }
  }
  return summary.packageName ? `${summary.packageName}.${clean}` : clean;
}

async function loadJavaTypeRecord({ simpleType, originSummary, fromFilePath, service, allServices, ioOpts }) {
  const cleanSimple = javaNav.stripGenericSuffix ? javaNav.stripGenericSuffix(simpleType) : String(simpleType || "").replace(/<.*$/, "").trim();
  if (!cleanSimple) return { kind: "missing", fqn: "" };

  const localSameFile = (originSummary?.types || []).find((t) => t.name === cleanSimple);
  if (localSameFile && fromFilePath) {
    return { kind: "project", tRec: localSameFile, summary: originSummary, absPath: fromFilePath, service };
  }

  const fqn = resolveJavaTypeFqnInSummary(cleanSimple, originSummary);
  if (fqn && KNOWN_JAVA_EXTERNAL_PREFIXES.some((p) => fqn.startsWith(p))) {
    return { kind: "external", fqn };
  }

  const candidateFqns = [];
  if (fqn) {
    candidateFqns.push({ typeFqn: fqn, simpleType: cleanSimple });
    const parts = fqn.split(".");
    if (parts.length >= 2) {
      candidateFqns.push({ typeFqn: parts.slice(0, -1).join("."), simpleType: parts[parts.length - 1] });
    }
  }

  const candidateServices = [service, ...allServices.filter((s) => s.root !== service.root)];
  for (let si = 0; si < candidateServices.length; si += 1) {
    const svc = candidateServices[si];
    const pkgName = originSummary?.packageName || "";
    const srcRoots = si === 0 ? inferJavaSourceRoots(fromFilePath, pkgName, svc.root) : inferJavaSourceRoots("", "", svc.root);
    for (const item of candidateFqns) {
      const relFile = `${item.typeFqn.replace(/\./g, "/")}.java`;
      const probes = srcRoots.map((sr) => joinFsPath(sr, relFile));
      const loaded = await probeFirstReadablePath(probes, svc, ioOpts);
      if (loaded?.summary) {
        const tRec = (loaded.summary.types || []).find((t) => t.name === item.simpleType);
        if (tRec) {
          return { kind: "project", tRec, summary: loaded.summary, absPath: loaded.absPath, service: svc };
        }
      }
    }
  }

  if (fqn && fqn.includes(".")) {
    return { kind: "external", fqn };
  }
  return { kind: "missing", fqn: cleanSimple };
}

async function resolveJavaMemberInHierarchy({ loaded, simpleTypeName, memberName, allServices, ioOpts, context, depth = 0 }) {
  const summary = loaded.summary;
  const absPath = loaded.absPath;
  const tRec = (summary.types || []).find((t) => t.name === simpleTypeName);
  if (!tRec) return [];
  if (memberName) {
    const memberCands = findMemberInTypeRecord(tRec, memberName, absPath, "java", context);
    if (memberCands.length > 0) {
      return memberCands.map((c) => attachServiceMeta(c, loaded.service));
    }
    if (depth < 3) {
      const parents = [...(tRec.extends || []), ...(tRec.implements || [])];
      for (const pRaw of parents) {
        const pSimple = javaNav.stripGenericSuffix ? javaNav.stripGenericSuffix(pRaw) : String(pRaw || "").replace(/<.*$/, "").trim();
        if (!pSimple) continue;
        const parentRes = await loadJavaTypeRecord({
          simpleType: pSimple,
          originSummary: summary,
          fromFilePath: absPath,
          service: loaded.service,
          allServices,
          ioOpts,
        });
        if (parentRes.kind === "project") {
          const inherited = await resolveJavaMemberInHierarchy({
            loaded: parentRes,
            simpleTypeName: parentRes.tRec.name,
            memberName,
            allServices,
            ioOpts,
            context,
            depth: depth + 1,
          });
          if (inherited.length > 0) return inherited;
        }
      }
    }
  }
  return findJavaTypeOrMemberInSummary(summary, absPath, simpleTypeName, memberName, context).map((c) =>
    attachServiceMeta(c, loaded.service)
  );
}

async function resolveJavaReceiverChain({ chainInfo, memberName, currentSummary, fromFilePath, service, allServices, ioOpts, context }) {
  let curType = chainInfo?.rootType || "";
  let curArgs = Array.isArray(chainInfo?.rootGenericArgs) ? [...chainInfo.rootGenericArgs] : [];
  let curSummary = currentSummary;
  let curFile = fromFilePath;
  let curService = service;
  const steps = Array.isArray(chainInfo?.steps) ? chainInfo.steps.slice(0, 6) : [];
  const builderPrefix = javaNav.BUILDER_TYPE_PREFIX || "__builderOf:";
  const formatExternalFqn = (fqn) => {
    if (typeof fqn === "string" && fqn.startsWith("java.lang.")) {
      const shortName = fqn.slice(10);
      if (KNOWN_BUILTIN_RECEIVERS.java.has(shortName)) return shortName;
    }
    return fqn;
  };

  for (let i = 0; i < steps.length && curType; i += 1) {
    const step = steps[i];
    if (curType.startsWith(builderPrefix)) {
      const next = javaNav.advanceJavaContainerOrBuilderType(curType, curArgs, step, () => null);
      if (!next || !next.typeName) return { candidates: [], externalPackage: null };
      curType = next.typeName;
      curArgs = next.genericArgs || [];
      continue;
    }

    const extAdvance = javaNav.advanceJavaContainerOrBuilderType(curType, curArgs, step, () => null);
    if (extAdvance && extAdvance.typeName) {
      curType = extAdvance.typeName;
      curArgs = extAdvance.genericArgs || [];
      continue;
    }

    const loaded = await loadJavaTypeRecord({
      simpleType: curType,
      originSummary: curSummary,
      fromFilePath: curFile,
      service: curService,
      allServices,
      ioOpts,
    });
    if (loaded.kind === "external") {
      return { candidates: [], externalPackage: formatExternalFqn(loaded.fqn) };
    }
    if (loaded.kind !== "project") {
      return { candidates: [], externalPackage: null };
    }

    curSummary = loaded.summary;
    curFile = loaded.absPath;
    curService = loaded.service;

    const findInLoaded = (n) => (loaded.summary.types || []).find((x) => x.name === n) || null;
    const next = javaNav.advanceJavaContainerOrBuilderType(loaded.tRec.name, curArgs, step, findInLoaded);
    if (!next || !next.typeName) {
      return { candidates: [], externalPackage: null };
    }
    curType = next.typeName;
    curArgs = next.genericArgs || [];
  }

  if (!curType) return { candidates: [], externalPackage: null };

  const isBuilder = curType.startsWith(builderPrefix);
  const targetType = isBuilder ? curType.slice(builderPrefix.length) : curType;
  const targetRes = await loadJavaTypeRecord({
    simpleType: targetType,
    originSummary: curSummary,
    fromFilePath: curFile,
    service: curService,
    allServices,
    ioOpts,
  });
  if (targetRes.kind === "external") {
    return { candidates: [], externalPackage: formatExternalFqn(targetRes.fqn) };
  }
  if (targetRes.kind !== "project") {
    return { candidates: [], externalPackage: null };
  }

  const cands = findMemberInTypeRecord(
    targetRes.tRec,
    memberName,
    targetRes.absPath,
    "java",
    isBuilder ? { ...context, builderTarget: true } : context
  ).map((c) => attachServiceMeta(c, targetRes.service));
  if (cands.length > 0) {
    return { candidates: cands, externalPackage: null };
  }
  const fallback = isBuilder
    ? findJavaTypeOrMemberInSummary(targetRes.summary, targetRes.absPath, targetRes.tRec.name, null, context).map((c) =>
        attachServiceMeta(c, targetRes.service)
      )
    : await resolveJavaMemberInHierarchy({
        loaded: targetRes,
        simpleTypeName: targetRes.tRec.name,
        memberName,
        allServices,
        ioOpts,
        context,
      });
  return { candidates: fallback, externalPackage: null };
}

function findJavaTypeOrMemberInSummary(summary, absPath, simpleTypeName, memberName, context) {
  if (!summary) return [];
  const tRec = (summary.types || []).find((t) => t.name === simpleTypeName);
  if (!tRec) return [];
  if (memberName) {
    const memberCands = findMemberInTypeRecord(tRec, memberName, absPath, "java", context);
    if (memberCands.length > 0) return memberCands;
  }
  if (context?.isCall && context?.isNewExpr) {
    const wantArity = Number.isFinite(context.arity) ? context.arity : null;
    const ctors = (tRec.constructors || []).filter((c) => wantArity === null || c.arity === wantArity);
    const list = ctors.length > 0 ? ctors : tRec.constructors || [];
    if (list.length > 0) {
      return list.map((c) =>
        normalizeNavCandidate(
          {
            filePath: absPath,
            line: c.line,
            column: c.column,
            name: tRec.name,
            kind: "constructor",
            containerName: tRec.name,
            signature: c.signature,
            arity: c.arity,
            lang: "java",
            score: 165,
          },
          { filePath: absPath, lang: "java" }
        )
      );
    }
  }
  return [
    normalizeNavCandidate(
      {
        filePath: absPath,
        line: tRec.line,
        column: tRec.column,
        name: tRec.name,
        kind: tRec.kind || "class",
        containerName: summary.packageName || "",
        isAbstract: Boolean(tRec.isAbstract),
        lang: "java",
        score: 155,
      },
      { filePath: absPath, lang: "java" }
    ),
  ];
}

async function resolveJavaImportHint({ importHint, currentSummary, fromFilePath, service, allServices, ioOpts, context }) {
  if (importHint?.receiverChain && importHint.memberName) {
    const chainRes = await resolveJavaReceiverChain({
      chainInfo: importHint.receiverChain,
      memberName: importHint.memberName,
      currentSummary,
      fromFilePath,
      service,
      allServices,
      ioOpts,
      context,
    });
    if (chainRes.candidates.length > 0 || chainRes.externalPackage) {
      return chainRes;
    }
  }

  const pkgName = currentSummary?.packageName || "";
  const fqn = importHint?.qualifiedName || "";
  const isWildcard = Boolean(importHint?.isWildcard);
  const rawTypeName = importHint?.typeName || (!isWildcard ? importHint?.importedName : null) || context.symbol;
  const memberName = importHint?.memberName || null;

  const isJdkPackage = fqn && KNOWN_JAVA_EXTERNAL_PREFIXES.some((p) => fqn.startsWith(p));
  const candidateFqns = [];
  if (fqn && !isWildcard) {
    // Handle `com.acme.Ids.nextId` -> static member on `com.acme.Ids`, OR inner class `com.acme.Outer.Inner`
    if (importHint?.isStatic && importHint?.specifier) {
      candidateFqns.push({ typeFqn: importHint.specifier, simpleType: basenameFs(importHint.specifier.replace(/\./g, "/")), member: importHint.memberName });
    } else {
      candidateFqns.push({ typeFqn: fqn, simpleType: rawTypeName, member: memberName });
      const parts = fqn.split(".");
      if (parts.length >= 2) {
        candidateFqns.push({ typeFqn: parts.slice(0, -1).join("."), simpleType: parts[parts.length - 1], member: memberName });
      }
    }
  } else if (isWildcard && importHint?.specifier && rawTypeName) {
    candidateFqns.push({ typeFqn: `${importHint.specifier}.${rawTypeName}`, simpleType: rawTypeName, member: memberName });
  } else if (pkgName && rawTypeName) {
    candidateFqns.push({ typeFqn: `${pkgName}.${rawTypeName}`, simpleType: rawTypeName, member: memberName });
  }

  if (!isJdkPackage) {
    const candidateServices = [service, ...allServices.filter((s) => s.root !== service.root)];
    for (let si = 0; si < candidateServices.length; si += 1) {
      const svc = candidateServices[si];
      const srcRoots = si === 0 ? inferJavaSourceRoots(fromFilePath, pkgName, svc.root) : inferJavaSourceRoots("", "", svc.root);
      for (const item of candidateFqns) {
        const relFile = `${item.typeFqn.replace(/\./g, "/")}.java`;
        const probes = srcRoots.map((sr) => joinFsPath(sr, relFile));
        const loaded = await probeFirstReadablePath(probes, svc, ioOpts);
        if (loaded) {
          const cands = await resolveJavaMemberInHierarchy({
            loaded: { ...loaded, service: svc },
            simpleTypeName: item.simpleType,
            memberName: item.member,
            allServices,
            ioOpts,
            context,
          });
          if (cands.length > 0) return { candidates: cands, externalPackage: null };
        }
      }
    }
  }

  if (fqn && fqn.includes(".")) {
    return { candidates: [], externalPackage: fqn };
  }
  return { candidates: [], externalPackage: null };
}

// ---------- Level 3: Polymorphic Implementation Fan-out & Workspace Grep Fallback ----------

function collectSummaryMatchesForSymbol(summary, absPath, service, context, { targetTypeName = null } = {}) {
  const symbol = context.symbol;
  if (!symbol || !summary) return [];
  const lang = summary.lang;
  const out = [];

  for (const t of summary.types || []) {
    if (t.name === symbol && (!targetTypeName || t.name === targetTypeName)) {
      out.push(
        attachServiceMeta(
          {
            filePath: absPath,
            line: t.line,
            column: t.column,
            name: t.name,
            kind: t.kind || "class",
            containerName: summary.packageName || "",
            isAbstract: Boolean(t.isAbstract),
            lang,
            score: context.isTypeContext ? 150 : 120,
          },
          service
        )
      );
    }
    if (!targetTypeName || t.name === targetTypeName) {
      const mCands = findMemberInTypeRecord(t, symbol, absPath, lang, context);
      for (const mc of mCands) out.push(attachServiceMeta(mc, service));
    }
  }

  if (!targetTypeName) {
    for (const fn of summary.functions || []) {
      if (fn.name === symbol && !fn.containerName) {
        out.push(
          attachServiceMeta(
            {
              filePath: absPath,
              line: fn.line,
              column: fn.column,
              name: fn.name,
              kind: fn.kind || "function",
              arity: fn.arity ?? null,
              signature: fn.signature || "",
              lang,
              score: context.isCall ? 140 : 125,
            },
            service
          )
        );
      }
    }
    for (const v of summary.topVariables || []) {
      if (v.name === symbol) {
        out.push(
          attachServiceMeta(
            {
              filePath: absPath,
              line: v.line,
              column: v.column,
              name: v.name,
              kind: v.kind || "variable",
              signature: v.signature || "",
              lang,
              score: 120,
            },
            service
          )
        );
      }
    }
  }

  return out;
}

function findEnclosingAbstractDecl(summary, context) {
  if (!summary || !context?.symbol) return null;
  for (const t of summary.types || []) {
    if (t.name === context.symbol && Math.abs((t.line || 0) - context.line) <= 1 && t.isAbstract) {
      return { typeName: t.name, methodName: null };
    }
    for (const m of t.methods || []) {
      if (m.name === context.symbol && Math.abs((m.line || 0) - context.line) <= 1 && (t.isAbstract || m.isAbstract)) {
        return { typeName: t.name, methodName: m.name };
      }
    }
  }
  return null;
}

function buildSubtypeSearchRegex(parentTypeName, lang, multiline = false) {
  const esc = parentTypeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (lang === "python") return `class\\s+\\w+\\([^)]*\\b${esc}\\b`;
  if (multiline) return `\\b(?:implements|extends)\\b[^{;]{0,600}\\b${esc}\\b`;
  return `\\b(?:implements|extends)\\b[^{;]*\\b${esc}\\b`;
}

function parseMatchedFilesFromGrep(stdout, service) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(joinFsPath(service.root, line));
    if (out.length >= MAX_GREP_MATCH_FILES) break;
  }
  return out;
}

async function grepServiceFiles(pattern, lang, service, ioOpts, opts = {}) {
  const run = ioOpts.execFn || exec;
  const trackRg = !ioOpts.execFn;
  const on = service?.on ?? ioOpts.on ?? null;
  const onKey = on ?? "local";
  const globs = (LANG_RG_GLOBS[lang] || []).flatMap((g) => ["--glob", g]);
  const multiline = Boolean(opts?.multiline);
  const gitFallbackPattern = opts?.gitFallbackPattern || pattern;

  if (!trackRg || isRgAvailable(onKey) !== false) {
    const rgArgs = ["-l"];
    if (multiline) rgArgs.push("-U");
    rgArgs.push(
      "--no-heading",
      "--color=never",
      "--path-separator",
      "/",
      "--max-filesize",
      "512K",
      "--threads",
      "4",
      ...COMMON_IGNORE_GLOBS,
      "--glob",
      "!*.min.js",
      "--glob",
      "!*.bundle.js",
      ...globs,
      "--",
      pattern,
      ".",
    );
    const rgRes = await run("rg", rgArgs, { cwd: service.root, on, timeout: 5000 }).catch(() => null);
    if (rgRes && rgRes.code === 0) {
      if (trackRg) markRgAvailable(onKey, true);
      return rgRes.stdout ? parseMatchedFilesFromGrep(rgRes.stdout, service) : [];
    }
    if (rgRes && rgRes.code === 1) {
      if (trackRg) markRgAvailable(onKey, true);
      return [];
    }
    if (trackRg) {
      const probe = await run("rg", ["--version"], { cwd: service.root, on, timeout: 1500 }).catch(() => null);
      markRgAvailable(onKey, Boolean(probe && probe.code === 0));
    }
  }

  // Fallback lock-free git grep when rg is unavailable
  const gitPathspecs = LANG_GIT_PATHSPECS[lang] || [];
  const gitRes = await run(
    "git",
    [...READ_GIT, "grep", "-l", "-E", "-e", gitFallbackPattern, ...gitPathspecs],
    { cwd: service.root, on, timeout: 5000 }
  ).catch(() => null);
  if (gitRes && gitRes.code === 0 && gitRes.stdout) {
    return parseMatchedFilesFromGrep(gitRes.stdout, service);
  }
  return [];
}

async function resolveSubtypeImplementations({
  parentTypeName,
  methodName,
  lang,
  allServices,
  currentSummary = null,
  currentFilePath = "",
  owningService = null,
  ioOpts,
  context,
  appHomeDir,
}) {
  const results = [];
  const visitedTypes = new Set([parentTypeName]);
  const queue = [{ typeName: parentTypeName, depth: 0 }];
  const MAX_SUBTYPE_DEPTH = 4;
  const MAX_SUBTYPE_TYPES = 24;

  const inspectSummaryForParent = (summary, abs, svc, targetParent, depth) => {
    for (const t of summary?.types || []) {
      const isChild = [...(t.extends || []), ...(t.implements || [])].some(
        (p) => String(p).replace(/<.*$/, "").split(".").pop() === targetParent
      );
      if (!isChild) continue;
      if (methodName) {
        const wantArity = Number.isFinite(context?.arity) ? context.arity : null;
        for (const c of findMemberInTypeRecord(t, methodName, abs, lang, context)) {
          const arityAdj = wantArity !== null && Number.isFinite(c.arity) ? (c.arity === wantArity ? 30 : -20) : 0;
          results.push(attachServiceMeta({ ...c, score: (c.isAbstract ? 110 : 180) + arityAdj }, svc));
        }
      } else if (!t.isAbstract) {
        results.push(
          attachServiceMeta(
            {
              filePath: abs,
              line: t.line,
              column: t.column,
              name: t.name,
              kind: t.kind || "class",
              containerName: summary.packageName || "",
              signature: `${t.kind || "class"} ${t.name}`,
              isAbstract: false,
              lang,
              score: 180,
            },
            svc
          )
        );
      }
      if (
        t.name &&
        !visitedTypes.has(t.name) &&
        depth + 1 < MAX_SUBTYPE_DEPTH &&
        visitedTypes.size < MAX_SUBTYPE_TYPES
      ) {
        visitedTypes.add(t.name);
        queue.push({ typeName: t.name, depth: depth + 1 });
      }
    }
  };

  while (queue.length > 0) {
    const { typeName: curParent, depth } = queue.shift();
    const visitedFiles = new Set();

    if (currentSummary && currentFilePath && owningService) {
      visitedFiles.add(normPathStr(currentFilePath));
      inspectSummaryForParent(currentSummary, normPathStr(currentFilePath), owningService, curParent, depth);
    }

    await runInBatches(allServices, 4, async (svc) => {
      const idx = getOrCreateServiceIndex(svc);
      await loadServiceDiskIndex(idx, appHomeDir);

      const indexedRels = idx.subtypesByParent.get(curParent);
      if (indexedRels) {
        for (const rel of indexedRels) {
          const ent = idx.files.get(rel);
          const abs = joinFsPath(svc.root, rel);
          if (!ent || ent.lang !== lang || visitedFiles.has(abs)) continue;
          visitedFiles.add(abs);
          inspectSummaryForParent(ent.summary, abs, svc, curParent, depth);
        }
      }

      // Live multiline grep for subtypes (handles Spotless multi-line implements/extends & unwarmed services)
      const escParent = curParent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = buildSubtypeSearchRegex(curParent, lang, lang === "java" || lang === "js");
      const matchedAbsPaths = await grepServiceFiles(pattern, lang, svc, ioOpts, {
        multiline: lang === "java" || lang === "js",
        gitFallbackPattern: `\\b${escParent}\\b`,
      });
      await runInBatches(matchedAbsPaths, 5, async (abs) => {
        if (visitedFiles.has(abs)) return;
        visitedFiles.add(abs);
        const loaded = await analyzeFileAtPath(abs, svc, ioOpts);
        if (!loaded || loaded.summary.lang !== lang) return;
        inspectSummaryForParent(loaded.summary, abs, svc, curParent, depth);
      });
    });
  }

  return results;
}

async function searchWorkspaceSymbol({ symbol, lang, memberTypeHints = [], allServices, currentFilePath, ioOpts, context, appHomeDir }) {
  const typedResults = [];
  const fallbackResults = [];
  const visitedFiles = new Set([normPathStr(currentFilePath)]);
  const typeHint = memberTypeHints[0] || null;
  const escSym = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declPattern =
    lang === "python"
      ? `^\\s*(?:async\\s+)?(?:def|class)\\s+${escSym}\\b|^\\s*${escSym}\\s*(?::[^=]+=|=)`
      : lang === "java"
        ? `\\b(?:class|interface|enum|record|@interface)\\s+${escSym}\\b|\\b${escSym}\\s*\\(`
        : `(?:function\\s+${escSym}\\b|class\\s+${escSym}\\b|interface\\s+${escSym}\\b|type\\s+${escSym}\\b|\\b${escSym}\\s*[:=]|\\b${escSym}\\s*\\()`;

  const collectForFile = (summary, abs, svc) => {
    const matches = collectSummaryMatchesForSymbol(summary, abs, svc, context, { targetTypeName: typeHint });
    if (matches.length > 0) typedResults.push(...matches);
    if (typeHint && typedResults.length === 0) {
      const untyped = collectSummaryMatchesForSymbol(summary, abs, svc, context, { targetTypeName: null });
      if (untyped.length > 0) fallbackResults.push(...untyped);
    }
  };

  await runInBatches(allServices, 6, async (svc) => {
    const idx = getOrCreateServiceIndex(svc);
    await loadServiceDiskIndex(idx, appHomeDir);
    const indexedFiles = idx.symbolNames.get(symbol);
    if (!indexedFiles) return;
    for (const rel of indexedFiles) {
      const ent = idx.files.get(rel);
      const abs = joinFsPath(svc.root, rel);
      if (!ent || ent.lang !== lang || visitedFiles.has(abs)) continue;
      visitedFiles.add(abs);
      collectForFile(ent.summary, abs, svc);
    }
  });

  if (typedResults.length > 0) return typedResults;

  const preGrepped = new Map();
  await runInBatches(allServices, 4, async (svc) => {
    const paths = await grepServiceFiles(declPattern, lang, svc, ioOpts);
    preGrepped.set(svc, paths);
  });

  for (let si = 0; si < allServices.length; si += 1) {
    const svc = allServices[si];
    const grepPaths = preGrepped.get(svc) || [];
    await runInBatches(grepPaths, 5, async (abs) => {
      if (visitedFiles.has(abs)) return;
      visitedFiles.add(abs);
      const loaded = await analyzeFileAtPath(abs, svc, ioOpts);
      if (!loaded || loaded.summary.lang !== lang) return;
      collectForFile(loaded.summary, abs, svc);
    });
  }

  return typedResults.length > 0 ? typedResults : fallbackResults;
}

// ---------- Top-Level Resolution Pipeline ----------

function finalizeNavigationResult(rawCandidates, context, { externalPackage = null } = {}) {
  const deduped = dedupeNavCandidates(rankNavCandidates(rawCandidates, context));
  let candidates = deduped;

  // For function/method implementation navigation, if any concrete implementation exists,
  // prefer navigating cleanly to concrete implementations instead of popping a picker with the abstract signature.
  if (context?.intent === "implementation") {
    const concrete = deduped.filter((c) => !c.isAbstract);
    if (concrete.length > 0) {
      candidates = concrete;
    }
  }

  if (candidates.length === 0) {
    if (externalPackage) {
      return {
        status: "external",
        candidates: [],
        best: null,
        context,
        externalPackage,
        message: `External library symbol: ${externalPackage}`,
      };
    }
    return {
      status: "not-found",
      candidates: [],
      best: null,
      context,
      externalPackage: null,
      message: context?.symbol ? `No target found for "${context.symbol}"` : "No navigable symbol at cursor",
    };
  }

  if (candidates.length === 1) {
    return {
      status: "ok",
      candidates,
      best: candidates[0],
      context,
      externalPackage: null,
      message: `Navigate to ${candidates[0].name}`,
    };
  }

  // Multiple candidates: auto-pick when one clearly dominates (>25pts above runner-up); otherwise disambiguate.
  const topScore = candidates[0].score || 0;
  const closePeers = candidates.filter((c) => topScore - (c.score || 0) <= 25);
  if (closePeers.length > 1) {
    return {
      status: "ambiguous",
      candidates: closePeers,
      best: candidates[0],
      context,
      externalPackage: null,
      message: `Select implementation (${closePeers.length} targets)`,
    };
  }

  return {
    status: "ok",
    candidates: [candidates[0]],
    best: candidates[0],
    context,
    externalPackage: null,
    message: `Navigate to ${candidates[0].name}`,
  };
}

const MAX_REF_SCAN_FILES = 40;
const MAX_REF_RESULTS = 50;

function escapeRegExpStr(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findEnclosingSymbolName(summary, lineNo) {
  if (!summary || !Number.isFinite(lineNo)) return "";
  let bestName = "";
  let bestSpan = Infinity;
  const consider = (name, startLine, endLine) => {
    if (!name || !startLine) return;
    const end = endLine && endLine >= startLine ? endLine : startLine;
    if (lineNo >= startLine && lineNo <= end) {
      const span = end - startLine;
      if (span <= bestSpan) {
        bestSpan = span;
        bestName = name;
      }
    }
  };
  for (const fn of summary.functions || []) {
    consider(fn.name, fn.line, fn.endLine);
  }
  for (const t of summary.types || []) {
    consider(t.name, t.line, t.endLine);
    for (const c of t.constructors || []) {
      consider(`${t.name}.${c.name || t.name}`, c.line, c.endLine);
    }
    for (const m of t.methods || []) {
      consider(t.name ? `${t.name}.${m.name}` : m.name, m.line, m.endLine);
    }
  }
  return bestName;
}

function isReferenceImportLine(trimmedLine, lang) {
  if (!trimmedLine) return false;
  if (lang === "python") {
    return /^(?:import\s+|from\s+[A-Za-z0-9_.]+\s+import\s+)/.test(trimmedLine);
  }
  if (lang === "java") {
    return /^import\s+/.test(trimmedLine);
  }
  return /^(?:import\s+|export\s+\{[^}]*\}\s+from\s+)/.test(trimmedLine);
}

function finalizeReferencesResult(rawRefs, context) {
  const candidates = (rawRefs || []).slice(0, MAX_REF_RESULTS);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return {
      status: "ok",
      mode: "references",
      candidates,
      best: candidates[0],
      context,
      externalPackage: null,
      message: `Usage in ${basenameFs(candidates[0].filePath)}:${candidates[0].line}`,
    };
  }
  return {
    status: "ambiguous",
    mode: "references",
    candidates,
    best: candidates[0],
    context,
    externalPackage: null,
    message: `Select usage (${candidates.length} references)`,
  };
}

export async function findWorkspaceReferences({
  symbol,
  lang,
  declFilePath,
  declLine,
  declCol = 1,
  currentSummary = null,
  currentSourceText = "",
  owningService = null,
  allServices = [],
  ioOpts = {},
  scopeSameFileOnly = false,
} = {}) {
  const cleanSym = String(symbol || "").trim();
  if (!cleanSym || cleanSym.length < 2 || !lang) return [];

  const normDeclFile = normPathStr(declFilePath);
  const esc = escapeRegExpStr(cleanSym);
  const wordRe = new RegExp(`\\b${esc}\\b`, "g");
  const seenKeys = new Set();
  const refs = [];

  const scanText = (absPath, text, svc, preSummary = null) => {
    const normAbs = normPathStr(absPath);
    if (!normAbs || typeof text !== "string" || refs.length >= MAX_REF_RESULTS || !text.includes(cleanSym)) return;
    const rawLines = text.split(/\r?\n/);
    const maskedLines = maskNonCodeRegions(rawLines, lang);
    const sameFile = normAbs === normDeclFile;
    const sameService = owningService && svc && svc.root === owningService.root;
    let summary = preSummary;
    let summaryResolved = Boolean(preSummary);
    const svcIdx = svc?.root ? SERVICE_INDEX_MAP.get(makeServiceKey(normPathStr(svc.root), svc?.on ?? ioOpts?.on ?? null)) : null;
    const svcRel = svc?.root && isPathInsideRoot(normAbs, svc.root) ? toServiceRelPath(svc.root, normAbs) : "";

    for (let i = 0; i < maskedLines.length; i += 1) {
      const mLine = maskedLines[i];
      if (!mLine || !mLine.includes(cleanSym)) continue;
      wordRe.lastIndex = 0;
      let match;
      while ((match = wordRe.exec(mLine)) !== null) {
        const lineNo = i + 1;
        const matchCol = match.index + 1;
        if (
          sameFile &&
          lineNo === declLine &&
          ((declCol >= matchCol && declCol < matchCol + cleanSym.length) || Math.abs(matchCol - declCol) <= 2)
        ) {
          continue;
        }
        const rawTrimmed = String(rawLines[i] || "").trim();
        const isImport = isReferenceImportLine(rawTrimmed, lang);
        const dedupeKey = `${normAbs}:${lineNo}:${matchCol}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);

        if (!summaryResolved) {
          summaryResolved = true;
          summary = (svcIdx && svcRel ? svcIdx.files.get(svcRel)?.summary : null) || summarizeFileCached(normAbs, text);
        }
        const containerName = findEnclosingSymbolName(summary, lineNo);
        const baseScore = sameFile ? 130 : sameService ? 120 : 105;
        const isTestFile = /(?:^|\/)(?:__tests__|test|tests)\/|(?:\.test\.|\.spec\.|Test\.java$|_test\.py$)/i.test(normAbs);
        let cand = normalizeNavCandidate(
          {
            filePath: normAbs,
            root: svc?.root || owningService?.root || "",
            on: svc?.on ?? owningService?.on ?? ioOpts?.on ?? null,
            serviceId: svc?.id || "",
            serviceName: svc?.name || "",
            line: lineNo,
            column: matchCol,
            name: cleanSym,
            kind: isImport ? "import" : "reference",
            containerName,
            signature: rawTrimmed.slice(0, 120),
            lang,
            score: isImport ? 60 : baseScore - (isTestFile ? 10 : 0),
          },
          { filePath: normAbs, lang }
        );
        if (svc) cand = attachServiceMeta(cand, svc);
        refs.push(cand);
        if (refs.length >= MAX_REF_RESULTS) return;
      }
    }
  };

  const scannedFiles = new Set();
  if (normDeclFile && typeof currentSourceText === "string") {
    scannedFiles.add(normDeclFile);
    scanText(normDeclFile, currentSourceText, owningService, currentSummary);
  }

  if (!scopeSameFileOnly) {
    if (ioOpts?.openFilesTextMap && typeof ioOpts.openFilesTextMap.entries === "function") {
      for (const [openPath, openText] of ioOpts.openFilesTextMap.entries()) {
        const normOpen = normPathStr(openPath);
        if (!normOpen || scannedFiles.has(normOpen)) continue;
        const openLang = getNavLanguageAnalyzer(normOpen)?.lang;
        if (openLang !== lang) continue;
        scannedFiles.add(normOpen);
        const openSvc = findOwningService(normOpen, owningService?.root || "", allServices, ioOpts?.on ?? null);
        scanText(normOpen, openText, openSvc);
      }
    }

    const grepPattern = `\\b${esc}\\b`;
    const candidateTargets = [];
    const seenTargets = new Set(scannedFiles);

    await runInBatches(allServices, 4, async (svc) => {
      const matchedPaths = await grepServiceFiles(grepPattern, lang, svc, ioOpts);
      for (const p of matchedPaths) {
        const normP = normPathStr(p);
        if (!normP || seenTargets.has(normP)) continue;
        seenTargets.add(normP);
        candidateTargets.push({ absPath: normP, svc });
      }
      if (ioOpts?.readTextFn) {
        const idx = getOrCreateServiceIndex(svc);
        for (const rel of idx.files.keys()) {
          const abs = normPathStr(joinFsPath(svc.root, rel));
          if (!abs || seenTargets.has(abs)) continue;
          seenTargets.add(abs);
          candidateTargets.push({ absPath: abs, svc });
        }
      }
    });

    const cappedTargets = candidateTargets.slice(0, MAX_REF_SCAN_FILES);
    await runInBatches(cappedTargets, 6, async ({ absPath, svc }) => {
      if (refs.length >= MAX_REF_RESULTS) return;
      const text = await readTextCached(absPath, {
        on: svc?.on ?? ioOpts?.on ?? null,
        openFilesTextMap: ioOpts?.openFilesTextMap,
        readTextFn: ioOpts?.readTextFn,
      });
      if (typeof text === "string") {
        scanText(absPath, text, svc);
      }
    });
  }

  const realRefs = refs.filter((r) => r.kind !== "import");
  const finalRefs = realRefs.length > 0 ? realRefs : refs;
  finalRefs.sort((a, b) => {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
  return finalRefs.slice(0, MAX_REF_RESULTS);
}

function isCursorAtNavCandidate(cand, normFile, context) {
  if (!cand || !normFile || !context) return false;
  if (normPathStr(cand.filePath) !== normFile) return false;
  const candLine = Number(cand.line || 0);
  const ctxLine = Number(context.line || 0);
  if (candLine <= 0 || candLine !== ctxLine) return false;
  const tokCol = Number(context.tokenCol || context.col || 0);
  const candCol = Number(cand.column || 0);
  const symLen = Math.max(1, String(context.symbol || cand.name || "").length);
  if (tokCol > 0 && candCol > 0) {
    return (
      (candCol >= tokCol && candCol < tokCol + symLen) ||
      (tokCol >= candCol && tokCol < candCol + symLen)
    );
  }
  return Boolean(context.isDeclarationSignature);
}

export async function resolveCrossFileNavigation(params = {}) {
  const {
    sourceText = "",
    filePath = "",
    line = 1,
    col = 1,
    currentRoot = "",
    workspaceRoot = "",
    on = null,
    services = [],
    openFilesTextMap = null,
    indexedFilesByRoot = null,
    appHomeDir = null,
    readTextFn = null,
    execFn = null,
  } = params;

  const langInfo = getNavLanguageAnalyzer(filePath);
  if (!langInfo || typeof sourceText !== "string") {
    return {
      status: "not-found",
      candidates: [],
      best: null,
      context: params.context || null,
      externalPackage: null,
      message: "Navigation is available for JS/TS, Python, and Java files",
    };
  }

  const effectiveRoot = normPathStr(currentRoot || workspaceRoot || "");
  const rawNormFile = normPathStr(filePath);
  const isAbsRaw = rawNormFile.startsWith("/") || /^[A-Za-z]:\//.test(rawNormFile);
  const normFile = rawNormFile
    ? (isAbsRaw || !effectiveRoot ? rawNormFile : joinFsPath(effectiveRoot, rawNormFile))
    : "";

  const context = params.context || extractNavContext(sourceText, line, col, normFile || filePath);
  if (!context || (!context.symbol && !context.importModuleSpec)) {
    return {
      status: "not-found",
      candidates: [],
      best: null,
      context: null,
      externalPackage: null,
      message: "No navigable symbol at cursor",
    };
  }

  const { lang, analyzer } = langInfo;
  const owningService = findOwningService(normFile, effectiveRoot, services, on);
  const allServices = normalizeServiceList(services, owningService.root, normFile, on);
  // Put current service first for deterministic intra-service resolution priority
  allServices.sort((a, b) => (a.root === owningService.root ? -1 : b.root === owningService.root ? 1 : 0));

  const ioOpts = {
    on: owningService.on ?? on ?? null,
    openFilesTextMap,
    indexedFilesByRoot,
    appHomeDir,
    readTextFn,
    execFn,
  };

  // Level 1: Single-file semantic resolution
  const level1 = analyzer.resolveInFile(sourceText, context, normFile);
  const evalContext =
    Array.isArray(level1.callArgTypes) && (!context.callArgTypes || context.callArgTypes.length === 0)
      ? { ...context, callArgTypes: level1.callArgTypes }
      : context;
  const localCands = (level1.resolved || []).map((c) => attachServiceMeta(c, owningService));
  const bestLocal = localCands[0] || null;
  const localConcrete = localCands.filter((c) => !c.isAbstract);
  const currentSummary = summarizeFileCached(normFile, sourceText);
  const abstractAnchor = findEnclosingAbstractDecl(currentSummary, evalContext);

  // Fast exit when resolved cleanly within the current file (and not an abstract/interface decl or call needing polymorphic fan-out)
  if (
    bestLocal &&
    !abstractAnchor &&
    !(evalContext.intent === "implementation" && localConcrete.length === 0 && bestLocal.isAbstract)
  ) {
    const localResult = finalizeNavigationResult(localCands, evalContext);
    const clickedOwnDeclaration = isCursorAtNavCandidate(localResult.best, normFile, evalContext);
    if (localResult.status !== "already-there" && !clickedOwnDeclaration) {
      return localResult;
    }
    const bestKind = String(localResult.best?.kind || "").toLowerCase();
    const scopeSameFileOnly =
      bestKind === "variable" ||
      bestKind === "parameter" ||
      Boolean(localResult.best?.isPrivate);
    const refs = await findWorkspaceReferences({
      symbol: evalContext.symbol,
      lang,
      declFilePath: normFile,
      declLine: evalContext.line,
      declCol: evalContext.tokenCol || evalContext.col || 1,
      currentSummary,
      currentSourceText: sourceText,
      owningService,
      allServices,
      ioOpts,
      scopeSameFileOnly,
    });
    if (refs.length > 0) {
      return finalizeReferencesResult(refs, evalContext);
    }
    if (clickedOwnDeclaration && localResult.best) {
      return {
        status: "already-there",
        candidates: [localResult.best],
        best: localResult.best,
        context: evalContext,
        externalPackage: null,
        message: `Already at ${evalContext.symbol} declaration`,
      };
    }
    return localResult;
  }

  let externalPackage = null;
  let crossCandidates = [];

  // Level 2: Direct import / module / package resolution (skip self-type lookup when already anchored on a local interface/abstract decl)
  const hint = abstractAnchor ? null : level1.importHint;
  if (hint) {
    if (lang === "js" && (hint.specifier || context.importModuleSpec)) {
      const res2 = await resolveJsImportChain({
        specifier: hint.specifier || context.importModuleSpec,
        importedName: hint.importedName || context.symbol,
        memberName: hint.memberName || null,
        isDefault: Boolean(hint.isDefault),
        isNamespace: Boolean(hint.isNamespace),
        isTypeOnly: Boolean(hint.isTypeOnly),
        fromFilePath: normFile,
        service: owningService,
        allServices,
        ioOpts,
        context: evalContext,
      });
      crossCandidates.push(...res2.candidates);
      externalPackage = res2.externalPackage;
    } else if (lang === "python" && (hint.specifier || hint.relativeLevel || evalContext.importModuleSpec)) {
      const res2 = await resolvePythonImportChain({
        specifier: hint.specifier || evalContext.importModuleSpec || "",
        relativeLevel: hint.relativeLevel || 0,
        importedName: hint.importedName || evalContext.symbol,
        memberName: hint.memberName || null,
        fromFilePath: normFile,
        service: owningService,
        allServices,
        ioOpts,
        context: evalContext,
      });
      crossCandidates.push(...res2.candidates);
      externalPackage = res2.externalPackage;
    } else if (lang === "java") {
      const res2 = await resolveJavaImportHint({
        importHint: hint,
        currentSummary,
        fromFilePath: normFile,
        service: owningService,
        allServices,
        ioOpts,
        context: evalContext,
      });
      crossCandidates.push(...res2.candidates);
      externalPackage = res2.externalPackage;
    }
  } else if (evalContext.isImportLine && evalContext.importModuleSpec) {
    // Cursor directly on module path string (`import ... from "./utils"`)
    if (lang === "js") {
      const res2 = await resolveJsImportChain({
        specifier: evalContext.importModuleSpec,
        importedName: "",
        fromFilePath: normFile,
        service: owningService,
        allServices,
        ioOpts,
        context: evalContext,
      });
      crossCandidates.push(...res2.candidates);
      externalPackage = res2.externalPackage;
    } else if (lang === "python") {
      const res2 = await resolvePythonImportChain({
        specifier: evalContext.importModuleSpec,
        importedName: "",
        fromFilePath: normFile,
        service: owningService,
        allServices,
        ioOpts,
        context: evalContext,
      });
      crossCandidates.push(...res2.candidates);
      externalPackage = res2.externalPackage;
    }
  } else if (lang === "java" && currentSummary?.packageName && evalContext.symbol && (evalContext.isTypeContext || evalContext.isNewExpr || /^[A-Z]/.test(evalContext.symbol))) {
    // Unimported same-package Java class reference
    const res2 = await resolveJavaImportHint({
      importHint: { typeName: evalContext.symbol, qualifiedName: `${currentSummary.packageName}.${evalContext.symbol}` },
      currentSummary,
      fromFilePath: normFile,
      service: owningService,
      allServices,
      ioOpts,
      context: evalContext,
    });
    crossCandidates.push(...res2.candidates);
  }

  // Level 3A: Polymorphic concrete implementations when anchored on an interface/abstract decl or calling an abstract method
  const resolvedTop = rankNavCandidates([...localCands, ...crossCandidates], evalContext)[0] || null;
  const shouldResolveSubtypes = Boolean(
    abstractAnchor || (evalContext.intent === "implementation" && resolvedTop && resolvedTop.isAbstract)
  );
  if (shouldResolveSubtypes) {
    const parentType = abstractAnchor?.typeName || resolvedTop?.containerName || level1.importHint?.typeName || level1.memberTypeHints?.[0] || null;
    const targetMethod = abstractAnchor ? abstractAnchor.methodName : evalContext.symbol;
    if (parentType) {
      const subCands = await resolveSubtypeImplementations({
        parentTypeName: parentType,
        methodName: targetMethod,
        lang,
        allServices,
        currentSummary,
        currentFilePath: normFile,
        owningService,
        ioOpts,
        context: evalContext,
        appHomeDir,
      });
      crossCandidates.push(...subCands);
    }
  }

  // When cursor is directly on an interface/abstract declaration, prioritize non-self concrete implementations;
  // if none exist (e.g., Spring Data JpaRepository proxy), fall back cleanly to workspace references.
  if (abstractAnchor) {
    const implContext = { ...evalContext, intent: "implementation" };
    const concreteImpls = [...localCands, ...crossCandidates].filter(
      (c) => !c.isAbstract && !isCursorAtNavCandidate(c, normFile, evalContext)
    );
    if (concreteImpls.length > 0) {
      return finalizeNavigationResult(concreteImpls, implContext);
    }
    const refs = await findWorkspaceReferences({
      symbol: evalContext.symbol,
      lang,
      declFilePath: normFile,
      declLine: evalContext.line,
      declCol: evalContext.tokenCol || evalContext.col || 1,
      currentSummary,
      currentSourceText: sourceText,
      owningService,
      allServices,
      ioOpts,
    });
    if (refs.length > 0) {
      return finalizeReferencesResult(refs, evalContext);
    }
    const selfBest = localCands.find((c) => isCursorAtNavCandidate(c, normFile, evalContext)) || localCands[0] || null;
    if (selfBest) {
      return {
        status: "already-there",
        candidates: [selfBest],
        best: selfBest,
        context: evalContext,
        externalPackage: null,
        message: `No implementations found for ${evalContext.symbol}`,
      };
    }
  }

  // Level 3B: Workspace symbol index & grep fallback when still unresolved (or abstract-only)
  if (crossCandidates.length === 0 && localConcrete.length === 0 && !externalPackage && evalContext.symbol) {
    if (evalContext.isDeclarationSignature) {
      const refs = await findWorkspaceReferences({
        symbol: evalContext.symbol,
        lang,
        declFilePath: normFile,
        declLine: evalContext.line,
        declCol: evalContext.tokenCol || evalContext.col || 1,
        currentSummary,
        currentSourceText: sourceText,
        owningService,
        allServices,
        ioOpts,
      });
      if (refs.length > 0) {
        return finalizeReferencesResult(refs, evalContext);
      }
      const declSelf = attachServiceMeta(
        normalizeNavCandidate(
          {
            filePath: normFile,
            line: evalContext.line,
            column: evalContext.tokenCol || evalContext.col || 1,
            name: evalContext.symbol,
            kind: "declaration",
            containerName: findEnclosingSymbolName(currentSummary, evalContext.line),
            signature: String(evalContext.lineText || "").trim().slice(0, 120),
            lang,
            score: 150,
          },
          { filePath: normFile, lang }
        ),
        owningService
      );
      return {
        status: "already-there",
        candidates: [declSelf],
        best: declSelf,
        context: evalContext,
        externalPackage: null,
        message: `Already at ${evalContext.symbol} declaration`,
      };
    }

    if (evalContext.enclosingAnnotation) {
      return {
        status: "external",
        candidates: [],
        best: null,
        context: evalContext,
        externalPackage: evalContext.enclosingAnnotation,
        message: `Annotation attribute on @${evalContext.enclosingAnnotation}`,
      };
    }

    const builtinRoot = getKnownBuiltinRoot(evalContext, lang);
    if (builtinRoot) {
      return {
        status: "external",
        candidates: [],
        best: null,
        context: evalContext,
        externalPackage: builtinRoot,
        message: `External built-in/stdlib: ${builtinRoot}`,
      };
    }

    const wsCands = await searchWorkspaceSymbol({
      symbol: evalContext.symbol,
      lang,
      memberTypeHints: level1.memberTypeHints || [],
      allServices,
      currentFilePath: normFile,
      ioOpts,
      context: evalContext,
      appHomeDir,
    });
    crossCandidates.push(...wsCands);
  }

  const allCands = [...localCands, ...crossCandidates];
  return finalizeNavigationResult(allCands, evalContext, {
    externalPackage: allCands.length === 0 ? externalPackage : null,
  });
}
