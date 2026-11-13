import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, shared, run, window, keys } from "herdr";

function normPath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function tintedColor(color, alphaHex, fallback) {
  if (!color || typeof color !== "string") return fallback;
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 6) return `#${hex}${alphaHex}`;
    if (hex.length === 8) return `#${hex.slice(0, 6)}${alphaHex}`;
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${alphaHex}`;
    }
  }
  return fallback;
}

function isMatchingTestAlert(alert, tabId, activeRoot) {
  if (!alert || typeof alert !== "object") return false;
  if (tabId && alert.tabId) {
    return alert.tabId === tabId;
  }
  if (activeRoot && alert.workspaceRoot) {
    return normPath(alert.workspaceRoot) === normPath(activeRoot);
  }
  return false;
}

function buildTestAlertBadge(alert, t) {
  const total = Number(alert.total) || 0;
  const passed = Number(alert.passed) || 0;
  const failed = Number(alert.failed) || 0;
  const running = Number(alert.running) || 0;
  const status = alert.status;

  const workingColor = t.working || t.accent;
  const passColor = t.ansi2 || t.done || t.accent;
  const failColor = t.ansi1 || t.blocked;

  if (status === "running" || running > 0) {
    return {
      icon: null,
      dotColor: workingColor,
      color: workingColor,
      text: total > 0 ? `Test: running (${passed}/${total})` : "Test: running",
      tooltip: alert.summary || "Tests running (click to open Test panel)",
    };
  }
  if (status === "failed" || failed > 0) {
    return {
      icon: "alert",
      dotColor: null,
      color: failColor,
      text: failed > 0
        ? `Test: ${failed} failed`
        : (total > 0 ? `Test: failed (${passed}/${total})` : "Test: failed"),
      tooltip: alert.summary || "Tests failed (click to open Test panel)",
    };
  }
  if (status === "passed") {
    return {
      icon: "check",
      dotColor: null,
      color: passColor,
      text: total > 0 ? `Test: ${passed}/${total} passed` : "Test: passed",
      tooltip: alert.summary || "All tests passed (click to open Test panel)",
    };
  }
  if (status === "plan_ready") {
    return {
      icon: "check",
      dotColor: null,
      color: t.accent,
      text: total > 0 ? `Test: plan ready (${total})` : "Test: plan ready",
      tooltip: alert.summary || "Test plan ready (click to open Test panel)",
    };
  }
  return null;
}

function buildShipAlertBadge(tabFlow, t) {
  const prsMap = tabFlow?.prs;
  if (!prsMap || typeof prsMap !== "object") return null;

  const openPrs = Object.values(prsMap).filter((pr) => {
    if (!pr || typeof pr !== "object") return false;
    const state = pr.state ? String(pr.state).toUpperCase() : "OPEN";
    return state === "OPEN";
  });

  const totalPrs = openPrs.length;
  const failingCount = openPrs.filter((pr) => String(pr.checksStatus || "").toUpperCase() === "FAILING").length;
  const unresolvedCount = openPrs.reduce((sum, pr) => sum + Math.max(0, Number(pr.unresolvedCount) || 0), 0);

  if (totalPrs === 0 && failingCount === 0 && unresolvedCount === 0) return null;

  const parts = [`PRs: ${totalPrs}`];
  if (failingCount > 0) {
    parts.push(`${failingCount} failing`);
  }
  if (unresolvedCount > 0) {
    parts.push(`${unresolvedCount} ${unresolvedCount === 1 ? "comment" : "comments"}`);
  }

  const color = failingCount > 0
    ? (t.ansi1 || t.blocked)
    : unresolvedCount > 0
      ? (t.blocked || t.working || t.accent)
      : t.muted;
  const highlighted = failingCount > 0 || unresolvedCount > 0;
  return {
    text: parts.join(" · "),
    color,
    highlighted,
    tooltip: failingCount > 0
      ? `${failingCount} failing CI check(s) (click to open Ship panel)`
      : unresolvedCount > 0
        ? `${unresolvedCount} unresolved review comment(s) (click to open Ship panel)`
        : `${totalPrs} open pull request(s) (click to open Ship panel)`,
  };
}

export default class MeshStatus extends View {
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
    const activeTab = space?.tabs?.find((tab) => tab.active) ?? null;
    const tabId = activeTab?.id ?? null;

    const meshServices = shared("mesh.services");
    const activeFolder = space?.folder ? normPath(space.folder) : null;
    const servicesRoot = meshServices?.workspaceRoot ? normPath(meshServices.workspaceRoot) : null;
    const servicesMatchSpace = !activeFolder || !servicesRoot || servicesRoot === activeFolder;
    const services = servicesMatchSpace && Array.isArray(meshServices?.services) ? meshServices.services : [];
    const dirtyCount = services.filter((s) => (Number(s?.workingCount) || 0) > 0 || s?.dirty === true).length;
    const servicesText = dirtyCount > 0
      ? `${services.length} services · ${dirtyCount} dirty`
      : `${services.length} services`;

    const flows = shared("mesh.flows");
    const tabFlow = tabId && flows && typeof flows === "object" ? flows[tabId] ?? null : null;

    const testAlertRaw = shared("mesh.testAlert");
    const activeRoot = activeFolder || servicesRoot;
    const testBadge = isMatchingTestAlert(testAlertRaw, tabId, activeRoot)
      ? buildTestAlertBadge(testAlertRaw, t)
      : null;

    const shipBadge = buildShipAlertBadge(tabFlow, t);

    const agentList = agents() ?? [];
    const needsCount = agentList.filter((a) => a.status === "blocked").length;
    const workingCount = agentList.filter((a) => a.status === "working").length;
    const agentDotColor = needsCount > 0 ? t.blocked : workingCount > 0 ? t.working : t.dim;

    const iconLabel = (id, icon, text) => h_flex()
      .id(id)
      .flex_none()
      .gap(5)
      .items_center()
      .child(svg(`mods/mesh-status/icons/${icon}.svg`).size(12.5).flex_none())
      .child(div().truncate().child(text));

    return h_flex()
      .id("mesh-status")
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
      .when(Boolean(testBadge), (el) => el.child(
        h_flex()
          .id("status-test-alert")
          .h(20)
          .px(7)
          .gap(5)
          .flex_none()
          .items_center()
          .rounded(4)
          .bg(tintedColor(testBadge.color, "1c", t.raised))
          .border_1()
          .border_color(tintedColor(testBadge.color, "44", t.border))
          .text_size(11)
          .font_medium()
          .text_color(testBadge.color)
          .cursor_pointer()
          .hover((s) => s.bg(tintedColor(testBadge.color, "2e", t.hover)))
          .tooltip(testBadge.tooltip)
          .on_click(() => {
            run("layout.select", { stack: "panel-body", child: "test" });
            run("layout.show", { id: "panel" });
          })
          .when(Boolean(testBadge.dotColor), (b) => b.child(div().size(6).rounded(3).flex_none().bg(testBadge.dotColor)))
          .when(Boolean(testBadge.icon), (b) => b.child(
            svg(`mods/mesh-status/icons/${testBadge.icon}.svg`).size(12).flex_none().text_color(testBadge.color)
          ))
          .child(testBadge.text)
      ))
      .when(Boolean(shipBadge), (el) => el.child(
        h_flex()
          .id("status-ship-alert")
          .h(20)
          .px(7)
          .gap(5)
          .flex_none()
          .items_center()
          .rounded(4)
          .bg(shipBadge.highlighted ? tintedColor(shipBadge.color, "1c", t.raised) : t.raised)
          .border_1()
          .border_color(shipBadge.highlighted ? tintedColor(shipBadge.color, "44", t.border) : t.border)
          .text_size(11)
          .font_medium()
          .text_color(shipBadge.color)
          .cursor_pointer()
          .hover((s) => s.bg(shipBadge.highlighted ? tintedColor(shipBadge.color, "2e", t.hover) : t.hover).text_color(shipBadge.highlighted ? shipBadge.color : t.foreground))
          .tooltip(shipBadge.tooltip)
          .on_click(() => {
            run("layout.select", { stack: "panel-body", child: "ship" });
            run("layout.show", { id: "panel" });
          })
          .child(svg("mods/mesh-status/icons/git-pr.svg").size(12).flex_none().text_color(shipBadge.color))
          .child(shipBadge.text)
      ))
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
