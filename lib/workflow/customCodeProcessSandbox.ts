import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PermanentError, type NodeContext } from "./types";

const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_TEXT_RESULT = 200_000;
const SAFE_IMPORTS = new Set(["exceljs", "xlsx", "path", "node:path", "crypto", "node:crypto", "fs", "node:fs"]);

export interface ProcessSandboxResult {
  value: unknown;
  permissionMode: "os-permission" | "vm-fallback";
}

/** Node's permission flag is intentionally detected instead of assumed: older supported runtimes still get VM protection. */
export function hasNodePermissionRuntime(): boolean {
  return Boolean(process.allowedNodeEnvironmentFlags?.has("--permission"));
}

function collectReadableFiles(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    try {
      if (path.isAbsolute(value) && fs.existsSync(value) && fs.statSync(value).isFile()) out.add(path.resolve(value));
    } catch { /* an input value is only a candidate; the worker will fail honestly if it is unavailable */ }
  } else if (Array.isArray(value)) {
    for (const item of value) collectReadableFiles(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectReadableFiles(item, out);
  }
  return out;
}

function safeString(value: unknown, max = MAX_TEXT_RESULT): string {
  return String(value ?? "").slice(0, max);
}

function validateSelector(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) throw new PermanentError("只讀瀏覽器查詢的選擇器格式不正確");
  return value;
}

function validateIndex(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 10_000) throw new PermanentError("只讀瀏覽器查詢的項目位置不正確");
  return Number(value);
}

type BrowserLocator = { locator: (selector: string) => BrowserLocator; first: () => BrowserLocator; nth: (index: number) => BrowserLocator; count: () => Promise<number>; textContent: () => Promise<string | null>; innerText: () => Promise<string>; allTextContents: () => Promise<string[]>; getAttribute: (name: string) => Promise<string | null>; inputValue: () => Promise<string>; isVisible: () => Promise<boolean> };

/**
 * The child process never receives a Playwright object. It can only request a
 * small read-only browser operation, and the parent decides whether that
 * operation is allowed. No arbitrary page.evaluate or browser handle crosses
 * the process boundary.
 */
