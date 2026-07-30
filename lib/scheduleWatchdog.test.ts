import test from "node:test";
import assert from "node:assert/strict";
import { notifiedRecently } from "./scheduleWatchdog";
import { recordAudit } from "./auditLog";
import { getDb } from "./db";

/**
 * 看門狗的節流是這個模組唯一有風險的邏輯：壞成「永遠不通知」就等於沒有看門狗
 * (那正是原本的問題——排程安靜地不執行，只寫一行終端機日誌)；
 * 壞成「不節流」就會每分鐘轟炸使用者，然後他就把通知關掉，一樣等於沒有看門狗。
 *
 * 刻意不呼叫 warnScheduleBlocked：那會真的發一則桌面通知，測試不該在使用者螢幕上冒東西。
 */

const TARGET = "test-watchdog-schedule";

function cleanup() {
  getDb().prepare(`DELETE FROM audit_log WHERE target = ?`).run(TARGET);
}

test("看門狗節流：第一次要通知，24 小時內同一件事不再通知", () => {
  cleanup();
  try {
    assert.equal(notifiedRecently("schedule.blocked", TARGET), false, "還沒通知過就該通知");
    recordAudit({ actor: "scheduler", action: "schedule.blocked", target: TARGET, detail: { reason: "測試" } });
    assert.equal(notifiedRecently("schedule.blocked", TARGET), true, "剛通知過就不該再通知");
    // 不同的事件類型要各自獨立節流(排程被擋 vs 排程卡住是兩件事，不能互相壓住)
    assert.equal(notifiedRecently("schedule.stalled", TARGET), false);
  } finally {
    cleanup();
  }
});

test("看門狗節流：超過 24 小時的舊紀錄不算通知過(才不會永遠靜音)", () => {
  cleanup();
  try {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    getDb()
      .prepare(`INSERT INTO audit_log (at, actor, action, target, detail, source) VALUES (?, 'scheduler', 'schedule.blocked', ?, NULL, NULL)`)
      .run(old, TARGET);
    assert.equal(notifiedRecently("schedule.blocked", TARGET), false, "30 小時前的通知不該把今天壓住");
  } finally {
    cleanup();
  }
});
