// Pure zero-UI geometry and scrolling metrics for shared GPUI dropdown menus.

export const DEFAULT_REOPEN_GUARD_MS = 80;
export const DEFAULT_SEARCH_BAR_HEIGHT = 38;

/**
 * Clamp a numeric value into [min, max] safely.
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampDropdownNumber(val, min, max) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? Math.max(lo, max) : lo;
  const n = Number(val);
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function estimateTextWidth(text, charPx = 6.6) {
  if (text === undefined || text === null) return 0;
  const str = String(text);
  if (!str) return 0;
  return Math.ceil(str.length * charPx);
}

function hasBadgeValue(val) {
  return val !== undefined && val !== null && val !== "";
}

/**
 * Compute adaptive popover width, exact content height, bounded body height,
 * and whether vertical scrolling should be enabled.
 * @param {{
 *   items?: Array<Record<string, any>>,
 *   panelWidth?: number,
 *   minWidth?: number,
 *   maxWidth?: number,
 *   maxHeight?: number,
 *   headerHeight?: number,
 *   dividerHeight?: number,
 *   emptyHeight?: number,
 *   defaultRowHeight?: number,
 *   itemGap?: number,
 *   padding?: number,
 *   marginX?: number,
 * }} [options]
 * @returns {{ width: number, contentHeight: number, bodyHeight: number, shouldScroll: boolean }}
 */
export function computeDropdownMetrics(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const {
    items = [],
    panelWidth = 420,
    minWidth = 180,
    maxWidth = 340,
    maxHeight = 320,
    headerHeight = 26,
    dividerHeight = 9,
    emptyHeight = 31,
    defaultRowHeight = 31,
    sublineRowHeight = 44,
    chromeTopHeight = 0,
    headerTitle = "",
    itemGap = 1,
    padding = 5,
    marginX = 20,
  } = opts;

  const list = Array.isArray(items) ? items : [];
  const safeMinW = Number.isFinite(minWidth) && minWidth > 0 ? minWidth : 180;
  const safeMaxW = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.max(safeMinW, maxWidth) : Math.max(safeMinW, 340);
  const safePanelW = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : 420;
  const safeMarginX = Number.isFinite(marginX) && marginX >= 0 ? marginX : 20;
  const safeMaxH = Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : 320;
  const safePad = Number.isFinite(padding) && padding >= 0 ? padding : 5;
  const safeGap = Number.isFinite(itemGap) && itemGap >= 0 ? itemGap : 1;
  const safeDefaultRowH = Number.isFinite(defaultRowHeight) && defaultRowHeight > 0 ? defaultRowHeight : 31;
  const safeSublineRowH = Number.isFinite(sublineRowHeight) && sublineRowHeight > 0 ? Math.max(safeDefaultRowH, sublineRowHeight) : Math.max(safeDefaultRowH, 44);
  const safeChromeTopH = Number.isFinite(chromeTopHeight) && chromeTopHeight > 0 ? chromeTopHeight : 0;
  const safeHeaderH = Number.isFinite(headerHeight) && headerHeight > 0 ? headerHeight : 26;
  const safeDividerH = Number.isFinite(dividerHeight) && dividerHeight > 0 ? dividerHeight : 9;
  const safeEmptyH = Number.isFinite(emptyHeight) && emptyHeight > 0 ? emptyHeight : 31;

  let itemCount = 0;
  let rowsHeight = 0;
  let maxItemWidth = headerTitle ? estimateTextWidth(headerTitle, 6.8) + 110 : 0;
  const containerChrome = safePad * 2 + 18 + 12;

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    itemCount += 1;

    const kind = item.type || "option";
    const explicitH = Number(item.height);

    if (kind === "divider") {
      rowsHeight += Number.isFinite(explicitH) && explicitH > 0 ? explicitH : safeDividerH;
      continue;
    }

    if (kind === "section") {
      rowsHeight += Number.isFinite(explicitH) && explicitH > 0 ? explicitH : safeHeaderH;
      const w = estimateTextWidth(item.label, 6.4) + safePad * 2 + 22;
      if (w > maxItemWidth) maxItemWidth = w;
      continue;
    }

    if (kind === "empty") {
      rowsHeight += Number.isFinite(explicitH) && explicitH > 0 ? explicitH : safeEmptyH;
      const w = estimateTextWidth(item.label, 7.0) + safePad * 2 + 24;
      if (w > maxItemWidth) maxItemWidth = w;
      continue;
    }

    const rowFallbackH = hasBadgeValue(item.subline) ? safeSublineRowH : safeDefaultRowH;
    rowsHeight += Number.isFinite(explicitH) && explicitH > 0 ? explicitH : rowFallbackH;

    const iconSize = Number.isFinite(Number(item.iconSize)) && Number(item.iconSize) > 0 ? Number(item.iconSize) : 14;
    const leftChrome = (item.dotColor ? 15 : 0) + (item.icon ? iconSize + 10 : 0);

    const primaryWidth =
      estimateTextWidth(item.label, 7.2) +
      (hasBadgeValue(item.meta) ? estimateTextWidth(item.meta, 6.3) + 10 : 0);

    const sublineWidth = item.subline
      ? estimateTextWidth(item.subline, 6.1) +
        (hasBadgeValue(item.sublineBadge) ? estimateTextWidth(item.sublineBadge, 5.8) + 14 : 0)
      : 0;

    const rightChrome =
      (hasBadgeValue(item.badge) ? estimateTextWidth(item.badge, 6.1) + 20 : 0) +
      (hasBadgeValue(item.rightText) ? estimateTextWidth(item.rightText, 6.4) + 14 : 0);

    const rowWidth = leftChrome + Math.max(primaryWidth, sublineWidth) + rightChrome + containerChrome;
    if (rowWidth > maxItemWidth) maxItemWidth = rowWidth;
  }

  const listContentHeight =
    itemCount === 0
      ? safeDefaultRowH + safePad * 2
      : rowsHeight + (itemCount - 1) * safeGap + safePad * 2;
  const contentHeight = safeChromeTopH + listContentHeight;

  const shouldScroll = contentHeight > safeMaxH;
  const bodyHeight = shouldScroll ? safeMaxH : contentHeight;
  const effectiveMaxWidth = Math.max(safeMinW, Math.min(safeMaxW, safePanelW - safeMarginX));
  const desiredWidth = maxItemWidth + (shouldScroll ? 12 : 0);
  const width = clampDropdownNumber(Math.ceil(desiredWidth), safeMinW, effectiveMaxWidth);

  return {
    width,
    contentHeight,
    bodyHeight,
    shouldScroll,
  };
}

