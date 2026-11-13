import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  repoMatchesTranscript,
  parsePorcelainHeader,
  parseSearchOutputLines,
  scoreSubseqFast,
  fuzzy,
  prepareSearchQuery,
  scoreIndexEntry,
  buildTopFileItems,
} from "../mods/files-search/search-logic.js";

describe("files-search search-logic", () => {
  test("prepareSearchQuery and scoreIndexEntry rank folders with trailing slash higher than files", () => {
    const dirEntry = {
      kind: "dir",
      path: "mods/files-search",
      name: "files-search",
      lowerPath: "mods/files-search",
      lowerName: "files-search",
    };
    const fileEntry = {
      kind: "file",
      path: "mods/files-search/main.js",
      name: "main.js",
      lowerPath: "mods/files-search/main.js",
      lowerName: "main.js",
    };

    const qsSlash = prepareSearchQuery("files-search/");
    assert.equal(qsSlash.qEndsSlash, true);
    assert.equal(qsSlash.matchKey, "files-search");

    const dirScore = scoreIndexEntry(dirEntry, qsSlash);
    const fileScore = scoreIndexEntry(fileEntry, qsSlash);
    assert.ok(dirScore.score > 0);
    assert.equal(dirScore.fromName, true);
    assert.ok(dirScore.score > fileScore.score, "folder should outrank files inside it on trailing slash query");

    const nestedDirEntry = {
      kind: "dir",
      path: "src/components",
      name: "components",
      lowerPath: "src/components",
      lowerName: "components",
    };
    const nestedFileEntry = {
      kind: "file",
      path: "src/components/index.ts",
      name: "index.ts",
      lowerPath: "src/components/index.ts",
      lowerName: "index.ts",
    };
    const qsPathSlash = prepareSearchQuery("src/components/");
    assert.ok(scoreIndexEntry(nestedDirEntry, qsPathSlash).score > scoreIndexEntry(nestedFileEntry, qsPathSlash).score);
  });

  test("fuzzy and scoreSubseqFast prioritize word-boundary & contiguous matches cleanly", () => {
    const exactMatch = fuzzy("idx", "idx.js");
    const scatteredMatch = fuzzy("idx", "mid_extra_file.js");
    assert.ok(exactMatch);
    assert.ok(scatteredMatch);
    assert.ok(exactMatch.score > scatteredMatch.score);
    assert.deepEqual(exactMatch.hits, [0, 1, 2]);

    const qChars = Array.from("idx");
    assert.ok(scoreSubseqFast("idx.js", qChars, 3) > scoreSubseqFast("mid_extra_file.js", qChars, 3));
    assert.equal(scoreSubseqFast("readme.md", qChars, 3), -Infinity);
  });

  test("buildTopFileItems preserves kind and computes highlight hits when requested", () => {
    const items = buildTopFileItems(
      [
        { entry: { kind: "file", path: "a/foo.js", name: "foo.js" }, score: 10, fromName: true },
        { entry: { kind: "dir", path: "src/foo", name: "foo" }, score: 25, fromName: true },
      ],
      "foo",
      true,
    );
    assert.equal(items[0].kind, "dir");
    assert.equal(items[0].path, "src/foo");
    assert.deepEqual(items[0].hits, [0, 1, 2]);
    assert.equal(items[1].kind, "file");
  });

  test("prepareSearchQuery requires at least one non-whitespace character before matching files", () => {
    assert.equal(prepareSearchQuery(""), null);
    assert.equal(prepareSearchQuery("   \t\n "), null);

    const qsSingle = prepareSearchQuery("a");
    assert.ok(qsSingle);
    assert.equal(qsSingle.qLen, 1);
    const hit = scoreIndexEntry(
      { kind: "file", path: "src/app.js", name: "app.js", lowerPath: "src/app.js", lowerName: "app.js" },
      qsSingle,
    );
    assert.ok(hit.score > -Infinity);
  });

  test("parseSearchOutputLines normalizes Windows paths, supports rg/git formats, and truncates long lines near query", () => {
    const padding = "x".repeat(180);
    const stdout = [
      "src\\nested\\app.js:12:5:  const targetValue = 42;",
      `./docs/long.md:8:${padding} specialNeedle ${padding}`,
    ].join("\n");

    const parsed = parseSearchOutputLines(stdout, "specialNeedle", "auth-api/");
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      { kind: parsed[0].kind, path: parsed[0].path, line: parsed[0].line, content: parsed[0].content },
      { kind: "text", path: "auth-api/src/nested/app.js", line: 12, content: "const targetValue = 42;" },
    );
    assert.equal(parsed[1].path, "auth-api/docs/long.md");
    assert.ok(parsed[1].content.includes("specialNeedle"));
    assert.ok(parsed[1].content.startsWith("…"));
  });

  test("parsePorcelainHeader extracts branch, upstream state, and ahead count", () => {
    assert.deepEqual(parsePorcelainHeader("## feat/PROJ-12...origin/feat/PROJ-12 [ahead 3]"), {
      branch: "feat/PROJ-12",
      hasUpstream: true,
      ahead: 3,
    });
    assert.deepEqual(parsePorcelainHeader("## No commits yet on main"), {
      branch: "main",
      hasUpstream: false,
      ahead: 0,
    });
    assert.deepEqual(parsePorcelainHeader("## HEAD (no branch)"), {
      branch: "HEAD",
      hasUpstream: false,
      ahead: 0,
    });
  });

  test("repoMatchesTranscript escapes special regex characters and matches repo hints", () => {
    const svc = { root: "C:\\work\\auth+v2", relPath: "auth+v2", name: "auth+v2" };
    assert.equal(repoMatchesTranscript(svc, [], "Editing auth+v2/src/jwt.ts"), true);
    assert.equal(repoMatchesTranscript(svc, [{ name: "JwtTokenFilter.java" }], "Updated JwtTokenFilter.java"), true);
    assert.equal(repoMatchesTranscript(svc, [], "Unrelated billing-service/pom.xml"), false);
  });
});
