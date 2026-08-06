import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeContext } from "../types";
import { PermanentError } from "../types";
import { getNodeDef } from "../registry";
import { DRY_RUN_SKIPPED_WRITES_KEY } from "../dryRun";
import { PLACEHOLDER_CODE } from "../codegen";

// 不能直接 import ./customCode——它經由 store→registry 又繞回自己(循環引用會在載入時炸掉)。
// 走 registry 拿定義，順便驗證它真的有註冊。
const customCodeNode = getNodeDef("custom-code")!;

/**
 * custom-code 是整個平台風險最高的節點(執行 AI 寫的程式碼)，這裡釘住它對外的行為合約——
 * 這些合約是後續把正式執行搬進沙箱時的安全網：搬完後這個檔案必須原封不動全綠。
 * workflowId 用不存在的 id，讓「讀磁碟最新版 code」的路徑安全地退回 ctx.config。
 */

function context(config: Record<string, unknown>, opts: { dryRun?: boolean; input?: Record<string, unknown> } = {}): NodeContext {
  return {
    runId: "test-run",
    workflowId: "zz-test-custom-code-不存在",
    nodeId: "step",
    input: opts.input ?? {},
    config,
    secrets: {},
    vars: {},
    model: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    headed: false,
    dryRun: opts.dryRun ?? false,
    outputDir: "/tmp",
    debugDir: "/tmp",
    session: {} as NodeContext["session"],
    cancelSignal: new AbortController().signal,
    log: () => {},
    registerFile: () => {},
  };
}

test("custom-code：正式執行跑程式碼，回傳物件的具名欄位交給下游", async () => {
  const result = await customCodeNode.execute(
    context({ intent: "把數字加倍", code: "return { ...ctx.input, 加倍後: ctx.input.數字 * 2 };" }, { input: { 數字: 21 } }),
  );
  assert.equal(result.output?.加倍後, 42);
  assert.equal(result.output?.數字, 21, "展開 ctx.input 的慣例要保留");
});

test("custom-code：回傳裸陣列一律報錯，不准變成 {0:…,1:…} 的索引鍵垃圾", async () => {
  await assert.rejects(
    customCodeNode.execute(context({ intent: "x", code: "return [1, 2, 3];" })),
    (err: unknown) => err instanceof PermanentError && /具名欄位/.test(err.message),
  );
});

test("custom-code：回傳純值(不是物件)時包成 { result }，不讓下游拿到 undefined", async () => {
  const result = await customCodeNode.execute(context({ intent: "x", code: "return 7;" }));
  assert.equal(result.output?.result, 7);
});

test("custom-code：語法錯誤要老實報 PermanentError(重跑不會變好)", async () => {
  await assert.rejects(
    customCodeNode.execute(context({ intent: "x", code: "return {{{ 不是合法的程式" })),
    (err: unknown) => err instanceof PermanentError && /語法/.test(err.message),
  );
});

test("custom-code：空殼＋沒有描述＝毫無意義，報錯而不是假成功", async () => {
  await assert.rejects(
    customCodeNode.execute(context({ intent: "", code: PLACEHOLDER_CODE })),
    (err: unknown) => err instanceof PermanentError && /還沒有內容/.test(err.message),
  );
});

test("custom-code：程式碼在正式執行拋錯時，原始錯誤要往外傳(修復迴圈的燃料)", async () => {
  await assert.rejects(
    customCodeNode.execute(context({ intent: "x", code: "throw new Error('boom-detail');" })),
    (err: unknown) => err instanceof Error && err.message.includes("boom-detail"),
  );
});

