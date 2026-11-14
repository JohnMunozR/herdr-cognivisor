import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  LOG_FIELD_SEP,
  LOG_RECORD_SEP,
  parseDecorations,
  parseGitLogOutput,
  computeCommitGraphLayout,
  filterCommits,
  formatRelativeTime,
} from "../mods/git-history/graph-logic.js";

/**
 * Verifies the mathematical lane continuity invariant across all consecutive rows:
 * every active lane exiting row r at (toLane, yBot) enters row r+1 at (fromLane, yTop)
 * with the exact same lane index and colorIndex, and no phantom lanes appear or vanish.
 */
function assertLaneContinuity(layout) {
  const { rows, maxLaneCount } = layout;
  if (rows.length === 0) {
    assert.equal(maxLaneCount, 0);
    return;
  }

  assert.equal(rows[0].incomingEdges.length, 0, "row 0 must have no incomingEdges");
  assert.equal(rows[0].passThroughLanes.length, 0, "row 0 must have no passThroughLanes");

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    assert.ok(row.lane >= 0 && row.lane < row.maxLanes, `row ${r} lane within maxLanes`);
    assert.ok(row.maxLanes <= maxLaneCount, `row ${r} maxLanes <= maxLaneCount`);

    if (row.isRoot) {
      assert.equal(row.outgoingEdges.length, 0, `root row ${r} must have no outgoingEdges`);
    }

    if (r === rows.length - 1) continue;

    // Collect lanes exiting row r at yBot with their active slot colorIndex.
    // Pass-through lanes carry the persistent slot color when an outgoing edge converges into them.
    const exitMap = new Map();
    for (const pt of row.passThroughLanes) {
      assert.ok(!exitMap.has(pt.lane), `row ${r} duplicate passThrough lane ${pt.lane}`);
      exitMap.set(pt.lane, pt.colorIndex);
    }
    for (const edge of row.outgoingEdges) {
      assert.equal(edge.fromLane, row.lane, `row ${r} outgoingEdge must start at commitLane`);
      if (!exitMap.has(edge.toLane)) {
        exitMap.set(edge.toLane, edge.colorIndex);
      }
    }

    // Collect lanes entering row r+1 at yTop.
    const nextRow = rows[r + 1];
    const entryMap = new Map();
    for (const pt of nextRow.passThroughLanes) {
      assert.ok(!entryMap.has(pt.lane), `row ${r + 1} duplicate passThrough lane ${pt.lane}`);
      entryMap.set(pt.lane, pt.colorIndex);
    }
    for (const edge of nextRow.incomingEdges) {
      assert.equal(edge.toLane, nextRow.lane, `row ${r + 1} incomingEdge must end at commitLane`);
      assert.ok(!entryMap.has(edge.fromLane), `row ${r + 1} lane ${edge.fromLane} entered twice`);
      entryMap.set(edge.fromLane, edge.colorIndex);
    }

    assert.equal(
      exitMap.size,
      entryMap.size,
      `lane count mismatch between row ${r} (${exitMap.size}) and row ${r + 1} (${entryMap.size})`,
    );
    for (const [lane, colorIndex] of exitMap.entries()) {
      assert.ok(
        entryMap.has(lane),
        `lane ${lane} exited row ${r} but did not enter row ${r + 1}`,
      );
      assert.equal(
        entryMap.get(lane),
        colorIndex,
        `lane ${lane} changed colorIndex from ${colorIndex} to ${entryMap.get(lane)} between row ${r} and ${r + 1}`,
      );
    }
  }
}