/**
 * Compute viewport-clamped (left, top) placement for an anchored floating popover.
 * Ensures popovers never clip behind left/right/top/bottom container edges and flip
 * above the anchor when there isn't enough space below.
 * @param {{
 *   anchorX?: number|null,
 *   anchorY?: number|null,
 *   anchorBottomY?: number|null,
 *   popoverWidth?: number,
 *   popoverHeight?: number,
 *   containerWidth?: number,
 *   containerHeight?: number,
 *   marginX?: number,
 *   marginTop?: number,
 *   marginBottom?: number,
 *   gapY?: number,
 *   alignOffsetX?: number,
 * }} [options]
 * @returns {{ left: number, top: number, placement: "below"|"above"|"center" }}
 */
export function computeAnchoredPopoverPosition(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const {
    anchorX = null,
    anchorY = null,
    anchorBottomY = null,
    popoverWidth = 320,
    popoverHeight = 160,
    containerWidth = 760,
    containerHeight = 560,
    marginX = 12,
    marginTop = 12,
    marginBottom = 12,
    gapY = 6,
    alignOffsetX = 12,
  } = opts;

  const safeMarginX = Number.isFinite(marginX) && marginX >= 0 ? marginX : 12;
  const safeMarginTop = Number.isFinite(marginTop) && marginTop >= 0 ? marginTop : 12;
  const safeMarginBottom = Number.isFinite(marginBottom) && marginBottom >= 0 ? marginBottom : 12;
  const safeContainerW = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 760;
  const safeContainerH = Number.isFinite(containerHeight) && containerHeight > 0 ? containerHeight : 560;
  const safePopW = Math.min(
    Number.isFinite(popoverWidth) && popoverWidth > 0 ? popoverWidth : 320,
    Math.max(120, safeContainerW - safeMarginX * 2)
  );
  const safePopH = Math.min(
    Number.isFinite(popoverHeight) && popoverHeight > 0 ? popoverHeight : 160,
    Math.max(80, safeContainerH - safeMarginTop - safeMarginBottom)
  );
  const safeGapY = Number.isFinite(gapY) && gapY >= 0 ? gapY : 6;
  const safeAlignX = Number.isFinite(alignOffsetX) && alignOffsetX >= 0 ? alignOffsetX : 12;

  const maxLeft = Math.max(safeMarginX, safeContainerW - safePopW - safeMarginX);
  const hasAnchorX = anchorX !== null && anchorX !== undefined && Number.isFinite(Number(anchorX));
  const rawLeft = hasAnchorX
    ? Math.round(Number(anchorX) - safeAlignX)
    : Math.round((safeContainerW - safePopW) / 2);
  const left = clampDropdownNumber(rawLeft, safeMarginX, maxLeft);

  const maxTop = Math.max(safeMarginTop, safeContainerH - safePopH - safeMarginBottom);
  const hasAnchorY =
    (anchorY !== null && anchorY !== undefined && Number.isFinite(Number(anchorY))) ||
    (anchorBottomY !== null && anchorBottomY !== undefined && Number.isFinite(Number(anchorBottomY)));

  if (!hasAnchorY) {
    return {
      left,
      top: clampDropdownNumber(safeMarginTop + 8, safeMarginTop, maxTop),
      placement: "center",
    };
  }

  const numY = anchorY !== null && anchorY !== undefined && Number.isFinite(Number(anchorY))
    ? Number(anchorY)
    : Number(anchorBottomY) - 20;
  const numBottomY = anchorBottomY !== null && anchorBottomY !== undefined && Number.isFinite(Number(anchorBottomY))
    ? Number(anchorBottomY)
    : numY + 20;

  const belowTop = Math.round(numBottomY + safeGapY);
  if (belowTop <= maxTop) {
    return {
      left,
      top: clampDropdownNumber(belowTop, safeMarginTop, maxTop),
      placement: "below",
    };
  }

  const aboveTop = Math.round(numY - safePopH - safeGapY);
  if (aboveTop >= safeMarginTop) {
    return {
      left,
      top: aboveTop,
      placement: "above",
    };
  }

  const spaceBelow = Math.max(0, safeContainerH - safeMarginBottom - numBottomY);
  const spaceAbove = Math.max(0, numY - safeMarginTop);
  const placement = spaceAbove > spaceBelow ? "above" : "below";
  const top = clampDropdownNumber(placement === "above" ? aboveTop : belowTop, safeMarginTop, maxTop);
  return { left, top, placement };
}

