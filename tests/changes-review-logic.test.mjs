import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getFileExt,
  tokenizeDiffLine,
  diffRows,
  normCmpStr,
  isSameOrChildPath,
  isIgnoredWatchPath,
  hasRelevantWatchChange,
  parsePorcelainHeader,
  getParentDir,
} from "../mods/changes-review/review-logic.js";

describe("changes-review review-logic", () => {
  test("getFileExt resolves extensionless Dockerfiles, Makefiles, dotfiles, and standard extensions", () => {
    assert.equal(getFileExt("services/auth/Dockerfile"), "dockerfile");
    assert.equal(getFileExt("Makefile"), "makefile");
    assert.equal(getFileExt(".env.local"), "env");
    assert.equal(getFileExt("C:\\repo\\src\\Button.TSX"), "tsx");
  });

  test("tokenizeDiffLine highlights keywords, strings, comments, numbers, functions, JSON keys, and Rust lifetimes", () => {
    const jsTokens = tokenizeDiffLine('const count = compute("abc", 42); // ok', "js");
    assert.ok(jsTokens.some(([k, v]) => k === "keyword" && v === "const"));
    assert.ok(jsTokens.some(([k, v]) => k === "function" && v === "compute"));
    assert.ok(jsTokens.some(([k, v]) => k === "string" && v === '"abc"'));
    assert.ok(jsTokens.some(([k, v]) => k === "number" && v === "42"));
    assert.ok(jsTokens.some(([k, v]) => k === "comment" && v === "// ok"));

    const jsonTokens = tokenizeDiffLine('  "scripts": "node --test"', "json");
    assert.ok(jsonTokens.some(([k, v]) => k === "function" && v === '"scripts"'));
    assert.ok(jsonTokens.some(([k, v]) => k === "string" && v === '"node --test"'));

    const rustTokens = tokenizeDiffLine("fn parse<'a>(input: &'a str) -> char { 'x' }", "rs");
    assert.ok(rustTokens.some(([k, v]) => k === "keyword" && v === "fn"));
    assert.ok(rustTokens.some(([k, v]) => k === "string" && v === "'x'"));
    assert.ok(!rustTokens.some(([k, v]) => k === "string" && v.includes("input")), "Rust lifetimes must not parse as strings");

    assert.equal(tokenizeDiffLine("x".repeat(501), "js"), null, "long lines should bypass tokenization cleanly");
  });

  test("diffRows tracks old/new line numbers and strips Windows CRLF", () => {
    const rows = diffRows(
      [
        "@@ -10,3 +20,4 @@\r",
        " context();\r",
        "-const a = 1;\r",
        "+const b = 2;\r",
        "+// note\r",
      ],
      "src/app.js",
    );
    assert.equal(rows[0].kind, "@");
    assert.deepEqual([rows[1].kind, rows[1].number], [" ", 20]);
    assert.deepEqual([rows[2].kind, rows[2].number], ["-", 11]);
    assert.deepEqual([rows[3].kind, rows[3].number], ["+", 21]);
    assert.deepEqual([rows[4].kind, rows[4].number], ["+", 22]);
    assert.ok(rows[3].tokens.some(([k, v]) => k === "keyword" && v === "const"));
  });

  test("watch filters ignore build/lock churn while catching source and git ref events cross-platform", () => {
    assert.equal(isIgnoredWatchPath("C:\\repo\\target\\classes\\Main.class", "C:\\Repo"), true);
    assert.equal(isIgnoredWatchPath("/repo/node_modules/pkg/index.js", "/repo"), true);
    assert.equal(isIgnoredWatchPath("/repo/.git/index.lock", "/repo"), true);
    assert.equal(isIgnoredWatchPath("/repo/.git/HEAD", "/repo"), false);
    assert.equal(isIgnoredWatchPath("/repo/.git/refs/heads/main", "/repo"), false);
    assert.equal(isIgnoredWatchPath("C:\\repo\\src\\index.ts", "C:\\Repo"), false);

    assert.equal(hasRelevantWatchChange(["/repo/target/a.o", "/repo/.git/objects/aa/bb"], "/repo"), false);
    assert.equal(hasRelevantWatchChange(["/repo/target/a.o", "/repo/src/lib.rs"], "/repo"), true);
    assert.equal(normCmpStr("C:\\Repo\\Sub\\", true), "c:/repo/sub");
    assert.equal(isSameOrChildPath("C:\\Repo\\Sub\\a.js", "c:/repo", true), true);
  });

  test("parsePorcelainHeader and getParentDir behave cleanly", () => {
    assert.deepEqual(parsePorcelainHeader("## main...origin/main [ahead 2, behind 1]"), {
      branch: "main",
      hasUpstream: true,
      ahead: 2,
    });
    assert.equal(getParentDir("/projects/org/repo"), "/projects/org");
    assert.equal(getParentDir("/repo"), null);
  });
});
