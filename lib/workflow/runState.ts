import type Database from "better-sqlite3";

/**
 * 一次執行被停止後，所有尚未開始的節點都必須進入終態。
 * 留在 pending 會讓歷史畫面看起來仍在等待，也會讓外部監控誤判 run 尚未真正收尾。
 */
export function markPendingNodeRunsSkipped(db: Database.Database, runId: string): number {
  return db.prepare(
    `UPDATE node_runs
     SET status='skipped', finished_at=COALESCE(finished_at, datetime('now'))
     WHERE run_id=? AND status='pending'`,
  ).run(runId).changes;
}
