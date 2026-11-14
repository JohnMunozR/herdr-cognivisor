import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIFF_SYNTAX_LINE_CHARS,
  MAX_VIEWER_DIFF_LINES,
  DEFAULT_SBS_PAGE_ROWS,
  MAX_RENDER_TOKENS_PER_LINE,
  parseCommitFiles,
  getFileExt,
  expandCodeTabs,
  tokenizeDiffLine,
  getDiffSyntaxPalette,
  diffSyntaxTokenColor,
  buildSideBySideRows,
  buildUnifiedRows,
  computeDiffColumnWidths,
  resolveGitFileIcon,
  computeViewerLoadedKey,
  formatGitTabTitle,
  paginateDiffRows,
  capRenderTokens,
} from "../mods/git-history/diff-logic.js";

describe("git-history diff-logic", () => {
  test("exports expected line and syntax thresholds", () => {
    assert.equal(MAX_DIFF_SYNTAX_LINE_CHARS, 500);
    assert.equal(MAX_VIEWER_DIFF_LINES, 1500);
  });

  test("parseCommitFiles parses newline outputs including renames, copies, additions, deletions, type changes, and binary", () => {
    const numstat = [
      "12\t3\tsrc/auth.ts",
      "48\t0\tsrc/new-file.js",
      "0\t20\tsrc/old-file.js",
      "5\t2\tsrc/{legacy => modern}/service.java",
      "1\t0\tsrc/original.py => src/copied.py",
      "-\t-\tassets/logo.png",
      "2\t1\tscripts/run.sh",
    ].join("\n");

    const nameStatus = [
      "M\tsrc/auth.ts",
      "A\tsrc/new-file.js",
      "D\tsrc/old-file.js",
      "R100\tsrc/legacy/service.java\tsrc/modern/service.java",
      "C090\tsrc/original.py\tsrc/copied.py",
      "M\tassets/logo.png",
      "T\tscripts/run.sh",
    ].join("\n");

    const files = parseCommitFiles(numstat, nameStatus);
    assert.equal(files.length, 7);

    assert.deepEqual(files[0], {
      path: "src/auth.ts",
      oldPath: null,
      status: "M",
      added: 12,
      deleted: 3,
      binary: false,
      displayPath: "src/auth.ts",
    });
    assert.deepEqual(files[1], {
      path: "src/new-file.js",
      oldPath: null,
      status: "A",
      added: 48,
      deleted: 0,
      binary: false,
      displayPath: "src/new-file.js",
    });
    assert.deepEqual(files[2], {
      path: "src/old-file.js",
      oldPath: null,
      status: "D",
      added: 0,
      deleted: 20,
      binary: false,
      displayPath: "src/old-file.js",
    });
    assert.deepEqual(files[3], {
      path: "src/modern/service.java",
      oldPath: "src/legacy/service.java",
      status: "R",
      added: 5,
      deleted: 2,
      binary: false,
      displayPath: "src/legacy/service.java -> src/modern/service.java",
    });
    assert.deepEqual(files[4], {
      path: "src/copied.py",
      oldPath: "src/original.py",
      status: "C",
      added: 1,
      deleted: 0,
      binary: false,
      displayPath: "src/original.py -> src/copied.py",
    });
    assert.deepEqual(files[5], {
      path: "assets/logo.png",
      oldPath: null,
      status: "M",
      added: 0,
      deleted: 0,
      binary: true,
      displayPath: "assets/logo.png",
    });
    assert.equal(files[6].status, "T");
  });

  test("parseCommitFiles handles NUL (-z) outputs and R100 old -> new format", () => {
    const numstatZ =
      "10\t4\tsrc/main.go\0" +
      "3\t1\t\0old/util.rs\0new/util.rs\0" +
      "-\t-\tdocs/diagram.png\0";
    const nameStatusZ =
      "M\0src/main.go\0" +
      "R100\0old/util.rs\0new/util.rs\0" +
      "A\0docs/diagram.png\0";

    const files = parseCommitFiles(numstatZ, nameStatusZ);
    assert.equal(files.length, 3);
    assert.deepEqual(files[1], {
      path: "new/util.rs",
      oldPath: "old/util.rs",
      status: "R",
      added: 3,
      deleted: 1,
      binary: false,
      displayPath: "old/util.rs -> new/util.rs",
    });
    assert.equal(files[2].binary, true);
    assert.equal(files[2].status, "A");

    const arrowFormat = parseCommitFiles("2\t2\ta.txt => b.txt", "R100 a.txt -> b.txt");
    assert.equal(arrowFormat.length, 1);
    assert.equal(arrowFormat[0].status, "R");
    assert.equal(arrowFormat[0].oldPath, "a.txt");
    assert.equal(arrowFormat[0].path, "b.txt");
    assert.equal(arrowFormat[0].displayPath, "a.txt -> b.txt");
  });

  test("getFileExt and expandCodeTabs handle special filenames and custom tab sizes", () => {
    assert.equal(getFileExt("services/api/Dockerfile"), "dockerfile");
    assert.equal(getFileExt("GNUmakefile"), "makefile");
    assert.equal(getFileExt(".gitignore"), "gitignore");
    assert.equal(getFileExt(".env.production"), "env");
    assert.equal(getFileExt("C:\\repo\\src\\App.TSX"), "tsx");
    assert.equal(getFileExt("README"), "");

    assert.equal(expandCodeTabs("\tconst x = 1;"), "    const x = 1;");
    assert.equal(expandCodeTabs("\t\tx", 2), "    x");
    assert.equal(expandCodeTabs(""), "");
  });

  test("tokenizeDiffLine supports JS/TS/Java/Spring/Python/Rust/Go/JSON/YAML/HTML/CSS/Shell/SQL/properties and caps at 500 chars", () => {
    const jsTokens = tokenizeDiffLine('const res = fetchData(`hi ${user}`, 42); // ok', "ts");
    assert.equal(jsTokens.map(([, v]) => v).join(""), 'const res = fetchData(`hi ${user}`, 42); // ok');
    assert.ok(jsTokens.some(([k, v]) => k === "keyword" && v === "const"));
    assert.ok(jsTokens.some(([k, v]) => k === "function" && v === "fetchData"));
    assert.ok(jsTokens.some(([k, v]) => k === "string.escape" && v === "${user}"));
    assert.ok(jsTokens.some(([k, v]) => k === "number" && v === "42"));
    assert.ok(jsTokens.some(([k, v]) => k === "comment" && v === "// ok"));

    const javaTokens = tokenizeDiffLine("@RestController public class Api { Optional<UserDto> u = list.stream().map(UserDto::of); }", "java");
    assert.ok(javaTokens.some(([k, v]) => k === "annotation" && v === "@RestController"));
    assert.ok(javaTokens.some(([k, v]) => k === "type" && v === "UserDto"));
    assert.ok(javaTokens.some(([k, v]) => k === "operator" && v === "::"));

    const pyTokens = tokenizeDiffLine('@app.get("/v1") def run(self): return f"{self.id}" if True else None # note', "py");
    assert.ok(pyTokens.some(([k, v]) => k === "annotation" && v === "@app.get"));
    assert.ok(pyTokens.some(([k, v]) => k === "keyword" && v === "def"));
    assert.ok(pyTokens.some(([k, v]) => k === "string.escape" && v === "{self.id}"));
    assert.ok(pyTokens.some(([k, v]) => k === "boolean" && v === "True"));
    assert.ok(pyTokens.some(([k, v]) => k === "constant" && v === "None"));
    assert.ok(pyTokens.some(([k, v]) => k === "comment" && v === "# note"));

    const rustTokens = tokenizeDiffLine("fn parse<'a>(s: &'a str) -> char { 'x' }", "rs");
    assert.ok(!rustTokens.some(([k, v]) => k === "string" && v.includes("str")));
    assert.ok(rustTokens.some(([k, v]) => k === "string" && v === "'x'"));

    const goTokens = tokenizeDiffLine('func send(ch chan<- string) { msg := <-ch; _ = nil }', "go");
    assert.ok(goTokens.some(([k, v]) => k === "keyword" && v === "func"));
    assert.ok(goTokens.some(([k, v]) => k === "operator" && v === ":="));
    assert.ok(goTokens.some(([k, v]) => k === "constant" && v === "nil"));

    const jsonTokens = tokenizeDiffLine('  "port": 8080,', "json");
    assert.ok(jsonTokens.some(([k, v]) => k === "function" && v === '"port"'));
    assert.ok(jsonTokens.some(([k, v]) => k === "number" && v === "8080"));

    const yamlTokens = tokenizeDiffLine("  service-name: auth # primary", "yaml");
    assert.ok(yamlTokens.some(([k, v]) => k === "function" && v === "service-name"));
    assert.ok(yamlTokens.some(([k, v]) => k === "comment" && v === "# primary"));

    const htmlTokens = tokenizeDiffLine('<div class="card"><!-- header --></div>', "html");
    assert.ok(htmlTokens.some(([k, v]) => k === "keyword" && v === "div"));
    assert.ok(htmlTokens.some(([k, v]) => k === "comment" && v === "<!-- header -->"));

    const cssTokens = tokenizeDiffLine("@media screen { color: #ff00aa; width: 12px; }", "css");
    assert.ok(cssTokens.some(([k, v]) => k === "keyword" && v === "@media"));
    assert.ok(cssTokens.some(([k, v]) => k === "number" && v === "#ff00aa"));
    assert.ok(cssTokens.some(([k, v]) => k === "number" && v === "12px"));

    const shTokens = tokenizeDiffLine('if [ -n "$HOME" ]; then export FOO=${BAR}; fi # done', "sh");
    assert.ok(shTokens.some(([k, v]) => k === "keyword" && v === "export"));
    assert.ok(shTokens.some(([k, v]) => k === "variable" && v === "${BAR}"));
    assert.ok(shTokens.some(([k, v]) => k === "comment" && v === "# done"));

    const sqlTokens = tokenizeDiffLine("select id, name FROM users WHERE active = true -- active", "sql");
    assert.ok(sqlTokens.some(([k, v]) => k === "keyword" && v === "select"));
    assert.ok(sqlTokens.some(([k, v]) => k === "keyword" && v === "FROM"));
    assert.ok(sqlTokens.some(([k, v]) => k === "comment" && v === "-- active"));

    const propTokens = tokenizeDiffLine("spring.datasource.url=jdbc:postgresql://localhost/db", "properties");
    assert.ok(propTokens.some(([k, v]) => k === "function" && v === "spring.datasource.url"));
    assert.ok(propTokens.some(([k, v]) => k === "operator" && v === "="));

    assert.ok(Array.isArray(tokenizeDiffLine("x".repeat(MAX_DIFF_SYNTAX_LINE_CHARS), "js")));
    assert.equal(tokenizeDiffLine("x".repeat(MAX_DIFF_SYNTAX_LINE_CHARS + 1), "js"), null);
    assert.equal(tokenizeDiffLine("plain text", "txt"), null);
    assert.equal(tokenizeDiffLine("", "js"), null);
  });

  test("getDiffSyntaxPalette and diffSyntaxTokenColor enforce contrast safety across light and dark themes", () => {
    const darkTheme = { is_dark: true, ansi1: "#e06c75", ansi4: "#050505", foreground: "#abb2bf" };
    const darkPalette = getDiffSyntaxPalette(darkTheme);
    assert.equal(darkPalette.isDark, true);
    assert.notEqual(darkPalette.function, "#050505", "too-dark ansi4 should fall back on dark themes");
    assert.equal(diffSyntaxTokenColor("annotation", darkTheme), darkPalette.annotation);

    const lightTheme = { is_dark: false, ansi3: "#ffff00", foreground: "#ffffff" };
    const lightPalette = getDiffSyntaxPalette(lightTheme);
    assert.equal(lightPalette.isDark, false);
    assert.equal(lightPalette.type, "#9a6700", "too-bright ansi3 should fall back on light themes");
    assert.equal(lightPalette.plain, "#24292f");
  });

  test("buildSideBySideRows aligns unequal del/add blocks, context, root new files, deleted files, and binary markers", () => {
    const patch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,4 +10,5 @@ function run() {",
      " const keep = true;",
      "-const oldA = 1;",
      "-const oldB = 2;",
      "+const newA = 10;",
      "+const newB = 20;",
      "+const newC = 30;",
      " return keep;",
      "\\ No newline at end of file",
    ].join("\n");

    const res = buildSideBySideRows(patch, "src/app.ts");
    assert.equal(res.isBinary, false);
    assert.equal(res.truncated, false);
    assert.equal(res.rows.length, 6);
    assert.deepEqual(res.rows[0], {
      kind: "hunk",
      header: "@@ -10,4 +10,5 @@ function run() {",
      oldStart: 10,
      oldCount: 4,
      newStart: 10,
      newCount: 5,
      hunkIndex: 0,
    });
    assert.equal(res.rows[1].left.kind, "ctx");
    assert.equal(res.rows[1].left.lineNo, 10);
    assert.equal(res.rows[1].right.lineNo, 10);

    // Paired dels and adds
    assert.equal(res.rows[2].left.kind, "del");
    assert.equal(res.rows[2].left.lineNo, 11);
    assert.equal(res.rows[2].right.kind, "add");
    assert.equal(res.rows[2].right.lineNo, 11);

    assert.equal(res.rows[3].left.kind, "del");
    assert.equal(res.rows[3].left.lineNo, 12);
    assert.equal(res.rows[3].right.kind, "add");
    assert.equal(res.rows[3].right.lineNo, 12);

    // Extra add pairs with empty left
    assert.deepEqual(res.rows[4].left, { lineNo: null, text: "", kind: "empty", tokens: null });
    assert.equal(res.rows[4].right.kind, "add");
    assert.equal(res.rows[4].right.lineNo, 13);

    // Trailing context keeps aligned line numbers
    assert.equal(res.rows[5].left.kind, "ctx");
    assert.equal(res.rows[5].left.lineNo, 13);
    assert.equal(res.rows[5].right.lineNo, 14);

    // Root / new file
    const addedFile = buildSideBySideRows("--- /dev/null\n+++ b/a.js\n@@ -0,0 +1,2 @@\n+line1\n+line2\n", "a.js");
    assert.equal(addedFile.rows.length, 3);
    assert.equal(addedFile.rows[1].left.kind, "empty");
    assert.equal(addedFile.rows[1].right.kind, "add");
    assert.equal(addedFile.rows[2].right.lineNo, 2);

    // Deleted file
    const deletedFile = buildSideBySideRows("--- a/a.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-old1\n-old2\n", "a.js");
    assert.equal(deletedFile.rows.length, 3);
    assert.equal(deletedFile.rows[1].left.kind, "del");
    assert.equal(deletedFile.rows[1].right.kind, "empty");
    assert.equal(deletedFile.rows[2].left.lineNo, 2);

    // Binary patch
    const binRes = buildSideBySideRows("Binary files a/logo.png and b/logo.png differ\n", "logo.png");
    assert.equal(binRes.isBinary, true);
    assert.equal(binRes.rows.length, 0);

    // Truncation
    const bigLines = ["@@ -1,10 +1,10 @@"];
    for (let i = 0; i < 10; i++) bigLines.push(`+line ${i}`);
    const trunc = buildSideBySideRows(bigLines.join("\n"), "big.js", { maxLines: 5 });
    assert.equal(trunc.truncated, true);
    assert.equal(trunc.totalLines, 11);
    assert.equal(trunc.rows.length, 5);
  });

  test("buildUnifiedRows and computeDiffColumnWidths compute unified rows and column widths", () => {
    const patch = "@@ -1,2 +1,3 @@\n ctx\n-old line here\n+much longer added line here\n+extra\n";
    const unified = buildUnifiedRows(patch, "file.js");
    assert.equal(unified.isBinary, false);
    assert.equal(unified.rows.length, 5);
    assert.equal(unified.rows[1].kind, "ctx");
    assert.equal(unified.rows[1].oldLineNo, 1);
    assert.equal(unified.rows[1].newLineNo, 1);
    assert.equal(unified.rows[2].kind, "del");
    assert.equal(unified.rows[2].oldLineNo, 2);
    assert.equal(unified.rows[2].newLineNo, null);
    assert.equal(unified.rows[3].kind, "add");
    assert.equal(unified.rows[3].oldLineNo, null);
    assert.equal(unified.rows[3].newLineNo, 2);
    assert.equal(unified.maxChars, "much longer added line here".length);

    const sbs = buildSideBySideRows(patch, "file.js");
    const widths = computeDiffColumnWidths(sbs.rows, 8);
    assert.ok(widths.leftWidth >= 260);
    assert.ok(widths.rightWidth >= Math.ceil("much longer added line here".length * 8) + 68);
    assert.ok(widths.unifiedWidth >= 300);

    const emptyWidths = computeDiffColumnWidths([]);
    assert.deepEqual(emptyWidths, { leftWidth: 260, rightWidth: 260, unifiedWidth: 300 });
  });

  test("resolveGitFileIcon, computeViewerLoadedKey, and formatGitTabTitle produce expected paths, keys, and titles", () => {
    const theme = { is_dark: true };
    const springIcon = resolveGitFileIcon("config/application-prod.yml", theme);
    assert.equal(springIcon.kind, "spring");
    assert.equal(springIcon.path, "mods/git-history/icons/file-types/spring.svg");
    assert.ok(springIcon.color.startsWith("#"));

    const tsIcon = resolveGitFileIcon("src/auth.ts", theme);
    assert.equal(tsIcon.path, "mods/git-history/icons/file-types/typescript.svg");

    const fallbackIcon = resolveGitFileIcon("archive.unknownext", theme);
    assert.equal(fallbackIcon.path, "mods/git-history/icons/file-types/file.svg");

    assert.equal(computeViewerLoadedKey(null), "empty");
    assert.equal(computeViewerLoadedKey({ commitHash: "abc1234" }), "empty");
    const key1 = computeViewerLoadedKey({
      requestSeq: 3,
      repoRoot: "/ws/api",
      commitHash: "abc1234",
      openFileKey: "src/auth.ts",
      expanded: false,
      diffMode: "side-by-side",
    });
    const key2 = computeViewerLoadedKey({
      requestSeq: 3,
      repoRoot: "/ws/api",
      commitHash: "abc1234",
      openFileKey: "src/auth.ts",
      expanded: false,
      diffMode: "unified",
    });
    const key3 = computeViewerLoadedKey({
      requestSeq: 3,
      repoRoot: "/ws/api",
      commitHash: "abc1234",
      openFileKey: "src/auth.ts",
      expanded: true,
    });
    assert.equal(key1, key2);
    assert.notEqual(key1, key3);

    assert.equal(formatGitTabTitle({ shortHash: "abc1234" }, { path: "src/auth.ts" }), "abc1234 · auth.ts");
    assert.equal(formatGitTabTitle("abcdef123456", "README.md"), "abcdef1 · README.md");
    assert.equal(formatGitTabTitle(null, "src/index.js"), "Git · index.js");
    assert.equal(formatGitTabTitle("abc1234", null), "Git · abc1234");
    assert.equal(formatGitTabTitle(null, null), "Git History");
  });

  test("paginateDiffRows windows large diffs to bounded frame sizes without dropping rows", () => {
    assert.equal(DEFAULT_SBS_PAGE_ROWS, 180);
    assert.equal(MAX_RENDER_TOKENS_PER_LINE, 28);

    const empty = paginateDiffRows([], 2, 180);
    assert.deepEqual(empty, {
      rows: [],
      pageIndex: 0,
      totalPages: 1,
      totalRows: 0,
      startRow: 0,
      endRow: 0,
      hasPrev: false,
      hasNext: false,
    });

    const rows = Array.from({ length: 1500 }, (_, i) => ({ kind: "pair", id: i }));
    const p0 = paginateDiffRows(rows, 0, DEFAULT_SBS_PAGE_ROWS);
    assert.equal(p0.pageIndex, 0);
    assert.equal(p0.totalPages, 9);
    assert.equal(p0.totalRows, 1500);
    assert.equal(p0.startRow, 1);
    assert.equal(p0.endRow, 180);
    assert.equal(p0.rows.length, 180);
    assert.equal(p0.hasPrev, false);
    assert.equal(p0.hasNext, true);

    // Out-of-bounds pageIndex clamps safely to last page
    const last = paginateDiffRows(rows, 99, DEFAULT_SBS_PAGE_ROWS);
    assert.equal(last.pageIndex, 8);
    assert.equal(last.startRow, 1441);
    assert.equal(last.endRow, 1500);
    assert.equal(last.rows.length, 60);
    assert.equal(last.hasPrev, true);
    assert.equal(last.hasNext, false);

    // Negative index clamps to page 0
    assert.equal(paginateDiffRows(rows, -3, DEFAULT_SBS_PAGE_ROWS).pageIndex, 0);
  });

  test("capRenderTokens bounds per-line token count while preserving full text verbatim", () => {
    const dense = Array.from({ length: 50 }, (_, i) => ["identifier", `tok${i}_`]);
    const capped = capRenderTokens(dense, MAX_RENDER_TOKENS_PER_LINE);
    assert.equal(capped.length, MAX_RENDER_TOKENS_PER_LINE);
    assert.equal(capped[capped.length - 1][0], "plain");
    assert.equal(
      capped.map(([, txt]) => txt).join(""),
      dense.map(([, txt]) => txt).join(""),
    );

    const small = [["keyword", "const"], ["plain", " x = 1"]];
    assert.deepEqual(capRenderTokens(small, MAX_RENDER_TOKENS_PER_LINE), small);
    assert.equal(capRenderTokens(null), null);
  });
});
