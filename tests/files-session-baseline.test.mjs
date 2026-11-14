import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeGitStatusMark,
  normalizeSessionBaseline,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  terminalHasResumeCommand,
  computeFileSig,
  statFileEntry,
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
});
