// Shared reusable GPUI dropdown trigger and adaptive shrink-wrapping popover component.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  DEFAULT_REOPEN_GUARD_MS,
  computeDropdownMetrics,
  shouldSuppressDropdownReopen,
} from "./dropdown-logic.js";

const dismissedAtByKey = new Map();
const MAX_DISMISS_TIMESTAMPS = 32;

function hasValue(val) {
  return val !== undefined && val !== null && val !== "";
}

function recordDropdownDismiss(guardKey) {
  if (!guardKey) return;
  const now = Date.now();
  dismissedAtByKey.set(guardKey, now);
  if (dismissedAtByKey.size > MAX_DISMISS_TIMESTAMPS) {
    for (const [k, ts] of dismissedAtByKey.entries()) {
      if (now - ts >= DEFAULT_REOPEN_GUARD_MS * 2 || dismissedAtByKey.size > MAX_DISMISS_TIMESTAMPS) {
        dismissedAtByKey.delete(k);
      }
      if (dismissedAtByKey.size <= MAX_DISMISS_TIMESTAMPS) break;
    }
  }
}

function consumeRecentDismiss(guardKey) {
  if (!guardKey || !dismissedAtByKey.has(guardKey)) return false;
  const closedAt = dismissedAtByKey.get(guardKey);
  dismissedAtByKey.delete(guardKey);
  return shouldSuppressDropdownReopen(closedAt, Date.now(), DEFAULT_REOPEN_GUARD_MS);
}

/**
 * Render a compact h(24) selector trigger button with optional icon, status dot,
 * truncated label, badge pill, and chevron.
 */
export function renderDropdownTrigger({
  id,
  isOpen = false,
  label = "",
  labelColor,
  fontMedium = true,
  badge,
  leftIcon,
  leftIconSize = 11,
  leftIconColor,
  dotColor,
  chevronIcon,
  maxW,
  flex1 = false,
  fullWidth = false,
  t,
  onClick,
} = {}) {
  const themeObj = t || {};
  const hasBadge = hasValue(badge);
  const triggerKey = id || "dropdown-trigger";

  return h_flex()
    .when(Boolean(id), (el) => el.id(id))
    .when(!id && typeof onClick === "function", (el) => el.id("dropdown-trigger"))
    .h(24)
    .px(8)
    .gap(6)
    .min_w(0)
    .when(Boolean(flex1), (el) => el.flex_1())
    .when(Boolean(fullWidth), (el) => el.w_full())
    .when(typeof maxW === "number" && maxW > 0, (el) => el.max_w(maxW))
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(isOpen ? (themeObj.accent || themeObj.border) : themeObj.border)
    .bg(isOpen ? (themeObj.selected || themeObj.hover) : themeObj.background)
    .cursor_pointer()
    .hover((s) => s.bg(themeObj.hover))
    .when(typeof onClick === "function", (el) =>
      el
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((e, cx) => {
          cx.stop_propagation();
          if (!isOpen && consumeRecentDismiss(triggerKey)) return;
          onClick(e, cx);
        })
    )
    .when(Boolean(leftIcon), (el) =>
      el.child(
        svg(leftIcon)
          .size(leftIconSize)
          .flex_none()
          .text_color(leftIconColor || themeObj.muted || themeObj.foreground)
      )
    )
    .when(Boolean(dotColor), (el) =>
      el.child(div().w(6).h(6).rounded_full().flex_none().bg(dotColor))
    )
    .child(
      div()
        .flex_1()
        .min_w(0)
        .truncate()
        .text_size(11)
        .when(Boolean(fontMedium), (el) => el.font_medium())
        .text_color(labelColor || themeObj.foreground)
        .child(String(label ?? ""))
    )
    .when(hasBadge, (el) =>
      el.child(
        div()
          .flex_none()
          .px(4)
          .py(0.5)
          .rounded(3)
          .bg(themeObj.raised || themeObj.chrome || themeObj.background)
          .text_size(9.5)
          .text_color(themeObj.muted || themeObj.dim)
          .child(String(badge))
      )
    )
    .child(
      chevronIcon
        ? svg(chevronIcon).size(9).flex_none().text_color(themeObj.dim)
        : div().flex_none().text_size(9).text_color(themeObj.dim).child("▾")
    );
}

