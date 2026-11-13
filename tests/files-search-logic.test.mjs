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
      resolveViewerFilePath("C:\\work\\mesh\\", "auth-service\\src\\..\\Main.java"),
      "C:/work/mesh/auth-service/Main.java"
    );
    assert.equal(
      resolveViewerFilePath("C:/work/mesh", "D:\\elsewhere\\config.yml"),
      "D:/elsewhere/config.yml"
    );
    assert.equal(
      resolveViewerFilePath("\\\\fileserver\\share\\repo", "dir\\sub\\..\\mod.rs"),
      "//fileserver/share/repo/dir/mod.rs"
    );
  });

  test("buildFileViewerKey normalizes equivalent targets and respects case sensitivity", () => {
    const k1 = buildFileViewerKey("/work/mesh", "auth-service/src/AuthController.java", false);
    const k2 = buildFileViewerKey("/work/mesh/auth-service", "src/./AuthController.java", false);
    const k3 = buildFileViewerKey("", "/work/mesh/auth-service/src/AuthController.java", false);
    assert.equal(k1, "/work/mesh/auth-service/src/AuthController.java");
    assert.equal(k2, k1);
    assert.equal(k3, k1);

    // POSIX preserves case while Windows folds case for deduplication
    assert.notEqual(
      buildFileViewerKey("/work/mesh", "src/Main.java", false),
      buildFileViewerKey("/work/mesh", "src/main.java", false)
    );
    assert.equal(
      buildFileViewerKey("C:\\Work\\Mesh", "Src\\Main.Java", true),
      buildFileViewerKey("C:/work/mesh", "src/main.java", true)
    );
    assert.equal(buildFileViewerKey("/work/mesh", "   ", false), "");
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
        root: "/workspace/mesh",
        path: "auth-service/src/AuthController.java",
        absPath: "/workspace/mesh/auth-service/src/AuthController.java",
      },
      "tab-space2-auth": {
        tabId: "tab-space2-auth",
        spaceId: "space-2",
        root: "/workspace/mesh",
        path: "auth-service/src/AuthController.java",
        absPath: "/workspace/mesh/auth-service/src/AuthController.java",
      },
      "tab-win": {
        tabId: "tab-win",
        spaceId: "space-1",
        root: "C:\\Work\\Mesh",
        path: "gateway\\App.ts",
        absPath: "C:/Work/Mesh/gateway/App.ts",
      },
    };

    // Opening from sub-service root or absolute path matches the existing space-1 tab
    const hitFromSubroot = findMatchingOpenFileTab(
      openTabs,
      ["tab-space1-auth", "tab-win"],
      ["tab-space1-auth", "tab-space2-auth", "tab-win"],
      "/workspace/mesh/auth-service",
      "src/AuthController.java",
      false
    );
    assert.equal(hitFromSubroot?.tabId, "tab-space1-auth");

    // Space without that file tab must NOT reuse a viewer tab belonging to another space
    const missInSpace3 = findMatchingOpenFileTab(
      openTabs,
      ["tab-space3-term"],
      ["tab-space1-auth", "tab-space2-auth"],
      "/workspace/mesh",
      "auth-service/src/AuthController.java",
      false
    );
    assert.equal(missInSpace3, null);

    // Pane that is no longer a files-search pane cannot be reused
    const stalePane = findMatchingOpenFileTab(
      openTabs,
      ["tab-space1-auth"],
      ["tab-win"],
      "/workspace/mesh",
      "auth-service/src/AuthController.java",
      false
    );
    assert.equal(stalePane, null);

    // Windows case-insensitive dedupe match
    const winHit = findMatchingOpenFileTab(
      openTabs,
      ["tab-space1-auth", "tab-win"],
      ["tab-space1-auth", "tab-win"],
      "c:/work/mesh",
      "GATEWAY/app.ts",
      true
    );
    assert.equal(winHit?.tabId, "tab-win");
    assert.equal(findMatchingOpenFileTab(null, ["tab-1"], ["tab-1"], "/repo", "a.ts"), null);
  });
});
