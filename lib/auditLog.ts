/**
 * 稽核軌跡：記「人做了什麼」。
 *
 * 為什麼原本沒有也不夠(稽核指出的 P0)：系統已經有非常完整的**執行**紀錄
 * (runs / node_runs / run_logs / runReceipt / runtimeEvidence)——但那些回答的是
 * 「系統做了什麼」。企業稽核問的是另一組問題：誰改了這條流程？誰觸發了這次執行？
 * 誰看了那組帳密？**誰核准了那個閘門？** 最後一項最關鍵，因為人工核准閘正是這個產品的
 * 賣點之一，而核准這個動作原本完全沒有留下紀錄。
 *
 * 誠實的限制：這個產品沒有使用者概念(單人本機工具)，所以 actor 記到「管道」等級——
 * 從瀏覽器 UI、從腳本、從 Telegram 按鈕、還是排程自己做的。這不等於「知道是哪個人」，
 * 但它回答了稽核真正在問的另一半：**這件事是怎麼發生的、經過哪個入口**。
 * 結構先建起來，將來真的接上身分層時把 actor 換成人即可，寫入點不用重寫。
 */

import { getDb } from "./db";
import { LOCAL_TOKEN_COOKIE, LOCAL_TOKEN_HEADER } from "./localToken";

/** 管道等級的行為者。刻意用固定字串，不讓呼叫端自由填。 */
export type AuditActor =
  | "local-ui" | "script" | "approve-link" | "telegram" | "line"
  | "webhook" | "scheduler" | "watcher" | "system";

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  source: string | null;
}

/**
 * 稽核紀錄的目的是「事後查得到」，所以保留期要長；但它也不能無界成長。
 * 20 萬筆對本機單人使用是好幾年的量，超過就從最舊的開始刪(並且記一筆刪除本身)。
 */
const MAX_ROWS = 200_000;
const PRUNE_BATCH = 5_000;

let writes = 0;

/**
 * 從請求判斷「這件事是從哪個入口進來的」。
 * 只能判斷管道，判斷不出是誰——所以回傳值刻意不叫 user。
 */
export function actorFromRequest(req: Request): AuditActor {
  if (req.headers.get(LOCAL_TOKEN_HEADER)) return "script";
  const cookie = req.headers.get("cookie") ?? "";
  if (cookie.includes(`${LOCAL_TOKEN_COOKIE}=`)) return "local-ui";
  return "system";
}

function sourceFromRequest(req: Request): string {
  const ua = (req.headers.get("user-agent") ?? "").slice(0, 120);
  return ua || "unknown";
}

/**
 * 寫一筆稽核紀錄。
 *
 * **絕對不能因為稽核寫入失敗而讓原本的操作失敗**——稽核是旁路，不是主線。
 * (反過來說，主線成功但稽核靜默漏記也是問題，所以失敗時 console.error 留痕。)
 */
export function recordAudit(entry: {
  actor: AuditActor;
  action: string;
  target?: string | null;
  detail?: unknown;
  source?: string | null;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO audit_log (at, actor, action, target, detail, source) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      entry.actor,
      entry.action,
      entry.target ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail).slice(0, 4_000),
      entry.source ?? null,
    );
    // 每 500 筆才檢查一次總量，不要每次寫入都跑 COUNT(*)。
    if (++writes % 500 === 0) prune(db);
  } catch (err) {
    console.error("[audit] 寫入稽核紀錄失敗", err);
  }
}

/** 從請求直接記一筆(自動填 actor / source)。 */
export function recordAuditFromRequest(req: Request, action: string, target?: string | null, detail?: unknown): void {
  recordAudit({ actor: actorFromRequest(req), action, target, detail, source: sourceFromRequest(req) });
}

function prune(db: ReturnType<typeof getDb>): void {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number };
  if (n <= MAX_ROWS) return;
  const removed = db.prepare(
    `DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY id ASC LIMIT ?)`,
  ).run(Math.max(PRUNE_BATCH, n - MAX_ROWS)).changes;
  // 刪除本身也留一筆——否則稽核軌跡「少了一段」時沒人看得出是被清掉還是從來沒發生。
  db.prepare(`INSERT INTO audit_log (at, actor, action, target, detail, source) VALUES (?, ?, ?, ?, ?, ?)`).run(
    new Date().toISOString(), "system", "audit.prune", null, JSON.stringify({ removed, keep: MAX_ROWS }), "auto",
  );
}

export function listAudit(opts: { limit?: number; action?: string } = {}): AuditEntry[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2_000);
  const db = getDb();
  const rows = opts.action
    ? db.prepare(`SELECT * FROM audit_log WHERE action LIKE ? ORDER BY id DESC LIMIT ?`).all(`${opts.action}%`, limit)
    : db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`).all(limit);
  return rows as AuditEntry[];
}

export function countAudit(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number }).n;
}

/** 動作代號 → 白話。UI 給非工程師看，不能直接顯示 workflow.update 這種字串。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "workflow.create": "建立流程",
  "workflow.update": "修改流程",
  "workflow.delete": "刪除流程",
  "workflow.import": "匯入流程",
  "workflow.copy": "複製流程",
  "workflow.node.update": "修改步驟設定",
  "workflow.run": "手動觸發執行",
  "workflow.manual-login": "開啟手動登入視窗",
  "workflow.record": "錄一段操作示範",
  "schedule.create": "新增排程",
  "schedule.update": "修改排程",
  "schedule.delete": "刪除排程",
  "schedule.pause-all": "暫停全部排程",
  "schedule.blocked": "排程時間到了卻被檢查擋住(沒有執行)",
  "schedule.stalled": "排程看起來卡住了",
  "schedule.resume-batch": "恢復剛才暫停的排程",
  "secret.write": "儲存帳密",
  "secret.delete": "刪除帳密",
  "secret.reveal": "查看帳密明碼",
  "settings.update": "修改全域設定",
  "settings.reveal": "查看 API Key 明碼",
  "approval.approve": "核准",
  "approval.reject": "拒絕",
  "user-step.save": "儲存我的步驟",
  "user-step.delete": "刪除我的步驟",
  "output-folder.set": "設定產出檔案的資料夾",
  "output-folder.clear": "取消產出資料夾設定",
  "retention.update": "修改資料保留期限",
  "retention.sweep": "清理過期資料",
  "google.connect": "連結 Google 帳號",
  "google.disconnect": "取消連結 Google 帳號",
  "audit.prune": "自動清理最舊的稽核紀錄",
};

export const AUDIT_ACTOR_LABELS: Record<string, string> = {
  "local-ui": "本機瀏覽器",
  script: "腳本/命令列",
  "approve-link": "簽核連結",
  telegram: "Telegram",
  line: "LINE",
  webhook: "Webhook",
  scheduler: "排程",
  watcher: "監聽",
  system: "系統",
};
