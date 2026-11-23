import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import {
  spaces, panes, terminals, exec, hc, run, openOverlay,
  theme, window, shared, setShared, layout, settings,
} from "herdr";
import {
  findNode,
  asPlainObject,
  resolveSpacePanelTarget,
  classifyViewerTab,
  isGenericName,
  isGenericTab,
  findLeadPane,
  extractJiraKey,
  extractPromptLine,
  summarizePrompt,
  cleanBranchSlug,
} from "./tab-logic.js";
import { createModLogger, renderErrorFallbackCard } from "./diagnostics.js";

const READ_GIT = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false",
];

const PANEL_DEFS = [
  { id: "files", label: "Files", icon: "mods/cognivisor-tabs/icons/files.svg" },
  { id: "changes", label: "Review", icon: "mods/cognivisor-tabs/icons/changes.svg" },
  { id: "git", label: "Git", icon: "mods/cognivisor-tabs/icons/git.svg" },
];

const PROBE_COOLDOWN_MS = 8000;
const ACTIVE_STATUSES = new Set(["working", "done", "blocked"]);

export default class CognivisorTabs extends View {
  init(_props, cx) {
    this.logger = createModLogger("cognivisor-tabs");
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.probeCache = new Map();
    this.editingTabId = null;
    this.editingStartedAt = 0;
    this.knownTabIds = new Set();
    this.focusRenameTask = null;
    this.pendingPanelSyncTask = null;
    this.pendingTabScanTask = null;

    this.renameInput = InputState.new({ placeholder: "Tab name" });
    this.renameInput.on("submit", (_e, cx) => this.commitRename(cx));
    this.renameInput.on("blur", (_e, cx) => {
      if (this.editingTabId && Date.now() - this.editingStartedAt > 150) {
        this.cancelRename(cx);
      }
    });

    this.scanUnnamedTabs(cx);
    cx.timer.every(5000, (cx) => this.scanUnnamedTabs(cx));
  }

  close() {
    try { this.logger?.dispose?.(); } catch {}
    try { this.focusRenameTask?.cancel(); } catch {}
    try { this.pendingPanelSyncTask?.cancel(); } catch {}
    try { this.pendingTabScanTask?.cancel(); } catch {}
    this.focusRenameTask = null;
    this.pendingPanelSyncTask = null;
    this.pendingTabScanTask = null;
    try { this.renameInput?.release(); } catch {}
    try { this.scroll?.release(); } catch {}
  }

  startRename(tab, currentName, cx) {
    this.editingTabId = tab.id;
    this.editingStartedAt = Date.now();
    const initial = String(currentName || "").trim();
    this.renameInput.set_value(initial);
    if (initial) {
      this.renameInput.set_selected_range({ start: 0, end: initial.length });
    }
    this.renameInput.focus();
    cx.notify();
    try { this.focusRenameTask?.cancel(); } catch {}
    this.focusRenameTask = cx.timer.after(20, () => {
      this.focusRenameTask = null;
      if (this.editingTabId === tab.id) {
        this.renameInput?.focus();
      }
    });
  }

  cancelRename(cx) {
    if (!this.editingTabId) return;
    this.editingTabId = null;
    cx.notify();
  }

