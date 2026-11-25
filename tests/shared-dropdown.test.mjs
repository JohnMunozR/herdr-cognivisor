import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REOPEN_GUARD_MS,
  DEFAULT_SEARCH_BAR_HEIGHT,
  clampDropdownNumber,
  computeDropdownMetrics,
  computeAnchoredPopoverPosition,
  shouldSuppressDropdownReopen,
  filterDropdownItems,
  findFirstSelectableDropdownOption,
} from "../shared/dropdown-logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("shared dropdown engine & git-history sync parity", () => {
  test("mods/git-history/dropdown-logic.js and dropdown.js stay byte-identical to shared/", () => {
    for (const file of ["dropdown-logic.js", "dropdown.js"]) {
      const canonical = readFileSync(resolve(ROOT, "shared", file), "utf8");
      const modCopy = readFileSync(resolve(ROOT, "mods/git-history", file), "utf8");
      assert.equal(modCopy, canonical, `mods/git-history/${file} must match shared/${file} verbatim`);
    }
  });

  test("clampDropdownNumber clamps numbers cleanly and handles non-finite or reversed bounds", () => {
    assert.equal(clampDropdownNumber(200, 170, 340), 200);
    assert.equal(clampDropdownNumber(100, 170, 340), 170);
    assert.equal(clampDropdownNumber(500, 170, 340), 340);
    assert.equal(clampDropdownNumber(Number.NaN, 170, 340), 170);
    assert.equal(clampDropdownNumber(undefined, 170, 340), 170);
    assert.equal(clampDropdownNumber(220, 200, 150), 200);
  });

  test("computeDropdownMetrics shrink-wraps empty and single-item lists without enabling scroll", () => {
    const emptyMetrics = computeDropdownMetrics({
      items: [],
      panelWidth: 420,
      minWidth: 180,
      maxWidth: 340,
      maxHeight: 320,
    });
    assert.deepEqual(emptyMetrics, {
      width: 180,
      contentHeight: 41,
      bodyHeight: 41,
      shouldScroll: false,
    });

    const singleItem = computeDropdownMetrics({
      items: [{ type: "option", label: "All Branches", rightText: "--all" }],
      panelWidth: 420,
      minWidth: 180,
      maxWidth: 340,
      maxHeight: 320,
    });
    assert.equal(singleItem.shouldScroll, false);
    assert.equal(singleItem.contentHeight, 41);
    assert.equal(singleItem.bodyHeight, 41);
    assert.equal(singleItem.width, 180);

    const twoItems = computeDropdownMetrics({
      items: [
        { type: "option", label: "All Branches", rightText: "--all" },
        { type: "divider" },
        { type: "section", label: "Local branches" },
        { type: "option", label: "main", dotColor: "#61afef", rightText: "885a77d" },
      ],
      panelWidth: 420,
      minWidth: 180,
      maxWidth: 340,
      maxHeight: 320,
    });
    // rows: 31 + 9 + 26 + 31 = 97; gaps: 3 * 1 = 3; padding: 5 * 2 = 10 => 110
    assert.equal(twoItems.contentHeight, 110);
    assert.equal(twoItems.bodyHeight, 110);
    assert.equal(twoItems.shouldScroll, false);
    assert.ok(twoItems.width >= 180 && twoItems.width <= 240);
  });

  test("computeDropdownMetrics sizes moderate lists with subline, badge, and meta cleanly", () => {
    const items = [
      {
        type: "option",
        label: "auth-service",
        subline: "feature/oauth2-pkce-refresh",
        sublineBadge: "ahead",
        badge: "12",
        dotColor: "#ffaa00",
        height: 42,
      },
      {
        type: "option",
        label: "api-gateway",
        meta: "(clean)",
        subline: "main",
        dotColor: "#00cc66",
        height: 42,
      },
      { type: "empty", label: "No other services" },
    ];
    const metrics = computeDropdownMetrics({
      items,
      panelWidth: 420,
      minWidth: 180,
      maxWidth: 340,
      maxHeight: 320,
    });
    // rows: 42 + 42 + 31 = 115; gaps: 2 * 1 = 2; padding: 5 * 2 = 10 => 127
    assert.equal(metrics.contentHeight, 127);
    assert.equal(metrics.bodyHeight, 127);
    assert.equal(metrics.shouldScroll, false);
    assert.ok(metrics.width > 180 && metrics.width <= 340, `expected dynamic width in (180, 340], got ${metrics.width}`);
  });

  test("computeDropdownMetrics activates scroll and caps bodyHeight at maxHeight for long lists", () => {
    const items = [
      { type: "option", label: "All Branches", rightText: "--all" },
      { type: "divider" },
      { type: "section", label: "Local branches" },
    ];
    for (let i = 0; i < 20; i += 1) {
      items.push({
        type: "option",
        label: `feature/branch-item-${i}`,
        rightText: "885a77d",
      });
    }
    const metrics = computeDropdownMetrics({
      items,
      panelWidth: 420,
      minWidth: 180,
      maxWidth: 340,
      maxHeight: 320,
    });
    // rows: 31 + 9 + 26 + 20 * 31 = 686; gaps: 22 * 1 = 22; padding: 10 => 718
    assert.equal(metrics.contentHeight, 718);
    assert.equal(metrics.shouldScroll, true);
    assert.equal(metrics.bodyHeight, 320);
    assert.ok(metrics.width >= 180 && metrics.width <= 340);
  });

  test("computeDropdownMetrics clamps width safely on narrow panels", () => {
    const longBranchItems = [
      {
        type: "option",
        label: "origin/feature/very-long-cross-service-branch-name-that-exceeds-panel",
        rightText: "885a77d",
        height: 26,
      },
    ];

    const narrow = computeDropdownMetrics({
      items: longBranchItems,
      panelWidth: 240,
      minWidth: 170,
      maxWidth: 340,
      marginX: 20,
    });
    assert.equal(narrow.width, 220);
    assert.equal(narrow.shouldScroll, false);

    const ultraNarrow = computeDropdownMetrics({
      items: longBranchItems,
      panelWidth: 150,
      minWidth: 170,
      maxWidth: 340,
      marginX: 20,
    });
    assert.equal(ultraNarrow.width, 170);
  });

  test("shouldSuppressDropdownReopen prevents same-click backdrop dismiss + trigger reopen races", () => {
    const t0 = 1700000000000;
    assert.equal(shouldSuppressDropdownReopen(t0, t0), true);
    assert.equal(shouldSuppressDropdownReopen(t0, t0 + 12), true);
    assert.equal(shouldSuppressDropdownReopen(t0, t0 + DEFAULT_REOPEN_GUARD_MS - 1), true);
    assert.equal(shouldSuppressDropdownReopen(t0, t0 + DEFAULT_REOPEN_GUARD_MS), false);
    assert.equal(shouldSuppressDropdownReopen(t0, t0 + 250), false);
    assert.equal(shouldSuppressDropdownReopen(undefined, t0), false);
    assert.equal(shouldSuppressDropdownReopen(0, t0), false);
    assert.equal(shouldSuppressDropdownReopen(t0, t0 - 5), false);
  });

  test("computeDropdownMetrics accounts for subline rows, fixed headers, and chromeTopHeight without clipping", () => {
    const items = [];
    for (let i = 0; i < 7; i += 1) {
      items.push({
        type: "option",
        label: `Impl${i}.execute`,
        subline: `src/services/Impl${i}.java:${10 + i}`,
        rightText: `→ Ln ${10 + i}`,
      });
    }
    // Without subline awareness (7 * 31 = 217), 7 items wouldn't trigger scroll against 280px maxHeight;
    // with 44px subline height + 32px header + 10px pad + 6px gap = 356px > 280px, scroll activates cleanly.
    const metrics = computeDropdownMetrics({
      items,
      panelWidth: 800,
      minWidth: 280,
      maxWidth: 460,
      maxHeight: 280,
      chromeTopHeight: 32,
      headerTitle: "Implementations of veryLongMethodName",
    });
    assert.equal(metrics.shouldScroll, true);
    assert.equal(metrics.bodyHeight, 280);
    assert.ok(metrics.contentHeight > 280);
    assert.ok(metrics.width >= 280 && metrics.width <= 460);
  });

  test("computeAnchoredPopoverPosition clamps near left/right/bottom edges and centers cleanly when unanchored", () => {
    // Far-left word must never place left < marginX (behind left limit)
    const farLeft = computeAnchoredPopoverPosition({
      anchorX: 4,
      anchorY: 120,
      anchorBottomY: 140,
      popoverWidth: 360,
      popoverHeight: 180,
      containerWidth: 900,
      containerHeight: 600,
      marginX: 12,
      marginTop: 46,
      marginBottom: 14,
    });
    assert.equal(farLeft.left, 12);
    assert.equal(farLeft.top, 146);
    assert.equal(farLeft.placement, "below");

    // Far-right word shifts leftward so menu fits strictly within right margin
    const farRight = computeAnchoredPopoverPosition({
      anchorX: 860,
      anchorY: 120,
      anchorBottomY: 140,
      popoverWidth: 360,
      popoverHeight: 180,
      containerWidth: 900,
      containerHeight: 600,
      marginX: 12,
      marginTop: 46,
      marginBottom: 14,
    });
    assert.equal(farRight.left, 900 - 360 - 12);
    assert.equal(farRight.top, 146);

    // Near bottom edge flips cleanly above the clicked token
    const nearBottom = computeAnchoredPopoverPosition({
      anchorX: 200,
      anchorY: 500,
      anchorBottomY: 520,
      popoverWidth: 320,
      popoverHeight: 180,
      containerWidth: 900,
      containerHeight: 600,
      marginX: 12,
      marginTop: 46,
      marginBottom: 14,
      gapY: 6,
      alignOffsetX: 12,
    });
    assert.equal(nearBottom.left, 188);
    assert.equal(nearBottom.top, 314);
    assert.equal(nearBottom.placement, "above");

    // Missing anchor coordinates center horizontally cleanly instead of hugging right edge
    const unanchored = computeAnchoredPopoverPosition({
      popoverWidth: 320,
      popoverHeight: 160,
      containerWidth: 800,
      containerHeight: 600,
      marginX: 12,
      marginTop: 46,
    });
    assert.equal(unanchored.left, 240);
    assert.equal(unanchored.top, 54);
    assert.equal(unanchored.placement, "center");
  });

  test("renderDropdownPopover stops scroll_wheel propagation on both overlay backdrop and popover card", () => {
    const src = readFileSync(resolve(ROOT, "shared/dropdown.js"), "utf8");
    const popoverIdx = src.indexOf("export function renderDropdownPopover(");
    assert.ok(popoverIdx >= 0, "renderDropdownPopover export must exist");
    const popoverSrc = src.slice(popoverIdx);
    const wheelStopMatches = popoverSrc.match(/\.on_scroll_wheel\(\(_e,\s*cx\)\s*=>\s*cx\.stop_propagation\(\)\)/g) || [];
    assert.equal(wheelStopMatches.length, 2, "both overlay backdrop and menu card must stop scroll wheel propagation");
  });

  test("filterDropdownItems filters multi-token queries across label/rightText, prunes empty sections/dividers, and returns empty state", () => {
    const branchItems = [
      { type: "option", id: "all", label: "All Branches", rightText: "--all", onSelect: () => "all" },
      { type: "divider", id: "d1" },
      { type: "section", id: "s1", label: "Local branches" },
      { type: "option", id: "l1", label: "main", rightText: "885a77d", onSelect: () => "main" },
      { type: "option", id: "l2", label: "nmunoz/dev/extract-accounts-with-mirror", rightText: "a1b2c3d", onSelect: () => "local-mirror" },
      { type: "divider", id: "d2" },
      { type: "section", id: "s2", label: "Remote branches" },
      { type: "option", id: "r1", label: "origin/development", rightText: "02e93d6", onSelect: () => "origin/development" },
      { type: "option", id: "r2", label: "origin/nmunoz/prod/BMB-4364-validate", rightText: "f00ba12", onSelect: () => "origin/prod" },
    ];

    // Blank query returns exact original reference (O(1) fast path)
    assert.strictEqual(filterDropdownItems(branchItems, ""), branchItems);
    assert.strictEqual(filterDropdownItems(branchItems, "   "), branchItems);

    // Multi-token match only inside Remote branches drops Local section & leading divider
    const remoteOnly = filterDropdownItems(branchItems, "prod 4364");
    assert.deepEqual(
      remoteOnly.map((it) => `${it.type}:${it.id}`),
      ["section:s2", "option:r2"],
    );
    assert.equal(findFirstSelectableDropdownOption(remoteOnly)?.id, "r2");

    // Match by short SHA (rightText) works cleanly
    const bySha = filterDropdownItems(branchItems, "a1b2");
    assert.deepEqual(
      bySha.map((it) => `${it.type}:${it.id}`),
      ["section:s1", "option:l2"],
    );

    // Match spanning Local + Remote keeps divider between them cleanly
    const bothGroups = filterDropdownItems(branchItems, "dev");
    assert.deepEqual(
      bothGroups.map((it) => `${it.type}:${it.id}`),
      ["section:s1", "option:l2", "divider:d2", "section:s2", "option:r1"],
    );

    // Zero matches emits a single empty row and findFirstSelectableDropdownOption returns null
    const none = filterDropdownItems(branchItems, "nonexistent-xyz", {
      emptyId: "git-branch-dropdown-empty",
      emptyLabel: "No matching branches",
    });
    assert.deepEqual(none, [{ type: "empty", id: "git-branch-dropdown-empty", label: "No matching branches" }]);
    assert.equal(findFirstSelectableDropdownOption(none), null);

    // Search bar height constant is positive and integrates cleanly with chromeTopHeight
    assert.ok(DEFAULT_SEARCH_BAR_HEIGHT > 0);
    const metricsWithSearch = computeDropdownMetrics({
      items: remoteOnly,
      minWidth: 230,
      maxWidth: 340,
      maxHeight: 340,
      chromeTopHeight: DEFAULT_SEARCH_BAR_HEIGHT,
    });
    assert.equal(metricsWithSearch.shouldScroll, false);
    assert.ok(metricsWithSearch.contentHeight > DEFAULT_SEARCH_BAR_HEIGHT);
  });
});