async function handleBrowserRpc(ctx: NodeContext, command: string, args: unknown[], locators: Map<string, BrowserLocator>): Promise<unknown> {
  if (command === "session.getPage") {
    await ctx.session.getPage();
    return true;
  }
  if (command === "session.currentPage") return Boolean(ctx.session.currentPage());
  if (command === "session.getBrowser") throw new PermanentError("只讀安全試跑禁止取得未受限的瀏覽器能力");
  const page = ctx.session.currentPage() ?? await ctx.session.getPage();
  if (command === "page.goto") {
    const url = typeof args[0] === "string" ? args[0] : "";
    if (!/^https?:\/\//i.test(url) || url.length > 4_000) throw new PermanentError("只讀瀏覽器只能開啟有效的外部網址");
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    return { ok: response?.ok() ?? false, status: response?.status() ?? 0, url: response?.url() ?? url };
  }
  if (command === "page.title") return safeString(await page.title());
  if (command === "page.url") return safeString(page.url(), 4_000);
  if (command === "page.content") return safeString(await page.content());
  if (command === "page.waitForSelector") {
    await page.waitForSelector(validateSelector(args[0]), { state: "attached", timeout: 15_000 });
    return true;
  }
  if (command === "page.locator") {
    const selector = validateSelector(args[0]);
    const id = `l${locators.size + 1}`;
    locators.set(id, page.locator(selector));
    return id;
  }
  if (command === "page.click" || command === "page.evaluate" || command === "locator.click" || command === "locator.fill") {
    throw new PermanentError("只讀安全試跑禁止瀏覽器操作或任意腳本");
  }
  if (command.startsWith("locator.")) {
    const id = typeof args[0] === "string" ? args[0] : "";
    const locator = locators.get(id);
    if (!locator) throw new PermanentError("找不到只讀瀏覽器查詢物件");
    const rest = args.slice(1);
    switch (command) {
      case "locator.locator": {
        const childId = `l${locators.size + 1}`;
        locators.set(childId, locator.locator(validateSelector(rest[0])));
        return childId;
      }
      case "locator.first": {
        const childId = `l${locators.size + 1}`;
        locators.set(childId, locator.first());
        return childId;
      }
      case "locator.nth": {
        const childId = `l${locators.size + 1}`;
        locators.set(childId, locator.nth(validateIndex(rest[0])));
        return childId;
      }
      case "locator.count": return locator.count();
      case "locator.textContent": return safeString(await locator.textContent());
      case "locator.innerText": return safeString(await locator.innerText());
      case "locator.allTextContents": return (await locator.allTextContents()).slice(0, 500).map((item: string) => safeString(item, 10_000));
      case "locator.getAttribute": return safeString(await locator.getAttribute(String(rest[0] ?? "")), 4_000);
      case "locator.inputValue": return safeString(await locator.inputValue());
      case "locator.isVisible": return locator.isVisible();
      default: throw new PermanentError(`只讀安全試跑不支援瀏覽器查詢「${command}」`);
    }
  }
  throw new PermanentError(`只讀安全試跑不支援瀏覽器操作「${command}」`);
}

const WORKER_SOURCE = String.raw`
const readline = require('node:readline');
const vm = require('node:vm');
const lines = readline.createInterface({ input: process.stdin });
let readyResolve;
const ready = new Promise((resolve) => { readyResolve = resolve; });
const pending = new Map();
let nextId = 1;
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
lines.on('line', (line) => {
  let value;
  try { value = JSON.parse(line); } catch { return; }
  if (value && value.type === 'response' && pending.has(value.id)) {
    const item = pending.get(value.id); pending.delete(value.id);
    if (value.ok) item.resolve(value.value); else item.reject(new Error(String(value.error || '只讀能力呼叫失敗')));
  } else if (value && value.type === 'start') readyResolve(value.payload);
});
function rpc(command, args) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++); pending.set(id, { resolve, reject }); send({ type: 'request', id, command, args });
  });
}
function callback(fn) {
  try { Object.defineProperty(fn, 'constructor', { value: undefined, configurable: false }); Object.defineProperty(fn, '__proto__', { value: undefined, configurable: false }); } catch {}
  return fn;
}
class Locator {
  constructor(id) { this.id = id; }
  locator(selector) { return new LocatorPromise(rpc('locator.locator', [this.id, selector])); }
  first() { return new LocatorPromise(rpc('locator.first', [this.id])); }
  nth(index) { return new LocatorPromise(rpc('locator.nth', [this.id, index])); }
  count() { return rpc('locator.count', [this.id]); }
  textContent() { return rpc('locator.textContent', [this.id]); }
  innerText() { return rpc('locator.innerText', [this.id]); }
  allTextContents() { return rpc('locator.allTextContents', [this.id]); }
  getAttribute(name) { return rpc('locator.getAttribute', [this.id, name]); }
  inputValue() { return rpc('locator.inputValue', [this.id]); }
  isVisible() { return rpc('locator.isVisible', [this.id]); }
  click() { return rpc('locator.click', [this.id]); }
  fill(value) { return rpc('locator.fill', [this.id, value]); }
}
class LocatorPromise {
  constructor(promise) { this.promise = promise; }
  then(resolve, reject) { return this.promise.then((id) => resolve(new Locator(id)), reject); }
  catch(reject) { return this.promise.catch(reject); }
  finally(fn) { return this.promise.finally(fn); }
  count() { return this.then((locator) => locator.count()); }
  textContent() { return this.then((locator) => locator.textContent()); }
  innerText() { return this.then((locator) => locator.innerText()); }
  allTextContents() { return this.then((locator) => locator.allTextContents()); }
  getAttribute(name) { return this.then((locator) => locator.getAttribute(name)); }
  inputValue() { return this.then((locator) => locator.inputValue()); }
  isVisible() { return this.then((locator) => locator.isVisible()); }
  click() { return this.then((locator) => locator.click()); }
  fill(value) { return this.then((locator) => locator.fill(value)); }
}
class Page {
  getPage() { return rpc('session.getPage', []); }
  goto(url) { return rpc('page.goto', [url]); }
  title() { return rpc('page.title', []); }
  url() { return rpc('page.url', []); }
  content() { return rpc('page.content', []); }
  waitForSelector(selector) { return rpc('page.waitForSelector', [selector]); }
  locator(selector) { return new LocatorPromise(rpc('page.locator', [selector])); }
  click() { return rpc('page.click', []); }
  evaluate(fn) { return rpc('page.evaluate', [String(fn)]); }
}
async function main() {
  const payload = await ready;
  const safeImport = callback(async (specifier) => { if (!${JSON.stringify([...SAFE_IMPORTS])}.includes(specifier)) throw new Error('不允許的模組'); return import(specifier); });
  const page = new Page();
  const ctx = Object.assign(Object.create(null), payload.ctx, {
    input: Object.assign(Object.create(null), payload.ctx.input || {}),
    config: Object.assign(Object.create(null), payload.ctx.config || {}),
    secrets: Object.assign(Object.create(null), payload.ctx.secrets || {}),
    vars: Object.assign(Object.create(null), payload.ctx.vars || {}),
    cancelSignal: Object.freeze({ aborted: false }),
    log: callback((message) => send({ type: 'log', message: String(message) })),
    session: Object.assign(Object.create(null), {
      getPage: callback(async () => { await rpc('session.getPage', []); return page; }),
      currentPage: callback(() => page),
      getBrowser: callback(async () => { throw new Error('只讀安全試跑禁止取得未受限的瀏覽器能力'); }),
    }),
    registerFile: callback(() => { throw new Error('只讀安全試跑禁止寫入或登記產出檔案'); }),
  });
  const context = vm.createContext({ __agentHubSafeImport: safeImport }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('Object.defineProperty(globalThis, "constructor", {value:undefined, configurable:false}); for (const p of [Object.prototype, Function.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype, RegExp.prototype, Date.prototype, Promise.prototype]) { try { Object.defineProperty(p, "constructor", {value:undefined, configurable:false}); } catch {} }', context);
  const code = String(payload.code || '').replace(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g, '__agentHubSafeImport("$2")');
  if (/\bimport\s*\(/.test(code)) throw new Error('只讀安全試跑無法確認動態載入來源');
  const script = new vm.Script('(async (ctx) => {\n' + code + '\n})', { filename: 'agent-hub-custom-code-worker.mjs' });
  const fn = script.runInContext(context);
  const result = await fn(ctx);
  send({ type: 'result', value: result });
}
ready.then(() => main().catch((error) => send({ type: 'error', error: error && error.message ? error.message : String(error) }))).catch((error) => send({ type: 'error', error: String(error) }));
`;

export async function executeCustomCodeInProcessSandbox(ctx: NodeContext, code: string): Promise<ProcessSandboxResult> {
  const permission = hasNodePermissionRuntime();
  const args = permission ? ["--permission", `--allow-fs-read=${path.join(process.cwd(), "node_modules")}`, ...[...collectReadableFiles(ctx.input)].map((file) => `--allow-fs-read=${file}`), "-e", WORKER_SOURCE] : ["-e", WORKER_SOURCE];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    // Never inherit the parent environment: it may contain AGENT_HUB_API_KEY or
    // provider credentials. The worker only needs PATH for Node's own startup.
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" } as unknown as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let stderr = "";
  let stdoutBuffer = "";
  let resultResolve: ((result: ProcessSandboxResult) => void) | null = null;
  let resultReject: ((error: Error) => void) | null = null;
  const done = new Promise<ProcessSandboxResult>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  const locators = new Map<string, BrowserLocator>();
  const writeResponse = (id: string, ok: boolean, value?: unknown, error?: unknown) => child.stdin.write(JSON.stringify({ type: "response", id, ok, value, error: error instanceof Error ? error.message : error }) + "\n");
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(stdoutBuffer) > MAX_MESSAGE_BYTES * 2) { resultReject?.(new Error("只讀安全子程序回傳過大")); child.kill("SIGKILL"); return; }
    const lines = stdoutBuffer.split("\n"); stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: { type?: string; id?: unknown; command?: unknown; args?: unknown; value?: unknown; error?: unknown; message?: unknown };
      try { message = JSON.parse(line); } catch { resultReject?.(new Error("只讀安全子程序回傳格式錯誤")); child.kill("SIGKILL"); continue; }
      if (message.type === "request") {
        void handleBrowserRpc(ctx, String(message.command), Array.isArray(message.args) ? message.args : [], locators)
          .then((value) => writeResponse(String(message.id), true, value))
          .catch((error) => writeResponse(String(message.id), false, undefined, error));
      } else if (message.type === "log") ctx.log(safeString(message.message, 2_000));
      else if (message.type === "result") { resultResolve?.({ value: message.value, permissionMode: permission ? "os-permission" : "vm-fallback" }); child.kill(); }
      else if (message.type === "error") { resultReject?.(new Error(safeString(message.error, 8_000))); child.kill(); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8_000); });
  child.on("error", (error) => resultReject?.(error));
  child.on("close", (code) => {
    if (resultResolve || resultReject) {
      if (code !== 0 && code !== null) resultReject?.(new Error(stderr || `只讀安全子程序結束(${code})`));
    }
  });
  const abort = () => { child.kill("SIGKILL"); resultReject?.(new Error("只讀安全試跑已停止")); };
  if (ctx.cancelSignal.aborted) abort(); else ctx.cancelSignal.addEventListener("abort", abort, { once: true });
  const payload = {
    code,
    ctx: {
      runId: ctx.runId, workflowId: ctx.workflowId, nodeId: ctx.nodeId, input: ctx.input, config: ctx.config,
      secrets: ctx.secrets, vars: ctx.vars, model: ctx.model, baseUrl: ctx.baseUrl, headed: false,
      outputDir: ctx.outputDir, debugDir: ctx.debugDir, dryRun: true,
    },
  };
  child.stdin.write(JSON.stringify({ type: "start", payload }) + "\n");
  try { return await done; } finally { ctx.cancelSignal.removeEventListener("abort", abort); if (!child.killed) child.kill(); }
}
