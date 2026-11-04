import test from "node:test";
import assert from "node:assert/strict";
import { getAttemptState, getCompletedAction, idempotencyKey, markAttemptStarted, recordCompletedAction } from "./idempotency";
import { getDb } from "../db";

test("idempotencyKey：同一個 run 對同一個節點永遠算同一把 key，不同 run 或不同節點各自獨立", () => {
  assert.equal(idempotencyKey({ runId: "run1", nodeId: "n1" }), "run1:n1");
  assert.notEqual(idempotencyKey({ runId: "run1", nodeId: "n1" }), idempotencyKey({ runId: "run2", nodeId: "n1" }));
  assert.notEqual(idempotencyKey({ runId: "run1", nodeId: "n1" }), idempotencyKey({ runId: "run1", nodeId: "n2" }));
  // repeat-steps 內嵌步驟的 nodeId 本身已經帶著迭代序號(見 repeatSteps.ts 的 `${nodeId}-i${i}-s${j}`)，
  // 天然讓每一輪迴圈都有自己獨立的 key，不會被誤判成同一個動作。
  assert.notEqual(idempotencyKey({ runId: "run1", nodeId: "loop1-i0-s0" }), idempotencyKey({ runId: "run1", nodeId: "loop1-i1-s0" }));
});

test("getCompletedAction／recordCompletedAction：沒記錄過回 null；記錄後能讀回同樣的輸出", () => {
  const key = `test-idem-${Date.now()}`;
  try {
    assert.equal(getCompletedAction(key), null, "還沒真的執行成功過，不該有記錄");
    const output = { sent: true, sentTo: "a@b.com" };
    recordCompletedAction(key, output);
    assert.deepEqual(getCompletedAction(key), output, "重試前查表要拿到跟當時完全一樣的輸出，不能重新送出");
  } finally {
    getDb().prepare(`DELETE FROM idempotent_actions WHERE key = ?`).run(key);
  }
});

test("recordCompletedAction：同一把 key 再次記錄(理論上不該發生,但防禦性驗證)要覆蓋成最新值,不是疊加/報錯", () => {
  const key = `test-idem-overwrite-${Date.now()}`;
  try {
    recordCompletedAction(key, { sent: true, attempt: 1 });
    recordCompletedAction(key, { sent: true, attempt: 2 });
    assert.deepEqual(getCompletedAction(key), { sent: true, attempt: 2 });
  } finally {
    getDb().prepare(`DELETE FROM idempotent_actions WHERE key = ?`).run(key);
  }
});

test("recordCompletedAction：機會性清理不會誤刪剛寫入、還在 14 天保留期內的紀錄", () => {
  const key = `test-idem-fresh-${Date.now()}`;
  try {
    recordCompletedAction(key, { sent: true });
    recordCompletedAction(`${key}-another`, { sent: true }); // 觸發清理邏輯本身
    assert.notEqual(getCompletedAction(key), null, "14 天內的紀錄不該被清理邏輯誤刪");
  } finally {
    getDb().prepare(`DELETE FROM idempotent_actions WHERE key LIKE ?`).run(`${key}%`);
  }
});

// 真實踩過的漏洞(code review 抓到)：只記「確定完成」防不住最常見的觸發路徑——外部呼叫已經
// 送出、但因為逾時而拋錯，同一個 run 內的自動重試會用同一把 key 再叫一次 execute()，這時
// 查不到任何「完成」紀錄，會照樣真的送第二次。markAttemptStarted 標記「已經要送出去、結果
// 還不確定」，讓下一次(不管是同一個 run 的自動重試、還是之後手動續跑)都能查到並拒絕自動重試。
test("getAttemptState：markAttemptStarted 後狀態是 pending；recordCompletedAction 後升級成 completed", () => {
  const key = `test-idem-state-${Date.now()}`;
  try {
    assert.equal(getAttemptState(key), "none", "還沒開始任何嘗試");
    markAttemptStarted(key);
    assert.equal(getAttemptState(key), "pending", "已經標記要發起外部呼叫、結果還不確定");
    assert.equal(getCompletedAction(key), null, "pending 狀態不能被當成「已完成」讀出快取結果");
    recordCompletedAction(key, { sent: true });
    assert.equal(getAttemptState(key), "completed");
    assert.deepEqual(getCompletedAction(key), { sent: true });
  } finally {
    getDb().prepare(`DELETE FROM idempotent_actions WHERE key = ?`).run(key);
  }
});

test("markAttemptStarted：已經是 completed 的紀錄不會被重新標記回 pending(INSERT OR IGNORE)", () => {
  const key = `test-idem-noclobber-${Date.now()}`;
  try {
    recordCompletedAction(key, { sent: true });
    markAttemptStarted(key); // 理論上不該發生(呼叫端會先檢查狀態)，但要確認不會意外把 completed 蓋回 pending
    assert.equal(getAttemptState(key), "completed", "已確定完成的紀錄不能被 markAttemptStarted 悄悄降級");
    assert.deepEqual(getCompletedAction(key), { sent: true });
  } finally {
    getDb().prepare(`DELETE FROM idempotent_actions WHERE key = ?`).run(key);
  }
});
