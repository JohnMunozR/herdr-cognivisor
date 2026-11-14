// Shared reusable GPUI Markdown rendered toggle button and TextView.markdown viewer surface.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Scrollbar } from "gpui-base";
import {
  DEFAULT_MARKDOWN_MAX_CHARS,
  classifyMarkdownLink,
  prepareMarkdownForRender,
} from "./markdown-view-logic.js";

/**
 * Bounded LRU cache of prepareMarkdownForRender results keyed by file/revision/maxChars.
 */
export function createMarkdownRenderCache(maxEntries = 16) {
  const cap = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 16;
  const map = new Map();

  return {
    getOrPrepare(key, rawText, options) {
      if (key && map.has(key)) {
        const hit = map.get(key);
        map.delete(key);
        map.set(key, hit);
        return hit;
      }
      const prepared = prepareMarkdownForRender(rawText, options);
      if (key) {
        if (map.size >= cap) {
          const oldest = map.keys().next().value;
          if (oldest !== undefined) map.delete(oldest);
        }
        map.set(key, prepared);
      }
      return prepared;
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

/**
 * Render a compact toggle button for switching between raw/diff view and formatted Markdown view.
 */
export function renderMarkdownToggleButton({
  id = "markdown-render-toggle",
  active = false,
  compact = false,
  disabled = false,
  height = 24,
  px,
  rounded = 5,
  icon = "",
  iconSize = 11,
  label,
  activeLabel,
  tooltip,
  t,
  onClick,
} = {}) {
  const themeObj = t || {};
  const resolvedPx = typeof px === "number" ? px : compact ? 7 : 9;
  const resolvedLabel = active
    ? (activeLabel ?? (compact ? "MD" : "Rendered"))
    : (label ?? (compact ? "MD" : "Render"));
  const resolvedTooltip = tooltip || (active ? "Switch back to raw source view" : "Render formatted Markdown");
  const activeAccent = themeObj.accent || themeObj.ansi4 || themeObj.solid || themeObj.foreground;

  return h_flex()
    .id(id)
    .h(height)
    .px(resolvedPx)
    .gap(5)
    .flex_none()
    .items_center()
    .justify_center()
    .rounded(rounded)
    .border_1()
    .tooltip(resolvedTooltip)
    .when(disabled, (el) =>
      el
        .border_color(themeObj.border)
        .bg(themeObj.background)
        .text_color(themeObj.dim)
    )
    .when(!disabled && active, (el) =>
      el
        .cursor_pointer()
        .border_color(activeAccent)
        .bg(themeObj.selected || themeObj.hover || themeObj.raised || themeObj.background)
        .text_color(themeObj.foreground)
        .hover((s) => s.bg(themeObj.hover || themeObj.selected))
    )
    .when(!disabled && !active, (el) =>
      el
        .cursor_pointer()
        .border_color(themeObj.border)
        .bg(themeObj.raised || themeObj.background)
        .text_color(themeObj.muted || themeObj.dim)
        .hover((s) => s.bg(themeObj.hover).text_color(themeObj.foreground))
    )
    .when(!disabled && typeof onClick === "function", (el) =>
      el
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((e, cx) => {
          cx.stop_propagation();
          onClick(e, cx);
        })
    )
    .when(Boolean(icon), (el) =>
      el.child(
        svg(icon)
          .size(iconSize)
          .flex_none()
          .text_color(active ? activeAccent : (themeObj.muted || themeObj.dim))
      )
    )
    .when(!icon && active, (el) =>
      el.child(div().w(6).h(6).rounded_full().flex_none().bg(activeAccent))
    )
    .child(
      div()
        .text_size(11)
        .when(Boolean(active), (el) => el.font_medium())
        .child(String(resolvedLabel))
    );
}

function renderFrontmatterCard(prepared, monoFont, themeObj) {
  const entries = Array.isArray(prepared?.frontmatterEntries) ? prepared.frontmatterEntries : [];
  if (!prepared?.hasFrontmatter) return null;

  return v_flex()
    .flex_none()
    .w_full()
    .rounded(7)
    .border_1()
    .border_color(themeObj.border)
    .bg(themeObj.raised || themeObj.chrome || themeObj.background)
    .px(10)
    .py(8)
    .gap(5)
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(
          div()
            .text_size(10)
            .font_semibold()
            .text_color(themeObj.dim)
            .child("FRONTMATTER")
        )
        .when(prepared.extraEntriesCount > 0, (el) =>
          el.child(
            div()
              .text_size(10)
              .text_color(themeObj.dim)
              .child(`+${prepared.extraEntriesCount} more`)
          )
        )
    )
    .when(entries.length > 0, (el) =>
      el.child(
        h_flex()
          .flex_wrap()
          .gap(6)
          .children(
            entries.map((entry) =>
              h_flex()
                .max_w_full()
                .px(6)
                .py(2)
                .gap(4)
                .rounded(4)
                .border_1()
                .border_color(themeObj.border)
                .bg(themeObj.background)
                .items_center()
                .child(
                  div()
                    .flex_none()
                    .font_family(monoFont)
                    .text_size(10.5)
                    .font_medium()
                    .text_color(themeObj.accent || themeObj.foreground)
                    .child(`${entry.key}:`)
                )
                .child(
                  div()
                    .min_w(0)
                    .truncate()
                    .font_family(monoFont)
                    .text_size(10.5)
                    .text_color(themeObj.muted || themeObj.foreground)
                    .child(entry.value)
                )
            )
          )
      )
    );
}

function renderNoticePill(text, isWarning, themeObj) {
  const warnColor = themeObj.ansi3 || themeObj.accent || themeObj.muted;
  return h_flex()
    .flex_none()
    .w_full()
    .px(10)
    .py(6)
    .rounded(6)
    .border_1()
    .border_color(themeObj.border)
    .bg(themeObj.raised || themeObj.chrome || themeObj.background)
    .items_center()
    .gap(6)
    .child(
      div()
        .w(6)
        .h(6)
        .rounded_full()
        .flex_none()
        .bg(isWarning ? warnColor : (themeObj.accent || themeObj.dim))
    )
    .child(
      div()
        .flex_1()
        .min_w(0)
        .text_size(11.5)
        .text_color(themeObj.muted || themeObj.foreground)
        .child(text)
    );
}

function formatCharCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return String(Math.max(0, Math.floor(num))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Render an adaptive scrollable TextView.markdown surface with safe link handling,
 * compact YAML frontmatter badges, and truncation/MDX/diff banners.
 */
export function renderMarkdownViewer({
  id = "markdown-text-view",
  scrollId = "markdown-scroll-view",
  prepared = null,
  rawText,
  filePath = "",
  maxChars = DEFAULT_MARKDOWN_MAX_CHARS,
  loading = false,
  error = "",
  noticeBanner = "",
  emptyText = "Empty Markdown file",
  monoFont = "monospace",
  paddingX = 18,
  paddingY = 14,
  t,
  onRelativeLink = null,
  onLinkClick = null,
} = {}) {
  const themeObj = t || {};
  const effectiveMaxChars = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MARKDOWN_MAX_CHARS;
  const data = prepared || (typeof rawText === "string"
    ? prepareMarkdownForRender(rawText, { filePath, maxChars: effectiveMaxChars })
    : null);

  if (loading && !data) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .w_full()
      .items_center()
      .justify_center()
      .child(div().text_size(12).text_color(themeObj.dim).child("Loading Markdown…"));
  }

  if (error) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .w_full()
      .p(20)
      .gap(6)
      .child(
        div()
          .text_size(12.5)
          .text_color(themeObj.ansi1 || themeObj.blocked || themeObj.dim)
          .child(String(error))
      );
  }

  if (!data || data.isEmpty) {
    return v_flex()
      .flex_1()
      .min_h(0)
      .w_full()
      .items_center()
      .justify_center()
      .child(div().text_size(12.5).text_color(themeObj.dim).child(emptyText));
  }

  const notices = [];
  if (noticeBanner) notices.push({ text: String(noticeBanner), warn: true });
  if (data.truncated) {
    notices.push({
      text: `Rendered preview capped at ${formatCharCount(effectiveMaxChars)} chars (${formatCharCount(data.omittedChars)} omitted) — switch to raw view for full content.`,
      warn: true,
    });
  }
  if (data.hasMdxSyntax) {
    notices.push({
      text: "MDX file detected: ESM imports/exports and JSX tags are shown as plain text.",
      warn: false,
    });
  }

  const frontmatterCard = renderFrontmatterCard(data, monoFont, themeObj);
  const bodyMarkdown = data.markdown || "";

  return v_flex()
    .relative()
    .flex_1()
    .min_h(0)
    .w_full()
    .overflow_hidden()
    .child(
      v_flex()
        .id(scrollId)
        .size_full()
        .overflow_y_scroll()
        .px(paddingX)
        .py(paddingY)
        .gap(10)
        .children(notices.map((n) => renderNoticePill(n.text, n.warn, themeObj)))
        .when(Boolean(frontmatterCard), (el) => el.child(frontmatterCard))
        .when(Boolean(bodyMarkdown.trim()), (el) =>
          el.child(
            TextView.markdown(id, bodyMarkdown)
              .selectable(true)
              .scrollable(false)
              .w_full()
              .on_link_click((url, cx) => {
                if (typeof onLinkClick === "function") {
                  try {
                    if (onLinkClick(url, cx) === true) return;
                  } catch {}
                }
                const classified = classifyMarkdownLink(url);
                if (classified.kind === "external") {
                  try {
                    cx?.open_url?.(classified.url);
                  } catch {}
                  return;
                }
                if (classified.kind === "relative" && typeof onRelativeLink === "function") {
                  try {
                    onRelativeLink(classified.url, cx);
                  } catch {}
                }
              })
          )
        )
    )
    .child(Scrollbar.vertical(scrollId).absolute().inset_0());
}
