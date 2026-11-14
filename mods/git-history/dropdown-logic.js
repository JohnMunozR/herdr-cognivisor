// Pure zero-UI geometry and scrolling metrics for shared GPUI dropdown menus.

export const DEFAULT_REOPEN_GUARD_MS = 80;

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
  const safeHeaderH = Number.isFinite(headerHeight) && headerHeight > 0 ? headerHeight : 26;
  const safeDividerH = Number.isFinite(dividerHeight) && dividerHeight > 0 ? dividerHeight : 9;
  const safeEmptyH = Number.isFinite(emptyHeight) && emptyHeight > 0 ? emptyHeight : 31;

  let itemCount = 0;
  let rowsHeight = 0;
  let maxItemWidth = 0;
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

    rowsHeight += Number.isFinite(explicitH) && explicitH > 0 ? explicitH : safeDefaultRowH;

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

  const contentHeight =
    itemCount === 0
      ? safeDefaultRowH + safePad * 2
      : rowsHeight + (itemCount - 1) * safeGap + safePad * 2;

  const shouldScroll = contentHeight > safeMaxH;
  const bodyHeight = shouldScroll ? safeMaxH : contentHeight;
  const effectiveMaxWidth = Math.max(safeMinW, Math.min(safeMaxW, safePanelW - safeMarginX));
  const desiredWidth = maxItemWidth + (shouldScroll ? 8 : 0);
  const width = clampDropdownNumber(Math.ceil(desiredWidth), safeMinW, effectiveMaxWidth);

  return {
    width,
    contentHeight,
    bodyHeight,
    shouldScroll,
  };
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
