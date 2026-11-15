// Interactive GPUI code viewer and symbol-navigation rendering components.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { syntaxTokenStyle } from "./code-syntax.js";
import { renderDropdownPopover } from "./dropdown.js";
import {
  isNavModifierActive,
  buildDisambiguationDropdownItems,
  computeWindowedViewerSlice,
  computeScrollbarMetrics,
  resolveWheelLineDelta,
} from "./search-logic.js";

export const CODE_VIEWER_LINE_HEIGHT = 20;

/**
 * Compute responsive monospace line-number gutter width from logical line count.
 */
export function computeCodeGutterWidth(totalLines = 1) {
  const digits = Math.max(2, String(Math.max(1, Number(totalLines) || 1)).length);
  return Math.max(40, digits * 8 + 18);
}

function appendQueryMatchedChunks(targetChildren, text, query, style, t, monoFont, isTargetSymbolMatch) {
  if (!query || !text) {
    targetChildren.push(
      div()
        .flex_none()
        .whitespace_nowrap()
        .text_size(11.5)
        .font_family(monoFont)
        .when(Boolean(style.bold), el => el.font_semibold())
        .when(isTargetSymbolMatch, el => el.bg(t.selected).rounded(3).px(1))
        .text_color(style.color)
        .child(text)
    );
    return;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = String(query).toLowerCase();
  if (!lowerQuery) {
    targetChildren.push(
      div()
        .flex_none()
        .whitespace_nowrap()
        .text_size(11.5)
        .font_family(monoFont)
        .when(Boolean(style.bold), el => el.font_semibold())
        .text_color(style.color)
        .child(text)
    );
    return;
  }

  let cursor = 0;
  let matchIdx = lowerText.indexOf(lowerQuery, cursor);
  if (matchIdx === -1) {
    targetChildren.push(
      div()
        .flex_none()
        .whitespace_nowrap()
        .text_size(11.5)
        .font_family(monoFont)
        .when(Boolean(style.bold), el => el.font_semibold())
        .when(isTargetSymbolMatch, el => el.bg(t.selected).rounded(3).px(1))
        .text_color(style.color)
        .child(text)
    );
    return;
  }

  while (matchIdx !== -1) {
    if (matchIdx > cursor) {
      targetChildren.push(
        div()
          .flex_none()
          .whitespace_nowrap()
          .text_size(11.5)
          .font_family(monoFont)
          .when(Boolean(style.bold), el => el.font_semibold())
          .text_color(style.color)
          .child(text.slice(cursor, matchIdx))
      );
    }
    targetChildren.push(
      div()
        .flex_none()
        .whitespace_nowrap()
        .text_size(11.5)
        .font_family(monoFont)
        .font_semibold()
        .rounded(2)
        .bg(t.accent)
        .text_color(t.background)
        .child(text.slice(matchIdx, matchIdx + lowerQuery.length))
    );
    cursor = matchIdx + lowerQuery.length;
    matchIdx = lowerText.indexOf(lowerQuery, cursor);
  }

  if (cursor < text.length) {
    targetChildren.push(
      div()
        .flex_none()
        .whitespace_nowrap()
        .text_size(11.5)
        .font_family(monoFont)
        .when(Boolean(style.bold), el => el.font_semibold())
        .text_color(style.color)
        .child(text.slice(cursor))
    );
  }
}

/**
 * Render wrapped syntax segments with optional `Ctrl/Cmd+Hover` underline and `Ctrl/Cmd+Click` symbol navigation.
 */
export function renderInteractiveTokenSegments({
  t,
  segments,
  query = "",
  isTargetLine = false,
  baseTarget = true,
  highlightSymbol = "",
  targetCol = null,
  monoFont = "monospace",
  ctrlHeld = false,
  hoveredTokenKey = null,
  idPrefix = "cv",
  lineNum = 1,
  wrapIdx = 0,
  fillWidth = false,
  onTokenHover = null,
  onTokenClick = null,
}) {
  const rowChildren = [];
  if (!Array.isArray(segments) || segments.length === 0) {
    rowChildren.push(div().flex_none().whitespace_nowrap().text_size(11.5).font_family(monoFont).child("\u00a0"));
  } else {
    for (let idx = 0; idx < segments.length; idx += 1) {
      const seg = segments[idx];
      const kind = seg?.[0] || "plain";
      const segText = seg?.[1] || "";
      const meta = seg?.[2] || null;
      if (!segText) continue;

      const style = syntaxTokenStyle(kind, t, baseTarget);
      const isNavigable = Boolean(meta?.nav && typeof onTokenClick === "function");
      const isCandidateTarget = Boolean(isTargetLine && highlightSymbol && segText === highlightSymbol);
      const tokenCol = (isNavigable || isCandidateTarget) && Number.isFinite(Number(meta?.col))
        ? Number(meta.col)
        : 1;
      const tokenKey = isNavigable ? `${idPrefix}:${lineNum}:${tokenCol}:${segText}` : "";
      const isHoveredNav = Boolean(isNavigable && ctrlHeld && hoveredTokenKey === tokenKey);
      const isNavTargetMatch = Boolean(
        isCandidateTarget &&
        (!targetCol || tokenCol === Number(targetCol))
      );

      if (!isNavigable) {
        appendQueryMatchedChunks(rowChildren, segText, query, style, t, monoFont, isNavTargetMatch);
        continue;
      }

      const tokenEl = h_flex()
        .id(`${idPrefix}-tok-${lineNum}-${wrapIdx}-${idx}`)
        .flex_none()
        .items_center()
        .whitespace_nowrap()
        .text_size(11.5)
        .font_family(monoFont)
        .when(Boolean(style.bold) && !isNavTargetMatch, el => el.font_semibold())
        .when(isNavTargetMatch && !isHoveredNav, el =>
          el
            .bg(t.accent)
            .text_color(t.background)
            .rounded(2)
            .font_semibold()
        )
        .when(isHoveredNav, el =>
          el
            .cursor_pointer()
            .underline()
            .text_color(t.ansi4)
        )
        .on_hover((hovered, cx) => {
          onTokenHover?.(hovered ? tokenKey : null, tokenKey, cx);
        })
        .on_click((e, cx) => {
          const mods = e?.modifiers || e;
          if (!isNavModifierActive(mods) && !ctrlHeld) return;
          cx?.stop_propagation?.();
          onTokenClick(
            {
              line: lineNum,
              col: tokenCol,
              symbol: segText,
              tokenKey,
              bounds: e?.bounds || null,
            },
            e,
            cx,
          );
        });

      const innerStyle = isHoveredNav
        ? { ...style, color: t.ansi4 }
        : isNavTargetMatch
          ? { ...style, color: t.background, bold: true }
          : style;
      const innerChunks = [];
      appendQueryMatchedChunks(innerChunks, segText, query, innerStyle, t, monoFont, false);
      rowChildren.push(tokenEl.children(innerChunks));
    }
  }

  return h_flex()
    .when(fillWidth, el => el.flex_1().min_w(0).overflow_hidden())
    .items_center()
    .children(rowChildren);
}

/**
 * Render `#main` code-viewer navigation controls (`<-`, `->`, `Copy`, `Select Text`).
 */
export function renderViewerNavToolbar({
  t,
  canBack = false,
  canForward = false,
  selectTextMode = false,
  copiedFile = false,
  hasFile = false,
  onBack = null,
  onForward = null,
  onCopyFile = null,
  onToggleSelectText = null,
}) {
  return h_flex()
    .flex_none()
    .items_center()
    .gap(5)
    .child(
      h_flex()
        .items_center()
        .gap(2)
        .child(
          div()
            .id("viewer-nav-back")
            .h(22)
            .px(7)
            .rounded(4)
            .flex()
            .items_center()
            .justify_center()
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .text_size(11.5)
            .text_color(canBack ? t.foreground : t.dim)
            .when(canBack && typeof onBack === "function", el =>
              el
                .cursor_pointer()
                .hover(s => s.bg(t.hover).border_color(t.accent))
                .on_click((_e, cx) => onBack(cx))
            )
            .child("←")
        )
        .child(
          div()
            .id("viewer-nav-forward")
            .h(22)
            .px(7)
            .rounded(4)
            .flex()
            .items_center()
            .justify_center()
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .text_size(11.5)
            .text_color(canForward ? t.foreground : t.dim)
            .when(canForward && typeof onForward === "function", el =>
              el
                .cursor_pointer()
                .hover(s => s.bg(t.hover).border_color(t.accent))
                .on_click((_e, cx) => onForward(cx))
            )
            .child("→")
        )
    )
    .when(hasFile, el =>
      el
        .child(
          div()
            .id("viewer-copy-file-btn")
            .h(22)
            .px(8)
            .rounded(4)
            .flex()
            .items_center()
            .border_1()
            .border_color(copiedFile ? t.ansi2 : t.border)
            .bg(t.background)
            .text_size(11)
            .font_medium()
            .text_color(copiedFile ? t.ansi2 : t.dim)
            .cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => onCopyFile?.(cx))
            .child(copiedFile ? "Copied ✓" : "Copy")
        )
        .child(
          div()
            .id("viewer-select-text-toggle")
            .h(22)
            .px(8)
            .rounded(4)
            .flex()
            .items_center()
            .border_1()
            .border_color(selectTextMode ? t.accent : t.border)
            .bg(selectTextMode ? t.selected : t.background)
            .text_size(11)
            .font_medium()
            .text_color(selectTextMode ? t.accent : t.dim)
            .cursor_pointer()
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => onToggleSelectText?.(cx))
            .child("Select Text")
        )
    );
}

