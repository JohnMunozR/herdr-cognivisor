import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findNode,
  resolveSpacePanelTarget,
  classifyViewerTab,
  isGenericName,
  isGenericTab,
  findLeadPane,
  extractJiraKey,
  isBoilerplateLine,
  extractPromptLine,
  trimCleanly,
  summarizePrompt,
  cleanBranchSlug,
} from "../mods/cognivisor-tabs/tab-logic.js";

describe("cognivisor-tabs tab-logic", () => {
  test("findNode traverses nested layout nodes", () => {
    const tree = { id: "root", children: [{ id: "panel", children: [{ id: "panel-body" }] }] };
    assert.equal(findNode(tree, "panel-body")?.id, "panel-body");
    assert.equal(findNode(tree, "missing"), null);
  });

  test("isGenericName and isGenericTab protect manually named tabs", () => {
    assert.equal(isGenericName("tb12", { name: "claude" }), true);
    assert.equal(isGenericName("3", null), true);
    assert.equal(isGenericName("Terminal", null), true);
    assert.equal(isGenericName("claude", { name: "claude" }), true);
    assert.equal(isGenericName("PROJ-412 · Login", { name: "claude" }), false);

    assert.equal(isGenericTab({ name: "tb1", named: false }, { name: "claude" }), true);
    assert.equal(isGenericTab({ name: "tb1", named: true }, { name: "claude" }), false);
  });

  test("findLeadPane prefers explicit leadTerminal, ignores cognivisorRunner splits, and prefers agent panes", () => {
    const panes = [
      { tab: "t1", terminal: "term-shell", program: { name: "bash", agent: false } },
      { tab: "t1", terminal: "term-runner", labels: { cognivisorRunner: "true" }, program: { name: "claude", agent: true } },
      { tab: "t1", terminal: "term-lead", program: { name: "claude", agent: true } },
    ];
    const terms = [
      { address: "term-shell", labels: {} },
      { address: "term-runner", labels: { cognivisorRunner: "true" } },
      { address: "term-lead", labels: {} },
    ];

    assert.equal(findLeadPane("t1", panes, terms, null)?.terminal, "term-lead");
    assert.equal(findLeadPane("t1", panes, terms, "term-runner")?.terminal, "term-lead");
    assert.equal(findLeadPane("t1", panes, terms, "term-shell")?.terminal, "term-shell");
  });

  test("extractJiraKey ignores standard encodings like UTF-8/SHA-256 and extracts ticket keys", () => {
    assert.equal(extractJiraKey("charset=UTF-8 SHA-256", "Fix PROJ-412 login"), "PROJ-412");
    assert.equal(extractJiraKey("ISO-8601 TLS-13"), null);
  });

  test("isBoilerplateLine and extractPromptLine extract user intent cleanly", () => {
    assert.equal(isBoilerplateLine("────────────────────────"), true);
    assert.equal(isBoilerplateLine("ctrl+p for shortcuts"), true);
    assert.equal(isBoilerplateLine("claude"), true);
    assert.equal(isBoilerplateLine("Fix authentication race condition"), false);

    const screen = [
      "Welcome to Claude Code",
      "ctrl+c to exit",
      "───────────────────",
      "❯ Fix PROJ-412 token refresh timeout",
    ].join("\n");
    assert.equal(extractPromptLine(screen), "Fix PROJ-412 token refresh timeout");

    const cliScreen = "user@host:~/Projects$ claude \"Add cache index for agent\"";
    assert.equal(extractPromptLine(cliScreen), "Add cache index for agent");
  });

  test("summarizePrompt, trimCleanly, and cleanBranchSlug format concise titles", () => {
    assert.equal(
      summarizePrompt("Hola, necesito que me ayudes a PROJ-412 corregir timeout en auth", "PROJ-412"),
      "Corregir timeout en auth",
    );
    assert.equal(
      summarizePrompt("Please help me to refactor payment retry worker", null),
      "Refactor payment retry",
    );
    assert.equal(trimCleanly("Implement cache store worker", 20), "Implement cache");
    assert.equal(trimCleanly("AuthenticationRefactorWorker", 16), "AuthenticationR…");

    assert.equal(cleanBranchSlug("feat/PROJ-412-oauth-refresh-flow", "PROJ-412"), "oauth refresh flow");
    assert.equal(cleanBranchSlug("main", null), "");
    assert.equal(cleanBranchSlug("develop", null), "");
  });

  test("classifyViewerTab detects git-history, changes-review, files-search, and terminal tabs", () => {
    const gitTab = classifyViewerTab([{ id: "p1", mod: "git-history" }], null);
    assert.deepEqual(gitTab, {
      isFilesTab: false,
      isReviewTab: false,
      isGitTab: true,
      isViewerTab: true,
      modIconPath: "mods/cognivisor-tabs/icons/git.svg",
      usesAccentTint: true,
    });

    const reviewTab = classifyViewerTab([{ id: "p2", mod: "changes-review" }], null);
    assert.deepEqual(reviewTab, {
      isFilesTab: false,
      isReviewTab: true,
      isGitTab: false,
      isViewerTab: true,
      modIconPath: "mods/cognivisor-tabs/icons/changes.svg",
      usesAccentTint: true,
    });

    const filesTab = classifyViewerTab(
      [{ id: "p3", mod: "files-search" }],
      { iconPath: "mods/files-search/icons/file-types/javascript.svg" },
    );
    assert.deepEqual(filesTab, {
      isFilesTab: true,
      isReviewTab: false,
      isGitTab: false,
      isViewerTab: true,
      modIconPath: "mods/files-search/icons/file-types/javascript.svg",
      usesAccentTint: false,
    });

    const termTab = classifyViewerTab([{ id: "p4", terminal: "t1" }], null);
    assert.deepEqual(termTab, {
      isFilesTab: false,
      isReviewTab: false,
      isGitTab: false,
      isViewerTab: false,
      modIconPath: null,
      usesAccentTint: false,
    });
  });

  test("resolveSpacePanelTarget supports files, changes, and git panels via cognivisor.spacePanels", () => {
    const enabled = ["files", "changes", "git"];
    assert.equal(resolveSpacePanelTarget("files", enabled), "files");
    assert.equal(resolveSpacePanelTarget("changes", enabled), "changes");
    assert.equal(resolveSpacePanelTarget("git", enabled), "git");
    assert.equal(resolveSpacePanelTarget("unknown", enabled), null);
    assert.equal(resolveSpacePanelTarget(null, enabled), null);
  });
});
