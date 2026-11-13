import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import moduleApi from "node:module";

const execFileAsync = promisify(execFile);

let hooksInstalled = false;

export const defaultExec = async (cmd, args = [], opts = {}) => {
  globalThis.__HERDR_TEST_MOCK__.execCalls.push({ cmd, args, opts });
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout || 5000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
    };
  }
};

export function resetHerdrMock(overrides = {}) {
  const current = {
    appHome: "",
    spaces: [],
    panes: [],
    terminals: [],
    agents: [],
    focused: null,
    sharedData: {},
    execCalls: [],
    execImpl: defaultExec,
    ...overrides,
  };
  globalThis.__HERDR_TEST_MOCK__ = current;
  return current;
}

export function getHerdrMock() {
  if (!globalThis.__HERDR_TEST_MOCK__) {
    return resetHerdrMock();
  }
  return globalThis.__HERDR_TEST_MOCK__;
}

export function installHerdrHooks() {
  getHerdrMock();
  if (hooksInstalled) return;
  hooksInstalled = true;

  moduleApi.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "herdr" || specifier === "fs/promises") {
        return { shortCircuit: true, url: `mock:${specifier}` };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === "mock:herdr") {
        return {
          shortCircuit: true,
          format: "module",
          source: `
            const state = () => globalThis.__HERDR_TEST_MOCK__;
            export const spaces = () => state().spaces;
            export const panes = () => state().panes;
            export const terminals = () => state().terminals;
            export const agents = () => state().agents;
            export const focused = () => state().focused;
            export const exec = (...a) => state().execImpl(...a);
            export const appHome = () => state().appHome;
            export const shared = (k) => k ? state().sharedData[k] : state().sharedData;
            export const setShared = (k, v) => { state().sharedData[k] = v; };
          `,
        };
      }
      if (url === "mock:fs/promises") {
        return {
          shortCircuit: true,
          format: "module",
          source: `
            import * as realFs from "node:fs/promises";
            export * from "node:fs/promises";
            export async function exists(p) {
              try {
                await realFs.access(p);
                return true;
              } catch {
                return false;
              }
            }
          `,
        };
      }
      return nextLoad(url, context);
    },
  });
}

export async function createTempDir(prefix = "herdr-mesh-test-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanupTempDir(dirPath) {
  if (!dirPath) return;
  await fs.rm(dirPath, { recursive: true, force: true });
}
