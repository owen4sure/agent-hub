import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";

/**
 * LINE 訊息觸發：LINE 官方帳號的 webhook 打進 /api/line-hooks/<id>/<token>，
 * 有人傳訊息給官方帳號就觸發流程(下游拿 {{message}}/{{userId}}/{{replyToken}})。
 *
 * 兩層驗證缺一不可：
 * 1. URL 裡的隨機 token(跟一般 webhook 同一套：常數時間比對、錯誤一律同句 404 防探測)。
 * 2. X-Line-Signature 簽章(用共用帳密的 lineChannelSecret 驗 HMAC-SHA256)——
 *    LINE 平台才簽得出來，就算網址外流也偽造不了觸發。
 *
 * ⚠️ LINE 平台只能打「公網 HTTPS」網址——本機要先用隧道(cloudflared/ngrok)把網址開出去，
 * 面板上有教學；內建的安全對外模式在 W6 做。
 */

export function getLineToken(workflowId: string): string | null {
  const row = getDb().prepare(`SELECT line_token FROM workflows_meta WHERE id = ?`).get(workflowId) as
    | { line_token: string | null }
    | undefined;
  return row?.line_token ?? null;
}

/** 啟用(或重新產生)LINE token。回傳新 token。 */
export function rotateLineToken(workflowId: string): string {
  const token = randomBytes(24).toString("hex");
  const res = getDb().prepare(`UPDATE workflows_meta SET line_token = ? WHERE id = ?`).run(token, workflowId);
  if (res.changes === 0) {
    throw new Error("這條流程還沒有中繼資料(請先存檔一次再啟用 LINE 觸發)");
  }
  return token;
}

export function disableLineToken(workflowId: string): void {
  getDb().prepare(`UPDATE workflows_meta SET line_token = NULL WHERE id = ?`).run(workflowId);
}

/** 常數時間比對，避免 timing attack 逐字猜 token */
export function lineTokenMatches(workflowId: string, given: string): boolean {
  const stored = getLineToken(workflowId);
  if (!stored || !given) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 純函式：驗 LINE 平台的 X-Line-Signature(HMAC-SHA256 over 原始 body、base64) */
export function verifyLineSignature(channelSecret: string, rawBody: string, signature: string | null): boolean {
  if (!channelSecret || !signature) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface LineTextEvent {
  message: string;
  userId: string;
  replyToken: string;
}

/** 純函式：從 LINE webhook payload 抽出文字訊息事件(其他事件型別——貼圖/加好友/已讀——一律略過) */
export function extractLineTextEvents(payload: unknown): LineTextEvent[] {
  const events = (payload as { events?: unknown[] } | null)?.events;
  if (!Array.isArray(events)) return [];
  const out: LineTextEvent[] = [];
  for (const ev of events) {
    const e = ev as {
      type?: string;
      replyToken?: string;
      source?: { userId?: string };
      message?: { type?: string; text?: string };
    };
    if (e?.type !== "message" || e.message?.type !== "text" || !e.message.text) continue;
    out.push({
      message: e.message.text,
      userId: e.source?.userId ?? "",
      replyToken: e.replyToken ?? "",
    });
  }
  return out;
}
