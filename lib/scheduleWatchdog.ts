/**
 * 排程看門狗：不准「安靜地不執行」。
 *
 * 真實踩到的狀況：有一條排程開著、`next_run_at` 也算好了，畫面上跟正常的一模一樣，
 * 但排程器每分鐘都會在自動觸發檢查那裡跳過它(流程還是草稿)，而**唯一的痕跡是一行終端機警告**。
 * 結果是那條排程長期不執行，沒有任何人發現——直到有人專門去查資料庫。
 *
 * 對一個「無人值守」的產品來說，這比明確失敗危險得多：失敗會通知你，安靜不執行不會。
 * 所以這裡補兩個偵測：
 *   ①**該跑卻被檢查擋住**：到了該觸發的時間卻被 readiness 擋掉 → 通知一次(每天最多一次)。
 *   ②**排程器自己壞了**：某條排程開著、沒被擋、但 `next_run_at` 已經過期超過一天還沒更新
 *     → 代表 tick 根本沒在跑或一直在同一個地方出錯，這是最該立刻知道的狀況。
 *
 * 節流用 audit_log 當共同記憶(而不是行程內的變數)：常駐 daemon 跟使用者另開的 dev server
 * 是兩個行程、各自都有排程器，用記憶體節流會變成同一件事通知兩次。
 */

import { getDb } from "./db";
import { notifyDesktop } from "./notify";
import { recordAudit } from "./auditLog";

const NOTIFY_COOLDOWN_HOURS = 24;
/** next_run_at 過期多久才算「排程器自己有問題」。留 25 小時的餘裕：電腦睡一整晚是正常的。 */
const STALE_NEXT_RUN_HOURS = 25;

/**
 * 這件事最近通知過了沒。
 *
 * 匯出出來是為了能測試——節流是這個模組唯一有風險的邏輯(壞掉的話就是每分鐘轟炸使用者
 * 或是永遠不通知)，而 warnXxx 會真的發桌面通知，不適合在測試裡呼叫。
 */
export function notifiedRecently(action: string, target: string): boolean {
  try {
    const since = new Date(Date.now() - NOTIFY_COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
    const row = getDb()
      .prepare(`SELECT 1 FROM audit_log WHERE action = ? AND target = ? AND at >= ? LIMIT 1`)
      .get(action, target, since);
    return Boolean(row);
  } catch {
    // 查不到就當沒通知過——寧可多通知一次，也不要因為查詢失敗而永遠不通知。
    return false;
  }
}

/**
 * 該觸發卻被自動觸發檢查擋住。
 * 只在「真的到了該跑的時間」才叫——不然一條草稿排程會每分鐘都在喊。
 */
export function warnScheduleBlocked(input: {
  scheduleId: string;
  workflowId: string;
  workflowName: string;
  reason: string;
}): void {
  if (notifiedRecently("schedule.blocked", input.scheduleId)) return;
  recordAudit({
    actor: "scheduler",
    action: "schedule.blocked",
    target: input.scheduleId,
    detail: { workflowId: input.workflowId, reason: input.reason },
  });
  notifyDesktop(
    `「${input.workflowName}」的排程時間到了，但沒有執行`,
    `${input.reason}｜打開 Agent Hub 的「排程 & 執行」就會看到這一條被標紅色。`,
  );
}

/** 排程器自己看起來壞了(某條排程的下次執行時間過期太久還沒被更新)。 */
export function warnSchedulerStalled(input: { scheduleId: string; workflowName: string; nextRunAt: string }): void {
  if (notifiedRecently("schedule.stalled", input.scheduleId)) return;
  recordAudit({
    actor: "scheduler",
    action: "schedule.stalled",
    target: input.scheduleId,
    detail: { nextRunAt: input.nextRunAt },
  });
  notifyDesktop(
    `「${input.workflowName}」的排程看起來卡住了`,
    `預計 ${input.nextRunAt} 要執行，但已經過了超過一天還沒有動作。請打開 Agent Hub 檢查。`,
  );
}

/** 每分鐘的心跳順便掃一次「排程器自己壞了」。被擋住的那種在 tick 的檢查點就地判斷。 */
export function sweepStalledSchedules(nowStr: string): void {
  const cutoff = new Date(Date.now() - STALE_NEXT_RUN_HOURS * 60 * 60 * 1000)
    .toISOString().replace("T", " ").slice(0, 19);
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.next_run_at, COALESCE(m.name, s.workflow_id) AS name
       FROM schedules s LEFT JOIN workflows_meta m ON m.id = s.workflow_id
       WHERE s.enabled = 1 AND s.next_run_at IS NOT NULL AND s.next_run_at < ?`,
    )
    .all(cutoff) as { id: string; next_run_at: string; name: string }[];
  for (const row of rows) {
    // nowStr 只是為了讓呼叫端的時間基準一致，這裡不再自己算 now。
    if (row.next_run_at >= nowStr) continue;
    warnSchedulerStalled({ scheduleId: row.id, workflowName: row.name, nextRunAt: row.next_run_at });
  }
}