function renderDropdownItem(item, index, monoFont, themeObj) {
  if (!item || typeof item !== "object") return null;
  const kind = item.type || "option";

  if (kind === "divider") {
    return div()
      .when(Boolean(item.id), (el) => el.id(item.id))
      .h(1)
      .mx(7)
      .my(4)
      .bg(themeObj.border)
      .flex_none();
  }

  if (kind === "section") {
    return div()
      .when(Boolean(item.id), (el) => el.id(item.id))
      .px(9)
      .pt(8)
      .pb(4)
      .flex_none()
      .text_size(11)
      .text_color(item.color || themeObj.dim)
      .truncate()
      .child(String(item.label ?? ""));
  }

  if (kind === "empty") {
    return h_flex()
      .when(Boolean(item.id), (el) => el.id(item.id))
      .min_h(item.height || 31)
      .px(9)
      .flex_none()
      .items_center()
      .text_size(12)
      .text_color(item.color || themeObj.dim)
      .child(div().flex_1().min_w(0).truncate().child(String(item.label ?? "No options")));
  }

  const hasSubline = hasValue(item.subline);
  const hasSublineBadge = hasValue(item.sublineBadge);
  const hasMeta = hasValue(item.meta);
  const hasBadge = hasValue(item.badge);
  const hasRightText = hasValue(item.rightText);
  const rowId = item.id || `dropdown-opt-${index}`;
  const isDisabled = Boolean(item.disabled);
  const rowMinH = item.height || (hasSubline ? 42 : 31);

  const primaryRow = h_flex()
    .min_w(0)
    .gap(6)
    .items_center()
    .child(
      div()
        .min_w(0)
        .truncate()
        .text_size(12.5)
        .when(Boolean(item.fontMedium), (el) => el.font_medium())
        .text_color(isDisabled ? themeObj.dim : (item.labelColor || themeObj.foreground))
        .child(String(item.label ?? ""))
    )
    .when(hasMeta, (el) =>
      el.child(
        div()
          .flex_none()
          .text_size(11)
          .text_color(item.metaColor || themeObj.dim)
          .child(String(item.meta))
      )
    );

  const centerNode = hasSubline
    ? v_flex()
        .flex_1()
        .min_w(0)
        .gap(1)
        .child(primaryRow)
        .child(
          h_flex()
            .min_w(0)
            .gap(5)
            .items_center()
            .child(
              div()
                .min_w(0)
                .truncate()
                .text_size(10.5)
                .text_color(item.sublineColor || themeObj.dim)
                .child(String(item.subline))
            )
            .when(hasSublineBadge, (el) =>
              el.child(
                div()
                  .flex_none()
                  .px(5)
                  .py(0.5)
                  .rounded(4)
                  .bg(item.sublineBadgeBg || themeObj.raised || themeObj.background)
                  .text_size(9.5)
                  .text_color(item.sublineBadgeColor || themeObj.dim)
                  .child(String(item.sublineBadge))
              )
            )
        )
    : primaryRow.flex_1();

  return h_flex()
    .id(rowId)
    .flex_none()
    .min_h(rowMinH)
    .px(9)
    .py(hasSubline ? 5 : 0)
    .gap(10)
    .items_center()
    .rounded(7)
    .when(!isDisabled, (el) =>
      el
        .cursor_pointer()
        .when(Boolean(item.selected), (s) => s.bg(themeObj.selected || themeObj.hover))
        .hover((s) => s.bg(themeObj.selected || themeObj.hover))
        .when(typeof item.onSelect === "function", (s) =>
          s.on_click((e, cx) => {
            cx.stop_propagation();
            item.onSelect(e, cx);
          })
        )
    )
    .when(Boolean(item.dotColor), (el) =>
      el.child(div().w(7).h(7).rounded_full().flex_none().bg(item.dotColor))
    )
    .when(Boolean(item.icon), (el) =>
      el.child(
        svg(item.icon)
          .size(item.iconSize || 14)
          .flex_none()
          .text_color(item.iconColor || themeObj.muted || themeObj.foreground)
      )
    )
    .child(centerNode)
    .when(hasBadge, (el) =>
      el.child(
        div()
          .flex_none()
          .px(6)
          .py(1)
          .rounded(5)
          .bg(item.badgeBg || themeObj.raised || themeObj.chrome || themeObj.background)
          .text_size(10.5)
          .text_color(item.badgeColor || themeObj.muted)
          .child(String(item.badge))
      )
    )
    .when(hasRightText, (el) =>
      el.child(
        div()
          .flex_none()
          .when(item.rightMono !== false, (d) => d.font_family(monoFont))
          .text_size(11)
          .text_color(item.rightColor || themeObj.dim)
          .child(String(item.rightText))
      )
    );
}

/**
 * Render an overlay-backed floating dropdown popover that shrink-wraps cleanly
 * for short lists and activates bounded GPUI scrolling only when needed.
 */
export function renderDropdownPopover({
  overlayId = "dropdown-overlay",
  menuId = "dropdown-menu",
  triggerId,
  top = 40,
  left = 10,
  right = 10,
  anchor = "left",
  minWidth = 180,
  maxWidth = 340,
  maxHeight = 320,
  panelWidth = 420,
  marginX = 20,
  items = [],
  scrollHandle = null,
  monoFont = "monospace",
  t,
  onClose,
} = {}) {
  const themeObj = t || {};
  const listItems = Array.isArray(items) ? items : [];
  const guardKey = triggerId || menuId || overlayId || "dropdown-trigger";
  const metrics = computeDropdownMetrics({
    items: listItems,
    panelWidth,
    minWidth,
    maxWidth,
    maxHeight,
    marginX,
  });

  const children = [];
  if (listItems.length === 0) {
    children.push(
      renderDropdownItem({ type: "empty", id: `${menuId}-empty`, label: "No options" }, 0, monoFont, themeObj)
    );
  } else {
    for (let i = 0; i < listItems.length; i += 1) {
      const node = renderDropdownItem(listItems[i], i, monoFont, themeObj);
      if (node) children.push(node);
    }
  }

  return div()
    .id(overlayId || "dropdown-overlay")
    .absolute()
    .inset_0()
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      recordDropdownDismiss(guardKey);
      if (typeof onClose === "function") onClose(e, cx);
    })
    .child(
      v_flex()
        .id(menuId || "dropdown-menu")
        .absolute()
        .top(top)
        .when(anchor === "right", (el) => el.right(right))
        .when(anchor !== "right", (el) => el.left(left))
        .w(metrics.width)
        .rounded(10)
        .bg(themeObj.popover || themeObj.raised || themeObj.chrome || themeObj.background)
        .border_1()
        .border_color(themeObj.border)
        .shadow_xl()
        .p(5)
        .gap(1)
        // CRITICAL GPUI FIX: only attach fixed height + scrollbar when overflowing so short lists shrink-wrap tightly
        .when(metrics.shouldScroll === true, (el) =>
          el
            .h(metrics.bodyHeight)
            .overflow_y_scrollbar()
            .when(Boolean(scrollHandle), (s) => s.track_scroll(scrollHandle))
        )
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => cx.stop_propagation())
        .children(children)
    );
}
