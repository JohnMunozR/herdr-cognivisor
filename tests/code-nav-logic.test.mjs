import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  detectNavLanguage,
  maskNonCodeRegions,
  countCallArity,
  extractNavContext,
  createNavHistoryState,
  pushNavHistory,
  canStepNavBack,
  canStepNavForward,
  stepNavBack,
  stepNavForward,
  rankNavCandidates,
  expandedColToRawCol,
} from "../shared/code-nav-logic.js";

describe("shared code-nav-logic core helpers", () => {
  test("detectNavLanguage recognizes JS/TS, Python, and Java extensions cleanly", () => {
    assert.equal(detectNavLanguage("src/App.tsx"), "js");
    assert.equal(detectNavLanguage("worker.mjs"), "js");
    assert.equal(detectNavLanguage("api/routes.py"), "python");
    assert.equal(detectNavLanguage("stubs.pyi"), "python");
    assert.equal(detectNavLanguage("src/main/java/OrderService.java"), "java");
    assert.equal(detectNavLanguage("README.md"), null);
  });

  test("maskNonCodeRegions blanks comments and strings while preserving exact character lengths and template expressions", () => {
    const jsSample = [
      "// const fake = 1;",
      "const msg = `hello ${user.name} // keep`; /* block",
      "const ignored = 2; */ const real = 3;",
    ];
    const maskedJs = maskNonCodeRegions(jsSample, "js");
    assert.equal(maskedJs.length, 3);
    assert.equal(maskedJs[0].length, jsSample[0].length);
    assert.equal(maskedJs[0].trim(), "");
    assert.equal(maskedJs[1].length, jsSample[1].length);
    assert.ok(maskedJs[1].includes("user.name"));
    assert.ok(!maskedJs[1].includes("keep"));
    assert.ok(!maskedJs[2].includes("ignored"));
    assert.ok(maskedJs[2].includes("const real = 3;"));

    const pySample = [
      "'''docstring with def fake():'''",
      'text = f"val={compute(item)} # inside string" # comment',
    ];
    const maskedPy = maskNonCodeRegions(pySample, "python");
    assert.equal(maskedPy[0].length, pySample[0].length);
    assert.equal(maskedPy[0].trim(), "");
    assert.equal(maskedPy[1].length, pySample[1].length);
    assert.ok(maskedPy[1].includes("compute(item)"));
    assert.ok(!maskedPy[1].includes("comment"));
    assert.ok(!maskedPy[1].includes("inside"));
  });

  test("extractNavContext distinguishes variables vs calls, qualifier chains, annotations, import strings, and arity", () => {
    const js = [
      'import { fetchUser } from "./api/client";',
      "const user = await this.userService.fetchUser(id, { full: true });",
      "const x = user;",
    ].join("\n");

    const onImportStr = extractNavContext(js, 1, 29, "src/index.ts");
    assert.ok(onImportStr);
    assert.equal(onImportStr.isImportLine, true);
    assert.equal(onImportStr.importModuleSpec, "./api/client");

    const onMethodCall = extractNavContext(js, 2, 39, "src/index.ts");
    assert.ok(onMethodCall);
    assert.equal(onMethodCall.symbol, "fetchUser");
    assert.deepEqual(onMethodCall.qualifierChain, ["this", "userService", "fetchUser"]);
    assert.equal(onMethodCall.memberIndex, 2);
    assert.equal(onMethodCall.isCall, true);
    assert.equal(onMethodCall.intent, "implementation");
    assert.equal(onMethodCall.arity, 2);

    const onVarRef = extractNavContext(js, 3, 12, "src/index.ts");
    assert.ok(onVarRef);
    assert.equal(onVarRef.symbol, "user");
    assert.equal(onVarRef.isCall, false);
    assert.equal(onVarRef.intent, "declaration");

    const java = [
      "@Override",
      "public User findById(Long id) {",
      "    return repo.findById(id);",
      "}",
    ].join("\n");
    const onAnn = extractNavContext(java, 1, 4, "Repo.java");
    assert.equal(onAnn.symbol, "Override");
    assert.equal(onAnn.isAnnotation, true);

    const onComment = extractNavContext("// hello world", 1, 5, "a.js");
    assert.equal(onComment, null);

    assert.equal(expandedColToRawCol("\tconst a = 1;", 5, 4), 2);
    assert.equal(countCallArity(["foo()"], 0, 3), 0);
    assert.equal(countCallArity(["foo(a, bar(1, 2), c)"], 0, 3), 3);

    const strCallCtx = extractNavContext('new Controller("a")', 1, 6, "App.java");
    assert.equal(strCallCtx?.arity, 1);
    const commentCallCtx = extractNavContext('foo(/* "a" */)', 1, 2, "app.js");
    assert.equal(commentCallCtx?.arity, 0);
    const pyCommentCallCtx = extractNavContext('foo(# "a"\n)', 1, 2, "app.py");
    assert.equal(pyCommentCallCtx?.arity, 0);
  });

  test("navigation history stack supports push, back, forward, and branch truncation", () => {
    let hist = createNavHistoryState(10);
    assert.equal(canStepNavBack(hist), false);
    assert.equal(canStepNavForward(hist), false);

    const a = { root: "/r", path: "a.js", line: 10, column: 5, symbol: "foo" };
    const b = { root: "/r", path: "b.js", line: 22, column: 1, symbol: "foo" };
    const c = { root: "/r", path: "c.js", line: 8, column: 3, symbol: "bar" };

    hist = pushNavHistory(hist, a, b);
    assert.equal(canStepNavBack(hist), true);
    assert.equal(canStepNavForward(hist), false);

    const back1 = stepNavBack(hist);
    assert.equal(back1.entry.path, "a.js");
    assert.equal(canStepNavForward(back1.state), true);

    const fwd1 = stepNavForward(back1.state);
    assert.equal(fwd1.entry.path, "b.js");

    const branched = pushNavHistory(back1.state, a, c);
    assert.equal(canStepNavForward(branched), false);
    assert.equal(branched.entries.length, 2);
    assert.equal(branched.entries[1].path, "c.js");
  });

  test("rankNavCandidates prefers concrete implementations over abstract ones for implementation intent and deduplicates", () => {
    const cands = [
      { filePath: "IRepo.java", line: 5, column: 10, name: "save", isAbstract: true, arity: 1, score: 80 },
      { filePath: "SqlRepo.java", line: 14, column: 15, name: "save", isAbstract: false, arity: 1, score: 80 },
      { filePath: "SqlRepo.java", line: 14, column: 15, name: "save", isAbstract: false, arity: 1, score: 70 },
    ];
    const ranked = rankNavCandidates(cands, { intent: "implementation", arity: 1 });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].filePath, "SqlRepo.java");
  });

  test("maskNonCodeRegions masks JS regex literals (including // and inside templates) while keeping division ops intact", () => {
    const src = [
      "const rel = line.replace(/^\\.\\//, \"\");",
      "const urlRe = /^https?:\\/\\/[^\\s]+/i;",
      "const tpl = `prefix ${raw.replace(/\\\\/g, \"/\")} suffix`;",
      "const ratio = (totalCount / pageSize) + 1;",
      "function stillVisibleAfterRegex() { return rel; }",
    ];
    const masked = maskNonCodeRegions(src, "js");
    assert.equal(masked.length, src.length);
    for (let i = 0; i < src.length; i += 1) {
      assert.equal(masked[i].length, src[i].length);
    }
    assert.ok(!masked[0].includes("^\\."));
    assert.ok(!masked[1].includes("https"));
    assert.ok(masked[2].includes("raw.replace(") && !masked[2].includes("prefix") && !masked[2].includes("suffix"));
    assert.ok(masked[3].includes("totalCount / pageSize"));
    assert.ok(masked[4].includes("function stillVisibleAfterRegex"));
  });

  test("extractNavContext distinguishes multiline signatures, type vs ternary/call-arg context, and @Annotation attributes", () => {
    const javaSrc = [
      "package com.acme;",
      "import jakarta.persistence.Column;",
      "public class Sample implements Runnable, Comparable<Sample> {",
      "  @Column(name = \"tenant_id\", nullable = false)",
      "  private String tenantId;",
      "  public ResponseEntity<String>",
      "  createItem(",
      "    Map<String, List<Sample>> lookup,",
      "    boolean flag",
      "  ) {",
      "    for (Document chunk : rawChunks) {",
      "      var val = flag ? chunk : fallback;",
      "      helper(chunk, fallback);",
      "    }",
      "  }",
      "}",
    ].join("\n");

    const lines = javaSrc.split("\n");
    const colOf = (l, needle) => lines[l - 1].indexOf(needle) + 1;

    // Multiline method signature -> declaration signature
    const ctxSig = extractNavContext(javaSrc, 7, colOf(7, "createItem"), "Sample.java");
    assert.equal(ctxSig.isDeclarationSignature, true);

    // Comma inside generic `Map<String, List<Sample>>` & `implements ..., Comparable` -> type context
    const ctxGen = extractNavContext(javaSrc, 8, colOf(8, "List"), "Sample.java");
    assert.equal(ctxGen.isTypeContext, true);
    const ctxImpl = extractNavContext(javaSrc, 3, colOf(3, "Comparable"), "Sample.java");
    assert.equal(ctxImpl.isTypeContext, true);

    // Enhanced-for `rawChunks` after `:` and ternary `:` branch `fallback` -> NOT type context
    const ctxFor = extractNavContext(javaSrc, 11, colOf(11, "rawChunks"), "Sample.java");
    assert.equal(ctxFor.isTypeContext, false);
    const ctxTern = extractNavContext(javaSrc, 12, colOf(12, "fallback"), "Sample.java");
    assert.equal(ctxTern.isTypeContext, false);

    // Comma in call args `helper(chunk, fallback)` -> NOT type context
    const ctxArg = extractNavContext(javaSrc, 13, colOf(13, "fallback"), "Sample.java");
    assert.equal(ctxArg.isTypeContext, false);

    // Annotation attribute `@Column(name = ...)` -> sets enclosingAnnotation
    const ctxAttr = extractNavContext(javaSrc, 4, colOf(4, "name"), "Sample.java");
    assert.equal(ctxAttr.enclosingAnnotation, "Column");
    const ctxAnn = extractNavContext(javaSrc, 4, colOf(4, "Column"), "Sample.java");
    assert.equal(ctxAnn.enclosingAnnotation || null, null);

    // TypeScript parameter type annotation `:` STILL marks type context
    const tsSrc = "function run(item: OrderItem, count: number): OrderResult {\n  return make(item, count);\n}\n";
    const tsLines = tsSrc.split("\n");
    const tsCol = (l, n) => tsLines[l - 1].indexOf(n) + 1;
    assert.equal(extractNavContext(tsSrc, 1, tsCol(1, "OrderItem"), "run.ts").isTypeContext, true);
    assert.equal(extractNavContext(tsSrc, 1, tsCol(1, "OrderResult"), "run.ts").isTypeContext, true);
    assert.equal(extractNavContext(tsSrc, 2, tsCol(2, "count"), "run.ts").isTypeContext, false);
  });
});
