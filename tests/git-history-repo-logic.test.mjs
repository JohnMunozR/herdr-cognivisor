import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  READ_GIT,
  DISCOVER_SKIP_DIRS,
  isHomeDirectoryRoot,
  resolveWorkspaceRoot,
  parseBranchesOutput,
  mergeDiscoveredWithServices,
  resolveSelectedRepo,
  shouldIgnoreGitWatchEvent,
  resolveSessionAgentTabId,
} from "../mods/git-history/repo-logic.js";

describe("git-history repo-logic", () => {
  test("exports lock-free READ_GIT flags and DISCOVER_SKIP_DIRS", () => {
    assert.deepEqual(READ_GIT, [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.autoRefreshIndex=false",
    ]);
    for (const dir of [".git", "node_modules", "target", "dist", "build", ".next", "__pycache__"]) {
      assert.equal(DISCOVER_SKIP_DIRS.has(dir), true);
    }
  });

  test("isHomeDirectoryRoot and resolveWorkspaceRoot resolve space and pane roots safely", () => {
    assert.equal(isHomeDirectoryRoot("~"), true);
    assert.equal(isHomeDirectoryRoot("/root"), true);
    assert.equal(isHomeDirectoryRoot("/home/alice"), true);
    assert.equal(isHomeDirectoryRoot("/Users/alice/"), true);
    assert.equal(isHomeDirectoryRoot("C:\\Users\\alice"), true);
    assert.equal(isHomeDirectoryRoot("/home/alice/projects/cognivisor"), false);
    assert.equal(isHomeDirectoryRoot("/custom", null, "/custom/.herdr"), true);

    assert.equal(
      resolveWorkspaceRoot({ folder: "/home/alice" }, { cwd: "/home/alice/work/api" }),
      "/home/alice/work/api",
    );
    assert.equal(
      resolveWorkspaceRoot({ folder: "/work/cognivisor" }, { cwd: "/work/cognivisor/services/auth" }),
      "/work/cognivisor",
    );
    assert.equal(
      resolveWorkspaceRoot({ folder: "/work/cognivisor" }, { cwd: "/other/repo" }),
      "/other/repo",
    );
    assert.equal(
      resolveWorkspaceRoot({ spaceFolder: "/work/cognivisor", paneCwd: null }),
      "/work/cognivisor",
    );
    assert.equal(
      resolveWorkspaceRoot(null, { cwd: "/work/standalone" }),
      "/work/standalone",
    );
  });

  test("parseBranchesOutput parses tab-delimited (%09) local and remote refs while filtering symbolic /HEAD", () => {
    const stdout = [
      " \tfix/changes-review\trefs/heads/fix/changes-review\t885a77d",
      "*\tmain\trefs/heads/main\t885a77d",
      " \torigin\trefs/remotes/origin/HEAD\t885a77d",
      " \tupstream\trefs/remotes/upstream/HEAD\t1234abc",
      " \torigin/fix/changes-review\trefs/remotes/origin/fix/changes-review\t885a77d",
      " \torigin/main\trefs/remotes/origin/main\t885a77d",
      " \tupstream/main\trefs/remotes/upstream/main\t1234abc",
      "",
    ].join("\n");

    const branches = parseBranchesOutput(stdout);
    assert.deepEqual(branches, [
      {
        name: "fix/changes-review",
        fullName: "refs/heads/fix/changes-review",
        kind: "local",
        isCurrent: false,
        shortHash: "885a77d",
      },
      {
        name: "main",
        fullName: "refs/heads/main",
        kind: "local",
        isCurrent: true,
        shortHash: "885a77d",
      },
      {
        name: "origin/fix/changes-review",
        fullName: "refs/remotes/origin/fix/changes-review",
        kind: "remote",
        isCurrent: false,
        shortHash: "885a77d",
      },
      {
        name: "origin/main",
        fullName: "refs/remotes/origin/main",
        kind: "remote",
        isCurrent: false,
        shortHash: "885a77d",
      },
      {
        name: "upstream/main",
        fullName: "refs/remotes/upstream/main",
        kind: "remote",
        isCurrent: false,
        shortHash: "1234abc",
      },
    ]);
    assert.equal(branches.some((b) => b.name === "origin" || b.fullName.endsWith("/HEAD")), false);
    assert.deepEqual(parseBranchesOutput(""), []);
    // Regression check: unexpanded literal %x1f from old format must not yield bogus branches
    assert.deepEqual(parseBranchesOutput("*%x1fmain%x1frefs/heads/main%x1f885a77d\n"), []);
  });

  test("parseBranchesOutput maintains backwards compatibility with \\x1f delimited refs and filters /HEAD", () => {
    const stdout = [
      "*\x1fmain\x1frefs/heads/main\x1fa1b2c3d",
      " \x1ffeat/git-history\x1frefs/heads/feat/git-history\x1fd4e5f60",
      " \x1forigin\x1frefs/remotes/origin/HEAD\x1fa1b2c3d",
      " \x1forigin/main\x1frefs/remotes/origin/main\x1fa1b2c3d",
      "",
    ].join("\n");

    const branches = parseBranchesOutput(stdout);
    assert.deepEqual(branches, [
      { name: "main", fullName: "refs/heads/main", kind: "local", isCurrent: true, shortHash: "a1b2c3d" },
      { name: "feat/git-history", fullName: "refs/heads/feat/git-history", kind: "local", isCurrent: false, shortHash: "d4e5f60" },
      { name: "origin/main", fullName: "refs/remotes/origin/main", kind: "remote", isCurrent: false, shortHash: "a1b2c3d" },
    ]);
  });

  test("mergeDiscoveredWithServices preserves clean repos and enriches dirty repos from cognivisor.services", () => {
    const discovered = ["/ws/clean-repo", "/ws/auth-service/"];
    const cognivisorServices = {
      spaceId: "space-1",
      services: [
        {
          id: "auth-service",
          name: "auth-service",
          root: "/ws/auth-service",
          branch: "feat/jwt",
          workingCount: 4,
        },
      ],
      candidates: [
        {
          id: "clean-repo",
          name: "clean-repo",
          root: "/ws/clean-repo",
          branch: "main",
        },
      ],
    };

    const repos = mergeDiscoveredWithServices(discovered, cognivisorServices, "space-1");
    assert.deepEqual(repos, [
      {
        id: "clean-repo",
        name: "clean-repo",
        root: "/ws/clean-repo",
        branch: "main",
        dirtyCount: 0,
        isDirty: false,
      },
      {
        id: "auth-service",
        name: "auth-service",
        root: "/ws/auth-service",
        branch: "feat/jwt",
        dirtyCount: 4,
        isDirty: true,
      },
    ]);

    // Clean repos must still appear when cognivisor.services is null or belongs to another space
    const cleanOnly = mergeDiscoveredWithServices(["/ws/solo-clean"], { spaceId: "other", services: [{ id: "x", root: "/ws/x", workingCount: 2 }] }, "space-1");
    assert.equal(cleanOnly.length, 1);
    assert.equal(cleanOnly[0].isDirty, false);
  });

  test("resolveSelectedRepo prefers selectedRepoState, then activeServiceState (!= 'all'), then repos[0]", () => {
    const repos = [
      { id: "clean-repo", name: "clean-repo", root: "/ws/clean-repo" },
      { id: "auth-service", name: "auth-service", root: "/ws/auth-service" },
    ];

    assert.equal(
      resolveSelectedRepo(repos, { repoRoot: "/ws/clean-repo", ts: 10 }, { serviceId: "auth-service", ts: 20 })?.id,
      "clean-repo",
    );
    assert.equal(
      resolveSelectedRepo(repos, null, { serviceId: "auth-service", ts: 20 })?.id,
      "auth-service",
    );
    assert.equal(
      resolveSelectedRepo(repos, { repoRoot: "/ws/missing" }, { serviceId: "all", ts: 20 })?.id,
      "clean-repo",
    );
    assert.equal(resolveSelectedRepo([], null, null), null);
  });

  test("shouldIgnoreGitWatchEvent ignores lock/index/temp files while allowing HEAD, refs/, and packed-refs", () => {
    assert.equal(shouldIgnoreGitWatchEvent("index.lock"), true);
    assert.equal(shouldIgnoreGitWatchEvent("/ws/repo/.git/index.lock"), true);
    assert.equal(shouldIgnoreGitWatchEvent("refs/heads/main.lock"), true);
    assert.equal(shouldIgnoreGitWatchEvent("HEAD.lock"), true);
    assert.equal(shouldIgnoreGitWatchEvent("index"), true);
    assert.equal(shouldIgnoreGitWatchEvent("COMMIT_EDITMSG"), true);
    assert.equal(shouldIgnoreGitWatchEvent("FETCH_HEAD"), true);
    assert.equal(shouldIgnoreGitWatchEvent("ORIG_HEAD"), true);
    assert.equal(shouldIgnoreGitWatchEvent("MERGE_MSG"), true);
    assert.equal(shouldIgnoreGitWatchEvent("tmp_obj_123.tmp"), true);

    assert.equal(shouldIgnoreGitWatchEvent("HEAD"), false);
    assert.equal(shouldIgnoreGitWatchEvent("/ws/repo/.git/HEAD"), false);
    assert.equal(shouldIgnoreGitWatchEvent("refs/heads/main"), false);
    assert.equal(shouldIgnoreGitWatchEvent("/ws/repo/.git/refs/remotes/origin/main"), false);
    assert.equal(shouldIgnoreGitWatchEvent("packed-refs"), false);
    assert.equal(shouldIgnoreGitWatchEvent("/ws/repo/.git/packed-refs"), false);
  });

  test("resolveSessionAgentTabId preserves terminal session tab when a git-history viewer tab is active", () => {
    const space = {
      id: "sp1",
      tabs: [
        { id: "term-1", active: false },
        { id: "git-tab", active: true },
      ],
    };
    const allPanes = [
      { pane: "p1", tab: "term-1", terminal: { pid: 100 } },
      { pane: "p2", tab: "git-tab", mod: "git-history" },
    ];
    assert.equal(resolveSessionAgentTabId(space, allPanes, { sp1: "term-1" }), "term-1");
    assert.equal(resolveSessionAgentTabId(space, allPanes, {}), "term-1");

    const termActiveSpace = {
      id: "sp1",
      tabs: [
        { id: "term-1", active: true },
        { id: "git-tab", active: false },
      ],
    };
    assert.equal(resolveSessionAgentTabId(termActiveSpace, allPanes, {}), "term-1");
    assert.equal(resolveSessionAgentTabId(null, allPanes, {}), null);
  });
});