/**
 * Render windowed, soft-wrapped interactive code lines inside `#main` File Viewer.
 * Uses bounded slice rendering instead of `v_virtual_list` because GPUI prohibits child
 * `.on_click` / `.on_hover` handlers inside `v_virtual_list` `range =>` item renderers.
 */
export function renderCodeViewerBody({
  listId = "viewer-code-lines",
  idPrefix = "main-cv",
  t,
  monoFont = "monospace",
  doc,
  scrollTop = 0,
  viewportHeight = 560,
  targetLine = null,
  targetCol = null,
  highlightSymbol = "",
  hoveredTokenKey = null,
  ctrlHeld = false,
  copiedLineNum = null,
  onTokenHover = null,
  onTokenClick = null,
  onCopyLine = null,
  onScrollDelta = null,
  onSizeChange = null,
}) {
  const rows = doc?.rows || [];
  const gutterW = computeCodeGutterWidth(doc?.totalLines || 1);
  const vpH = Math.max(120, Number(viewportHeight) || 560);
  const slice = computeWindowedViewerSlice(rows.length, scrollTop, vpH - 8, CODE_VIEWER_LINE_HEIGHT);
  const scrollbar = computeScrollbarMetrics(rows.length, slice.scrollTop, slice.visibleCount, Math.max(48, vpH - 8));

  const visibleRowEls = [];
  for (let i = slice.start; i < slice.end; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const isTargetLine = Boolean(targetLine && row.lineNum === targetLine);
    const isCopiedLine = Boolean(copiedLineNum && copiedLineNum === row.lineNum);
    const wrapIdx = row.isFirstWrap ? 0 : row.rowIndex;

    visibleRowEls.push(
      h_flex()
        .id(`${idPrefix}-vrow-${row.rowIndex}`)
        .w_full()
        .min_w(0)
        .h(CODE_VIEWER_LINE_HEIGHT)
        .flex_none()
        .items_center()
        .pr(16)
        .when(isTargetLine, el => el.bg(t.selected).border_l(2).border_color(t.accent))
        .when(!isTargetLine, el => el.pl(2))
        .child(
          div()
            .id(`${idPrefix}-lnum-${row.rowIndex}`)
            .w(gutterW)
            .flex_none()
            .pr(10)
            .text_size(11)
            .font_family(monoFont)
            .text_right()
            .text_color(isCopiedLine ? t.ansi2 : (isTargetLine ? t.accent : t.dim))
            .when(row.isFirstWrap && typeof onCopyLine === "function", el =>
              el
                .cursor_pointer()
                .hover(s => s.text_color(t.foreground))
                .on_click((_e, cx) => {
                  cx?.stop_propagation?.();
                  onCopyLine(row.lineNum, cx);
                })
            )
            .child(row.isFirstWrap ? (isCopiedLine ? "✓" : String(row.lineNum)) : "")
        )
        .child(
          renderInteractiveTokenSegments({
            t,
            segments: row.segments,
            isTargetLine,
            baseTarget: true,
            highlightSymbol,
            targetCol,
            monoFont,
            ctrlHeld,
            hoveredTokenKey,
            idPrefix,
            lineNum: row.lineNum,
            wrapIdx,
            fillWidth: true,
            onTokenHover,
            onTokenClick,
          })
        )
    );
  }

  const pageStep = Math.max(1, slice.visibleCount - 2);

  return div()
    .id(listId)
    .flex_1()
    .min_h(0)
    .w_full()
    .min_w(0)
    .relative()
    .overflow_hidden()
    .when(typeof onSizeChange === "function", el =>
      el.on_size_change((size, cx) => onSizeChange(size?.width || 0, size?.height || 0, cx))
    )
    .when(rows.length > 0 && typeof onScrollDelta === "function", el =>
      el.on_scroll_wheel((e, cx) => {
        const dx = Math.abs(e.delta?.x || 0);
        const dy = Math.abs(e.delta?.y || 0);
        const dlY = Number(e.delta_lines?.y || 0);
        if (dlY !== 0 || (dy > 0 && dy >= dx && !e.modifiers?.shift)) {
          const delta = resolveWheelLineDelta(e.delta?.y || 0, dlY);
          if (delta !== 0) {
            onScrollDelta(delta, cx);
            cx?.stop_propagation?.();
          }
        }
      })
    )
    .when(visibleRowEls.length > 0, container =>
      container.child(
        v_flex()
          .size_full()
          .min_w(0)
          .py(4)
          .overflow_hidden()
          .children(visibleRowEls)
      )
    )
    .when(scrollbar.visible, container =>
      container.child(
        v_flex()
          .id(`${listId}-scrollbar-track`)
          .absolute()
          .top(4)
          .bottom(4)
          .right(2)
          .w(8)
          .items_center()
          .on_mouse_down("left", (_e, cx) => cx?.stop_propagation?.())
          .child(
            div()
              .id(`${listId}-sb-up`)
              .w_full()
              .h(scrollbar.thumbTop)
              .flex_none()
              .when(scrollbar.thumbTop > 0 && typeof onScrollDelta === "function", el =>
                el
                  .cursor_pointer()
                  .on_click((_e, cx) => {
                    cx?.stop_propagation?.();
                    onScrollDelta(-pageStep, cx);
                  })
              )
          )
          .child(
            div()
              .id(`${listId}-sb-thumb`)
              .w(6)
              .h(scrollbar.thumbHeight)
              .flex_none()
              .rounded(3)
              .bg(t.border)
              .hover(s => s.bg(t.muted))
          )
          .child(
            div()
              .id(`${listId}-sb-down`)
              .w_full()
              .flex_1()
              .min_h(0)
              .when(typeof onScrollDelta === "function", el =>
                el
                  .cursor_pointer()
                  .on_click((_e, cx) => {
                    cx?.stop_propagation?.();
                    onScrollDelta(pageStep, cx);
                  })
              )
          )
      )
    );
}

