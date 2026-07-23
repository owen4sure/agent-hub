import { randomUUID } from "node:crypto";
import { getDb } from "../db";
import { isPidAlive } from "./engine";
import { getWorkflow, saveWorkflow } from "./store";
import type { WorkflowEdge, WorkflowNode } from "./types";

/**
 * 「讓 AI 修」(autofix) 與「自動測試」(autorun) 的修復迴圈會橫跨好幾輪，每一輪都可能先套用一個
 * 還沒驗證過的節點改動、重跑驗證、再決定保留或還原——這整個過程的「乾淨收尾」(restoreUnverified)
 * 只有在迴圈自己正常結束時才會執行。若承載迴圈的進程中途死掉(部署重啟/crash/被殺)，未驗證的
 * 改動就會半吊子永久留在流程上。這裡在迴圈開始前記一筆「開始前的完整快照」，迴圈結束(不管哪種
 * 結局)都要呼叫 endRepairSession 把這筆記錄刪掉；只有真的被中斷才會留下孤兒列，交給下次啟動時
 * 的 recoverCrashedRepairs() 整個還原回快照，不會把「還沒驗證過」的中間狀態誤當成使用者的最終決定。
 */
/**
 * 跨進程互斥：lib/workflow/busyLocks.ts 的 autorunActive 只是進程內記憶體的 Set——daemon(launchd
 * 常駐) + 使用者另外開的 dev instance 同時跑起來時，各自的記憶體鎖完全看不到對方，兩邊都可能同時
 * 對同一條流程跑修復迴圈，各自基於自己讀到的舊快照存檔，其中一邊的合法修改會被另一邊覆蓋或誤還原
 * (這是先前已知、記錄在案但沒有處理的限制)。這裡才是真正跨進程生效的檢查點(SQLite 檔案本身就是
 * 跨進程共用的)：開新一輪修復前，查有沒有「owner_pid 還活著」的既有 session，有就拒絕開新的一輪，
 * 若是舊 pid 早就死了(前一輪異常中斷)則放行(那筆孤兒紀錄留給 recoverCrashedRepairs 處理)。
 */
export function beginRepairSession(
  workflowId: string,
  kind: "autofix" | "autorun",
  snapshot: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
): string {
  const db = getDb();
  const id = randomUUID();
  // 查詢(SELECT)跟寫入(INSERT)是兩句獨立的 SQL，若各自單獨執行，兩個進程可能都在對方 INSERT
  // 之前完成 SELECT、都判定「沒有活著的 session」，結果同時插入兩筆——這正是這個檢查點原本要
  // 防的事，卻沒有真的擋住(code review 抓到的 TOCTOU 競態)。用 .immediate() 讓這個 transaction
  // 一開始就取得 SQLite 的 RESERVED 鎖(BEGIN IMMEDIATE)，另一個進程的同一個 transaction 會被
  // 擋住直到這筆 commit 完成(lib/db.ts 已設 busy_timeout，不會立刻報錯，而是等待)，檢查+寫入
  // 之間不會再有別的進程插隊。
  db.transaction(() => {
    const existing = db.prepare(`SELECT owner_pid FROM repair_sessions WHERE workflow_id = ?`).all(workflowId) as { owner_pid: number }[];
    const stillAlive = existing.find((row) => isPidAlive(row.owner_pid));
    if (stillAlive) {
      throw new Error(`這條流程目前有另一個進程(pid ${stillAlive.owner_pid})正在修復中，不能同時進行——請等它結束後再試`);
    }
    db.prepare(
      `INSERT INTO repair_sessions (id, workflow_id, kind, owner_pid, before_json, started_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(id, workflowId, kind, process.pid, JSON.stringify(snapshot));
  }).immediate();
  return id;
}

export function endRepairSession(id: string): void {
  getDb().prepare(`DELETE FROM repair_sessions WHERE id = ?`).run(id);
}

interface RepairSessionRow {
  id: string;
  workflow_id: string;
  kind: string;
  owner_pid: number;
  before_json: string;
  started_at: string;
}

/**
 * 啟動時掃描孤兒修復session：owner_pid 已死代表上次那個迴圈連自己的還原都沒機會跑。
 * 同一條流程可能疊了好幾筆孤兒紀錄(連續好幾次都在半路被中斷)——只還原成「最舊那筆」記錄的快照
 * (最早、最可能是乾淨的起點)，而不是逐筆疊還原，避免中間某筆快照其實也是別筆未驗證改動的結果。
 */
export function recoverCrashedRepairs(): void {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM repair_sessions ORDER BY workflow_id, started_at ASC`).all() as RepairSessionRow[];
  if (rows.length === 0) return;
  const dead = rows.filter((r) => !isPidAlive(r.owner_pid));
  if (dead.length === 0) return;
  const oldestByWorkflow = new Map<string, RepairSessionRow>();
  for (const row of dead) {
    if (!oldestByWorkflow.has(row.workflow_id)) oldestByWorkflow.set(row.workflow_id, row);
  }
  for (const [workflowId, row] of oldestByWorkflow) {
    try {
      const snapshot = JSON.parse(row.before_json) as { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
      const current = getWorkflow(workflowId);
      if (current) {
        saveWorkflow({ ...current, nodes: snapshot.nodes, edges: snapshot.edges });
        console.warn(`[repair-recovery] 流程 ${workflowId} 的「${row.kind}」修復迴圈上次異常中斷，已還原成迴圈開始前的版本`);
      }
    } catch (err) {
      console.error(`[repair-recovery] 還原流程 ${workflowId} 失敗:`, err);
    }
  }
  // 只刪掉「這次真的判定為死掉」的孤兒列(用 id，不是整個 workflow_id 一次清掉)——理論上極罕見，
  // 但若同一條流程剛好還有一筆屬於別的活進程的紀錄，不能被這裡誤刪。
  const deleteStmt = db.prepare(`DELETE FROM repair_sessions WHERE id = ?`);
  for (const row of dead) deleteStmt.run(row.id);
}
