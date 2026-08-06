import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deserialize as v8deserialize } from "node:v8";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PermanentError, type NodeContext } from "./types";

const MAX_MESSAGE_BYTES = 512 * 1024;
/** 正式執行的結果可以是整份 Excel 算出來的資料，上限要夠大——太小會把「成功算完」截斷成假失敗。 */
const MAX_MESSAGE_BYTES_PRODUCTION = 8 * 1024 * 1024;
const MAX_TEXT_RESULT = 200_000;
const SAFE_IMPORTS = new Set(["exceljs", "xlsx", "path", "node:path", "crypto", "node:crypto", "fs", "node:fs"]);

export type SandboxMode = "dry-run" | "production";

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

/**
 * 正式模式的讀取白名單比只讀試跑寬:除了檔案本身,也放行 input/config 引用的**目錄**
 * (整個目錄遞迴可讀)與被引用檔案的**所在目錄**。code review 抓到只白名單檔案的回歸:
 * 既有節點 config 寫 { folder: "/某/資料夾" }、程式碼 readdirSync(folder) 再逐檔讀——
 * 目錄不是 isFile,永遠進不了白名單,原本能跑的純計算流程沙箱化後每次排程都掛。
 */
function collectReadablePaths(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    try {
      if (path.isAbsolute(value) && fs.existsSync(value)) {
        const resolved = path.resolve(value);
        if (fs.statSync(resolved).isDirectory()) out.add(resolved);
        else { out.add(resolved); out.add(path.dirname(resolved)); }
      }
    } catch { /* 同上:候選而已 */ }
  } else if (Array.isArray(value)) {
    for (const item of value) collectReadablePaths(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectReadablePaths(item, out);
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
async function handleBrowserRpc(ctx: NodeContext, command: string, args: unknown[], locators: Map<string, BrowserLocator>, mode: SandboxMode): Promise<unknown> {
  if (command === "registerFile") {
    // 正式執行的程式碼可以登記產出檔——但只轉發呼叫,不給子程序任何檔案系統之外的能力
    if (mode !== "production") throw new PermanentError("只讀安全試跑禁止寫入或登記產出檔案");
    const [name, filePath, mime, kind] = args;
    ctx.registerFile(safeString(name, 200), safeString(filePath, 2_000), safeString(mime, 200), kind === "output" ? "output" : "intermediate");
    return true;
  }
  if (mode === "production") {
    // 正式沙箱刻意不含瀏覽器：RPC 代理的 Page 跟真的 Playwright Page 保真度賭不起。
    // 用到 ctx.session 的程式碼由 customCode.ts 判斷後改走主行程,不會到這裡。
    throw new PermanentError("沙箱執行不提供瀏覽器能力——這段程式碼用到了 ctx.session,應由平台自動改走主行程(若看到這個錯誤,代表判斷邏輯漏了,請回報)");
  }
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
const util = require('node:util');
const lines = readline.createInterface({ input: process.stdin });
// 程式碼裡的 console.log 一定要改走訊息通道——直接印到 stdout 會插進 JSON 協定裡,
// 家長行程會把整個執行當成「回傳格式錯誤」殺掉(而且看起來像隨機失敗)。
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => { try { process.stdout.write(JSON.stringify({ type: 'log', message: util.format(...args).slice(0, 2000) }) + '\n'); } catch {} };
}
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
    // 正式模式給真的 AbortSignal(程式碼可能把它塞給 fetch,假物件會讓 fetch 直接 TypeError)。
    // 實際取消由家長行程 kill 子程序完成,這個 signal 不需要真的觸發。
    cancelSignal: payload.mode === 'production' ? new AbortController().signal : Object.freeze({ aborted: false }),
    log: callback((message) => send({ type: 'log', message: String(message) })),
    session: Object.assign(Object.create(null), {
      getPage: callback(async () => { await rpc('session.getPage', []); return page; }),
      currentPage: callback(() => page),
      getBrowser: callback(async () => { throw new Error('只讀安全試跑禁止取得未受限的瀏覽器能力'); }),
    }),
    registerFile: callback((name, filePath, mime, kind) => {
      if (payload.mode === 'production') return rpc('registerFile', [name, filePath, mime, kind]);
      throw new Error('只讀安全試跑禁止寫入或登記產出檔案');
    }),
  });
  if (payload.mode === 'production') {
    // 正式執行：在子程序的**主 realm** 直接執行,不進 VM——VM 是另一個 JS realm,
    // 裡面 new 出來的 Date 過不了主 realm 函式庫(exceljs 等)的 instanceof 檢查,
    // 而且 fetch/console/Buffer 都不在 VM context 裡,真實程式碼會莫名壞掉。
    // 正式模式的隔離靠的是行程邊界：環境變數已清洗、OS 權限白名單擋住檔案系統與子程序。
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction('ctx', String(payload.code || ''));
    const result = await fn(ctx);
    // 回傳值走 v8 結構化序列化,不走 JSON——JSON 會把 Map 變 {}(資料默默消失但流程全綠)、
    // Date 變字串、Buffer 變 {type:'Buffer'},下游原本拿到活物件的行為就變了。
    // v8.serialize 保留這些型別;真的序列化不了(函式等)才退回 JSON(跟持久化層的行為一致)。
    try {
      const v8mod = require('node:v8');
      send({ type: 'result', v8: v8mod.serialize(result).toString('base64') });
    } catch {
      send({ type: 'result', value: result });
    }
    return;
  }
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