/**
 * Guard against backdrop-close + trigger-reopen races within the same click dispatch.
 * Returns true when the same dropdown was just dismissed inside `guardMs`.
 * @param {number|undefined|null} dismissedAt
 * @param {number} nowMs
 * @param {number} [guardMs]
 * @returns {boolean}
 */
export function shouldSuppressDropdownReopen(dismissedAt, nowMs, guardMs = DEFAULT_REOPEN_GUARD_MS) {
  const closedTs = Number(dismissedAt);
  const currentTs = Number(nowMs);
  const windowMs = Number(guardMs);
  if (!Number.isFinite(closedTs) || !Number.isFinite(currentTs) || !Number.isFinite(windowMs)) {
    return false;
  }
  if (closedTs <= 0 || windowMs <= 0) return false;
  const elapsed = currentTs - closedTs;
  return elapsed >= 0 && elapsed < windowMs;
}

function getDropdownItemSearchText(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.searchText === "string") return item.searchText.toLowerCase();
  const parts = [];
  if (hasBadgeValue(item.label)) parts.push(String(item.label));
  if (hasBadgeValue(item.meta)) parts.push(String(item.meta));
  if (hasBadgeValue(item.subline)) parts.push(String(item.subline));
  if (hasBadgeValue(item.sublineBadge)) parts.push(String(item.sublineBadge));
  if (hasBadgeValue(item.badge)) parts.push(String(item.badge));
  if (hasBadgeValue(item.rightText)) parts.push(String(item.rightText));
  return parts.join(" ").toLowerCase();
}

/**
 * Filter dropdown items by case-insensitive multi-token substring match while
 * automatically pruning empty sections and leading/trailing/consecutive dividers.
 * Returns the original array reference unchanged when `query` is blank.
 * @param {Array<Record<string, any>>} items
 * @param {string} query
 * @param {{ emptyId?: string, emptyLabel?: string }} [opts]
 * @returns {Array<Record<string, any>>}
 */
export function filterDropdownItems(items, query, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const rawQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!rawQuery) return list;

  const tokens = rawQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return list;

  const matchesTokens = (item) => {
    if (item.alwaysVisible === true) return true;
    const hay = getDropdownItemSearchText(item);
    if (!hay) return false;
    for (let i = 0; i < tokens.length; i += 1) {
      if (!hay.includes(tokens[i])) return false;
    }
    return true;
  };

  const out = [];
  let pendingSection = null;
  let pendingDivider = null;
  let matchedOptionCount = 0;

  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const kind = item.type || "option";

    if (kind === "divider") {
      if (matchedOptionCount > 0) {
        pendingDivider = item;
      }
      pendingSection = null;
      continue;
    }

    if (kind === "section") {
      pendingSection = item;
      continue;
    }

    if (kind === "empty") {
      continue;
    }

    if (!matchesTokens(item)) continue;

    if (pendingDivider && out.length > 0) {
      out.push(pendingDivider);
      pendingDivider = null;
    }
    if (pendingSection) {
      out.push(pendingSection);
      pendingSection = null;
    }
    out.push(item);
    matchedOptionCount += 1;
  }

  if (matchedOptionCount === 0) {
    return [
      {
        type: "empty",
        id: opts?.emptyId || "dropdown-search-empty",
        label: opts?.emptyLabel || "No matches",
      },
    ];
  }
  return out;
}

/**
 * Return the first enabled option item in a dropdown list (used for Enter-to-select).
 * @param {Array<Record<string, any>>} items
 * @returns {Record<string, any>|null}
 */
export function findFirstSelectableDropdownOption(items) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const kind = item.type || "option";
    if (kind === "option" && !item.disabled && typeof item.onSelect === "function") {
      return item;
    }
  }
  return null;
}