test("custom-code：只讀試跑遇到含外部操作的程式碼要攔下來，絕不真的執行", async () => {
  let executed = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => { executed = true; return new Response("{}"); }) as typeof fetch;
  try {
    const result = await customCodeNode.execute(
      context(
        { intent: "送出資料", code: "await fetch('https://example.invalid/submit', { method: 'POST' }); return { ok: true };" },
        { dryRun: true, input: { a: 1 } },
      ),
    );
    assert.equal(executed, false, "只讀試跑不能真的打出去");
    const skipped = result.output?.[DRY_RUN_SKIPPED_WRITES_KEY];
    assert.ok(Array.isArray(skipped) && skipped.length === 1, "要把被攔下的操作記進輸出，讓試跑報告看得到");
    assert.equal(result.output?.a, 1, "原輸入要原樣往下傳");
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* ── 正式執行沙箱(2026-08)：隔離要真的擋得住,保真要真的不變 ─────────────── */

function prodContext(code: string, opts: { input?: Record<string, unknown>; outputDir?: string } = {}) {
  const ctx = context({ intent: "測試", code }, { input: opts.input });
  if (opts.outputDir) (ctx as { outputDir: string }).outputDir = opts.outputDir;
  return ctx;
}

test("沙箱隔離：子程序拿不到平台行程的環境變數(模型金鑰絕不外流給 AI 寫的程式碼)", async () => {
  const prev = process.env.ZZ_TEST_SENSITIVE;
  process.env.ZZ_TEST_SENSITIVE = "super-secret";
  try {
    const result = await customCodeNode.execute(prodContext("return { seen: process.env.ZZ_TEST_SENSITIVE ?? '(拿不到)' };"));
    assert.equal(result.output?.seen, "(拿不到)");
  } finally {
    if (prev === undefined) delete process.env.ZZ_TEST_SENSITIVE;
    else process.env.ZZ_TEST_SENSITIVE = prev;
  }
});

test("沙箱保真：exceljs 在子程序能用,而且 Date 的 instanceof 不會被 realm 邊界弄壞", async () => {
  const os = await import("node:os");
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "cc-prod-"));
  try {
    // 真實 KPI 流程的縮影:exceljs 開活頁簿、放一個 Date 進儲存格、再讀回來
    const result = await customCodeNode.execute(prodContext(`
      const ExcelJS = (await import('exceljs')).default ?? await import('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('測試');
      ws.getCell('A1').value = new Date('2026-08-06T00:00:00Z');
      ws.getCell('B1').value = 42;
      const buffer = await wb.xlsx.writeBuffer();
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.load(buffer);
      const cell = wb2.getWorksheet('測試').getCell('A1').value;
      return { isDate: cell instanceof Date, year: cell instanceof Date ? cell.getUTCFullYear() : null, b1: wb2.getWorksheet('測試').getCell('B1').value };
    `, { outputDir: dir }));
    assert.equal(result.output?.isDate, true, "Date 過不了 instanceof = VM realm 問題,會弄壞真實的 Excel 程式碼");
    assert.equal(result.output?.year, 2026);
    assert.equal(result.output?.b1, 42);
  } finally {
    fsMod.rmSync(dir, { recursive: true, force: true });
  }
});

test("沙箱保真：fetch 在子程序照常運作(真實流程大量用 fetch 打 Apps Script)", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, msg: "來自本機伺服器" })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const result = await customCodeNode.execute(prodContext(`
      const resp = await fetch('http://127.0.0.1:${port}/');
      const data = await resp.json();
      return { status: resp.status, msg: data.msg };
    `));
    assert.equal(result.output?.status, 200);
    assert.equal(result.output?.msg, "來自本機伺服器");
  } finally {
    server.close();
  }
});

test("沙箱保真：程式碼裡的 console.log 不能弄壞結果通道(要變成執行紀錄)", async () => {
  const result = await customCodeNode.execute(prodContext("console.log('進度訊息', {a: 1}); return { done: true };"));
  assert.equal(result.output?.done, true);
});

test("沙箱隔離：寫檔只准寫進這次執行的產出目錄,寫別的地方要被 OS 權限擋下", async () => {
  const os = await import("node:os");
  const fsMod = await import("node:fs");
  const pathMod = await import("node:path");
  const { hasNodePermissionRuntime } = await import("../customCodeProcessSandbox");
  if (!hasNodePermissionRuntime()) return; // 舊 Node 沒有 --permission,這條防線在該環境本來就不存在
  const outDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "cc-out-"));
  const forbidden = pathMod.join(os.homedir(), `zz-test-should-not-exist-${Date.now()}.txt`);
  try {
    const ok = await customCodeNode.execute(prodContext(`
      const fs = await import('node:fs');
      fs.default.writeFileSync(ctx.outputDir + '/result.txt', '合法寫入');
      let blocked = false;
      try { fs.default.writeFileSync(${JSON.stringify(forbidden)}, '不該成功'); } catch { blocked = true; }
      return { blocked };
    `, { outputDir: outDir }));
    assert.equal(fsMod.readFileSync(pathMod.join(outDir, "result.txt"), "utf8"), "合法寫入", "產出目錄要寫得進去");
    assert.equal(ok.output?.blocked, true, "家目錄要被擋");
    assert.equal(fsMod.existsSync(forbidden), false);
  } finally {
    fsMod.rmSync(outDir, { recursive: true, force: true });
    fsMod.rmSync(forbidden, { force: true });
  }
});

test("確認凍結：排程觸發的執行遇到還沒產碼的節點要拒絕,不臨場產生沒人看過的程式碼", async () => {
  const { getDb } = await import("../../db");
  const runId = "zz-test-schedule-run";
  const db = getDb();
  try {
    db.prepare(`INSERT OR REPLACE INTO runs (id, workflow_id, status, trigger_type, started_at) VALUES (?, 'zz-test-wf', 'running', 'schedule', datetime('now'))`).run(runId);
    const ctx = context({ intent: "做點什麼", code: PLACEHOLDER_CODE });
    (ctx as { runId: string }).runId = runId;
    await assert.rejects(
      customCodeNode.execute(ctx),
      (err: unknown) => err instanceof PermanentError && /手動執行一次/.test(err.message),
    );
  } finally {
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);
  }
});