  commitRename(cx) {
    const id = this.editingTabId;
    if (!id) return;
    const raw = this.renameInput.value().trim();
    this.editingTabId = null;

    const ownerSpace = spaces().find((s) => (s.tabs ?? []).some((t) => t.id === id)) || spaces().find((s) => s.active);
    const flows = asPlainObject(shared("cognivisor.flows"));
    const existing = asPlainObject(flows[id]);

    if (raw) {
      run("tab.rename", { id, name: raw });
      const ticket = extractJiraKey(raw) || existing.ticket || null;
      setShared("cognivisor.flows", {
        ...flows,
        [id]: {
          ...existing,
          tabId: id,
          workspaceRoot: ownerSpace?.folder || existing.workspaceRoot || "",
          stage: existing.stage || "plan",
          ticket,
          derivedTitle: existing.derivedTitle ?? null,
          manualTitle: true,
          leadTerminal: existing.leadTerminal ?? null,
          reviewedServices: existing.reviewedServices || {},
          updatedAt: Date.now(),
        },
      });
    } else {
      run("tab.rename", { id, name: "" });
      for (const cacheKey of this.probeCache.keys()) {
        if (cacheKey.startsWith(`${id}::`)) {
          this.probeCache.delete(cacheKey);
        }
      }
      setShared("cognivisor.flows", {
        ...flows,
        [id]: {
          ...existing,
          tabId: id,
          workspaceRoot: ownerSpace?.folder || existing.workspaceRoot || "",
          stage: existing.stage || "plan",
          ticket: existing.ticket ?? null,
          derivedTitle: null,
          autoNamed: false,
          manualTitle: false,
          leadTerminal: existing.leadTerminal ?? null,
          reviewedServices: existing.reviewedServices || {},
          updatedAt: Date.now(),
        },
      });
    }
    cx.notify();
  }

