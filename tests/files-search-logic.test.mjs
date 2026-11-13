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
});
