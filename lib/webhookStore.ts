import { randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";

/**
 * Webhook 觸發的 token 管理。URL 路徑裡的隨機 token 就是認證：
 * - 瀏覽器跨站攻擊者拿不到 token(proxy.ts 的 Origin 檢查另外擋跨站 POST)；
 * - 本機其他程式(捷徑/腳本/別的工具)拿著網址就能觸發，不用再學任何認證。
 */

export function getWebhookToken(workflowId: string): string | null {
  const row = getDb().prepare(`SELECT webhook_token FROM workflows_meta WHERE id = ?`).get(workflowId) as
    | { webhook_token: string | null }
    | undefined;
  return row?.webhook_token ?? null;
}

/** 啟用(或重新產生)webhook token。回傳新 token。 */
export function rotateWebhookToken(workflowId: string): string {
  const token = randomBytes(24).toString("hex");
  const res = getDb().prepare(`UPDATE workflows_meta SET webhook_token = ? WHERE id = ?`).run(token, workflowId);
  if (res.changes === 0) {
    // workflows_meta 由 saveWorkflow 同步；走到這代表流程沒存過(不該發生)，老實報錯而不是靜默給一個沒存進去的 token
    throw new Error("這條流程還沒有中繼資料(請先存檔一次再啟用 webhook)");
  }
  return token;
}

export function disableWebhook(workflowId: string): void {
  getDb().prepare(`UPDATE workflows_meta SET webhook_token = NULL WHERE id = ?`).run(workflowId);
}

/** 常數時間比對，避免 timing attack 逐字猜 token */
export function webhookTokenMatches(workflowId: string, given: string): boolean {
  const stored = getWebhookToken(workflowId);
  if (!stored || !given) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
