import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getFileExt,
  tokenizeDiffLine,
  diffRows,
  getDiffSyntaxPalette,
  diffSyntaxTokenColor,
  normCmpStr,
  resolveDiffFileIconSpec,
  resolveDiffFileIcon,
  expandCodeTabs,
  computeDiffContentWidth,
  MAX_DIFF_SYNTAX_LINE_CHARS,
  isSameOrChildPath,
  isIgnoredWatchPath,
  hasRelevantWatchChange,
  parsePorcelainHeader,
  getParentDir,
  formatReviewTabTitle,
  getSessionNotesKey,
  resolveSessionAgentTabId,
  pickNextUnreviewedFile,
  sortServicesDirtyFirst,
  normalizeCommentSide,
  buildCommentKey,
  buildReviewedFileKey,
  computeFileReviewFingerprint,
  parseReviewedFileRecord,
  reconcileReviewedFiles,
  filterSessionWorkingEntries,
  partitionSessionWorkingEntries,
  partitionSessionUnifiedEntries,
  evaluateRepoSessionActivity,
  normalizeGitStatusMark,
  statFileEntry,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  resolveSessionStartTime,
  buildFreshSessionBaseline,
  createResetSessionBaseline,
  countBaselineDirtyFiles,
  compactFlowsMap,
  extractResumeKeyFromTranscript,
  filterUnbaselinedRepoEntries,
  isHomeDirectoryRoot,
  resolveWorkspaceRoot,
  READ_GIT_FLAGS,
  mergeBusCandidateServices,
  countUntrackedFileLines,
  parseNameStatusZ,
  parseNumstatZ,
  resolveRepoBaseRefWithExec,
  collectServiceSessionSnapshot,
  resolveReviewMarkdownSourceSpec,
  computeViewerMarkdownFileId,
  computeReviewMarkdownLoadToken,
  buildReviewMarkdownCacheKey,
  validateMarkdownTextContent,
  formatGitShowMarkdownError,
  buildVariableRowLayout,
  computeVariableWindowSlice,
  computeDiffScrollOffsetForRow,
  computeDiffScrollbarMetrics,
  resolveDiffWheelDeltaPx,
  resolveDiffScrollbarDragPx,
  DEFAULT_CONTEXT_EXPAND_STEP,
  splitSourceFileLines,
  annotateDiffGaps,
  syncBottomGapWithTotalLines,
  expandDiffGapInRows,
  computeAnchorPreservedScrollPx,
  formatReviewAgentMessage,
  parseHcJsonOutput,
  formatHcErrorMessage,
  resolveAgentSubmitKey,
  screenLooksBlockedOrPrompting,
  detectUnsubmittedReviewInScreen,
  decideSendSubmitAction,
  computeReviewCommentWrapCols,
  extractHcReadText,
  selectPathsToStageForCommit,
} from "../mods/changes-review/review-logic.js";
import {
  statFileEntry as filesSearchStatFileEntry,
  normalizeGitStatusMark as filesSearchNormalizeStatus,
  resolveWorkspaceRoot as filesSearchResolveWorkspaceRoot,
} from "../mods/files-search/session-baseline.js";

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

    assert.equal(rustTokens.map(([, v]) => v).join(""), "fn parse<'a>(input: &'a str) -> char { 'x' }");
    assert.ok(Array.isArray(tokenizeDiffLine(`const longIdent = "${"a".repeat(1000)}";`, "js")), "1000-char source lines should still tokenize");
    assert.equal(
      tokenizeDiffLine("x".repeat(MAX_DIFF_SYNTAX_LINE_CHARS + 1), "js"),
      null,
      "lines above MAX_DIFF_SYNTAX_LINE_CHARS should bypass tokenization cleanly",
    );
  });

  test("tokenizeDiffLine separates Spring annotations, operators, self/this, Python f-strings, and properties", () => {
    const springTokens = tokenizeDiffLine('@RestController public sealed class Api permits V1 {}', "java");
    assert.ok(springTokens.some(([k, v]) => k === "annotation" && v === "@RestController"));
    assert.ok(!springTokens.some(([k, v]) => k === "type" && v === "@RestController"), "Spring annotations must not share type token kind");
    assert.ok(springTokens.some(([k, v]) => k === "keyword" && v === "sealed"));
    assert.ok(springTokens.some(([k, v]) => k === "keyword" && v === "permits"));

    const streamTokens = tokenizeDiffLine("items.stream().map(UserDto::from).map(u -> this.format(u));", "java");
    assert.ok(streamTokens.some(([k, v]) => k === "type" && v === "UserDto"));
    assert.ok(streamTokens.some(([k, v]) => k === "operator" && v === "::"));
    assert.ok(streamTokens.some(([k, v]) => k === "function" && v === "from"));
    assert.ok(streamTokens.some(([k, v]) => k === "operator" && v === "->"));
    assert.ok(streamTokens.some(([k, v]) => k === "variable" && v === "this"));

    const pyTokens = tokenizeDiffLine('@dataclass class User: pass  # self check: f"{cls.name}"', "py");
    assert.ok(pyTokens.some(([k, v]) => k === "annotation" && v === "@dataclass"));
    assert.ok(pyTokens.some(([k, v]) => k === "keyword" && v === "pass"));
    const pyStr = tokenizeDiffLine('return f"hello {self.name}" if True else None', "py");
    assert.ok(pyStr.some(([k, v]) => k === "string.escape" && v === "{self.name}"));
    assert.ok(pyStr.some(([k, v]) => k === "boolean" && v === "True"));
    assert.ok(pyStr.some(([k, v]) => k === "constant" && v === "None"));

    const propTokens = tokenizeDiffLine("server.port=8080", "properties");
    assert.ok(propTokens.some(([k, v]) => k === "function" && v === "server.port"));
    assert.ok(propTokens.some(([k, v]) => k === "operator" && v === "="));
    assert.ok(propTokens.some(([k, v]) => k === "number" && v === "8080"));

    const darkTheme = { is_dark: true, ansi1: "#e06c75", ansi3: "#e5c07b" };
    assert.notEqual(diffSyntaxTokenColor("number", darkTheme), "#e06c75");
    assert.notEqual(diffSyntaxTokenColor("annotation", darkTheme), diffSyntaxTokenColor("type", darkTheme));
    assert.equal(getDiffSyntaxPalette({ is_dark: false, ansi3: "#ffff00" }).type, "#9a6700");
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

  test("resolveDiffFileIconSpec matches Spring, Java, Python, JS/TS, config, and generic files", () => {
    const cases = [
      ["src/main/java/OrderService.java", "java"],
      ["src/main/resources/application-dev.yml", "spring"],
      ["src/main/resources/application.properties", "spring"],
      ["pom.xml", "build"],
      ["worker/tasks.py", "python"],
      ["ui/App.js", "javascript"],
      ["ui/Panel.tsx", "react"],
      ["api/schema.sql", "database"],
      ["Dockerfile.prod", "docker"],
      [".gitignore", "git"],
      ["yarn.lock", "lock"],
      ["docs/guide.md", "markdown"],
      ["unknown.bin", "file"],
    ];
    for (const [filePath, kind] of cases) {
      const spec = resolveDiffFileIconSpec(filePath);
      assert.equal(spec.kind, kind, `${filePath} should map to ${kind}, got ${spec.kind}`);
      assert.ok(typeof spec.tone === "string" && spec.tone.length > 0);
    }
  });

  test("resolveDiffFileIcon resolves valid SVG assets in changes-review for dark and light themes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const iconDir = path.join(repoRoot, "mods/changes-review/icons/file-types");

    const sampleFiles = [
      "src/OrderService.java",
      "src/main/resources/application.yml",
      "worker/tasks.py",
      "ui/App.js",
      "package.json",
      "notes.txt",
    ];
    for (const t of [{ is_dark: true, text_muted: "#7f848e" }, { is_dark: false }]) {
      for (const filePath of sampleFiles) {
        const icon = resolveDiffFileIcon(filePath, t);
        assert.match(icon.path, /^mods\/changes-review\/icons\/file-types\/[a-z-]+\.svg$/);
        assert.ok(typeof icon.color === "string" && icon.color.startsWith("#"));
        assert.ok(fs.existsSync(path.join(repoRoot, icon.path)), `missing SVG asset: ${icon.path}`);
      }
    }

    const expectedKinds = [
      "java", "spring", "python", "javascript", "typescript", "react", "kotlin",
      "json", "yaml", "settings", "html", "css", "database", "markdown",
      "shell", "docker", "git", "build", "lock", "image", "code", "file",
    ];
    for (const kind of expectedKinds) {
      assert.ok(fs.existsSync(path.join(iconDir, `${kind}.svg`)), `missing icon file: ${kind}.svg`);
    }
  });

  test("diffRows, expandCodeTabs, and computeDiffContentWidth preserve long lines and tab spacing for horizontal scrolling", () => {
    const longExpr = `${"service.execute(" + "\"arg\",".repeat(150)}"end")`;
    assert.ok(longExpr.length > 900 && longExpr.length < 1600);
    const rows = diffRows([
      "@@ -10,2 +10,2 @@ public void processLongChain()",
      `-\t${longExpr}`,
      `+\t${longExpr} // updated`,
    ], "src/Service.java");

    assert.equal(rows[1].text, `    ${longExpr}`);
    assert.ok(Array.isArray(rows[1].tokens) && rows[1].tokens.length > 0);
    assert.equal(rows[2].tokens.map(([, txt]) => txt).join(""), `    ${longExpr} // updated`);

    const width = computeDiffContentWidth(rows, { minWidth: 300, charPx: 7.8, gutterPx: 96 });
    assert.ok(width > 7000, `expected wide diff width for horizontal scroll, got ${width}`);
    assert.equal(computeDiffContentWidth([{ text: "x" }], { minWidth: 300, charPx: 7.8, gutterPx: 96 }), 300);

    // Ensure stack-safe iteration on large diffs
    const manyRows = Array.from({ length: 12000 }, () => ({ text: "ok" }));
    assert.equal(computeDiffContentWidth(manyRows, { minWidth: 300 }), 300);
  });

  test("formatReviewTabTitle and getSessionNotesKey format deterministic labels and keys", () => {
    assert.equal(formatReviewTabTitle(null), "Review");
    assert.equal(formatReviewTabTitle({}), "Review");
    assert.equal(formatReviewTabTitle({ path: "src/components/LoginModal.tsx" }), "Review · LoginModal.tsx");
    assert.equal(
      formatReviewTabTitle({ displayPath: "auth-api/src/jwt.ts", path: "src/jwt.ts" }),
      "Review · jwt.ts",
    );
    assert.equal(formatReviewTabTitle("README.md"), "Review · README.md");

    assert.equal(getSessionNotesKey("space-1", "tab-9"), "space-1::tab-9");
    assert.equal(getSessionNotesKey("space-1", null), "space-1::global");
    assert.equal(getSessionNotesKey("", ""), "default::global");
  });

  test("resolveSessionAgentTabId preserves agent tab while viewing non-terminal Review tab", () => {
    const space = {
      id: "sp-1",
      tabs: [
        { id: "tab-agent-1", active: false },
        { id: "tab-agent-2", active: false },
        { id: "tab-review", active: true },
      ],
    };
    const allPanes = [
      { id: "p-1", tab: "tab-agent-1", terminal: "term-1" },
      { id: "p-2", tab: "tab-agent-2", terminal: "term-2" },
      { id: "p-3", tab: "tab-review", terminal: null, mod: "changes-review" },
    ];

    // Stored agent tab still has a terminal -> resolve it over non-terminal Review tab
    assert.equal(
      resolveSessionAgentTabId(space, allPanes, { "sp-1": "tab-agent-2" }),
      "tab-agent-2",
    );

    // Stale or missing stored tab -> fall back to first tab with a terminal in the space
    assert.equal(
      resolveSessionAgentTabId(space, allPanes, { "sp-1": "tab-deleted" }),
      "tab-agent-1",
    );

    // If the active tab itself has a terminal, it wins immediately over stored tab
    const terminalActiveSpace = {
      id: "sp-1",
      tabs: [
        { id: "tab-agent-1", active: true },
        { id: "tab-agent-2", active: false },
      ],
    };
    assert.equal(
      resolveSessionAgentTabId(terminalActiveSpace, allPanes, { "sp-1": "tab-agent-2" }),
      "tab-agent-1",
    );

    // Space without any terminal panes falls back to active tab id, or null when empty
    assert.equal(
      resolveSessionAgentTabId({ id: "sp-2", tabs: [{ id: "tab-review", active: true }] }, [], {}),
      "tab-review",
    );
    assert.equal(resolveSessionAgentTabId(null, allPanes, {}), null);
  });

  test("pickNextUnreviewedFile wraps around files skipping current and reviewed items", () => {
    const files = [
      { key: "svc::a.js" },
      { key: "svc::b.js" },
      { key: "svc::c.js" },
    ];
    const reviewed = new Set(["svc::b.js"]);

    // Starting at a.js skips already-reviewed b.js and lands on c.js
    assert.equal(
      pickNextUnreviewedFile(files, "svc::a.js", (f) => reviewed.has(f.key))?.key,
      "svc::c.js",
    );

    // Starting at c.js wraps back to unreviewed a.js
    assert.equal(
      pickNextUnreviewedFile(files, "svc::c.js", (f) => reviewed.has(f.key))?.key,
      "svc::a.js",
    );

    // Null/absent currentKey selects the first unreviewed entry from index 0
    assert.equal(
      pickNextUnreviewedFile(files, null, (f) => f.key === "svc::a.js")?.key,
      "svc::b.js",
    );

    // Returns null when every remaining file is already reviewed (or single file only)
    assert.equal(
      pickNextUnreviewedFile(files, "svc::c.js", (f) => f.key !== "svc::c.js"),
      null,
    );
    assert.equal(pickNextUnreviewedFile([{ key: "svc::only.js" }], "svc::only.js", () => false), null);
    assert.equal(pickNextUnreviewedFile([], null, () => false), null);
  });

  test("sortServicesDirtyFirst orders dirty services first and then alphabetically by name", () => {
    const sorted = sortServicesDirtyFirst([
      { id: "web", name: "web-client", workingCount: 0 },
      { id: "billing", name: "billing-api", workingCount: 2 },
      { id: "auth", name: "auth-api", workingCount: 5 },
      { id: "docs", name: "docs", workingCount: 0 },
    ]);
    assert.deepEqual(sorted.map((s) => s.id), ["auth", "billing", "docs", "web"]);
    assert.deepEqual(sortServicesDirtyFirst(null), []);
  });

  test("normalizeCommentSide and buildCommentKey disambiguate deleted vs added lines sharing a line number", () => {
    assert.equal(normalizeCommentSide("old"), "old");
    assert.equal(normalizeCommentSide("new"), "new");
    assert.equal(normalizeCommentSide(undefined), "new");
    assert.equal(normalizeCommentSide("other"), "new");

    const oldKey = buildCommentKey("auth::src/a.ts", 14, "old");
    const newKey = buildCommentKey("auth::src/a.ts", 14, "new");
    assert.notEqual(oldKey, newKey);
    assert.equal(oldKey, "auth::src/a.ts::old::14");
    assert.equal(newKey, "auth::src/a.ts::new::14");
    assert.equal(buildCommentKey("auth::src/a.ts", 14), newKey);
  });

  test("filterSessionWorkingEntries excludes unchanged baseline files, detects re-edits, and blocks deleted-file mtimeMs=0 leaks", () => {
    const startedAt = 1700000100000;
    const baselineRepo = {
      dirtyFiles: {
        "src/unchanged.js": { status: "M", sig: "120:1700000050000" },
        "src/re-edited.js": { status: "M", sig: "200:1700000050000" },
        "src/status-changed.js": { status: "A", sig: "50:1700000050000" },
        "src/old-deleted.js": { status: "D", sig: "deleted" },
      },
    };

    const entries = [
      { relFile: "src/unchanged.js", status: "M", sig: "120:1700000050000", mtimeMs: 1700000050000 },
      { relFile: "src/re-edited.js", status: "M", sig: "245:1700000200000", mtimeMs: 1700000200000 },
      { relFile: "src/status-changed.js", status: "M", sig: "50:1700000050000", mtimeMs: 1700000050000 },
      { relFile: "src/old-deleted.js", status: "D", sig: "deleted:D", mtimeMs: 0 },
      { relFile: "src/new-session.js", status: "A", sig: "99:1700000150000", mtimeMs: 1700000150000 },
    ];

    assert.deepEqual(
      filterSessionWorkingEntries(entries, baselineRepo, startedAt).map((e) => e.relFile),
      ["src/re-edited.js", "src/status-changed.js", "src/new-session.js"],
    );

    // When baselineRepo is missing and sessionStartedAt > 0, mtimeMs === 0 (e.g. pre-existing deleted file) MUST stay hidden
    const fallbackEntries = [
      { relFile: "old.js", status: "M", sig: "10:1700000000000", mtimeMs: 1700000000000 },
      { relFile: "fresh.js", status: "M", sig: "10:1700000100000", mtimeMs: 1700000100000 },
      { relFile: "preexisting-deleted.js", status: "D", sig: "deleted:D", mtimeMs: 0 },
    ];
    assert.deepEqual(
      filterSessionWorkingEntries(fallbackEntries, null, startedAt).map((e) => e.relFile),
      ["fresh.js"],
    );
  });

  test("statFileEntry and normalizeGitStatusMark match files-search identically across stat, no-stat QuickJS, binary, dir, and SSH", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-parity-"));
    try {
      const textFile = path.join(dir, "main.ts");
      await fs.writeFile(textFile, "export const saludo = 'hola ñ';\n", "utf8");
      const binFile = path.join(dir, "mypass.zip");
      await fs.writeFile(binFile, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xfe, 0xed]));
      const subDir = path.join(dir, ".agent");
      await fs.mkdir(subDir);

      // 1. Standard Node stat mode
      assert.deepEqual(
        await statFileEntry(textFile, "M", null),
        await filesSearchStatFileEntry(textFile, "M", null),
      );
      assert.deepEqual(
        await statFileEntry(binFile, "A", null),
        await filesSearchStatFileEntry(binFile, "A", null),
      );
      assert.deepEqual(
        await statFileEntry(subDir, "A", null),
        await filesSearchStatFileEntry(subDir, "A", null),
      );

      // 2. QuickJS no-stat fallback mode (exists + raw readFile Uint8Array)
      const noStatFs = {
        exists: async (p) => {
          try { await fs.access(p); return true; } catch { return false; }
        },
        readFile: (p) => fs.readFile(p),
      };
      const crText = await statFileEntry(textFile, "M", null, noStatFs);
      const fsText = await filesSearchStatFileEntry(textFile, "M", null, noStatFs);
      assert.deepEqual(crText, fsText);
      assert.match(crText.sig, /^\d+:b[0-9a-f]{8}$/);

      const crBin = await statFileEntry(binFile, "A", null, noStatFs);
      const fsBin = await filesSearchStatFileEntry(binFile, "A", null, noStatFs);
      assert.deepEqual(crBin, fsBin);
      assert.equal(crBin.sig.startsWith("6:b"), true);

      const crDir = await statFileEntry(subDir, "A", null, noStatFs);
      const fsDir = await filesSearchStatFileEntry(subDir, "A", null, noStatFs);
      assert.deepEqual(crDir, fsDir);
      assert.equal(crDir.sig, "dir:A");

      const crMissing = await statFileEntry(path.join(dir, "nope.txt"), "D", null, noStatFs);
      const fsMissing = await filesSearchStatFileEntry(path.join(dir, "nope.txt"), "D", null, noStatFs);
      assert.equal(crMissing.sig, "deleted:D");
      assert.equal(fsMissing.sig, "deleted");

      // 3. SSH remote mode (and diffStat-backed signature detection for SSH re-edits)
      assert.deepEqual(
        await statFileEntry(textFile, "M", "dev@host"),
        await filesSearchStatFileEntry(textFile, "M", "dev@host"),
      );
      const sshStatA = await statFileEntry(textFile, "M", "dev@host", noStatFs, { diffStat: { add: 3, del: 1, binary: false } });
      const sshStatB = await statFileEntry(textFile, "M", "dev@host", noStatFs, { diffStat: { add: 8, del: 1, binary: false } });
      assert.notEqual(sshStatA.sig, sshStatB.sig);

      // 4. Git status normalization parity
      for (const xy of ["??", " M", "M ", "MM", "A ", "AD", "UD", "UU", "AA", "DD", " D"]) {
        assert.equal(normalizeGitStatusMark(xy), filesSearchNormalizeStatus(xy), `mismatch for ${xy}`);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("resolveSessionAgentTabId does not steal prior tab baseline when a brand-new tab has no panes yet", () => {
    const space = {
      id: "sp-1",
      tabs: [
        { id: "tab-old", active: false },
        { id: "tab-new", active: true },
      ],
    };
    const panesBeforeSpawn = [
      { id: "p-1", tab: "tab-old", terminal: "term-1" },
    ];
    assert.equal(
      resolveSessionAgentTabId(space, panesBeforeSpawn, { "sp-1": "tab-old" }),
      "tab-new",
    );

    // Non-terminal File Viewer tab DOES preserve stored agent tab
    const spaceViewingFile = {
      id: "sp-1",
      tabs: [
        { id: "tab-old", active: false },
        { id: "tab-file-viewer", active: true },
      ],
    };
    const panesWithViewer = [
      { id: "p-1", tab: "tab-old", terminal: "term-1" },
      { id: "p-2", tab: "tab-file-viewer", terminal: null, mod: "files-search" },
    ];
    assert.equal(
      resolveSessionAgentTabId(spaceViewingFile, panesWithViewer, { "sp-1": "tab-old" }),
      "tab-old",
    );
  });

  test("filterUnbaselinedRepoEntries blocks un-attributed mtimeMs=0 sibling leaks and pre-existing deleted files", () => {
    const entries = [
      { relFile: "manifest.json", status: "M", sig: "100:b1234567", mtimeMs: 0 },
      { relFile: ".agent/SKILL.md", status: "A", sig: "200:babcdef0", mtimeMs: 0 },
    ];

    // Un-attributed sibling repo (e.g. mypass/scaffold) with mtimeMs=0 -> 0 session changes, backfilled
    const unattr = filterUnbaselinedRepoEntries(entries, 1700000000000, { isAttributed: false });
    assert.equal(unattr.sessionFiles.length, 0);
    assert.deepEqual(Object.keys(unattr.backfillDirtyFiles).sort(), [".agent/SKILL.md", "manifest.json"]);

    // Attributed repo (active-tab pane cwd / transcript / sessionRepos) -> surfaces entries
    const attr = filterUnbaselinedRepoEntries(entries, 1700000000000, { isAttributed: true });
    assert.equal(attr.sessionFiles.length, 2);

    // Regression: when some entries have real mtimeMs, deleted file (mtimeMs=0) MUST be backfilled, not leaked
    const mixedEntries = [
      { relFile: "src/fresh.ts", status: "M", sig: "50:1700000005000", mtimeMs: 1700000005000 },
      { relFile: "src/old-deleted.ts", status: "D", sig: "deleted:D", mtimeMs: 0 },
    ];
    const mixed = filterUnbaselinedRepoEntries(mixedEntries, 1700000001000, { isAttributed: false });
    assert.deepEqual(mixed.sessionFiles.map((e) => e.relFile), ["src/fresh.ts"]);
    assert.deepEqual(Object.keys(mixed.backfillDirtyFiles), ["src/old-deleted.ts"]);
  });

  test("extractResumeKeyFromTranscript and readDiskSessionBaseline preserve rev/startHead and prevent cross-workspace collisions", async () => {
    assert.equal(extractResumeKeyFromTranscript("/home/nmr/.config/herdr-app/cognivisor/sessions/resume", "/ws"), "");
    assert.equal(extractResumeKeyFromTranscript("Use /resume to restore a session\n  /resume   Resume chat", "/ws"), "");
    assert.equal(extractResumeKeyFromTranscript("\x1b[36m❯\x1b[0m /resume sess-42", "/ws"), "resume:sess-42");
    assert.equal(extractResumeKeyFromTranscript("user@dev:~/herdr-cognivisor$ claude --resume", "/ws"), "resume:/ws");

    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const appHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-cr-baseline-"));
    try {
      const ws = "/home/nmr/Projects/herdr-cognivisor";
      const baseline = {
        version: 1,
        rev: 2,
        startedAt: 1700000000000,
        workspaceRoot: ws,
        repos: {
          "/home/nmr/Projects/mypass": {
            startHead: "1111111111111111111111111111111111111111",
            startBranch: "feat/pay",
            dirtyFiles: { "manifest.json": { status: "M", sig: "10:b01020304" } },
          },
        },
      };
      await writeDiskSessionBaseline(appHomeDir, "tab-1", ws, "main", baseline);

      const loadedSameWs = await readDiskSessionBaseline(appHomeDir, "tab-1", ws, ["main"], false);
      assert.deepEqual(loadedSameWs, baseline);

      const loadedWrongWs = await readDiskSessionBaseline(appHomeDir, "tab-1", "/home/nmr/Projects/other", ["main"], false);
      assert.equal(loadedWrongWs, null);
    } finally {
      await fs.rm(appHomeDir, { recursive: true, force: true });
    }
  });

  test("resolveWorkspaceRoot defers to paneCwd when spaceFolder is $HOME and matches files-search", () => {
    const appHomeDir = "/home/nmr/.config/herdr-app";
    const cases = [
      { spaceFolder: "/home/nmr", paneCwd: "/home/nmr/Projects/herdr-cognivisor", appHomeDir },
      { spaceFolder: "/home/nmr", paneCwd: "/home/nmr", appHomeDir },
      { spaceFolder: "/home/nmr", paneCwd: null, appHomeDir },
      { spaceFolder: "/home/nmr/Projects", paneCwd: "/home/nmr/Projects/herdr-cognivisor", appHomeDir },
      { spaceFolder: "/home/nmr/Projects/herdr-cognivisor", paneCwd: "/home/nmr/Projects/herdr-cognivisor/mods", appHomeDir },
      { spaceFolder: "/home/nmr/Projects/herdr-cognivisor", paneCwd: "/tmp/scratch", appHomeDir },
      { spaceFolder: "C:\\Users\\nmr", paneCwd: "C:\\Users\\nmr\\work\\app", isWindows: true, appHomeDir: "C:\\Users\\nmr\\AppData\\Roaming\\herdr-app" },
    ];
    for (const c of cases) {
      assert.equal(resolveWorkspaceRoot(c), filesSearchResolveWorkspaceRoot(c));
    }
    assert.equal(isHomeDirectoryRoot("/home/nmr", null, appHomeDir), true);
    assert.equal(resolveWorkspaceRoot(cases[0]), "/home/nmr/Projects/herdr-cognivisor");
    assert.equal(resolveWorkspaceRoot(cases[3]), "/home/nmr/Projects");
    assert.equal(resolveWorkspaceRoot(cases[4]), "/home/nmr/Projects/herdr-cognivisor");
    assert.equal(resolveWorkspaceRoot(cases[5]), "/tmp/scratch");
    assert.equal(resolveWorkspaceRoot(cases[6]), "C:\\Users\\nmr\\work\\app");
  });

  test("mergeBusCandidateServices, parseNameStatusZ, and parseNumstatZ parse lock-free git outputs cleanly", () => {
    const candidates = [
      { id: ".", name: "herdr-cognivisor", relPath: "", root: "/ws/herdr-cognivisor", isSibling: false, branch: "" },
      { id: "../mypass", name: "mypass", relPath: "", root: "/ws/mypass", isSibling: true, branch: "dev" },
    ];
    const busServices = [
      { id: "../mypass", name: "mypass", root: "/ws/mypass", branch: "dev", workingCount: 2, aheadCount: 1 },
      { id: "extra", name: "extra", root: "/ws/extra", branch: "feat/x", workingCount: 1, aheadCount: 0 },
    ];
    const merged = mergeBusCandidateServices(candidates, busServices, false);
    assert.deepEqual(
      merged.map((s) => ({ root: s.root, workingCount: s.workingCount ?? 0, branch: s.branch })),
      [
        { root: "/ws/herdr-cognivisor", workingCount: 0, branch: "" },
        { root: "/ws/mypass", workingCount: 2, branch: "dev" },
        { root: "/ws/extra", workingCount: 1, branch: "feat/x" },
      ],
    );

    const statusMap = parseNameStatusZ("M\0src/a.ts\0A\0src/new.ts\0D\0src/old.ts\0T\0src/link.ts\0");
    assert.deepEqual(Object.fromEntries(statusMap), {
      "src/a.ts": "M",
      "src/new.ts": "A",
      "src/old.ts": "D",
      "src/link.ts": "M",
    });

    const numMap = parseNumstatZ("12\t3\tsrc/a.ts\0-\t-\tassets/logo.png\0");
    assert.deepEqual(numMap.get("src/a.ts"), { add: 12, del: 3, binary: false });
    assert.deepEqual(numMap.get("assets/logo.png"), { add: 0, del: 0, binary: true });
  });

  test("resolveRepoBaseRefWithExec anchors feature branches to origin base and falls back to startHead on base branches", async () => {
    const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const START = "cccccccccccccccccccccccccccccccccccccccc";

    // 1. Feature branch with origin/HEAD -> origin/main returns merge-base hash (never origin/<feature>)
    const featureExec = async (_cmd, args) => {
      assert.ok(READ_GIT_FLAGS.every((f) => args.includes(f)));
      if (args.includes("symbolic-ref")) return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      if (args.includes("for-each-ref")) return { code: 0, stdout: "origin/main\nmain\n", stderr: "" };
      if (args.includes("merge-base") && args.includes("origin/main")) return { code: 0, stdout: `${BASE}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const featRes = await resolveRepoBaseRefWithExec("/ws/auth", "feat/PROJ-412", HEAD, null, featureExec);
    assert.deepEqual(featRes, { hasHead: true, baseRef: "origin/main", baseHash: BASE, baseSource: "base" });

    // 2. Working directly on `main` after pushing (merge-base === HEAD) falls back to session `startHead`
    const pushedMainExec = async (_cmd, args) => {
      if (args.includes("symbolic-ref")) return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      if (args.includes("for-each-ref")) return { code: 0, stdout: "origin/main\nmain\n", stderr: "" };
      if (args.includes("merge-base") && args.includes("--is-ancestor") && args.includes(START)) {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("merge-base")) return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const pushedMainRes = await resolveRepoBaseRefWithExec("/ws/auth", "main", HEAD, null, pushedMainExec, { startHead: START });
    assert.deepEqual(pushedMainRes, { hasHead: true, baseRef: "session start", baseHash: START, baseSource: "session" });

    // 3. Local-only repo without remotes falls back to local `development`
    const localOnlyExec = async (_cmd, args) => {
      if (args.includes("symbolic-ref")) return { code: 1, stdout: "", stderr: "" };
      if (args.includes("for-each-ref")) return { code: 0, stdout: "development\nmain\n", stderr: "" };
      if (args.includes("merge-base") && args.includes("development")) return { code: 0, stdout: `${BASE}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const localRes = await resolveRepoBaseRefWithExec("/ws/auth", "feat/x", HEAD, null, localOnlyExec);
    assert.deepEqual(localRes, { hasHead: true, baseRef: "development", baseHash: BASE, baseSource: "base" });

    // 4. Unborn repo (empty headHash)
    const unbornRes = await resolveRepoBaseRefWithExec("/ws/new", "main", "", null, localOnlyExec);
    assert.deepEqual(unbornRes, { hasHead: false, baseRef: "", baseHash: "", baseSource: "unborn" });
  });

  test("collectServiceSessionSnapshot merges committed + working-tree edits into one deduplicated list and counts untracked lines", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-unified-snap-"));
    try {
      await fs.mkdir(path.join(tmpRepo, "src"), { recursive: true });
      await fs.writeFile(path.join(tmpRepo, "src/shared.ts"), "export const v = 2;\n", "utf8");
      await fs.writeFile(path.join(tmpRepo, "src/new-untracked.ts"), "line 1\nline 2\nline 3\n", "utf8");
      await fs.writeFile(path.join(tmpRepo, "src/blob.bin"), new Uint8Array([0x00, 0x01, 0x02, 0x03]));

      const BASE = "1111111111111111111111111111111111111111";
      const HEAD = "2222222222222222222222222222222222222222";
      const calls = [];
      const mockExec = async (_cmd, args) => {
        calls.push(args);
        if (args.includes("status")) {
          return { code: 0, stdout: "## feat/unified...origin/feat/unified\0 M src/shared.ts\0?? src/new-untracked.ts\0?? src/blob.bin\0", stderr: "" };
        }
        if (args.includes("rev-parse")) return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
        if (args.includes("symbolic-ref")) return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
        if (args.includes("for-each-ref")) return { code: 0, stdout: "origin/main\n", stderr: "" };
        if (args.includes("merge-base")) return { code: 0, stdout: `${BASE}\n`, stderr: "" };
        if (args.includes("diff") && args.includes("--name-status")) {
          return { code: 0, stdout: "M\0src/shared.ts\0D\0src/removed-in-commit.ts\0", stderr: "" };
        }
        if (args.includes("diff") && args.includes("--numstat")) {
          return { code: 0, stdout: "15\t4\tsrc/shared.ts\x000\t20\tsrc/removed-in-commit.ts\x00", stderr: "" };
        }
        if (args.includes("diff") && args.includes("--name-only")) {
          return { code: 0, stdout: "src/shared.ts\0src/removed-in-commit.ts\0", stderr: "" };
        }
        throw new Error(`Unexpected git args: ${args.join(" ")}`);
      };

      const service = { id: "auth", name: "auth-api", relPath: "auth", root: tmpRepo, isSibling: false };
      const snap = await collectServiceSessionSnapshot(
        { ...service },
        null,
        { baselineRepo: { startHead: BASE, dirtyFiles: { "src/shared.ts": { status: "M", sig: "old" } } } },
        { exec: mockExec, fsPromises: fs },
      );

      assert.ok(calls.every((a) => READ_GIT_FLAGS.every((flag) => a.includes(flag))));
      assert.equal(snap.baseRef, "origin/main");
      assert.equal(snap.baseHash, BASE);
      assert.equal(snap.headHash, HEAD);
      assert.equal(snap.committedPaths.has("src/shared.ts"), true);
      assert.equal(snap.committedPaths.has("src/removed-in-commit.ts"), true);

      // Deduplicated unified files: src/shared.ts appears ONCE combining commits + working tree!
      assert.deepEqual(snap.files.map((f) => f.path), [
        "src/blob.bin",
        "src/new-untracked.ts",
        "src/removed-in-commit.ts",
        "src/shared.ts",
      ]);

      const untrackedText = snap.files.find((f) => f.path === "src/new-untracked.ts");
      assert.equal(untrackedText.add, 3, "untracked text file must count real lines instead of +0");
      assert.equal(untrackedText.binary, false);
      assert.equal(untrackedText.fresh, true);

      const untrackedBin = snap.files.find((f) => f.path === "src/blob.bin");
      assert.equal(untrackedBin.binary, true);
      assert.equal(untrackedBin.add, 0);

      const deletedCommitFile = snap.files.find((f) => f.path === "src/removed-in-commit.ts");
      assert.equal(deletedCommitFile.status, "D");
      assert.equal(deletedCommitFile.sig, "deleted:D");
      assert.equal(deletedCommitFile.inWorkingTree, false);
      assert.equal(deletedCommitFile.baseHash, BASE);

      // Untracked line counter handles no-trailing-LF and empty files cleanly
      const noLfPath = path.join(tmpRepo, "src/no-lf.txt");
      await fs.writeFile(noLfPath, "a\nb", "utf8");
      assert.deepEqual(await countUntrackedFileLines(noLfPath, null, fs), { add: 2, del: 0, binary: false });
    } finally {
      await fs.rm(tmpRepo, { recursive: true, force: true });
    }
  });

  test("partitionSessionUnifiedEntries & evaluateRepoSessionActivity exclude untouched sibling repos while preserving committed branch changes", () => {
    const baselineRepo = {
      startHead: "1111",
      dirtyFiles: {
        "src/preexisting-dirty.ts": { status: "M", sig: "50:1000" },
        "src/in-both-commit-and-dirty.ts": { status: "M", sig: "80:1000" },
      },
    };
    const unifiedFiles = [
      { path: "src/preexisting-dirty.ts", status: "M", workingStatus: "M", inWorkingTree: true, sig: "50:1000", mtimeMs: 1000 },
      { path: "src/in-both-commit-and-dirty.ts", status: "M", workingStatus: "M", inWorkingTree: true, sig: "80:1000", mtimeMs: 1000 },
      { path: "src/committed-only.ts", status: "A", workingStatus: "", inWorkingTree: false, sig: "90:2000", mtimeMs: 2000 },
    ];
    const committedPaths = new Set(["src/in-both-commit-and-dirty.ts", "src/committed-only.ts"]);

    const part = partitionSessionUnifiedEntries(unifiedFiles, baselineRepo, committedPaths, 1500);
    assert.deepEqual(part.visible.map((f) => f.path), ["src/in-both-commit-and-dirty.ts", "src/committed-only.ts"]);
    assert.deepEqual(part.hidden.map((f) => f.path), ["src/preexisting-dirty.ts"]);

    // Untouched sibling repo on old feature branch -> excluded (false)
    assert.equal(
      evaluateRepoSessionActivity({
        hasNewWorkingEdit: false,
        inPaneCwd: false,
        inSessionRepos: false,
        startHead: "aaaa",
        headHash: "aaaa",
        repoMatchesTranscript: false,
      }),
      false,
    );
    // Active chat repo on existing feature branch -> included (true)
    assert.equal(
      evaluateRepoSessionActivity({
        hasNewWorkingEdit: false,
        inPaneCwd: true,
        inSessionRepos: false,
        startHead: "aaaa",
        headHash: "aaaa",
        repoMatchesTranscript: false,
      }),
      true,
    );
    // Sibling repo committed by another unrelated terminal (no transcript match) -> excluded (false)
    assert.equal(
      evaluateRepoSessionActivity({
        hasNewWorkingEdit: false,
        inPaneCwd: false,
        inSessionRepos: false,
        startHead: "aaaa",
        headHash: "bbbb",
        repoMatchesTranscript: false,
      }),
      false,
    );
    // Sibling repo committed by THIS session's agent (transcript match) -> included (true)
    assert.equal(
      evaluateRepoSessionActivity({
        hasNewWorkingEdit: false,
        inPaneCwd: false,
        inSessionRepos: false,
        startHead: "aaaa",
        headHash: "bbbb",
        repoMatchesTranscript: true,
      }),
      true,
    );
  });

  test("computeFileReviewFingerprint and reconcileReviewedFiles survive git commit unchanged and invalidate on edit or baseHash move", () => {
    assert.equal(computeFileReviewFingerprint(null), "");
    assert.equal(computeFileReviewFingerprint(undefined), "");
    assert.equal(buildReviewedFileKey({ key: "auth::src/jwt.ts" }), "session::auth::src/jwt.ts");

    const untrackedBeforeCommit = {
      key: "auth::src/jwt.ts",
      status: "A",
      add: 12,
      del: 0,
      fresh: true,
      binary: false,
      baseHash: "base111",
      sig: "420:1700000000123",
      mtimeMs: 1700000000123,
    };
    const trackedAfterCommit = {
      ...untrackedBeforeCommit,
      fresh: false,
    };
    const fpBefore = computeFileReviewFingerprint(untrackedBeforeCommit);
    const fpAfter = computeFileReviewFingerprint(trackedAfterCommit);
    assert.equal(fpBefore, fpAfter, "approving an added file must survive git add + git commit unchanged");

    // Edits or baseHash changes MUST invalidate the fingerprint
    assert.notEqual(computeFileReviewFingerprint({ ...trackedAfterCommit, add: 13 }), fpAfter);
    assert.notEqual(computeFileReviewFingerprint({ ...trackedAfterCommit, sig: "425:1700000009999" }), fpAfter);
    assert.notEqual(computeFileReviewFingerprint({ ...trackedAfterCommit, baseHash: "base222" }), fpAfter);
    assert.notEqual(computeFileReviewFingerprint({ ...trackedAfterCommit, binary: true }), fpAfter);

    const fileB = {
      key: "auth::src/b.js",
      status: "D",
      add: 0,
      del: 5,
      fresh: false,
      binary: false,
      baseHash: "base111",
      sig: "deleted:D",
      mtimeMs: 0,
    };
    const fpB = computeFileReviewFingerprint(fileB);

    // 1. Retains unchanged session:: checks across commit and drops legacy working::/commit: keys
    const prevMap = {
      "session::auth::src/jwt.ts": { reviewed: true, fp: fpBefore, reviewedAt: 1700000200000 },
      "session::auth::src/b.js": { reviewed: true, fp: fpB, reviewedAt: 1700000200000 },
      "working::auth::src/old.js": { reviewed: true, fp: "legacy", reviewedAt: 1700000200000 },
      "commit:c1::auth::src/c.js": { reviewed: true, fp: "legacy", reviewedAt: 1700000200000 },
    };
    const reconciled = reconcileReviewedFiles(prevMap, { sessionFiles: [trackedAfterCommit, fileB] });
    assert.equal(reconciled.changed, true);
    assert.deepEqual(Object.keys(reconciled.nextMap).sort(), [
      "session::auth::src/b.js",
      "session::auth::src/jwt.ts",
    ]);

    // 2. Clean steady-state has changed === false
    const steady = reconcileReviewedFiles(reconciled.nextMap, { sessionFiles: [trackedAfterCommit, fileB] });
    assert.equal(steady.changed, false);

    // 3. Editing a file invalidates ONLY that file
    const editedJwt = { ...trackedAfterCommit, sig: "430:1700000999999" };
    const afterEdit = reconcileReviewedFiles(reconciled.nextMap, { sessionFiles: [editedJwt, fileB] });
    assert.equal(afterEdit.changed, true);
    assert.deepEqual(Object.keys(afterEdit.nextMap), ["session::auth::src/b.js"]);

    // 4. Preserves checks for services in erroredServiceIds
    const withErrored = {
      "session::billing::src/pay.js": { reviewed: true, fp: "M|1|1|0|b1|10:1", reviewedAt: 1700000200000 },
      "session::auth::src/b.js": { reviewed: true, fp: fpB, reviewedAt: 1700000200000 },
    };
    const errRes = reconcileReviewedFiles(withErrored, {
      sessionFiles: [fileB],
      erroredServiceIds: new Set(["billing"]),
    });
    assert.equal(errRes.changed, false);
    assert.deepEqual(errRes.nextMap, withErrored);

    assert.deepEqual(parseReviewedFileRecord(true), { reviewed: true, fp: "", reviewedAt: 0 });
    assert.equal(parseReviewedFileRecord(false), null);
    assert.equal(parseReviewedFileRecord(null), null);
  });

  test("mods/changes-review synced shared modules match shared/ verbatim and dropdown files are removed", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    for (const file of ["code-wrap.js", "code-syntax.js", "markdown-syntax.js", "markdown-view-logic.js", "markdown-view.js"]) {
      const canonical = readFileSync(resolve(repoRoot, "shared", file), "utf8");
      const modCopy = readFileSync(resolve(repoRoot, "mods/changes-review", file), "utf8");
      assert.equal(modCopy, canonical, `mods/changes-review/${file} must match shared/${file} verbatim`);
    }
    assert.equal(existsSync(resolve(repoRoot, "mods/changes-review/dropdown.js")), false);
    assert.equal(existsSync(resolve(repoRoot, "mods/changes-review/dropdown-logic.js")), false);
  });

  test("tokenizeDiffLine delegates md and mdx prose to shared markdown syntax without code-keyword rainbow noise", () => {
    const prose = 'Use `const x = 1` when **bold** and or is in "quoted" text -> @user.';
    for (const ext of ["md", "mdx", "MD"]) {
      const toks = tokenizeDiffLine(prose, ext);
      assert.ok(Array.isArray(toks));
      assert.equal(toks.map(([, v]) => v).join(""), prose);
      assert.deepEqual(toks, [
        ["plain", "Use "],
        ["string", "`const x = 1`"],
        ["plain", ' when **bold** and or is in "quoted" text -> @user.'],
      ]);
      for (const [kind] of toks) {
        assert.notEqual(kind, "keyword");
        assert.notEqual(kind, "operator");
        assert.notEqual(kind, "annotation");
        assert.notEqual(kind, "number");
      }
    }

    assert.deepEqual(tokenizeDiffLine("## Heading and or is", "md"), [
      ["keyword", "##"],
      ["plain", " "],
      ["function", "Heading and or is"],
    ]);

    assert.deepEqual(tokenizeDiffLine('- list item with `code` and "quotes"', "md"), [
      ["comment", "-"],
      ["plain", " list item with "],
      ["string", "`code`"],
      ["plain", ' and "quotes"'],
    ]);

    assert.deepEqual(tokenizeDiffLine("- [x] shipped and or is", "mdx"), [
      ["comment", "-"],
      ["plain", " "],
      ["constant", "[x]"],
      ["plain", " shipped and or is"],
    ]);
  });

  test("diffRows maintains per-side Markdown frontmatter/fence state and isolates deletions from active additions", () => {
    const fmRows = diffRows([
      "@@ -0,0 +1,5 @@",
      "+---",
      '+title: "Guide"',
      "+---",
      "+## Intro",
      '+Prose with and or is "quoted" **bold**.',
    ], "docs/guide.md");

    assert.deepEqual(fmRows[1].tokens, [["comment", "---"]]);
    assert.deepEqual(fmRows[2].tokens, [
      ["type", "title"],
      ["comment", ":"],
      ["plain", ' "Guide"'],
    ]);
    assert.deepEqual(fmRows[3].tokens, [["comment", "---"]]);
    assert.deepEqual(fmRows[4].tokens, [
      ["keyword", "##"],
      ["plain", " "],
      ["function", "Intro"],
    ]);
    assert.deepEqual(fmRows[5].tokens, [
      ["plain", 'Prose with and or is "quoted" **bold**.'],
    ]);

    // Later hunk keeps per-side fence state: `-` deletions must not corrupt `+` fence or leak fences into `+` prose,
    // and non-contiguous `@` hunks reset unclosed fences cleanly.
    const mdDiffRows = diffRows([
      "@@ -10,4 +10,7 @@",
      " ---",
      "-Old prose with and or is - list item",
      "+```js",
      "-```",
      "+const total = 42;",
      "+```",
      "+After fence with and or is **bold** and `inline()`.",
      "@@ -25,2 +28,2 @@",
      "-```python",
      "+Replacement prose after deleted python fence: def and or is 1.",
      "@@ -40,2 +45,2 @@",
      " ```ts",
      "-const a: string = 'old';",
      "+const a: string = 'new';",
      "@@ -80,1 +85,1 @@",
      "+This and or is outside any unclosed fence from earlier hunks.",
    ], "notes/README.mdx");

    // Line 10 context "---" is a horizontal rule (not frontmatter)
    assert.deepEqual(mdDiffRows[1].tokens, [["comment", "---"]]);
    // Deleted prose line stays plain
    assert.deepEqual(mdDiffRows[2].tokens, [["plain", "Old prose with and or is - list item"]]);
    // Opening ```js fence on + side
    assert.deepEqual(mdDiffRows[3].tokens, [["comment", "```"], ["type", "js"]]);
    // Deleted ``` does NOT close active + fence, and stays comment on old side
    assert.deepEqual(mdDiffRows[4].tokens, [["comment", "```"]]);
    // Inside + js fence: JS syntax tokens active!
    assert.ok(mdDiffRows[5].tokens.some(([k, v]) => k === "keyword" && v === "const"));
    assert.ok(mdDiffRows[5].tokens.some(([k, v]) => k === "number" && v === "42"));
    // Closing ``` on + side
    assert.deepEqual(mdDiffRows[6].tokens, [["comment", "```"]]);
    // Back to calm Markdown prose + inline code
    assert.deepEqual(mdDiffRows[7].tokens, [
      ["plain", "After fence with and or is **bold** and "],
      ["string", "`inline()`"],
      ["plain", "."],
    ]);
    // Deleted ```python opens fence on old side only; subsequent + prose stays strictly plain!
    assert.deepEqual(mdDiffRows[9].tokens, [["comment", "```"], ["type", "python"]]);
    assert.deepEqual(mdDiffRows[10].tokens, [
      ["plain", "Replacement prose after deleted python fence: def and or is 1."],
    ]);
    // Context ```ts advances both old and new fence state cleanly for - and + lines inside hunk 3
    assert.ok(mdDiffRows[13].tokens.some(([k, v]) => k === "keyword" && v === "const"));
    assert.ok(mdDiffRows[14].tokens.some(([k, v]) => k === "keyword" && v === "const"));
    // Non-contiguous hunk 4 resets unclosed ```ts fence from hunk 3 cleanly
    assert.deepEqual(mdDiffRows[16].tokens, [
      ["plain", "This and or is outside any unclosed fence from earlier hunks."],
    ]);
  });

  test("resolveReviewMarkdownSourceSpec resolves unified working reads, baseHash deletions, untracked ??, and lock-free git flags", () => {
    // 1. Modified/added/untracked/renamed -> fast readTextFile path with no deleted notice
    const modSpec = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo/", path: "docs/README.md", status: "M", hasHead: true, baseHash: "base111" },
    );
    assert.equal(modSpec.kind, "file");
    assert.equal(modSpec.mode, "after");
    assert.equal(modSpec.isDeleted, false);
    assert.equal(modSpec.notice, "");
    assert.equal(modSpec.absPath, "/ws/repo/docs/README.md");

    const untrackedSpec = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "notes/TODO.mdx", status: "??", fresh: true, hasHead: false },
    );
    assert.equal(untrackedSpec.kind, "file");
    assert.equal(untrackedSpec.isDeleted, false);
    assert.equal(untrackedSpec.absPath, "/ws/repo/notes/TODO.mdx");

    // 2. Deleted file (including committed deletions!) -> lock-free git show <baseHash>:<oldPath || path>
    const deletedAtBase = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "docs/removed.md", oldPath: "docs/prev-removed.md", status: "D", hasHead: true, baseHash: "base999" },
      { on: "dev@host" },
    );
    assert.equal(deletedAtBase.kind, "git");
    assert.equal(deletedAtBase.mode, "before");
    assert.equal(deletedAtBase.isDeleted, true);
    assert.equal(deletedAtBase.notice, "Deleted in this change — showing previous version");
    assert.equal(deletedAtBase.refSpec, "base999:docs/prev-removed.md");
    assert.equal(deletedAtBase.on, "dev@host");
    assert.deepEqual(deletedAtBase.args, [...READ_GIT_FLAGS, "show", "base999:docs/prev-removed.md"]);

    const deletedFallbackHead = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "CHANGELOG.md", status: "D" },
    );
    assert.equal(deletedFallbackHead.kind, "git");
    assert.equal(deletedFallbackHead.refSpec, "HEAD:CHANGELOG.md");

    // Deleted when untracked / repo has no HEAD -> clear unavailable spec
    const deletedNoHead = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "draft.md", status: "D", hasHead: false },
    );
    assert.equal(deletedNoHead.kind, "unavailable");
    assert.equal(deletedNoHead.isDeleted, true);
    assert.match(deletedNoHead.error, /untracked|HEAD/i);

    // Guards: binary flag, missing file
    assert.equal(
      resolveReviewMarkdownSourceSpec({ repoRoot: "/ws/repo", path: "docs/bin.md", status: "M", binary: true }).kind,
      "unavailable",
    );
    assert.equal(resolveReviewMarkdownSourceSpec(null).kind, "unavailable");
  });

  test("Markdown cache keying, binary NUL guard, and git-show error formatting handle baseHash changes cleanly", () => {
    const file = {
      key: "svc::docs/guide.md",
      repoRoot: "/ws/repo",
      path: "docs/guide.md",
      status: "M",
      baseHash: "base111",
      fresh: false,
      sig: "120:1700000000000",
      mtimeMs: 1700000000000,
      add: 4,
      del: 1,
    };

    const id1 = computeViewerMarkdownFileId(file);
    const id2 = computeViewerMarkdownFileId({ ...file, baseHash: "base222" });
    assert.notEqual(id1, id2);
    assert.equal(computeViewerMarkdownFileId(null), "");

    const tok0 = computeReviewMarkdownLoadToken(file, { reloadNonce: 0 });
    const tok1 = computeReviewMarkdownLoadToken(file, { reloadNonce: 1 });
    const tokEdited = computeReviewMarkdownLoadToken(
      { ...file, sig: "140:1700000005000", mtimeMs: 1700000005000 },
      { reloadNonce: 0 },
    );
    assert.notEqual(tok0, tok1);
    assert.notEqual(tok0, tokEdited);

    const k0 = buildReviewMarkdownCacheKey(file, { loadToken: tok0 });
    const k1 = buildReviewMarkdownCacheKey(file, { loadToken: tok1 });
    const kOtherBase = buildReviewMarkdownCacheKey({ ...file, baseHash: "base222" }, { loadToken: tok0 });
    assert.notEqual(k0, k1);
    assert.notEqual(k0, kOtherBase);

    // Binary content NUL byte guard
    assert.deepEqual(validateMarkdownTextContent("# Hello\n"), { ok: true, text: "# Hello\n" });
    const binRes = validateMarkdownTextContent("abc\0def");
    assert.equal(binRes.ok, false);
    assert.match(binRes.error, /binary/i);
    assert.equal(validateMarkdownTextContent(null, "Missing file").error, "Missing file");

    // Git show error translation for missing deleted file at comparison base
    assert.match(
      formatGitShowMarkdownError("fatal: path 'docs/new.md' exists on disk, but not in 'base111'", { isDeleted: true, refSpec: "base111:docs/new.md" }),
      /comparison base|untracked/i,
    );
  });

  test("isIgnoredWatchPath filters .git internals, node_modules, and logs while computeDiffContentWidth guards tabs and charPx", () => {
    const repoRoot = "/workspace/repo-a";
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git", repoRoot), true);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git/", repoRoot), true);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git/objects/aa/bb", repoRoot), true);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git/index.lock", repoRoot), true);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git/logs/HEAD", repoRoot), true);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git/COMMIT_EDITMSG", repoRoot), true);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git/index", repoRoot), false);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git/HEAD", repoRoot), false);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.git//refs/heads/main", repoRoot), false);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/packages/api/node_modules/pkg/index.js", repoRoot), true);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/logs/output.log", repoRoot), true);

    assert.equal(isIgnoredWatchPath("/workspace/repo-a/.gitignore", repoRoot), false);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/src/.gitkeep", repoRoot), false);
    assert.equal(isIgnoredWatchPath("/workspace/repo-a/src/app.js", repoRoot), false);
    assert.equal(isIgnoredWatchPath("/workspace/other/.git/objects/00/11", repoRoot), true);

    const noTabWidth = computeDiffContentWidth([{ type: "line", content: "alpha    beta" }]);
    const tabWidth = computeDiffContentWidth([{ type: "line", content: "alpha\tbeta" }]);
    assert.ok(tabWidth > 0 && noTabWidth > 0);
    assert.equal(computeDiffContentWidth([{ type: "line", content: "abc" }], { minWidth: 300, charPx: 0 }), 300);
    assert.equal(computeDiffContentWidth([{ type: "line", content: "abc" }], { minWidth: 300, charPx: Number.NaN }), 300);
    assert.equal(computeDiffContentWidth([{ type: "line", content: "abc" }], { minWidth: 300, charPx: -4 }), 300);
  });

  test("regression: resolveSessionStartTime ignores tab-naming updatedAt and fresh baseline preserves startHead + workingFiles only", () => {
    const t0900 = 1795442400000;
    const t1205 = 1795453500000;
    const t1211 = 1795453860000;
    const t1215 = 1795454100000;
    const t1221 = 1795454460000;

    // `updatedAt` written by cognivisor-tabs must NOT falsely anchor session start backward
    assert.deepEqual(resolveSessionStartTime({ updatedAt: t1205 }, t1221), { startedAt: t1221, anchored: false });

    // Explicit `sessionStartedAt` DOES anchor session start so agent edits before Review opens remain visible
    const startInfo = resolveSessionStartTime({ sessionStartedAt: t1205 }, t1221);
    assert.equal(startInfo.startedAt, t1205);
    assert.equal(startInfo.anchored, true);

    const workingFiles = [
      { relFile: "src/PreExisting.java", status: "M", sig: "50:1795442400000", mtimeMs: t0900 },
      { relFile: "src/CardB2bApi.java", status: "M", sig: "120:1795453860000", mtimeMs: t1211 },
      { relFile: "src/CardRepository.java", status: "M", sig: "240:1795454100000", mtimeMs: t1215 },
    ];

    const baseline = buildFreshSessionBaseline(
      [{ service: { root: "/ws/ms-card" }, headHash: "deadbeef", branch: "feat/card", workingFiles }],
      { workspaceRoot: "/ws/ms-card", startedAt: startInfo.startedAt, anchored: startInfo.anchored },
    );

    assert.equal(baseline.repos["/ws/ms-card"].startHead, "deadbeef");
    assert.equal(baseline.repos["/ws/ms-card"].startBranch, "feat/card");
    assert.deepEqual(Object.keys(baseline.repos["/ws/ms-card"].dirtyFiles), ["src/PreExisting.java"]);

    const part = partitionSessionWorkingEntries(workingFiles, baseline.repos["/ws/ms-card"], baseline.startedAt);
    assert.deepEqual(part.visible.map((f) => f.relFile), ["src/CardB2bApi.java", "src/CardRepository.java"]);
    assert.deepEqual(part.hidden.map((f) => f.relFile), ["src/PreExisting.java"]);
  });

  test("createResetSessionBaseline increments rev, preserves startHead/startBranch, and clears dirtyFiles", () => {
    const existing = {
      version: 1,
      rev: 1,
      startedAt: 1795454466000,
      workspaceRoot: "/ws/ms-card",
      repos: {
        "/ws/ms-card": {
          startHead: "aaaa1111",
          startBranch: "feat/card",
          dirtyFiles: {
            "src/CardB2bApi.java": { status: "M", sig: "120:1795453860000" },
            "src/CardRepository.java": { status: "M", sig: "240:1795454100000" },
          },
        },
      },
    };
    assert.equal(countBaselineDirtyFiles(existing), 2);

    const reset = createResetSessionBaseline(existing, ["/ws/ms-card", "/ws/ms-wallet"], "/ws/ms-card");
    assert.equal(reset.startedAt, existing.startedAt);
    assert.equal(reset.rev, 2);
    assert.equal(countBaselineDirtyFiles(reset), 0);
    assert.deepEqual(reset.repos["/ws/ms-card"], {
      startHead: "aaaa1111",
      startBranch: "feat/card",
      dirtyFiles: {},
    });
    assert.deepEqual(reset.repos["/ws/ms-wallet"], { dirtyFiles: {} });

    const files = [
      { relFile: "src/CardB2bApi.java", status: "M", sig: "120:1795453860000", mtimeMs: 1795453860000 },
      { relFile: "src/CardRepository.java", status: "M", sig: "240:1795454100000", mtimeMs: 1795454100000 },
    ];
    const afterReset = partitionSessionWorkingEntries(files, reset.repos["/ws/ms-card"], reset.startedAt);
    assert.equal(afterReset.hidden.length, 0);
    assert.deepEqual(afterReset.visible.map((f) => f.relFile), ["src/CardB2bApi.java", "src/CardRepository.java"]);
  });

  test("regression: compactFlowsMap strips bulky sessionBaseline and prunes expired closed tabs to prevent QuickJS OOM", () => {
    const now = 1795474000000;
    const day = 24 * 60 * 60 * 1000;
    const flows = {
      live_tab: {
        ticket: "PROJ-1",
        sessionStartedAt: now - 1000,
        sessionBaseline: { version: 1, startedAt: now - 1000, repos: { "/ws/a": { dirtyFiles: { "x.js": { status: "M", sig: "1:1" } } } } },
        updatedAt: now - 1000,
      },
      recent_closed: {
        sessionStartedAt: now - day,
        sessionBaseline: { version: 1, startedAt: now - day, repos: {} },
        updatedAt: now - day,
      },
      ancient_closed: {
        sessionStartedAt: now - 30 * day,
        sessionBaseline: { version: 1, startedAt: now - 30 * day, repos: {} },
        updatedAt: now - 30 * day,
      },
    };
    const compacted = compactFlowsMap(flows, new Set(["live_tab"]), { maxClosedTabs: 10, maxAgeMs: 7 * day, now });
    assert.deepEqual(Object.keys(compacted).sort(), ["live_tab", "recent_closed"]);
    assert.equal(compacted.live_tab.sessionBaseline, undefined);
    assert.equal(compacted.live_tab.ticket, "PROJ-1");
    assert.equal(compacted.recent_closed.sessionBaseline, undefined);
  });

  test("buildVariableRowLayout and computeVariableWindowSlice virtualize variable-height diff rows accurately", () => {
    const layout = buildVariableRowLayout([22, 20, 40, 20, 61, 20, 20, 20]);
    assert.deepEqual(layout.offsets, [0, 22, 42, 82, 102, 163, 183, 203]);
    assert.equal(layout.totalHeight, 223);

    const topSlice = computeVariableWindowSlice(layout, 0, 80, 1);
    assert.equal(topSlice.start, 0);
    assert.equal(topSlice.end, 4);
    assert.equal(topSlice.scrollPx, 0);
    assert.equal(topSlice.maxScrollPx, 143);
    assert.equal(topSlice.topOffsetPx, 0);

    // Mid-row pixel scroll should keep exact negative topOffsetPx for smooth scrolling
    const midSlice = computeVariableWindowSlice(layout, 50, 80, 1);
    assert.equal(midSlice.start, 1);
    assert.equal(midSlice.end, 6);
    assert.equal(midSlice.topOffsetPx, 22 - 50);

    // Overscrolling clamps cleanly to maxScrollPx
    const endSlice = computeVariableWindowSlice(layout, 9999, 80, 0);
    assert.equal(endSlice.scrollPx, 143);
    assert.equal(endSlice.start, 4);
    assert.equal(endSlice.end, 8);
    assert.equal(endSlice.topOffsetPx, 102 - 143);

    // Empty layout stays safe
    const empty = computeVariableWindowSlice(buildVariableRowLayout([]), 100, 400, 2);
    assert.equal(empty.start, 0);
    assert.equal(empty.end, 0);
    assert.equal(empty.topOffsetPx, 0);
  });

  test("computeDiffScrollOffsetForRow supports top, center, and nearest visibility clamping", () => {
    const layout = buildVariableRowLayout(Array.from({ length: 30 }, () => 20)); // total 600px
    assert.equal(computeDiffScrollOffsetForRow(layout, 10, 200, "top"), 200);
    assert.equal(computeDiffScrollOffsetForRow(layout, 10, 200, "center"), 130);
    assert.equal(computeDiffScrollOffsetForRow(layout, 29, 200, "top"), 400);

    // Already visible row stays put under "nearest"
    assert.equal(computeDiffScrollOffsetForRow(layout, 12, 200, "nearest", 200), 200);
    // Row below viewport scrolls just enough to reveal bottom edge
    assert.equal(computeDiffScrollOffsetForRow(layout, 15, 200, "nearest", 100), 120);
    // Row above viewport scrolls up to row top
    assert.equal(computeDiffScrollOffsetForRow(layout, 2, 200, "nearest", 200), 40);
  });

  test("computeDiffScrollbarMetrics, resolveDiffWheelDeltaPx, and resolveDiffScrollbarDragPx behave deterministically", () => {
    const hidden = computeDiffScrollbarMetrics(200, 0, 400, 392);
    assert.equal(hidden.visible, false);
    assert.equal(hidden.maxScrollPx, 0);

    const shown = computeDiffScrollbarMetrics(1000, 300, 400, 400);
    assert.equal(shown.visible, true);
    assert.equal(shown.maxScrollPx, 600);
    assert.equal(shown.thumbHeight, 160);
    assert.equal(shown.thumbTop, 120);

    // Drag back from thumbTop=120 recovers scrollPx=300
    assert.equal(resolveDiffScrollbarDragPx(120, 400, 160, 600), 300);
    assert.equal(resolveDiffScrollbarDragPx(-50, 400, 160, 600), 0);
    assert.equal(resolveDiffScrollbarDragPx(999, 400, 160, 600), 600);

    // GPUI scroll convention: positive delta scrolls UP (negative scrollPx delta)
    assert.equal(resolveDiffWheelDeltaPx(0, 1, 20), -60);
    assert.equal(resolveDiffWheelDeltaPx(0, -1, 20), 60);
    assert.equal(resolveDiffWheelDeltaPx(24, 0, 20), -24);
    assert.equal(resolveDiffWheelDeltaPx(-24, 0, 20), 24);
    assert.equal(resolveDiffWheelDeltaPx(0, 0, 20), 0);
  });

  test("annotateDiffGaps identifies independent top, between, and bottom gaps while skipping line-1 hunks and truncation banners", () => {
    const rawDiff = [
      "@@ -40,3 +40,4 @@ function first() {",
      " line40",
      "-old41",
      "+new41",
      "+new42",
      " line43",
      "@@ -120,2 +121,3 @@ function second() {",
      " line121",
      "+added122",
      " line123",
    ];
    const annotated = annotateDiffGaps(diffRows(rawDiff, "src/app.js"), { canExpandBottom: true });
    assert.deepEqual(annotated[0].gap, { id: "gap-top", position: "top", startLine: 1, endLine: 39, oldDelta: 0 });
    assert.deepEqual(annotated[6].gap, { id: "gap-between-1", position: "between", startLine: 44, endLine: 120, oldDelta: -1 });
    assert.deepEqual(annotated[annotated.length - 1].gap, {
      id: "gap-bottom",
      position: "bottom",
      startLine: 124,
      endLine: null,
      oldDelta: -2,
    });

    // Hunk starting at line 1 should NOT show a top expand gap, and truncation banner must not produce a gap
    const topZeroDiff = [
      "@@ -1,2 +1,2 @@",
      " line1",
      "+line2",
      "@@ -0,0 +0,0 @@ [Diff preview truncated: showing first 500 lines. 10 more lines hidden.]",
    ];
    const topZeroAnnotated = annotateDiffGaps(diffRows(topZeroDiff, "src/app.js"), { canExpandBottom: true });
    assert.equal(topZeroAnnotated[0].gap, null);
    assert.equal(topZeroAnnotated[3].gap, null);
    assert.equal(topZeroAnnotated.length, 4, "truncated diff must not append a trailing bottom gap");

    // syncBottomGapWithTotalLines resolves endLine or prunes bottom gap at EOF
    const synced = syncBottomGapWithTotalLines(annotated, 150);
    assert.equal(synced[synced.length - 1].gap.endLine, 150);
    const atEof = syncBottomGapWithTotalLines(annotated, 123);
    assert.equal(atEof.length, annotated.length - 1);
  });

  test("expandDiffGapInRows expands ONLY the targeted block (up/down/all) and computeAnchorPreservedScrollPx keeps visual position intact", () => {
    const sourceLines = Array.from({ length: 160 }, (_, idx) => `const v${idx + 1} = ${idx + 1};`);
    const rawDiff = [
      "@@ -40,2 +40,3 @@ function first() {",
      " const v40 = 40;",
      "+const v41 = 41;",
      " const v42 = 42;",
      "@@ -120,6 +121,7 @@ function second() {",
      " const v121 = 121;",
      "+const v122 = 122;",
      " const v123 = 123;",
      " const v124 = 124;",
      " const v125 = 125;",
      " const v126 = 126;",
      " const v127 = 127;",
    ];
    const initialRows = annotateDiffGaps(diffRows(rawDiff, "src/app.js"), {
      canExpandBottom: true,
      totalFileLines: sourceLines.length,
    });
    const hunk2AnchorRowRef = initialRows[5]; // " const v121 = 121;"
    const topGapRowRef = initialRows[0];
    const bottomGapRowRef = initialRows[initialRows.length - 1];

    // 1. Expand ONLY between-hunk gap UPWARD by 20 lines (rows[4] is gap-between-1: lines 43..120)
    const oldLayout = buildVariableRowLayout(initialRows.map((r) => (r.kind === "@" ? 26 : 20)));
    const vpH = 140;
    const oldScrollPx = 40;
    const oldAnchorScreenY = oldLayout.offsets[5] - oldScrollPx; // screen Y of line 121 before expansion

    const upRes = expandDiffGapInRows(initialRows, 4, "up", sourceLines, {
      step: DEFAULT_CONTEXT_EXPAND_STEP,
      filePath: "src/app.js",
    });
    assert.equal(upRes.changed, true);
    assert.equal(upRes.insertedCount, 20);
    assert.equal(upRes.removedGap, false);
    // Sibling top and bottom gaps MUST remain untouched
    assert.equal(upRes.rows[0], topGapRowRef);
    assert.equal(upRes.rows[upRes.rows.length - 1], bottomGapRowRef);
    assert.deepEqual(upRes.rows[4].gap, { id: "gap-between-1", position: "between", startLine: 43, endLine: 100, oldDelta: -1 });
    assert.equal(upRes.rows[5].number, 101);
    assert.equal(upRes.rows[24].number, 120);
    assert.equal(upRes.rows[upRes.newAnchorIndex], hunk2AnchorRowRef);

    // Visual anchor pixel for line 121 MUST remain identical (zero downward jump!)
    const newLayout = buildVariableRowLayout(upRes.rows.map((r) => (r.kind === "@" ? 26 : 20)));
    const nextScrollPx = computeAnchorPreservedScrollPx(
      oldLayout,
      newLayout,
      oldScrollPx,
      upRes.oldAnchorIndex,
      upRes.newAnchorIndex,
      vpH,
    );
    assert.equal(newLayout.offsets[upRes.newAnchorIndex] - nextScrollPx, oldAnchorScreenY);

    // 2. Expand same between-hunk gap DOWNWARD by 20 lines: code ABOVE gap stays pinned (scrollPx unchanged!)
    const hunk1LastRowRef = upRes.rows[3]; // line 42
    const downRes = expandDiffGapInRows(upRes.rows, 4, "down", sourceLines, {
      step: DEFAULT_CONTEXT_EXPAND_STEP,
      filePath: "src/app.js",
    });
    assert.equal(downRes.insertedCount, 20);
    assert.equal(downRes.rows[3], hunk1LastRowRef);
    assert.equal(downRes.rows[4].number, 43);
    assert.equal(downRes.rows[23].number, 62);
    assert.deepEqual(downRes.rows[24].gap, { id: "gap-between-1", position: "between", startLine: 63, endLine: 100, oldDelta: -1 });
    assert.equal(downRes.oldAnchorIndex, 3);
    assert.equal(downRes.newAnchorIndex, 3);
    const downLayout = buildVariableRowLayout(downRes.rows.map((r) => (r.kind === "@" ? 26 : 20)));
    const downScrollPx = computeAnchorPreservedScrollPx(
      newLayout,
      downLayout,
      nextScrollPx,
      downRes.oldAnchorIndex,
      downRes.newAnchorIndex,
      vpH,
    );
    assert.equal(downScrollPx, nextScrollPx);

    // 3. Expand remaining between-hunk gap ("all") closes ONLY that gap bar seamlessly
    const closeRes = expandDiffGapInRows(downRes.rows, 24, "all", sourceLines, {
      step: DEFAULT_CONTEXT_EXPAND_STEP,
      filePath: "src/app.js",
      anchorPreference: "below",
    });
    assert.equal(closeRes.removedGap, true);
    assert.equal(closeRes.insertedCount, 38); // lines 63..100
    assert.equal(closeRes.rows.some((r) => r?.gap?.id === "gap-between-1"), false);
    // Top gap and bottom gap STILL collapsed and untouched!
    assert.deepEqual(closeRes.rows[0].gap, { id: "gap-top", position: "top", startLine: 1, endLine: 39, oldDelta: 0 });
    assert.deepEqual(closeRes.rows[closeRes.rows.length - 1].gap, { id: "gap-bottom", position: "bottom", startLine: 128, endLine: 160, oldDelta: -2 });
  });

  test("splitSourceFileLines strips CRLF, drops single trailing LF, rejects binary NUL, and bounds huge input", () => {
    assert.deepEqual(splitSourceFileLines("a\r\nb\r\nc\r\n"), ["a", "b", "c"]);
    assert.equal(splitSourceFileLines("abc\0def"), null);
    assert.equal(splitSourceFileLines("hello\nworld\n", 5).join("\n"), "hello");
  });

  test("formatReviewAgentMessage formats unified session notes with baseRef, removed-line side marker, and no trailing newline", () => {
    const msg = formatReviewAgentMessage(
      [
        {
          serviceId: "ms-card",
          serviceName: "ms-card",
          repoRoot: "C:\\Dev\\ms-card",
          baseRef: "origin/main",
          displayPath: "src/CardLimit.java",
          line: 22,
          side: "new",
          text: "Add unique index\r\nand verify rollback",
          snippet: "@Entity\npublic class CardLimit",
        },
        {
          serviceId: "ms-card",
          serviceName: "ms-card",
          repoRoot: "C:\\Dev\\ms-card",
          baseRef: "origin/main",
          displayPath: "src/CardLimit.java",
          line: 22,
          side: "old",
          text: "Why remove this constraint?",
          snippet: "@Column(unique = true)",
        },
      ],
    );
    assert.ok(msg.startsWith("Review comments on session changes:\n\n### Service: ms-card (C:\\Dev\\ms-card) [vs origin/main]"));
    assert.ok(msg.includes("- `src/CardLimit.java:22`:\n  Add unique index\n  and verify rollback\n  > @Entity public class CardLimit"));
    assert.ok(msg.includes("- `src/CardLimit.java:22` (removed line):\n  Why remove this constraint?\n  > @Column(unique = true)"));
    assert.equal(msg.endsWith("\n"), false, "message must not end with trailing blank newline");
    assert.equal(msg.includes("\r"), false, "message must normalize CRLF to LF");
  });

  test("parseHcJsonOutput, formatHcErrorMessage, and resolveAgentSubmitKey handle hc JSON responses cleanly", () => {
    assert.deepEqual(parseHcJsonOutput('{"turn":4,"status":"done","started":false}\n'), {
      turn: 4,
      status: "done",
      started: false,
    });
    assert.equal(
      formatHcErrorMessage({ code: 9, stderr: '{"error":{"kind":"blocked","message":"terminal is blocked"}}' }),
      "Agent is blocked waiting for input. Respond to its prompt first.",
    );
    assert.equal(
      formatHcErrorMessage({ code: 1, stderr: '{"error":{"kind":"unavailable","message":"offline","hint":"retry"}}' }),
      "offline (retry)",
    );
    assert.equal(resolveAgentSubmitKey({ submit: "ctrl+enter" }), "ctrl+enter");
    assert.equal(resolveAgentSubmitKey({ submit: null }), "enter");
  });

  test("decideSendSubmitAction nudges stuck multiline pastes safely and never submits on working/blocked/advanced turns", () => {
    const message = "Review comments on uncommitted changes:\n\n### Service: ms-card (/ws)\n- `A.java:10`:\n  Fix race";
    const preScreen = "Done.\n\n❯ ";
    const stuckChipScreen = "Done.\n\n❯ [Pasted text #1 +34 lines]\n";
    const stuckTextScreen = "Done.\n\n❯ Review comments on uncommitted changes:\n  Fix race";
    const blockedScreen = "Allow once\nDo you want to proceed? (y/n)";

    // 1. Agent already started working -> never nudge
    assert.equal(
      decideSendSubmitAction({
        sendResult: { turn: 5, status: "done", started: true },
        liveTerminal: { state: "live", status: "working", turn: 5 },
        preScreen,
        postScreen: stuckChipScreen,
        message,
      }).shouldNudge,
      false,
    );

    // 2. hc reported started: false and terminal is still idle/done at same turn -> nudge with submit key
    const nudge1 = decideSendSubmitAction({
      sendResult: { turn: 5, status: "done", started: false },
      liveTerminal: { state: "live", status: "done", turn: 5, submit: "enter" },
      preScreen,
      postScreen: stuckChipScreen,
      message,
    });
    assert.equal(nudge1.shouldNudge, true);
    assert.equal(nudge1.submitKey, "enter");

    // 3. Turn already advanced (fast completion) -> never double-submit
    assert.equal(
      decideSendSubmitAction({
        sendResult: { turn: 5, status: "done", started: false },
        liveTerminal: { state: "live", status: "done", turn: 6 },
        preScreen,
        postScreen: preScreen,
        message,
      }).shouldNudge,
      false,
    );

    // 4. Blocked status or permission dialog on screen -> NEVER press Enter
    assert.equal(screenLooksBlockedOrPrompting(blockedScreen), true);
    assert.equal(
      decideSendSubmitAction({
        sendResult: { turn: 5, status: "done", started: false },
        liveTerminal: { state: "live", status: "blocked", turn: 5 },
        preScreen,
        postScreen: stuckChipScreen,
        message,
      }).shouldNudge,
      false,
    );
    assert.equal(
      decideSendSubmitAction({
        sendResult: { turn: 5, status: "done", started: false },
        liveTerminal: { state: "live", status: "idle", turn: 5 },
        preScreen,
        postScreen: blockedScreen,
        message,
      }).shouldNudge,
      false,
    );

    // 5. Non-7501 agent (started: null) -> nudges ONLY when screen positively shows fresh unsubmitted paste
    assert.equal(detectUnsubmittedReviewInScreen(preScreen, stuckChipScreen, message), true);
    assert.equal(detectUnsubmittedReviewInScreen(preScreen, stuckTextScreen, message), true);
    assert.equal(detectUnsubmittedReviewInScreen(preScreen, preScreen, message), false);
    assert.equal(
      decideSendSubmitAction({
        sendResult: { turn: 0, status: null, started: null },
        liveTerminal: { state: "live", status: null, turn: 0 },
        preScreen,
        postScreen: stuckChipScreen,
        message,
      }).shouldNudge,
      true,
    );
    assert.equal(
      decideSendSubmitAction({
        sendResult: { turn: 0, status: null, started: null },
        liveTerminal: { state: "live", status: null, turn: 0 },
        preScreen,
        postScreen: "Agent replying now...\nWorking on CardLimit...",
        message,
      }).shouldNudge,
      false,
    );
  });

  test("regression: computeReviewCommentWrapCols scales to full review width without legacy 56-column cap", () => {
    // Wide Review tab (~1208px viewport -> ~153 code wrap cols) must not cap comments at 56 cols
    assert.equal(computeReviewCommentWrapCols(153), 147);
    assert.equal(computeReviewCommentWrapCols(111), 105);
    // Narrow split pane reserves chrome cleanly without overflowing
    assert.equal(computeReviewCommentWrapCols(33), 27);
    // Ultra-narrow viewport clamps safely to 12 columns
    assert.equal(computeReviewCommentWrapCols(14), 12);
    assert.equal(computeReviewCommentWrapCols(6), 12);
    // Missing/invalid wrapCols falls back cleanly to 74 columns (80 - 6)
    assert.equal(computeReviewCommentWrapCols(undefined), 74);
    assert.equal(computeReviewCommentWrapCols(0), 74);
    assert.equal(computeReviewCommentWrapCols(NaN), 74);
  });

  test("regression: review comment composer and saved inline comments span full width without fixed max_w cutoff", () => {
    const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const mainSource = readFileSync(join(repoRoot, "mods/changes-review/main.js"), "utf8");

    const composerStart = mainSource.indexOf("renderCommentComposer(");
    const composerEnd = mainSource.indexOf("render(cx)", composerStart);
    assert.ok(composerStart > 0 && composerEnd > composerStart, "renderCommentComposer method must exist");
    const composerSrc = mainSource.slice(composerStart, composerEnd);

    // Must not artificially cut the composer to half-width with a fixed max_w(...) cap
    assert.equal(/\.max_w\(/.test(composerSrc), false, "renderCommentComposer must not constrain width via max_w(...)");
    assert.ok(composerSrc.includes('v_flex().id("review-comment-composer").w_full().min_w(0).flex_none()'));
    assert.ok(composerSrc.includes("Textarea.new(this.commentInput).w_full().min_w(0).h(62)"));
    assert.ok(composerSrc.includes('id("inline-cancel-btn")') && composerSrc.includes('id("inline-save-btn")'));
    assert.ok(composerSrc.includes("div().flex_1().min_w(0).truncate().text_size(10.5)"), "shortcut hint must truncate on narrow panes");
    assert.ok(composerSrc.includes("h_flex().flex_none().gap(6).items_center()"), "action buttons must remain flex_none()");

    // Inline saved comments in diffRow must also span full width without legacy max_w(460)
    const commentLinesStart = mainSource.indexOf("const commentLines = this.getWrappedCommentLines(");
    assert.ok(commentLinesStart > 0 && composerStart > commentLinesStart);
    const inlineSavedCommentSrc = mainSource.slice(commentLinesStart, composerStart);
    assert.equal(/\.max_w\(/.test(inlineSavedCommentSrc), false, "saved inline comment row must not constrain width via max_w(...)");
    assert.ok(mainSource.includes("computeReviewCommentWrapCols(wrapCols)"), "getWrappedCommentLines must use computeReviewCommentWrapCols");
  });

  test("regression: expandDiffGapInRows preserves Markdown fenced code state inside expanded gaps", () => {
    const sourceLines = [
      "# Guide",
      "```js",
      "const inside = 42;",
      "const alsoInside = true;",
      "```",
      "Trailing prose with and or is.",
    ];
    const rows = annotateDiffGaps(
      diffRows(["@@ -6,1 +6,1 @@", "+Trailing prose with and or is."], "docs/guide.md"),
      { canExpandBottom: false },
    );
    // Gap at index 0 covers lines 1..5; expanding lines 3..5 upward starts inside open ```js fence at line 2!
    const expanded = expandDiffGapInRows(rows, 0, "up", sourceLines, {
      step: 3,
      filePath: "docs/guide.md",
    });
    const line3 = expanded.rows.find((r) => r.number === 3);
    assert.ok(line3 && Array.isArray(line3.tokens));
    assert.ok(line3.tokens.some(([k, v]) => k === "keyword" && v === "const"), "line 3 inside ```js fence must receive JS syntax tokens");
    assert.ok(line3.tokens.some(([k, v]) => k === "number" && v === "42"));
  });

  test("regression: changes-review/main.js removes commit dropdown & repo selector bars, short-circuits hidden panel, and avoids git add -A", () => {
    const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const mainSource = readFileSync(join(repoRoot, "mods/changes-review/main.js"), "utf8");

    assert.equal(mainSource.includes("commit-selector-btn"), false, "commit selector button must be removed");
    assert.equal(mainSource.includes("commit-dropdown-floating"), false, "commit dropdown overlay must be removed");
    assert.equal(mainSource.includes("service-filter-bar"), false, "service filter pill bar must be removed");
    assert.equal(mainSource.includes("microservice-review-bar"), false, "sole repo bar must be removed");
    assert.equal(mainSource.includes("cognivisor.activeService"), false, "changes-review must not filter by activeService");
    assert.equal(mainSource.includes("./dropdown.js"), false, "changes-review must not import dropdown.js");
    assert.equal(mainSource.includes('["add", "-A"]'), false, "commit drawer must not run git add -A");
    assert.ok(mainSource.includes('["add", "--", ...slice]'), "commit drawer must stage only explicit visible dirty paths");
    assert.ok(mainSource.includes('if (!visible) {\n      return div().id("changes");\n    }'), "renderPanel must short-circuit when hidden");
    assert.ok(mainSource.includes("this.pendingRefresh = true"), "refresh must queue pending watch events during loading");
    assert.ok(mainSource.includes("this.pendingRefreshForce = true"), "refresh must preserve force flag on queued refreshes");
    assert.ok(mainSource.includes("reads.map(extractHcReadText)"), "hc read transcripts must extract ExecResult stdout cleanly");
    assert.ok(mainSource.includes("selectPathsToStageForCommit"), "commit drawer must omit already-staged git rm deletions from git add");
    assert.ok(mainSource.includes("sessionBaseline.rev = Math.max("), "baseline mutations must bump rev so files-search cache invalidates");
  });

  test("regression: extractHcReadText handles ExecResult objects, strings, and errors without [object Object]", () => {
    assert.equal(extractHcReadText({ code: 0, stdout: "edited apps/billing/a.ts\n", stderr: "" }), "edited apps/billing/a.ts\n");
    assert.equal(extractHcReadText({ code: 1, stdout: "ignored", stderr: "err" }), "");
    assert.equal(extractHcReadText("raw transcript"), "raw transcript");
    assert.equal(extractHcReadText(null), "");
    assert.equal(extractHcReadText(undefined), "");
  });

  test("regression: selectPathsToStageForCommit omits already-staged git rm deletions (xy === 'D ') while keeping unstaged deletes and edits", () => {
    const workingFiles = [
      { path: "gone-staged.ts", xy: "D ", stagedDeletion: true, status: "D" },
      { path: "gone-unstaged.ts", xy: " D", stagedDeletion: false, status: "D" },
      { path: "edited.ts", xy: " M", stagedDeletion: false, status: "M" },
      { path: "added.ts", xy: "??", stagedDeletion: false, status: "A" },
      { path: "staged-mod.ts", xy: "M ", stagedDeletion: false, status: "M" },
      { path: "edited.ts", xy: " M", stagedDeletion: false, status: "M" }, // duplicate
    ];
    assert.deepEqual(selectPathsToStageForCommit(workingFiles), [
      "gone-unstaged.ts",
      "edited.ts",
      "added.ts",
      "staged-mod.ts",
    ]);
    // Repo with ONLY a git-rm staged deletion still has dirtyPaths.length === 1, but stagePaths === []
    assert.deepEqual(selectPathsToStageForCommit([{ path: "only-rm.ts", xy: "D ", stagedDeletion: true }]), []);
  });

  test("regression: resolveRepoBaseRefWithExec anchors directly on origin/development before origin/HEAD (origin/main)", async () => {
    const devHead = "dddd2222";
    const startHead = "dddd1111";
    const mainHead = "mmmm0000";
    const fakeExec = async (_cmd, args) => {
      if (args.includes("symbolic-ref")) return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      if (args.includes("for-each-ref")) return { code: 0, stdout: "origin/development\norigin/main\ndevelopment\nmain\n", stderr: "" };
      if (args.includes("merge-base") && args.includes("origin/development")) return { code: 0, stdout: `${devHead}\n`, stderr: "" };
      if (args.includes("merge-base") && args.includes("origin/main")) return { code: 0, stdout: `${mainHead}\n`, stderr: "" };
      if (args.includes("--is-ancestor") && args.includes(startHead)) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };

    // Synced with origin/development and no startHead -> must anchor at origin/development (HEAD), NOT origin/main!
    const synced = await resolveRepoBaseRefWithExec("/repo", "development", devHead, null, fakeExec);
    assert.equal(synced.baseRef, "origin/development");
    assert.equal(synced.baseHash, devHead);

    // Pushed commit on development (startHead != devHead) -> falls back to session startHead, NOT origin/main!
    const pushed = await resolveRepoBaseRefWithExec("/repo", "development", devHead, null, fakeExec, { startHead });
    assert.equal(pushed.baseRef, "session start");
    assert.equal(pushed.baseHash, startHead);
    assert.equal(pushed.baseSource, "session");

    // Local-only repo on main with a stale local development branch must anchor to main, not development
    const localOnlyExec = async (_cmd, args) => {
      if (args.includes("symbolic-ref")) return { code: 1, stdout: "", stderr: "" };
      if (args.includes("for-each-ref")) return { code: 0, stdout: "development\nmain\n", stderr: "" };
      if (args.includes("merge-base") && args.includes("main")) return { code: 0, stdout: `${devHead}\n`, stderr: "" };
      if (args.includes("merge-base") && args.includes("development")) return { code: 0, stdout: `${mainHead}\n`, stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const localMain = await resolveRepoBaseRefWithExec("/repo", "main", devHead, null, localOnlyExec);
    assert.equal(localMain.baseRef, "main");
    assert.equal(localMain.baseHash, devHead);
  });

  test("regression: collectServiceSessionSnapshot queries committedPaths on first unbaselined refresh, marks xy==='D ', and handles delete-commit-recreate untracked files", async () => {
    const fakeExec = async (_cmd, args) => {
      if (args.includes("status")) {
        return {
          code: 0,
          stdout: "## feat/overlap\x00 M both.ts\x00D  gone.ts\x00?? rec.ts\x00?? brand-new.ts\x00",
          stderr: "",
        };
      }
      if (args.includes("rev-parse")) return { code: 0, stdout: "head2222\n", stderr: "" };
      if (args.includes("symbolic-ref")) return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      if (args.includes("for-each-ref")) return { code: 0, stdout: "origin/main\n", stderr: "" };
      if (args.includes("merge-base")) return { code: 0, stdout: "base1111\n", stderr: "" };
      if (args.includes("--name-status")) {
        return { code: 0, stdout: "M\x00both.ts\x00D\x00gone.ts\x00M\x00rec.ts\x00", stderr: "" };
      }
      if (args.includes("--numstat")) {
        return { code: 0, stdout: "4\t1\tboth.ts\x000\t7\tgone.ts\x002\t5\trec.ts\x00", stderr: "" };
      }
      if (args.includes("--name-only")) {
        return { code: 0, stdout: "both.ts\x00rec.ts\x00", stderr: "" };
      }
      if (args.includes("rev-list")) return { code: 0, stdout: "1\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const fakeFs = {
      stat: async (p) => {
        if (String(p).endsWith("gone.ts")) throw new Error("ENOENT");
        return { size: 42, mtimeMs: 1_700_000_000_000 };
      },
      readFile: async (p) => Buffer.from(String(p).endsWith("brand-new.ts") ? "l1\nl2\n" : "new1\nnew2\n"),
    };

    const snap = await collectServiceSessionSnapshot(
      { id: "svc", name: "svc", root: "/ws/svc", relPath: "", isSibling: false },
      null,
      { baselineRepo: null },
      { exec: fakeExec, fsPromises: fakeFs },
    );

    // 1) Even with baselineRepo === null, committedPaths was fetched so overlapping committed+dirty `both.ts` stays visible!
    assert.equal(snap.committedPaths.has("both.ts"), true);
    const baseline = buildFreshSessionBaseline([snap], { workspaceRoot: "/ws/svc", startedAt: 1_700_000_100_000, anchored: false });
    const part = partitionSessionUnifiedEntries(snap.files, baseline.repos["/ws/svc"], snap.committedPaths, 1_700_000_100_000);
    assert.equal(part.visible.some((f) => f.path === "both.ts"), true, "committed file with pre-existing dirty edit must remain visible on first refresh");
    assert.equal(part.hidden.some((f) => f.path === "brand-new.ts"), true, "pre-existing untracked file outside base..HEAD stays hidden");

    // 2) `gone.ts` carries xy === "D " and stagedDeletion === true so commit omits it from `git add --`
    const goneWorking = snap.workingFiles.find((w) => w.path === "gone.ts");
    assert.equal(goneWorking?.xy, "D ");
    assert.equal(goneWorking?.stagedDeletion, true);
    assert.equal(selectPathsToStageForCommit(snap.workingFiles).includes("gone.ts"), false);

    // 3) `rec.ts` existed at baseHash, deleted in HEAD, recreated untracked -> uses git diff <baseHash> stats (add:2, del:5), fresh: false!
    const recUnified = snap.files.find((f) => f.path === "rec.ts");
    assert.equal(recUnified?.fresh, false);
    assert.equal(recUnified?.status, "M");
    assert.equal(recUnified?.add, 2);
    assert.equal(recUnified?.del, 5);
    const brandNewUnified = snap.files.find((f) => f.path === "brand-new.ts");
    assert.equal(brandNewUnified?.fresh, true);
    assert.equal(brandNewUnified?.add, 2);
  });
});
