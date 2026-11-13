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

    assert.equal(rustTokens.map(([, v]) => v).join(""), "fn parse<'a>(input: &'a str) -> char { 'x' }");
    assert.equal(tokenizeDiffLine("x".repeat(501), "js"), null, "long lines should bypass tokenization cleanly");
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
});
