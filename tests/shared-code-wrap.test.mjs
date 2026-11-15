import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TAB_SIZE,
  computeWrapColumns,
  codeUnitEndForColumns,
  expandTabsFromColumn,
  expandTabs,
  computeWrapRanges,
  countWrappedLines,
  wrapPlainText,
  wrapStyledSpans,
} from "../shared/code-wrap.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("shared code-wrap engine & mod parity", () => {
  test("mods/files-search, mods/changes-review, and mods/git-history stay byte-identical to shared/code-wrap.js", () => {
    const canonical = readFileSync(resolve(ROOT, "shared/code-wrap.js"), "utf8");
    for (const rel of [
      "mods/files-search/code-wrap.js",
      "mods/changes-review/code-wrap.js",
      "mods/git-history/code-wrap.js",
    ]) {
      const actual = readFileSync(resolve(ROOT, rel), "utf8");
      assert.equal(actual, canonical, `${rel} must match shared/code-wrap.js verbatim`);
    }
  });

  test("computeWrapColumns adapts cleanly to narrower/wider viewports and handles fallbacks", () => {
    assert.equal(DEFAULT_TAB_SIZE, 4);
    assert.equal(computeWrapColumns({ viewportWidth: 0, fallbackCols: 72 }), 72);
    assert.equal(computeWrapColumns({ viewportWidth: -10, fallbackCols: 64 }), 64);

    const wide = computeWrapColumns({ viewportWidth: 800, gutterWidth: 60, rightPadding: 20, fontSize: 11.5 });
    const mid = computeWrapColumns({ viewportWidth: 500, gutterWidth: 60, rightPadding: 20, fontSize: 11.5 });
    const narrow = computeWrapColumns({ viewportWidth: 120, gutterWidth: 60, rightPadding: 20, fontSize: 11.5, minCols: 10 });
    assert.ok(wide > mid && mid > narrow);
    assert.equal(narrow, 10);
  });

  test("expandTabs expands tabs using column-aligned tab stops and strips CR", () => {
    assert.equal(expandTabs("\thello\r"), "    hello");
    assert.equal(expandTabs("ab\tcd"), "ab  cd");
    const part1 = expandTabsFromColumn("a", 0, 4);
    assert.equal(part1.endCol, 1);
    const part2 = expandTabsFromColumn("\tb", part1.endCol, 4);
    assert.equal(part2.text, "   b");
    assert.equal(part2.endCol, 5);
  });

  test("wrapPlainText wraps long lines losslessly without splitting UTF-16 surrogate pairs", () => {
    assert.deepEqual(wrapPlainText("", 20), [""]);
    assert.deepEqual(wrapPlainText("short line", 40), ["short line"]);

    const src = "const result = computeVeryLongFunctionName(alphaParam, betaParam, gammaParam);";
    const wrapped = wrapPlainText(src, 32);
    assert.ok(wrapped.length >= 3);
    assert.equal(wrapped.join(""), src);
    for (const seg of wrapped) {
      assert.ok([...seg].length <= 32, `segment exceeded 32 cols: ${seg}`);
    }

    // Surrogate-pair safety (astral code point counts as 1 column and never splits)
    const emojis = "🚀🔥✨🎯🚀🔥✨🎯";
    const emojiWrapped = wrapPlainText(emojis, 3);
    assert.equal(emojiWrapped.join(""), emojis);
    assert.equal(emojiWrapped.length, 3);
    assert.deepEqual(emojiWrapped.map((s) => [...s].length), [3, 3, 2]);
    assert.equal(codeUnitEndForColumns("🚀a", 0, 1), 2);
  });

  test("wrapPlainText converts spaces to NBSP without changing wrap break boundaries", () => {
    const line = "function processLongRequest(firstArgument, secondArgument) { return true; }";
    const plain = wrapPlainText(line, 28, { toNbsp: false });
    const nbsp = wrapPlainText(line, 28, { toNbsp: true });
    assert.equal(nbsp.length, plain.length);
    for (let i = 0; i < plain.length; i += 1) {
      assert.equal(nbsp[i].replace(/\u00a0/g, " "), plain[i]);
    }
    assert.deepEqual(computeWrapRanges("abcdef", 4), [[0, 4], [4, 6]]);
  });

  test("wrapStyledSpans preserves [kind, text] tuple syntax colors and object spans across continuation rows", () => {
    assert.deepEqual(wrapStyledSpans([], 20), [[]]);
    assert.deepEqual(wrapStyledSpans([["plain", ""]], 20), [[]]);

    const tuples = [
      ["keyword", "const"],
      ["plain", " "],
      ["variable", "extremelyLongConfigurationIdentifier"],
      ["plain", " = "],
      ["string", "\"jdbc:postgresql://localhost:5432/microservices_db\""],
      ["plain", ";"],
    ];
    const wrappedTuples = wrapStyledSpans(tuples, 26, { toNbsp: true });
    assert.ok(wrappedTuples.length >= 3);

    const reconstructed = wrappedTuples
      .map((row) => row.map(([, text]) => text).join(""))
      .join("")
      .replace(/\u00a0/g, " ");
    const original = tuples.map(([, text]) => text).join("");
    assert.equal(reconstructed, original);
    assert.equal(wrappedTuples[0][0][0], "keyword");
    assert.equal(wrappedTuples[0][0][1], "const");
    assert.ok(
      wrappedTuples.some((row) => row.some(([kind, text]) => kind === "string" && text.includes("microservices_db")))
    );

    const objSpans = [
      { text: "prefix text ", match: false },
      { text: "matchedQueryToken", match: true },
      { text: " trailing suffix after the match", match: false },
    ];
    const wrappedObjs = wrapStyledSpans(objSpans, 18, { toNbsp: false });
    assert.ok(wrappedObjs.length >= 3);
    assert.equal(wrappedObjs.map((r) => r.map((s) => s.text).join("")).join(""), objSpans.map((s) => s.text).join(""));
    assert.ok(wrappedObjs.flat().some((s) => s.match === true));

    // 3rd-tuple metadata { col, nav } is preserved and column-shifted on wrapped continuation slices
    const interactive = [
      ["keyword", "const", { col: 1, nav: false }],
      ["plain", " ", { col: 6, nav: false }],
      ["plain", "extremelyLongIdentifierThatWrapsAcrossLines", { col: 7, nav: true }],
    ];
    const wrappedInteractive = wrapStyledSpans(interactive, 20, { toNbsp: false });
    assert.ok(wrappedInteractive.length >= 3);
    assert.deepEqual(wrappedInteractive[0][2], ["plain", "extremelyLongI", { col: 7, nav: true }]);
    assert.deepEqual(wrappedInteractive[1][0], ["plain", "dentifierThatWrapsAc", { col: 21, nav: true }]);
    assert.deepEqual(wrappedInteractive[2][0], ["plain", "rossLines", { col: 41, nav: true }]);

    // Single-span tuple wrap also shifts col metadata cleanly
    const singleLong = [["plain", "abcdefghijklmnopqrstuvwxyz", { col: 1, nav: true }]];
    const wrappedSingle = wrapStyledSpans(singleLong, 10, { toNbsp: false });
    assert.deepEqual(wrappedSingle, [
      [["plain", "abcdefghij", { col: 1, nav: true }]],
      [["plain", "klmnopqrst", { col: 11, nav: true }]],
      [["plain", "uvwxyz", { col: 21, nav: true }]],
    ]);
  });

  test("countWrappedLines matches wrapPlainText(...).length across tabs, surrogates, and narrow widths", () => {
    const samples = [
      "",
      "short",
      "const x = 1;",
      "\t\tindented\tcolumn\tvalues\tacross\tmany\ttab\tstops",
      "emoji🚀🎉unicode🔥clusters with spaces and.punctuation,splits;here/and:there",
      "superlongcontinuousidentifierwithoutanywhitespacesorthings1234567890",
      "line\r\n",
    ];
    for (const s of samples) {
      for (const cols of [1, 4, 12, 24, 60, 120]) {
        assert.equal(
          countWrappedLines(s, cols),
          wrapPlainText(s, cols).length,
          `mismatch for cols=${cols} sample=${JSON.stringify(s)}`
        );
      }
    }
  });
});
