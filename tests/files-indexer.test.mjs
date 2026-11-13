import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  installHerdrHooks,
  resetHerdrMock,
  createTempDir,
  cleanupTempDir,
} from "./helpers/herdr-mock.mjs";

installHerdrHooks();
const idx = await import("../mods/files-search/indexer.js");

async function buildSampleWorkspace(wsRoot) {
  await fs.mkdir(path.join(wsRoot, "src", "nested"), { recursive: true });
  await fs.writeFile(path.join(wsRoot, "README.md"), "# Sample\n");
  await fs.writeFile(path.join(wsRoot, "src", "app.js"), "console.log(1);\n");
  await fs.writeFile(path.join(wsRoot, "src", "nested", "util.js"), "export const x = 1;\n");
}

describe("files-search indexer — agent gate", () => {
  beforeEach(() => {
    resetHerdrMock({
      spaces: [{ id: "sp-1", active: true, tabs: [{ id: "tab-1" }] }],
      panes: [{ id: "p-shell", tab: "tab-1", terminal: "term-shell", program: { name: "bash", agent: false } }],
      terminals: [{ address: "term-shell", program: { name: "bash", agent: false }, labels: {} }],
      agents: [],
      focused: { space: "sp-1", tab: "tab-1", agent: null },
    });
  });

  test("returns false when active space only has plain shell terminals", () => {
    assert.equal(idx.hasOpenAgentInSpace(), false);
  });

  test("ignores auxiliary runner splits marked with meshRunner=true", () => {
    resetHerdrMock({
      spaces: [{ id: "sp-1", active: true, tabs: [{ id: "tab-1" }] }],
      panes: [
        { id: "p-shell", tab: "tab-1", terminal: "term-shell", program: { name: "bash", agent: false } },
        { id: "p-run", tab: "tab-1", terminal: "term-run", labels: { meshRunner: "true" }, program: { agent: true } },
      ],
      terminals: [
        { address: "term-shell", program: { name: "bash", agent: false }, labels: {} },
        { address: "term-run", labels: { meshRunner: "true" }, program: { agent: true } },
      ],
      agents: [{ address: "term-run", space: "sp-1", tab: "tab-1" }],
      focused: { space: "sp-1", tab: "tab-1", agent: "term-run" },
    });
    assert.equal(idx.hasOpenAgentInSpace(), false);
  });

  test("returns true when a non-runner coding agent is active in the space", () => {
    resetHerdrMock({
      spaces: [{ id: "sp-1", active: true, tabs: [{ id: "tab-1" }] }],
      panes: [
        { id: "p-agent", tab: "tab-1", terminal: "term-claude", program: { name: "claude", agent: true } },
      ],
      terminals: [
        { address: "term-claude", program: { name: "claude", agent: true }, labels: {} },
      ],
      agents: [{ address: "term-claude", space: "sp-1", tab: "tab-1" }],
      focused: { space: "sp-1", tab: "tab-1", agent: "term-claude" },
    });
    assert.equal(idx.hasOpenAgentInSpace(), true);
  });

  test("does not count agents belonging solely to another space", () => {
    resetHerdrMock({
      spaces: [
        { id: "sp-1", active: true, tabs: [{ id: "tab-1" }] },
        { id: "sp-2", active: false, tabs: [{ id: "tab-2" }] },
      ],
      panes: [
        { id: "p-shell", tab: "tab-1", terminal: "term-shell", program: { name: "zsh", agent: false } },
        { id: "p-other", tab: "tab-2", terminal: "term-other", program: { name: "claude", agent: true } },
      ],
      terminals: [
        { address: "term-shell", program: { name: "zsh", agent: false }, labels: {} },
        { address: "term-other", program: { name: "claude", agent: true }, labels: {} },
      ],
      agents: [{ address: "term-other", space: "sp-2", tab: "tab-2" }],
      focused: { space: "sp-1", tab: "tab-1", agent: null },
    });
    assert.equal(idx.hasOpenAgentInSpace(), false);
    assert.equal(idx.hasOpenAgentInSpace({ id: "sp-2", tabs: [{ id: "tab-2" }] }), true);
  });
});

