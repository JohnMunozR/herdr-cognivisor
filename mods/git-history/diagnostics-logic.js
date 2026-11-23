// Canonical pure diagnostic logging, redaction, ring-buffer, and JSON report builder.
// Zero external/host dependencies: executes identically under Node `--test` and GPUI QuickJS.

export const DIAGNOSTICS_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_RING_ENTRIES = 250;
export const DEFAULT_MAX_MERGED_ENTRIES = 1250;
export const DEFAULT_MAX_REPORT_FILES = 10;
export const DEFAULT_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_STRING_LEN = 512;
export const DEFAULT_MAX_STACK_LEN = 2048;

const FORBIDDEN_KEY_SET = new Set([
  "content",
  "source",
  "sourcetext",
  "rawtext",
  "diff",
  "patch",
  "hunk",
  "hunks",
  "transcript",
  "commenttext",
  "notetext",
  "commitmessage",
  "messagebody",
  "querytext",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "env",
]);

const VALID_LEVELS = new Set(["action", "lifecycle", "info", "warn", "error", "perf"]);

/**
 * Redact secrets, credentials, and user home-directory prefixes from a string,
 * clamping length safely to prevent oversized log payloads.
 */
export function redactString(input, opts = {}) {
  if (input === null || input === undefined) return "";
  let str = String(input);
  const maskHomeDir = opts.maskHomeDir !== false;
  const maxLen = Number.isFinite(Number(opts.maxLen)) && Number(opts.maxLen) > 0
    ? Math.trunc(Number(opts.maxLen))
    : DEFAULT_MAX_STRING_LEN;

  // Mask URL credentials: https://user:pass@host -> https://[redacted]@host
  str = str.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@:]+):([^/\s@]+)@/g, "$1[redacted]@");
  // Mask Bearer / Basic authorization tokens
  str = str.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  // Mask common token prefixes (GitHub, OpenAI/Anthropic, AWS, Slack)
  str = str.replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|sk|xoxb|xoxp|AKIA)[_-]?[A-Za-z0-9_-]{12,}\b/g, "[redacted-token]");
  // Mask key=value secret assignments (skip already-redacted Bearer/Basic values)
  str = str.replace(/\b(token|api[_-]?key|secret|password|passwd|authorization)\s*[:=]\s*(?!Bearer\s+\[redacted\]|Basic\s+\[redacted\]|\[redacted\])["']?[^\s"',;]{4,}["']?/gi, "$1=[redacted]");

  if (maskHomeDir) {
    // Windows C:\Users\<name> or C:/Users/<name>
    str = str.replace(/[a-zA-Z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, "~");
    // POSIX /home/<name> or /Users/<name>
    str = str.replace(/\/(?:home|Users)\/[^/\s"']+/g, "~");
  }

  if (str.length > maxLen) {
    str = str.slice(0, Math.max(0, maxLen - 1)) + "…";
  }
  return str;
}

/**
 * Safely serialize any thrown value (Error, null, undefined, primitive, or object)
 * into a deterministic JSON-safe structure.
 */
export function serializeError(err, opts = {}) {
  const maskHomeDir = opts.maskHomeDir !== false;
  if (err === null) {
    return {
      type: "null",
      name: "NullException",
      message: "Null exception thrown",
      stack: "",
    };
  }
  if (err === undefined) {
    return {
      type: "undefined",
      name: "UndefinedException",
      message: "Undefined exception thrown",
      stack: "",
    };
  }
  if (typeof err === "string") {
    return {
      type: "string",
      name: "ThrownString",
      message: redactString(err, { maskHomeDir, maxLen: DEFAULT_MAX_STRING_LEN }),
      stack: "",
    };
  }
  if (typeof err === "number" || typeof err === "boolean") {
    return {
      type: typeof err,
      name: "ThrownPrimitive",
      message: String(err),
      stack: "",
    };
  }
  if (typeof err === "object") {
    const isErrObj = err instanceof Error || typeof err.message === "string" || typeof err.stack === "string";
    const name = redactString(err.name || (isErrObj ? "Error" : "ThrownObject"), { maskHomeDir, maxLen: 120 });
    const rawMsg = typeof err.message === "string"
      ? err.message
      : (() => {
          try {
            return JSON.stringify(err);
          } catch {
            return String(err);
          }
        })();
    const out = {
      type: isErrObj ? "error" : "object",
      name,
      message: redactString(rawMsg, { maskHomeDir, maxLen: DEFAULT_MAX_STRING_LEN }),
      stack: typeof err.stack === "string"
        ? redactString(err.stack, { maskHomeDir, maxLen: DEFAULT_MAX_STACK_LEN })
        : "",
    };
    if (err.code !== undefined && err.code !== null) {
      out.code = redactString(String(err.code), { maskHomeDir, maxLen: 64 });
    }
    return out;
  }
  return {
    type: typeof err,
    name: "UnknownException",
    message: redactString(String(err), { maskHomeDir, maxLen: DEFAULT_MAX_STRING_LEN }),
    stack: "",
  };
}

/**
 * Recursively sanitize metadata payloads: redacts forbidden keys, caps depth/array/key counts,
 * guards circular references, and applies redactString to all string leaves.
 */
export function sanitizeLogPayload(value, opts = {}) {
  const maskHomeDir = opts.maskHomeDir !== false;
  const maxDepth = Number.isFinite(Number(opts.maxDepth)) ? Math.max(1, Math.trunc(Number(opts.maxDepth))) : 3;
  const maxKeys = Number.isFinite(Number(opts.maxKeys)) ? Math.max(1, Math.trunc(Number(opts.maxKeys))) : 24;
  const maxArrayLen = Number.isFinite(Number(opts.maxArrayLen)) ? Math.max(1, Math.trunc(Number(opts.maxArrayLen))) : 20;
  const seen = new WeakSet();

  function walk(val, depth) {
    if (val === null || val === undefined) return val === undefined ? null : null;
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return Number.isFinite(val) ? val : null;
    if (typeof val === "string") return redactString(val, { maskHomeDir, maxLen: DEFAULT_MAX_STRING_LEN });
    if (typeof val !== "object") return redactString(String(val), { maskHomeDir, maxLen: 128 });
    if (val instanceof Error) return serializeError(val, { maskHomeDir });

    if (seen.has(val)) return "[circular]";
    if (depth >= maxDepth) {
      return Array.isArray(val) ? `[array(${val.length})]` : "[object]";
    }
    seen.add(val);

    if (Array.isArray(val)) {
      const out = [];
      const limit = Math.min(val.length, maxArrayLen);
      for (let i = 0; i < limit; i += 1) {
        out.push(walk(val[i], depth + 1));
      }
      if (val.length > maxArrayLen) {
        out.push(`…(+${val.length - maxArrayLen})`);
      }
      return out;
    }

    const out = {};
    const keys = Object.keys(val);
    let count = 0;
    for (const k of keys) {
      if (count >= maxKeys) {
        out._truncatedKeys = keys.length - count;
        break;
      }
      const lower = k.toLowerCase();
      if (FORBIDDEN_KEY_SET.has(lower)) {
        out[k] = "[redacted]";
      } else {
        const v = val[k];
        if (v !== undefined) {
          out[k] = walk(v, depth + 1);
        }
      }
      count += 1;
    }
    return out;
  }

  if (value === undefined || value === null) return undefined;
  return walk(value, 0);
}

/**
 * Normalize a raw log entry to the canonical schema.
 */
export function normalizeLogEntry(raw, fallbackMod = "", opts = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const tsNum = Number(raw.ts);
  const ts = Number.isFinite(tsNum) && tsNum > 0 ? Math.trunc(tsNum) : Date.now();
  const seqNum = Number(raw.seq);
  const seq = Number.isFinite(seqNum) && seqNum >= 0 ? Math.trunc(seqNum) : 0;
  const mod = redactString(raw.mod || fallbackMod || "unknown", { maskHomeDir: false, maxLen: 64 });
  const level = VALID_LEVELS.has(raw.level) ? raw.level : "info";
  const event = redactString(raw.event || "event", { maskHomeDir: false, maxLen: 120 });

  const entry = { ts, seq, mod, level, event };
  if (raw.durationMs !== undefined && Number.isFinite(Number(raw.durationMs))) {
    entry.durationMs = Math.max(0, Math.round(Number(raw.durationMs)));
  }
  if (raw.data !== undefined && raw.data !== null) {
    entry.data = sanitizeLogPayload(raw.data, opts);
  }
  if (Object.prototype.hasOwnProperty.call(raw, "error") && raw.error !== undefined) {
    entry.error =
      raw.error !== null && typeof raw.error === "object" && typeof raw.error.type === "string" && typeof raw.error.name === "string"
        ? {
            type: String(raw.error.type),
            name: redactString(raw.error.name, { maskHomeDir: opts.maskHomeDir !== false, maxLen: 120 }),
            message: redactString(raw.error.message || "", { maskHomeDir: opts.maskHomeDir !== false, maxLen: DEFAULT_MAX_STRING_LEN }),
            stack: redactString(raw.error.stack || "", { maskHomeDir: opts.maskHomeDir !== false, maxLen: DEFAULT_MAX_STACK_LEN }),
            ...(raw.error.code ? { code: redactString(raw.error.code, { maskHomeDir: false, maxLen: 64 }) } : {}),
          }
        : serializeError(raw.error, opts);
  }
  return entry;
}

/**
 * Bounded FIFO ring buffer for in-memory per-mod log retention.
 */
export function createRingBuffer(maxEntries = DEFAULT_MAX_RING_ENTRIES) {
  const cap = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0
    ? Math.trunc(Number(maxEntries))
    : DEFAULT_MAX_RING_ENTRIES;
  let items = [];

  return {
    capacity: cap,
    push(entry) {
      if (!entry) return;
      items.push(entry);
      if (items.length > cap) {
        items = items.slice(items.length - cap);
      }
    },
    load(list) {
      if (!Array.isArray(list)) return;
      items = list.filter(Boolean).slice(-cap);
    },
    toArray() {
      return items.slice();
    },
    size() {
      return items.length;
    },
    clear() {
      items = [];
    },
  };
}

/**
 * Merge multiple per-mod entry arrays chronologically by (ts, seq, mod),
 * capping total size to the most recent maxTotalEntries items.
 */
export function mergeDiagnosticStreams(streams, opts = {}) {
  const maxTotal = Number.isFinite(Number(opts.maxTotalEntries)) && Number(opts.maxTotalEntries) > 0
    ? Math.trunc(Number(opts.maxTotalEntries))
    : DEFAULT_MAX_MERGED_ENTRIES;

  const merged = [];
  for (const stream of Array.isArray(streams) ? streams : []) {
    const fallbackMod = stream?.mod || "";
    const entries = Array.isArray(stream) ? stream : (Array.isArray(stream?.entries) ? stream.entries : []);
    for (const raw of entries) {
      const norm = normalizeLogEntry(raw, fallbackMod, opts);
      if (norm) merged.push(norm);
    }
  }

  merged.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.mod.localeCompare(b.mod);
  });

  if (merged.length > maxTotal) {
    return merged.slice(merged.length - maxTotal);
  }
  return merged;
}

