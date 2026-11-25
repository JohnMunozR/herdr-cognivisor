import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import moduleApi from "node:module";

const state = {
  props: {},
  spaces: [],
  panes: [],
  terminals: [],
  agents: [],
  focused: null,
  sharedData: {},
  layout: { id: "root", children: [{ id: "panel", hidden: false }, { id: "panel-body", active: "files" }] },
  windowInfo: { platform: "linux", width: 1200, height: 800 },
  runCalls: [],
  watchHandles: [],
  closedOverlays: [],
};
globalThis.__FILES_CTRL_MOCK__ = state;

moduleApi.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "herdr" || specifier === "gpui-kit" || specifier === "gpui-base" || specifier === "fs/promises") {
      return { shortCircuit: true, url: `ctrlmock:${specifier}` };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "ctrlmock:fs/promises") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          import * as realFs from "node:fs/promises";
          export * from "node:fs/promises";
          export async function exists(p) {
            try { await realFs.access(p); return true; } catch { return false; }
          }
        `,
      };
    }
    if (url === "ctrlmock:gpui-kit") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          function makeEl(kind, arg) {
            const el = {
              _kind: kind,
              _arg: arg,
              _id: null,
              _children: [],
            };
            return new Proxy(el, {
              get(target, prop) {
                if (prop in target) return target[prop];
                if (prop === "id") return (v) => { target._id = v; return new Proxy(target, this); };
                if (prop === "child") return (c) => { if (c !== null && c !== undefined) target._children.push(c); return new Proxy(target, this); };
                if (prop === "children") return (arr) => { if (Array.isArray(arr)) target._children.push(...arr); return new Proxy(target, this); };
                if (prop === "when") return (cond, fn) => { if (cond && typeof fn === "function") fn(new Proxy(target, this)); return new Proxy(target, this); };
                if (prop === "when_some") return (val, fn) => { if (val != null && typeof fn === "function") fn(new Proxy(target, this), val); return new Proxy(target, this); };
                return () => new Proxy(target, this);
              },
            });
          }
          export class View {}
          export const div = () => makeEl("div");
          export const svg = (p) => makeEl("svg", p);
        `,
      };
    }
    if (url === "ctrlmock:gpui-base") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          import { div } from "gpui-kit";
          export const v_flex = () => div();
          export const h_flex = () => div();
          export const v_virtual_list = () => div();
          export const Input = { new: () => div() };
          export const Editor = { new: () => div() };
          export const TextView = { markdown: () => div() };
          export const Scrollbar = { vertical: () => div(), horizontal: () => div() };
          export const ScrollHandle = { new: () => ({ release() {} }) };
          export const VirtualListScrollHandle = { new: () => ({ scroll_to_item() {}, release() {} }) };
          export const InputState = {
            new: () => ({
              _val: "",
              value() { return this._val; },
              set_value(v) { this._val = v; },
              on() {},
              focus() {},
              release() {},
            }),
          };
          export const EditorState = {
            new: () => ({
              set_value() {},
              release() {},
            }),
          };
        `,
      };
    }
    if (url === "ctrlmock:herdr") {
      return {
        shortCircuit: true,
        format: "module",
        source: `
          const st = () => globalThis.__FILES_CTRL_MOCK__;
          export const spaces = () => st().spaces;
          export const panes = () => st().panes;
          export const terminals = () => st().terminals;
          export const agents = () => st().agents;
          export const focused = () => st().focused;
          export const props = () => st().props;
          export const layout = () => st().layout;
          export const window = () => st().windowInfo;
          export const settings = () => ({ font_size: 13, font_family: "monospace" });
          export const theme = () => new Proxy({}, { get: () => "#ffffff" });
          export const shared = (k) => (k ? st().sharedData[k] : st().sharedData);
          export const setShared = (k, v) => { st().sharedData[k] = v; };
          export const run = (cmd, payload) => { st().runCalls.push({ cmd, payload }); };
          export const hc = async () => "";
          export const exec = async () => ({ code: 1, stdout: "", stderr: "" });
          export const appHome = () => "";
          export const readTextFile = async () => "";
          export const openOverlay = () => {};
          export const closeOverlay = (k) => { st().closedOverlays.push(k); };
          export const notify = () => {};
          export const watchFolder = () => {
            let resolveFn;
            const p = new Promise(r => { resolveFn = r; });
            p.cancelled = false;
            p.cancel = () => { p.cancelled = true; resolveFn([]); };
            st().watchHandles.push(p);
            return p;
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { default: FilesSearch } = await import("../mods/files-search/main.js");
const { previewWrapCache } = await import("../mods/files-search/workspace-io.js");

function makeCx() {
  const afterCalls = [];
  const everyCalls = [];
  const makeTask = (list, meta) => {
    const t = { ...meta, cancelled: false, cancel() { this.cancelled = true; } };
    list.push(t);
    return t;
  };
  return {
    afterCalls,
    everyCalls,
    focus_handle: () => ({ focus() {} }),
    notify: () => {},
    sleep: async () => {},
    spawn: () => {},
    timer: {
      after: (ms, fn) => makeTask(afterCalls, { ms, fn }),
      every: (ms, fn) => makeTask(everyCalls, { ms, fn }),
    },
  };
}

describe("files-search modular controller regressions", () => {
  beforeEach(() => {
    state.props = {};
    state.spaces = [];
    state.panes = [];
    state.terminals = [];
    state.agents = [];
    state.focused = null;
    state.sharedData = {};
    state.runCalls = [];
    state.watchHandles = [];
    state.closedOverlays = [];
  });

  it("OverlayController renders full Search Everywhere root instead of blank div()", () => {
    state.props = { overlay: "files-search-win", root: "/tmp/ws" };
    const cx = makeCx();
    const view = new FilesSearch();
    view.init(state.props, cx);
    const tree = view.render(cx);
    assert.equal(tree._id, "files-search-overlay-root");
    assert.ok(tree._children.length > 0, "expected rendered overlay children");
    view.close(cx);
  });

  it("ViewerController initializes cleanly when props.viewerId is omitted and close() preserves previewWrapCache", () => {
    previewWrapCache.clear();
    previewWrapCache.set("keep-me", { mode: "plain", rows: [] });
    state.props = { role: "viewer", root: "/tmp/ws", path: "src/app.js" };
    const cx = makeCx();
    const view = new FilesSearch();
    view.init(state.props, cx);
    assert.match(view.controller.viewerId, /^fv-inst-/);
    view.close(cx);
    assert.equal(previewWrapCache.has("keep-me"), true);
    previewWrapCache.clear();
  });

  it("PanelController does not loop render() -> schedulePanelSync() on a non-terminal tab without terminal panes", () => {
    state.props = {};
    state.spaces = [{ id: "sp-1", active: true, folder: "/tmp/ws", tabs: [{ id: "viewer-tab-1", active: true }] }];
    state.panes = [{ id: "p-1", tab: "viewer-tab-1", mod: "files-search" }];
    state.sharedData = {
      "cognivisor.openFileTabs": {
        "viewer-tab-1": { tabId: "viewer-tab-1", root: "/tmp/ws", path: "src/app.js" },
      },
    };

    const cx = makeCx();
    const view = new FilesSearch();
    view.init(state.props, cx);
    // Simulate root loaded and viewer selection already synced
    view.controller.entries.set("", [{ name: "src", dir: true }]);
    view.controller.lastSyncedViewerTabId = "viewer-tab-1";
    cx.afterCalls.length = 0;

    for (let i = 0; i < 5; i++) {
      view.render(cx);
    }
    assert.equal(view.controller.activeSessionTabId, null);
    assert.equal(cx.afterCalls.length, 0, "expected zero panel sync loops when active tab is non-terminal with no terminal tabs");

    // Closing PanelController cancels its 30s pollTimerTask cleanly
    assert.equal(cx.everyCalls.length, 1);
    assert.equal(cx.everyCalls[0].cancelled, false);
    view.close(cx);
    assert.equal(cx.everyCalls[0].cancelled, true);
  });
});
