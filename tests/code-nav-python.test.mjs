import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFileSymbolSummary, resolveInFile } from "../shared/code-nav-python.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function colOf(lines, line1Based, needle, nth = 1) {
  const raw = lines[line1Based - 1];
  let idx = -1;
  let from = 0;
  for (let i = 0; i < nth; i += 1) {
    idx = raw.indexOf(needle, from);
    assert.ok(idx >= 0, `Expected "${needle}" on line ${line1Based}: ${raw}`);
    from = idx + 1;
  }
  return idx + 1;
}

describe("Python code navigation analyzer", () => {
  test("mods/files-search/code-nav-python.js stays byte-identical to shared/code-nav-python.js", () => {
    assert.equal(
      readFileSync(resolve(ROOT, "mods/files-search/code-nav-python.js"), "utf8"),
      readFileSync(resolve(ROOT, "shared/code-nav-python.js"), "utf8")
    );
  });

  test("extractFileSymbolSummary parses classes, bases, decorators, properties, async defs, and imports", () => {
    const src = [
      'from ..models import User',
      'from app.services import (',
      '    AuditService as Auditor,',
      ')',
      '__all__ = ["UserManager"]',
      'DEFAULT_LIMIT = 50',
      'class BaseManager:',
      '    def audit(self, action: str) -> None:',
      '        pass',
      'class UserManager(BaseManager):',
      '    def __init__(self, auditor: Auditor):',
      '        self.auditor = auditor',
      '    @property',
      '    def active(self) -> bool:',
      '        return True',
      '    @classmethod',
      '    async def create(cls, user: User):',
      '        return user',
    ].join("\n");

    const summary = extractFileSymbolSummary(src, "app/managers.py");
    assert.equal(summary.lang, "python");
    assert.ok(summary.imports.some((i) => i.importedName === "User" && i.moduleSpec === "..models" && i.relativeLevel === 2));
    assert.ok(summary.imports.some((i) => i.importedName === "AuditService" && i.localName === "Auditor"));
    assert.ok(summary.topVariables.some((v) => v.name === "DEFAULT_LIMIT" && v.line === 6));

    const mgr = summary.types.find((t) => t.name === "UserManager");
    assert.ok(mgr && mgr.extends.includes("BaseManager"));
    assert.equal(mgr.constructors[0].line, 11);
    assert.ok(mgr.fields.some((f) => f.name === "auditor" && f.typeName === "Auditor"));
    assert.ok(mgr.methods.some((m) => m.name === "active" && m.kind === "property"));
    assert.ok(mgr.methods.some((m) => m.name === "create" && m.kind === "classmethod"));
  });

  test("resolves LEGB closures, global/nonlocal, unpacking, comprehensions, and walrus bindings", () => {
    const src = [
      'counter = 0',
      'def outer(step):',
      '    total = 10',
      '    def inner(items):',
      '        nonlocal total',
      '        global counter',
      '        res = [x * 2 for x in items]',
      '        if (count := len(res)) > 0:',
      '            total += step + count + counter',
      '        return total',
      '    return inner',
    ].join("\n");
    const lines = src.split("\n");

    // `nonlocal total` -> outer total on line 3
    const rTotal = resolveInFile(src, { line: 10, col: colOf(lines, 10, "total") }, "calc.py");
    assert.equal(rTotal.resolved[0]?.line, 3);

    // `global counter` -> module counter on line 1
    const rCounter = resolveInFile(src, { line: 9, col: colOf(lines, 9, "counter") }, "calc.py");
    assert.equal(rCounter.resolved[0]?.line, 1);

    // Enclosing param `step` -> line 2
    const rStep = resolveInFile(src, { line: 9, col: colOf(lines, 9, "step") }, "calc.py");
    assert.equal(rStep.resolved[0]?.line, 2);

    // Walrus `count` -> line 8
    const rCount = resolveInFile(src, { line: 9, col: colOf(lines, 9, "count") }, "calc.py");
    assert.equal(rCount.resolved[0]?.line, 8);
  });

  test("resolves self.attr, self.method, super().method(), and multi-line signatures cleanly", () => {
    const src = [
      'class Repo:',
      '    def save(self, entity):',
      '        return entity',
      'class UserRepo(Repo):',
      '    def __init__(',
      '        self,',
      '        table_name: str,',
      '    ):',
      '        self.table_name = table_name',
      '    def persist(self, item):',
      '        self.log_item(item)',
      '        return super().save(self.table_name)',
      '    def log_item(self, item):',
      '        return item',
    ].join("\n");
    const lines = src.split("\n");

    // `self.log_item` -> line 13
    const rMethod = resolveInFile(src, { line: 11, col: colOf(lines, 11, "log_item") }, "repo.py");
    assert.equal(rMethod.resolved[0]?.line, 13);

    // `self.table_name` -> line 9
    const rAttr = resolveInFile(src, { line: 12, col: colOf(lines, 12, "table_name") }, "repo.py");
    assert.equal(rAttr.resolved[0]?.line, 9);

    // `super().save` -> base Repo.save on line 2
    const rSuper = resolveInFile(src, { line: 12, col: colOf(lines, 12, "save") }, "repo.py");
    assert.equal(rSuper.resolved[0]?.line, 2);

    // `UserRepo("users")` -> `__init__` on line 5
    const srcInst = `${src}\nrepo = UserRepo("users")\nrepo.persist(1)\n`;
    const instLines = srcInst.split("\n");
    const rInit = resolveInFile(srcInst, { line: 15, col: colOf(instLines, 15, "UserRepo") }, "repo.py");
    assert.equal(rInit.resolved[0]?.line, 5);
  });

  test("emits importHint for imported symbols, type-hinted receivers, and decorators", () => {
    const src = [
      'from .services import OrderService',
      'from flask import login_required',
      '@login_required',
      'def handle(svc: OrderService):',
      '    return svc.submit_order()',
    ].join("\n");
    const lines = src.split("\n");

    const onImport = resolveInFile(src, { line: 1, col: colOf(lines, 1, "OrderService") }, "views.py");
    assert.equal(onImport.resolved.length, 0);
    assert.equal(onImport.importHint?.specifier, ".services");
    assert.equal(onImport.importHint?.relativeLevel, 1);
    assert.equal(onImport.importHint?.importedName, "OrderService");

    const onDec = resolveInFile(src, { line: 3, col: colOf(lines, 3, "login_required") }, "views.py");
    assert.equal(onDec.importHint?.specifier, "flask");
    assert.equal(onDec.importHint?.importedName, "login_required");
    assert.equal(onDec.importHint?.isAnnotation, true);

    const onMethodCall = resolveInFile(src, { line: 5, col: colOf(lines, 5, "submit_order") }, "views.py");
    assert.ok(onMethodCall.memberTypeHints.includes("OrderService"));
    assert.equal(onMethodCall.importHint?.typeName, "OrderService");
    assert.equal(onMethodCall.importHint?.memberName, "submit_order");
    assert.equal(onMethodCall.importHint?.specifier, ".services");
  });

  test("extractFileSymbolSummary preserves exports, classes with self fields, conditional imports, and scales linearly on deep brackets", () => {
    const src = [
      "from typing import TypeAlias",
      "from .models import Account",
      "__all__ = ['Service', 'helper', 'UserId']",
      "UserId: TypeAlias = str",
      "",
      "class Service:",
      "    def __init__(self, repo: Account) -> None:",
      "        self.repo = repo",
      "        local_tmp = 123",
      "",
      "    def load(self):",
      "        from .lazy import fetch_remote",
      "        x = 1 + 2",
      "        return fetch_remote(self.repo)",
      "",
      "def helper(uid: UserId) -> Service:",
      "    local_val = uid",
      "    return Service(local_val)",
    ].join("\n");

    const summary = extractFileSymbolSummary(src, "app/service.py");
    assert.equal(summary.lang, "python");
    assert.ok(summary.imports.some((i) => i.localName === "Account" && i.moduleSpec === ".models"));
    assert.ok(summary.exports.some((e) => e.name === "Service"));
    assert.ok(summary.exports.some((e) => e.name === "helper"));
    assert.ok(summary.types.some((t) => t.name === "Service" && t.fields.some((f) => f.name === "repo" && f.typeName === "Account")));
    assert.ok(summary.functions.some((f) => f.name === "helper"));

    const srcLines = src.split("\n");
    const lazyRes = resolveInFile(src, { line: 14, col: colOf(srcLines, 14, "fetch_remote") }, "app/service.py");
    assert.equal(lazyRes.importHint?.specifier, ".lazy");
    assert.equal(lazyRes.importHint?.importedName, "fetch_remote");

    const deepBrackets = `matrix = ${"[".repeat(500)}0${"]".repeat(500)}\nvalue = matrix\n`;
    const t0 = performance.now();
    const res = resolveInFile(deepBrackets, { line: 2, col: 9 }, "deep.py");
    const elapsedMs = performance.now() - t0;
    assert.equal(res.resolved[0]?.name, "matrix");
    assert.ok(elapsedMs < 500, `Expected linear handling of 500 nested brackets, took ${elapsedMs.toFixed(1)}ms`);
  });
});