/**
 * Assemble a self-contained, sanitized diagnostic JSON report suitable for bug reports.
 */
export function buildDiagnosticReport({
  trigger = "manual",
  environment = {},
  stateSnapshot = {},
  streams = [],
  exportedAt = new Date().toISOString(),
  maskHomeDir = true,
  maxTotalEntries = DEFAULT_MAX_MERGED_ENTRIES,
} = {}) {
  const timeline = mergeDiagnosticStreams(streams, { maskHomeDir, maxTotalEntries });
  const errors = timeline.filter((e) => e.level === "error");
  const warnCount = timeline.reduce((n, e) => n + (e.level === "warn" ? 1 : 0), 0);
  const modsIncluded = Array.from(new Set(timeline.map((e) => e.mod).filter(Boolean))).sort();

  return {
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    exportedAt: String(exportedAt || new Date().toISOString()),
    trigger: redactString(trigger || "manual", { maskHomeDir: false, maxLen: 64 }),
    environment: sanitizeLogPayload(environment, { maskHomeDir, maxDepth: 3 }) || {},
    stateSnapshot: sanitizeLogPayload(stateSnapshot, { maskHomeDir, maxDepth: 4 }) || {},
    summary: {
      totalEvents: timeline.length,
      errorCount: errors.length,
      warnCount,
      modsIncluded,
    },
    errors,
    timeline,
  };
}