/**
 * Render non-blocking code-navigation feedback pill inside viewer or preview surfaces.
 */
export function renderNavToastBanner({
  id = "viewer-nav-toast",
  t,
  notice = null,
  onDismiss = null,
}) {
  if (!notice || !notice.message) return null;
  const isWarn = notice.level === "warn";
  return h_flex()
    .id(id)
    .px(10)
    .py(5)
    .gap(8)
    .items_center()
    .rounded(6)
    .bg(t.raised)
    .border_1()
    .border_color(isWarn ? t.ansi3 : t.ansi4)
    .text_size(11.5)
    .text_color(t.foreground)
    .child(
      div()
        .w(6)
        .h(6)
        .rounded(3)
        .flex_none()
        .bg(isWarn ? t.ansi3 : t.ansi4)
    )
    .child(div().flex_1().min_w(0).truncate().child(notice.message))
    .when(typeof onDismiss === "function", el =>
      el.child(
        div()
          .text_size(11)
          .text_color(t.dim)
          .cursor_pointer()
          .hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            cx?.stop_propagation?.();
            onDismiss(cx);
          })
          .child("✕")
      )
    );
}

/**
 * Render adaptive implementation disambiguation popover backed by `shared/dropdown.js`.
 */
export function renderNavDisambiguationPopover({
  overlayId = "viewer-nav-disambig-overlay",
  menuId = "viewer-nav-disambig-menu",
  triggerId,
  t,
  monoFont = "monospace",
  disambig = null,
  currentRoot = "",
  currentServiceName = "",
  scrollHandle = null,
  top = 42,
  left = null,
  right = 12,
  anchor = left != null ? "left" : "right",
  minWidth = 300,
  maxWidth = 480,
  maxHeight = 280,
  panelWidth = 520,
  marginX = 20,
  onSelectCandidate = null,
  onClose = null,
}) {
  if (!disambig || !Array.isArray(disambig.candidates) || disambig.candidates.length === 0) {
    return null;
  }

  const rawItems = buildDisambiguationDropdownItems(
    disambig.candidates,
    currentRoot,
    currentServiceName,
  );
  const selectedIndex = Math.max(0, Math.min(rawItems.length - 1, Number(disambig.selectedIndex) || 0));
  const items = rawItems.map((item, idx) => ({
    ...item,
    selected: idx === selectedIndex,
    onSelect: (_e, cx) => onSelectCandidate?.(item.candidate, cx),
  }));

  return renderDropdownPopover({
    overlayId,
    menuId,
    triggerId,
    top,
    left: left ?? 10,
    right: right ?? 12,
    anchor,
    minWidth,
    maxWidth,
    maxHeight,
    panelWidth,
    marginX,
    items,
    scrollHandle,
    monoFont,
    t,
    onClose,
  });
}
