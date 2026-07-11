import { randomBytes, randomUUID } from "node:crypto";
import { getDb } from "./db";
import { notifyDesktop } from "./notify";

/**
 * 等人簽核的資料層：流程跑到「等人簽核」節點會暫停(run 標 waiting)並建一筆 pending 簽核，
 * 簽核人透過 /approve/<token> 網頁、首頁的簽核卡、或 Telegram 內建按鈕決定；
 * 決定後用引擎的續跑機制(resumeRun + preResolved)讓流程從簽核節點帶著結果繼續跑。
 *
 * 循環相依注意：engine → registry → waitApproval 節點 → 本檔。所以本檔對 engine 的呼叫
 * (resumeRun)一律走動態 import，不能靜態 import engine，否則模組初始化互咬。
 */

export interface ApprovalRow {
  id: string;
  run_id: string;
  workflow_id: string;
  node_id: string;
  token: string;
  message: string;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled";
  decision_note: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

export function createApproval(input: {
  runId: string;
  workflowId: string;
  nodeId: string;
  message: string;
  timeoutHours: number;
}): { id: string; token: string } {
  const id = randomUUID();
  const token = randomBytes(24).toString("hex");
  const hours = Math.min(Math.max(Math.round(input.timeoutHours), 1), 14 * 24); // 1小時～14天
  getDb()
    .prepare(
      `INSERT INTO approvals (id, run_id, workflow_id, node_id, token, message, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now', ?))`,
    )
    .run(id, input.runId, input.workflowId, input.nodeId, token, input.message, `+${hours} hours`);
  return { id, token };
}

/** token 是簽核連結的認證：先驗格式(48 碼 hex)再查，亂打的字串連查詢都不用做 */
export function getApprovalByToken(token: string): ApprovalRow | null {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  return (getDb().prepare(`SELECT * FROM approvals WHERE token = ?`).get(token) as ApprovalRow | undefined) ?? null;
}

export function getApprovalById(id: string): ApprovalRow | null {
  return (getDb().prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined) ?? null;
}

/** 首頁簽核卡用：所有待決定的簽核(附流程名稱) */
export function listPendingApprovals(): (ApprovalRow & { workflow_name: string })[] {
  return getDb()
    .prepare(
      `SELECT a.*, COALESCE(m.name, a.workflow_id) AS workflow_name
       FROM approvals a LEFT JOIN workflows_meta m ON m.id = a.workflow_id
       WHERE a.status = 'pending' ORDER BY a.created_at DESC`,
    )
    .all() as (ApprovalRow & { workflow_name: string })[];
}

/**
 * 簽核人做決定：原子更新(只有 pending 能被決定，兩個人同時按只有一個生效)，
 * 然後讓流程從簽核節點續跑——核准走 "approved" 分支、拒絕走 "rejected" 分支，
 * 下游可用 {{approved}}(true/false)、{{decision}}(核准/拒絕)、{{decisionNote}}(簽核人備註)。
 */
export async function decideApproval(
  ref: { token?: string; id?: string },
  action: "approve" | "reject",
  note?: string,
): Promise<{ ok: boolean; error?: string; approval?: ApprovalRow }> {
  const db = getDb();
  const existing = ref.token ? getApprovalByToken(ref.token) : ref.id ? getApprovalById(ref.id) : null;
  if (!existing) return { ok: false, error: "找不到這筆簽核(連結可能貼錯或已被清理)。" };

  const newStatus = action === "approve" ? "approved" : "rejected";
  const changed = db
    .prepare(`UPDATE approvals SET status=?, decision_note=?, decided_at=datetime('now') WHERE id=? AND status='pending'`)
    .run(newStatus, (note ?? "").slice(0, 500) || null, existing.id).changes;
  if (changed === 0) {
    const now = getApprovalById(existing.id);
    const label: Record<string, string> = { approved: "已核准", rejected: "已拒絕", expired: "已逾時", cancelled: "已取消(執行被停止)" };
    return { ok: false, error: `這筆簽核${label[now?.status ?? ""] ?? "已處理過"}，不能再決定一次。`, approval: now ?? undefined };
  }

  // 讓流程從簽核節點帶著結果續跑(動態 import 破循環相依，見檔頭)
  const { resumeRun } = await import("./workflow/engine");
  const r = resumeRun(existing.run_id, {
    preResolved: {
      nodeId: existing.node_id,
      output: {
        approved: action === "approve",
        decision: action === "approve" ? "核准" : "拒絕",
        decisionNote: (note ?? "").slice(0, 500),
      },
      activePort: action === "approve" ? "approved" : "rejected",
    },
  });
  const approval = getApprovalById(existing.id)!;
  if (!r.ok) {
    // 決定已記錄但流程恢復不了(執行紀錄被清/流程被刪)——老實告訴簽核人，不要假裝一切正常
    return { ok: false, error: `已記錄你的決定(${newStatus === "approved" ? "核准" : "拒絕"})，但流程恢復失敗：${r.error}`, approval };
  }
  return { ok: true, approval };
}

/**
 * 逾時掃描(由 scheduler 每分鐘 tick 順便呼叫)：過期的 pending 簽核標 expired，
 * 對應的 waiting run 老實標失敗(簽核逾時)並通知——不能讓流程無聲地永遠掛在等簽核。
 */
export function sweepExpiredApprovals(): void {
  const db = getDb();
  const expired = db
    .prepare(`SELECT a.*, COALESCE(m.name, a.workflow_id) AS workflow_name FROM approvals a LEFT JOIN workflows_meta m ON m.id=a.workflow_id WHERE a.status='pending' AND a.expires_at <= datetime('now')`)
    .all() as (ApprovalRow & { workflow_name: string })[];
  for (const a of expired) {
    const changed = db.prepare(`UPDATE approvals SET status='expired', decided_at=datetime('now') WHERE id=? AND status='pending'`).run(a.id).changes;
    if (changed === 0) continue; // 另一個進程剛好處理掉了
    db.prepare(
      `UPDATE runs SET status='failed', error='簽核逾時', reason='等人簽核超過時限沒有人決定，這次執行停止。需要的話直接重新執行。', resolution='needs-human', failed_node=?, finished_at=datetime('now') WHERE id=? AND status='waiting'`,
    ).run(a.node_id, a.run_id);
    db.prepare(`UPDATE node_runs SET status='failed', error='簽核逾時', finished_at=datetime('now') WHERE run_id=? AND node_id=? AND status='waiting'`).run(a.run_id, a.node_id);
    db.prepare(`UPDATE node_runs SET status='skipped' WHERE run_id=? AND status='pending'`).run(a.run_id);
    db.prepare(`INSERT INTO run_logs (run_id, node_id, ts, line) VALUES (?, ?, datetime('now'), ?)`).run(a.run_id, a.node_id, "⏰ 簽核逾時，執行停止");
    notifyDesktop(`「${a.workflow_name}」簽核逾時`, `沒有人在時限內決定，流程已停止：${a.message.slice(0, 120)}`);
  }
}