/**
 * Format deterministic diagnostic report filename: cognivisor-report-YYYYMMDD-HHmmss.json
 */
export function formatReportFilename(dateInput = new Date()) {
  const d = dateInput instanceof Date && Number.isFinite(dateInput.getTime()) ? dateInput : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `cognivisor-report-${stamp}.json`;
}

/**
 * Select expired or excess report files to prune.
 * Input entries: Array<{ name: string, mtimeMs?: number }>
 */
export function selectReportsToPrune(
  fileEntries,
  { maxFiles = DEFAULT_MAX_REPORT_FILES, maxAgeMs = DEFAULT_REPORT_MAX_AGE_MS, now = Date.now() } = {},
) {
  if (!Array.isArray(fileEntries) || fileEntries.length === 0) return [];
  const cap = Number.isFinite(Number(maxFiles)) && Number(maxFiles) > 0 ? Math.trunc(Number(maxFiles)) : DEFAULT_MAX_REPORT_FILES;
  const ageLimit = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0 ? Number(maxAgeMs) : DEFAULT_REPORT_MAX_AGE_MS;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();

  const jsonReports = fileEntries
    .filter((f) => f && typeof f.name === "string" && f.name.startsWith("cognivisor-report-") && f.name.endsWith(".json"))
    .slice()
    .sort((a, b) => {
      const mDiff = (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0);
      if (mDiff !== 0) return mDiff;
      return b.name.localeCompare(a.name);
    });

  const toDelete = [];
  for (let i = 0; i < jsonReports.length; i += 1) {
    const item = jsonReports[i];
    const mtime = Number(item.mtimeMs) || 0;
    const isExpired = mtime > 0 && (nowMs - mtime) > ageLimit;
    if (i >= cap || isExpired) {
      toDelete.push(item.name);
    }
  }
  return toDelete;
}
