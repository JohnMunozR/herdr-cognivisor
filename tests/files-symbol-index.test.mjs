import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  installHerdrHooks,
  resetHerdrMock,
  getHerdrMock,
  createTempDir,
  cleanupTempDir,
} from "./helpers/herdr-mock.mjs";

installHerdrHooks();
const symIdx = await import("../mods/files-search/symbol-index.js");
const { buildDisambiguationDropdownItems } = await import("../mods/files-search/search-logic.js");

function colOf(src, line1, needle) {
  const line = src.split("\n")[line1 - 1] || "";
  const idx = line.indexOf(needle);
  if (idx < 0) throw new Error(`Needle "${needle}" not found on line ${line1}: ${line}`);
  return idx + 1;
}

describe("files-search symbol-index cross-file & cross-service navigation", () => {
  let tmpRoot = "";
  let appHomeDir = "";

  beforeEach(async () => {
    symIdx.resetSymbolIndexCache();
    tmpRoot = await createTempDir("herdr-symidx-");
    appHomeDir = path.join(tmpRoot, ".app-home");
    resetHerdrMock({ appHome: appHomeDir });
  });

  afterEach(async () => {
    symIdx.resetSymbolIndexCache();
    await cleanupTempDir(tmpRoot);
  });

  test("JS/TS resolves tsconfig paths (with JSONC), .js->.ts ESM mapping, barrel re-exports, namespace calls, and cross-service packages", async () => {
    const webSvcRoot = path.join(tmpRoot, "web-app");
    const sharedSvcRoot = path.join(tmpRoot, "shared-ui");
    await fs.mkdir(path.join(webSvcRoot, "src", "api"), { recursive: true });
    await fs.mkdir(path.join(sharedSvcRoot, "src"), { recursive: true });

    await fs.writeFile(
      path.join(webSvcRoot, "tsconfig.json"),
      `{
        // TSConfig comment
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["src/*"]
          }
        },
      }`
    );
    await fs.writeFile(
      path.join(webSvcRoot, "src", "api", "index.ts"),
      `export { createOrder as buildOrder } from "./orders.js";\n`
    );
    await fs.writeFile(
      path.join(webSvcRoot, "src", "api", "orders.ts"),
      `export class OrderService { submit(id: string) { return id; } }\nexport function createOrder(user: string) { return user; }\n`
    );
    await fs.writeFile(
      path.join(webSvcRoot, "src", "utils.ts"),
      `export function formatMoney(n: number) { return String(n); }\n`
    );

    await fs.writeFile(
      path.join(sharedSvcRoot, "package.json"),
      JSON.stringify({ name: "@acme/shared-ui", exports: { ".": "./src/index.ts" } })
    );
    await fs.writeFile(
      path.join(sharedSvcRoot, "src", "index.ts"),
      `export function showToast(msg: string) { return msg; }\n`
    );

    const entryPath = path.join(webSvcRoot, "src", "page.ts");
    const entrySrc = [
      'import { buildOrder } from "@/api";',
      'import * as utils from "./utils.js";',
      'import { showToast } from "@acme/shared-ui";',
      'import React from "react";',
      'const s = buildOrder("u1");',
      "utils.formatMoney(10);",
      "showToast(s);",
      "React.useState(0);",
    ].join("\n");
    await fs.writeFile(entryPath, entrySrc);

    const services = [
      { id: "svc-web", name: "web-app", root: webSvcRoot, relPath: "web-app" },
      { id: "svc-shared", name: "shared-ui", root: sharedSvcRoot, relPath: "shared-ui" },
    ];

    // Barrel + tsconfig @/* + .js->.ts chain
    const rBarrel = await symIdx.resolveCrossFileNavigation({
      sourceText: entrySrc,
      filePath: entryPath,
      line: 5,
      col: colOf(entrySrc, 5, "buildOrder"),
      currentRoot: tmpRoot,
      services,
      appHomeDir,
    });
    assert.equal(rBarrel.status, "ok");
    assert.equal(path.normalize(rBarrel.best.filePath), path.normalize(path.join(webSvcRoot, "src", "api", "orders.ts")));
    assert.equal(rBarrel.best.line, 2);
    assert.equal(rBarrel.best.name, "createOrder");

    // Namespace call `utils.formatMoney(10)` -> `utils.ts` line 1
    const rNs = await symIdx.resolveCrossFileNavigation({
      sourceText: entrySrc,
      filePath: entryPath,
      line: 6,
      col: colOf(entrySrc, 6, "formatMoney"),
      currentRoot: tmpRoot,
      services,
      appHomeDir,
    });
    assert.equal(rNs.status, "ok");
    assert.equal(path.normalize(rNs.best.filePath), path.normalize(path.join(webSvcRoot, "src", "utils.ts")));
    assert.equal(rNs.best.line, 1);

    // Cross-service workspace package `@acme/shared-ui`
    const rCrossSvc = await symIdx.resolveCrossFileNavigation({
      sourceText: entrySrc,
      filePath: entryPath,
      line: 7,
      col: colOf(entrySrc, 7, "showToast"),
      currentRoot: tmpRoot,
      services,
      appHomeDir,
    });
    assert.equal(rCrossSvc.status, "ok");
    assert.equal(rCrossSvc.best.serviceId, "svc-shared");
    assert.equal(rCrossSvc.best.serviceName, "shared-ui");
    assert.equal(path.normalize(rCrossSvc.best.filePath), path.normalize(path.join(sharedSvcRoot, "src", "index.ts")));

    // External library notice (`react`)
    const rExt = await symIdx.resolveCrossFileNavigation({
      sourceText: entrySrc,
      filePath: entryPath,
      line: 4,
      col: colOf(entrySrc, 4, "React"),
      currentRoot: tmpRoot,
      services,
      appHomeDir,
    });
    assert.equal(rExt.status, "external");
    assert.equal(rExt.externalPackage, "react");
  });

  test("Python resolves relative imports (..models, from . import utils), __init__ re-exports, polymorphic subclasses, and stdlib", async () => {
    const pySvc = path.join(tmpRoot, "py-svc");
    await fs.mkdir(path.join(pySvc, "app", "api"), { recursive: true });
    await fs.writeFile(path.join(pySvc, "app", "__init__.py"), "");
    await fs.writeFile(path.join(pySvc, "app", "api", "__init__.py"), "");
    await fs.writeFile(
      path.join(pySvc, "app", "models.py"),
      `class User:\n    def __init__(self, name: str):\n        self.name = name\n`
    );
    await fs.writeFile(
      path.join(pySvc, "app", "api", "helpers.py"),
      `def clean_slug(v: str):\n    return v.strip()\n`
    );
    await fs.writeFile(
      path.join(pySvc, "app", "repos.py"),
      `class BaseRepo:\n    def save(self, row):\n        raise NotImplementedError()\n`
    );
    await fs.writeFile(
      path.join(pySvc, "app", "pg_repo.py"),
      `from .repos import BaseRepo\n\nclass PgRepo(BaseRepo):\n    def save(self, row):\n        return row\n`
    );

    const viewsPath = path.join(pySvc, "app", "api", "views.py");
    const viewsSrc = [
      "import json",
      "from ..models import User",
      "from . import helpers",
      "",
      "def handle(raw: str) -> User:",
      "    data = json.loads(raw)",
      "    return User(helpers.clean_slug(data))",
    ].join("\n");
    await fs.writeFile(viewsPath, viewsSrc);

    const services = [{ id: "py", name: "py-svc", root: pySvc, relPath: "py-svc" }];

    // `..models` -> `app/models.py`
    const rUser = await symIdx.resolveCrossFileNavigation({
      sourceText: viewsSrc,
      filePath: viewsPath,
      line: 5,
      col: colOf(viewsSrc, 5, "User"),
      currentRoot: pySvc,
      services,
      appHomeDir,
    });
    assert.equal(rUser.status, "ok");
    assert.equal(path.normalize(rUser.best.filePath), path.normalize(path.join(pySvc, "app", "models.py")));
    assert.equal(rUser.best.line, 1);

    // `from . import helpers; helpers.clean_slug(...)` -> `helpers.py`
    const rHelper = await symIdx.resolveCrossFileNavigation({
      sourceText: viewsSrc,
      filePath: viewsPath,
      line: 7,
      col: colOf(viewsSrc, 7, "clean_slug"),
      currentRoot: pySvc,
      services,
      appHomeDir,
    });
    assert.equal(rHelper.status, "ok");
    assert.equal(path.normalize(rHelper.best.filePath), path.normalize(path.join(pySvc, "app", "api", "helpers.py")));
    assert.equal(rHelper.best.line, 1);

    // `json` -> external stdlib notice
    const rStd = await symIdx.resolveCrossFileNavigation({
      sourceText: viewsSrc,
      filePath: viewsPath,
      line: 6,
      col: colOf(viewsSrc, 6, "json"),
      currentRoot: pySvc,
      services,
      appHomeDir,
    });
    assert.equal(rStd.status, "external");
    assert.equal(rStd.externalPackage, "json");
  });

  test("Java resolves Maven packages, static imports, same-package refs, and polymorphic interface implementations across services (1 direct vs N ambiguous)", async () => {
    const coreSvc = path.join(tmpRoot, "core-contracts");
    const paySvc = path.join(tmpRoot, "payment-service");
    const billSvc = path.join(tmpRoot, "billing-service");

    const corePkg = path.join(coreSvc, "src", "main", "java", "com", "acme", "core");
    const payPkg = path.join(paySvc, "src", "main", "java", "com", "acme", "pay");
    const billPkg = path.join(billSvc, "src", "main", "java", "com", "acme", "bill");
    await fs.mkdir(corePkg, { recursive: true });
    await fs.mkdir(payPkg, { recursive: true });
    await fs.mkdir(billPkg, { recursive: true });

    const gwPath = path.join(corePkg, "PaymentGateway.java");
    const gwSrc = [
      "package com.acme.core;",
      "public interface PaymentGateway {",
      "    void charge(int cents);",
      "}",
    ].join("\n");
    await fs.writeFile(gwPath, gwSrc);

    const idsPath = path.join(corePkg, "Ids.java");
    await fs.writeFile(
      idsPath,
      `package com.acme.core;\npublic class Ids {\n    public static String nextId() { return "id"; }\n}\n`
    );

    const helperPath = path.join(payPkg, "PayHelper.java");
    await fs.writeFile(
      helperPath,
      `package com.acme.pay;\npublic class PayHelper {\n    public static int fee() { return 5; }\n}\n`
    );

    const stripePath = path.join(payPkg, "StripeGateway.java");
    await fs.writeFile(
      stripePath,
      [
        "package com.acme.pay;",
        "import com.acme.core.PaymentGateway;",
        "public class StripeGateway implements PaymentGateway {",
        "    @Override",
        "    public void charge(int cents) {}",
        "}",
      ].join("\n")
    );

    const ctrlPath = path.join(payPkg, "PayController.java");
    const ctrlSrc = [
      "package com.acme.pay;",
      "import com.acme.core.PaymentGateway;",
      "import static com.acme.core.Ids.nextId;",
      "import java.util.List;",
      "public class PayController {",
      "    private final PaymentGateway gateway;",
      "    public void run(List<String> items) {",
      "        var id = nextId();",
      "        var h = new PayHelper();",
      "        gateway.charge(100);",
      "    }",
      "}",
    ].join("\n");
    await fs.writeFile(ctrlPath, ctrlSrc);

    const twoServices = [
      { id: "core", name: "core-contracts", root: coreSvc, relPath: "core-contracts" },
      { id: "pay", name: "payment-service", root: paySvc, relPath: "payment-service" },
    ];

    // Static import across services (`nextId()` -> `Ids.java` line 3)
    const rStatic = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 8,
      col: colOf(ctrlSrc, 8, "nextId"),
      currentRoot: tmpRoot,
      services: twoServices,
      appHomeDir,
    });
    assert.equal(rStatic.status, "ok");
    assert.equal(path.normalize(rStatic.best.filePath), path.normalize(idsPath));
    assert.equal(rStatic.best.line, 3);

    // Unimported same-package class `new PayHelper()` -> `PayHelper.java` line 2
    const rSamePkg = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 9,
      col: colOf(ctrlSrc, 9, "PayHelper"),
      currentRoot: tmpRoot,
      services: twoServices,
      appHomeDir,
    });
    assert.equal(rSamePkg.status, "ok");
    assert.equal(path.normalize(rSamePkg.best.filePath), path.normalize(helperPath));
    assert.equal(rSamePkg.best.line, 2);

    // 1 concrete implementation across services (`gateway.charge(100)` -> directly to `StripeGateway.java` line 5!)
    const rSingleImpl = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 10,
      col: colOf(ctrlSrc, 10, "charge"),
      currentRoot: tmpRoot,
      services: twoServices,
      appHomeDir,
    });
    assert.equal(rSingleImpl.status, "ok");
    assert.equal(path.normalize(rSingleImpl.best.filePath), path.normalize(stripePath));
    assert.equal(rSingleImpl.best.line, 5);
    assert.equal(rSingleImpl.best.serviceName, "payment-service");

    // JDK import -> external notice
    const rJdk = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 7,
      col: colOf(ctrlSrc, 7, "List"),
      currentRoot: tmpRoot,
      services: twoServices,
      appHomeDir,
    });
    assert.equal(rJdk.status, "external");
    assert.equal(rJdk.externalPackage, "java.util.List");

    // Add 2nd concrete implementation in a 3rd service -> `ambiguous` picker returns both concrete targets!
    const paypalPath = path.join(billPkg, "PaypalGateway.java");
    await fs.writeFile(
      paypalPath,
      [
        "package com.acme.bill;",
        "import com.acme.core.PaymentGateway;",
        "public class PaypalGateway implements PaymentGateway {",
        "    @Override",
        "    public void charge(int cents) {}",
        "}",
      ].join("\n")
    );
    const threeServices = [
      ...twoServices,
      { id: "bill", name: "billing-service", root: billSvc, relPath: "billing-service" },
    ];
    const rMultiImpl = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 10,
      col: colOf(ctrlSrc, 10, "charge"),
      currentRoot: tmpRoot,
      services: threeServices,
      appHomeDir,
    });
    assert.equal(rMultiImpl.status, "ambiguous");
    const targetPaths = rMultiImpl.candidates.map((c) => path.normalize(c.filePath)).sort();
    assert.deepEqual(targetPaths, [path.normalize(paypalPath), path.normalize(stripePath)].sort());

    // Clicking directly on `void charge(int cents);` in interface `PaymentGateway.java` also yields both concrete impls!
    const rIfaceClick = await symIdx.resolveCrossFileNavigation({
      sourceText: gwSrc,
      filePath: gwPath,
      line: 3,
      col: colOf(gwSrc, 3, "charge"),
      currentRoot: tmpRoot,
      services: threeServices,
      appHomeDir,
    });
    assert.equal(rMultiImpl.status, "ambiguous");
    assert.equal(rIfaceClick.status, "ambiguous");
    assert.equal(rIfaceClick.candidates.length, 2);

    // Real Java ambiguous output must format directly into dropdown items without .symbol/.serviceRoot shims.
    const dropdownItems = buildDisambiguationDropdownItems(rIfaceClick.candidates, coreSvc, "core-contracts");
    assert.equal(dropdownItems.length, 2);
    assert.deepEqual(dropdownItems.map((it) => it.label).sort(), ["PaypalGateway.charge", "StripeGateway.charge"]);
    assert.ok(dropdownItems.every((it) => it.subline.endsWith(".java:5") && !it.subline.startsWith(tmpRoot)));
    assert.deepEqual(dropdownItems.map((it) => it.badge).sort(), ["billing-service", "payment-service"]);
  });

  test("warmServiceSymbolIndex persists disk cache cleanly, invalidates changed files, and passes SSH `on` + lock-free Git flags", async () => {
    const mock = getHerdrMock();
    const remoteRoot = "/srv/remote-svc";
    const remoteFiles = {
      [`${remoteRoot}/src/greeter.js`]: `export function greet(name) { return name; }\n`,
      [`${remoteRoot}/src/main.js`]: `import { greet } from "./greeter.js";\ngreet("world");\n`,
    };

    mock.readTextFileImpl = async (p, opts = {}) => {
      mock.readTextFileCalls.push({ path: p, opts });
      if (p in remoteFiles) return remoteFiles[p];
      throw new Error("ENOENT");
    };
    mock.execImpl = async (cmd, args = [], opts = {}) => {
      mock.execCalls.push({ cmd, args, opts });
      if (cmd === "rg" && args[0] === "--files") {
        return { code: 0, stdout: "src/greeter.js\nsrc/main.js\n", stderr: "" };
      }
      if (cmd === "git" && args.includes("ls-files")) {
        return { code: 0, stdout: "src/greeter.js\nsrc/main.js\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const remoteSvc = { id: "remote-1", name: "remote-svc", root: remoteRoot, on: "dev-box" };
    await symIdx.warmServiceSymbolIndex({
      service: remoteSvc,
      on: "dev-box",
      appHomeDir,
    });

    assert.ok(mock.execCalls.some((c) => c.opts?.on === "dev-box" && c.opts?.cwd === remoteRoot));
    assert.ok(mock.readTextFileCalls.some((c) => c.opts?.on === "dev-box"));

    // Verify lock-free Git fallback flags when rg fails
    mock.execCalls.length = 0;
    mock.execImpl = async (cmd, args = [], opts = {}) => {
      mock.execCalls.push({ cmd, args, opts });
      if (cmd === "rg") return { code: 127, stdout: "", stderr: "not found" };
      if (cmd === "git") return { code: 0, stdout: "src/greeter.js\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const listed = await symIdx.listServiceIndexableFiles({ root: remoteRoot, on: "dev-box" });
    assert.deepEqual(listed, ["src/greeter.js"]);
    const gitCall = mock.execCalls.find((c) => c.cmd === "git");
    assert.ok(gitCall);
    assert.ok(gitCall.args.includes("--no-optional-locks"));
    assert.ok(gitCall.args.includes("core.fsmonitor=false"));
    assert.ok(gitCall.args.includes("diff.autoRefreshIndex=false"));
    assert.equal(gitCall.opts.on, "dev-box");

    // Cache invalidation drops stale source cache so edited file lines are re-read cleanly
    mock.readTextFileCalls.length = 0;
    const beforeNav = await symIdx.resolveCrossFileNavigation({
      sourceText: remoteFiles[`${remoteRoot}/src/main.js`],
      filePath: `${remoteRoot}/src/main.js`,
      line: 2,
      col: 2,
      currentRoot: remoteRoot,
      on: "dev-box",
      services: [remoteSvc],
      appHomeDir,
    });
    assert.equal(beforeNav.status, "ok");
    assert.equal(beforeNav.best.line, 1);

    remoteFiles[`${remoteRoot}/src/greeter.js`] = `\n\nexport function greet(name) { return name; }\n`;
    symIdx.invalidateIndexedFiles(remoteRoot, [`${remoteRoot}/src/greeter.js`], "dev-box");

    const afterNav = await symIdx.resolveCrossFileNavigation({
      sourceText: remoteFiles[`${remoteRoot}/src/main.js`],
      filePath: `${remoteRoot}/src/main.js`,
      line: 2,
      col: 2,
      currentRoot: remoteRoot,
      on: "dev-box",
      services: [remoteSvc],
      appHomeDir,
    });
    assert.equal(afterNav.status, "ok");
    assert.equal(afterNav.best.line, 3);
  });

  test("symbol disk cache isolates local and SSH remote workspaces sharing an identical root path", async () => {
    const sharedRoot = path.join(tmpRoot, "same-path-app");
    const localSrc = path.join(sharedRoot, "src");
    await fs.mkdir(localSrc, { recursive: true });
    await fs.writeFile(path.join(localSrc, "target.js"), "export function onlyLocal() { return 1; }\n");
    const localMainSrc = `import { onlyLocal } from "./target.js";\nonlyLocal();\n`;
    await fs.writeFile(path.join(localSrc, "main.js"), localMainSrc);

    const mock = getHerdrMock();
    mock.execImpl = async (cmd, args = [], opts = {}) => {
      if (opts?.on === "ssh-prod") {
        if (cmd === "rg") return { code: 0, stdout: "src/remoteTarget.js\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "rg") return { code: 0, stdout: "src/target.js\nsrc/main.js\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    mock.readTextFileImpl = async (p, opts = {}) => {
      if (opts?.on === "ssh-prod" && p.endsWith("remoteTarget.js")) {
        return "export function onlyRemote() { return 99; }\n";
      }
      return fs.readFile(p, "utf8");
    };

    const remoteSvc = { id: "rem", name: "app", root: sharedRoot, on: "ssh-prod" };
    await symIdx.warmServiceSymbolIndex({ service: remoteSvc, on: "ssh-prod", appHomeDir });

    const localSvc = { id: "loc", name: "app", root: sharedRoot, on: null };
    await symIdx.warmServiceSymbolIndex({ service: localSvc, on: null, appHomeDir });

    // Two distinct workspace hash directories must exist on disk (no overwrite between local and SSH `on`).
    const wsDir = path.join(appHomeDir, "cognivisor", "workspaces");
    const subdirs = await fs.readdir(wsDir);
    assert.equal(subdirs.length, 2);

    // Reloading local from disk after clearing memory cache must resolve local symbol and NOT remote symbol.
    symIdx.resetSymbolIndexCache();
    const localRes = await symIdx.resolveCrossFileNavigation({
      sourceText: localMainSrc,
      filePath: path.join(localSrc, "main.js"),
      line: 2,
      col: 2,
      currentRoot: sharedRoot,
      on: null,
      services: [localSvc],
      appHomeDir,
    });
    assert.equal(localRes.status, "ok");
    assert.equal(path.normalize(localRes.best.filePath), path.normalize(path.join(localSrc, "target.js")));
  });

  test("KNOWN_BUILTIN_RECEIVERS guards console.error, os.*, and System.out.* from matching unrelated DTO fields", async () => {
    const repoRoot = path.join(tmpRoot, "builtin-guard-app");
    const srcDir = path.join(repoRoot, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const dtoPath = path.join(srcDir, "types.ts");
    const mainPath = path.join(srcDir, "app.ts");
    const pyPath = path.join(srcDir, "worker.py");
    const javaPath = path.join(srcDir, "Runner.java");

    await fs.writeFile(dtoPath, "export interface ApiResult { error?: string; join?: boolean; }\n");
    const jsSrc = "function run() {\n  console.error(\"boom\");\n}\n";
    const pySrc = "def check(p):\n    return os.path.join(p, 'x')\n";
    const javaSrc = "public class Runner {\n  public void run() {\n    System.out.println(\"hi\");\n  }\n}\n";
    await fs.writeFile(mainPath, jsSrc);
    await fs.writeFile(pyPath, pySrc);
    await fs.writeFile(javaPath, javaSrc);

    const mock = getHerdrMock();
    mock.readTextFileImpl = async (p) => fs.readFile(p, "utf8");
    mock.execImpl = async (cmd) => {
      if (cmd === "rg") {
        return { code: 0, stdout: "src/types.ts\nsrc/app.ts\nsrc/worker.py\nsrc/Runner.java\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const svc = { id: "bg", name: "builtin-guard-app", root: repoRoot };
    const jsRes = await symIdx.resolveCrossFileNavigation({
      sourceText: jsSrc,
      filePath: mainPath,
      line: 2,
      col: 12,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(jsRes.status, "external");
    assert.equal(jsRes.externalPackage, "console");

    const pyRes = await symIdx.resolveCrossFileNavigation({
      sourceText: pySrc,
      filePath: pyPath,
      line: 2,
      col: 21,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(pyRes.status, "external");
    assert.equal(pyRes.externalPackage, "os");

    const javaRes = await symIdx.resolveCrossFileNavigation({
      sourceText: javaSrc,
      filePath: javaPath,
      line: 3,
      col: 17,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(javaRes.status, "external");
    assert.equal(javaRes.externalPackage, "System");
  });

  test("incremental mtimeMs/size validation rebuilds modified files, drops v1 disk cache, and warmFileImports seeds peek cache", async () => {
    const repoRoot = path.join(tmpRoot, "inc-cache-app");
    const srcDir = path.join(repoRoot, "src");
    await fs.mkdir(srcDir, { recursive: true });
    const helperPath = path.join(srcDir, "helper.js");
    const entryPath = path.join(srcDir, "entry.js");
    await fs.writeFile(helperPath, "export function calcTax(v) { return v * 0.1; }\n");
    const entrySrc = "import { calcTax } from \"./helper.js\";\nconsole.log(calcTax(10));\n";
    await fs.writeFile(entryPath, entrySrc);

    const svc = { id: "inc", name: "inc-cache-app", root: repoRoot };
    const mock = getHerdrMock();
    mock.readTextFileImpl = async (p) => fs.readFile(p, "utf8");
    mock.execImpl = async (cmd) => {
      if (cmd === "rg") return { code: 0, stdout: "src/helper.js\nsrc/entry.js\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };

    assert.equal(symIdx.isServiceIndexWarmed(repoRoot, null), false);
    await symIdx.warmServiceSymbolIndex({ service: svc, appHomeDir });
    assert.equal(symIdx.isServiceIndexWarmed(repoRoot, null), true);

    // Simulate editing helper.js on disk updating its line number and size
    await fs.writeFile(helperPath, "\n\nexport function calcTax(v) {\n  return v * 0.2;\n}\n");
    symIdx.resetSymbolIndexCache();
    await symIdx.warmServiceSymbolIndex({ service: svc, appHomeDir });

    const navAfterEdit = await symIdx.resolveCrossFileNavigation({
      sourceText: entrySrc,
      filePath: entryPath,
      line: 2,
      col: 14,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(navAfterEdit.status, "ok");
    assert.equal(navAfterEdit.best.line, 3);

    // Pre-warm active file imports into RAM and verify synchronous peek hit
    symIdx.resetSymbolIndexCache();
    assert.equal(symIdx.peekCachedSourceText(helperPath, null), null);
    const warmed = await symIdx.warmFileImports({
      filePath: entryPath,
      sourceText: entrySrc,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.ok(warmed >= 1);
    assert.match(symIdx.peekCachedSourceText(helperPath, null) || "", /calcTax/);
    assert.match(symIdx.peekCachedSourceText(entryPath, null) || "", /import \{ calcTax \}/);

    // Reject stale version: 1 disk caches and rebuild cleanly under INDEX_CACHE_VERSION = 2
    const wsDir = path.join(appHomeDir, "cognivisor", "workspaces");
    const wsFolders = await fs.readdir(wsDir);
    let corruptedCachePath = null;
    for (const d of wsFolders) {
      const candidate = path.join(wsDir, d, "symbols-index.json");
      try {
        const raw = JSON.parse(await fs.readFile(candidate, "utf8"));
        if (raw.root === path.resolve(repoRoot).replace(/\\/g, "/")) {
          corruptedCachePath = candidate;
          await fs.writeFile(
            candidate,
            JSON.stringify({ version: 1, root: raw.root, on: null, entries: [{ relPath: "src/staleOnly.js", sig: "x", summary: { lang: "js", path: "src/staleOnly.js", imports: [], exports: [], types: [], functions: [{ name: "staleGhost", line: 1, column: 1 }], topVariables: [] } }] }),
            "utf8"
          );
          break;
        }
      } catch {}
    }
    assert.ok(corruptedCachePath);
    symIdx.resetSymbolIndexCache();
    await symIdx.warmServiceSymbolIndex({ service: svc, appHomeDir });
    const upgraded = JSON.parse(await fs.readFile(corruptedCachePath, "utf8"));
    assert.equal(upgraded.version, 2);
    assert.ok(!upgraded.entries.some((e) => e.relPath === "src/staleOnly.js"));
  });

  test("Ctrl+Clicking declaration headers discovers workspace usages (1 -> ok, >1 -> ambiguous, 0 -> already-there) while keeping interface -> subtype priority", async () => {
    const repoRoot = path.join(tmpRoot, "refs-app");
    const srcDir = path.join(repoRoot, "src");
    const testDir = path.join(srcDir, "__tests__");
    await fs.mkdir(testDir, { recursive: true });

    const libPath = path.join(srcDir, "lib.js");
    const callerPath = path.join(srcDir, "caller.js");
    const callerTestPath = path.join(testDir, "lib.test.js");
    const libSrc = [
      "export function singleUse(x) { return x + 1; }",
      "export function multiUse(x) { return x * 2; }",
      "export function unusedFn() { return 0; }",
    ].join("\n") + "\n";
    const callerSrc = [
      "import { singleUse, multiUse } from \"./lib.js\";",
      "export function runProd() {",
      "  return singleUse(1) + multiUse(2);",
      "}",
    ].join("\n") + "\n";
    const testSrc = [
      "import { multiUse } from \"../lib.js\";",
      "console.log(multiUse(5));",
    ].join("\n") + "\n";

    await fs.writeFile(libPath, libSrc);
    await fs.writeFile(callerPath, callerSrc);
    await fs.writeFile(callerTestPath, testSrc);

    const svc = { id: "refs", name: "refs-app", root: repoRoot };
    const mock = getHerdrMock();
    mock.readTextFileImpl = async (p) => fs.readFile(p, "utf8");
    mock.execImpl = async (cmd, args = []) => {
      if (cmd === "rg") {
        const pat = String(args[args.length - 2] || "");
        if (pat.includes("singleUse")) return { code: 0, stdout: "src/lib.js\nsrc/caller.js\n", stderr: "" };
        if (pat.includes("multiUse")) return { code: 0, stdout: "src/lib.js\nsrc/caller.js\nsrc/__tests__/lib.test.js\n", stderr: "" };
        return { code: 0, stdout: "src/lib.js\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const singleRes = await symIdx.resolveCrossFileNavigation({
      sourceText: libSrc,
      filePath: libPath,
      line: 1,
      col: 18,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(singleRes.status, "ok");
    assert.equal(singleRes.mode, "references");
    assert.equal(path.normalize(singleRes.best.filePath), path.normalize(callerPath));
    assert.equal(singleRes.best.line, 3);

    const multiRes = await symIdx.resolveCrossFileNavigation({
      sourceText: libSrc,
      filePath: libPath,
      line: 2,
      col: 18,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(multiRes.status, "ambiguous");
    assert.equal(multiRes.mode, "references");
    assert.equal(multiRes.candidates.length, 2);
    assert.equal(path.normalize(multiRes.candidates[0].filePath), path.normalize(callerPath));

    const unusedRes = await symIdx.resolveCrossFileNavigation({
      sourceText: libSrc,
      filePath: libPath,
      line: 3,
      col: 18,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(unusedRes.status, "already-there");

    // Interface / abstract method declarations must still prioritize concrete subtype implementations over reference search
    const ifacePath = path.join(srcDir, "Store.ts");
    const implPath = path.join(srcDir, "MemoryStore.ts");
    const ifaceSrc = "export interface Store {\n  save(id: string): void;\n}\n";
    const implSrc = "import type { Store } from \"./Store\";\nexport class MemoryStore implements Store {\n  save(id: string): void {}\n}\n";
    await fs.writeFile(ifacePath, ifaceSrc);
    await fs.writeFile(implPath, implSrc);
    mock.execImpl = async (cmd) => {
      if (cmd === "rg") return { code: 0, stdout: "src/Store.ts\nsrc/MemoryStore.ts\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const ifaceRes = await symIdx.resolveCrossFileNavigation({
      sourceText: ifaceSrc,
      filePath: ifacePath,
      line: 2,
      col: 3,
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(ifaceRes.status, "ok");
    assert.equal(path.normalize(ifaceRes.best.filePath), path.normalize(implPath));
    assert.equal(ifaceRes.best.line, 3);
  });

  test("Java resolves cross-file @Builder/@Getter, JDK container chains, overloads, declaration self-clicks, relative filePath, and @Column attrs", async () => {
    const repoRoot = path.join(tmpRoot, "java-cross-app");
    const basePkg = path.join(repoRoot, "src/main/java/com/rag/app");
    await fs.mkdir(path.join(basePkg, "model"), { recursive: true });
    await fs.mkdir(path.join(basePkg, "repo"), { recursive: true });
    await fs.mkdir(path.join(basePkg, "service"), { recursive: true });

    const tenantPath = path.join(basePkg, "model/Tenant.java");
    const repoPath = path.join(basePkg, "repo/TenantRepository.java");
    const svcPath = path.join(basePkg, "service/TenantService.java");

    const tenantSrc = [
      "package com.rag.app.model;",
      "import jakarta.persistence.Column;",
      "import lombok.Builder;",
      "import lombok.Getter;",
      "@Getter",
      "@Builder",
      "public class Tenant {",
      "  private Long id;",
      '  @Column(name = "tenant_name")',
      "  private String name;",
      "}",
    ].join("\n");

    const repoSrc = [
      "package com.rag.app.repo;",
      "import com.rag.app.model.Tenant;",
      "import java.util.Optional;",
      "public interface TenantRepository {",
      "  Optional<Tenant> findById(Long id);",
      "}",
    ].join("\n");

    const svcSrc = [
      "package com.rag.app.service;",
      "import com.rag.app.model.Tenant;",
      "import com.rag.app.repo.TenantRepository;",
      "import java.util.UUID;",
      "import org.springframework.http.ResponseEntity;",
      "public class TenantService {",
      "  private final TenantRepository tenantRepository;",
      "  public String ask(String req, UUID tenantId) { return req; }",
      "  public String ask(String req, String sessionId) { return sessionId; }",
      "  private void audit(Long id) {}",
      "  public ResponseEntity<String> create(UUID tid, Long existingId) {",
      '    Tenant built = Tenant.builder().name("acme").build();',
      "    Long builtId = built.getId();",
      "    Tenant found = tenantRepository.findById(existingId).orElseThrow();",
      "    String foundName = found.getName();",
      "    audit(builtId);",
      '    ask("q", tid);',
      '    return ResponseEntity.status(200).body(foundName);',
      "  }",
      "}",
    ].join("\n");

    await fs.writeFile(tenantPath, tenantSrc);
    await fs.writeFile(repoPath, repoSrc);
    await fs.writeFile(svcPath, svcSrc);

    const mock = getHerdrMock();
    mock.readTextFileImpl = async (p) => fs.readFile(p, "utf8");
    mock.execImpl = async (cmd) => {
      if (cmd === "rg") {
        return {
          code: 0,
          stdout: [
            "src/main/java/com/rag/app/model/Tenant.java",
            "src/main/java/com/rag/app/repo/TenantRepository.java",
            "src/main/java/com/rag/app/service/TenantService.java",
          ].join("\n") + "\n",
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const svc = { id: "app", name: "java-cross-app", root: repoRoot };

    // 1. Cross-file Lombok @Builder chain (.builder(), .name(), .build()) + relative filePath & workspaceRoot
    const rBuilder = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: "src/main/java/com/rag/app/service/TenantService.java",
      line: 12,
      col: colOf(svcSrc, 12, "builder"),
      workspaceRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rBuilder.status, "ok");
    assert.equal(path.normalize(rBuilder.best.filePath), path.normalize(tenantPath));
    assert.equal(rBuilder.best.line, 7);

    const rBuilderField = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: svcPath,
      line: 12,
      col: colOf(svcSrc, 12, "name"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rBuilderField.status, "ok");
    assert.equal(path.normalize(rBuilderField.best.filePath), path.normalize(tenantPath));
    assert.equal(rBuilderField.best.line, 10);

    const rBuild = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: svcPath,
      line: 12,
      col: colOf(svcSrc, 12, "build"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rBuild.status, "ok");
    assert.equal(path.normalize(rBuild.best.filePath), path.normalize(tenantPath));
    assert.equal(rBuild.best.line, 7);

    // 2. Cross-file Lombok @Getter on variable + Optional<Tenant>.orElseThrow().getName()
    const rGetId = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: svcPath,
      line: 13,
      col: colOf(svcSrc, 13, "getId"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rGetId.status, "ok");
    assert.equal(path.normalize(rGetId.best.filePath), path.normalize(tenantPath));
    assert.equal(rGetId.best.line, 8);

    const rOptGetName = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: svcPath,
      line: 15,
      col: colOf(svcSrc, 15, "getName"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rOptGetName.status, "ok");
    assert.equal(path.normalize(rOptGetName.best.filePath), path.normalize(tenantPath));
    assert.equal(rOptGetName.best.line, 10);

    // 3. External fluent chain ResponseEntity.status(200).body(...) -> external
    const rExtBody = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: svcPath,
      line: 18,
      col: colOf(svcSrc, 18, "body"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rExtBody.status, "external");
    assert.equal(rExtBody.externalPackage, "org.springframework.http.ResponseEntity");

    // 4. Annotation attribute @Column(name = ...) stays external (does not jump to DTO field)
    const rColAttr = await symIdx.resolveCrossFileNavigation({
      sourceText: tenantSrc,
      filePath: tenantPath,
      line: 9,
      col: colOf(tenantSrc, 9, "name"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rColAttr.status, "external");
    assert.equal(rColAttr.externalPackage, "jakarta.persistence.Column");

    // 5. Same-arity overload disambiguation in cross-file navigation
    const rOverload = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: svcPath,
      line: 17,
      col: colOf(svcSrc, 17, "ask"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rOverload.status, "ok");
    assert.equal(rOverload.best.line, 8);

    // 6. Clicking own declaration header enters findWorkspaceReferences (same-file for private/local, already-there on 0 refs)
    const rPrivateDecl = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: svcPath,
      line: 10,
      col: colOf(svcSrc, 10, "audit"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rPrivateDecl.status, "ok");
    assert.equal(rPrivateDecl.mode, "references");
    assert.equal(rPrivateDecl.best.line, 16);

    const rZeroRefs = await symIdx.resolveCrossFileNavigation({
      sourceText: svcSrc,
      filePath: svcPath,
      line: 6,
      col: colOf(svcSrc, 6, "TenantService"),
      currentRoot: repoRoot,
      services: [svc],
      appHomeDir,
    });
    assert.equal(rZeroRefs.status, "already-there");
  });

  test("regression: Array-valued indexedFilesByRoot does not throw overlaySet.has TypeError on Java DTO/service navigation", async () => {
    const repoRoot = path.join(tmpRoot, "scaffold-array-probe");
    const dtoDir = path.join(repoRoot, "src", "main", "java", "com", "rag", "scaffold", "dto");
    const svcDir = path.join(repoRoot, "src", "main", "java", "com", "rag", "scaffold", "service");
    const implDir = path.join(svcDir, "impl");
    const ctrlDir = path.join(repoRoot, "src", "main", "java", "com", "rag", "scaffold", "controller");
    await fs.mkdir(dtoDir, { recursive: true });
    await fs.mkdir(implDir, { recursive: true });
    await fs.mkdir(ctrlDir, { recursive: true });

    const reqPath = path.join(dtoDir, "ChatRequest.java");
    const respPath = path.join(dtoDir, "ChatResponse.java");
    const svcIfacePath = path.join(svcDir, "RagChatService.java");
    const svcImplPath = path.join(implDir, "RagChatServiceImpl.java");
    const ctrlPath = path.join(ctrlDir, "ChatController.java");

    const reqSrc = "package com.rag.scaffold.dto;\npublic record ChatRequest(String question) {}\n";
    const respSrc = "package com.rag.scaffold.dto;\npublic record ChatResponse(String answer) {}\n";
    const svcIfaceSrc = [
      "package com.rag.scaffold.service;",
      "import com.rag.scaffold.dto.ChatRequest;",
      "import com.rag.scaffold.dto.ChatResponse;",
      "import java.util.UUID;",
      "public interface RagChatService {",
      "  ChatResponse askQuestion(ChatRequest request, UUID tenantId);",
      "}",
    ].join("\n") + "\n";
    const svcImplSrc = [
      "package com.rag.scaffold.service.impl;",
      "import com.rag.scaffold.dto.ChatRequest;",
      "import com.rag.scaffold.dto.ChatResponse;",
      "import com.rag.scaffold.service.RagChatService;",
      "import java.util.UUID;",
      "public class RagChatServiceImpl implements RagChatService {",
      "  @Override",
      "  public ChatResponse askQuestion(ChatRequest request, UUID tenantId) {",
      "    return null;",
      "  }",
      "}",
    ].join("\n") + "\n";
    const ctrlSrc = [
      "package com.rag.scaffold.controller;",
      "import com.rag.scaffold.dto.ChatRequest;",
      "import com.rag.scaffold.dto.ChatResponse;",
      "import com.rag.scaffold.service.RagChatService;",
      "import java.util.UUID;",
      "public class ChatController {",
      "  private final RagChatService ragChatService;",
      "  public ChatController(RagChatService ragChatService) { this.ragChatService = ragChatService; }",
      "  public ChatResponse askQuestion(ChatRequest request, UUID tenantId) {",
      "    ChatResponse response = ragChatService.askQuestion(request, tenantId);",
      "    return response;",
      "  }",
      "}",
    ].join("\n") + "\n";

    await fs.writeFile(reqPath, reqSrc);
    await fs.writeFile(respPath, respSrc);
    await fs.writeFile(svcIfacePath, svcIfaceSrc);
    await fs.writeFile(svcImplPath, svcImplSrc);
    await fs.writeFile(ctrlPath, ctrlSrc);

    const svc = { id: "scaffold", name: "scaffold", root: repoRoot };
    const mock = getHerdrMock();
    mock.readTextFileImpl = async (p) => fs.readFile(p, "utf8");
    mock.execImpl = async () => ({ code: 1, stdout: "", stderr: "" });
    symIdx.resetSymbolIndexCache();

    const relFiles = [
      "./src/main/java/com/rag/scaffold/dto/ChatRequest.java",
      "src/main/java/com/rag/scaffold/dto/ChatResponse.java",
      "src/main/java/com/rag/scaffold/service/RagChatService.java",
      "src/main/java/com/rag/scaffold/service/impl/RagChatServiceImpl.java",
      "src/main/java/com/rag/scaffold/controller/ChatController.java",
    ];
    const arrayIndexedFiles = new Map([[repoRoot, relFiles]]);

    const rReqFromArray = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 9,
      col: colOf(ctrlSrc, 9, "ChatRequest"),
      currentRoot: repoRoot,
      services: [svc],
      indexedFilesByRoot: arrayIndexedFiles,
      appHomeDir,
    });
    assert.equal(rReqFromArray.status, "ok");
    assert.equal(path.normalize(rReqFromArray.best.filePath), path.normalize(reqPath));
    assert.equal(rReqFromArray.best.line, 2);

    const rRespFromArray = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 10,
      col: colOf(ctrlSrc, 10, "ChatResponse"),
      currentRoot: repoRoot,
      services: [svc],
      indexedFilesByRoot: arrayIndexedFiles,
      appHomeDir,
    });
    assert.equal(rRespFromArray.status, "ok");
    assert.equal(path.normalize(rRespFromArray.best.filePath), path.normalize(respPath));
    assert.equal(rRespFromArray.best.line, 2);

    const rMethodFromArray = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 10,
      col: colOf(ctrlSrc, 10, "askQuestion"),
      currentRoot: repoRoot,
      services: [svc],
      indexedFilesByRoot: arrayIndexedFiles,
      appHomeDir,
    });
    assert.equal(rMethodFromArray.status, "ok");
    assert.equal(rMethodFromArray.best.kind, "method");

    const setIndexedFiles = new Map([[repoRoot, new Set(relFiles.map((p) => p.replace(/^\.\//, "")))]]);
    const rReqFromSet = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 9,
      col: colOf(ctrlSrc, 9, "ChatRequest"),
      currentRoot: repoRoot,
      services: [svc],
      indexedFilesByRoot: setIndexedFiles,
      appHomeDir,
    });
    assert.equal(rReqFromSet.status, "ok");
    assert.equal(path.normalize(rReqFromSet.best.filePath), path.normalize(reqPath));

    const emptyIndexedFiles = new Map([[repoRoot, []]]);
    const rReqFromEmptyArray = await symIdx.resolveCrossFileNavigation({
      sourceText: ctrlSrc,
      filePath: ctrlPath,
      line: 9,
      col: colOf(ctrlSrc, 9, "ChatRequest"),
      currentRoot: repoRoot,
      services: [svc],
      indexedFilesByRoot: emptyIndexedFiles,
      appHomeDir,
    });
    assert.equal(rReqFromEmptyArray.status, "ok");
    assert.equal(path.normalize(rReqFromEmptyArray.best.filePath), path.normalize(reqPath));
  });

  test("isServiceIndexWarmed stays read-only before warm and invalidateIndexedFiles preserves siblings while marking new files dirty", async () => {
    const svcRoot = path.join(tmpRoot, "granular-svc");
    await fs.mkdir(path.join(svcRoot, "src"), { recursive: true });
    const alphaPath = path.join(svcRoot, "src", "alpha.js");
    const betaPath = path.join(svcRoot, "src", "beta.js");
    const entryPath = path.join(svcRoot, "src", "entry.js");

    await fs.writeFile(alphaPath, "export function alphaFn() { return 1; }\n");
    await fs.writeFile(betaPath, "export function betaFn() { return 2; }\n");
    const entrySrc = [
      'import { alphaFn } from "./alpha.js";',
      'import { betaFn } from "./beta.js";',
      "alphaFn();",
      "betaFn();",
    ].join("\n");
    await fs.writeFile(entryPath, entrySrc);

    const svc = { id: "g1", name: "granular-svc", root: svcRoot, on: null };
    const wsCacheDir = path.join(appHomeDir, "cognivisor", "workspaces");

    // Read-only unwarmed check must return false without creating disk cache artifacts
    assert.equal(symIdx.isServiceIndexWarmed(svcRoot, null), false);
    let existsBefore = true;
    try {
      await fs.access(wsCacheDir);
    } catch {
      existsBefore = false;
    }
    assert.equal(existsBefore, false);

    await symIdx.warmServiceSymbolIndex({ service: svc, appHomeDir });
    assert.equal(symIdx.isServiceIndexWarmed(svcRoot, null), true);
    assert.equal(symIdx.isServiceIndexWarmed(svcRoot, "other-host"), false);

    const indexed = new Map([[svcRoot, [alphaPath, betaPath, entryPath]]]);
    const betaBefore = await symIdx.resolveCrossFileNavigation({
      sourceText: entrySrc,
      filePath: entryPath,
      line: 4,
      col: 2,
      services: [svc],
      indexedFilesByRoot: indexed,
      appHomeDir,
    });
    assert.equal(betaBefore.status, "ok");
    assert.equal(betaBefore.best.line, 1);

    // Modify both files on disk, but ONLY invalidate alphaPath -> sibling betaPath keeps cached line 1
    await fs.writeFile(alphaPath, "\n\nexport function alphaFn() { return 10; }\n");
    await fs.writeFile(betaPath, "\n\n\nexport function betaFn() { return 20; }\n");
    symIdx.invalidateIndexedFiles(svcRoot, [alphaPath], null);

    const alphaAfter = await symIdx.resolveCrossFileNavigation({
      sourceText: entrySrc,
      filePath: entryPath,
      line: 3,
      col: 2,
      services: [svc],
      indexedFilesByRoot: indexed,
      appHomeDir,
    });
    assert.equal(alphaAfter.status, "ok");
    assert.equal(alphaAfter.best.line, 3);

    const betaStillCached = await symIdx.resolveCrossFileNavigation({
      sourceText: entrySrc,
      filePath: entryPath,
      line: 4,
      col: 2,
      services: [svc],
      indexedFilesByRoot: indexed,
      appHomeDir,
    });
    assert.equal(betaStillCached.status, "ok");
    assert.equal(betaStillCached.best.line, 1);

    // Adding a brand new source file and invalidating it marks the index dirty so skipIfFreshMs still refreshes it
    const gammaPath = path.join(svcRoot, "src", "gamma.js");
    const entryGammaPath = path.join(svcRoot, "src", "entryGamma.js");
    await fs.writeFile(gammaPath, "export function gammaUniqueSymbol() { return 3; }\n");
    const entryGammaSrc = 'import { gammaUniqueSymbol } from "./gamma.js";\ngammaUniqueSymbol();\n';
    await fs.writeFile(entryGammaPath, entryGammaSrc);
    indexed.set(svcRoot, [alphaPath, betaPath, entryPath, gammaPath, entryGammaPath]);
    symIdx.invalidateIndexedFiles(svcRoot, [gammaPath, entryGammaPath], null);

    await symIdx.warmServiceSymbolIndex({ service: svc, appHomeDir, skipIfFreshMs: 60000 });
    const gammaNav = await symIdx.resolveCrossFileNavigation({
      sourceText: entryGammaSrc,
      filePath: entryGammaPath,
      line: 2,
      col: 2,
      services: [svc],
      indexedFilesByRoot: indexed,
      appHomeDir,
    });
    assert.equal(gammaNav.status, "ok");
    assert.equal(path.normalize(gammaNav.best.filePath), path.normalize(gammaPath));
    assert.equal(gammaNav.best.line, 1);

    const refs = await symIdx.findWorkspaceReferences({
      symbol: "gammaUniqueSymbol",
      lang: "js",
      declFilePath: gammaPath,
      declLine: 1,
      declCol: 17,
      currentSourceText: "export function gammaUniqueSymbol() { return 3; }\n",
      owningService: svc,
      allServices: [svc],
      ioOpts: { indexedFilesByRoot: indexed, appHomeDir },
    });
    assert.ok(refs.some((r) => path.normalize(r.filePath) === path.normalize(entryGammaPath)));
  });
});
