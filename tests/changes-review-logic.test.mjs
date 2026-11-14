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
  pickNextDirtyService,
  filterSessionCommits,
  filterSessionWorkingEntries,
  normalizeGitStatusMark,
  statFileEntry,
  readDiskSessionBaseline,
  writeDiskSessionBaseline,
  extractResumeKeyFromTranscript,
  filterUnbaselinedRepoEntries,
  isHomeDirectoryRoot,
  resolveWorkspaceRoot,
  READ_GIT_FLAGS,
  parseCommitLogOutput,
  mergeBusCandidateServices,
  collectServiceWorkingSnapshot,
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

  test("sortServicesDirtyFirst and pickNextDirtyService advance across dirty unapproved services", () => {
    const sorted = sortServicesDirtyFirst([
      { id: "web", name: "web-client", workingCount: 0 },
      { id: "billing", name: "billing-api", workingCount: 2 },
      { id: "auth", name: "auth-api", workingCount: 5 },
      { id: "docs", name: "docs", workingCount: 0 },
    ]);
    assert.deepEqual(sorted.map((s) => s.id), ["auth", "billing", "docs", "web"]);

    const statuses = {
      auth: "approved",
      billing: "pending",
      web: "pending",
    };
    assert.equal(
      pickNextDirtyService(sorted, "auth", (id) => statuses[id])?.id,
      "billing",
    );

    // Wraps to earlier dirty service when current is at the end
    const statusesWrap = {
      auth: "pending",
      billing: "approved",
      web: "pending",
    };
    assert.equal(
      pickNextDirtyService(sorted, "billing", (id) => statusesWrap[id])?.id,
      "auth",
    );

    // Skips clean services even if pending, returns null when none left dirty & unapproved
    const allCleanOrApproved = {
      auth: "approved",
      billing: "approved",
      docs: "pending",
      web: "pending",
    };
    assert.equal(
      pickNextDirtyService(sorted, "auth", (id) => allCleanOrApproved[id]),
      null,
    );
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
    assert.equal(extractResumeKeyFromTranscript("/home/nmr/.config/herdr-app/mesh/sessions/resume", "/ws"), "");
    assert.equal(extractResumeKeyFromTranscript("Use /resume to restore a session\n  /resume   Resume chat", "/ws"), "");
    assert.equal(extractResumeKeyFromTranscript("\x1b[36m❯\x1b[0m /resume sess-42", "/ws"), "resume:sess-42");
    assert.equal(extractResumeKeyFromTranscript("user@dev:~/herdr-mesh$ claude --resume", "/ws"), "resume:/ws");

    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const appHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-cr-baseline-"));
    try {
      const ws = "/home/nmr/Projects/herdr-mesh";
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
      { spaceFolder: "/home/nmr", paneCwd: "/home/nmr/Projects/herdr-mesh", appHomeDir },
      { spaceFolder: "/home/nmr", paneCwd: "/home/nmr", appHomeDir },
      { spaceFolder: "/home/nmr", paneCwd: null, appHomeDir },
      { spaceFolder: "/home/nmr/Projects", paneCwd: "/home/nmr/Projects/herdr-mesh", appHomeDir },
      { spaceFolder: "/home/nmr/Projects/herdr-mesh", paneCwd: "/home/nmr/Projects/herdr-mesh/mods", appHomeDir },
      { spaceFolder: "/home/nmr/Projects/herdr-mesh", paneCwd: "/tmp/scratch", appHomeDir },
      { spaceFolder: "C:\\Users\\nmr", paneCwd: "C:\\Users\\nmr\\work\\app", isWindows: true, appHomeDir: "C:\\Users\\nmr\\AppData\\Roaming\\herdr-app" },
    ];
    for (const c of cases) {
      assert.equal(resolveWorkspaceRoot(c), filesSearchResolveWorkspaceRoot(c));
    }
    assert.equal(isHomeDirectoryRoot("/home/nmr", null, appHomeDir), true);
    assert.equal(resolveWorkspaceRoot(cases[0]), "/home/nmr/Projects/herdr-mesh");
    assert.equal(resolveWorkspaceRoot(cases[3]), "/home/nmr/Projects");
    assert.equal(resolveWorkspaceRoot(cases[4]), "/home/nmr/Projects/herdr-mesh");
    assert.equal(resolveWorkspaceRoot(cases[5]), "/tmp/scratch");
    assert.equal(resolveWorkspaceRoot(cases[6]), "C:\\Users\\nmr\\work\\app");
  });

  test("parseCommitLogOutput and mergeBusCandidateServices retain clean pushed repos and enrich metadata", () => {
    const svc = { id: ".", name: "herdr-mesh", root: "/ws/herdr-mesh" };
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
      serviceName: "herdr-mesh",
      repoRoot: "/ws/herdr-mesh",
    });
    assert.deepEqual(parseCommitLogOutput("", svc), []);

    const candidates = [
      { id: ".", name: "herdr-mesh", relPath: "", root: "/ws/herdr-mesh", isSibling: false, branch: "" },
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
        { root: "/ws/herdr-mesh", workingCount: 0, branch: "" },
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

    const service = { id: ".", name: "herdr-mesh", relPath: "", root: "/ws/herdr-mesh", isSibling: false };
    const snap = await collectServiceWorkingSnapshot({ ...service }, null, true, { exec: mockExec });
    assert.equal(snap.rawCount, 0);
    assert.equal(snap.files.length, 0);
    assert.equal(snap.touched, true);
    assert.equal(snap.branch, "main");
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
    assert.equal(noCommitSnap.touched, false);
    assert.equal(calls.length, beforeCalls + 1);
  });
});