describe("git-history graph-logic", () => {
  test("exports expected ASCII separators", () => {
    assert.equal(LOG_FIELD_SEP, "\x1f");
    assert.equal(LOG_RECORD_SEP, "\x1e");
  });

  test("parseDecorations parses HEAD, local, remote, tag, detached HEAD, and slash branches", () => {
    assert.deepEqual(parseDecorations(""), []);
    assert.deepEqual(parseDecorations("   "), []);
    assert.deepEqual(parseDecorations(null), []);

    assert.deepEqual(
      parseDecorations("HEAD -> main, tag: v1.0, origin/main, origin/HEAD, feat/auth"),
      [
        { kind: "head", label: "main", isHeadBranch: true },
        { kind: "tag", label: "v1.0" },
        { kind: "remote", label: "origin/main" },
        { kind: "remote", label: "origin/HEAD" },
        { kind: "local", label: "feat/auth" },
      ],
    );

    assert.deepEqual(parseDecorations("HEAD, upstream/develop, tag: release-2.1"), [
      { kind: "head", label: "HEAD" },
      { kind: "remote", label: "upstream/develop" },
      { kind: "tag", label: "release-2.1" },
    ]);

    assert.deepEqual(
      parseDecorations("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/tags/v0.1.0"),
      [
        { kind: "head", label: "main", isHeadBranch: true },
        { kind: "remote", label: "origin/main" },
        { kind: "tag", label: "v0.1.0" },
      ],
    );
  });

  test("parseGitLogOutput parses record-separated log output including multi-line bodies and root commits", () => {
    const rec1 = [
      "a1b2c3d4e5f6789012345678901234567890abcd",
      "1111111111111111111111111111111111111111 2222222222222222222222222222222222222222",
      "Alice Dev",
      "alice@example.com",
      "1700000100",
      "HEAD -> main, origin/main",
      "Merge pull request #42",
      "Line 1 of body\nLine 2 of body",
    ].join(LOG_FIELD_SEP);

    const rec2 = [
      "1111111111111111111111111111111111111111",
      "",
      "Bob",
      "bob@example.com",
      "1700000000",
      "tag: v0.1.0",
      "Initial commit",
      "",
    ].join(LOG_FIELD_SEP);

    const raw = `${rec1}${LOG_RECORD_SEP}\n${rec2}${LOG_RECORD_SEP}\n`;
    const parsed = parseGitLogOutput(raw);

    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      hash: "a1b2c3d4e5f6789012345678901234567890abcd",
      shortHash: "a1b2c3d",
      parents: [
        "1111111111111111111111111111111111111111",
        "2222222222222222222222222222222222222222",
      ],
      author: "Alice Dev",
      email: "alice@example.com",
      timestamp: 1700000100,
      refs: [
        { kind: "head", label: "main", isHeadBranch: true },
        { kind: "remote", label: "origin/main" },
      ],
      subject: "Merge pull request #42",
      body: "Line 1 of body\nLine 2 of body",
    });

    assert.deepEqual(parsed[1], {
      hash: "1111111111111111111111111111111111111111",
      shortHash: "1111111",
      parents: [],
      author: "Bob",
      email: "bob@example.com",
      timestamp: 1700000000,
      refs: [{ kind: "tag", label: "v0.1.0" }],
      subject: "Initial commit",
      body: "",
    });

    assert.deepEqual(parseGitLogOutput(""), []);
    assert.deepEqual(parseGitLogOutput(null), []);
  });

  test("computeCommitGraphLayout handles empty input and single root commit", () => {
    assert.deepEqual(computeCommitGraphLayout([]), { rows: [], maxLaneCount: 0 });

    const single = computeCommitGraphLayout([{ hash: "root", parents: [] }]);
    assert.equal(single.maxLaneCount, 1);
    assert.deepEqual(single.rows, [
      {
        hash: "root",
        lane: 0,
        colorIndex: 0,
        isMerge: false,
        isRoot: true,
        maxLanes: 1,
        passThroughLanes: [],
        incomingEdges: [],
        outgoingEdges: [],
      },
    ]);
    assertLaneContinuity(single);
  });

  test("computeCommitGraphLayout renders linear chain on lane 0 with constant color", () => {
    const commits = [
      { hash: "c3", parents: ["c2"] },
      { hash: "c2", parents: ["c1"] },
      { hash: "c1", parents: [] },
    ];
    const layout = computeCommitGraphLayout(commits);

    assert.equal(layout.maxLaneCount, 1);
    assert.equal(layout.rows.length, 3);
    assert.equal(layout.rows[0].lane, 0);
    assert.equal(layout.rows[0].isMerge, false);
    assert.equal(layout.rows[0].isRoot, false);
    assert.deepEqual(layout.rows[0].outgoingEdges, [{ fromLane: 0, toLane: 0, colorIndex: 0 }]);

    assert.equal(layout.rows[1].lane, 0);
    assert.deepEqual(layout.rows[1].incomingEdges, [{ fromLane: 0, toLane: 0, colorIndex: 0 }]);
    assert.deepEqual(layout.rows[1].outgoingEdges, [{ fromLane: 0, toLane: 0, colorIndex: 0 }]);

    assert.equal(layout.rows[2].lane, 0);
    assert.equal(layout.rows[2].isRoot, true);
    assert.deepEqual(layout.rows[2].incomingEdges, [{ fromLane: 0, toLane: 0, colorIndex: 0 }]);
    assert.deepEqual(layout.rows[2].outgoingEdges, []);

    assertLaneContinuity(layout);
  });

  test("computeCommitGraphLayout handles simple fork + merge in both topo orders", () => {
    // M (P1, F1) -> P1 (B) -> F1 (B) -> B (root)
    const orderA = computeCommitGraphLayout([
      { hash: "M", parents: ["P1", "F1"] },
      { hash: "P1", parents: ["B"] },
      { hash: "F1", parents: ["B"] },
      { hash: "B", parents: [] },
    ]);
    assert.equal(orderA.maxLaneCount, 2);
    assert.equal(orderA.rows[0].isMerge, true);
    assert.deepEqual(orderA.rows[0].outgoingEdges, [
      { fromLane: 0, toLane: 0, colorIndex: 0 },
      { fromLane: 0, toLane: 1, colorIndex: 1 },
    ]);
    assert.equal(orderA.rows[1].lane, 0);
    assert.deepEqual(orderA.rows[1].passThroughLanes, [{ lane: 1, colorIndex: 1 }]);
    assert.equal(orderA.rows[2].lane, 1);
    assert.deepEqual(orderA.rows[2].outgoingEdges, [{ fromLane: 1, toLane: 0, colorIndex: 1 }]);
    assert.equal(orderA.rows[3].lane, 0);
    assert.equal(orderA.rows[3].isRoot, true);
    assertLaneContinuity(orderA);

    // M (P1, F1) -> F1 (B) -> P1 (B) -> B (root)
    const orderB = computeCommitGraphLayout([
      { hash: "M", parents: ["P1", "F1"] },
      { hash: "F1", parents: ["B"] },
      { hash: "P1", parents: ["B"] },
      { hash: "B", parents: [] },
    ]);
    assert.equal(orderB.maxLaneCount, 2);
    assert.equal(orderB.rows[1].lane, 1);
    assert.deepEqual(orderB.rows[1].passThroughLanes, [{ lane: 0, colorIndex: 0 }]);
    assert.equal(orderB.rows[2].lane, 0);
    assert.deepEqual(orderB.rows[2].outgoingEdges, [{ fromLane: 0, toLane: 1, colorIndex: 0 }]);
    assert.equal(orderB.rows[3].lane, 1);
    assert.equal(orderB.rows[3].isRoot, true);
    assertLaneContinuity(orderB);
  });

  test("computeCommitGraphLayout handles octopus merge (3+ parents)", () => {
    const layout = computeCommitGraphLayout([
      { hash: "OCTO", parents: ["P0", "P1", "P2", "P3"] },
      { hash: "P3", parents: ["BASE"] },
      { hash: "P2", parents: ["BASE"] },
      { hash: "P1", parents: ["BASE"] },
      { hash: "P0", parents: ["BASE"] },
      { hash: "BASE", parents: [] },
    ]);

    assert.equal(layout.maxLaneCount, 4);
    assert.equal(layout.rows[0].isMerge, true);
    assert.equal(layout.rows[0].outgoingEdges.length, 4);
    assert.deepEqual(
      layout.rows[0].outgoingEdges.map((e) => e.toLane),
      [0, 1, 2, 3],
    );
    // Distinct colors for the 4 active lanes
    const branchColors = new Set(layout.rows[0].outgoingEdges.map((e) => e.colorIndex));
    assert.equal(branchColors.size, 4);

    assert.equal(layout.rows[5].isRoot, true);
    assertLaneContinuity(layout);
  });

  test("computeCommitGraphLayout handles multi-branch converging tips and lane reuse", () => {
    const layout = computeCommitGraphLayout([
      { hash: "tip-a", parents: ["a1"] },
      { hash: "tip-b", parents: ["b1"] },
      { hash: "tip-c", parents: ["base"] },
      { hash: "a1", parents: ["base"] },
      { hash: "b1", parents: ["base"] },
      { hash: "base", parents: ["root"] },
      { hash: "root", parents: [] },
    ]);

    assert.equal(layout.rows[0].lane, 0);
    assert.equal(layout.rows[1].lane, 1);
    assert.equal(layout.rows[2].lane, 2);
    // tip-c sets base on lane 2; then a1 and b1 converge onto lane 2 cleanly
    assert.equal(layout.rows[3].lane, 0);
    assert.deepEqual(layout.rows[3].outgoingEdges, [{ fromLane: 0, toLane: 2, colorIndex: 0 }]);
    assert.equal(layout.rows[4].lane, 1);
    assert.deepEqual(layout.rows[4].outgoingEdges, [{ fromLane: 1, toLane: 2, colorIndex: 1 }]);
    assert.equal(layout.rows[5].lane, 2);
    assert.equal(layout.rows[6].lane, 2);
    assert.equal(layout.rows[6].isRoot, true);
    assertLaneContinuity(layout);

    // Also verify multiple disconnected roots + subsequent tip reusing freed lane 0
    const multiRoot = computeCommitGraphLayout([
      { hash: "orphan-tip", parents: ["orphan-root"] },
      { hash: "orphan-root", parents: [] },
      { hash: "main-tip", parents: ["main-root"] },
      { hash: "main-root", parents: [] },
    ]);
    assert.equal(multiRoot.maxLaneCount, 1);
    assert.equal(multiRoot.rows[1].isRoot, true);
    assert.equal(multiRoot.rows[2].lane, 0);
    assert.equal(multiRoot.rows[3].isRoot, true);
    assertLaneContinuity(multiRoot);
  });

  test("computeCommitGraphLayout maintains continuity across complex interleaved DAG", () => {
    const complex = computeCommitGraphLayout([
      { hash: "c10", parents: ["c9", "c8"] },
      { hash: "c9", parents: ["c7"] },
      { hash: "feat-tip", parents: ["c8"] },
      { hash: "c8", parents: ["c6", "c5"] },
      { hash: "c7", parents: ["c4"] },
      { hash: "c6", parents: ["c4"] },
      { hash: "c5", parents: ["c3"] },
      { hash: "c4", parents: ["c2"] },
      { hash: "c3", parents: ["c2"] },
      { hash: "c2", parents: ["c1"] },
      { hash: "c1", parents: [] },
    ]);

    assert.ok(complex.maxLaneCount >= 3);
    assertLaneContinuity(complex);
  });

  test("filterCommits matches hash, shortHash, subject, author, and refs[].label case-insensitively", () => {
    const commits = [
      {
        hash: "abcdef1234567890",
        shortHash: "abcdef1",
        subject: "feat: JWT refresh rotation",
        author: "Alice Vance",
        refs: [
          { kind: "head", label: "main", isHeadBranch: true },
          { kind: "tag", label: "v1.4.0" },
        ],
      },
      {
        hash: "9876543210fedcba",
        shortHash: "9876543",
        subject: "fix: race condition in worker",
        author: "Bob Smith",
        refs: [{ kind: "remote", label: "origin/fix-race" }],
      },
    ];

    assert.equal(filterCommits(commits, "").length, 2);
    assert.equal(filterCommits(commits, "   ").length, 2);
    assert.equal(filterCommits(commits, null).length, 2);
    assert.deepEqual(
      filterCommits(commits, "JWT").map((c) => c.shortHash),
      ["abcdef1"],
    );
    assert.deepEqual(
      filterCommits(commits, "BOB").map((c) => c.shortHash),
      ["9876543"],
    );
    assert.deepEqual(
      filterCommits(commits, "ABCDEF12").map((c) => c.shortHash),
      ["abcdef1"],
    );
    assert.deepEqual(
      filterCommits(commits, "9876543").map((c) => c.shortHash),
      ["9876543"],
    );
    assert.deepEqual(
      filterCommits(commits, "V1.4").map((c) => c.shortHash),
      ["abcdef1"],
    );
    assert.deepEqual(
      filterCommits(commits, "fix-race").map((c) => c.shortHash),
      ["9876543"],
    );
    assert.equal(filterCommits(commits, "nonexistent").length, 0);
  });

  test("formatRelativeTime formats concise relative timestamps and YYYY-MM-DD fallback", () => {
    const baseSec = 1700000000; // 2023-11-14T22:13:20.000Z
    const baseMs = baseSec * 1000;

    assert.equal(formatRelativeTime(baseSec, baseMs), "just now");
    assert.equal(formatRelativeTime(baseSec - 45, baseMs), "just now");
    assert.equal(formatRelativeTime(baseSec - 5 * 60, baseMs), "5m ago");
    assert.equal(formatRelativeTime(baseSec - 2 * 3600, baseMs), "2h ago");
    assert.equal(formatRelativeTime(baseSec - 3 * 86400, baseMs), "3d ago");
    assert.equal(formatRelativeTime(baseSec - 40 * 86400, baseMs), "2023-10-05");
    assert.equal(formatRelativeTime(NaN, baseMs), "");
    assert.equal(formatRelativeTime(-1, baseMs), "");
  });
});
