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
});
