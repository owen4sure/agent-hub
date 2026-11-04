import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSubRunOutput } from "./subWorkflow";
import { getDb } from "../../db";

/**
 * 真實踩過的 bug：測「子流程重用」情境時，共用子流程最後一步是 desktop-notify，它自己的
 * result.output 只有 {notified:true}；前一步 custom-code 算好的 formattedMessage 完全沒有接回
 * 呼叫端的母流程——母流程以為呼叫子流程後會拿到格式化好的文字，實際上什麼都沒有。
 * 根因：舊版只讀子流程「最後一個成功節點」的 output_json，但 node_runs.output_json 存的是
 * 「這個節點自己新增的欄位」，不是 engine.ts 記憶體內 nodeOutputs 那份「輸入+新增欄位」的合併值
 * (兩者刻意不同，見 collectSubRunOutput 的說明)。這裡直接操作真實 DB 插入模擬的 node_runs，
 * 不是重新描述邏輯——用真正的 SQL 讀回來驗證。
 */

const TEST_RUN_ID = "test-run-subworkflow-collect-output";

function insertNodeRun(nodeId: string, status: string, output: Record<string, unknown> | null) {
  getDb()
    .prepare(`INSERT INTO node_runs (run_id, node_id, status, output_json, started_at, finished_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .run(TEST_RUN_ID, nodeId, status, output ? JSON.stringify(output) : null);
}

test("collectSubRunOutput：子流程最後一步自己沒有 spread input 時，仍要接回前面步驟算出的欄位", () => {
  getDb().prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(TEST_RUN_ID);
  try {
    // 模擬：trigger(輸入) → fmt(算出 formattedMessage，只回自己新增的欄位，不含 reportTitle) → notify(只回 notified)
    insertNodeRun("trigger", "success", { reportTitle: "【週業績彙整】", contentList: "台北店：128000 元" });
    insertNodeRun("fmt", "success", { formattedMessage: "[V2]【週業績彙整】\n台北店：128000 元" });
    insertNodeRun("notify", "success", { notified: true });

    const out = collectSubRunOutput(TEST_RUN_ID);
    assert.equal(out.reportTitle, "【週業績彙整】", "trigger 的輸入欄位要保留");
    assert.equal(out.formattedMessage, "[V2]【週業績彙整】\n台北店：128000 元", "中間步驟算出的欄位不能在接回母流程的路上不見");
    assert.equal(out.notified, true, "最後一步自己新增的欄位也要在");
  } finally {
    getDb().prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(TEST_RUN_ID);
  }
});

test("collectSubRunOutput：後面節點的欄位覆蓋前面同名欄位，跟 engine.ts 記憶體內合併順序一致", () => {
  getDb().prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(TEST_RUN_ID);
  try {
    insertNodeRun("trigger", "success", { status: "pending" });
    insertNodeRun("step2", "success", { status: "done" });
    assert.equal(collectSubRunOutput(TEST_RUN_ID).status, "done");
  } finally {
    getDb().prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(TEST_RUN_ID);
  }
});

test("collectSubRunOutput：失敗/跳過的節點與壞掉的 JSON 不能污染結果", () => {
  getDb().prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(TEST_RUN_ID);
  try {
    insertNodeRun("trigger", "success", { a: 1 });
    insertNodeRun("failedStep", "failed", { shouldNotAppear: true });
    getDb()
      .prepare(`INSERT INTO node_runs (run_id, node_id, status, output_json, started_at, finished_at) VALUES (?, ?, 'success', ?, datetime('now'), datetime('now'))`)
      .run(TEST_RUN_ID, "brokenJson", "{not valid json");
    insertNodeRun("finalStep", "success", { b: 2 });

    const out = collectSubRunOutput(TEST_RUN_ID);
    assert.deepEqual(out, { a: 1, b: 2 });
  } finally {
    getDb().prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(TEST_RUN_ID);
  }
});
