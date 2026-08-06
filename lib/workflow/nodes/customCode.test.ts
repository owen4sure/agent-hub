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