export async function executeCustomCodeInProcessSandbox(
  ctx: NodeContext,
  code: string,
  opts: { mode?: SandboxMode } = {},
): Promise<ProcessSandboxResult> {
  const mode: SandboxMode = opts.mode ?? "dry-run";
  const permission = hasNodePermissionRuntime();
  const maxMessageBytes = mode === "production" ? MAX_MESSAGE_BYTES_PRODUCTION : MAX_MESSAGE_BYTES;
  // 正式執行比只讀試跑多的權限：可讀 config 引用的檔案與這次 run 的產出/除錯目錄,
  // 可寫產出/除錯目錄與 OS 暫存目錄。就這些——parent 的環境變數、其他目錄、子程序一律拿不到。
  const readable = mode === "production"
    ? collectReadablePaths(ctx.config, collectReadablePaths(ctx.input))
    : collectReadableFiles(ctx.input);
  const fsArgs = [
    `--allow-fs-read=${path.join(process.cwd(), "node_modules")}`,
    ...[...readable].map((file) => `--allow-fs-read=${file}`),
    ...(mode === "production"
      ? [
        `--allow-fs-read=${ctx.outputDir}`, `--allow-fs-read=${ctx.debugDir}`, `--allow-fs-read=${os.tmpdir()}`,
        `--allow-fs-write=${ctx.outputDir}`, `--allow-fs-write=${ctx.debugDir}`, `--allow-fs-write=${os.tmpdir()}`,
      ]
      : []),
  ];
  const args = permission ? ["--permission", ...fsArgs, "-e", WORKER_SOURCE] : ["-e", WORKER_SOURCE];
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
  // Promise 本身重複 settle 沒事,但 close 事件需要知道「還沒有結果」——不能只看 exit code
  // (code review 抓到:程式碼呼叫 process.exit(0) 會乾淨退出且永遠沒有 result 訊息,
  // done 懸著直到節點 90 秒逾時,錯誤訊息還誤導成「執行太久」)。
  let settled = false;
  const settleResolve = (result: ProcessSandboxResult) => { settled = true; resultResolve?.(result); };
  const settleReject = (error: Error) => { settled = true; resultReject?.(error); };
  const locators = new Map<string, BrowserLocator>();
  const writeResponse = (id: string, ok: boolean, value?: unknown, error?: unknown) => child.stdin.write(JSON.stringify({ type: "response", id, ok, value, error: error instanceof Error ? error.message : error }) + "\n");
  const decodeResult = (message: { v8?: unknown; value?: unknown }): unknown => {
    if (typeof message.v8 === "string") {
      // v8 結構化序列化(保留 Date/Map/Buffer;見 worker 端註解);同一顆 Node 執行檔,格式必然相容
      return v8deserialize(Buffer.from(message.v8, "base64"));
    }
    return message.value;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(stdoutBuffer) > maxMessageBytes * 2) { settleReject(new Error("自訂程式碼子程序回傳過大")); child.kill("SIGKILL"); return; }
    const lines = stdoutBuffer.split("\n"); stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: { type?: string; id?: unknown; command?: unknown; args?: unknown; value?: unknown; v8?: unknown; error?: unknown; message?: unknown };
      try { message = JSON.parse(line); } catch { settleReject(new Error("只讀安全子程序回傳格式錯誤")); child.kill("SIGKILL"); continue; }
      if (message.type === "request") {
        void handleBrowserRpc(ctx, String(message.command), Array.isArray(message.args) ? message.args : [], locators, mode)
          .then((value) => writeResponse(String(message.id), true, value))
          .catch((error) => writeResponse(String(message.id), false, undefined, error));
      } else if (message.type === "log") ctx.log(safeString(message.message, 2_000));
      else if (message.type === "result") {
        try {
          settleResolve({ value: decodeResult(message), permissionMode: permission ? "os-permission" : "vm-fallback" });
        } catch (err) {
          settleReject(new Error(`自訂程式碼的回傳結果解讀失敗：${err instanceof Error ? err.message : err}`));
        }
        child.kill();
      } else if (message.type === "error") { settleReject(new Error(safeString(message.error, 8_000))); child.kill(); }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8_000); });
  child.on("error", (error) => settleReject(error));
  child.on("close", (code) => {
    if (settled) return;
    if (code !== 0 && code !== null) settleReject(new Error(stderr || `只讀安全子程序結束(${code})`));
    else settleReject(new Error("自訂程式碼的子程序結束了卻沒有回傳結果——多半是程式碼呼叫了 process.exit()。請把結束方式改成 return { ...ctx.input, 結果欄位: 值 }"));
  });
  const abort = () => { child.kill("SIGKILL"); settleReject(new Error("只讀安全試跑已停止")); };
  if (ctx.cancelSignal.aborted) abort(); else ctx.cancelSignal.addEventListener("abort", abort, { once: true });
  const payload = {
    code,
    mode,
    ctx: {
      runId: ctx.runId, workflowId: ctx.workflowId, nodeId: ctx.nodeId, input: ctx.input, config: ctx.config,
      secrets: ctx.secrets, vars: ctx.vars, model: ctx.model, baseUrl: ctx.baseUrl, headed: false,
      outputDir: ctx.outputDir, debugDir: ctx.debugDir, dryRun: mode !== "production",
    },
  };
  child.stdin.write(JSON.stringify({ type: "start", payload }) + "\n");
  try { return await done; } finally { ctx.cancelSignal.removeEventListener("abort", abort); if (!child.killed) child.kill(); }
}
