import { getDb } from "../db";
import type { NodeContext } from "./types";

/**
 * 寫入/發送類節點(google-sheet-append、send-email、telegram/line/slack-notify)標成 retryable：
 * 引擎逾時或暫時性錯誤會整個節點重跑，但「重跑」不等於「這次真的沒送到」——遠端有可能其實已經
 * 處理成功，只是我們這邊等回應逾時，重跑就會寄兩次信、多寫一列、發兩次通知。
 *
 * key 用 runId:nodeId：repeat-steps 內嵌步驟執行時，ctx.nodeId 本身已經帶著迭代序號
 * (`${外層nodeId}-i${第幾輪}-s${第幾步}`，見 repeatSteps.ts)，天然對每一次迴圈迭代都唯一，
 * 不需要額外處理——「同一個 runId+nodeId 只應該真正送出一次」這個假設對迴圈内的每一輪也成立。
 *
 * 只記「成功後」不夠：真實踩過的漏洞(code review 抓到)——引擎的自動重試是在「同一個 run 裡、
 * 呼叫端還沒換一輪」時，node 拋出 RetryableError(例如 sendEmail.ts 的 ETIMEDOUT，這正是「已經
 * 送出、只是沒等到回應」的典型情境)就立刻重新呼叫 execute()，用的是同一把 idempotencyKey。
 * 如果只在外部呼叫「確定成功」之後才記錄，這種「送出了、但因為逾時而拋錯」的情況完全記錄不到，
 * 下一次重試(不管是引擎自動重試、還是使用者手動續跑)一樣會查不到紀錄、照樣真的送第二次——
 * 這正是這個機制原本要防的事，卻沒真的擋住最常見的觸發路徑。
 *
 * 修法：在「真的要發起外部呼叫」前先標記 pending；呼叫確定成功後才升級成 completed。
 * 下次(不管是同一個 run 內的自動重試，還是之後的手動續跑)查到：
 * - completed → 直接沿用當時的輸出，不再呼叫。
 * - pending(代表上次「已經要送出去」但不知道結果，不能確定是否真的送達) → 不自動重試，
 *   老實停下來讓人決定，不能悄悄再送一次冒重複的風險。
 * - 都沒有 → 這是第一次真的要做，正常執行。
 * pending 標記只能在**所有輸入驗證都通過之後**才下(見各節點呼叫處)，不然「設定沒填」這類
 * 跟外部呼叫完全無關的錯誤，會被誤標成「已經嘗試過」，讓使用者修好設定後也永遠被擋住無法重試。
 */
export function idempotencyKey(ctx: Pick<NodeContext, "runId" | "nodeId">): string {
  return `${ctx.runId}:${ctx.nodeId}`;
}

export type AttemptState = "none" | "pending" | "completed";

/** 查這個邏輯動作目前的狀態——呼叫外部服務之前，先問一次要不要繼續。 */
export function getAttemptState(key: string): AttemptState {
  const row = getDb().prepare(`SELECT status FROM idempotent_actions WHERE key = ?`).get(key) as { status: string } | undefined;
  if (!row) return "none";
  return row.status === "completed" ? "completed" : "pending";
}

/** 這個邏輯動作在這次執行裡已經真的完成過時，回傳當時記錄的輸出；沒有就回 null。 */
export function getCompletedAction(key: string): Record<string, unknown> | null {
  const row = getDb().prepare(`SELECT output_json FROM idempotent_actions WHERE key = ? AND status = 'completed'`).get(key) as { output_json: string | null } | undefined;
  if (!row?.output_json) return null;
  try {
    const parsed = JSON.parse(row.output_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * 所有輸入驗證都過關、真的要發起外部呼叫前呼叫這個——標記「已經要送出去，結果還不確定」。
 * 用 INSERT OR IGNORE：如果已經有 pending/completed 紀錄，不覆蓋它(尤其不能把 completed 蓋回
 * pending，那會讓已經確定成功的動作看起來又變成不確定)。
 */
export function markAttemptStarted(key: string): void {
  // output_json 欄位是 NOT NULL(給 completed 用)，pending 狀態還沒有真正的輸出，
  // 用空字串佔位——getCompletedAction 只認 status='completed' 的紀錄，不會誤讀這個佔位值。
  getDb().prepare(`INSERT OR IGNORE INTO idempotent_actions (key, status, output_json, created_at) VALUES (?, 'pending', '', datetime('now'))`).run(key);
}

/**
 * 真正的外部呼叫確定成功後才呼叫——記錄之前失敗就直接拋錯，不會誤記「已完成」。
 * 順手清掉過期紀錄(機會性清理，不用額外排程)：這張表只在「同一個 run 對同一個節點重跑」這個
 * 極短窗口內有意義，14 天後的紀錄不可能再被同一次重試用到。
 */
export function recordCompletedAction(key: string, output: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO idempotent_actions (key, status, output_json, created_at) VALUES (?, 'completed', ?, datetime('now'))`)
    .run(key, JSON.stringify(output));
  db.prepare(`DELETE FROM idempotent_actions WHERE created_at < datetime('now', '-14 days')`).run();
}