describe("files-search indexer — cache, disk persistence & watch invalidation", () => {
  let tmpRoot;

  beforeEach(async () => {
    idx.OVERLAY_INDEX_CACHE.clear();
    idx.RG_AVAILABLE_CACHE.clear();
    tmpRoot = await createTempDir("herdr-idx-");
  });

  afterEach(async () => {
    await cleanupTempDir(tmpRoot);
  });

  test("indexes files and derived dirs, deduplicates concurrent scans, and persists to disk", async () => {
    const appHomeDir = path.join(tmpRoot, "app-home");
    const wsRoot = path.join(tmpRoot, "ws");
    await fs.mkdir(appHomeDir, { recursive: true });
    await buildSampleWorkspace(wsRoot);
    const mock = resetHerdrMock({ appHome: appHomeDir });

    const discoverRepos = async () => [{ path: wsRoot, name: "ws" }];
    const [r1, r2] = await Promise.all([
      idx.ensureWorkspaceIndex({ root: wsRoot, on: null, isWindows: false, discoverRepos }),
      idx.ensureWorkspaceIndex({ root: wsRoot, on: null, isWindows: false, discoverRepos }),
    ]);

    assert.equal(r1, r2);
    assert.equal(mock.execCalls.length, 1);
    assert.ok(r1.files.includes("src/app.js"));
    assert.ok(r1.files.includes("src/nested/util.js"));
    assert.ok(r1.dirs.includes("src"));
    assert.ok(r1.dirs.includes("src/nested"));
    assert.ok(r1.entries.some((e) => e.kind === "dir" && e.path === "src"));
    assert.ok(r1.entries.some((e) => e.kind === "file" && e.path === "src/app.js"));

    const cacheParent = path.join(appHomeDir, "mesh", "workspaces");
    const slugDirs = await fs.readdir(cacheParent);
    assert.equal(slugDirs.length, 1);
    const diskJson = JSON.parse(await fs.readFile(path.join(cacheParent, slugDirs[0], "files-index.json"), "utf8"));
    assert.equal(diskJson.v, 1);
    assert.ok(diskJson.files.includes("README.md"));
    assert.ok(diskJson.dirs.includes("src/nested"));
  });

  test("restores disk snapshot immediately on cold start and clears needsVerify on refresh", async () => {
    const appHomeDir = path.join(tmpRoot, "app-home-restore");
    const wsRoot = path.join(tmpRoot, "ws-restore");
    await fs.mkdir(appHomeDir, { recursive: true });
    await buildSampleWorkspace(wsRoot);
    resetHerdrMock({ appHome: appHomeDir });

    const discoverRepos = async () => [{ path: wsRoot, name: "ws-restore" }];
    await idx.ensureWorkspaceIndex({ root: wsRoot, on: null, isWindows: false, discoverRepos });
    idx.OVERLAY_INDEX_CACHE.clear();

    const restored = await idx.restoreDiskIndex(wsRoot, null, false, null);
    assert.ok(restored);
    assert.equal(restored.fromDisk, true);
    assert.equal(restored.needsVerify, true);
    assert.equal(idx.shouldRefreshIndex(restored, null), true);
    assert.ok(restored.dirSet.has("src/nested"));

    const indexKey = idx.makeIndexKey(wsRoot, null, false);
    idx.claimRootWatcher(indexKey, "w-panel", true);
    const verified = await idx.ensureWorkspaceIndex({ root: wsRoot, on: null, isWindows: false, discoverRepos });
    assert.equal(verified.needsVerify, false);
    assert.equal(verified.watching, true);
    idx.releaseRootWatcher(indexKey, "w-panel");
  });

  test("ignores edits to existing files (including shallow depth<=2) and invalidates only on add/delete/gitignore/HEAD", async () => {
    const appHomeDir = path.join(tmpRoot, "app-home-watch");
    const wsRoot = path.join(tmpRoot, "ws-watch");
    await fs.mkdir(appHomeDir, { recursive: true });
    await buildSampleWorkspace(wsRoot);
    resetHerdrMock({ appHome: appHomeDir });

    const indexKey = idx.makeIndexKey(wsRoot, null, false);
    idx.claimRootWatcher(indexKey, "w-idx", false);
    const record = await idx.ensureWorkspaceIndex({ root: wsRoot, on: null, isWindows: false });
    idx.setIndexWatching(indexKey, true);

    record.ts = Date.now() - 30000; // > 8s default window, < 300s watched TTL
    assert.equal(idx.shouldRefreshIndex(record, null), false);

    // Edits to existing files (depth 1 and depth 2) must NOT dirty the file index.
    const openSet = new Set(["src"]);
    const editPaths = [path.join(wsRoot, "README.md"), path.join(wsRoot, "src", "app.js")];
    const editInfo = idx.analyzeWatchBatch(editPaths, wsRoot, openSet);
    assert.equal(await idx.handleWatchForIndex(wsRoot, null, false, editInfo, editPaths), false);
    assert.equal(record.dirty, false);

    // Ignored paths (node_modules / target / .git lock) never trigger watch handling.
    const ignoredPaths = [
      path.join(wsRoot, "node_modules", "pkg", "index.js"),
      path.join(wsRoot, ".git", "index.lock"),
    ];
    const ignoredInfo = idx.analyzeWatchBatch(ignoredPaths, wsRoot, openSet);
    assert.equal(ignoredInfo.hasNonIgnored, false);
    assert.equal(await idx.handleWatchForIndex(wsRoot, null, false, ignoredInfo, ignoredPaths), false);

    // New file creation marks dirty and clean rebuild clears dirty without force.
    const newFile = path.join(wsRoot, "src", "created.js");
    await fs.writeFile(newFile, "export const n = 2;\n");
    const addInfo = idx.analyzeWatchBatch([newFile], wsRoot, openSet);
    assert.equal(await idx.handleWatchForIndex(wsRoot, null, false, addInfo, [newFile]), true);
    assert.equal(idx.shouldRefreshIndex(record, null), true);

    const rebuilt = await idx.ensureWorkspaceIndex({ root: wsRoot, on: null, isWindows: false });
    assert.equal(rebuilt.dirty, false);
    assert.ok(rebuilt.files.includes("src/created.js"));
    assert.equal(idx.shouldRefreshIndex(rebuilt, null), false);

    // Deleting an indexed file marks dirty.
    await fs.unlink(path.join(wsRoot, "src", "app.js"));
    assert.equal(await idx.handleWatchForIndex(wsRoot, null, false, editInfo, editPaths), true);

    // Branch/HEAD change marks dirty.
    rebuilt.dirty = false;
    const headPath = path.join(wsRoot, ".git", "HEAD");
    const headInfo = idx.analyzeWatchBatch([headPath], wsRoot, openSet);
    assert.equal(await idx.handleWatchForIndex(wsRoot, null, false, headInfo, [headPath]), true);

    // Editing .gitignore marks dirty.
    rebuilt.dirty = false;
    const giPath = path.join(wsRoot, ".gitignore");
    await fs.writeFile(giPath, "dist/\n");
    const giInfo = idx.analyzeWatchBatch([giPath], wsRoot, openSet);
    assert.equal(await idx.handleWatchForIndex(wsRoot, null, false, giInfo, [giPath]), true);

    idx.releaseRootWatcher(indexKey, "w-idx");
    assert.equal(idx.hasActiveRootWatcher(indexKey), false);
  });

  test("fsListWorkspace includes non-empty files and empty directories while skipping ignored dirs", async () => {
    const plainDir = path.join(tmpRoot, "plain");
    await fs.mkdir(path.join(plainDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(plainDir, "empty-folder"), { recursive: true });
    await fs.mkdir(path.join(plainDir, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(plainDir, "docs", "guide.md"), "# Guide\n");
    await fs.writeFile(path.join(plainDir, "node_modules", "dep", "x.js"), "x\n");

    const listed = await idx.fsListWorkspace(plainDir, 100, 100);
    assert.ok(listed.files.includes("docs/guide.md"));
    assert.ok(!listed.files.some((f) => f.includes("node_modules")));
    assert.ok(listed.dirs.includes("docs"));
    assert.ok(listed.dirs.includes("empty-folder"));
    assert.ok(!listed.dirs.includes("node_modules"));
  });

  test("cross-platform path helpers handle Windows backslashes and casing cleanly", () => {
    assert.equal(idx.normPathStr("C:\\Users\\Dev\\Proj\\"), "C:/Users/Dev/Proj");
    assert.equal(idx.isSameOrChildPath("c:\\Users\\Dev\\Proj\\src", "C:\\Users\\Dev\\Proj", true), true);
    assert.equal(idx.getRelToWorkspace("c:\\repo\\src\\App.tsx", "C:\\Repo"), "src/App.tsx");
    assert.equal(idx.isIgnoredWatchPath("C:\\Repo\\target\\debug\\app.exe", "C:\\Repo"), true);
    assert.equal(idx.isIgnoredWatchPath("C:\\Repo\\src\\App.tsx", "C:\\Repo"), false);
  });
});
