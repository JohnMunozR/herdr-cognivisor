import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  MAX_CASCADE_DEPTH,
  POSIX_LIST_SCRIPT,
  POSIX_CASCADE_SCRIPT,
  computeWorkspaceContextKey,
  collectMissingAncestorPaths,
  buildTreeRows,
  sortDirectoryEntries,
  matchesServiceFilter,
  getCascadeChildPath,
  collectSubtreePaths,
  parseCascadeStdout,
  resolveCachedCascade,
  runStagedCascade,
} from "../mods/files-search/tree-logic.js";

describe("files-search tree-logic", () => {
  test("matchesServiceFilter matches self, ancestors, and descendants only", () => {
    assert.equal(matchesServiceFilter("anything/file.js", null), true);
    assert.equal(matchesServiceFilter("apps/web", "apps/web"), true);
    assert.equal(matchesServiceFilter("apps", "apps/web"), true);
    assert.equal(matchesServiceFilter("apps/web/src/index.js", "apps/web"), true);
    assert.equal(matchesServiceFilter("apps/website", "apps/web"), false);
    assert.equal(matchesServiceFilter("apps/api", "apps/web"), false);
  });

  test("getCascadeChildPath returns single child folder or null on stopping conditions", () => {
    assert.equal(getCascadeChildPath("src", [{ name: "main", dir: true }]), "src/main");
    assert.equal(getCascadeChildPath("", [{ name: "src", dir: true }]), "src");
    assert.equal(
      getCascadeChildPath("src", [{ name: ".", dir: true }, { name: "..", dir: true }, { name: "main", dir: true }]),
      "src/main",
    );

    assert.equal(
      getCascadeChildPath("src", [{ name: "main", dir: true }, { name: "index.ts", dir: false }]),
      null,
    );
    assert.equal(
      getCascadeChildPath("src", [{ name: "a", dir: true }, { name: "b", dir: true }]),
      null,
    );
    assert.equal(getCascadeChildPath("src", [{ name: "README.md", dir: false }]), null);
    assert.equal(getCascadeChildPath("src", []), null);
    assert.equal(getCascadeChildPath("src", null), null);

    assert.equal(
      getCascadeChildPath(
        "apps",
        [{ name: "api", dir: true }, { name: "web", dir: true }],
        "apps/web",
      ),
      "apps/web",
    );
  });

  test("collectSubtreePaths matches root and descendants without touching sibling prefixes", () => {
    const items = new Set(["src", "src/main", "src/main/java", "src-extra", "src2/foo"]);
    assert.deepEqual(collectSubtreePaths(items, "src"), ["src", "src/main", "src/main/java"]);
    assert.deepEqual(collectSubtreePaths(items, ""), []);
  });

  test("sortDirectoryEntries puts directories before files and handles 0/1-element fast paths", () => {
    assert.deepEqual(sortDirectoryEntries([]), []);
    assert.deepEqual(sortDirectoryEntries([{ name: "only", dir: true }]), [{ name: "only", dir: true }]);
    const sorted = sortDirectoryEntries([
      { name: "z.txt", dir: false },
      { name: "b", dir: true },
      { name: "a.txt", dir: false },
      { name: "a", dir: true },
    ]);
    assert.deepEqual(
      sorted.map(e => `${e.dir ? "d" : "f"}:${e.name}`),
      ["d:a", "d:b", "f:a.txt", "f:z.txt"],
    );
  });

  test("POSIX_CASCADE_SCRIPT and parseCascadeStdout collect nested single-folder chain in one process", () => {
    const tmp = mkdtempSync(join(tmpdir(), "herdr-cascade-"));
    try {
      const startAbs = join(tmp, "src");
      mkdirSync(join(startAbs, ".git"), { recursive: true });
      mkdirSync(join(startAbs, "main", "my pkg", "com", "rag", "scaffold"), { recursive: true });
      mkdirSync(join(startAbs, "main", "my pkg", "com", "rag", "scaffold", "controller"));
      writeFileSync(join(startAbs, "main", "my pkg", "com", "rag", "scaffold", "App.java"), "");

      const stdout = execFileSync("sh", ["-c", POSIX_CASCADE_SCRIPT, "files", startAbs, String(MAX_CASCADE_DEPTH)], {
        encoding: "utf8",
      });
      const parsed = parseCascadeStdout(stdout, "src");

      assert.deepEqual([...parsed.keys()], [
        "src",
        "src/main",
        "src/main/my pkg",
        "src/main/my pkg/com",
        "src/main/my pkg/com/rag",
        "src/main/my pkg/com/rag/scaffold",
      ]);
      assert.deepEqual(parsed.get("src"), [{ name: "main", dir: true }]);
      assert.deepEqual(
        sortDirectoryEntries(parsed.get("src/main/my pkg/com/rag/scaffold")),
        [
          { name: "controller", dir: true },
          { name: "App.java", dir: false },
        ],
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runStagedCascade resolves full chain before commit and uses batch fetcher without intermediate UI commits", async () => {
    const tree = {
      src: [{ name: "main", dir: true }],
      "src/main": [{ name: "java", dir: true }],
      "src/main/java": [{ name: "com", dir: true }],
      "src/main/java/com": [
        { name: "service", dir: true },
        { name: "App.java", dir: false },
      ],
    };
    const folders = new Set();
    const pending = new Set(["src"]);
    let batchCalls = 0;

    const result = await runStagedCascade({
      startPath: "src",
      getFilterRel: () => null,
      isCancelled: () => !pending.has("src"),
      getCachedEntries: () => undefined,
      fetchCascadeBatch: async curPath => {
        batchCalls += 1;
        // Return the entire single-dir chain in one batch round-trip
        const batch = new Map();
        for (const [k, v] of Object.entries(tree)) batch.set(k, v);
        assert.equal(curPath, "src");
        // Neither visible folders nor pending changed before cascade returns
        assert.equal(folders.size, 0);
        assert.deepEqual([...pending], ["src"]);
        return batch;
      },
      fetchSingleEntries: async () => {
        throw new Error("should not call fetchSingleEntries when batch already resolved chain");
      },
    });

    assert.equal(batchCalls, 1);
    assert.deepEqual(result.stagedFolders, [
      "src",
      "src/main",
      "src/main/java",
      "src/main/java/com",
    ]);
    assert.equal(result.stagedEntries.size, 4);
  });

  test("runStagedCascade respects cancellation, serviceFilter branches, and maxDepth", async () => {
    // 1. Cancellation discards result before commit
    let cancelled = false;
    const cancelledResult = await runStagedCascade({
      startPath: "a",
      isCancelled: () => cancelled,
      fetchCascadeBatch: async () => {
        cancelled = true;
        return new Map([["a", [{ name: "b", dir: true }]]]);
      },
      fetchSingleEntries: async () => [],
    });
    assert.equal(cancelledResult, null);

    // 2. Service filter prunes multi-dir ancestor and continues cascading inside matching subtree
    const filteredTree = {
      apps: [{ name: "api", dir: true }, { name: "web", dir: true }],
      "apps/web": [{ name: "src", dir: true }],
      "apps/web/src": [{ name: "pages", dir: true }, { name: "main.tsx", dir: false }],
    };
    const filteredResult = await runStagedCascade({
      startPath: "apps",
      getFilterRel: () => "apps/web",
      isCancelled: () => false,
      fetchCascadeBatch: async curPath => {
        if (curPath === "apps") return new Map([["apps", filteredTree.apps]]);
        return new Map([
          ["apps/web", filteredTree["apps/web"]],
          ["apps/web/src", filteredTree["apps/web/src"]],
        ]);
      },
      fetchSingleEntries: async p => filteredTree[p] || [],
    });
    assert.deepEqual(filteredResult.stagedFolders, ["apps", "apps/web", "apps/web/src"]);

    // 3. Enforce maxDepth
    const deep = new Map([
      ["d0", [{ name: "d1", dir: true }]],
      ["d0/d1", [{ name: "d2", dir: true }]],
      ["d0/d1/d2", [{ name: "d3", dir: true }]],
      ["d0/d1/d2/d3", [{ name: "leaf.txt", dir: false }]],
    ]);
    const bounded = await runStagedCascade({
      startPath: "d0",
      maxDepth: 2,
      isCancelled: () => false,
      fetchCascadeBatch: async () => deep,
      fetchSingleEntries: async p => deep.get(p) || [],
    });
    assert.deepEqual(bounded.stagedFolders, ["d0", "d0/d1", "d0/d1/d2"]);
  });

  test("resolveCachedCascade expands 2-child stop and nested chains synchronously from cache and reports cache misses", () => {
    assert.equal(resolveCachedCascade({ startPath: "", getCachedEntries: () => [] }), null);
    assert.equal(resolveCachedCascade({ startPath: "src", getCachedEntries: null }), null);

    const cache = new Map([
      ["two-children", [{ name: "a", dir: true }, { name: "b", dir: true }]],
      ["src", [{ name: "main", dir: true }]],
      ["src/main", [{ name: "java", dir: true }]],
      ["src/main/java", [{ name: "com", dir: true }, { name: "App.java", dir: false }]],
      ["apps", [{ name: "api", dir: true }, { name: "web", dir: true }]],
      ["apps/web", [{ name: "src", dir: true }]],
      ["apps/web/src", [{ name: "index.ts", dir: false }, { name: "pages", dir: true }]],
      ["partial", [{ name: "inner", dir: true }]],
    ]);

    const twoChildren = resolveCachedCascade({
      startPath: "two-children",
      getCachedEntries: p => cache.get(p),
    });
    assert.equal(twoChildren.complete, true);
    assert.equal(twoChildren.missingPath, null);
    assert.deepEqual(twoChildren.stagedFolders, ["two-children"]);

    const nested = resolveCachedCascade({
      startPath: "src",
      getCachedEntries: p => cache.get(p),
    });
    assert.equal(nested.complete, true);
    assert.equal(nested.missingPath, null);
    assert.deepEqual(nested.stagedFolders, ["src", "src/main", "src/main/java"]);
    assert.equal(nested.stagedEntries.size, 3);

    const filtered = resolveCachedCascade({
      startPath: "apps",
      getFilterRel: () => "apps/web",
      getCachedEntries: p => cache.get(p),
    });
    assert.equal(filtered.complete, true);
    assert.deepEqual(filtered.stagedFolders, ["apps", "apps/web", "apps/web/src"]);

    const partial = resolveCachedCascade({
      startPath: "partial",
      getCachedEntries: p => cache.get(p),
    });
    assert.equal(partial.complete, false);
    assert.equal(partial.missingPath, "partial/inner");
    assert.deepEqual(partial.stagedFolders, ["partial"]);

    const bounded = resolveCachedCascade({
      startPath: "src",
      maxDepth: 1,
      getCachedEntries: p => cache.get(p),
    });
    assert.equal(bounded.complete, true);
    assert.deepEqual(bounded.stagedFolders, ["src", "src/main"]);
  });

  test("POSIX_LIST_SCRIPT and POSIX_CASCADE_SCRIPT cap large dirs cleanly without globbing special chars", () => {
    const tmp = mkdtempSync(join(tmpdir(), "herdr-large-dir-"));
    try {
      mkdirSync(join(tmp, ".git"));
      mkdirSync(join(tmp, ".hidden dir"));
      writeFileSync(join(tmp, "file with [glob] * chars.txt"), "");
      for (let i = 0; i < 650; i++) {
        writeFileSync(join(tmp, `entry-${String(i).padStart(4, "0")}.txt`), "");
      }

      const listStdout = execFileSync("sh", ["-c", POSIX_LIST_SCRIPT, "files", tmp], { encoding: "utf8" });
      const fields = listStdout.split("\0");
      const listEntries = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        listEntries.push({ name: fields[i + 1], dir: fields[i] === "d" });
      }
      assert.equal(listEntries.length, 501);
      assert.ok(!listEntries.some(e => e.name === ".git" || e.name === "." || e.name === ".."));

      const cascadeStdout = execFileSync("sh", ["-c", POSIX_CASCADE_SCRIPT, "files", tmp, "8"], { encoding: "utf8" });
      const parsed = parseCascadeStdout(cascadeStdout, "big");
      assert.deepEqual([...parsed.keys()], ["big"]);
      assert.equal(parsed.get("big").length, 501);
      assert.ok(!parsed.get("big").some(e => e.name === ".git"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runStagedCascade stops gracefully when a nested subfolder (depth > 0) fails while still throwing on depth 0", async () => {
    let singleCalls = 0;
    const partial = await runStagedCascade({
      startPath: "src",
      isCancelled: () => false,
      fetchCascadeBatch: async curPath => {
        if (curPath === "src") {
          return new Map([["src", [{ name: "restricted", dir: true }]]]);
        }
        return new Map();
      },
      fetchSingleEntries: async () => {
        singleCalls += 1;
        throw new Error("EACCES");
      },
    });
    assert.equal(singleCalls, 0);
    assert.deepEqual(partial.stagedFolders, ["src"]);
    assert.deepEqual(partial.stagedEntries.get("src"), [{ name: "restricted", dir: true }]);

    await assert.rejects(
      () =>
        runStagedCascade({
          startPath: "unreadable",
          isCancelled: () => false,
          fetchCascadeBatch: async () => new Map(),
          fetchSingleEntries: async () => {
            throw new Error("EACCES");
          },
        }),
      /EACCES/,
    );
  });

  test("computeWorkspaceContextKey stays stable across terminal tab switches inside the same workspace", () => {
    const k1 = computeWorkspaceContextKey({ cwd: "/home/dev/repo", on: null, space: "sp-1", tabId: "tab-a" });
    const k2 = computeWorkspaceContextKey({ cwd: "/home/dev/repo", on: null, space: "sp-1", tabId: "tab-b" });
    const k3 = computeWorkspaceContextKey({ cwd: "/home/dev/other", on: null, space: "sp-1", tabId: "tab-a" });
    const k4 = computeWorkspaceContextKey({ cwd: "/home/dev/repo", on: "ssh-box", space: "sp-1", tabId: "tab-a" });
    assert.equal(k1, k2);
    assert.notEqual(k1, k3);
    assert.notEqual(k1, k4);
  });

  test("collectMissingAncestorPaths skips cached folders and respects includeSelf", () => {
    const entries = new Map([
      ["", []],
      ["apps", []],
    ]);
    assert.deepEqual(collectMissingAncestorPaths("apps/web/src/components", entries, true), [
      "apps/web",
      "apps/web/src",
      "apps/web/src/components",
    ]);
    assert.deepEqual(collectMissingAncestorPaths("apps/web/src/App.tsx", entries, false), [
      "apps/web",
      "apps/web/src",
    ]);
    assert.deepEqual(collectMissingAncestorPaths("README.md", entries, false), []);
  });

  test("buildTreeRows fast-paths empty git state and resolves repo pills, dirCounts, marks, Windows casing, and caps", () => {
    const entries = new Map([
      ["", [{ name: "svc-a", dir: true }, { name: "README.md", dir: false }]],
      ["svc-a", [{ name: "src", dir: true }, { name: "index.js", dir: false }]],
      ["svc-a/src", [{ name: "app.js", dir: false }]],
    ]);
    const folders = new Set(["svc-a", "svc-a/src"]);
    const pending = new Set(["svc-a"]);

    const clean = buildTreeRows({
      entries,
      folders,
      pending,
      root: "/ws",
      dirCounts: {},
      marks: {},
      repoRoots: new Set(),
    });
    assert.deepEqual(clean.rows.map(r => `${r.depth}:${r.kind}:${r.path}`), [
      "0:dir:svc-a",
      "1:dir:svc-a/src",
      "2:file:svc-a/src/app.js",
      "1:file:svc-a/index.js",
      "0:file:README.md",
    ]);
    assert.equal(clean.rows[0].isLoadingFolder, true);
    assert.equal(clean.rows[0].isRepo, false);
    assert.equal(clean.rows[0].dirCount, 0);
    assert.equal(clean.rows[2].mark, null);

    const dirtyWin = buildTreeRows({
      entries,
      folders,
      pending: new Set(),
      root: "C:\\WS\\",
      isWindows: true,
      repoRoots: new Set(["c:/ws/svc-a"]),
      dirCounts: { "c:/ws/svc-a": 2, "c:/ws/svc-a/src": 1 },
      marks: { "c:/ws/svc-a/src/app.js": "M" },
    });
    assert.equal(dirtyWin.byKey.get("svc-a").isRepo, true);
    assert.equal(dirtyWin.byKey.get("svc-a").dirCount, 2);
    assert.equal(dirtyWin.byKey.get("svc-a/src").dirCount, 1);
    assert.equal(dirtyWin.byKey.get("svc-a/src/app.js").mark, "M");

    const capped = buildTreeRows({
      entries,
      folders,
      pending: new Set(),
      root: "/ws",
      maxTotal: 2,
    });
    assert.equal(capped.rows.length, 2);
    assert.equal(capped.hitVisibleCap, true);
  });
});