  // Persist per-space panel choices in shared("cognivisor.spacePanels") without leaving stale transitions.
  syncPanel(space, panel, body, enabled, cx) {
    if (!space || !panel || !cx) return;
    const panels = asPlainObject(shared("cognivisor.spacePanels"));
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      this.editingTabId = null;
      if (!(first && !(space.id in panels))) {
        const stored = panels[space.id] ?? null;
        const want = resolveSpacePanelTarget(stored, enabled);
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          try { this.pendingPanelSyncTask?.cancel(); } catch {}
          this.pendingPanelSyncTask = cx.timer.after(0, () => {
            this.pendingPanelSyncTask = null;
            if (want) {
              run("layout.select", { stack: "panel-body", child: want });
              run("layout.show", { id: "panel" });
            } else {
              run("layout.hide", { id: "panel" });
            }
          });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (Object.prototype.hasOwnProperty.call(panels, space.id) && panels[space.id] === now) return;
    const spaceId = space.id;
    try { this.pendingPanelSyncTask?.cancel(); } catch {}
    this.pendingPanelSyncTask = cx.timer.after(0, () => {
      this.pendingPanelSyncTask = null;
      const latestPanels = asPlainObject(shared("cognivisor.spacePanels"));
      if (Object.prototype.hasOwnProperty.call(latestPanels, spaceId) && latestPanels[spaceId] === now) return;
      setShared("cognivisor.spacePanels", { ...latestPanels, [spaceId]: now });
    });
  }

  scanUnnamedTabs(cx) {
    const allSpaces = spaces();
    const allPanes = panes();
    const allTerminals = terminals();
    const flows = asPlainObject(shared("cognivisor.flows"));
    const now = Date.now();

    for (const space of allSpaces) {
      for (const tab of space?.tabs ?? []) {
        if (tab.named || this.editingTabId === tab.id) continue;
        const flow = asPlainObject(flows[tab.id]);
        if (flow.manualTitle === true || flow.autoNamed === true) continue;

        const leadPane = findLeadPane(tab.id, allPanes, allTerminals, flow.leadTerminal);
        if (!leadPane?.terminal) continue;
        if (!isGenericTab(tab, leadPane.program)) continue;

        const terminal = leadPane.terminal;
        const cacheKey = `${tab.id}::${terminal}`;
        const cached = this.probeCache.get(cacheKey);
        if (cached?.done || cached?.inFlight) continue;
        if (cached?.lastAttempt && now - cached.lastAttempt < PROBE_COOLDOWN_MS) continue;

        this.probeCache.set(cacheKey, { lastAttempt: now, inFlight: true, done: false });
        cx.spawn(async (cx) => {
          await this.probeAndRenameTab({ space, tab, leadPane, terminal, cacheKey }, cx);
        });
      }
    }
  }

  async probeAndRenameTab({ space, tab, leadPane, terminal, cacheKey }, cx) {
    let renamed = false;
    try {
      const getRes = await hc(["get", terminal, "--json"]).catch(() => null);
      if (!getRes || getRes.code !== 0 || !getRes.stdout?.trim()) return;

      let info;
      try {
        info = JSON.parse(getRes.stdout);
      } catch {
        return;
      }
      if (!info || info.labels?.cognivisorRunner === "true") return;

      const infoStatus = typeof info.status === "string" ? info.status : info.status?.state;
      const firstMessage = typeof info.first_message === "string" ? info.first_message.trim() : "";
      const hasInteracted = Boolean(
        firstMessage ||
        (typeof info.turn === "number" && info.turn > 0) ||
        ACTIVE_STATUSES.has(infoStatus) ||
        ACTIVE_STATUSES.has(leadPane?.status) ||
        ACTIVE_STATUSES.has(tab.status),
      );
      if (!hasInteracted) return;

      let promptLine = "";
      if (!firstMessage) {
        const readRes = await hc(["read", "--lines", "40", terminal]).catch(() => null);
        if (readRes && readRes.code === 0 && readRes.stdout) {
          promptLine = extractPromptLine(readRes.stdout);
        }
      }

      const gitCwd = info.foreground?.cwd || leadPane.cwd || space?.folder || "";
      let branch = "";
      if (gitCwd) {
        const gitRes = await exec(
          "git",
          [...READ_GIT, "rev-parse", "--abbrev-ref", "HEAD"],
          { cwd: gitCwd, on: space?.machine || null, timeout: 4000 },
        ).catch(() => null);
        if (gitRes && gitRes.code === 0) {
          const out = (gitRes.stdout || "").trim();
          if (out && out !== "HEAD") branch = out;
        }
      }
      if (!branch && leadPane.branch) {
        branch = leadPane.branch;
      }

      const title = typeof info.title === "string" ? info.title.trim() : "";
      const statusMsg = typeof info.status?.msg === "string" ? info.status.msg.trim() : "";
      const ticket = extractJiraKey(firstMessage, promptLine, title, branch, statusMsg);
      const summary = summarizePrompt(firstMessage || promptLine, ticket);
      const branchSlug = cleanBranchSlug(branch, ticket);

      let derivedName = "";
      if (ticket && summary) derivedName = `${ticket} · ${summary}`;
      else if (ticket && branchSlug) derivedName = `${ticket} · ${branchSlug}`;
      else if (ticket) derivedName = ticket;
      else if (summary) derivedName = summary;
      else if (branchSlug) derivedName = branchSlug;

      if (!derivedName || isGenericName(derivedName, leadPane.program)) return;

      // Re-validate current tab and flow state after async awaits so manual renames always win.
      const freshSpace = spaces().find((s) => s.id === space.id);
      const freshTab = (freshSpace?.tabs ?? []).find((t) => t.id === tab.id);
      const freshFlows = asPlainObject(shared("cognivisor.flows"));
      const existing = asPlainObject(freshFlows[tab.id]);
      if (!freshTab || freshTab.named || this.editingTabId === tab.id) return;
      if (existing.manualTitle === true || existing.autoNamed === true) return;

      if (derivedName !== freshTab.name) {
        run("tab.rename", { id: tab.id, name: derivedName });
      }
      setShared("cognivisor.flows", {
        ...freshFlows,
        [tab.id]: {
          ...existing,
          tabId: tab.id,
          workspaceRoot: freshSpace?.folder || existing.workspaceRoot || "",
          stage: existing.stage || "plan",
          ticket: ticket || existing.ticket || null,
          derivedTitle: derivedName,
          autoNamed: true,
          manualTitle: Boolean(existing.manualTitle),
          leadTerminal: existing.leadTerminal || terminal,
          reviewedServices: existing.reviewedServices || {},
          updatedAt: Date.now(),
        },
      });
      renamed = true;
      cx.notify();
    } finally {
      this.probeCache.set(cacheKey, {
        lastAttempt: Date.now(),
        inFlight: false,
        done: renamed,
      });
    }
  }

  render(cx) {
    try {
      return this.renderInner(cx);
    } catch (err) {
      const ser = this.logger?.recordRenderError(err, { selected: this.selected || null }, cx);
      const summary = ser ? `${ser.name}: ${ser.message}` : String(err || "Render error");
      return renderErrorFallbackCard({
        modName: "cognivisor-tabs",
        errorSummary: summary,
        t: theme(),
        onRetry: (retryCx) => retryCx.notify(),
        onExport: (exportCx) => {
          exportCx.spawn(async () => {
            await this.logger?.exportReport({ trigger: "error-card" });
          });
        },
      });
    }
  }

  renderInner(cx) {
    const t = theme();
    const space = spaces().find((p) => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex((tab) => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }

    const allPanes = panes();
    const openFileTabs = asPlainObject(shared("cognivisor.openFileTabs"));
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) =>
      div()
        .id(id)
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(action)
        .child(label);

    const item = (c, i) => {
      const tabPanes = allPanes.filter((p) => p.tab === c.id);
      const program =
        tabPanes.find((p) => p.program?.agent)?.program ??
        tabPanes[0]?.program;
      const openFileEntry = openFileTabs[c.id] || null;
      const { isViewerTab, modIconPath, usesAccentTint } = classifyViewerTab(tabPanes, openFileEntry);
      const displayName = /^tb\d+$/.test(c.name) ? (program?.name ?? "Terminal") : c.name;
      const isEditing = this.editingTabId === c.id;
      const modIconColor = usesAccentTint
        ? (c.active ? (t.accent || t.foreground) : t.muted)
        : (openFileEntry?.iconColor || (c.active ? t.foreground : t.muted));

      return h_flex()
        .id(`tab-${c.id}`)
        .h(29)
        .px(10)
        .gap(7)
        .rounded(7)
        .items_center()
        .flex_none()
        .text_size(12.8)
        .when(Boolean(openFileEntry?.displayPath), (el) => el.tooltip(openFileEntry.displayPath))
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, (el) =>
          el.on_size_change((_size, cx) => {
            this.scroll.scroll_to_item(active);
            cx.notify();
          }),
        )
        .border(1)
        .border_color(c.active ? t.border : t.chrome)
        .bg(c.active ? t.raised : t.chrome)
        .text_color(c.active ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          if (isEditing) return;
          if (e.click_count === 2) {
            this.pressed = null;
            this.startRename(c, displayName, cx);
            return;
          }
          this.pressed = i;
        })
        .on_mouse_up("left", () => {
          if (isEditing || this.editingTabId === c.id) {
            this.pressed = null;
            return;
          }
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== i && shown[from]) {
            run("tab.move", {
              id: shown[from].id,
              index: space.tabs.findIndex((x) => x.id === c.id) + 1,
            });
          } else if (from === i) {
            run("tab.select", { id: c.id });
          }
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: "menu",
            kind: "popup",
            width: 200,
            props: { tab: "tab", target: { id: c.id, space: space.id } },
          });
        })
        .when(Boolean(program?.icon), (el) =>
          el.child(
            program.tint
              ? svg(program.icon).size(14).text_color(t.muted)
              : image(program.icon).size(14),
          ),
        )
        .when(!program?.icon && Boolean(modIconPath), (el) =>
          el.child(svg(modIconPath).size(13).flex_none().text_color(modIconColor)),
        )
        .when(isEditing, (el) =>
          el.child(
            div()
              .id(`tab-rename-${c.id}`)
              .w(150)
              .h(22)
              .px(6)
              .flex()
              .items_center()
              .rounded(5)
              .bg(t.background)
              .border_1()
              .border_color(t.accent)
              .on_mouse_down("left", stop)
              .on_mouse_up("left", stop)
              .on_key_down((e, cx) => {
                if (e.key === "escape") {
                  cx.stop_propagation();
                  this.cancelRename(cx);
                }
              })
              .child(
                Input.new(this.renameInput)
                  .w_full()
                  .h_full()
                  .text_size(12.2)
                  .text_color(t.foreground),
              ),
          ),
        )
        .when(!isEditing, (el) =>
          el.child(div().max_w(170).truncate().child(c.zoomed ? `${displayName} Z` : displayName)),
        )
        .when(c.status === "working", (el) =>
          el.child(svg("mods/cognivisor-tabs/icons/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)),
        )
        .when(c.status === "blocked" || c.status === "done", (el) =>
          el.child(div().size(6).rounded(3).bg(t[c.status])),
        )
        .when((c.active || isViewerTab) && !isEditing, (el) =>
          el.child(
            div()
              .id(`close-${c.id}`)
              .text_color(c.active ? t.dim : t.muted)
              .cursor_pointer()
              .hover((s) => s.text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("tab.close", { id: c.id });
              })
              .child(svg("mods/cognivisor-tabs/icons/close.svg").size(12)),
          ),
        );
    };

    const root = layout();
    const sidebar = findNode(root, "sidebar");
    const w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding =
      w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
        ? Math.max(
            10,
            (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0),
          )
        : 10;

    const panel = findNode(root, "panel");
    const body = findNode(root, "panel-body");
    const enabled = PANEL_DEFS.map((d) => d.id);
    this.syncPanel(space, panel, body, enabled, cx);

    let hasNewUnseenTab = false;
    for (const tab of shown) {
      if (tab?.id && !this.knownTabIds.has(tab.id)) {
        this.knownTabIds.add(tab.id);
        hasNewUnseenTab = true;
      }
    }
    if (hasNewUnseenTab && !this.pendingTabScanTask) {
      this.pendingTabScanTask = cx.timer.after(0, (cx) => {
        this.pendingTabScanTask = null;
        this.scanUnnamedTabs(cx);
      });
    }

    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex()
        .id(`panel-${id}`)
        .h(26)
        .px(8)
        .gap(5)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .cursor_pointer()
        .bg(on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(() => {
          if (on) {
            run("layout.hide", { id: "panel" });
          } else {
            run("layout.select", { stack: "panel-body", child: id });
            run("layout.show", { id: "panel" });
          }
        })
        .child(svg(icon).size(14))
        .child(label);
    };

    let bar = h_flex()
      .size_full()
      .min_w(0)
      .px(10)
      .pl(lightsPadding)
      .gap(3)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .on_mouse_up("left", () => {
        this.pressed = null;
      })
      .on_scroll_wheel((e) => {
        if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next");
      })
      .child(
        h_flex()
          .id("tab-scroll")
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .gap(3)
          .overflow_x_scrollbar()
          .track_scroll(this.scroll)
          .on_size_change((_size, cx) => {
            if (active >= 0) {
              this.scroll.scroll_to_item(active);
              cx.notify();
            }
          })
          .children(shown.map(item)),
      )
      .child(
        button("tab-new", "+", () =>
          openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }),
        ),
      );

    for (const def of PANEL_DEFS) {
      if (enabled.includes(def.id)) {
        bar = bar.child(panelButton(def.id, def.label, def.icon));
      }
    }

    return bar.when(w?.buttons, (el) =>
      el
        .child(
          button(
            "minimize",
            w.platform === "windows" ? svg("mods/cognivisor-tabs/icons/win-min.svg").size(16) : "−",
            () => run("window.minimize"),
          ),
        )
        .child(
          button(
            "maximize",
            w.platform === "windows"
              ? svg(`mods/cognivisor-tabs/${w.maximized ? "icons/win-restore.svg" : "icons/win-max.svg"}`).size(16)
              : "□",
            () => run("window.maximize"),
          ),
        )
        .child(
          button(
            "close-window",
            w.platform === "windows"
              ? svg("mods/cognivisor-tabs/icons/win-close.svg").size(16)
              : svg("mods/cognivisor-tabs/icons/close.svg").size(13),
            () => run("window.close"),
          ),
        ),
    );
  }
}
