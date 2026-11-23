import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, shared, run, window, keys } from "herdr";
import { createModLogger } from "./diagnostics.js";

function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export default class CognivisorStatus extends View {
  init() {
    this.logger = createModLogger("cognivisor-status");
    this.exportingDiagnostics = false;
  }

  close() {
    try { this.logger?.dispose?.(); } catch {}
  }

  exportDiagnostics(cx) {
    if (this.exportingDiagnostics) return;
    this.exportingDiagnostics = true;
    const diag = shared("cognivisor.diagnostics");
    this.logger?.action("status.exportDiagnostics", {
      unreadErrors: Number(diag?.errorCount) || 0,
      lastErrorMod: diag?.lastErrorMod || null,
    }, cx);
    cx.spawn(async (cx) => {
      try {
        await this.logger?.exportReport({ trigger: "status-bar" });
      } finally {
        this.exportingDiagnostics = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  // Format the actual bound key for app.palette; fall back to "commands" when unbound.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = {
      cmd: mac ? "⌘" : "Ctrl+",
      ctrl: mac ? "⌃" : "Ctrl+",
      shift: mac ? "⇧" : "Shift+",
      alt: mac ? "⌥" : "Alt+",
      option: mac ? "⌥" : "Alt+",
    };
    const allKeys = keys() ?? [];
    const b = allKeys.find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys?.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const spaceList = spaces() ?? [];
    const space = spaceList.find((s) => s.active) ?? null;

    const cognivisorServices = shared("cognivisor.services");
    const activeFolder = space?.folder ? normPath(space.folder) : null;
    const servicesRoot = cognivisorServices?.workspaceRoot ? normPath(cognivisorServices.workspaceRoot) : null;
    const servicesMatchSpace = !activeFolder || !servicesRoot || servicesRoot === activeFolder;
    const services = servicesMatchSpace && Array.isArray(cognivisorServices?.services) ? cognivisorServices.services : [];
    const dirtyCount = services.filter((s) => (Number(s?.workingCount) || 0) > 0 || s?.dirty === true).length;
    const servicesText = dirtyCount > 0
      ? `${services.length} services · ${dirtyCount} dirty`
      : `${services.length} services`;

    const agentList = agents() ?? [];
    const needsCount = agentList.filter((a) => a.status === "blocked").length;
    const workingCount = agentList.filter((a) => a.status === "working").length;
    const agentDotColor = needsCount > 0 ? t.blocked : workingCount > 0 ? t.working : t.dim;

    const iconLabel = (id, icon, text) => h_flex()
      .id(id)
      .flex_none()
      .gap(5)
      .items_center()
      .child(svg(`mods/cognivisor-status/icons/${icon}.svg`).size(12.5).flex_none())
      .child(div().truncate().child(text));

    const diag = shared("cognivisor.diagnostics");
    const diagErrors = Number(diag?.errorCount) || 0;
    const diagTooltip = diagErrors > 0
      ? `${diagErrors} diagnostic ${diagErrors === 1 ? "error" : "errors"} (${diag?.lastErrorMod || "mod"}: ${diag?.lastErrorEvent || "error"}). Click to export JSON report.`
      : "Export Cognivisor diagnostic JSON report";

    return h_flex()
      .id("cognivisor-status")
      .size_full()
      .h(28)
      .px(14)
      .gap(12)
      .items_center()
      .overflow_hidden()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(t.muted)
      .child(iconLabel("status-machine", space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(services.length > 1, (el) => el.child(iconLabel("status-services", "layers", servicesText)))
      .when(Boolean(space?.branch), (el) => el.child(iconLabel("status-branch", "branch", space.branch)))
      .child(
        h_flex()
          .id("status-agents")
          .flex_none()
          .gap(6)
          .items_center()
          .child(div().size(6).rounded(3).flex_none().bg(agentDotColor))
          .child(`${agentList.length} agents`)
          .when(needsCount > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needsCount} needs you`)))
      )
      .child(div().flex_1().min_w(0))
      .child(
        div()
          .id("status-diagnostics")
          .flex_none()
          .px(6)
          .py(2)
          .rounded(4)
          .text_color(diagErrors > 0 ? t.blocked : t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(diagErrors > 0 ? t.blocked : t.foreground))
          .tooltip(diagTooltip)
          .on_click((_e, cx) => this.exportDiagnostics(cx))
          .child(
            this.exportingDiagnostics
              ? "Exporting…"
              : diagErrors > 0
                ? `⚠ ${diagErrors} ${diagErrors === 1 ? "error" : "errors"} · Export`
                : "Logs"
          )
      )
      .child(
        div()
          .id("palette")
          .flex_none()
          .px(6)
          .py(2)
          .rounded(4)
          .text_color(t.dim)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("app.palette"))
          .child(this.hint())
      );
  }
}
