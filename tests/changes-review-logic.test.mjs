import { test, describe } from "node:test";
import assert from "node:assert/strict";
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
  computeFileReviewFingerprint,
  parseReviewedFileRecord,
  reconcileReviewedFiles,
  filterSessionCommits,
  filterSessionWorkingEntries,
  partitionSessionWorkingEntries,
  normalizeGitStatusMark,
  statFileEntry,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  resolveSessionStartTime,
  buildFreshSessionBaseline,
  createResetSessionBaseline,
  findRecentFlowWorkspaceBaseline,
  findRecentWorkspaceBaseline,
  countBaselineDirtyFiles,
  compactFlowsMap,
  extractResumeKeyFromTranscript,
  filterUnbaselinedRepoEntries,
  isHomeDirectoryRoot,
  resolveWorkspaceRoot,
  READ_GIT_FLAGS,
  parseCommitLogOutput,
  mergeBusCandidateServices,
  collectServiceWorkingSnapshot,
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

  test("filterSessionCommits excludes pre-session commits and keeps session commits", () => {
    const startedAtMs = 1700000100500; // floor(/1000) === 1700000100
    const commits = [
      { hash: "c3", timestamp: 1700000200, subject: "after" },
      { hash: "c2", timestamp: 1700000100, subject: "exact boundary" },
      { hash: "c1", timestamp: 1700000099, subject: "before" },
      { hash: "c0", timestamp: 0, subject: "missing ts" },
    ];

    assert.deepEqual(
      filterSessionCommits(commits, startedAtMs).map((c) => c.hash),
      ["c3", "c2"],
    );

    // When sessionStartedAt is falsy, returns commits unchanged
    assert.equal(filterSessionCommits(commits, 0).length, 4);
    assert.equal(filterSessionCommits(commits, null).length, 4);
    assert.deepEqual(filterSessionCommits(null, startedAtMs), []);
  });

  test("filterSessionWorkingEntries excludes unchanged baseline files, includes re-edited files, and handles missing baselineRepo", () => {
    const startedAt = 1700000100000;
    const baselineRepo = {
      dirtyFiles: {
        "src/unchanged.js": { status: "M", sig: "120:1700000050000" },
        "src/re-edited.js": { status: "M", sig: "200:1700000050000" },
        "src/status-changed.js": { status: "A", sig: "50:1700000050000" },
      },
    };

    const entries = [
      { relFile: "src/unchanged.js", status: "M", sig: "120:1700000050000", mtimeMs: 1700000050000 },
      { relFile: "src/re-edited.js", status: "M", sig: "245:1700000200000", mtimeMs: 1700000200000 },
      { relFile: "src/status-changed.js", status: "M", sig: "50:1700000050000", mtimeMs: 1700000050000 },
      { relFile: "src/new-session.js", status: "A", sig: "99:1700000150000", mtimeMs: 1700000150000 },
    ];

    assert.deepEqual(
      filterSessionWorkingEntries(entries, baselineRepo, startedAt).map((e) => e.relFile),
      ["src/re-edited.js", "src/status-changed.js", "src/new-session.js"],
    );

    // When baselineRepo is missing and sessionStartedAt > 0, filter by mtimeMs >= sessionStartedAt (or !mtimeMs fallback)
    const fallbackEntries = [
      { relFile: "old.js", status: "M", sig: "10:1700000000000", mtimeMs: 1700000000000 },
      { relFile: "fresh.js", status: "M", sig: "10:1700000100000", mtimeMs: 1700000100000 },
      { relFile: "remote-no-stat.js", status: "M", sig: "", mtimeMs: 0 },
    ];
    assert.deepEqual(
      filterSessionWorkingEntries(fallbackEntries, null, startedAt).map((e) => e.relFile),
      ["fresh.js", "remote-no-stat.js"],
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
      assert.deepEqual(crMissing, fsMissing);
      assert.equal(crMissing.sig, "deleted");

      // 3. SSH remote mode
      assert.deepEqual(
        await statFileEntry(textFile, "M", "dev@host"),
        await filesSearchStatFileEntry(textFile, "M", "dev@host"),
      );

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

  test("filterUnbaselinedRepoEntries blocks un-attributed mtimeMs=0 sibling leaks and backfills baseline", () => {
    const entries = [
      { relFile: "manifest.json", status: "M", sig: "100:b1234567", mtimeMs: 0 },
      { relFile: ".agent/SKILL.md", status: "A", sig: "200:babcdef0", mtimeMs: 0 },
    ];

    // Un-attributed sibling repo (e.g. mypass/scaffold) with mtimeMs=0 -> 0 session changes, backfilled
    const unattr = filterUnbaselinedRepoEntries(entries, 1700000000000, { isAttributed: false, hasSessionCommits: false });
    assert.equal(unattr.sessionFiles.length, 0);
    assert.deepEqual(Object.keys(unattr.backfillDirtyFiles).sort(), [".agent/SKILL.md", "manifest.json"]);

    // Attributed repo (active-tab pane cwd / transcript / sessionRepos) -> surfaces entries
    const attr = filterUnbaselinedRepoEntries(entries, 1700000000000, { isAttributed: true, hasSessionCommits: false });
    assert.equal(attr.sessionFiles.length, 2);
  });

  test("extractResumeKeyFromTranscript and readDiskSessionBaseline prevent false /resume & cross-workspace collisions", async () => {
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
        startedAt: 1700000000000,
        workspaceRoot: ws,
        repos: {
          "/home/nmr/Projects/mypass": { dirtyFiles: { "manifest.json": { status: "M", sig: "10:b01020304" } } },
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

  test("parseCommitLogOutput and mergeBusCandidateServices retain clean pushed repos and enrich metadata", () => {
    const svc = { id: ".", name: "herdr-cognivisor", root: "/ws/herdr-cognivisor" };
    const logOut = [
      "845bbd4\tfeat(git-history): wave transitions\tJohnMunozR\t2 minutes ago\t845bbd44c7b586209dacee3c495946a6116b3edf\t1794625047",
      "2283aba\tfix(files-search): session baseline\tJohnMunozR\t2 hours ago\t2283abaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t1794615446",
    ].join("\n");
    const commits = parseCommitLogOutput(logOut, svc);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0], {
      shortHash: "845bbd4",
      subject: "feat(git-history): wave transitions",
      author: "JohnMunozR",
      date: "2 minutes ago",
      hash: "845bbd44c7b586209dacee3c495946a6116b3edf",
      timestamp: 1794625047,
      serviceId: ".",
      serviceName: "herdr-cognivisor",
      repoRoot: "/ws/herdr-cognivisor",
    });
    assert.deepEqual(parseCommitLogOutput("", svc), []);

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
  });

  test("collectServiceWorkingSnapshot loads session commits even when working tree is clean and pushed", async () => {
    const calls = [];
    const sessionStartMs = 1794615367673;
    const mockExec = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes("status")) {
        return { code: 0, stdout: "## main...origin/main\0", stderr: "" };
      }
      if (args.includes("log")) {
        return {
          code: 0,
          stdout: [
            "845bbd4\tfeat(git-history): wave transitions\tJohnMunozR\t2 mins ago\t845bbd44c7b586209dacee3c495946a6116b3edf\t1794625047",
            "ba0ca0a\told commit\tJohnMunozR\t10 hours ago\tba0ca0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\t1794590000",
          ].join("\n"),
          stderr: "",
        };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    };

    const service = { id: ".", name: "herdr-cognivisor", relPath: "", root: "/ws/herdr-cognivisor", isSibling: false };
    const snap = await collectServiceWorkingSnapshot({ ...service }, null, true, { exec: mockExec });
    assert.equal(snap.rawCount, 0);
    assert.equal(snap.files.length, 0);
    assert.equal(snap.touched, true);
    assert.equal(snap.branch, "main");
    assert.equal(snap.headHash, "845bbd44c7b586209dacee3c495946a6116b3edf");
    assert.equal(snap.commits.length, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => READ_GIT_FLAGS.every((flag) => c.args.includes(flag))));
    const logCall = calls.find((c) => c.args.includes("log"));
    assert.deepEqual(logCall.args.slice(-2), ["main", "--"]);

    // Session filter retains only post-session commit alongside clean working tree
    const sessionCommits = filterSessionCommits(snap.commits, sessionStartMs);
    assert.deepEqual(sessionCommits.map((c) => c.shortHash), ["845bbd4"]);

    // Respects includeCommits = false for clean pushed repos without invoking git log
    const beforeCalls = calls.length;
    const noCommitSnap = await collectServiceWorkingSnapshot({ ...service }, null, false, { exec: mockExec });
    assert.equal(noCommitSnap.commits.length, 0);
    assert.equal(noCommitSnap.headHash, "");
    assert.equal(noCommitSnap.touched, false);
    assert.equal(calls.length, beforeCalls + 1);

    // Dirty repository attaches headHash from git rev-parse --verify HEAD
    const dirtyExec = async (cmd, args) => {
      if (args.includes("status")) {
        return { code: 0, stdout: "## feat/auth...origin/feat/auth\0 M src/a.js\0", stderr: "" };
      }
      if (args.includes("rev-parse")) {
        return { code: 0, stdout: "deadbeef1234567890abcdef1234567890abcdef\n", stderr: "" };
      }
      if (args.includes("diff")) {
        return { code: 0, stdout: "3\t1\tsrc/a.js\0", stderr: "" };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    };
    const dirtySnap = await collectServiceWorkingSnapshot(
      { id: "auth", name: "auth-api", relPath: "auth", root: "/ws/auth", isSibling: false },
      "dev@host",
      false,
      { exec: dirtyExec },
    );
    assert.equal(dirtySnap.headHash, "deadbeef1234567890abcdef1234567890abcdef");
    assert.equal(dirtySnap.files.length, 1);
    assert.equal(dirtySnap.files[0].add, 3);
    assert.equal(dirtySnap.files[0].del, 1);
  });

  test("computeFileReviewFingerprint and parseReviewedFileRecord capture file metadata accurately", () => {
    assert.equal(computeFileReviewFingerprint(null), "");
    assert.equal(computeFileReviewFingerprint(undefined), "");

    const base = {
      key: "auth::src/jwt.ts",
      status: "M",
      add: 12,
      del: 3,
      fresh: false,
      binary: false,
      sig: "420:1700000000123",
      mtimeMs: 1700000000123,
    };
    const baseFp = computeFileReviewFingerprint(base);
    assert.equal(baseFp, "M|12|3|0|0|420:1700000000123|1700000000123");

    assert.notEqual(computeFileReviewFingerprint({ ...base, status: "A" }), baseFp);
    assert.notEqual(computeFileReviewFingerprint({ ...base, add: 13 }), baseFp);
    assert.notEqual(computeFileReviewFingerprint({ ...base, del: 4 }), baseFp);
    assert.notEqual(computeFileReviewFingerprint({ ...base, fresh: true }), baseFp);
    assert.notEqual(computeFileReviewFingerprint({ ...base, binary: true }), baseFp);
    assert.notEqual(computeFileReviewFingerprint({ ...base, sig: "425:1700000000123" }), baseFp);
    assert.notEqual(computeFileReviewFingerprint({ ...base, mtimeMs: 1700000009999 }), baseFp);

    assert.deepEqual(parseReviewedFileRecord(true), { reviewed: true, fp: "", reviewedAt: 0 });
    assert.deepEqual(
      parseReviewedFileRecord({ reviewed: true, fp: baseFp, reviewedAt: 1700000001000 }),
      { reviewed: true, fp: baseFp, reviewedAt: 1700000001000 },
    );
    assert.equal(parseReviewedFileRecord(false), null);
    assert.equal(parseReviewedFileRecord(null), null);
    assert.equal(parseReviewedFileRecord({ reviewed: false, fp: baseFp }), null);
  });

  test("reconcileReviewedFiles retains unchanged checks and invalidates on edits, commits, and working-tree removal", () => {
    const fileA = {
      key: "auth::src/a.js",
      status: "M",
      add: 5,
      del: 2,
      fresh: false,
      binary: false,
      sig: "100:1700000100000",
      mtimeMs: 1700000100000,
    };
    const fileB = {
      key: "auth::src/b.js",
      status: "A",
      add: 0,
      del: 0,
      fresh: true,
      binary: false,
      sig: "200:1700000100000",
      mtimeMs: 1700000100000,
    };
    const fpA = computeFileReviewFingerprint(fileA);
    const fpB = computeFileReviewFingerprint(fileB);

    // 1. Retains unchanged working & commit checks
    const initial = {
      "working::auth::src/a.js": { reviewed: true, fp: fpA, reviewedAt: 1700000200000 },
      "working::auth::src/b.js": { reviewed: true, fp: fpB, reviewedAt: 1700000200000 },
      "commit:c1::auth::src/c.js": { reviewed: true, fp: "M|1|0|0|0||0", reviewedAt: 1700000200000 },
    };
    const unchangedRes = reconcileReviewedFiles(initial, { workingFiles: [fileA, fileB] });
    assert.equal(unchangedRes.changed, false);
    assert.deepEqual(unchangedRes.nextMap, initial);

    // 2. Drops legacy un-fingerprinted boolean entries so files modified before migration require re-review
    const legacyRes = reconcileReviewedFiles(
      { "working::auth::src/a.js": true, "commit:c1::auth::src/c.js": true },
      { workingFiles: [fileA] },
    );
    assert.equal(legacyRes.changed, true);
    assert.deepEqual(legacyRes.nextMap, {});

    // 3. Removes working check when agent edits file (sig/mtimeMs or add/del changes), keeps untouched fileB
    const editedA = { ...fileA, sig: "110:1700000300000", mtimeMs: 1700000300000 };
    const editedRes = reconcileReviewedFiles(initial, { workingFiles: [editedA, fileB] });
    assert.equal(editedRes.changed, true);
    assert.equal("working::auth::src/a.js" in editedRes.nextMap, false);
    assert.equal("working::auth::src/b.js" in editedRes.nextMap, true);

    const lineCountChangedB = { ...fileB, add: 10 };
    const lineCountRes = reconcileReviewedFiles(initial, { workingFiles: [fileA, lineCountChangedB] });
    assert.equal(lineCountRes.changed, true);
    assert.equal("working::auth::src/b.js" in lineCountRes.nextMap, false);
    assert.equal("working::auth::src/a.js" in lineCountRes.nextMap, true);

    // 4. Removes working check when file leaves working tree (committed externally in terminal)
    const committedOutRes = reconcileReviewedFiles(initial, { workingFiles: [fileB] });
    assert.equal(committedOutRes.changed, true);
    assert.equal("working::auth::src/a.js" in committedOutRes.nextMap, false);
    assert.equal("working::auth::src/b.js" in committedOutRes.nextMap, true);

    // Subsequent re-edit starts unreviewed because working::auth::src/a.js was cleared
    assert.equal("working::auth::src/a.js" in committedOutRes.nextMap, false);

    // 5. Removes working & commit checks when another commit touches the same file
    const byCommittedSet = reconcileReviewedFiles(initial, {
      workingFiles: [fileA, fileB],
      committedFileKeys: new Set(["auth::src/a.js", "auth::src/c.js"]),
    });
    assert.equal(byCommittedSet.changed, true);
    assert.equal("working::auth::src/a.js" in byCommittedSet.nextMap, false);
    assert.equal("commit:c1::auth::src/c.js" in byCommittedSet.nextMap, false);
    assert.equal("working::auth::src/b.js" in byCommittedSet.nextMap, true);

    const byNewerCommitTs = reconcileReviewedFiles(initial, {
      workingFiles: [fileA, fileB],
      committedAfterByKey: new Map([
        ["auth::src/c.js", 1700000250000], // newer than 1700000200000
        ["auth::src/d.js", 1700000100000], // older than review
      ]),
    });
    assert.equal(byNewerCommitTs.changed, true);
    assert.equal("commit:c1::auth::src/c.js" in byNewerCommitTs.nextMap, false);
    assert.equal("working::auth::src/a.js" in byNewerCommitTs.nextMap, true);

    // 6. Preserves checks for services in erroredServiceIds even when workingFiles omits them
    const erroredInitial = {
      "working::billing::src/pay.js": { reviewed: true, fp: "M|1|1|0|0|10:1|1", reviewedAt: 1700000200000 },
      "commit:c2::billing::src/pay.js": { reviewed: true, fp: "M|1|1|0|0||0", reviewedAt: 1700000200000 },
      "working::auth::src/a.js": { reviewed: true, fp: fpA, reviewedAt: 1700000200000 },
    };
    const erroredRes = reconcileReviewedFiles(erroredInitial, {
      workingFiles: [fileA],
      committedFileKeys: new Set(["billing::src/pay.js"]),
      erroredServiceIds: new Set(["billing"]),
    });
    assert.equal(erroredRes.changed, false);
    assert.deepEqual(erroredRes.nextMap, erroredInitial);
  });

  test("mods/changes-review copies of dropdown-logic.js, dropdown.js, and markdown-syntax.js stay byte-identical to shared/", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

    for (const file of ["dropdown-logic.js", "dropdown.js", "markdown-syntax.js"]) {
      const canonical = readFileSync(resolve(repoRoot, "shared", file), "utf8");
      const modCopy = readFileSync(resolve(repoRoot, "mods/changes-review", file), "utf8");
      assert.equal(modCopy, canonical, `mods/changes-review/${file} must match shared/${file} verbatim`);
    }
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

  test("resolveReviewMarkdownSourceSpec resolves working tree, commit, renamed R, deleted D, untracked ??, and lock-free git flags", () => {
    // 1. Working tree modified/added/untracked/renamed -> fast readTextFile path with no deleted notice
    const workingMod = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo/", path: "docs/README.md", status: "M", hasHead: true },
      { viewMode: "working" },
    );
    assert.equal(workingMod.kind, "file");
    assert.equal(workingMod.mode, "after");
    assert.equal(workingMod.isDeleted, false);
    assert.equal(workingMod.notice, "");
    assert.equal(workingMod.absPath, "/ws/repo/docs/README.md");

    const workingUntracked = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "notes/TODO.mdx", status: "??", fresh: true, hasHead: false },
    );
    assert.equal(workingUntracked.kind, "file");
    assert.equal(workingUntracked.isDeleted, false);
    assert.equal(workingUntracked.absPath, "/ws/repo/notes/TODO.mdx");

    const workingRenamed = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "docs/new-guide.md", oldPath: "docs/old-guide.md", status: "R", hasHead: true },
      { viewMode: "working" },
    );
    assert.equal(workingRenamed.kind, "file");
    assert.equal(workingRenamed.isDeleted, false);
    assert.equal(workingRenamed.notice, "");
    assert.equal(workingRenamed.absPath, "/ws/repo/docs/new-guide.md");

    // 2. Working tree deleted -> lock-free git show HEAD:<oldPath || path> with notice banner
    const workingDeleted = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "docs/removed.md", oldPath: "docs/prev-removed.md", status: "D", hasHead: true },
      { viewMode: "working", on: "dev@host" },
    );
    assert.equal(workingDeleted.kind, "git");
    assert.equal(workingDeleted.mode, "before");
    assert.equal(workingDeleted.isDeleted, true);
    assert.equal(workingDeleted.notice, "Deleted in this change — showing previous version");
    assert.equal(workingDeleted.refSpec, "HEAD:docs/prev-removed.md");
    assert.equal(workingDeleted.on, "dev@host");
    assert.deepEqual(workingDeleted.args, [...READ_GIT_FLAGS, "show", "HEAD:docs/prev-removed.md"]);

    const workingDeletedFallbackPath = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "CHANGELOG.md", status: "D" },
    );
    assert.equal(workingDeletedFallbackPath.kind, "git");
    assert.equal(workingDeletedFallbackPath.refSpec, "HEAD:CHANGELOG.md");

    // Working tree deleted when untracked / repo has no HEAD -> clear unavailable spec
    const workingDeletedNoHead = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "draft.md", status: "D", hasHead: false },
    );
    assert.equal(workingDeletedNoHead.kind, "unavailable");
    assert.equal(workingDeletedNoHead.isDeleted, true);
    assert.match(workingDeletedNoHead.error, /untracked|HEAD/i);

    // 3. Commit mode non-deleted (M, R) -> lock-free git show <hash>:<path>
    const commitHash = "845bbd44c7b586209dacee3c495946a6116b3edf";
    const commitRenamed = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "docs/renamed.md", oldPath: "docs/before.md", status: "R" },
      { viewMode: "commit", commitHash },
    );
    assert.equal(commitRenamed.kind, "git");
    assert.equal(commitRenamed.mode, "after");
    assert.equal(commitRenamed.isDeleted, false);
    assert.equal(commitRenamed.notice, "");
    assert.equal(commitRenamed.refSpec, `${commitHash}:docs/renamed.md`);
    assert.deepEqual(commitRenamed.args, [...READ_GIT_FLAGS, "show", `${commitHash}:docs/renamed.md`]);

    // 4. Commit mode deleted -> lock-free git show <hash>^:<oldPath || path> with deleted notice
    const commitDeleted = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "docs/old.md", status: "D" },
      { commitHash },
    );
    assert.equal(commitDeleted.kind, "git");
    assert.equal(commitDeleted.mode, "before");
    assert.equal(commitDeleted.isDeleted, true);
    assert.equal(commitDeleted.notice, "Deleted in this change — showing previous version");
    assert.equal(commitDeleted.refSpec, `${commitHash}^:docs/old.md`);
    assert.deepEqual(commitDeleted.args, [...READ_GIT_FLAGS, "show", `${commitHash}^:docs/old.md`]);

    const commitDeletedWithOldPath = resolveReviewMarkdownSourceSpec(
      { repoRoot: "/ws/repo", path: "docs/new.md", oldPath: "docs/orig.md", status: "D" },
      { viewMode: "commit", commitHash },
    );
    assert.equal(commitDeletedWithOldPath.refSpec, `${commitHash}^:docs/orig.md`);

    // 5. Guards: binary flag, missing commit hash in commit mode, missing file
    assert.equal(
      resolveReviewMarkdownSourceSpec({ repoRoot: "/ws/repo", path: "docs/bin.md", status: "M", binary: true }).kind,
      "unavailable",
    );
    assert.equal(
      resolveReviewMarkdownSourceSpec({ repoRoot: "/ws/repo", path: "docs/a.md", status: "M" }, { viewMode: "commit", commitHash: "" }).kind,
      "unavailable",
    );
    assert.equal(resolveReviewMarkdownSourceSpec(null).kind, "unavailable");
  });

  test("Markdown cache keying, binary NUL guard, and git-show error formatting handle edge cases", () => {
    const file = {
      key: "svc::docs/guide.md",
      repoRoot: "/ws/repo",
      path: "docs/guide.md",
      status: "M",
      fresh: false,
      sig: "120:1700000000000",
      mtimeMs: 1700000000000,
      add: 4,
      del: 1,
    };

    const workingId = computeViewerMarkdownFileId(file, "working", "");
    const commitId = computeViewerMarkdownFileId(file, "commit", "abc123");
    assert.notEqual(workingId, commitId);
    assert.equal(computeViewerMarkdownFileId(null), "");

    const tok0 = computeReviewMarkdownLoadToken(file, { viewMode: "working", reloadNonce: 0 });
    const tok1 = computeReviewMarkdownLoadToken(file, { viewMode: "working", reloadNonce: 1 });
    const tokEdited = computeReviewMarkdownLoadToken(
      { ...file, sig: "140:1700000005000", mtimeMs: 1700000005000 },
      { viewMode: "working", reloadNonce: 0 },
    );
    assert.notEqual(tok0, tok1);
    assert.notEqual(tok0, tokEdited);

    const k0 = buildReviewMarkdownCacheKey(file, { viewMode: "working", loadToken: tok0 });
    const k1 = buildReviewMarkdownCacheKey(file, { viewMode: "working", loadToken: tok1 });
    const kCommit = buildReviewMarkdownCacheKey(file, { viewMode: "commit", commitHash: "abc123", loadToken: "M||r0" });
    assert.notEqual(k0, k1);
    assert.notEqual(k0, kCommit);

    // Binary content NUL byte guard
    assert.deepEqual(validateMarkdownTextContent("# Hello\n"), { ok: true, text: "# Hello\n" });
    const binRes = validateMarkdownTextContent("abc\0def");
    assert.equal(binRes.ok, false);
    assert.match(binRes.error, /binary/i);
    assert.equal(validateMarkdownTextContent(null, "Missing file").error, "Missing file");

    // Git show error translations (root commit parent missing vs missing from HEAD)
    assert.match(
      formatGitShowMarkdownError("fatal: bad revision 'abc^:docs/old.md'", { isDeleted: true, refSpec: "abc^:docs/old.md" }),
      /root commit|parent/i,
    );
    assert.match(
      formatGitShowMarkdownError("fatal: path 'docs/new.md' exists on disk, but not in 'HEAD'", { isDeleted: true, refSpec: "HEAD:docs/new.md" }),
      /HEAD|untracked/i,
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

  test("regression: fresh baseline anchored to session start does not hide agent edits made before Review opens", () => {
    const t0900 = 1795442400000;
    const t1205 = 1795453500000;
    const t1211 = 1795453860000;
    const t1215 = 1795454100000;
    const t1221 = 1795454460000;

    // Flow already existed since 12:05 before Review created its baseline at 12:21
    const startInfo = resolveSessionStartTime({ updatedAt: t1205 }, t1221);
    assert.equal(startInfo.startedAt, t1205);
    assert.equal(startInfo.anchored, true);

    const files = [
      { relFile: "src/PreExisting.java", status: "M", sig: "50:1795442400000", mtimeMs: t0900 },
      { relFile: "src/CardB2bApi.java", status: "M", sig: "120:1795453860000", mtimeMs: t1211 },
      { relFile: "src/CardRepository.java", status: "M", sig: "240:1795454100000", mtimeMs: t1215 },
    ];

    const baseline = buildFreshSessionBaseline(
      [{ service: { root: "/ws/ms-card" }, files }],
      { workspaceRoot: "/ws/ms-card", startedAt: startInfo.startedAt, anchored: startInfo.anchored },
    );

    // Only the 09:00 pre-existing file is snapshotted; 12:11 & 12:15 agent edits are excluded from dirtyFiles
    assert.deepEqual(Object.keys(baseline.repos["/ws/ms-card"].dirtyFiles), ["src/PreExisting.java"]);

    const part = partitionSessionWorkingEntries(files, baseline.repos["/ws/ms-card"], baseline.startedAt);
    assert.deepEqual(part.visible.map((f) => f.relFile), ["src/CardB2bApi.java", "src/CardRepository.java"]);
    assert.deepEqual(part.hidden.map((f) => f.relFile), ["src/PreExisting.java"]);
  });

  test("regression: findRecentWorkspaceBaseline & findRecentFlowWorkspaceBaseline reuse orphaned morning baseline without stealing live tabs", async () => {
    const t0919 = 1795443593000;
    const t1221 = 1795454466000;
    const oldBaseline = {
      version: 1,
      startedAt: t0919,
      workspaceRoot: "/ws/ms-card",
      repos: { "/ws/ms-card": { dirtyFiles: {} } },
    };
    const otherLiveBaseline = {
      version: 1,
      startedAt: t0919 + 60000,
      workspaceRoot: "/ws/ms-card",
      repos: { "/ws/ms-card": { dirtyFiles: { "src/CardB2bApi.java": { status: "M", sig: "1:1" } } } },
    };

    const flows = {
      tbf79e3c: { sessionBaseline: oldBaseline },
      live_tab_2: { sessionBaseline: otherLiveBaseline },
    };

    // tbf79e3c is no longer live -> recovered; live_tab_2 is live -> skipped
    const fromFlows = findRecentFlowWorkspaceBaseline(flows, "/ws/ms-card", {
      excludeTabId: "tb70b579",
      liveTabIds: new Set(["tb70b579", "live_tab_2"]),
      now: t1221,
    });
    assert.deepEqual(fromFlows, oldBaseline);

    // Disk scan via mock fsDeps
    const filesMap = new Map([
      ["/app/cognivisor/sessions/tabs/tbf79e3c.json", JSON.stringify(oldBaseline)],
      ["/app/cognivisor/sessions/tabs/live_tab_2.json", JSON.stringify(otherLiveBaseline)],
    ]);
    const mockFs = {
      readdir: async () => ["tbf79e3c.json", "live_tab_2.json"],
      readFile: async (p) => {
        const key = String(p).replace(/\\/g, "/");
        if (!filesMap.has(key)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return filesMap.get(key);
      },
    };
    const fromDisk = await findRecentWorkspaceBaseline("/app", "/ws/ms-card", {
      excludeTabId: "tb70b579",
      liveTabIds: new Set(["tb70b579", "live_tab_2"]),
      now: t1221,
      fsDeps: mockFs,
    });
    assert.deepEqual(fromDisk, oldBaseline);
  });

  test("createResetSessionBaseline clears dirtyFiles across repos so hidden files immediately reappear", () => {
    const existing = {
      version: 1,
      startedAt: 1795454466000,
      workspaceRoot: "/ws/ms-card",
      repos: {
        "/ws/ms-card": {
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
    assert.equal(countBaselineDirtyFiles(reset), 0);
    assert.deepEqual(reset.repos["/ws/ms-card"], { dirtyFiles: {} });
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

  test("formatReviewAgentMessage strips trailing newlines and groups comments cleanly by service", () => {
    const msg = formatReviewAgentMessage(
      [
        {
          serviceId: "ms-card",
          serviceName: "ms-card",
          repoRoot: "C:\\Dev\\ms-card",
          displayPath: "src/CardLimit.java",
          line: 22,
          text: "Add unique index\r\nand verify rollback",
          snippet: "@Entity\npublic class CardLimit",
        },
      ],
      { viewMode: "working" },
    );
    assert.ok(msg.startsWith("Review comments on uncommitted changes:\n\n### Service: ms-card (C:\\Dev\\ms-card)"));
    assert.ok(msg.includes("- `src/CardLimit.java:22`:\n  Add unique index\n  and verify rollback\n  > @Entity public class CardLimit"));
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
});
