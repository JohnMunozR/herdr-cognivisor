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
  MAX_PREVIEW_RENDER_LINE_CHARS,
  getSyntaxExt,
  resolveEditorLanguage,
  getSyntaxPalette,
  getEditorSyntaxConfig,
  syntaxTokenStyle,
  tokenizeCodeLine,
  resolveFileIconSpec,
  resolveFileIcon,
  expandCodeTabs,
  computeCodeContentWidth,
  resolveViewerFilePath,
  buildFileViewerKey,
  formatFileTabTitle,
  pruneOpenFileTabs,
  findMatchingOpenFileTab,
  resolveViewerMarkdownToggleOnLoad,
  selectViewerMarkdownRawText,
  selectViewerRawText,
  shouldReuseInFlightPendingViewerOpen,
  buildViewerMarkdownCacheKey,
  buildViewerMarkdownViewIds,
  resolveRelativeMarkdownTarget,
  getPreviewMarkdownTargetPath,
  shouldResetPreviewMarkdown,
  shouldLoadFullMarkdownPreview,
  buildPreviewMarkdownViewIds,
  isNavModifierActive,
  splitCodeViewerLines,
  tokenizeInteractiveWrappedLine,
  buildWrappedViewerDocument,
  computeWindowedViewerSlice,
  computeTargetCenterScrollRow,
  computeScrollbarMetrics,
  resolveWheelLineDelta,
  resolveClickScrollbarRow,
  buildDisambiguationDropdownItems,
  buildDisambiguationHeaderMeta,
  computeLocalAnchorRect,
  shouldAllowUnderlyingScroll,
  buildViewerNavigationNotice,
  applyTabNavMeta,
  shouldOpenNavInNewTab,
} from "../mods/files-search/search-logic.js";
import { normalizeNavCandidate } from "../shared/code-nav-logic.js";
import { isMarkdownFile } from "../mods/files-search/markdown-view-logic.js";

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

  test("resolveEditorLanguage and getEditorSyntaxConfig support Java Spring Boot, Python, JS, and light/dark contrast", () => {
    assert.equal(getSyntaxExt("config/application.properties"), "properties");
    assert.equal(getSyntaxExt("build.gradle"), "gradle");
    assert.equal(resolveEditorLanguage("src/Main.JAVA"), "java");
    assert.equal(resolveEditorLanguage("app/worker.pyi"), "py");
    assert.equal(resolveEditorLanguage("web/index.tsx"), "js");
    assert.equal(resolveEditorLanguage("build.gradle"), "groovy");
    assert.equal(resolveEditorLanguage("config/application.properties"), "properties");

    const oneDark = {
      is_dark: true,
      background: "#21252b",
      foreground: "#abb2bf",
      dim: "#5c6370",
      ansi1: "#e06c75",
      ansi2: "#98c379",
      ansi3: "#e5c07b",
      ansi4: "#61afef",
      ansi5: "#c678dd",
      ansi6: "#56b6c2",
    };
    const darkCfg = getEditorSyntaxConfig(oneDark);
    assert.equal(Object.keys(darkCfg).length, 12);
    assert.notEqual(darkCfg.number, oneDark.ansi1, "numbers should use calm amber instead of coral red");
    assert.equal(darkCfg.annotation, undefined, "EditorState config exposes the 12 gpui-kit token keys");
    assert.equal(darkCfg.variable, oneDark.ansi1);
    assert.equal(darkCfg.operator, oneDark.ansi6);
    assert.equal(darkCfg["string.escape"], oneDark.ansi6);

    const washedLight = {
      is_dark: false,
      background: "#ffffff",
      foreground: "#24292f",
      dim: "#cccccc",
      ansi1: "#cf222e",
      ansi2: "#116329",
      ansi3: "#ffff00",
      ansi4: "#0969da",
      ansi5: "#8250df",
      ansi6: "#a0f0ff",
    };
    const lightPalette = getSyntaxPalette(washedLight);
    assert.equal(lightPalette.isDark, false);
    assert.equal(lightPalette.type, "#9a6700", "washed-out light yellow ansi3 should fall back to high-contrast ochre");
    assert.equal(lightPalette.operator, "#0e7490", "washed-out light cyan should fall back to high-contrast teal");
  });

  test("tokenizeCodeLine highlights Spring Boot annotations, Python f-strings/decorators, JS arrows, and properties", () => {
    const springLine = tokenizeCodeLine('@GetMapping("/{id}") public ResponseEntity<UserDto> get(Long id) { return this.find(id); }', "java");
    assert.ok(springLine.some(([k, v]) => k === "annotation" && v === "@GetMapping"));
    assert.ok(springLine.some(([k, v]) => k === "string.escape" && v === "{id}"));
    assert.ok(springLine.some(([k, v]) => k === "type" && v === "ResponseEntity"));
    assert.ok(springLine.some(([k, v]) => k === "type" && v === "UserDto"));
    assert.ok(springLine.some(([k, v]) => k === "variable" && v === "this"));
    assert.ok(springLine.some(([k, v]) => k === "function" && v === "find"));

    const javadocLine = tokenizeCodeLine(" * @return {@code ResponseEntity} with status 200", "java");
    assert.ok(javadocLine.some(([k, v]) => k === "annotation" && v === "@return"));
    assert.ok(javadocLine.some(([k, v]) => k === "annotation" && v === "@code"));
    assert.ok(javadocLine.some(([k, v]) => k === "comment"));

    const pyDecorated = tokenizeCodeLine('@app.get("/users")', "py");
    assert.ok(pyDecorated.some(([k, v]) => k === "annotation" && v === "@app.get"));
    const pyBody = tokenizeCodeLine('elif self.count <= 0: msg = f"missing {user_id} \\n" # check', "py");
    assert.ok(pyBody.some(([k, v]) => k === "keyword" && v === "elif"));
    assert.ok(pyBody.some(([k, v]) => k === "variable" && v === "self"));
    assert.ok(pyBody.some(([k, v]) => k === "operator" && v === "<="));
    assert.ok(pyBody.some(([k, v]) => k === "number" && v === "0"));
    assert.ok(pyBody.some(([k, v]) => k === "string.escape" && v === "{user_id}"));
    assert.ok(pyBody.some(([k, v]) => k === "string.escape" && v === "\\n"));
    assert.ok(pyBody.some(([k, v]) => k === "comment" && v === "# check"));

    const jsArrow = tokenizeCodeLine("const load = async (id) => `user:${id}` ?? null;", "js");
    assert.ok(jsArrow.some(([k, v]) => k === "keyword" && v === "const"));
    assert.ok(jsArrow.some(([k, v]) => k === "keyword" && v === "async"));
    assert.ok(jsArrow.some(([k, v]) => k === "operator" && v === "=>"));
    assert.ok(jsArrow.some(([k, v]) => k === "string.escape" && v === "${id}"));
    assert.ok(jsArrow.some(([k, v]) => k === "operator" && v === "??"));
    assert.ok(jsArrow.some(([k, v]) => k === "constant" && v === "null"));

    const propsUrl = tokenizeCodeLine("spring.datasource.url=jdbc:postgresql://db:5432/${DB_NAME}", "properties");
    assert.ok(propsUrl.some(([k, v]) => k === "function" && v === "spring.datasource.url"));
    assert.ok(propsUrl.some(([k, v]) => k === "operator" && v === "="));
    assert.ok(propsUrl.some(([k, v]) => k === "string.escape" && v === "${DB_NAME}"));

    const previewStyle = syntaxTokenStyle("annotation", { is_dark: true, ansi1: "#e06c75" }, true);
    assert.deepEqual(previewStyle, { color: "#e06c75", bold: true });
  });

  test("resolveFileIconSpec classifies Java, Spring Boot, Python, JS/TS, config, infra, and generic files", () => {
    const cases = [
      ["src/main/java/com/acme/UserController.java", "java"],
      ["build/libs/app.jar", "java"],
      ["src/main/resources/application.yml", "spring"],
      ["config/application-prod.properties", "spring"],
      ["src/main/resources/bootstrap.properties", "spring"],
      ["src/main/resources/logback-spring.xml", "spring"],
      ["META-INF/spring.factories", "spring"],
      ["pom.xml", "build"],
      ["build.gradle", "build"],
      ["app/service.py", "python"],
      ["stubs/api.pyi", "python"],
      ["src/index.js", "javascript"],
      ["scripts/cli.mjs", "javascript"],
      ["src/types.ts", "typescript"],
      ["src/components/Button.tsx", "react"],
      ["src/App.jsx", "react"],
      ["src/Main.kt", "kotlin"],
      ["package.json", "json"],
      [".github/workflows/ci.yaml", "yaml"],
      [".env.local", "settings"],
      ["conf/server.properties", "settings"],
      ["Dockerfile", "docker"],
      ["docker-compose.yml", "docker"],
      ["package-lock.json", "lock"],
      [".gitignore", "git"],
      ["db/migrations/001_init.sql", "database"],
      ["README.md", "markdown"],
      ["LICENSE", "markdown"],
      ["install.sh", "shell"],
      ["index.html", "html"],
      ["styles/app.scss", "css"],
      ["assets/logo.png", "image"],
      ["src/lib.rs", "code"],
      ["notes/todo.txt", "file"],
      ["C:\\repo\\USER_SERVICE.JAVA", "java"],
    ];
    for (const [filePath, expectedKind] of cases) {
      const spec = resolveFileIconSpec(filePath);
      assert.equal(spec.kind, expectedKind, `expected ${filePath} -> ${expectedKind}, got ${spec.kind}`);
      assert.ok(typeof spec.tone === "string" && spec.tone.length > 0);
    }
  });

  test("resolveFileIcon returns existing SVG paths and non-empty colors for dark and light themes", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const iconDir = path.join(repoRoot, "mods/files-search/icons/file-types");

    const themes = [
      {
        is_dark: true,
        text_muted: "#7f848e",
        ansi1: "#e06c75",
        ansi2: "#98c379",
        ansi3: "#e5c07b",
        ansi4: "#61afef",
        ansi5: "#c678dd",
        ansi6: "#56b6c2",
      },
      {
        is_dark: false,
        text_muted: "#6b7280",
      },
    ];

    const sampleFiles = [
      "src/UserController.java",
      "src/main/resources/application.yml",
      "app/main.py",
      "web/index.js",
      "web/App.tsx",
      "Dockerfile",
      "pom.xml",
      "db/schema.sql",
      "README.md",
      "notes.txt",
    ];

    for (const t of themes) {
      for (const filePath of sampleFiles) {
        const icon = resolveFileIcon(filePath, t);
        assert.match(icon.path, /^mods\/files-search\/icons\/file-types\/[a-z-]+\.svg$/);
        assert.ok(typeof icon.color === "string" && icon.color.startsWith("#"));
        const svgDiskPath = path.join(repoRoot, icon.path);
        assert.ok(fs.existsSync(svgDiskPath), `missing SVG asset: ${svgDiskPath}`);
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

  test("expandCodeTabs, tokenizeCodeLine, and computeCodeContentWidth support long lines for horizontal scrolling", () => {
    assert.equal(expandCodeTabs("\treturn x;\t// tab"), "    return x;    // tab");

    const longJava = `@GetMapping("${"/segment".repeat(100)}") public ResponseEntity<String> handleLongRoute() { return ResponseEntity.ok("ok"); }`;
    assert.ok(longJava.length > 800 && longJava.length < 1600);
    const tokens = tokenizeCodeLine(longJava, "java");
    assert.ok(Array.isArray(tokens) && tokens.length > 0);
    assert.equal(tokens[0][0], "annotation");
    assert.equal(tokens.map(([, txt]) => txt).join(""), longJava);

    const w = computeCodeContentWidth(["short", `\t${longJava}`], { minWidth: 320, charPx: 7.6, gutterPx: 88 });
    assert.ok(w > 6000, `expected horizontal scroll width > 6000 for long line, got ${w}`);
    assert.equal(computeCodeContentWidth(["short"], { minWidth: 500, charPx: 7.6, gutterPx: 88 }), 500);

    // Ensure stack-safe iteration across 12k lines (exceeding JS call-stack arg limit)
    const manyLines = Array.from({ length: 12000 }, () => "const x = 1;");
    assert.equal(computeCodeContentWidth(manyLines, { minWidth: 240, charPx: 7.6, gutterPx: 92 }), 240);
  });

  test("resolveViewerFilePath resolves relative, Unix absolute, Windows drive, and UNC paths", () => {
    assert.equal(resolveViewerFilePath("/workspace/repo", "src/./app/../AuthController.java"), "/workspace/repo/src/AuthController.java");
    assert.equal(resolveViewerFilePath("/workspace/repo/", "nested/sub/"), "/workspace/repo/nested/sub");
    assert.equal(resolveViewerFilePath("/", "etc/hosts"), "/etc/hosts");
    assert.equal(resolveViewerFilePath("/workspace/repo", "/other/abs/file.ts"), "/other/abs/file.ts");
    assert.equal(resolveViewerFilePath("", "relative/./file.js"), "relative/file.js");
    assert.equal(resolveViewerFilePath("/workspace/repo", ""), "");

    // Windows drive and UNC paths normalize to forward slashes and resolve dot segments cleanly
    assert.equal(
      resolveViewerFilePath("C:\\work\\cognivisor\\", "auth-service\\src\\..\\Main.java"),
      "C:/work/cognivisor/auth-service/Main.java"
    );
    assert.equal(
      resolveViewerFilePath("C:/work/cognivisor", "D:\\elsewhere\\config.yml"),
      "D:/elsewhere/config.yml"
    );
    assert.equal(
      resolveViewerFilePath("\\\\fileserver\\share\\repo", "dir\\sub\\..\\mod.rs"),
      "//fileserver/share/repo/dir/mod.rs"
    );
  });

  test("buildFileViewerKey normalizes equivalent targets and respects case sensitivity", () => {
    const k1 = buildFileViewerKey("/work/cognivisor", "auth-service/src/AuthController.java", false);
    const k2 = buildFileViewerKey("/work/cognivisor/auth-service", "src/./AuthController.java", false);
    const k3 = buildFileViewerKey("", "/work/cognivisor/auth-service/src/AuthController.java", false);
    assert.equal(k1, "/work/cognivisor/auth-service/src/AuthController.java");
    assert.equal(k2, k1);
    assert.equal(k3, k1);

    // POSIX preserves case while Windows folds case for deduplication
    assert.notEqual(
      buildFileViewerKey("/work/cognivisor", "src/Main.java", false),
      buildFileViewerKey("/work/cognivisor", "src/main.java", false)
    );
    assert.equal(
      buildFileViewerKey("C:\\Work\\Cognivisor", "Src\\Main.Java", true),
      buildFileViewerKey("C:/work/cognivisor", "src/main.java", true)
    );
    assert.equal(buildFileViewerKey("/work/cognivisor", "   ", false), "");
  });

  test("formatFileTabTitle keeps concise basenames and disambiguates duplicate tab titles", () => {
    assert.equal(formatFileTabTitle("src/main/java/AuthController.java", "auth-service", []), "AuthController.java");
    assert.equal(formatFileTabTitle("C:\\repo\\order\\OrderService.java", null, new Set()), "OrderService.java");
    assert.equal(formatFileTabTitle("", null, []), "File");

    // Duplicate basename disambiguates with service name first
    assert.equal(
      formatFileTabTitle("auth-service/src/Application.java", "auth-service", ["Application.java"]),
      "Application.java · auth-service"
    );
    // Same-service collision escalates cleanly to service/parent, parent, deeper segments, and numeric fallback
    const taken = new Set([
      "application.yml",
      "application.yml · auth-service",
    ]);
    assert.equal(
      formatFileTabTitle("auth-service/src/test/resources/application.yml", "auth-service", taken),
      "application.yml · auth-service/resources"
    );
    taken.add("application.yml · auth-service/resources");
    assert.equal(
      formatFileTabTitle("auth-service/src/test/resources/application.yml", "auth-service", taken),
      "application.yml · resources"
    );
    taken.add("application.yml · resources");
    assert.equal(
      formatFileTabTitle("auth-service/src/test/resources/application.yml", "auth-service", taken),
      "application.yml · test/resources"
    );
    taken.add("application.yml · test/resources");
    taken.add("application.yml · src/test/resources");
    assert.equal(
      formatFileTabTitle("auth-service/src/test/resources/application.yml", "auth-service", taken),
      "application.yml (2)"
    );

    // Boolean hint disambiguates when no service or duplicate list is supplied
    assert.equal(formatFileTabTitle("packages/api/index.ts", null, true), "index.ts · api");
  });

  test("pruneOpenFileTabs drops closed or non-viewer tabs and repairs inconsistent entries", () => {
    const initial = {
      "tab-1": { tabId: "tab-1", root: "/repo", path: "a.ts", absPath: "/repo/a.ts" },
      "tab-dead": { tabId: "tab-dead", root: "/repo", path: "b.ts", absPath: "/repo/b.ts" },
      "tab-terminal": { tabId: "tab-terminal", root: "/repo", path: "c.ts", absPath: "/repo/c.ts" },
      "wrong-key": { tabId: "tab-2", root: "/repo", path: "d.ts", absPath: "/repo/d.ts" },
      broken: null,
    };

    const pruned = pruneOpenFileTabs(
      initial,
      ["tab-1", "tab-2", "tab-terminal"],
      ["tab-1", "tab-2"]
    );
    assert.equal(pruned.changed, true);
    assert.deepEqual(Object.keys(pruned.tabs).sort(), ["tab-1", "tab-2"]);
    assert.equal(pruned.tabs["tab-2"].tabId, "tab-2");

    // Re-running on already clean tabs reports unchanged
    const second = pruneOpenFileTabs(pruned.tabs, new Set(["tab-1", "tab-2"]), new Set(["tab-1", "tab-2"]));
    assert.equal(second.changed, false);
    assert.deepEqual(second.tabs, pruned.tabs);
    assert.deepEqual(pruneOpenFileTabs(null, []), { tabs: {}, changed: false });
  });

  test("findMatchingOpenFileTab deduplicates per space and respects stale/cross-space boundaries", () => {
    const openTabs = {
      "tab-space1-auth": {
        tabId: "tab-space1-auth",
        spaceId: "space-1",
        root: "/workspace/cognivisor",
        path: "auth-service/src/AuthController.java",
        absPath: "/workspace/cognivisor/auth-service/src/AuthController.java",
      },
      "tab-space2-auth": {
        tabId: "tab-space2-auth",
        spaceId: "space-2",
        root: "/workspace/cognivisor",
        path: "auth-service/src/AuthController.java",
        absPath: "/workspace/cognivisor/auth-service/src/AuthController.java",
      },
      "tab-win": {
        tabId: "tab-win",
        spaceId: "space-1",
        root: "C:\\Work\\Cognivisor",
        path: "gateway\\App.ts",
        absPath: "C:/Work/Cognivisor/gateway/App.ts",
      },
    };

    // Opening from sub-service root or absolute path matches the existing space-1 tab
    const hitFromSubroot = findMatchingOpenFileTab(
      openTabs,
      ["tab-space1-auth", "tab-win"],
      ["tab-space1-auth", "tab-space2-auth", "tab-win"],
      "/workspace/cognivisor/auth-service",
      "src/AuthController.java",
      false
    );
    assert.equal(hitFromSubroot?.tabId, "tab-space1-auth");

    // Space without that file tab must NOT reuse a viewer tab belonging to another space
    const missInSpace3 = findMatchingOpenFileTab(
      openTabs,
      ["tab-space3-term"],
      ["tab-space1-auth", "tab-space2-auth"],
      "/workspace/cognivisor",
      "auth-service/src/AuthController.java",
      false
    );
    assert.equal(missInSpace3, null);

    // Pane that is no longer a files-search pane cannot be reused
    const stalePane = findMatchingOpenFileTab(
      openTabs,
      ["tab-space1-auth"],
      ["tab-win"],
      "/workspace/cognivisor",
      "auth-service/src/AuthController.java",
      false
    );
    assert.equal(stalePane, null);

    // Windows case-insensitive dedupe match
    const winHit = findMatchingOpenFileTab(
      openTabs,
      ["tab-space1-auth", "tab-win"],
      ["tab-space1-auth", "tab-win"],
      "c:/work/cognivisor",
      "GATEWAY/app.ts",
      true
    );
    assert.equal(winHit?.tabId, "tab-win");
    assert.equal(findMatchingOpenFileTab(null, ["tab-1"], ["tab-1"], "/repo", "a.ts"), null);
  });

  test("resolveViewerMarkdownToggleOnLoad defaults false on new/switched targets and preserves on same-file reload", () => {
    // Initial open starts raw (false)
    assert.equal(resolveViewerMarkdownToggleOnLoad("", "/repo/README.md", false), false);
    assert.equal(resolveViewerMarkdownToggleOnLoad(null, "/repo/README.md", true), false);

    // Explicit reload of the same Markdown file preserves toggle state
    assert.equal(resolveViewerMarkdownToggleOnLoad("/repo/README.md", "/repo/README.md", true), true);
    assert.equal(resolveViewerMarkdownToggleOnLoad("/repo/README.md", "/repo/README.md", false), false);
    assert.equal(
      resolveViewerMarkdownToggleOnLoad("C:\\Repo\\docs\\SPEC.md", "C:/repo/docs/spec.md", true, true),
      true
    );

    // Switching to another file resets toggle to raw (false)
    assert.equal(resolveViewerMarkdownToggleOnLoad("/repo/README.md", "/repo/SPEC.md", true), false);
    assert.equal(resolveViewerMarkdownToggleOnLoad("/repo/README.md", "/repo/src/main.js", true), false);
    assert.equal(resolveViewerMarkdownToggleOnLoad("/repo/src/main.js", "/repo/src/main.js", true), false);
  });

  test("selectViewerMarkdownRawText retains raw text only for valid non-binary Markdown files", () => {
    assert.equal(selectViewerMarkdownRawText("/repo/README.md", "# Title\n"), "# Title\n");
    assert.equal(selectViewerMarkdownRawText("docs/guide.MDX", "# MDX"), "# MDX");
    assert.equal(selectViewerMarkdownRawText("/repo/empty.md", ""), "");

    // Non-Markdown, errors, null, or binary content must clear retained text to null
    assert.equal(selectViewerMarkdownRawText("/repo/main.js", "console.log(1);"), null);
    assert.equal(selectViewerMarkdownRawText("/repo/README.md", "# Title", true), null);
    assert.equal(selectViewerMarkdownRawText("/repo/README.md", null, false), null);
    assert.equal(selectViewerMarkdownRawText("/repo/README.md", "abc\0def", false), null);
    assert.equal(isMarkdownFile("/repo/README.md"), true);
    assert.equal(isMarkdownFile("/repo/main.js"), false);
  });

  test("selectViewerRawText retains raw text for code, config, and Markdown files so non-Markdown viewers build documents instead of staying on Loading file", () => {
    const javaSrc = "package com.rag.scaffold;\npublic class TenantController {\n  void getTenants() {}\n}\n";
    const jsSrc = "export function main() { return 42; }\n";
    const pySrc = "def main():\n    return 42\n";
    const mdSrc = "# Title\n";

    assert.equal(selectViewerRawText(javaSrc, false), javaSrc);
    assert.equal(selectViewerRawText(jsSrc, false), jsSrc);
    assert.equal(selectViewerRawText(pySrc, false), pySrc);
    assert.equal(selectViewerRawText(mdSrc, false), mdSrc);
    assert.equal(selectViewerRawText("", false), "");

    // Regression: selectViewerMarkdownRawText previously returned null for .java/.js/.py,
    // which left viewerRawText === null and viewerDoc === null ("Loading file…").
    assert.equal(selectViewerMarkdownRawText("/repo/TenantController.java", javaSrc, false), null);
    const rawForDoc = selectViewerRawText(javaSrc, false);
    const doc = buildWrappedViewerDocument(rawForDoc, "/repo/TenantController.java", 88);
    assert.ok(doc && doc.totalLines >= 3 && doc.rows.length >= 3);

    // Errors, null, or binary content must return null
    assert.equal(selectViewerRawText(javaSrc, true), null);
    assert.equal(selectViewerRawText(null, false), null);
    assert.equal(selectViewerRawText("abc\0def", false), null);
  });

  test("shouldReuseInFlightPendingViewerOpen deduplicates sub-window double open calls before spaces() materializes the new tab", () => {
    const pending = { viewerId: "fv-1", ts: 1000 };
    assert.equal(shouldReuseInFlightPendingViewerOpen(pending, 1004), true);
    assert.equal(shouldReuseInFlightPendingViewerOpen(pending, 1399), true);
    assert.equal(shouldReuseInFlightPendingViewerOpen(pending, 1400), false);
    assert.equal(shouldReuseInFlightPendingViewerOpen(pending, 999), false);
    assert.equal(shouldReuseInFlightPendingViewerOpen(null, 1004), false);
  });

  test("buildViewerMarkdownCacheKey and buildViewerMarkdownViewIds scope keys and scroll IDs per target and loadSeq", () => {
    assert.equal(buildViewerMarkdownCacheKey("/repo/README.md", 3), "/repo/README.md|3");
    assert.equal(buildViewerMarkdownCacheKey("", 1), "");

    const idsA1 = buildViewerMarkdownViewIds("fv-1", "/repo/README.md", 1);
    const idsA1Again = buildViewerMarkdownViewIds("fv-1", "/repo/README.md", 1);
    const idsA2 = buildViewerMarkdownViewIds("fv-1", "/repo/README.md", 2);
    const idsB1 = buildViewerMarkdownViewIds("fv-1", "/repo/SPEC.md", 1);
    const idsOtherTab = buildViewerMarkdownViewIds("fv-2", "/repo/README.md", 1);

    assert.deepEqual(idsA1, idsA1Again);
    assert.notEqual(idsA1.id, idsA1.scrollId);
    assert.notEqual(idsA1.scrollId, idsA2.scrollId);
    assert.notEqual(idsA1.scrollId, idsB1.scrollId);
    assert.notEqual(idsA1.scrollId, idsOtherTab.scrollId);
  });

  test("resolveRelativeMarkdownTarget resolves different relative files and rejects same-file, anchor, external, and unsafe links", () => {
    assert.equal(
      resolveRelativeMarkdownTarget("/repo/mods/files-search/SPEC.md", "../changes-review/SPEC.md#overview"),
      "/repo/mods/changes-review/SPEC.md"
    );
    assert.equal(
      resolveRelativeMarkdownTarget("mods/files-search/SPEC.md", "./main.js#L10"),
      "mods/files-search/main.js"
    );

    // Same-file relative links, anchors, external URLs, and invalid escapes must return null
    assert.equal(resolveRelativeMarkdownTarget("/repo/README.md", "./README.md#install"), null);
    assert.equal(
      resolveRelativeMarkdownTarget("C:\\repo\\README.md", "./readme.md", true),
      null
    );
    assert.equal(resolveRelativeMarkdownTarget("/repo/README.md", "#section"), null);
    assert.equal(resolveRelativeMarkdownTarget("/repo/README.md", "https://example.com/docs"), null);
    assert.equal(resolveRelativeMarkdownTarget("README.md", "../../secret.md"), null);
  });

  test("shouldResetPreviewMarkdown resets on path change, dir selection, or close while preserving same-file hits", () => {
    const fileItemA = { kind: "file", path: "docs/README.md" };
    const textHitA1 = { kind: "text", path: "docs/README.md", line: 10 };
    const textHitA2 = { kind: "text", path: "docs/README.md", line: 85 };
    const fileItemB = { kind: "file", path: "docs/SPEC.md" };
    const dirItem = { kind: "dir", path: "docs" };

    assert.equal(getPreviewMarkdownTargetPath(dirItem), null);
    assert.equal(getPreviewMarkdownTargetPath(fileItemA), "docs/README.md");

    assert.equal(shouldResetPreviewMarkdown(null, fileItemA), true);
    assert.equal(shouldResetPreviewMarkdown(fileItemA, textHitA1), false);
    assert.equal(shouldResetPreviewMarkdown(textHitA1, textHitA2), false);
    assert.equal(shouldResetPreviewMarkdown(fileItemA, fileItemB), true);
    assert.equal(shouldResetPreviewMarkdown(fileItemA, dirItem), true);
    assert.equal(shouldResetPreviewMarkdown(fileItemA, null), true);
    assert.equal(shouldResetPreviewMarkdown(null, null), false);
  });

  test("shouldLoadFullMarkdownPreview and buildPreviewMarkdownViewIds distinguish complete chunks from partial/mid-file previews", () => {
    // Full file already present from line 1 with no remaining chunks -> zero extra read
    assert.equal(shouldLoadFullMarkdownPreview(1, false), false);
    assert.equal(shouldLoadFullMarkdownPreview(0, false), false);

    // Mid-file text search hit or truncated >120 line file -> lazy fetch from line 1 required
    assert.equal(shouldLoadFullMarkdownPreview(1, true), true);
    assert.equal(shouldLoadFullMarkdownPreview(25, false), true);
    assert.equal(shouldLoadFullMarkdownPreview(25, true), true);
    assert.equal(shouldLoadFullMarkdownPreview(NaN, false), true);

    const chunkIds = buildPreviewMarkdownViewIds("docs/README.md", 1, "chunk-24");
    const fullIds = buildPreviewMarkdownViewIds("docs/README.md", 1, "full");
    const otherFileIds = buildPreviewMarkdownViewIds("docs/SPEC.md", 1, "chunk-24");
    assert.notEqual(chunkIds.scrollId, fullIds.scrollId);
    assert.notEqual(chunkIds.scrollId, otherFileIds.scrollId);
  });

  test("isNavModifierActive handles Ctrl/Cmd cleanly and ignores AltGr control+alt chord", () => {
    assert.equal(isNavModifierActive({ control: true }), true);
    assert.equal(isNavModifierActive({ platform: true }), true);
    assert.equal(isNavModifierActive({ control: true, shift: true }), true);
    assert.equal(isNavModifierActive({ control: true, alt: true }), false);
    assert.equal(isNavModifierActive({ alt: true }), false);
    assert.equal(isNavModifierActive(null), false);
  });

  test("tokenizeInteractiveWrappedLine and buildWrappedViewerDocument preserve interactive metadata across soft wraps", () => {
    const src = [
      "import { computeTotal } from './math.js';",
      "\tconst invoiceTotal = computeTotal(orderItemA, orderItemB, fallbackDiscountRate);",
      "",
      "return invoiceTotal;",
    ].join("\n");

    const singleRows = tokenizeInteractiveWrappedLine(
      "\tconst x = computeTotal(alpha);",
      "js",
      null,
      18,
    );
    assert.ok(singleRows.length >= 2);
    const flatToks = singleRows.flat();
    const callTok = flatToks.find(([, txt, meta]) => txt === "computeTotal" && meta?.nav);
    assert.ok(callTok, "computeTotal token must keep nav: true after wrapStyledSpans");
    assert.ok(Number.isInteger(callTok[2].col) && callTok[2].col > 1);

    const doc = buildWrappedViewerDocument(src, "src/billing.js", 36);
    assert.equal(doc.totalLines, 4);
    assert.equal(doc.rows[0].lineNum, 1);
    assert.equal(doc.rows[0].isFirstWrap, true);
    assert.ok(doc.lineRowCounts[1] >= 2, "long line 2 wraps into multiple visual rows");
    const line4First = doc.lineFirstRowIndex[3];
    assert.equal(doc.rows[line4First].lineNum, 4);
    assert.equal(doc.rows[line4First].isFirstWrap, true);
    for (let i = 1; i < doc.lineRowCounts[1]; i += 1) {
      assert.equal(doc.rows[doc.lineFirstRowIndex[1] + i].isFirstWrap, false);
    }

    const lines = splitCodeViewerLines("a\r\nb\nc");
    assert.deepEqual(lines, ["a", "b", "c"]);
  });

  test("windowed code viewer scroll, centering, wheel sign, and scrollbar geometry behave deterministically", () => {
    const src = Array.from({ length: 80 }, (_, idx) => `const value_${idx + 1} = compute_${idx + 1}();`).join("\n");
    const doc = buildWrappedViewerDocument(src, "src/index.js", 100);
    const slice0 = computeWindowedViewerSlice(doc.rows.length, -10, 400, 20);
    assert.equal(slice0.visibleCount, 20);
    assert.equal(slice0.maxScrollTop, 60);
    assert.equal(slice0.scrollTop, 0);

    const centerRow = computeTargetCenterScrollRow(doc, 45, 400, 20);
    assert.ok(centerRow > 25 && centerRow < 45);

    const hiddenBar = computeScrollbarMetrics(10, 0, 20, 400);
    assert.equal(hiddenBar.visible, false);

    const barTop = computeScrollbarMetrics(80, 0, 20, 400);
    const barEnd = computeScrollbarMetrics(80, 60, 20, 400);
    assert.equal(barTop.visible, true);
    assert.equal(barTop.thumbTop, 0);
    assert.equal(barEnd.thumbTop + barEnd.thumbHeight, 400);

    // Positive delta.y scrolls UP (negative row delta); negative delta.y scrolls DOWN
    assert.equal(resolveWheelLineDelta(15, 0), -3);
    assert.equal(resolveWheelLineDelta(-15, 0), 3);
    assert.equal(resolveWheelLineDelta(0, 2), -6);
    assert.equal(resolveClickScrollbarRow(400, 400, 80, 20), 60);
  });

  test("disambiguation items, nav notices, and tab nav metadata preserve context cleanly", () => {
    const items = buildDisambiguationDropdownItems([
      {
        filePath: "/repo/billing/src/StripeGateway.java",
        serviceRoot: "/repo/billing",
        serviceName: "billing",
        line: 27,
        column: 17,
        containerName: "StripeGateway",
        symbol: "charge",
        signature: "public Receipt charge(Order order, Currency currency)",
        kind: "implementation",
      },
      {
        filePath: "/repo/orders/src/FallbackGateway.java",
        serviceRoot: "/repo/orders",
        serviceName: "orders",
        line: 14,
        column: 10,
        containerName: "FallbackGateway",
        symbol: "charge",
        kind: "implementation",
      },
    ], "/repo/billing", "billing");

    assert.equal(items.length, 2);
    assert.equal(items[0].label, "StripeGateway.charge");
    assert.equal(items[0].subline, "src/StripeGateway.java:27");
    assert.equal(items[0].badge, "");
    assert.equal(items[1].badge, "orders");
    assert.equal(items[1].rightText, ":14");

    const extNotice = buildViewerNavigationNotice({ status: "external", externalPackage: "java.util.List" }, { symbol: "List" }, "declaration");
    assert.match(extNotice.message, /java\.util\.List/);
    const nfNotice = buildViewerNavigationNotice({ status: "not-found" }, { symbol: "missingFn" }, "implementation");
    assert.equal(nfNotice.level, "warn");
    assert.match(nfNotice.message, /missingFn/);
    const sameNotice = buildViewerNavigationNotice({ status: "already-there" }, { symbol: "targetFn" }, "implementation");
    assert.match(sameNotice.message, /Already at implementation/);

    const patchedTab = applyTabNavMeta({ tabId: "t1", line: 9 }, { column: 15, highlightSymbol: "processOrder", navSeq: 4 });
    assert.equal(patchedTab.column, 15);
    assert.equal(patchedTab.highlightSymbol, "processOrder");
    assert.equal(patchedTab.navSeq, 4);
  });

  test("wrapped markdown viewer tracks multi-line frontmatter state without making YAML keys navigable", () => {
    const mdText = [
      "---",
      "title: Architecture Notes",
      "author: Alice",
      "---",
      "",
      "```js",
      "const result = computeValue();",
      "```",
    ].join("\n");
    const doc = buildWrappedViewerDocument(mdText, "/repo/docs/guide.md", 80);

    // Line 2 (`title: Architecture Notes`) inside YAML frontmatter must tokenize as frontmatter key (`type`) with zero navigable tokens.
    const fmRowIdx = doc.lineFirstRowIndex[1];
    const fmRow = doc.rows[fmRowIdx];
    assert.equal(fmRow.segments[0]?.[0], "type");
    assert.equal(fmRow.segments.filter((seg) => seg[2]?.nav).length, 0);

    // Line 7 (`const result = computeValue();`) inside fenced JS block should tokenize syntax (`keyword` for const).
    const fenceRowIdx = doc.lineFirstRowIndex[6];
    const fenceRow = doc.rows[fenceRowIdx];
    assert.ok(fenceRow.segments.some((seg) => seg[0] === "keyword" && seg[1].includes("const")));
    assert.equal(fenceRow.segments.filter((seg) => seg[2]?.nav).length, 0);
  });

  test("disambiguation dropdown works with real normalizeNavCandidate output and monotonic navSeq breaks same-ms ties", () => {
    const c1 = normalizeNavCandidate({
      filePath: "/repo/billing/src/StripeGateway.java",
      root: "/repo/billing",
      serviceId: "bill",
      serviceName: "billing",
      line: 27,
      column: 17,
      name: "charge",
      kind: "implementation",
      containerName: "StripeGateway",
      signature: "public void charge(int cents)",
    });
    const c2 = normalizeNavCandidate({
      filePath: "/repo/orders/src/FallbackGateway.java",
      root: "/repo/orders",
      serviceId: "orders",
      serviceName: "orders",
      line: 14,
      column: 10,
      name: "charge",
      kind: "implementation",
      containerName: "FallbackGateway",
    });

    const items = buildDisambiguationDropdownItems([c1, c2], "/repo/billing", "billing");
    assert.equal(items.length, 2);
    assert.equal(items[0].label, "StripeGateway.charge");
    assert.equal(items[0].subline, "src/StripeGateway.java:27");
    assert.equal(items[0].badge, "");
    assert.equal(items[1].label, "FallbackGateway.charge");
    assert.equal(items[1].subline, "src/FallbackGateway.java:14");
    assert.equal(items[1].badge, "orders");

    const fixedTs = 1700000000123;
    const first = applyTabNavMeta({ tabId: "t1", line: 10, updatedAt: fixedTs }, { column: 5, highlightSymbol: "foo", navSeq: 1 });
    const second = applyTabNavMeta({ tabId: "t1", line: 42, updatedAt: fixedTs }, { column: 9, highlightSymbol: "bar", navSeq: 2 });
    assert.equal(first.updatedAt, second.updatedAt);
    assert.ok(second.navSeq > first.navSeq);
    assert.equal(second.line, 42);
    assert.equal(second.highlightSymbol, "bar");

    assert.equal(shouldOpenNavInNewTab("/repo/a.js", "/repo/a.js", null, null, false), false);
    assert.equal(shouldOpenNavInNewTab("/repo/b.js", "/repo/a.js", null, null, false), true);
    assert.equal(shouldOpenNavInNewTab("/repo/a.js", "/repo/a.js", "ssh-box", null, false), true);
    assert.equal(shouldOpenNavInNewTab("C:\\Repo\\Sub\\File.ts", "C:/repo/sub/file.ts", null, null, true), false);
  });

  test("buildWrappedViewerDocument reuses tokenizedLines across width resizes with identical output and clips huge plain lines", () => {
    const sample = [
      'import { helper } from "./helper.js";',
      "export function computeTotal(items, discountRate = 0.15) {",
      '  const label = "order_summary_value_that_wraps_across_multiple_visual_rows";',
      "  return items.map((x) => helper(x, label, discountRate));",
      "}",
      `const tail = "${"x".repeat(MAX_PREVIEW_RENDER_LINE_CHARS + 250)}";`,
    ].join("\n");

    const coldNarrow = buildWrappedViewerDocument(sample, "/repo/src/calc.js", 28);
    assert.ok(Array.isArray(coldNarrow.tokenizedLines));
    assert.equal(coldNarrow.tokenizedLines.length, coldNarrow.totalLines);

    // Resize to wide width reusing tokenizedLines without re-tokenizing
    const warmWide = buildWrappedViewerDocument("", "/repo/src/calc.js", 110, {
      tokenizedLines: coldNarrow.tokenizedLines,
      truncated: coldNarrow.truncated,
    });
    const coldWide = buildWrappedViewerDocument(sample, "/repo/src/calc.js", 110);

    assert.deepEqual(warmWide.rows, coldWide.rows);
    assert.deepEqual(warmWide.lineFirstRowIndex, coldWide.lineFirstRowIndex);
    assert.deepEqual(warmWide.lineRowCounts, coldWide.lineRowCounts);
    assert.equal(warmWide.totalLines, coldWide.totalLines);
    assert.equal(warmWide.truncated, coldWide.truncated);

    // Resize back to very narrow width
    const warmNarrow2 = buildWrappedViewerDocument("", "/repo/src/calc.js", 24, {
      tokenizedLines: coldNarrow.tokenizedLines,
      truncated: coldNarrow.truncated,
    });
    const coldNarrow2 = buildWrappedViewerDocument(sample, "/repo/src/calc.js", 24);
    assert.deepEqual(warmNarrow2.rows, coldNarrow2.rows);
    assert.deepEqual(warmNarrow2.lineFirstRowIndex, coldNarrow2.lineFirstRowIndex);
    assert.deepEqual(warmNarrow2.lineRowCounts, coldNarrow2.lineRowCounts);

    // Plain/unknown-extension ultra-long line clipping + computeCodeContentWidth tab-free/charPx guards
    const hugePlain = `${"a".repeat(MAX_PREVIEW_RENDER_LINE_CHARS + 500)}\nshort\tline\n`;
    const plainDoc = buildWrappedViewerDocument(hugePlain, "/repo/raw.unknownext", 20000);
    assert.equal(plainDoc.rows[0].segments[0][1].endsWith("\u00a0…"), true);
    assert.ok(plainDoc.rows[0].segments[0][1].length <= MAX_PREVIEW_RENDER_LINE_CHARS + 4);
    assert.equal(
      computeCodeContentWidth(["plain ascii", "\tindented"]),
      computeCodeContentWidth(["plain ascii", "    indented"]),
    );
    assert.equal(computeCodeContentWidth(["abc"], { charPx: Number.NaN, minWidth: 240, gutterPx: 92 }), 240);
  });

  test("buildDisambiguationHeaderMeta, buildDisambiguationDropdownItems, and computeLocalAnchorRect provide consistent target clarity and local anchors", () => {
    const implHeader = buildDisambiguationHeaderMeta({ symbol: "ChatService", mode: "implementations", count: 3 });
    assert.equal(implHeader.title, "Implementations of ChatService");
    assert.equal(implHeader.countText, "3 matches");
    assert.equal(implHeader.hintText, "↑↓ · Enter · Esc");

    assert.equal(buildDisambiguationHeaderMeta({ symbol: "getTenantId", mode: "declarations", count: 1 }).countText, "1 match");
    assert.equal(buildDisambiguationHeaderMeta({ symbol: "ask", mode: "references", count: 4 }).title, "Usages of ask");
    assert.equal(buildDisambiguationHeaderMeta({ symbol: "User", mode: "", count: 2 }).title, "Go to User");

    const rows = buildDisambiguationDropdownItems([
      {
        filePath: "/repo/app/src/ChatImpl.java",
        root: "/repo/app",
        line: 27,
        column: 12,
        containerName: "ChatImpl",
        name: "ask",
        kind: "method",
      },
    ], "/repo/app", "");
    assert.equal(rows[0].height, 44);
    assert.equal(rows[0].rightText, ":27");

    // Bounds-based anchor converts window coords to container-local rect accurately
    const fromBounds = computeLocalAnchorRect(
      { bounds: { x: 140, y: 260, width: 88, height: 18 } },
      { x: 100, y: 120, width: 700, height: 500 },
      { x: 12, y: 12 },
    );
    assert.deepEqual(fromBounds, { x: 40, y: 140, bottomY: 158 });

    // Position fallback when bounds absent
    const fromPos = computeLocalAnchorRect(
      { position: { x: 250, y: 300 } },
      { x: 100, y: 100, width: 700, height: 500 },
      null,
    );
    assert.deepEqual(fromPos, { x: 150, y: 190, bottomY: 210 });

    // Container pointer fallback when neither bounds nor position are present
    assert.deepEqual(computeLocalAnchorRect({}, null, { x: 85, y: 95 }), { x: 85, y: 85, bottomY: 105 });
    assert.equal(computeLocalAnchorRect({}, null, null), null);
  });

  test("shouldAllowUnderlyingScroll blocks file/preview/list scrolling while a disambiguation dropdown is open", () => {
    assert.equal(shouldAllowUnderlyingScroll({}), true);
    assert.equal(shouldAllowUnderlyingScroll({ hasDisambiguationPopover: false, closed: false, selectTextMode: false }), true);
    assert.equal(shouldAllowUnderlyingScroll({ hasDisambiguationPopover: true }), false);
    assert.equal(shouldAllowUnderlyingScroll({ selectTextMode: true }), false);
    assert.equal(shouldAllowUnderlyingScroll({ closed: true }), false);
  });
});
