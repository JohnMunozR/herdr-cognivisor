import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  MAX_CASCADE_DEPTH,
  POSIX_CASCADE_SCRIPT,
  sortDirectoryEntries,
  matchesServiceFilter,
  getCascadeChildPath,
  collectSubtreePaths,
  parseCascadeStdout,
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
});
