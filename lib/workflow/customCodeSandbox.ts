import vm from "node:vm";
import { PermanentError, type NodeContext, type RunSession } from "./types";

/**
 * The static dry-run scanner is useful as an early, explainable warning, but it
 * is not a security boundary: code can hide a capability behind an alias or a
 * computed property.  This module is the second boundary for custom-code.
 *
 * A dry-run gets a separate VM global (no process/require/fetch) and a
 * capability-limited view of the run context.  The normal execution path does
 * not use this helper, because a real run is explicitly allowed to perform the
 * configured side effects after the user's confirmation.
 */

const SAFE_IMPORTS = new Set([
  "exceljs",
  "xlsx",
  "path",
  "node:path",
  "crypto",
  "node:crypto",
  "fs",
  "node:fs",
]);

const BLOCKED_PAGE_METHODS = new Set([
  "click", "dblclick", "fill", "press", "pressSequentially", "type", "clear",
  "check", "uncheck", "setChecked", "selectOption", "setInputFiles", "dragTo",
  "dragAndDrop", "dispatchEvent", "focus", "hover", "tap", "context", "submit",
  "requestSubmit", "evaluate", "$eval", "$$eval", "evaluateAll", "setContent",
  "route", "unroute", "addInitScript", "exposeFunction", "exposeBinding",
  "newPage", "request", "close", "screenshot",
]);

const blockedCapability = (capability: string): never => {
  throw new PermanentError(`只讀安全試跑禁止${capability}；這次不會修改資料或操作外部畫面`);
};

function isObject(value: unknown): value is object {
  return !!value && (typeof value === "object" || typeof value === "function");
}

function safeCallable<T extends (...args: never[]) => unknown>(fn: T): T {
  // A callback is still useful as a capability, but must not expose the host
  // Function constructor through `callback.constructor.constructor(...)`.
  try {
    Object.defineProperty(fn, "constructor", { value: undefined, configurable: false });
    Object.defineProperty(fn, "__proto__", { value: undefined, configurable: false });
  } catch { /* best effort; VM prelude also removes intrinsic constructors */ }
  return fn;
}

/** Wrap Playwright objects recursively so an alias cannot recover a mutating method. */
function readOnlyProxy<T>(value: T, cache = new WeakMap<object, unknown>()): T {
  if (!isObject(value)) return value;
  const existing = cache.get(value);
  if (existing) return existing as T;
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      if (typeof property === "string" && BLOCKED_PAGE_METHODS.has(property)) {
        return () => blockedCapability(`瀏覽器操作「${property}」`);
      }
      if (property === "getBrowser" || property === "browser" || property === "context") {
        return () => blockedCapability("取得未受限的瀏覽器能力");
      }
      if (property === "constructor" || property === "__proto__") return undefined;
      const result = Reflect.get(target, property, receiver);
      if (typeof result !== "function") return isObject(result) ? readOnlyProxy(result, cache) : result;
      return safeCallable((...args: unknown[]) => {
        const returned = Reflect.apply(result, target, args);
        return returned && typeof (returned as Promise<unknown>).then === "function"
          ? (returned as Promise<unknown>).then((item) => isObject(item) ? readOnlyProxy(item, cache) : item)
          : isObject(returned) ? readOnlyProxy(returned, cache) : returned;
      });
    },
  });
  cache.set(value, proxy);
  return proxy as T;
}

function readOnlySession(session: RunSession): RunSession {
  return Object.assign(Object.create(null) as RunSession, {
    getPage: safeCallable(async () => readOnlyProxy(await session.getPage())),
    getBrowser: safeCallable(async () => blockedCapability("取得未受限的瀏覽器能力")),
    currentPage: safeCallable(() => {
      const page = session.currentPage();
      return page ? readOnlyProxy(page) : null;
    }),
    close: safeCallable(async () => blockedCapability("關閉瀏覽器工作階段")),
    resetPage: safeCallable(async () => blockedCapability("重設瀏覽器工作階段")),
    saveState: safeCallable(async () => blockedCapability("保存登入狀態")),
  });
}

function clonePlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value && typeof value === "object") {
    return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clonePlain(item)])));
  }
  return value;
}

function sandboxContext(ctx: NodeContext): Record<string, unknown> {
  const safeContext = Object.assign(Object.create(null), {
    runId: ctx.runId,
    workflowId: ctx.workflowId,
    nodeId: ctx.nodeId,
    input: Object.freeze(clonePlain(ctx.input) as Record<string, unknown>),
    config: Object.freeze(clonePlain(ctx.config) as Record<string, unknown>),
    secrets: Object.freeze(clonePlain(ctx.secrets) as Record<string, string>),
    vars: Object.freeze(clonePlain(ctx.vars) as Record<string, unknown>),
    model: ctx.model,
    baseUrl: ctx.baseUrl,
    headed: ctx.headed,
    outputDir: ctx.outputDir,
    debugDir: ctx.debugDir,
    dryRun: true,
    cancelSignal: Object.freeze({ aborted: ctx.cancelSignal.aborted }),
    log: safeCallable((message: string) => ctx.log(String(message))),
    session: readOnlySession(ctx.session),
    registerFile: safeCallable(() => blockedCapability("寫入或登記產出檔案")),
  }) satisfies Record<string, unknown>;
  return Object.freeze(safeContext);
}

/** Values crossing the VM boundary need host-realm prototypes before the engine serializes them. */
function normalizeVmValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeVmValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeVmValue(item)]));
  }
  return value;
}

function rewriteSafeImports(code: string): string {
  const literalImport = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;
  const rewritten = code.replace(literalImport, (_match, _quote: string, specifier: string) => `__agentHubSafeImport(${JSON.stringify(specifier)})`);
  // A dynamic import which was not a simple allow-listed literal would need a
  // loader with host capabilities.  Reject it instead of letting it escape the VM.
  if (/\bimport\s*\(/.test(rewritten)) {
    throw new PermanentError("只讀安全試跑無法確認自訂程式的動態載入來源；這次已停止，不會執行它");
  }
  return rewritten;
}

export async function executeCustomCodeInDryRun(ctx: NodeContext, code: string): Promise<unknown> {
  const rewritten = rewriteSafeImports(code);
  const vmGlobal = vm.createContext({
    __agentHubSafeImport: safeCallable(async (specifier: string) => {
      if (!SAFE_IMPORTS.has(specifier)) throw new PermanentError(`只讀安全試跑禁止載入「${specifier}」；這次不會執行它`);
      return import(specifier);
    }),
  }, { codeGeneration: { strings: false, wasm: false } });
  // Remove the common VM escape through host Function constructors.  The
  // sandbox deliberately exposes no host classes or globals beyond the import
  // capability above; ordinary literals and built-in collection methods remain
  // available inside the VM.
  vm.runInContext(`
    Object.defineProperty(globalThis, "constructor", { value: undefined, configurable: false });
    for (const prototype of [Object.prototype, Function.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype, RegExp.prototype, Date.prototype, Promise.prototype]) {
      try { Object.defineProperty(prototype, "constructor", { value: undefined, configurable: false }); } catch {}
    }
  `, vmGlobal);
  const script = new vm.Script(`(async (ctx) => {\n${rewritten}\n})`, { filename: `agent-hub-dry-run-${ctx.nodeId}.mjs` });
  const fn = script.runInContext(vmGlobal) as (safeContext: Record<string, unknown>) => Promise<unknown>;
  return Promise.resolve(fn(sandboxContext(ctx))).then(normalizeVmValue);
}
