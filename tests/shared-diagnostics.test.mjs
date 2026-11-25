import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DIAGNOSTICS_SCHEMA_VERSION,
  redactString,
  serializeError,
  sanitizeLogPayload,
  normalizeLogEntry,
  createRingBuffer,
  mergeModLogEntries,
  mergeDiagnosticStreams,
  buildDiagnosticReport,
  formatReportFilename,
  selectReportsToPrune,
} from "../shared/diagnostics-logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ACTIVE_MODS = [
  "files-search",
  "changes-review",
  "git-history",
  "cognivisor-tabs",
  "cognivisor-status",
];

describe("shared diagnostics engine & cross-mod sync parity", () => {
  it("keeps diagnostics-logic.js and diagnostics.js byte-identical across all 5 active mods", () => {
    for (const file of ["diagnostics-logic.js", "diagnostics.js"]) {
      const canonical = readFileSync(resolve(ROOT, "shared", file), "utf8");
      for (const mod of ACTIVE_MODS) {
        const copy = readFileSync(resolve(ROOT, "mods", mod, file), "utf8");
        assert.equal(copy, canonical, `mods/${mod}/${file} drifted from shared/${file}`);
      }
    }
  });

  it("redactString masks secrets, credentials, home paths, and truncates safely", () => {
    assert.equal(
      redactString("https://alice:s3cr3tPass@github.com/org/repo.git"),
      "https://[redacted]@github.com/org/repo.git",
    );
    assert.equal(
      redactString("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
      "Authorization: Bearer [redacted]",
    );
    assert.equal(
      redactString("token=ghp_1234567890abcdef1234567890abcdef"),
      "token=[redacted]",
    );
    assert.equal(
      redactString("Error at /home/alice/Projects/ms-card/Main.java"),
      "Error at ~/Projects/ms-card/Main.java",
    );
    assert.equal(
      redactString("Error at C:\\Users\\nicolas\\Projects\\ms-card\\Main.java"),
      "Error at ~\\Projects\\ms-card\\Main.java",
    );
    assert.equal(
      redactString("/home/alice/Projects/ms-card", { maskHomeDir: false }),
      "/home/alice/Projects/ms-card",
    );
    const clipped = redactString("x".repeat(600), { maxLen: 20 });
    assert.equal(clipped.length, 20);
    assert.ok(clipped.endsWith("…"));
  });

  it("serializeError handles Error, null (Null\"null\"), undefined, primitives, and objects", () => {
    const nullErr = serializeError(null);
    assert.deepEqual(nullErr, {
      type: "null",
      name: "NullException",
      message: "Null exception thrown",
      stack: "",
    });

    const undefErr = serializeError(undefined);
    assert.equal(undefErr.type, "undefined");
    assert.equal(undefErr.name, "UndefinedException");

    const jsErr = new TypeError("Failed reading /home/dev/repo with Bearer abcdefgh12345678");
    jsErr.code = "ENOENT";
    const ser = serializeError(jsErr);
    assert.equal(ser.type, "error");
    assert.equal(ser.name, "TypeError");
    assert.equal(ser.code, "ENOENT");
    assert.match(ser.message, /~\/repo/);
    assert.match(ser.message, /Bearer \[redacted\]/);
    assert.ok(ser.stack.length > 0);

    assert.equal(serializeError("plain boom").type, "string");
    assert.equal(serializeError(42).message, "42");
  });

  it("sanitizeLogPayload redacts forbidden keys, guards circular refs, and caps depth/arrays", () => {
    const cyclic = { ok: true, workspace: "/home/dev/ms-card", content: "secret source code", diff: "+secret", token: "abc123456" };
    cyclic.self = cyclic;
    cyclic.deep = { a: { b: { c: { d: "too deep" } } } };
    cyclic.items = Array.from({ length: 25 }, (_, i) => i);

    const out = sanitizeLogPayload(cyclic);
    assert.equal(out.ok, true);
    assert.equal(out.workspace, "~/ms-card");
    assert.equal(out.content, "[redacted]");
    assert.equal(out.diff, "[redacted]");
    assert.equal(out.token, "[redacted]");
    assert.equal(out.self, "[circular]");
    assert.equal(out.deep.a.b, "[object]");
    assert.equal(out.items.length, 21);
    assert.equal(out.items[20], "…(+5)");
  });

  it("createRingBuffer evicts oldest entries beyond capacity", () => {
    const buf = createRingBuffer(3);
    buf.push({ seq: 1 });
    buf.push({ seq: 2 });
    buf.push({ seq: 3 });
    buf.push({ seq: 4 });
    assert.equal(buf.size(), 3);
    assert.deepEqual(buf.toArray().map((e) => e.seq), [2, 3, 4]);
    buf.clear();
    assert.equal(buf.size(), 0);
  });

  it("mergeDiagnosticStreams and buildDiagnosticReport merge chronologically with error summary", () => {
    const s1 = {
      mod: "changes-review",
      entries: [
        normalizeLogEntry({ ts: 2000, seq: 2, level: "error", event: "render.failed", error: null, data: { viewMode: "working" } }, "changes-review"),
        normalizeLogEntry({ ts: 1000, seq: 1, level: "action", event: "review.toggleShowAll", data: { showAll: true } }, "changes-review"),
      ],
    };
    const s2 = {
      mod: "cognivisor-tabs",
      entries: [
        normalizeLogEntry({ ts: 1500, seq: 1, level: "action", event: "tabs.switchPanel", data: { panel: "changes" } }, "cognivisor-tabs"),
      ],
    };

    const merged = mergeDiagnosticStreams([s1, s2]);
    assert.deepEqual(
      merged.map((e) => `${e.mod}:${e.event}`),
      ["changes-review:review.toggleShowAll", "cognivisor-tabs:tabs.switchPanel", "changes-review:render.failed"],
    );

    const report = buildDiagnosticReport({
      trigger: "status-bar",
      environment: { platform: "windows", workspaceRoot: "C:\\Users\\nicolas\\ms-card" },
      stateSnapshot: { servicesCount: 2 },
      streams: [s1, s2],
      exportedAt: "2026-11-23T17:20:00.000Z",
    });

    assert.equal(report.schemaVersion, DIAGNOSTICS_SCHEMA_VERSION);
    assert.equal(report.trigger, "status-bar");
    assert.equal(report.environment.workspaceRoot, "~\\ms-card");
    assert.equal(report.summary.totalEvents, 3);
    assert.equal(report.summary.errorCount, 1);
    assert.deepEqual(report.summary.modsIncluded, ["changes-review", "cognivisor-tabs"]);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0].error.type, "null");
  });

  it("formatReportFilename and selectReportsToPrune enforce filename format and retention bounds", () => {
    const name = formatReportFilename(new Date(2026, 10, 23, 17, 5, 9));
    assert.equal(name, "cognivisor-report-20261123-170509.json");

    const now = 1795460000000;
    const day = 24 * 60 * 60 * 1000;
    const files = [
      { name: "cognivisor-report-20261123-170000.json", mtimeMs: now - 1000 },
      { name: "cognivisor-report-20261123-160000.json", mtimeMs: now - 2000 },
      { name: "cognivisor-report-20261123-150000.json", mtimeMs: now - 3000 },
      { name: "cognivisor-report-20261101-120000.json", mtimeMs: now - 20 * day },
      { name: "unrelated.json", mtimeMs: now - 30 * day },
    ];
    const pruned = selectReportsToPrune(files, { maxFiles: 2, maxAgeMs: 7 * day, now });
    assert.deepEqual(pruned, [
      "cognivisor-report-20261123-150000.json",
      "cognivisor-report-20261101-120000.json",
    ]);
  });

  it("mergeModLogEntries preserves prior render.failed entries across view reloads and deduplicates cleanly", () => {
    const existingDisk = [
      normalizeLogEntry({ ts: 1000, seq: 1, level: "lifecycle", event: "mod.init", data: { mode: "viewer" } }, "changes-review"),
      normalizeLogEntry({ ts: 1500, seq: 2, level: "error", event: "render.failed", error: new TypeError("boom") }, "changes-review"),
    ];
    const reloadedPanel = [
      normalizeLogEntry({ ts: 1500, seq: 2, level: "error", event: "render.failed", error: new TypeError("boom") }, "changes-review"),
      normalizeLogEntry({ ts: 2000, seq: 1, level: "lifecycle", event: "mod.init", data: { mode: "panel" } }, "changes-review"),
    ];

    const merged = mergeModLogEntries(existingDisk, reloadedPanel, { mod: "changes-review", maxEntries: 10 });
    assert.equal(merged.length, 3);
    assert.deepEqual(
      merged.map((e) => `${e.ts}:${e.event}`),
      ["1000:mod.init", "1500:render.failed", "2000:mod.init"],
    );

    const capped = mergeModLogEntries(existingDisk, reloadedPanel, { mod: "changes-review", maxEntries: 2 });
    assert.deepEqual(
      capped.map((e) => `${e.ts}:${e.event}`),
      ["1500:render.failed", "2000:mod.init"],
    );
  });
});
