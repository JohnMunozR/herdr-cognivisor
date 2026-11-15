import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFileSymbolSummary, resolveInFile } from "../shared/code-nav-js.js";

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

describe("JS/TS code navigation analyzer", () => {
  test("mods/files-search/code-nav-js.js stays byte-identical to shared/code-nav-js.js", () => {
    assert.equal(
      readFileSync(resolve(ROOT, "mods/files-search/code-nav-js.js"), "utf8"),
      readFileSync(resolve(ROOT, "shared/code-nav-js.js"), "utf8")
    );
  });

  test("extractFileSymbolSummary parses ESM/CJS imports, re-exports, interfaces, classes, fields, ctors, and arrows", () => {
    const src = [
      'import AuthClient, { verifyToken as checkJwt } from "./auth/client";',
      'import type { SessionUser } from "./types";',
      'const { hashValue } = require("./crypto");',
      'export { formatDate } from "./dates";',
      'export interface OrderRepo {',
      '  findById(id: string): Promise<Order>;',
      '}',
      'export class SqlOrderRepo implements OrderRepo {',
      '  private readonly client: AuthClient;',
      '  constructor(client: AuthClient) { this.client = client; }',
      '  async findById(id: string) { return id; }',
      '}',
      'export const computeTotal = (items, tax = 0) => items.length + tax;',
    ].join("\n");

    const summary = extractFileSymbolSummary(src, "src/orders.ts");
    assert.equal(summary.lang, "js");
    assert.ok(summary.imports.some((i) => i.localName === "AuthClient" && i.isDefault && i.specifier === "./auth/client"));
    assert.ok(summary.imports.some((i) => i.localName === "checkJwt" && i.importedName === "verifyToken"));
    assert.ok(summary.imports.some((i) => i.localName === "SessionUser" && i.isTypeOnly));
    assert.ok(summary.imports.some((i) => i.localName === "hashValue" && i.isRequire && i.specifier === "./crypto"));
    assert.ok(summary.reExports.some((r) => r.exportedName === "formatDate" && r.specifier === "./dates"));

    const iface = summary.types.find((t) => t.name === "OrderRepo");
    assert.ok(iface && iface.kind === "interface" && iface.isExported);
    assert.equal(iface.methods[0].isAbstract, true);

    const cls = summary.types.find((t) => t.name === "SqlOrderRepo");
    assert.ok(cls && cls.implements.includes("OrderRepo"));
    assert.equal(cls.fields[0].name, "client");
    assert.equal(cls.fields[0].typeName, "AuthClient");
    assert.equal(cls.constructors[0].arity, 1);
    assert.equal(cls.methods[0].name, "findById");

    assert.ok(summary.functions.some((f) => f.name === "computeTotal" && f.isExported && f.arity === 2));
  });

  test("resolves block/closure variable shadowing and destructuring bindings", () => {
    const src = [
      'const config = { retries: 3 };',
      'function runBatch(items, { retries = 1 } = {}) {',
      '  const localCount = items.length;',
      '  return items.map((item) => {',
      '    const { id: itemId } = item;',
      '    return itemId + retries + localCount + config.retries;',
      '  });',
      '}',
    ].join("\n");
    const lines = src.split("\n");

    // Inner destructured binding `itemId` -> line 5
    const rItemId = resolveInFile(src, { line: 6, col: colOf(lines, 6, "itemId") }, "batch.js");
    assert.equal(rItemId.resolved[0]?.line, 5);
    assert.equal(rItemId.resolved[0]?.name, "itemId");

    // Outer param destructuring `retries` shadows outer `config.retries` cleanly -> line 2
    const rRetries = resolveInFile(src, { line: 6, col: colOf(lines, 6, "retries", 1) }, "batch.js");
    assert.equal(rRetries.resolved[0]?.line, 2);

    // Closure variable `localCount` -> line 3
    const rLocalCount = resolveInFile(src, { line: 6, col: colOf(lines, 6, "localCount") }, "batch.js");
    assert.equal(rLocalCount.resolved[0]?.line, 3);

    // Module constant `config` -> line 1
    const rConfig = resolveInFile(src, { line: 6, col: colOf(lines, 6, "config") }, "batch.js");
    assert.equal(rConfig.resolved[0]?.line, 1);
  });

  test("resolves this.method, this.field, new Class() constructor, and inferred receiver types", () => {
    const src = [
      'class Helper {',
      '  constructor(seed) { this.seed = seed; }',
      '  compute(x) { return x + this.seed; }',
      '}',
      'class Worker {',
      '  private helper: Helper;',
      '  constructor() {',
      '    this.helper = new Helper(10);',
      '  }',
      '  run() {',
      '    const svc = new Helper(20);',
      '    const a = this.helper.compute(1);',
      '    return svc.compute(a);',
      '  }',
      '}',
    ].join("\n");
    const lines = src.split("\n");

    // `new Helper(10)` -> constructor on line 2
    const rNew = resolveInFile(src, { line: 8, col: colOf(lines, 8, "Helper") }, "worker.ts");
    assert.equal(rNew.resolved[0]?.line, 2);
    assert.equal(rNew.resolved[0]?.kind, "constructor");

    // `this.helper` on line 12 -> field on line 6
    const rThisField = resolveInFile(src, { line: 12, col: colOf(lines, 12, "helper") }, "worker.ts");
    assert.equal(rThisField.resolved[0]?.line, 6);

    // `this.helper.compute(1)` -> Helper.compute on line 3
    const rChain = resolveInFile(src, { line: 12, col: colOf(lines, 12, "compute") }, "worker.ts");
    assert.equal(rChain.resolved[0]?.line, 3);
    assert.ok(rChain.memberTypeHints.includes("Helper"));

    // `svc.compute(a)` -> Helper.compute on line 3
    const rLocalChain = resolveInFile(src, { line: 13, col: colOf(lines, 13, "compute") }, "worker.ts");
    assert.equal(rLocalChain.resolved[0]?.line, 3);
  });

  test("does not resolve imported symbols to import line; emits importHint for cross-file resolution", () => {
    const src = [
      'import { fetchOrders, OrderClient } from "./api/orders";',
      'export async function loadAll(client: OrderClient) {',
      '  const data = await fetchOrders(1, 2);',
      '  return client.refresh();',
      '}',
    ].join("\n");
    const lines = src.split("\n");

    // Clicking on the import identifier itself
    const onImportSym = resolveInFile(src, { line: 1, col: colOf(lines, 1, "fetchOrders") }, "page.ts");
    assert.equal(onImportSym.resolved.length, 0);
    assert.equal(onImportSym.importHint?.specifier, "./api/orders");
    assert.equal(onImportSym.importHint?.importedName, "fetchOrders");

    // Clicking string specifier
    const onImportSpec = resolveInFile(src, { line: 1, col: colOf(lines, 1, "./api/orders") + 3 }, "page.ts");
    assert.equal(onImportSpec.importHint?.specifier, "./api/orders");
    assert.equal(onImportSpec.importHint?.importedName, null);

    // Clicking call usage `fetchOrders(1, 2)`
    const onCall = resolveInFile(src, { line: 3, col: colOf(lines, 3, "fetchOrders") }, "page.ts");
    assert.equal(onCall.resolved.length, 0);
    assert.equal(onCall.importHint?.specifier, "./api/orders");
    assert.equal(onCall.importHint?.importedName, "fetchOrders");
    assert.equal(onCall.importHint?.arity, 2);

    // Clicking `client.refresh()` -> carries typeName/specifier from OrderClient param type
    const onMemberCall = resolveInFile(src, { line: 4, col: colOf(lines, 4, "refresh") }, "page.ts");
    assert.equal(onMemberCall.resolved.length, 0);
    assert.ok(onMemberCall.memberTypeHints.includes("OrderClient"));
    assert.equal(onMemberCall.importHint?.specifier, "./api/orders");
    assert.equal(onMemberCall.importHint?.typeName, "OrderClient");
    assert.equal(onMemberCall.importHint?.memberName, "refresh");
  });

  test("never matches symbols inside comments or string literals", () => {
    const src = [
      'const value = 42;',
      '// value is commented out',
      'const label = "value should stay plain";',
    ].join("\n");
    const lines = src.split("\n");

    assert.deepEqual(resolveInFile(src, { line: 2, col: colOf(lines, 2, "value") }, "a.js").resolved, []);
    assert.deepEqual(resolveInFile(src, { line: 3, col: colOf(lines, 3, "value") }, "a.js").resolved, []);
  });

  test("NON_METHOD_KEYWORDS prevents control-flow blocks inside classes from polluting methods and keeps parsing past regex literals", () => {
    const src = [
      "class PathProcessor {",
      "  normalize(raw) {",
      "    if (raw) {",
      "      return raw.replace(/^\\.\\//, '').replace(/^https?:\\/\\//, '');",
      "    }",
      "    for (const ch of raw) {",
      "      if (!ch) break;",
      "    }",
      "    return raw;",
      "  }",
      "  afterRegexMethod(item) {",
      "    return this.normalize(item);",
      "  }",
      "}",
    ].join("\n");
    const summary = extractFileSymbolSummary(src, "PathProcessor.js");
    const cls = summary.types.find((t) => t.name === "PathProcessor");
    assert.ok(cls);
    const methodNames = cls.methods.map((m) => m.name);
    assert.ok(methodNames.includes("normalize"));
    assert.ok(methodNames.includes("afterRegexMethod"));
    assert.ok(!methodNames.includes("if"));
    assert.ok(!methodNames.includes("for"));

    const lines = src.split("\n");
    const res = resolveInFile(src, { line: 12, col: colOf(lines, 12, "normalize") }, "PathProcessor.js");
    assert.equal(res.resolved[0]?.line, 2);
    assert.equal(res.resolved[0]?.name, "normalize");
  });

  test("extractFileSymbolSummary preserves static/dynamic imports, re-exports, classes, methods, and exported arrow functions", () => {
    const src = [
      'import { BaseClient } from "./base.js";',
      'export { formatDate } from "./dates.js";',
      'export * from "./shared-types.js";',
      "",
      "export class OrderApi extends BaseClient {",
      "  endpoint = '/orders';",
      "  async fetchOrder(id) {",
      '    const lazyMod = await import("./lazy-helper.js");',
      "    const local = { ok: true };",
      "    return lazyMod.run(id, local);",
      "  }",
      "}",
      "",
      "export const buildPayload = (order) => ({",
      "  id: order.id,",
      "  serialize() {",
      "    return String(order.id);",
      "  },",
      "});",
    ].join("\n");

    const summary = extractFileSymbolSummary(src, "src/order-api.js");
    assert.equal(summary.lang, "js");
    assert.ok(summary.imports.some((i) => i.localName === "BaseClient" && i.specifier === "./base.js"));
    assert.ok(summary.imports.some((i) => i.specifier === "./lazy-helper.js"));
    assert.ok(summary.reExports.some((r) => r.specifier === "./dates.js"));
    assert.ok(summary.reExports.some((r) => r.specifier === "./shared-types.js" && r.isStar));
    assert.ok(summary.types.some((t) => t.name === "OrderApi" && t.methods?.some((m) => m.name === "fetchOrder")));
    assert.ok(summary.exports.some((e) => e.name === "buildPayload"));
    assert.ok(summary.functions.some((f) => f.name === "buildPayload"));
  });
});
