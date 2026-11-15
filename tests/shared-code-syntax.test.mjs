import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_PREVIEW_SYNTAX_LINE_CHARS,
  getSyntaxExt,
  resolveEditorLanguage,
  getSyntaxPalette,
  getDiffSyntaxPalette,
  syntaxTokenStyle,
  diffSyntaxTokenColor,
  expandCodeTabs,
  createCodeSyntaxState,
  getSyntaxStateTag,
  cloneSyntaxState,
  advanceSyntaxState,
  tokenizeCodeLine,
  tokenizeInteractiveCodeLine,
} from "../shared/code-syntax.js";
import { buildWrappedViewerDocument } from "../mods/files-search/search-logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("shared code-syntax engine & interactive token splitting", () => {
  test("mods/files-search, mods/changes-review, and mods/git-history stay byte-identical to shared/code-syntax.js", () => {
    const canonical = readFileSync(resolve(ROOT, "shared/code-syntax.js"), "utf8");
    for (const rel of [
      "mods/files-search/code-syntax.js",
      "mods/changes-review/code-syntax.js",
      "mods/git-history/code-syntax.js",
    ]) {
      assert.equal(readFileSync(resolve(ROOT, rel), "utf8"), canonical, `${rel} must match shared/code-syntax.js`);
    }
  });

  test("tokenizeInteractiveCodeLine isolates standalone plain identifiers with 1-based tab-expanded columns", () => {
    const line = "\tconst total = computeSum(alpha, beta_2); // keep trailing";
    const tokens = tokenizeInteractiveCodeLine(line, "js");
    assert.ok(Array.isArray(tokens));
    assert.equal(tokens.map(([, text]) => text).join(""), expandCodeTabs(line));

    const findTok = (target) => tokens.find(([, text]) => text === target);
    const constTok = findTok("const");
    assert.equal(constTok[0], "keyword");
    assert.deepEqual(constTok[2], { col: 5, nav: false });

    const totalTok = findTok("total");
    assert.equal(totalTok[0], "plain");
    assert.deepEqual(totalTok[2], { col: 11, nav: true });

    const callTok = findTok("computeSum");
    assert.equal(callTok[0], "function");
    assert.deepEqual(callTok[2], { col: 19, nav: true });

    const alphaTok = findTok("alpha");
    assert.equal(alphaTok[0], "plain");
    assert.deepEqual(alphaTok[2], { col: 30, nav: true });

    const betaTok = findTok("beta_2");
    assert.equal(betaTok[0], "plain");
    assert.deepEqual(betaTok[2], { col: 37, nav: true });

    const commentTok = tokens.find(([kind]) => kind === "comment");
    assert.ok(commentTok);
    assert.equal(commentTok[2].nav, false);
  });

  test("tokenizeInteractiveCodeLine distinguishes navigable vs non-navigable tokens in Java, Python, and JS imports", () => {
    // Java line: primitive int is non-navigable, UserService and @Override and MAX_RETRIES are navigable, null is non-navigable
    const javaToks = tokenizeInteractiveCodeLine("@Override public int count(UserService svc) { return svc == null ? MAX_RETRIES : 0; }", "java");
    const byText = (arr, word) => arr.find(([, t]) => t === word);
    assert.equal(byText(javaToks, "@Override")[2].nav, true);
    assert.equal(byText(javaToks, "public")[2].nav, false);
    assert.equal(byText(javaToks, "int")[2].nav, false);
    assert.equal(byText(javaToks, "UserService")[2].nav, true);
    assert.equal(byText(javaToks, "null")[2].nav, false);
    assert.equal(byText(javaToks, "MAX_RETRIES")[2].nav, true);

    // Import lines mark strings as navigable for JS/TS/Python, non-import strings remain non-navigable
    const importToks = tokenizeInteractiveCodeLine('import { foo } from "./utils/helper";', "ts");
    const importStr = importToks.find(([kind]) => kind === "string");
    assert.ok(importStr && importStr[2].nav === true);

    const normalStrToks = tokenizeInteractiveCodeLine('const path = "./utils/helper";', "ts");
    const normalStr = normalStrToks.find(([kind]) => kind === "string");
    assert.ok(normalStr && normalStr[2].nav === false);

    // Python None is non-navigable, self.fetch and custom_var are navigable
    const pyToks = tokenizeInteractiveCodeLine("result = self.fetch(item_id) if item_id is not None else DEFAULT_ID", "py");
    assert.equal(byText(pyToks, "None")[2].nav, false);
    assert.equal(byText(pyToks, "self")[2].nav, true);
    assert.equal(byText(pyToks, "fetch")[2].nav, true);
    assert.equal(byText(pyToks, "item_id")[2].nav, true);
    assert.equal(byText(pyToks, "DEFAULT_ID")[2].nav, true);
  });

  test("tokenizeCodeLine and palette helpers honor options and length caps", () => {
    const longLine = "a".repeat(MAX_PREVIEW_SYNTAX_LINE_CHARS + 5);
    assert.equal(tokenizeCodeLine(longLine, "js"), null);
    // Still splits short plain lines even on txt fallback? txt/log stay non-syntax on tokenizeCodeLine
    assert.equal(tokenizeCodeLine("foo bar", "txt"), null);
    const plainFallback = tokenizeInteractiveCodeLine("foo bar", "txt");
    assert.deepEqual(plainFallback, [
      ["plain", "foo", { col: 1, nav: true }],
      ["plain", " ", { col: 4, nav: false }],
      ["plain", "bar", { col: 5, nav: true }],
    ]);

    assert.equal(getSyntaxExt("Dockerfile"), "dockerfile");
    assert.equal(resolveEditorLanguage("app.tsx"), "js");

    const darkTheme = { is_dark: true, ansi1: "#e06c75", ansi4: "#61afef", foreground: "#abb2bf" };
    assert.equal(syntaxTokenStyle("function", darkTheme).color, getSyntaxPalette(darkTheme).function);
    assert.equal(diffSyntaxTokenColor("type", darkTheme), getDiffSyntaxPalette(darkTheme).type);
  });

  test("createCodeSyntaxState and advanceSyntaxState persist Java/Python block comments and triple-quoted strings with nav: false", () => {
    const javaLines = [
      "/** Javadoc header",
      " * Calls TenantService.createTenant here",
      " */",
      'String sql = """',
      "  SELECT Tenant FROM User WHERE active = true",
      '  """;',
      "String res = computeResult();",
    ];
    let st = createCodeSyntaxState("java");
    const initialTag = getSyntaxStateTag(st);
    const snap = cloneSyntaxState(st);
    assert.equal(getSyntaxStateTag(snap), initialTag);

    const perLine = [];
    for (const line of javaLines) {
      perLine.push({
        tagBefore: getSyntaxStateTag(st),
        tokens: tokenizeInteractiveCodeLine(line, "java", cloneSyntaxState(st)) || [],
      });
      st = advanceSyntaxState(line, st, "java");
    }

    assert.notEqual(perLine[1].tagBefore, initialTag);
    assert.equal(perLine[1].tokens.filter((t) => t[2]?.nav).length, 0);
    assert.equal(perLine[1].tokens[0][0], "comment");

    assert.notEqual(perLine[4].tagBefore, initialTag);
    assert.equal(perLine[4].tokens.filter((t) => t[2]?.nav).length, 0);
    assert.equal(perLine[4].tokens[0][0], "string");

    assert.equal(getSyntaxStateTag(st), initialTag);
    assert.ok(perLine[6].tokens.some((t) => t[1] === "computeResult" && t[2]?.nav === true));

    // Python """ docstring persistence
    let pyState = advanceSyntaxState('"""', createCodeSyntaxState("py"), "py");
    assert.equal(pyState.tripleQuote, '"""');
    const pyInnerToks = tokenizeInteractiveCodeLine("TenantService inside docstring", "py", cloneSyntaxState(pyState)) || [];
    assert.equal(pyInnerToks.filter((t) => t[2]?.nav).length, 0);
    pyState = advanceSyntaxState('"""', pyState, "py");
    assert.equal(pyState.tripleQuote, null);

    // Integration with search-logic.buildWrappedViewerDocument
    const doc = buildWrappedViewerDocument(javaLines.join("\n"), "/repo/SqlRepo.java", 100);
    const commentRow = doc.rows[doc.lineFirstRowIndex[1]];
    const textBlockRow = doc.rows[doc.lineFirstRowIndex[4]];
    const codeRow = doc.rows[doc.lineFirstRowIndex[6]];
    assert.equal(commentRow.segments.filter((s) => s[2]?.nav).length, 0);
    assert.equal(textBlockRow.segments.filter((s) => s[2]?.nav).length, 0);
    assert.ok(codeRow.segments.some((s) => s[1] === "computeResult" && s[2]?.nav === true));
  });
});
