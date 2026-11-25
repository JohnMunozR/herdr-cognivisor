import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_HASH_READ_BYTES,
  normalizeGitStatusMark,
  normalizeSessionBaseline,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  resolveSessionStartTime,
  findRecentFlowWorkspaceBaseline,
  findRecentWorkspaceBaseline,
  pruneDiskSessionBaselines,
  terminalHasResumeCommand,
  computeFileSig,
  statFileEntry,
  createFileSigCache,
  batchStatLocalPaths,
  resolveFileSigCached,
  filterSessionDirtyEntries,
  isHomeDirectoryRoot,
  resolveWorkspaceRoot,
} from "../mods/files-search/session-baseline.js";

describe("files-search session-baseline", () => {
  it("normalizeSessionBaseline normalizes valid data and rejects non-objects", () => {
    assert.equal(normalizeSessionBaseline(null), null);
    assert.equal(normalizeSessionBaseline("invalid"), null);
    assert.equal(normalizeSessionBaseline([]), null);

    const normalized = normalizeSessionBaseline({
      version: 1,
      startedAt: 1700000000000,
      workspaceRoot: "C:\\Users\\dev\\mypass\\",
      repos: {
        "C:\\Users\\dev\\mypass\\": {
          dirtyFiles: {
            ".\\src\\App.js": { status: " M", sig: "120:1700000000000" },
          },
        },
        "C:\\Users\\dev\\herdr-cognivisor": {
          dirtyFiles: {},
        },
      },
    });

    assert.equal(normalized.version, 1);
    assert.equal(normalized.startedAt, 1700000000000);
    assert.equal(normalized.workspaceRoot, "C:/Users/dev/mypass");
    assert.deepEqual(normalized.repos["C:/Users/dev/mypass"], {
      dirtyFiles: {
        "src/App.js": { status: " M", sig: "120:1700000000000" },
      },
    });
    assert.deepEqual(normalized.repos["C:/Users/dev/herdr-cognivisor"], {
      dirtyFiles: {},
    });
  });

  it("filters out pre-existing dirty files and detects new or re-edited files after baseline", () => {
    const baselineRepo = {
      dirtyFiles: {
        "README.md": { status: " M", sig: "512:1700000000000" },
        "old-untracked.txt": { status: "??", sig: "10:1700000000000" },
      },
    };

    const entries = [
      { relFile: "README.md", fullPath: "/repo/README.md", status: " M", mtimeMs: 1700000000000, sig: "512:1700000000000" },
      { relFile: "old-untracked.txt", fullPath: "/repo/old-untracked.txt", status: "??", mtimeMs: 1700000005000, sig: "42:1700000005000" },
      { relFile: "src/new.js", fullPath: "/repo/src/new.js", status: "??", mtimeMs: 1700000006000, sig: "88:1700000006000" },
    ];

    const filtered = filterSessionDirtyEntries(entries, baselineRepo, 1700000001000);
    assert.deepEqual(
      filtered.map(e => e.relFile),
      ["old-untracked.txt", "src/new.js"]
    );
  });

  it("supports sigMap lookup and filters newly encountered repos by baselineStartedAt", () => {
    const baselineStartedAt = 1700000010000;
    const entries = [
      { relFile: "preexisting.js", fullPath: "/sibling/preexisting.js", status: " M", mtimeMs: 1700000005000 },
      { relFile: "session-edit.js", fullPath: "/sibling/session-edit.js", status: " M", mtimeMs: 1700000015000 },
      { relFile: "deleted-old.js", fullPath: "/sibling/deleted-old.js", status: " D", mtimeMs: 0 },
    ];

    const newRepoFiltered = filterSessionDirtyEntries(entries, null, baselineStartedAt);
    assert.deepEqual(
      newRepoFiltered.map(e => e.relFile),
      ["session-edit.js"]
    );

    const sigMap = new Map([
      ["preexisting.js", "100:1700000005000"],
      ["session-edit.js", "200:1700000015000"],
    ]);
    const existingRepoFiltered = filterSessionDirtyEntries(
      entries.slice(0, 2),
      { dirtyFiles: { "preexisting.js": { status: " M", sig: "100:1700000005000" } } },
      baselineStartedAt,
      sigMap
    );
    assert.deepEqual(
      existingRepoFiltered.map(e => e.relFile),
      ["session-edit.js"]
    );
  });

  it("computes file signatures locally, on ENOENT, and over SSH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-sig-"));
    try {
      const filePath = join(dir, "sample.txt");
      await writeFile(filePath, "hello world", "utf8");

      const localSig = await computeFileSig(filePath, " M", null);
      assert.match(localSig, /^11:\d+$/);

      const statInfo = await statFileEntry(filePath, " M", null);
      assert.equal(statInfo.sig, localSig);
      assert.ok(statInfo.mtimeMs > 0);

      const deletedSig = await computeFileSig(join(dir, "missing.txt"), " D", null);
      assert.equal(deletedSig, "deleted");

      const sshSig = await computeFileSig(filePath, " M", "dev@remote");
      assert.equal(sshSig, " M");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects /resume command in terminal transcripts", () => {
    assert.equal(terminalHasResumeCommand("user@host:~$ claude\n/resume\n"), true);
    assert.equal(terminalHasResumeCommand("Running /RESUME abc123"), true);
    assert.equal(terminalHasResumeCommand("git status\nnpm test"), false);
    assert.equal(terminalHasResumeCommand("resumed work without slash"), false);
    assert.equal(terminalHasResumeCommand(null), false);
  });

  it("persists baselines across restarts (tabId) and /resume across new tabIds", async () => {
    const appHomeDir = await mkdtemp(join(tmpdir(), "herdr-baseline-"));
    try {
      const workspaceRoot = "/home/dev/projects/mypass";
      const branch = "feat/session-tracking";
      const baseline = {
        version: 1,
        startedAt: 1700000000000,
        workspaceRoot,
        repos: {
          "/home/dev/projects/mypass": {
            dirtyFiles: { "package.json": { status: " M", sig: "300:1699999990000" } },
          },
          "/home/dev/projects/herdr-cognivisor": {
            dirtyFiles: { "dirty.js": { status: "??", sig: "50:1699999980000" } },
          },
        },
      };

      const wrote = await writeDiskSessionBaseline(appHomeDir, "tab:123", workspaceRoot, branch, baseline);
      assert.equal(wrote, true);

      // Same tabId restored after PC/Herdr restart
      const restoredSameTab = await readDiskSessionBaseline(appHomeDir, "tab:123", workspaceRoot, branch, false);
      assert.deepEqual(restoredSameTab, baseline);

      // New tabId without /resume does NOT restore the resume baseline
      const freshNewTab = await readDiskSessionBaseline(appHomeDir, "tab:999", workspaceRoot, branch, false);
      assert.equal(freshNewTab, null);

      // New tabId WITH /resume restores from resume/<hash>.json
      const resumedNewTab = await readDiskSessionBaseline(appHomeDir, "tab:999", workspaceRoot, branch, true);
      assert.deepEqual(resumedNewTab, baseline);

      // Different branch does NOT match resume/<hash>.json
      const wrongBranch = await readDiskSessionBaseline(appHomeDir, "tab:999", workspaceRoot, "main", true);
      assert.equal(wrongBranch, null);

      // Same tabId on a DIFFERENT workspaceRoot MUST NOT inherit stale baseline
      const wrongWorkspaceTab = await readDiskSessionBaseline(appHomeDir, "tab:123", "/home/dev/projects/other-repo", branch, false);
      assert.equal(wrongWorkspaceTab, null);
    } finally {
      await rm(appHomeDir, { recursive: true, force: true });
    }
  });

  it("ignores /resume inside paths or help banners and handles no-stat QuickJS binary/dir fallbacks", async () => {
    assert.equal(terminalHasResumeCommand("ls ~/.config/herdr-app/cognivisor/sessions/resume\n"), false);
    assert.equal(terminalHasResumeCommand("Type /resume to continue your previous conversation"), false);
    assert.equal(terminalHasResumeCommand("  /resume   Resume a previous session\n"), false);
    assert.equal(terminalHasResumeCommand("\x1b[32m❯\x1b[0m /resume my-prev-session\n"), true);
    assert.equal(terminalHasResumeCommand("user@host:~/proj$ antigravity --resume\n"), true);

    assert.equal(normalizeGitStatusMark("??"), "A");
    assert.equal(normalizeGitStatusMark("AD"), "D");
    assert.equal(normalizeGitStatusMark("UD"), "U");

    const noStatBinaryFs = {
      exists: async (p) => !p.endsWith("missing.bin"),
      readFile: async (p) => {
        if (p.endsWith(".agent")) {
          const err = new Error("EISDIR");
          err.code = "EISDIR";
          throw err;
        }
        return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
      },
    };
    const binStat = await statFileEntry("/repo/mypass.zip", "A", null, noStatBinaryFs);
    assert.match(binStat.sig, /^6:b[0-9a-f]{8}$/);
    assert.equal(binStat.mtimeMs, 0);

    const dirStat = await statFileEntry("/repo/.agent", "A", null, noStatBinaryFs);
    assert.equal(dirStat.sig, "dir:A");
    assert.equal(dirStat.mtimeMs, 0);

    const missingStat = await statFileEntry("/repo/missing.bin", "D", null, noStatBinaryFs);
    assert.equal(missingStat.sig, "deleted");
  });

  it("resolveWorkspaceRoot skips $HOME anchoring when pane.cwd is a deeper project folder", () => {
    const appHomeDir = "/home/nmr/.config/herdr-app";
    assert.equal(isHomeDirectoryRoot("/home/nmr", null, appHomeDir), true);
    assert.equal(isHomeDirectoryRoot("/home/nmr/Projects", null, appHomeDir), false);
    assert.equal(isHomeDirectoryRoot("C:\\Users\\dev", null, "C:\\Users\\dev\\AppData\\Roaming\\herdr-app", true), true);

    assert.equal(
      resolveWorkspaceRoot({
        spaceFolder: "/home/nmr",
        paneCwd: "/home/nmr/Projects/herdr-cognivisor",
        appHomeDir,
      }),
      "/home/nmr/Projects/herdr-cognivisor",
    );
    assert.equal(
      resolveWorkspaceRoot({
        spaceFolder: "/home/nmr",
        paneCwd: null,
        appHomeDir,
      }),
      "/home/nmr",
    );
    assert.equal(
      resolveWorkspaceRoot({
        spaceFolder: "/home/nmr/Projects",
        paneCwd: "/home/nmr/Projects/herdr-cognivisor",
        appHomeDir,
      }),
      "/home/nmr/Projects",
    );
    assert.equal(
      resolveWorkspaceRoot({
        spaceFolder: "/home/nmr/Projects/herdr-cognivisor",
        paneCwd: "/home/nmr/Projects/herdr-cognivisor/mods",
        appHomeDir,
      }),
      "/home/nmr/Projects/herdr-cognivisor",
    );
    assert.equal(
      resolveWorkspaceRoot({
        spaceFolder: "/home/nmr/Projects/herdr-cognivisor",
        paneCwd: "/home/nmr/Projects/other-repo",
        appHomeDir,
      }),
      "/home/nmr/Projects/other-repo",
    );
    assert.equal(
      resolveWorkspaceRoot({
        spaceFolder: "C:/Users/dev",
        paneCwd: "C:/Users/dev/Projects/app",
        isWindows: true,
        appHomeDir: "C:/Users/dev/AppData/Roaming/herdr-app",
      }),
      "C:/Users/dev/Projects/app",
    );
  });

  it("resolveSessionStartTime anchors to earliest flow timestamp and findRecentWorkspaceBaseline reuses orphaned baselines", async () => {
    const t0919 = 1795443593000;
    const t1205 = 1795453500000;
    const t1221 = 1795454466000;

    assert.deepEqual(resolveSessionStartTime({ updatedAt: t1205 }, t1221), { startedAt: t1205, anchored: true });
    assert.deepEqual(resolveSessionStartTime(null, t1221), { startedAt: t1221, anchored: false });

    const appHomeDir = await mkdtemp(join(tmpdir(), "herdr-recent-ws-"));
    try {
      const ws = "/home/dev/projects/ms-card";
      const morningBaseline = {
        version: 1,
        startedAt: t0919,
        workspaceRoot: ws,
        repos: { [ws]: { dirtyFiles: {} } },
      };
      await writeDiskSessionBaseline(appHomeDir, "tbf79e3c", ws, "feat/card", morningBaseline);

      // Skipped if tbf79e3c is still a live tab
      const whileLive = await findRecentWorkspaceBaseline(appHomeDir, ws, {
        excludeTabId: "tb70b579",
        liveTabIds: new Set(["tbf79e3c", "tb70b579"]),
        now: t1221,
      });
      assert.equal(whileLive, null);

      // Reused once tbf79e3c is orphaned (no longer in liveTabIds)
      const whenOrphaned = await findRecentWorkspaceBaseline(appHomeDir, ws, {
        excludeTabId: "tb70b579",
        liveTabIds: new Set(["tb70b579"]),
        now: t1221,
      });
      assert.deepEqual(whenOrphaned, morningBaseline);

      const flowMatch = findRecentFlowWorkspaceBaseline(
        { tbf79e3c: { sessionBaseline: morningBaseline } },
        ws,
        { excludeTabId: "tb70b579", liveTabIds: new Set(["tb70b579"]), now: t1221 },
      );
      assert.deepEqual(flowMatch, morningBaseline);
    } finally {
      await rm(appHomeDir, { recursive: true, force: true });
    }
  });

  it("caches file signatures in LRU on no-stat runtimes, skips huge files, and supports batched POSIX stat", async () => {
    const cache = createFileSigCache(2);
    cache.set("a", { mtimeSec: 1, size: 1, sig: "1:ba" });
    cache.set("b", { mtimeSec: 1, size: 1, sig: "1:bb" });
    assert.ok(cache.get("a")); // refresh LRU order -> "b" is now oldest
    cache.set("c", { mtimeSec: 1, size: 1, sig: "1:bc" });
    assert.equal(cache.get("b"), null);
    assert.ok(cache.get("a"));
    assert.ok(cache.get("c"));

    let readCount = 0;
    const noStatFs = {
      exists: async () => true,
      readFile: async () => {
        readCount += 1;
        return new Uint8Array([1, 2, 3, 4]);
      },
    };
    const sigCache = createFileSigCache(10);
    const meta1 = { mtimeSec: 1700000100, mtimeMs: 1700000100000, size: 4, isDir: false };

    // First call hashes once and populates cache
    const first = await resolveFileSigCached("/repo/a.js", "M", { statMeta: meta1, cache: sigCache, fsDeps: noStatFs });
    assert.equal(first.hashed, true);
    assert.equal(readCount, 1);
    assert.match(first.sig, /^4:b[0-9a-f]{8}$/);
    assert.equal(first.mtimeMs, 1700000100000);

    // Second call with same (mtimeSec, size) hits cache with ZERO readFile calls
    const second = await resolveFileSigCached("/repo/a.js", "M", { statMeta: meta1, cache: sigCache, fsDeps: noStatFs });
    assert.equal(second.hashed, false);
    assert.equal(readCount, 1);
    assert.equal(second.sig, first.sig);

    // Edited file (new mtimeSec) re-hashes cleanly
    const metaEdited = { mtimeSec: 1700000200, mtimeMs: 1700000200000, size: 4, isDir: false };
    const third = await resolveFileSigCached("/repo/a.js", "M", { statMeta: metaEdited, cache: sigCache, fsDeps: noStatFs });
    assert.equal(third.hashed, true);
    assert.equal(readCount, 2);

    // Directory skips readFile completely
    const dirRes = await resolveFileSigCached("/repo/sub", "A", {
      statMeta: { mtimeSec: 100, mtimeMs: 100000, size: 4096, isDir: true },
      cache: sigCache,
      fsDeps: noStatFs,
    });
    assert.equal(dirRes.sig, "dir:A");
    assert.equal(dirRes.hashed, false);
    assert.equal(readCount, 2);

    // Huge binary exceeding maxHashBytes never calls readFile (prevents QuickJS freeze/OOM)
    const hugeRes = await resolveFileSigCached("/repo/dump.bin", "A", {
      statMeta: { mtimeSec: 1700000300, mtimeMs: 1700000300000, size: MAX_HASH_READ_BYTES + 1024, isDir: false },
      cache: sigCache,
      fsDeps: noStatFs,
    });
    assert.equal(hugeRes.hashed, false);
    assert.equal(readCount, 2);
    assert.equal(hugeRes.sig, `${MAX_HASH_READ_BYTES + 1024}:1700000300000`);

    // Batched POSIX stat fallback (when fsDeps.stat is absent) parses path-keyed GNU & BSD stat output
    // even when a deleted file or broken symlink in the same chunk causes exit code 1, and skips on Windows.
    const execCalls = [];
    const statMap = await batchStatLocalPaths("/repo", ["src/a:b.js", "deleted.js", "sub"], {
      fsDeps: {},
      isWindows: false,
      execFn: async (cmd, args) => {
        execCalls.push({ cmd, args });
        return {
          code: 1,
          stdout: ["1700000100", "42", "regular file", "src/a:b.js", "1700000200", "4096", "directory", "sub", ""].join("\0"),
          stderr: "stat: cannot statx 'deleted.js': No such file or directory\n",
        };
      },
    });
    assert.equal(execCalls.length, 1);
    assert.deepEqual(statMap.get("src/a:b.js"), { size: 42, mtimeSec: 1700000100, mtimeMs: 1700000100000, isDir: false });
    assert.deepEqual(statMap.get("sub"), { size: 4096, mtimeSec: 1700000200, mtimeMs: 1700000200000, isDir: true });
    assert.equal(statMap.has("deleted.js"), false);

    // BSD stat fallback parses tab-delimited path-keyed records even with partial ENOENT exit code 1
    const bsdMap = await batchStatLocalPaths("/repo", ["space file.js", "missing.js", "sub"], {
      fsDeps: {},
      isWindows: false,
      execFn: async (_cmd, args) => {
        if (args.includes("-f")) {
          return {
            code: 1,
            stdout: "1700000300\t99\tRegular File\tspace file.js\n1700000400\t128\tDirectory\tsub\n",
            stderr: "stat: missing.js: No such file or directory\n",
          };
        }
        return { code: 1, stdout: "", stderr: "stat: illegal option -- -" };
      },
    });
    assert.deepEqual(bsdMap.get("space file.js"), { size: 99, mtimeSec: 1700000300, mtimeMs: 1700000300000, isDir: false });
    assert.deepEqual(bsdMap.get("sub"), { size: 128, mtimeSec: 1700000400, mtimeMs: 1700000400000, isDir: true });
    assert.equal(bsdMap.has("missing.js"), false);

    const winMap = await batchStatLocalPaths("/repo", ["src/a.js"], {
      fsDeps: {},
      isWindows: true,
      execFn: async () => {
        throw new Error("should not call POSIX stat on Windows");
      },
    });
    assert.equal(winMap.size, 0);
  });

  it("batchStatLocalPaths survives live POSIX ENOENT and broken symlink in same chunk without reading huge sibling", async () => {
    if (process.platform === "win32") return;
    const { mkdir, symlink } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const dir = await mkdtemp(join(tmpdir(), "herdr-stat-batch-"));
    try {
      await writeFile(join(dir, "a:b.txt"), "hello", "utf8");
      await writeFile(join(dir, "space file.txt"), "world!", "utf8");
      await writeFile(join(dir, "-dash.txt"), "dash", "utf8");
      await writeFile(join(dir, "huge.bin"), Buffer.alloc(MAX_HASH_READ_BYTES + 256, 0x41));
      await mkdir(join(dir, "sub-dir"));
      await symlink(join(dir, "does-not-exist"), join(dir, "broken-link"));

      const execFn = async (cmd, args, opts) => {
        try {
          const { stdout, stderr } = await execFileAsync(cmd, args, { cwd: opts?.cwd, timeout: 4000 });
          return { code: 0, stdout, stderr };
        } catch (err) {
          return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout || "", stderr: err.stderr || "" };
        }
      };

      const rels = ["a:b.txt", "space file.txt", "-dash.txt", "huge.bin", "sub-dir", "deleted.txt", "broken-link"];
      const map = await batchStatLocalPaths(dir, rels, { fsDeps: {}, isWindows: false, execFn });
      assert.equal(map.get("a:b.txt")?.size, 5);
      assert.equal(map.get("space file.txt")?.size, 6);
      assert.equal(map.get("-dash.txt")?.size, 4);
      assert.equal(map.get("huge.bin")?.size, MAX_HASH_READ_BYTES + 256);
      assert.equal(map.get("sub-dir")?.isDir, true);
      assert.equal(map.has("deleted.txt"), false);
      assert.equal(map.has("broken-link"), false);

      let hugeReadCount = 0;
      const hugeRes = await resolveFileSigCached(join(dir, "huge.bin"), "A", {
        statMeta: map.get("huge.bin"),
        cache: createFileSigCache(8),
        fsDeps: {
          exists: async () => true,
          readFile: async () => {
            hugeReadCount += 1;
            return new Uint8Array([1]);
          },
        },
      });
      assert.equal(hugeReadCount, 0);
      assert.equal(hugeRes.hashed, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pruneDiskSessionBaselines deletes expired and excess closed tab JSONs while preserving live tabs", async () => {
    const appHomeDir = await mkdtemp(join(tmpdir(), "herdr-prune-"));
    const now = 1800000000000;
    const day = 24 * 60 * 60 * 1000;
    try {
      const ws = "/home/dev/proj";
      // 1 live tab (old, must be preserved because it's live)
      await writeDiskSessionBaseline(appHomeDir, "tab-live", ws, "main", { version: 1, startedAt: now - 30 * day, workspaceRoot: ws, repos: {} });
      // 1 expired closed tab (> 7 days)
      await writeDiskSessionBaseline(appHomeDir, "tab-expired", ws, "main", { version: 1, startedAt: now - 10 * day, workspaceRoot: ws, repos: {} });
      // 3 recent closed tabs (cap = 2 -> oldest of these 3 pruned)
      await writeDiskSessionBaseline(appHomeDir, "tab-c1", ws, "main", { version: 1, startedAt: now - 3 * day, workspaceRoot: ws, repos: {} });
      await writeDiskSessionBaseline(appHomeDir, "tab-c2", ws, "main", { version: 1, startedAt: now - 2 * day, workspaceRoot: ws, repos: {} });
      await writeDiskSessionBaseline(appHomeDir, "tab-c3", ws, "main", { version: 1, startedAt: now - 1 * day, workspaceRoot: ws, repos: {} });

      const result = await pruneDiskSessionBaselines(appHomeDir, {
        liveTabIds: new Set(["tab-live"]),
        maxClosedFiles: 2,
        maxAgeMs: 7 * day,
        now,
      });
      assert.equal(result.pruned, 2);
      assert.equal(result.remaining, 3);

      assert.ok(await readDiskSessionBaseline(appHomeDir, "tab-live", ws, "main", false));
      assert.equal(await readDiskSessionBaseline(appHomeDir, "tab-expired", ws, "main", false), null);
      assert.equal(await readDiskSessionBaseline(appHomeDir, "tab-c1", ws, "main", false), null);
      assert.ok(await readDiskSessionBaseline(appHomeDir, "tab-c2", ws, "main", false));
      assert.ok(await readDiskSessionBaseline(appHomeDir, "tab-c3", ws, "main", false));
    } finally {
      await rm(appHomeDir, { recursive: true, force: true });
    }
  });

  it("preserves changes-review rev/startHead/startBranch fields and matches deleted:D signatures across mods", async () => {
    const appHomeDir = await mkdtemp(join(tmpdir(), "herdr-cross-mod-bl-"));
    try {
      const ws = "/home/dev/proj";
      const baseline = {
        version: 1,
        rev: 3,
        startedAt: 1700000000000,
        workspaceRoot: ws,
        repos: {
          [ws]: {
            startHead: "abcdef1234567890abcdef1234567890abcdef12",
            startBranch: "feat/unified",
            dirtyFiles: {
              "src/removed.ts": { status: "D", sig: "deleted:D" },
            },
          },
        },
      };
      await writeDiskSessionBaseline(appHomeDir, "tab-sync", ws, "feat/unified", baseline);
      const restored = await readDiskSessionBaseline(appHomeDir, "tab-sync", ws, "feat/unified", false);
      assert.deepEqual(restored, baseline);

      const filtered = filterSessionDirtyEntries(
        [{ relFile: "src/removed.ts", fullPath: `${ws}/src/removed.ts`, status: "D", sig: "deleted", mtimeMs: 0 }],
        restored.repos[ws],
        restored.startedAt,
      );
      assert.deepEqual(filtered, [], "deleted:D baseline entry must match deleted status cleanly");
    } finally {
      await rm(appHomeDir, { recursive: true, force: true });
    }
  });
});
