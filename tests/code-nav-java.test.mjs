import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILDER_TYPE_PREFIX,
  advanceJavaContainerOrBuilderType,
  findJavaSummaryMemberCandidates,
  extractFileSymbolSummary,
  resolveInFile,
} from "../shared/code-nav-java.js";

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

describe("Java code navigation analyzer", () => {
  test("mods/files-search/code-nav-java.js stays byte-identical to shared/code-nav-java.js", () => {
    assert.equal(
      readFileSync(resolve(ROOT, "mods/files-search/code-nav-java.js"), "utf8"),
      readFileSync(resolve(ROOT, "shared/code-nav-java.js"), "utf8")
    );
  });

  test("extractFileSymbolSummary captures package, imports, records, interfaces, annotations, and methods", () => {
    const src = [
      'package com.acme.orders;',
      'import com.acme.repo.OrderRepository;',
      'import static java.util.Objects.requireNonNull;',
      'public record OrderDto(Long id, String code) {}',
      'public interface OrderUseCase {',
      '    OrderDto load(Long id);',
      '    default String label() { return "order"; }',
      '}',
      '@Service',
      '@RequiredArgsConstructor',
      'public class DefaultOrderService implements OrderUseCase {',
      '    private final OrderRepository orderRepository;',
      '    public DefaultOrderService(OrderRepository repo) { this.orderRepository = repo; }',
      '    @Override',
      '    public OrderDto load(Long id) { return new OrderDto(id, "A"); }',
      '}',
    ].join("\n");

    const summary = extractFileSymbolSummary(src, "src/main/java/com/acme/orders/DefaultOrderService.java");
    assert.equal(summary.lang, "java");
    assert.equal(summary.packageName, "com.acme.orders");
    assert.ok(summary.imports.some((i) => i.qualifiedName === "com.acme.repo.OrderRepository" && !i.isStatic));
    assert.ok(summary.imports.some((i) => i.qualifiedName === "java.util.Objects.requireNonNull" && i.isStatic));

    const rec = summary.types.find((t) => t.name === "OrderDto");
    assert.ok(rec && rec.kind === "record");
    assert.ok(rec.fields.some((f) => f.name === "id" && f.typeName === "Long"));

    const iface = summary.types.find((t) => t.name === "OrderUseCase");
    assert.ok(iface && iface.kind === "interface");
    assert.equal(iface.methods.find((m) => m.name === "load")?.isAbstract, true);
    assert.equal(iface.methods.find((m) => m.name === "label")?.isDefault, true);
    assert.equal(iface.methods.find((m) => m.name === "label")?.isAbstract, false);

    const svc = summary.types.find((t) => t.name === "DefaultOrderService");
    assert.ok(svc && svc.implements.includes("OrderUseCase"));
    assert.ok(svc.annotations.includes("Service"));
    assert.ok(svc.annotations.includes("RequiredArgsConstructor"));
    assert.equal(svc.fields[0].name, "orderRepository");
    assert.equal(svc.fields[0].typeName, "OrderRepository");
    assert.equal(svc.constructors[0].arity, 1);
  });

  test("resolves local var shadowing vs this.field, overload arity, constructors, method refs, and Lombok @Getter", () => {
    const src = [
      'import lombok.Getter;',
      'import lombok.RequiredArgsConstructor;',
      '@Getter',
      '@RequiredArgsConstructor',
      'public class AccountController {',
      '    private final String accountName;',
      '    public AccountController(String accountName) {',
      '        this.accountName = accountName;',
      '    }',
      '    public String find(String key) { return key; }',
      '    public String find(String key, int limit) { return key; }',
      '    public void execute(String accountName) {',
      '        var copy = new AccountController("a");',
      '        var a = this.accountName;',
      '        var b = accountName;',
      '        var c = find(b, 5);',
      '        var d = copy.getAccountName();',
      '        Runnable r = this::execute;',
      '    }',
      '}',
    ].join("\n");
    const lines = src.split("\n");

    // `this.accountName` -> field line 6
    const rThisField = resolveInFile(src, { line: 14, col: colOf(lines, 14, "accountName") }, "AccountController.java");
    assert.equal(rThisField.resolved[0]?.line, 6);

    // `accountName` -> method param line 12 (shadows field)
    const rParam = resolveInFile(src, { line: 15, col: colOf(lines, 15, "accountName") }, "AccountController.java");
    assert.equal(rParam.resolved[0]?.line, 12);

    // `find(b, 5)` -> 2-arg overload line 11
    const rOverload = resolveInFile(src, { line: 16, col: colOf(lines, 16, "find") }, "AccountController.java");
    assert.equal(rOverload.resolved[0]?.line, 11);
    assert.equal(rOverload.resolved[0]?.arity, 2);

    // `new AccountController("a")` -> 1-arg constructor line 7
    const rCtor = resolveInFile(src, { line: 13, col: colOf(lines, 13, "AccountController") }, "AccountController.java");
    assert.equal(rCtor.resolved[0]?.line, 7);
    assert.equal(rCtor.resolved[0]?.kind, "constructor");

    // Lombok `@Getter` `getAccountName()` -> falls back cleanly to field `accountName` line 6
    const rGetter = resolveInFile(src, { line: 17, col: colOf(lines, 17, "getAccountName") }, "AccountController.java");
    assert.equal(rGetter.resolved[0]?.line, 6);

    // `this::execute` -> method line 12
    const rMethodRef = resolveInFile(src, { line: 18, col: colOf(lines, 18, "execute") }, "AccountController.java");
    assert.equal(rMethodRef.resolved[0]?.line, 12);
  });

  test("prefers concrete same-file implementation over interface method and emits cross-file importHint cleanly", () => {
    const src = [
      'package com.acme.app;',
      'import com.acme.repo.PaymentGateway;',
      '@Service',
      'public class CheckoutService {',
      '    private final PaymentGateway gateway;',
      '    interface Notifier { void send(String msg); }',
      '    class EmailNotifier implements Notifier {',
      '        public void send(String msg) {}',
      '    }',
      '    public void checkout(Notifier n, String id) {',
      '        n.send("ok");',
      '        gateway.charge(id);',
      '    }',
      '}',
    ].join("\n");
    const lines = src.split("\n");

    // `n.send("ok")` -> concrete EmailNotifier.send line 8 ahead of Notifier.send line 6
    const rImpl = resolveInFile(src, { line: 11, col: colOf(lines, 11, "send") }, "CheckoutService.java");
    assert.equal(rImpl.resolved[0]?.line, 8);
    assert.equal(rImpl.resolved[0]?.isAbstract, false);

    // `gateway.charge(id)` -> cross-file importHint with qualifiedName `com.acme.repo.PaymentGateway`
    const rGateway = resolveInFile(src, { line: 12, col: colOf(lines, 12, "charge") }, "CheckoutService.java");
    assert.equal(rGateway.resolved.length, 0);
    assert.ok(rGateway.memberTypeHints.includes("PaymentGateway"));
    assert.equal(rGateway.importHint?.typeName, "PaymentGateway");
    assert.equal(rGateway.importHint?.memberName, "charge");
    assert.equal(rGateway.importHint?.qualifiedName, "com.acme.repo.PaymentGateway");
    assert.equal(rGateway.importHint?.arity, 1);

    // Import line click -> emits cross-file hint rather than resolving locally
    const rImp = resolveInFile(src, { line: 2, col: colOf(lines, 2, "PaymentGateway") }, "CheckoutService.java");
    assert.equal(rImp.resolved.length, 0);
    assert.equal(rImp.importHint?.qualifiedName, "com.acme.repo.PaymentGateway");
  });

  test("resolves enhanced-for vars (typed & var), multi-param untyped lambdas, Lombok @Builder chains, and overload param types", () => {
    const src = [
      "package com.acme;",
      "import java.util.List;",
      "import java.util.Map;",
      "import java.util.UUID;",
      "import lombok.Builder;",
      "public class ComplexJava {",
      "  @Builder",
      "  public static class Order {",
      "    private final String id;",
      "    private String status;",
      "  }",
      "  public String askQuestion(String req, UUID tenantId) { return req; }",
      "  public String askQuestion(String req, String sessionId) { return sessionId; }",
      "  private void secretHelper() {}",
      "  public void run(List<Document> rawChunks, Map<String, Integer> counts, UUID tid, String sid) {",
      "    for (Document chunk : rawChunks) {",
      "      consume(chunk);",
      "    }",
      "    for (var item : rawChunks) {",
      "      consume(item);",
      "    }",
      "    counts.forEach((key, value) -> recordEntry(key, value));",
      "    Order built = Order.builder().status(\"NEW\").build();",
      "    askQuestion(\"hi\", tid);",
      "    askQuestion(\"hi\", sid);",
      "    secretHelper();",
      "  }",
      "}",
    ].join("\n");
    const lines = src.split("\n");

    const rChunk = resolveInFile(src, { line: 17, col: colOf(lines, 17, "chunk") }, "ComplexJava.java");
    assert.equal(rChunk.resolved[0]?.line, 16);
    assert.equal(rChunk.resolved[0]?.name, "chunk");

    const rVarItem = resolveInFile(src, { line: 20, col: colOf(lines, 20, "item") }, "ComplexJava.java");
    assert.equal(rVarItem.resolved[0]?.line, 19);
    assert.equal(rVarItem.resolved[0]?.name, "item");

    const rLambdaKey = resolveInFile(src, { line: 22, col: colOf(lines, 22, "key", 2) }, "ComplexJava.java");
    assert.equal(rLambdaKey.resolved[0]?.line, 22);
    assert.equal(rLambdaKey.resolved[0]?.name, "key");
    const rLambdaVal = resolveInFile(src, { line: 22, col: colOf(lines, 22, "value", 2) }, "ComplexJava.java");
    assert.equal(rLambdaVal.resolved[0]?.line, 22);
    assert.equal(rLambdaVal.resolved[0]?.name, "value");

    // Same-file @Builder chain
    const rBuilder = resolveInFile(src, { line: 23, col: colOf(lines, 23, "builder") }, "ComplexJava.java");
    assert.equal(rBuilder.resolved[0]?.line, 8);
    assert.equal(rBuilder.resolved[0]?.name, "Order");
    const rSetter = resolveInFile(src, { line: 23, col: colOf(lines, 23, "status") }, "ComplexJava.java");
    assert.equal(rSetter.resolved[0]?.line, 10);
    assert.equal(rSetter.resolved[0]?.name, "status");
    const rBuild = resolveInFile(src, { line: 23, col: colOf(lines, 23, "build") }, "ComplexJava.java");
    assert.equal(rBuild.resolved[0]?.line, 8);
    assert.equal(rBuild.resolved[0]?.name, "Order");

    // Direct helper export assertions
    const stepped = advanceJavaContainerOrBuilderType(
      `${BUILDER_TYPE_PREFIX}Order`,
      [],
      { name: "status", isCall: true },
      () => ({
        name: "Order",
        annotations: ["Builder"],
        fields: [{ name: "status", baseTypeName: "String" }],
      })
    );
    assert.equal(stepped?.typeName, `${BUILDER_TYPE_PREFIX}Order`);

    // Same-arity overload param-type disambiguation
    const rAskUuid = resolveInFile(src, { line: 24, col: colOf(lines, 24, "askQuestion") }, "ComplexJava.java");
    assert.equal(rAskUuid.resolved[0]?.line, 12);
    const rAskStr = resolveInFile(src, { line: 25, col: colOf(lines, 25, "askQuestion") }, "ComplexJava.java");
    assert.equal(rAskStr.resolved[0]?.line, 13);

    // Private member metadata propagation
    const summary = extractFileSymbolSummary(src, "ComplexJava.java");
    const helperCands = findJavaSummaryMemberCandidates(summary.types.find((t) => t.name === "ComplexJava"), "secretHelper", "ComplexJava.java");
    assert.equal(helperCands[0]?.isPrivate, true);
    const rSecret = resolveInFile(src, { line: 26, col: colOf(lines, 26, "secretHelper") }, "ComplexJava.java");
    assert.equal(rSecret.resolved[0]?.isPrivate, true);
  });
});
