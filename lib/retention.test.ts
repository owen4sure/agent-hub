import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RETENTION, getRetentionPolicy, setRetentionPolicy, sweepRetention } from "./retention";

/**
 * 保留期限的測試刻意**只**測「設定值的把關」與「預覽不會刪東西」。
 * 不去測真的刪除：這些測試跑在真實的 data/ 上，一個設錯天數的清理會刪掉使用者真正的執行紀錄。
 * 刪除路徑的正確性靠 ①預覽與刪除走同一段程式碼(只差 preview 旗標) ②畫面上按下去前一定先看預覽。
 */

test("保留期限：負數/非數字/超大值都會被夾回合理範圍，不會存進壞資料", () => {
  const original = getRetentionPolicy();
  try {
    assert.deepEqual(setRetentionPolicy({ debugArtifactDays: -5 }), { ...original, debugArtifactDays: original.debugArtifactDays });
    assert.equal(setRetentionPolicy({ debugArtifactDays: 99_999 }).debugArtifactDays, 3_650);
    assert.equal(setRetentionPolicy({ debugArtifactDays: 30.7 }).debugArtifactDays, 30);
    assert.equal(setRetentionPolicy({ runRecordDays: 0 }).runRecordDays, 0, "0 是合法值：代表不按時間刪");
  } finally {
    setRetentionPolicy(original);
    assert.deepEqual(getRetentionPolicy(), original, "測試結束要把使用者原本的設定放回去");
  }
});

test("保留期限預設值：除錯截圖有期限、使用者的成果不預設刪除", () => {
  // 這兩個預設值是刻意不對稱的(見 retention.ts 的說明)：截圖是 PII 最密集又最沒有長期價值的東西；
  // 執行紀錄與產出檔是使用者的成果，要不要按時間丟掉由他自己決定。
  assert.equal(DEFAULT_RETENTION.debugArtifactDays > 0, true);
  assert.equal(DEFAULT_RETENTION.runRecordDays, 0);
});

test("預覽模式完全不刪東西，只回報「會刪幾個」", () => {
  const first = sweepRetention({ preview: true });
  const second = sweepRetention({ preview: true });
  assert.equal(first.preview, true);
  assert.deepEqual(first, second, "預覽跑兩次結果要一樣(代表第一次真的沒動到任何東西)");
  assert.ok(first.debugDirsRemoved >= 0 && first.runsRemoved >= 0);
});
