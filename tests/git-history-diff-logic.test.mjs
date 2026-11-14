import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_DIFF_SYNTAX_LINE_CHARS,
  MAX_VIEWER_DIFF_LINES,
  DEFAULT_SBS_PAGE_ROWS,
  MAX_RENDER_TOKENS_PER_LINE,
  DIFF_ROW_HEIGHT,
  DIFF_HUNK_HEIGHT,
  DIFF_WAVE_GUTTER_WIDTH,
  DIFF_WAVE_MAX_CENTER_OFFSET_ROWS,
  parseCommitFiles,
  getFileExt,
  expandCodeTabs,
  tokenizeDiffLine,
  getDiffSyntaxPalette,
  diffSyntaxTokenColor,
  buildSideBySideRows,
  buildUnifiedRows,
  computeDiffColumnWidths,
  computeHorizontalWheelDelta,
  computeHorizontalScrollbarMetrics,
  computeScrollXFromTrackClick,
  resolveGitFileIcon,
  computeViewerLoadedKey,
  formatGitTabTitle,
  paginateDiffRows,
  capRenderTokens,
  buildWaveDiffLayout,
  toNbspString,
  prepareRenderLineData,
  tokenizeDeferredRow,
  tokenizeSideBySidePage,
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
    assert.ok(widths.rightWidth >= Math.ceil("much longer added line here".length * 8) + 92);
    assert.ok(widths.unifiedWidth >= 300);

    // Expands literal tabs and includes long hunk headers on the Left side
    const tabbedRows = [
      { kind: "hunk", header: "@@ -1,2 +1,2 @@ function veryLongHunkSignatureForHorizontalScrollCheck()" },
      { kind: "pair", left: { kind: "del", text: "\t\tconst a = 1;" }, right: { kind: "add", text: "    const b = 2;" } },
    ];
    const tabbedWidths = computeDiffColumnWidths(tabbedRows, 8);
    assert.ok(
      tabbedWidths.leftWidth >= Math.ceil(tabbedRows[0].header.length * 8) + 92,
      "leftWidth should cover hunk header width"
    );
    const shortHeaderTabbedRows = [
      { kind: "pair", left: { kind: "del", text: "\t\t\t\t\t\tret" }, right: { kind: "add", text: "ret" } },
    ];
    const tabExpanded = computeDiffColumnWidths(shortHeaderTabbedRows, 8);
    assert.equal(tabExpanded.leftWidth, Math.ceil((6 * 4 + 3) * 8) + 92);

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

  test("buildWaveDiffLayout produces height-synced compact columns, gutterItems, and wave connectors across add/del/mod chunks", () => {
    assert.equal(DIFF_ROW_HEIGHT, 24);
    assert.equal(DIFF_HUNK_HEIGHT, 28);
    assert.equal(DIFF_WAVE_GUTTER_WIDTH, 40);
    assert.equal(DIFF_WAVE_MAX_CENTER_OFFSET_ROWS, 2);

    const empty = buildWaveDiffLayout([]);
    assert.deepEqual(empty, {
      leftItems: [],
      rightItems: [],
      gutterItems: [],
      hunkBands: [],
      waves: [],
      totalHeight: 0,
    });

    const patch = [
      "@@ -1,10 +1,11 @@",
      " ctx1",
      "-del1",
      "-del2",
      "+add1",
      "+add2",
      "+add3",
      "+add4",
      "+add5",
      " ctx2",
      "+pureAdd1",
      "+pureAdd2",
      " ctx3",
      "-pureDel1",
      " ctx4",
    ].join("\n");

    const sbs = buildSideBySideRows(patch, "demo.js");
    const wave = buildWaveDiffLayout(sbs.rows);

    const leftSum = wave.leftItems.reduce((acc, it) => acc + it.height, 0);
    const rightSum = wave.rightItems.reduce((acc, it) => acc + it.height, 0);
    const gutterSum = wave.gutterItems.reduce((acc, it) => acc + it.height, 0);
    assert.equal(leftSum, wave.totalHeight);
    assert.equal(rightSum, wave.totalHeight);
    assert.equal(gutterSum, wave.totalHeight);
    assert.equal(wave.hunkBands.length, 1);
    assert.deepEqual(wave.hunkBands[0], { y: 0, height: 28 });

    // No empty cell line boxes should exist — spacers hold zero line numbers
    assert.ok(wave.leftItems.filter((it) => it.type === "line").every((it) => it.cell.kind !== "empty"));
    assert.ok(wave.rightItems.filter((it) => it.type === "line").every((it) => it.cell.kind !== "empty"));

    // 3 change blocks: mod (2 -> 5), pure add (0 -> 2), pure del (1 -> 0)
    assert.equal(wave.waves.length, 3);

    // Block 1 (after hunk 28 + ctx1 24 = 52): blockH = 5*24 = 120; Left centered offset = 36
    assert.deepEqual(wave.waves[0], {
      kind: "mod",
      leftTop: 52 + 36,
      leftBot: 52 + 36 + 48,
      rightTop: 52,
      rightBot: 52 + 120,
    });
    assert.deepEqual(wave.gutterItems[2], {
      type: "wave",
      height: 120,
      kind: "mod",
      leftTop: 36,
      leftBot: 36 + 48,
      rightTop: 0,
      rightBot: 120,
    });

    // Block 2 (after 52 + 120 + ctx2 24 = 196): pure addition 0 -> 2 (blockH = 48, pinched apex at +24)
    assert.deepEqual(wave.waves[1], {
      kind: "add",
      leftTop: 196 + 24,
      leftBot: 196 + 24,
      rightTop: 196,
      rightBot: 196 + 48,
    });
    assert.deepEqual(wave.gutterItems[4], {
      type: "wave",
      height: 48,
      kind: "add",
      leftTop: 24,
      leftBot: 24,
      rightTop: 0,
      rightBot: 48,
    });
    const addSpacer = wave.leftItems.find((it) => it.type === "spacer" && it.markerKind === "add");
    assert.equal(addSpacer.markerOffsetY, 24);

    // Block 3 (after 196 + 48 + ctx3 24 = 268): pure deletion 1 -> 0 (blockH = 24, pinched apex at +12)
    assert.deepEqual(wave.waves[2], {
      kind: "del",
      leftTop: 268,
      leftBot: 268 + 24,
      rightTop: 268 + 12,
      rightBot: 268 + 12,
    });
    assert.deepEqual(wave.gutterItems[6], {
      type: "wave",
      height: 24,
      kind: "del",
      leftTop: 0,
      leftBot: 24,
      rightTop: 12,
      rightBot: 12,
    });
  });

  test("buildWaveDiffLayout caps centering offset on giant single-sided insertions so wave starts stay near the top", () => {
    const adds = Array.from({ length: 120 }, (_, i) => `+addedLine${i}`);
    const giantPatch = ["@@ -1,1 +1,121 @@", " anchor", ...adds].join("\n");
    const sbs = buildSideBySideRows(giantPatch, "big.js");
    const wave = buildWaveDiffLayout(sbs.rows);

    const leftSum = wave.leftItems.reduce((acc, it) => acc + it.height, 0);
    const rightSum = wave.rightItems.reduce((acc, it) => acc + it.height, 0);
    const gutterSum = wave.gutterItems.reduce((acc, it) => acc + it.height, 0);
    assert.equal(leftSum, wave.totalHeight);
    assert.equal(rightSum, wave.totalHeight);
    assert.equal(gutterSum, wave.totalHeight);
    assert.equal(wave.waves.length, 1);

    // Chunk starts at y = 28 (hunk) + 24 (anchor) = 52; max offset is 2 * 24 = 48
    assert.equal(wave.waves[0].kind, "add");
    assert.equal(wave.waves[0].leftTop, 52 + 48);
    assert.equal(wave.waves[0].leftBot, 52 + 48);
    assert.equal(wave.waves[0].rightTop, 52);
    assert.equal(wave.waves[0].rightBot, 52 + 120 * 24);
    assert.deepEqual(wave.gutterItems[2], {
      type: "wave",
      height: 120 * 24,
      kind: "add",
      leftTop: 48,
      leftBot: 48,
      rightTop: 0,
      rightBot: 120 * 24,
    });
  });

  test("buildWaveDiffLayout produces zero-curvature local spans for equal-count 1:1 modifications", () => {
    const patch = ["@@ -1,3 +1,3 @@", " ctx1", "-oldLine", "+newLine", " ctx2"].join("\n");
    const sbs = buildSideBySideRows(patch, "eq.js");
    const wave = buildWaveDiffLayout(sbs.rows);
    const waveSegment = wave.gutterItems.find((it) => it.type === "wave");
    assert.deepEqual(waveSegment, {
      type: "wave",
      height: 24,
      kind: "mod",
      leftTop: 0,
      leftBot: 24,
      rightTop: 0,
      rightBot: 24,
    });
  });

  test("computeHorizontalWheelDelta distinguishes plain vertical wheel from Shift+Wheel and horizontal trackpad swipes", () => {
    // Plain vertical mouse wheel never triggers horizontal scroll
    assert.deepEqual(
      computeHorizontalWheelDelta({ delta: { x: 0, y: -48 }, modifiers: { shift: false } }),
      { handled: false, deltaX: 0 }
    );
    assert.deepEqual(
      computeHorizontalWheelDelta({ delta: { x: 4, y: 48 }, modifiers: { shift: false } }),
      { handled: false, deltaX: 0 }
    );

    // Shift + Wheel (with delta.y on Linux/Wayland or delta.x when swapped by OS)
    assert.deepEqual(
      computeHorizontalWheelDelta({ delta: { x: 0, y: -48 }, modifiers: { shift: true } }),
      { handled: true, deltaX: 48 }
    );
    assert.deepEqual(
      computeHorizontalWheelDelta({ delta: { x: 0, y: 48 }, modifiers: { shift: true } }),
      { handled: true, deltaX: -48 }
    );
    assert.deepEqual(
      computeHorizontalWheelDelta({ delta: { x: -36, y: 0 }, modifiers: { shift: true } }),
      { handled: true, deltaX: 36 }
    );
    assert.deepEqual(
      computeHorizontalWheelDelta({ delta: { x: 0, y: 0 }, modifiers: { shift: true } }),
      { handled: true, deltaX: 0 }
    );

    // Explicit horizontal touchpad swipe
    assert.deepEqual(
      computeHorizontalWheelDelta({ delta: { x: -30, y: 2 }, modifiers: { shift: false } }),
      { handled: true, deltaX: 30 }
    );
  });

  test("computeHorizontalScrollbarMetrics and computeScrollXFromTrackClick clamp and map thumb geometry accurately", () => {
    assert.equal(computeHorizontalScrollbarMetrics(400, 450, 50, 442).visible, false);
    assert.equal(computeHorizontalScrollbarMetrics(800, 0, 0, 0).visible, false);

    const m = computeHorizontalScrollbarMetrics(1000, 500, 250, 500);
    assert.equal(m.visible, true);
    assert.equal(m.maxScroll, 500);
    assert.equal(m.scrollX, 250);
    assert.equal(m.thumbW, 250);
    assert.equal(m.travelW, 250);
    assert.equal(m.thumbX, 125);

    // Clamps overflown scrollX
    const clamped = computeHorizontalScrollbarMetrics(1000, 500, 9999, 500);
    assert.equal(clamped.scrollX, 500);
    assert.equal(clamped.thumbX, 250);

    // Clicking start, middle, and far end of track
    assert.equal(computeScrollXFromTrackClick(0, 1000, 500, 500), 0);
    assert.equal(computeScrollXFromTrackClick(250, 1000, 500, 500), 250);
    assert.equal(computeScrollXFromTrackClick(500, 1000, 500, 500), 500);
  });

  test("toNbspString and getDiffSyntaxPalette cache cleanly across identical themes and invalidate on theme changes", () => {
    assert.equal(toNbspString("const  x = 1;"), "const\u00a0\u00a0x\u00a0=\u00a01;");
    assert.equal(toNbspString("plainTextWithoutSpaces"), "plainTextWithoutSpaces");
    assert.equal(toNbspString(""), "");

    const themeA = {
      foreground: "#cdd6f4",
      dim: "#6c7086",
      muted: "#a6adc8",
      accent: "#89b4fa",
      done: "#a6e3a1",
      ansi1: "#f38ba8",
      ansi2: "#a6e3a1",
      ansi3: "#f9e2af",
      ansi4: "#89b4fa",
      ansi5: "#cba6f7",
      ansi6: "#94e2d5",
    };
    const pal1 = getDiffSyntaxPalette(themeA);
    const pal2 = getDiffSyntaxPalette({ ...themeA });
    assert.equal(pal1._isSyntaxPalette, true);
    assert.equal(pal1, pal2);
    assert.equal(diffSyntaxTokenColor("keyword", pal1), "#cba6f7");

    const pal3 = getDiffSyntaxPalette({ ...themeA, ansi5: "#ff00aa" });
    assert.notEqual(pal3, pal1);
    assert.equal(diffSyntaxTokenColor("keyword", pal3), "#ff00aa");
  });

  test("prepareRenderLineData converts tokens into NBSP spans and merges adjacent identical colors", () => {
    const pal = getDiffSyntaxPalette({
      foreground: "#eee",
      dim: "#666",
      muted: "#999",
      accent: "#48f",
      done: "#2c6",
      ansi1: "#f44",
      ansi2: "#2c6",
      ansi3: "#ec3",
      ansi4: "#48f",
      ansi5: "#c6f",
      ansi6: "#3cc",
    });

    const singlePlain = prepareRenderLineData(null, "\ta + b", pal, "#eee");
    assert.deepEqual(singlePlain, {
      kind: "single",
      color: "#eee",
      text: "\u00a0\u00a0\u00a0\u00a0a\u00a0+\u00a0b",
    });

    const mergedAdjacent = prepareRenderLineData(
      [
        ["keyword", "const"],
        ["plain", " "],
        ["plain", "value"],
        ["operator", " = "],
        ["number", "42"],
      ],
      "const value = 42",
      pal,
      "#eee"
    );
    assert.equal(mergedAdjacent.kind, "multi");
    assert.deepEqual(mergedAdjacent.spans, [
      [pal.keyword, "const"],
      [pal.plain, "\u00a0value"],
      [pal.operator, "\u00a0=\u00a0"],
      [pal.number, "42"],
    ]);

    const collapsedSameColor = prepareRenderLineData(
      [
        ["plain", "foo"],
        ["variable", " bar"],
      ],
      "foo bar",
      { ...pal, variable: pal.plain },
      "#eee"
    );
    assert.deepEqual(collapsedSameColor, {
      kind: "single",
      color: "#eee",
      text: "foo\u00a0bar",
    });
  });

  test("deferTokens skips eager tokenization until tokenizeDeferredRow or tokenizeSideBySidePage runs", () => {
    const patch = [
      "@@ -1,2 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
    ].join("\n");

    const deferredSbs = buildSideBySideRows(patch, "demo.js", { deferTokens: true });
    assert.equal(deferredSbs.rows[0].kind, "hunk");
    assert.equal(deferredSbs.rows[1].left.tokens, null);
    assert.equal(deferredSbs.rows[1].right.tokens, null);
    assert.equal(deferredSbs.rows[2].left.tokens, null);
    assert.equal(deferredSbs.rows[2].right.tokens, null);
    assert.equal(deferredSbs.rows[3].left.kind, "empty");
    assert.equal(deferredSbs.rows[3].left.tokens, null);
    assert.equal(deferredSbs.rows[3].right.tokens, null);

    // Tokenize only row index 2..3 (page slice simulation)
    tokenizeSideBySidePage(deferredSbs.rows.slice(2, 3), "js");
    assert.equal(deferredSbs.rows[1].left.tokens, null);
    assert.ok(Array.isArray(deferredSbs.rows[2].left.tokens) && deferredSbs.rows[2].left.tokens.length > 0);
    assert.ok(Array.isArray(deferredSbs.rows[2].right.tokens) && deferredSbs.rows[2].right.tokens.length > 0);
    assert.equal(deferredSbs.rows[3].right.tokens, null);

    const deferredUni = buildUnifiedRows(patch, "demo.js", { deferTokens: true });
    const uniCodeRow = deferredUni.rows.find((r) => r.kind === "add");
    assert.equal(uniCodeRow.tokens, null);
    tokenizeDeferredRow(uniCodeRow, "js");
    assert.ok(Array.isArray(uniCodeRow.tokens) && uniCodeRow.tokens.length > 0);
    // Calling again is a fast idempotent no-op preserving the exact array reference
    const firstTokensRef = uniCodeRow.tokens;
    tokenizeDeferredRow(uniCodeRow, "js");
    assert.equal(uniCodeRow.tokens, firstTokensRef);
  });

  test("computeDiffColumnWidths counts untabbed and tabbed lines identically via expandedLineCols", () => {
    const widths = computeDiffColumnWidths(
      [
        { kind: "pair", left: { text: "short" }, right: { text: "\t\tindented" } },
      ],
      7.6
    );
    // left: 5 cols * 7.6 = 38 + 92 = 130 -> min 260
    assert.equal(widths.leftWidth, 260);
    // right: "\t\tindented" expands to 8 + 8 = 16 cols -> ceil(16 * 7.6) + 92 = 122 + 92 = 214 -> min 260
    assert.equal(widths.rightWidth, 260);

    const wide = computeDiffColumnWidths(
      [
        { kind: "pair", left: { text: "x".repeat(40) }, right: { text: "\t" + "y".repeat(38) } },
      ],
      7.6
    );
    assert.equal(wide.leftWidth, Math.ceil(40 * 7.6) + 92);
    assert.equal(wide.rightWidth, Math.ceil(42 * 7.6) + 92);
  });
});
