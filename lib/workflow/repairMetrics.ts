/**
 * 修復迴圈的量測。
 *
 * 為什麼需要：使用者問「出了問題裡面的 AI 修不修得了」——這是他最在意的三個問題之一，
 * 而這個平台**答不出來**。修復迴圈跑完就結束了，沒有留下「試了幾輪、改了什麼、最後成不成」
 * 的任何痕跡。學習庫(learnedFixes)只記「乾淨全綠+語意驗收通過」的那些，所以它是成功的下限，
 * 不是成功率的分母。
 *
 * **刻意的設計取捨**：不去改 autofix/autorun 那兩支路由裡散落十幾處的 return
 * (那兩條迴圈是已經在正式使用、修過很多真實 bug 的東西，為了埋量測去動它的控制流風險太高)。
 * 改成記在唯一的共同底層 `aiRepairGraph` 呼叫點，成敗則**由既有資料推導**：
 * 一次修復嘗試之後，那條流程的下一次執行結果就是它的成績。
 *
 * 這個定義要對使用者講清楚(見儀表板文案)：它衡量的是「修完之後下一次跑起來成功了嗎」，
 * 不是「模型的提案本身對不對」。誠實的定義比漂亮的數字重要。
 */

import { getDb } from "../db";

export type RepairSource = "autofix" | "autorun" | "chat" | "background" | "unknown";

export interface RepairAttemptRow {
  id: number;
  at: string;
  workflow_id: string;
  node_id: string;
  source: string;
  edits: number;
  skipped: number;
  error_signature: string | null;
}

/**
 * 把錯誤訊息正規化成「同一類問題」的指紋：數字與引號內容抽掉，
 * 這樣「逾時 30000ms」跟「逾時 45000ms」算同一類，統計才有意義。
 */
export function errorSignature(error: string): string {
  return String(error ?? "")
    .replace(/\d+/g, "#")
    .replace(/["'`][^"'`]*["'`]/g, "…")
    .slice(0, 200);
}

export function recordRepairAttempt(input: {
  workflowId: string;
  nodeId: string;
  source: RepairSource;
  edits: number;
  skipped: number;
  error: string;
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO repair_attempts (at, workflow_id, node_id, source, edits, skipped, error_signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.workflowId,
        input.nodeId,
        input.source,
        input.edits,
        input.skipped,
        errorSignature(input.error),
      );
  } catch (err) {
    // 量測是旁路：記不下來絕不能讓修復本身失敗。
    console.error("[repair-metrics] 記錄修復嘗試失敗", err);
  }
}

export interface RepairSummary {
  /** 總共嘗試過幾次修復 */
  attempts: number;
  /** 其中有真的產出修改的次數(模型有時候什麼都提不出來) */
  withEdits: number;
  /** 嘗試之後那條流程的下一次執行成功了 */
  followedBySuccess: number;
  /** 嘗試之後下一次執行還是失敗 */
  followedByFailure: number;
  /** 嘗試之後那條流程還沒有再跑過(還不知道結果) */
  noRunYet: number;
  /** 學習庫裡「乾淨全綠+語意驗收通過」的修復筆數——成功的下限 */
  verifiedCleanFixes: number;
  oldestAt: string | null;
}

/**
 * 統計。「成功」的定義：這次修復嘗試之後，同一條流程的下一次執行是成功的。
 * 刻意不做更聰明的歸因(例如排除使用者中間手動改了設定)——那會讓數字變成不可解釋的黑盒，
 * 而一個講得清楚定義的粗略數字，比一個講不清楚的精確數字有用。
 */
export function summarizeRepairs(days = 90): RepairSummary {
  const db = getDb();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const attempts = db
    .prepare(`SELECT * FROM repair_attempts WHERE at >= ? ORDER BY at`)
    .all(since) as RepairAttemptRow[];

  const summary: RepairSummary = {
    attempts: attempts.length,
    withEdits: attempts.filter((a) => a.edits > 0).length,
    followedBySuccess: 0,
    followedByFailure: 0,
    noRunYet: 0,
    verifiedCleanFixes: 0,
    oldestAt: attempts[0]?.at ?? null,
  };

  const nextRun = db.prepare(
    `SELECT status FROM runs
     WHERE workflow_id = ? AND started_at >= ? AND status IN ('success','failed')
     ORDER BY started_at LIMIT 1`,
  );
  for (const attempt of attempts) {
    // runs.started_at 是 'YYYY-MM-DD HH:MM:SS'(SQLite datetime)，attempt.at 是 ISO；
    // 統一成前者的格式再比，不然字串比較會全部不成立(踩過這類時間格式混用的坑)。
    const stamp = attempt.at.replace("T", " ").slice(0, 19);
    const row = nextRun.get(attempt.workflow_id, stamp) as { status: string } | undefined;
    if (!row) summary.noRunYet++;
    else if (row.status === "success") summary.followedBySuccess++;
    else summary.followedByFailure++;
  }

  try {
    summary.verifiedCleanFixes = (db.prepare(`SELECT COUNT(*) AS n FROM learned_fixes`).get() as { n: number }).n;
  } catch { /* 舊 DB 還沒有這張表 */ }

  return summary;
}

/** 最常被修的問題類型(給使用者看「我的流程老是壞在同一件事上」)。 */
export function topRepairSignatures(limit = 5): { signature: string; count: number }[] {
  return getDb()
    .prepare(
      `SELECT error_signature AS signature, COUNT(*) AS count FROM repair_attempts
       WHERE error_signature IS NOT NULL GROUP BY error_signature ORDER BY count DESC LIMIT ?`,
    )
    .all(limit) as { signature: string; count: number }[];
}
