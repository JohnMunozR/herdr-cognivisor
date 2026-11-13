import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CASCADE_DEPTH,
  matchesServiceFilter,
  getCascadeChildPath,
  collectSubtreePaths,
  runFolderCascade,
} from "../mods/files-search/tree-logic.js";

function makeCascadeHarness(treeMap, { filterRel = null, maxDepth = MAX_CASCADE_DEPTH, failOn = null } = {}) {
  const folders = new Set();
  const entries = new Map();
  const pending = new Set();
  const pendingTokens = new Map();
  const folderTokens = new Map();
  const pendingSnapshots = [];
  const loads = [];
  const errors = [];
  let seq = 0;

  function acquirePending(path, token) {
    if (pending.has(path)) return pendingTokens.get(path) === token;
    pending.add(path);
    pendingTokens.set(path, token);
    return true;
  }

  function clearPending(path, token) {
    if (pendingTokens.get(path) === token) {
      pending.delete(path);
      pendingTokens.delete(path);
    }
  }

  function expandSyncAndSpawn(path, loaderImpl) {
    const token = ++seq;
    folders.add(path);
    folderTokens.set(path, token);
    if (!entries.has(path) && !pending.has(path)) {
      acquirePending(path, token);
    }
    pendingSnapshots.push([...pending]);

    const promise = runFolderCascade({
      startPath: path,
      maxDepth,
      getFilterRel: () => filterRel,
      isActive: p => folders.has(p) && folderTokens.get(p) === token,
      hasEntries: p => entries.has(p),
      getEntries: p => entries.get(p),
      acquirePending: p => acquirePending(p, token),
      clearPending: p => clearPending(p, token),
      expandFolder: p => {
        folders.add(p);
        folderTokens.set(p, token);
      },
      loadFolder: async p => {
        loads.push(p);
        if (failOn === p) throw new Error(`failed reading ${p}`);
        const list = loaderImpl ? await loaderImpl(p) : treeMap[p];
        if (folders.has(p)) {
          entries.set(p, list ?? []);
        }
        return entries.has(p);
      },
      onError: err => {
        errors.push(String(err.message || err));
      },
      onStep: () => {
        pendingSnapshots.push([...pending]);
      },
    });
    return { token, promise };
  }

  function collapse(path) {
    for (const p of collectSubtreePaths(folders, path)) {
      folders.delete(p);
      entries.delete(p);
    }
    for (const p of collectSubtreePaths(pending, path)) {
      pending.delete(p);
    }
    for (const p of collectSubtreePaths(pendingTokens.keys(), path)) {
      pendingTokens.delete(p);
    }
    for (const p of collectSubtreePaths(folderTokens.keys(), path)) {
      folderTokens.delete(p);
    }
  }

  return {
    folders,
    entries,
    pending,
    pendingTokens,
    folderTokens,
    pendingSnapshots,
    loads,
    errors,
    expandSyncAndSpawn,
    collapse,
  };
}

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

    // Stop when a file is present alongside a folder
    assert.equal(
      getCascadeChildPath("src", [{ name: "main", dir: true }, { name: "index.ts", dir: false }]),
      null,
    );
    // Stop on two folders
    assert.equal(
      getCascadeChildPath("src", [{ name: "a", dir: true }, { name: "b", dir: true }]),
      null,
    );
    // Stop on single file
    assert.equal(getCascadeChildPath("src", [{ name: "README.md", dir: false }]), null);
    // Stop on empty / missing entries
    assert.equal(getCascadeChildPath("src", []), null);
    assert.equal(getCascadeChildPath("src", null), null);

    // Filter down to a single visible branch under service filter
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

  test("runFolderCascade opens nested single-folder chain and clears spinner between steps", async () => {
    const h = makeCascadeHarness({
      java: [{ name: "com", dir: true }],
      "java/com": [{ name: "example", dir: true }],
      "java/com/example": [
        { name: "app", dir: true },
        { name: "Main.java", dir: false },
      ],
    });

    const { promise } = h.expandSyncAndSpawn("java");
    assert.deepEqual([...h.pending], ["java"]);
    await promise;

    assert.deepEqual([...h.folders], ["java", "java/com", "java/com/example"]);
    assert.deepEqual(h.loads, ["java", "java/com", "java/com/example"]);
    assert.deepEqual([...h.pending], []);

    // Verify spinner transitioned cleanly through each loading folder
    assert.ok(h.pendingSnapshots.some(snap => snap.length === 1 && snap[0] === "java"));
    assert.ok(h.pendingSnapshots.some(snap => snap.length === 1 && snap[0] === "java/com"));
    assert.ok(h.pendingSnapshots.some(snap => snap.length === 1 && snap[0] === "java/com/example"));
  });

  test("runFolderCascade stops on empty subfolder or single-file subfolder", async () => {
    const emptyLeafHarness = makeCascadeHarness({
      a: [{ name: "b", dir: true }],
      "a/b": [],
    });
    await emptyLeafHarness.expandSyncAndSpawn("a").promise;
    assert.deepEqual([...emptyLeafHarness.folders], ["a", "a/b"]);
    assert.deepEqual([...emptyLeafHarness.pending], []);

    const fileLeafHarness = makeCascadeHarness({
      a: [{ name: "b", dir: true }],
      "a/b": [{ name: "only.txt", dir: false }],
    });
    await fileLeafHarness.expandSyncAndSpawn("a").promise;
    assert.deepEqual([...fileLeafHarness.folders], ["a", "a/b"]);
    assert.deepEqual([...fileLeafHarness.pending], []);
  });

  test("collapsing a folder mid-load aborts cascade and protects a newer re-open", async () => {
    const resolvers = new Map();
    const h = makeCascadeHarness({
      a: [{ name: "b", dir: true }],
      "a/b": [{ name: "leaf.txt", dir: false }],
    });

    const run1 = h.expandSyncAndSpawn("a", p => new Promise(resolve => {
      resolvers.set(`${p}:1`, () => resolve([{ name: "b", dir: true }]));
    }));
    assert.equal(h.pending.has("a"), true);

    // User collapses mid-flight -> spinner and folders clear immediately
    h.collapse("a");
    assert.equal(h.folders.has("a"), false);
    assert.equal(h.pending.has("a"), false);

    // User immediately re-opens "a" while run1 is still resolving
    let resolveRun2;
    const run2 = h.expandSyncAndSpawn("a", p => new Promise(resolve => {
      if (p === "a") resolveRun2 = () => resolve([{ name: "b", dir: true }]);
      else resolve([{ name: "leaf.txt", dir: false }]);
    }));
    assert.equal(h.pending.has("a"), true);
    assert.equal(h.pendingTokens.get("a"), run2.token);

    // Resolve stale run1: must NOT clear run2's pending spinner
    resolvers.get("a:1")();
    await run1.promise;
    assert.equal(h.pending.has("a"), true, "stale run must not clear active re-open pending state");
    assert.equal(h.pendingTokens.get("a"), run2.token);

    // Resolve active run2: completes cleanly
    resolveRun2();
    await run2.promise;
    assert.deepEqual([...h.folders], ["a", "a/b"]);
    assert.deepEqual([...h.pending], []);
  });

  test("runFolderCascade enforces maxDepth bound and clears pending on load error", async () => {
    const deepTree = {
      d0: [{ name: "d1", dir: true }],
      "d0/d1": [{ name: "d2", dir: true }],
      "d0/d1/d2": [{ name: "d3", dir: true }],
      "d0/d1/d2/d3": [{ name: "d4", dir: true }],
      "d0/d1/d2/d3/d4": [{ name: "d5", dir: true }],
    };
    const bounded = makeCascadeHarness(deepTree, { maxDepth: 2 });
    await bounded.expandSyncAndSpawn("d0").promise;
    assert.deepEqual([...bounded.folders], ["d0", "d0/d1", "d0/d1/d2"]);
    assert.deepEqual([...bounded.pending], []);

    const errHarness = makeCascadeHarness(
      { a: [{ name: "b", dir: true }] },
      { failOn: "a/b" },
    );
    await errHarness.expandSyncAndSpawn("a").promise;
    assert.deepEqual(errHarness.errors, ["failed reading a/b"]);
    assert.deepEqual([...errHarness.pending], []);
  });
});
