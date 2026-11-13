import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findNode,
  isGenericName,
  isGenericTab,
  findLeadPane,
  extractJiraKey,
  isBoilerplateLine,
  extractPromptLine,
  trimCleanly,
  summarizePrompt,
  cleanBranchSlug,
} from "../mods/mesh-tabs/tab-logic.js";

describe("mesh-tabs tab-logic", () => {
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

  test("findLeadPane prefers explicit leadTerminal, ignores meshRunner splits, and prefers agent panes", () => {
    const panes = [
      { tab: "t1", terminal: "term-shell", program: { name: "bash", agent: false } },
      { tab: "t1", terminal: "term-runner", labels: { meshRunner: "true" }, program: { name: "claude", agent: true } },
      { tab: "t1", terminal: "term-lead", program: { name: "claude", agent: true } },
    ];
    const terms = [
      { address: "term-shell", labels: {} },
      { address: "term-runner", labels: { meshRunner: "true" } },
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
});
