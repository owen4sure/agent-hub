import { test } from "node:test";
import assert from "node:assert/strict";
// 刻意透過 registry 取節點，不直接 import "./repeatSteps"：registry 的節點清單 import 這個檔案，
// 直接載入本檔會形成 repeatSteps → store → … → registry → repeatSteps 的初始化循環而 TDZ 炸掉
// (repeatSteps.ts 檔頭已經寫明這個雷，這支測試自己踩過一次)。
import { getNodeDef } from "../registry";
import { PermanentError } from "../types";
import { MAX_REPEAT_STEPS_NESTING } from "../repeatNesting";
import { getDb } from "../../db";

const repeatStepsNode = getNodeDef("repeat-steps")!;

/**
 * 執行器是最後一道防線。lintGraph 已經在 engine 的執行入口(assertRunnableGraph)擋過超深巢狀，
 * 但那道閘門只保護「走正常執行入口」的圖；舊資料、匯入、未來新增的執行入口都可能繞過它。
 * repeat-steps 自己會遞迴呼叫內嵌步驟的 execute()，所以巢狀迴圈在執行期是真的會跑的——這個節點
 * 必須在**任何副作用之前**先確認自己的深度合法，否則整個深度政策在執行期形同不存在(P0)。
 *
 * 這裡直接呼叫真正的 execute()(不是重新描述邏輯)，並用「fetch 有沒有被打」這個外部可觀察的事實
 * 驗證「throw 發生在副作用之前」：最內層放 telegram-notify(會打 fetch)，若守衛失效或位置被搬到
 * 迴圈開始之後，fetch 就會被呼叫、這個測試會失敗。
 */

function ctxAt(repeatDepth: number, steps: unknown[], runId = "test-run-repeat-nesting", nodeId = "loop") {
  return {
    runId,
    workflowId: "test-wf-repeat-nesting",
    nodeId,
    input: {},
    config: { items: JSON.stringify([{ label: "第一項" }]), itemVar: "item", outputKey: "results", steps: JSON.stringify(steps) },
    secrets: { telegramBotToken: "fake", telegramChatId: "fake" },
    vars: {},
    model: "test",
    baseUrl: "",
    apiKey: "",
    headed: false,
    outputDir: "",
    debugDir: "",
    repeatDepth,
    cancelSignal: new AbortController().signal,
    log: () => {},
    registerFile: () => {},
  } as never;
}

test("repeat-steps 執行期閘門：超過巢狀上限時在任何副作用之前就 PermanentError，並帶得出位置", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("超限的巢狀迴圈不該真的執行任何步驟");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => repeatStepsNode.execute(ctxAt(MAX_REPEAT_STEPS_NESTING, [{ type: "telegram-notify", label: "通知", config: { text: "x" } }])),
      (err: unknown) => {
        assert.ok(err instanceof PermanentError, "要用 PermanentError：結構問題重試幾次都不會變好，不該讓引擎白重試");
        assert.match((err as Error).message, /巢狀層數超過上限/);
        assert.match((err as Error).message, /loop/, "訊息要指得出是哪個節點");
        return true;
      },
    );
    assert.equal(fetchCalled, false, "守衛必須在任何步驟真的執行之前就擋下來");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repeat-steps 執行期閘門：合法深度不得被誤擋(既有一、二層流程照常執行)", async () => {
  // 只驗「有沒有被深度守衛擋下」：用一個不會有副作用的步驟，深度守衛過關後才會走到後面的設定檢查。
  for (let depth = 0; depth < MAX_REPEAT_STEPS_NESTING; depth++) {
    let threw: unknown = null;
    try {
      await repeatStepsNode.execute(ctxAt(depth, [{ type: "set-variable", label: "設值", config: { name: "a", value: "1" } }]));
    } catch (err) { threw = err; }
    const message = threw instanceof Error ? threw.message : "";
    assert.equal(/巢狀層數超過上限/.test(message), false, `depth=${depth} 是合法深度，不該被深度守衛擋下(實際錯誤：${message})`);
  }
});

test("repeat-steps 批次檢查點：第二次嘗試只沿用已完成項目，不重做整批", async () => {
  type ResultRow = Record<string, unknown>;
  const runId = "test-run-repeat-checkpoint";
  const nodeId = "loop-checkpoint";
  const db = getDb();
  db.prepare("DELETE FROM repeat_item_checkpoints WHERE run_id=?").run(runId);
  const lines: string[] = [];
  const context = ctxAt(0, [{ type: "template-text", label: "組字串", config: { template: "{{item.label}}", outputKey: "text" } }], runId, nodeId) as unknown as {
    config: Record<string, unknown>;
    log: (line: string) => void;
  };
  context.config.items = JSON.stringify([{ label: "第一項" }, { label: "第二項" }, { label: "第三項" }]);
  context.log = (line: string) => lines.push(line);
  try {
    const first = await repeatStepsNode.execute(context as never);
    assert.deepEqual((first.output.results as ResultRow[]).map((row) => row.text), ["第一項", "第二項", "第三項"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM repeat_item_checkpoints WHERE run_id=? AND status='success'").get(runId) as { n: number }).n, 3);
    const stored = db.prepare("SELECT output_json FROM repeat_item_checkpoints WHERE run_id=? LIMIT 1").get(runId) as { output_json: string };
    assert.ok(stored.output_json?.startsWith("agent-hub:v1:"), "批次輸出必須加密保存");

    lines.length = 0;
    const second = await repeatStepsNode.execute(context as never);
    assert.deepEqual((second.output.results as ResultRow[]).map((row) => row.text), ["第一項", "第二項", "第三項"]);
    assert.equal(lines.filter((line) => line.includes("沿用檢查點，不重做")).length, 3);
  } finally {
    db.prepare("DELETE FROM repeat_item_checkpoints WHERE run_id=?").run(runId);
  }
});
