import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MARKDOWN_MAX_CHARS,
  getFileExtension,
  isMarkdownFile,
  splitMarkdownFrontmatter,
  truncateMarkdownSafely,
  detectMdxCues,
  prepareMarkdownForRender,
  classifyMarkdownLink,
  isSafeExternalUrl,
  resolveRelativeMarkdownPath,
  getDiffMarkdownPlan,
} from "../shared/markdown-view-logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("shared markdown view logic & cross-mod sync parity", () => {
  test("shared markdown-view-logic.js, markdown-view.js, and markdown-syntax.js stay byte-identical across consuming mods", () => {
    for (const file of ["markdown-syntax.js", "markdown-view-logic.js", "markdown-view.js"]) {
      const canonical = readFileSync(resolve(ROOT, "shared", file), "utf8");
      for (const mod of ["files-search", "changes-review", "git-history"]) {
        const modCopy = readFileSync(resolve(ROOT, "mods", mod, file), "utf8");
        assert.equal(modCopy, canonical, `mods/${mod}/${file} must match shared/${file} verbatim`);
      }
    }
  });

  test("getFileExtension and isMarkdownFile classify .md/.mdx case-insensitively and reject non-markdown paths", () => {
    assert.equal(getFileExtension("/repo/docs/SPEC.md"), "md");
    assert.equal(getFileExtension("guides/intro.MDX"), "mdx");
    assert.equal(getFileExtension("C:\\work\\notes\\plan.Md"), "md");
    assert.equal(getFileExtension(".gitignore"), "");
    assert.equal(getFileExtension("README"), "");

    assert.equal(isMarkdownFile("README.md"), true);
    assert.equal(isMarkdownFile("docs/guide.MDX"), true);
    assert.equal(isMarkdownFile("md"), true);
    assert.equal(isMarkdownFile(".mdx"), true);
    assert.equal(isMarkdownFile("src/main.js"), false);
    assert.equal(isMarkdownFile(".gitignore"), false);
    assert.equal(isMarkdownFile(""), false);
  });

  test("splitMarkdownFrontmatter strips valid YAML frontmatter (CRLF + BOM + nested list) and keeps clean body", () => {
    const doc = [
      "\uFEFF---",
      "id: spec-markdown",
      "title: Rendered Preview",
      "tags:",
      "  - gpui",
      "  - markdown",
      "---",
      "",
      "# Heading",
      "",
      "Body text.",
    ].join("\r\n");

    const parsed = splitMarkdownFrontmatter(doc);
    assert.equal(parsed.hasFrontmatter, true);
    assert.deepEqual(parsed.frontmatterEntries, [
      { key: "id", value: "spec-markdown" },
      { key: "title", value: "Rendered Preview" },
      { key: "tags", value: "gpui, markdown" },
    ]);
    assert.equal(parsed.extraEntriesCount, 0);
    assert.equal(parsed.body, "# Heading\n\nBody text.");
  });

  test("splitMarkdownFrontmatter does not eat document if unclosed or interrupted by Markdown heading", () => {
    const thematicBreakBeforeHeading = "---\n\n# Real Heading\n\n---\n\nFooter";
    const res = splitMarkdownFrontmatter(thematicBreakBeforeHeading);
    assert.equal(res.hasFrontmatter, false);
    assert.equal(res.body, thematicBreakBeforeHeading);

    const unclosed = "---\ntitle: Oops\njust text without closer";
    const res2 = splitMarkdownFrontmatter(unclosed);
    assert.equal(res2.hasFrontmatter, false);
    assert.equal(res2.body, unclosed);
  });

  test("truncateMarkdownSafely respects UTF-16 surrogate pairs, aligns newlines, and auto-closes unclosed fences", () => {
    const shortDoc = "Hello world";
    assert.deepEqual(truncateMarkdownSafely(shortDoc, 100), {
      text: shortDoc,
      truncated: false,
      omittedChars: 0,
    });

    const fencedDoc = [
      "# Code Sample",
      "",
      "```javascript",
      "const a = 1;",
      "const emoji = '😀';",
      "const b = 2;",
      "```",
      "After fence",
    ].join("\n");

    const trunc = truncateMarkdownSafely(fencedDoc, 48);
    assert.equal(trunc.truncated, true);
    assert.ok(trunc.omittedChars > 0);
    assert.ok(trunc.text.endsWith("\n```\n"), `expected closing fence, got: ${JSON.stringify(trunc.text)}`);

    // Surrogate boundary check (high surrogate at cut - 1)
    const pairStr = "abcd😀efgh"; // index 4 = high surrogate, index 5 = low surrogate
    const pairTrunc = truncateMarkdownSafely(pairStr, 5);
    assert.equal(pairTrunc.truncated, true);
    const lastCode = pairTrunc.text.charCodeAt(pairTrunc.text.length - 1);
    assert.ok(!(lastCode >= 0xd800 && lastCode <= 0xdbff), "must not leave lone trailing high surrogate");
  });

  test("detectMdxCues and prepareMarkdownForRender handle MDX outside vs inside fenced code blocks", () => {
    const plainMdx = "# Title\n\n```tsx\nimport { Box } from 'ui';\n<Box />\n```\n";
    assert.equal(detectMdxCues(plainMdx), false);
    const resPlain = prepareMarkdownForRender(plainMdx, { filePath: "doc.mdx" });
    assert.equal(resPlain.isMdx, true);
    assert.equal(resPlain.hasMdxSyntax, false);

    const jsxMdx = "# Title\n\n<Callout kind=\"info\">Hello</Callout>\n";
    assert.equal(detectMdxCues(jsxMdx), true);
    const resJsx = prepareMarkdownForRender(jsxMdx, { filePath: "doc.mdx" });
    assert.equal(resJsx.isMdx, true);
    assert.equal(resJsx.hasMdxSyntax, true);

    const fmOnly = "---\ntitle: Only Frontmatter\n---\n";
    const resFm = prepareMarkdownForRender(fmOnly, { filePath: "meta.md" });
    assert.equal(resFm.hasFrontmatter, true);
    assert.equal(resFm.isEmpty, false);

    assert.equal(prepareMarkdownForRender("   \n\t ", { filePath: "empty.md" }).isEmpty, true);
    assert.ok(DEFAULT_MARKDOWN_MAX_CHARS >= 100000);
  });

  test("classifyMarkdownLink and isSafeExternalUrl guard cx.open_url against unsafe or relative schemes", () => {
    assert.deepEqual(classifyMarkdownLink("https://herdr.dev/docs"), {
      kind: "external",
      url: "https://herdr.dev/docs",
    });
    assert.equal(isSafeExternalUrl("http://localhost:8080/health"), true);
    assert.equal(classifyMarkdownLink("#section-two").kind, "anchor");
    assert.equal(classifyMarkdownLink("./SPEC.md").kind, "relative");
    assert.equal(classifyMarkdownLink("../architecture.md#top").kind, "relative");

    for (const bad of [
      "",
      "https://",
      "http:///path",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "mailto:dev@example.com",
      "https://bad url.com",
    ]) {
      assert.equal(isSafeExternalUrl(bad), false, `must reject unsafe URL: ${bad}`);
      assert.equal(classifyMarkdownLink(bad).kind, "unsupported", `must mark unsupported: ${bad}`);
    }
  });

  test("resolveRelativeMarkdownPath resolves sibling and parent paths cleanly while guarding relative escapes", () => {
    assert.equal(
      resolveRelativeMarkdownPath("/repo/mods/files-search/SPEC.md", "./main.js#L10"),
      "/repo/mods/files-search/main.js"
    );
    assert.equal(
      resolveRelativeMarkdownPath("mods/files-search/SPEC.md", "../../shared/SPEC.md?view=1#inv"),
      "shared/SPEC.md"
    );
    assert.equal(resolveRelativeMarkdownPath("SPEC.md", "../../outside.md"), null);
    assert.equal(resolveRelativeMarkdownPath("SPEC.md", "#only-anchor"), null);
    assert.equal(resolveRelativeMarkdownPath("SPEC.md", "https://example.com"), null);
  });

  test("getDiffMarkdownPlan switches deleted files to before snapshot with notice banner", () => {
    const del = getDiffMarkdownPlan("D");
    assert.equal(del.mode, "before");
    assert.equal(del.isDeleted, true);
    assert.ok(del.notice.length > 0);

    for (const status of ["M", "A", "R", "C", "U", "??", "fresh", ""]) {
      const plan = getDiffMarkdownPlan(status);
      assert.equal(plan.mode, "after");
      assert.equal(plan.isDeleted, false);
      assert.equal(plan.notice, "");
    }
  });
});
