import { randomUUID } from "node:crypto";
import { getDb } from "../db";

/** 主要節點以外，還一併要改的節點(整圖感知修復發現真正原因不只一處時) */
export interface ExtraFixEdit {
  nodeId: string;
  nodeLabel: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface FixProposal {
  id: string;
  run_id: string;
  workflow_id: string;
  node_id: string;
  node_label: string;
  error: string | null;
  before_json: string;
  after_json: string;
  extra_edits_json: string | null;
  status: "pending" | "applied" | "dismissed";
  created_at: string;
}

export function createProposal(input: {
  runId: string;
  workflowId: string;
  nodeId: string;
  nodeLabel: string;
  error: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** 整圖感知修復除了主要節點外，還一併改了哪些節點——套用提案時要一起套用，不能只套主要那格 */
  extraEdits?: ExtraFixEdit[];
}): string {
  const db = getDb();
  // 同一個 workflow+節點若已有還沒處理的舊提案，先作廢——不然同一個排程每天都失敗，
  // 首頁會堆一疊一模一樣的提案。只留最新的那個。
  db.prepare(`UPDATE fix_proposals SET status='dismissed' WHERE workflow_id=? AND node_id=? AND status='pending'`).run(input.workflowId, input.nodeId);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO fix_proposals (id, run_id, workflow_id, node_id, node_label, error, before_json, after_json, extra_edits_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
  ).run(
    id, input.runId, input.workflowId, input.nodeId, input.nodeLabel, input.error,
    JSON.stringify(input.before), JSON.stringify(input.after),
    input.extraEdits?.length ? JSON.stringify(input.extraEdits) : null,
  );
  return id;
}

/** 開機時清一次：作廢太舊還沒人理的 pending 提案(14天)，並刪掉早就處理過的紀錄(30天)，避免無限長大 */
export function cleanupStaleProposals() {
  const db = getDb();
  db.prepare(`UPDATE fix_proposals SET status='dismissed' WHERE status='pending' AND created_at < datetime('now','-14 days')`).run();
  db.prepare(`DELETE FROM fix_proposals WHERE status IN ('applied','dismissed') AND created_at < datetime('now','-30 days')`).run();
}

/** 列出所有還沒處理的提案(跨所有 workflow)，給首頁的通知橫幅用 */
export function listPendingProposals(): FixProposal[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM fix_proposals WHERE status = 'pending' ORDER BY created_at DESC`).all() as FixProposal[];
}

export function getProposal(id: string): FixProposal | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM fix_proposals WHERE id = ?`).get(id) as FixProposal | undefined;
}

/**
 * 原子地把 pending 提案標記成 applied：檢查與更新在同一句 UPDATE 完成。
 * 回傳 false 代表這個提案已經被別的請求搶先處理過了(例如使用者連點兩下「套用並重跑」)。
 */
export function claimProposal(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`UPDATE fix_proposals SET status = 'applied' WHERE id = ? AND status = 'pending'`).run(id);
  return result.changes > 0;
}

export function setProposalStatus(id: string, status: "applied" | "dismissed") {
  const db = getDb();
  db.prepare(`UPDATE fix_proposals SET status = ? WHERE id = ?`).run(status, id);
}

/**
 * 原子地把 pending 提案標記成 dismissed：檢查與更新在同一句 UPDATE 完成，跟 claimProposal 同一套防護。
 * 回傳 false 代表這個提案已經不是 pending 了(例如已被另一個分頁「套用」過)——呼叫方不能再無條件
 * 蓋成 dismissed，否則會把「已套用、節點已改、流程已重跑」的狀態靜默改回「已忽略」，使用者看不出
 * 剛剛的套用其實生效了(踩過的競態)。
 */
export function dismissPendingProposal(id: string): boolean {
  const db = getDb();
  const result = db.prepare(`UPDATE fix_proposals SET status = 'dismissed' WHERE id = ? AND status = 'pending'`).run(id);
  return result.changes > 0;
}
