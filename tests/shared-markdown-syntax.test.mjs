import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isMarkdownExt,
  createMarkdownState,
  getMarkdownStateTag,
  advanceMarkdownState,
  tokenizeMarkdownLine,
} from "../shared/markdown-syntax.js";
import { tokenizeCodeLine } from "../mods/files-search/search-logic.js";
import {
  tokenizeDiffLine,
  buildSideBySideRows,
  buildUnifiedRows,
  tokenizeSideBySidePage,
  tokenizeDeferredRow,
} from "../mods/git-history/diff-logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function joinTokens(tokens) {
  return Array.isArray(tokens) ? tokens.map(([, chunk]) => chunk).join("") : "";
}

function assertLossless(line, tokens, label = line) {
  assert.ok(Array.isArray(tokens) && tokens.length > 0, `expected tokens for ${label}`);
  assert.equal(joinTokens(tokens), line, `token text mismatch for ${label}`);
}

describe("shared markdown-syntax tokenizer & mod parity", () => {
  test("mods/files-search and mods/git-history markdown-syntax.js match shared/markdown-syntax.js byte-identically", () => {
    const canonical = readFileSync(resolve(ROOT, "shared/markdown-syntax.js"), "utf8");
    for (const rel of [
      "mods/files-search/markdown-syntax.js",
      "mods/git-history/markdown-syntax.js",
    ]) {
      const actual = readFileSync(resolve(ROOT, rel), "utf8");
      assert.equal(actual, canonical, `${rel} must match shared/markdown-syntax.js verbatim`);
    }
  });

  test("isMarkdownExt, createMarkdownState, and empty lines behave cleanly", () => {
    assert.equal(isMarkdownExt("md"), true);
    assert.equal(isMarkdownExt("mdx"), true);
    assert.equal(isMarkdownExt("MD"), true);
    assert.equal(isMarkdownExt("Mdx"), true);
    assert.equal(isMarkdownExt("js"), false);
    assert.equal(isMarkdownExt("txt"), false);
    assert.equal(isMarkdownExt(""), false);
    assert.equal(isMarkdownExt(null), false);

    assert.deepEqual(createMarkdownState(), {
      lineIndex: 0,
      inFrontmatter: false,
      frontmatterClosed: false,
      fence: null,
      fenceLang: "",
    });

    const st = createMarkdownState();
    assert.equal(tokenizeMarkdownLine("", st), null);
    assert.equal(st.lineIndex, 1, "empty line should still advance lineIndex");
    assert.equal(tokenizeMarkdownLine(null), null);
  });

  test("prose containing code keywords, quotes, apostrophes, handles, numbers, and math stays strictly plain", () => {
    const proseLines = [
      'This is in class and or not for from type "quoted text" with \'apostrophes\' and isn\'t.',
      "Contact @user or @RestController about 60fps, 42 retries, a - b, x * y, c + d, p / q -> z.",
      "SQL words like SELECT FROM WHERE NULL in normal text and #hashtag or C# stay calm.",
      "Markdown **bold text**, *italic*, __underline__, and ~~strike~~ stay calm without rainbow noise.",
      'Array<string> or x < 5 > 3 and arr[0] or [TODO] or [!NOTE] stay plain.',
    ];

    for (const line of proseLines) {
      const tokens = tokenizeMarkdownLine(line);
      assertLossless(line, tokens);
      assert.deepEqual(tokens, [["plain", line]], `prose line leaked non-plain tokens: ${JSON.stringify(tokens)}`);
      for (const [kind] of tokens) {
        assert.notEqual(kind, "keyword");
        assert.notEqual(kind, "operator");
        assert.notEqual(kind, "annotation");
        assert.notEqual(kind, "number");
        assert.notEqual(kind, "string");
      }
    }
  });

  test("ATX headings style # markers as keyword and keep heading titles coherent without breaking on quotes/keywords", () => {
    const heading = '## What\'s New in "Service-A" and Class B - Part 1';
    const tokens = tokenizeMarkdownLine(heading);
    assertLossless(heading, tokens);
    assert.deepEqual(tokens, [
      ["keyword", "##"],
      ["plain", " "],
      ["function", 'What\'s New in "Service-A" and Class B - Part 1'],
    ]);

    const h6 = "  ###### Deep Heading";
    assert.deepEqual(tokenizeMarkdownLine(h6), [
      ["plain", "  "],
      ["keyword", "######"],
      ["plain", " "],
      ["function", "Deep Heading"],
    ]);

    assert.deepEqual(tokenizeMarkdownLine("#"), [["keyword", "#"]]);
    assert.deepEqual(tokenizeMarkdownLine("####### Seven"), [["plain", "####### Seven"]]);
    assert.deepEqual(tokenizeMarkdownLine("#hashtag"), [["plain", "#hashtag"]]);
  });

  test("YAML frontmatter parses line 0 --- through closing --- with type keys and plain values, and skips line > 0", () => {
    const lines = [
      "---",
      'title: "What is in a class and why?"',
      "draft: false",
      "order: 42",
      "tags:",
      "  - markdown",
      "# yaml comment",
      "---",
      "title: outside frontmatter is plain prose",
      "---",
    ];

    const state = createMarkdownState();
    const out = lines.map((l) => tokenizeMarkdownLine(l, state, tokenizeCodeLine));
    lines.forEach((l, i) => assertLossless(l, out[i]));

    assert.deepEqual(out[0], [["comment", "---"]]);
    assert.deepEqual(out[1], [
      ["type", "title"],
      ["comment", ":"],
      ["plain", ' "What is in a class and why?"'],
    ]);
    assert.deepEqual(out[2], [
      ["type", "draft"],
      ["comment", ":"],
      ["plain", " false"],
    ]);
    assert.deepEqual(out[3], [
      ["type", "order"],
      ["comment", ":"],
      ["plain", " 42"],
    ]);
    assert.deepEqual(out[4], [
      ["type", "tags"],
      ["comment", ":"],
    ]);
    assert.deepEqual(out[5], [
      ["plain", "  "],
      ["comment", "-"],
      ["plain", " markdown"],
    ]);
    assert.deepEqual(out[6], [["comment", "# yaml comment"]]);
    assert.deepEqual(out[7], [["comment", "---"]]);
    assert.deepEqual(out[8], [["plain", "title: outside frontmatter is plain prose"]]);
    assert.deepEqual(out[9], [["comment", "---"]]);

    // If line 0 is non-frontmatter, --- on line 1 is a horizontal rule and does not open frontmatter.
    const st2 = createMarkdownState();
    assert.deepEqual(tokenizeMarkdownLine("# Intro", st2), [
      ["keyword", "#"],
      ["plain", " "],
      ["function", "Intro"],
    ]);
    assert.deepEqual(tokenizeMarkdownLine("---", st2), [["comment", "---"]]);
    assert.equal(st2.inFrontmatter, false);
    assert.deepEqual(tokenizeMarkdownLine("title: prose", st2), [["plain", "title: prose"]]);
  });

  test("fenced code blocks delegate code languages, keep unlabeled/txt/markdown fences plain, and respect fence length", () => {
    const doc = [
      "```javascript",
      "const count = 42; // ok",
      "```",
      "```",
      "const prose = in class and or 42;",
      "```",
      "~~~txt",
      "if true then return 1",
      "~~~",
      "````markdown",
      "# Not an active outer heading",
      "```",
      "````",
      '```ts title="demo.ts"',
      "\tconst tabbed: string = 'ok';",
      "```",
    ];

    const state = createMarkdownState();
    const out = doc.map((l) => tokenizeMarkdownLine(l, state, tokenizeCodeLine));
    doc.forEach((l, i) => assertLossless(l, out[i]));

    assert.deepEqual(out[0], [
      ["comment", "```"],
      ["type", "javascript"],
    ]);
    assert.ok(out[1].some(([k, v]) => k === "keyword" && v === "const"));
    assert.ok(out[1].some(([k, v]) => k === "number" && v === "42"));
    assert.ok(out[1].some(([k, v]) => k === "comment" && v === "// ok"));
    assert.deepEqual(out[2], [["comment", "```"]]);

    // Unlabeled fence stays plain
    assert.deepEqual(out[3], [["comment", "```"]]);
    assert.deepEqual(out[4], [["plain", "const prose = in class and or 42;"]]);
    assert.deepEqual(out[5], [["comment", "```"]]);

    // ~~~txt stays plain
    assert.deepEqual(out[6], [
      ["comment", "~~~"],
      ["type", "txt"],
    ]);
    assert.deepEqual(out[7], [["plain", "if true then return 1"]]);
    assert.deepEqual(out[8], [["comment", "~~~"]]);

    // ````markdown stays plain and is NOT closed by 3 backticks
    assert.deepEqual(out[9], [
      ["comment", "````"],
      ["type", "markdown"],
    ]);
    assert.deepEqual(out[10], [["plain", "# Not an active outer heading"]]);
    assert.deepEqual(out[11], [["plain", "```"]]);
    assert.deepEqual(out[12], [["comment", "````"]]);

    // Info string attributes & lossless tab restoration inside delegated fence
    assert.deepEqual(out[13], [
      ["comment", "```"],
      ["type", 'ts title="demo.ts"'],
    ]);
    assert.equal(out[14][0][1], "\t");
    assert.ok(out[14].some(([k, v]) => k === "keyword" && v === "const"));
    assert.equal(joinTokens(out[14]), "\tconst tabbed: string = 'ok';");
    assert.deepEqual(out[15], [["comment", "```"]]);

    // Single-line triple-backtick inline code is NOT an opening fence
    const stInline = createMarkdownState();
    const inlineThree = tokenizeMarkdownLine("```inline code``` and more", stInline, tokenizeCodeLine);
    assert.equal(stInline.fence, null);
    assert.deepEqual(inlineThree, [
      ["string", "```inline code```"],
      ["plain", " and more"],
    ]);
  });

  test("horizontal rules, blockquotes, lists, and task checkboxes style prefixes calmly", () => {
    for (const hr of ["---", "***", "___", " - - - ", "-----"]) {
      const toks = tokenizeMarkdownLine(hr);
      assertLossless(hr, toks);
      assert.deepEqual(toks, [["comment", hr]]);
    }

    const bq1 = "> Quoted prose with `const x = 1` and [link](https://a.test)";
    const bq1Toks = tokenizeMarkdownLine(bq1);
    assertLossless(bq1, bq1Toks);
    assert.deepEqual(bq1Toks, [
      ["comment", ">"],
      ["plain", " Quoted prose with "],
      ["string", "`const x = 1`"],
      ["plain", " and "],
      ["comment", "["],
      ["function", "link"],
      ["comment", "](https://a.test)"],
    ]);

    const bq2 = "> > Nested quote";
    assert.deepEqual(tokenizeMarkdownLine(bq2), [
      ["comment", ">"],
      ["plain", " "],
      ["comment", ">"],
      ["plain", " Nested quote"],
    ]);

    const bullet = "- Item with mid-line a - b * c + d / e and `code`";
    const bulletToks = tokenizeMarkdownLine(bullet);
    assertLossless(bullet, bulletToks);
    assert.deepEqual(bulletToks, [
      ["comment", "-"],
      ["plain", " Item with mid-line a - b * c + d / e and "],
      ["string", "`code`"],
    ]);

    const todo = "  * [ ] Pending task";
    assert.deepEqual(tokenizeMarkdownLine(todo), [
      ["plain", "  "],
      ["comment", "*"],
      ["plain", " "],
      ["comment", "[ ]"],
      ["plain", " Pending task"],
    ]);

    const doneLower = "1. [x] Completed and verified";
    assert.deepEqual(tokenizeMarkdownLine(doneLower), [
      ["comment", "1."],
      ["plain", " "],
      ["constant", "[x]"],
      ["plain", " Completed and verified"],
    ]);

    const doneUpper = "12) [X] Uppercase check";
    assert.deepEqual(tokenizeMarkdownLine(doneUpper), [
      ["comment", "12)"],
      ["plain", " "],
      ["constant", "[X]"],
      ["plain", " Uppercase check"],
    ]);

    const listWithLink = "- [API Docs](https://example.com)";
    assert.deepEqual(tokenizeMarkdownLine(listWithLink), [
      ["comment", "-"],
      ["plain", " "],
      ["comment", "["],
      ["function", "API Docs"],
      ["comment", "](https://example.com)"],
    ]);
  });

  test("inline scanner handles escapes, multi-backtick spans, links, images, autolinks, and HTML comments", () => {
    const escaped = String.raw`Escaped \*not italic\*, \`not code\`, \[not link\](u), \\backslash`;
    const escToks = tokenizeMarkdownLine(escaped);
    assertLossless(escaped, escToks);
    assert.deepEqual(escToks, [["plain", escaped]]);

    const codeSpan = "Use ``const x = `y` in class`` instead of `SELECT * FROM users`.";
    const codeToks = tokenizeMarkdownLine(codeSpan);
    assertLossless(codeSpan, codeToks);
    assert.deepEqual(codeToks, [
      ["plain", "Use "],
      ["string", "``const x = `y` in class``"],
      ["plain", " instead of "],
      ["string", "`SELECT * FROM users`"],
      ["plain", "."],
    ]);

    const linksImg = 'See ![arch](img/a.png), [Wiki](https://en.wikipedia.org/wiki/Foo_(bar) "Title"), and <https://herdr.dev>.';
    const linkToks = tokenizeMarkdownLine(linksImg);
    assertLossless(linksImg, linkToks);
    assert.deepEqual(linkToks, [
      ["plain", "See "],
      ["comment", "!["],
      ["function", "arch"],
      ["comment", "](img/a.png)"],
      ["plain", ", "],
      ["comment", "["],
      ["function", "Wiki"],
      ["comment", '](https://en.wikipedia.org/wiki/Foo_(bar) "Title")'],
      ["plain", ", and "],
      ["function", "<https://herdr.dev>"],
      ["plain", "."],
    ]);

    const htmlComment = "Before <!-- hidden const x = 1 --> after <http://localhost:3000>";
    const commentToks = tokenizeMarkdownLine(htmlComment);
    assertLossless(htmlComment, commentToks);
    assert.deepEqual(commentToks, [
      ["plain", "Before "],
      ["comment", "<!-- hidden const x = 1 -->"],
      ["plain", " after "],
      ["function", "<http://localhost:3000>"],
    ]);

    // Unclosed link followed by valid link still parses the valid link
    const unclosedThenValid = "Check [unclosed and [valid](https://ok.test) plus ``unclosed ticks";
    const uvToks = tokenizeMarkdownLine(unclosedThenValid);
    assertLossless(unclosedThenValid, uvToks);
    assert.deepEqual(uvToks, [
      ["plain", "Check [unclosed and "],
      ["comment", "["],
      ["function", "valid"],
      ["comment", "](https://ok.test)"],
      ["plain", " plus ``unclosed ticks"],
    ]);
  });

  test("linear O(n) safety on pathological nested brackets, parens, and backticks", () => {
    const start = performance.now();
    const evilBrackets = "[".repeat(4000) + "[a](b)";
    const bToks = tokenizeMarkdownLine(evilBrackets);
    assertLossless(evilBrackets, bToks);
    assert.ok(bToks.some(([k, v]) => k === "function" && v === "a"));

    const evilAlternating = "[[a]".repeat(1500) + "](x)";
    assertLossless(evilAlternating, tokenizeMarkdownLine(evilAlternating));

    const evilParens = "[a](".repeat(1500) + ")";
    assertLossless(evilParens, tokenizeMarkdownLine(evilParens));

    const evilTicks = "` ".repeat(2500);
    assertLossless(evilTicks, tokenizeMarkdownLine(evilTicks));
    const elapsedMs = performance.now() - start;
    assert.ok(elapsedMs < 250, `expected linear scan < 250ms, took ${elapsedMs.toFixed(1)}ms`);
  });

  test("advanceMarkdownState and getMarkdownStateTag track frontmatter and fence transitions accurately", () => {
    const st = createMarkdownState();
    assert.equal(getMarkdownStateTag(st), "md");
    advanceMarkdownState("---", st);
    assert.equal(st.inFrontmatter, true);
    assert.equal(getMarkdownStateTag(st), "fm");
    advanceMarkdownState("title: Hello", st);
    assert.equal(getMarkdownStateTag(st), "fm");
    advanceMarkdownState("---", st);
    assert.equal(st.inFrontmatter, false);
    assert.equal(getMarkdownStateTag(st), "md");
    advanceMarkdownState("```ts", st);
    assert.equal(getMarkdownStateTag(st), "f:```:ts");
    advanceMarkdownState("const x = 1;", st);
    assert.equal(getMarkdownStateTag(st), "f:```:ts");
    advanceMarkdownState("```", st);
    assert.equal(getMarkdownStateTag(st), "md");
  });

  test("tokenizeCodeLine (files-search) handles .md/.mdx statelessly and statefully without rainbow noise", () => {
    const prose = 'This is in class and or not "quoted" with 42 and @user - ok';
    for (const ext of ["md", "mdx", "MD"]) {
      const toks = tokenizeCodeLine(prose, ext);
      assertLossless(prose, toks);
      assert.deepEqual(toks, [["plain", prose]]);
    }

    const st = createMarkdownState();
    const lines = [
      "---",
      "title: Guide",
      "---",
      "# Overview",
      "```js",
      "const ok = true;",
      "```",
      "- [x] Ready",
    ];
    const tokenized = lines.map((l) => tokenizeCodeLine(l, "md", st));
    assert.deepEqual(tokenized[1], [
      ["type", "title"],
      ["comment", ":"],
      ["plain", " Guide"],
    ]);
    assert.deepEqual(tokenized[3], [
      ["keyword", "#"],
      ["plain", " "],
      ["function", "Overview"],
    ]);
    assert.ok(tokenized[5].some(([k, v]) => k === "keyword" && v === "const"));
    assert.ok(tokenized[5].some(([k, v]) => k === "boolean" && v === "true"));
    assert.deepEqual(tokenized[7], [
      ["comment", "-"],
      ["plain", " "],
      ["constant", "[x]"],
      ["plain", " Ready"],
    ]);
  });

  test("tokenizeDiffLine, buildSideBySideRows, and buildUnifiedRows (git-history) handle .md/.mdx cleanly", () => {
    const prose = 'Service is in class and "quotes" with 60fps @dev - check';
    for (const ext of ["md", "mdx"]) {
      const toks = tokenizeDiffLine(prose, ext);
      assertLossless(prose, toks);
      assert.deepEqual(toks, [["plain", prose]]);
    }

    const patch = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,6 +1,8 @@",
      " ---",
      " title: Cognivisor",
      " ---",
      "-Old prose in class and 12",
      "+New prose in class with `inlineCode` and [link](https://x.dev)",
      " ```js",
      "+const added = 42;",
      " ```",
    ].join("\n");

    const sbsEager = buildSideBySideRows(patch, "README.md");
    assert.deepEqual(sbsEager.rows[2].left.tokens, [
      ["type", "title"],
      ["comment", ":"],
      ["plain", " Cognivisor"],
    ]);
    assert.deepEqual(sbsEager.rows[4].left.tokens, [["plain", "Old prose in class and 12"]]);
    assert.ok(sbsEager.rows[4].right.tokens.some(([k, v]) => k === "string" && v === "`inlineCode`"));
    assert.ok(sbsEager.rows[4].right.tokens.some(([k, v]) => k === "function" && v === "link"));
    assert.ok(sbsEager.rows[6].right.tokens.some(([k, v]) => k === "keyword" && v === "const"));
    assert.ok(sbsEager.rows[6].right.tokens.some(([k, v]) => k === "number" && v === "42"));

    // Deferred SBS + tokenizeSideBySidePage matches eager tokenization
    const sbsDeferred = buildSideBySideRows(patch, "docs/guide.mdx", { deferTokens: true });
    tokenizeSideBySidePage(sbsDeferred.rows, "mdx");
    assert.deepEqual(sbsDeferred.rows[2].left.tokens, sbsEager.rows[2].left.tokens);
    assert.deepEqual(sbsDeferred.rows[4].right.tokens, sbsEager.rows[4].right.tokens);
    assert.deepEqual(sbsDeferred.rows[6].right.tokens, sbsEager.rows[6].right.tokens);

    // Deferred Unified + out-of-order tokenizeDeferredRow preserves fence and frontmatter state
    const uniDeferred = buildUnifiedRows(patch, "README.md", { deferTokens: true });
    const fmRow = uniDeferred.rows.find((r) => r.text === "title: Cognivisor");
    const fenceCodeRow = uniDeferred.rows.find((r) => r.text === "const added = 42;");
    const proseRow = uniDeferred.rows.find((r) => r.text === "Old prose in class and 12");
    tokenizeDeferredRow(fenceCodeRow, "md");
    tokenizeDeferredRow(fmRow, "md");
    tokenizeDeferredRow(proseRow, "md");
    assert.deepEqual(fmRow.tokens, [
      ["type", "title"],
      ["comment", ":"],
      ["plain", " Cognivisor"],
    ]);
    assert.ok(fenceCodeRow.tokens.some(([k, v]) => k === "keyword" && v === "const"));
    assert.deepEqual(proseRow.tokens, [["plain", "Old prose in class and 12"]]);
  });
});
