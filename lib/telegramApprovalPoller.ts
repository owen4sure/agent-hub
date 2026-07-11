import { getDb } from "./db";
import { getSharedSecrets } from "./settingsStore";
import { decideApproval } from "./approvals";

/**
 * Telegram 簽核按鈕的接收端：等人簽核節點發出的訊息帶「✅核准/❌拒絕」內建按鈕，
 * 使用者在手機上按下去 → Telegram 存成 callback——伺服器鎖 127.0.0.1 收不到 webhook，
 * 所以用 getUpdates 長輪詢主動去拿。這是「手機遠端簽核」在 local-first 架構下能真的動的關鍵。
 *
 * 節制原則：**只在有 pending 簽核時才輪詢**——沒有簽核在等就完全不碰 Telegram API，
 * 不會長期佔用使用者的 bot(bot 可能還有別的用途)。
 * 多進程(daemon+dev)同時輪詢會被 Telegram 回 409：收到就退避讓另一個進程獨佔，不炸錯。
 */

let started = false;

export function startApprovalPoller() {
  if (started) return;
  started = true;
  void loop();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pendingCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM approvals WHERE status='pending'`).get() as { c: number };
  return row.c;
}

function getOffset(): number {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key='tgApprovalOffset'`).get() as { value: string } | undefined;
  return Number(row?.value ?? 0) || 0;
}

function setOffset(n: number) {
  getDb().prepare(`INSERT INTO settings (key, value) VALUES ('tgApprovalOffset', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(n));
}

async function tgApi(botToken: string, method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<{ status: number; json: { ok?: boolean; result?: unknown } }> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: { ok?: boolean; result?: unknown } = {};
  try {
    json = (await res.json()) as { ok?: boolean; result?: unknown };
  } catch {
    /* 非 JSON 回應照 status 處理 */
  }
  return { status: res.status, json };
}

interface TgUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id?: number }; message_id?: number; text?: string };
  };
}

async function loop() {
  // 給 server 一點開機時間再開始
  await sleep(3000);
  for (;;) {
    try {
      if (pendingCount() === 0) {
        await sleep(5000);
        continue;
      }
      const botToken = getSharedSecrets().telegramBotToken;
      if (!botToken) {
        await sleep(20_000); // 沒設 Telegram：簽核仍可走網頁/首頁卡，這裡安靜等
        continue;
      }
      const r = await tgApi(botToken, "getUpdates", { offset: getOffset(), timeout: 20, allowed_updates: ["callback_query"] }, 30_000);
      if (r.status === 409) {
        await sleep(60_000); // 另一個進程(daemon/dev)在輪詢或 bot 設了 webhook——讓對方獨佔
        continue;
      }
      if (r.status !== 200 || !r.json.ok) {
        await sleep(15_000);
        continue;
      }
      const updates = (r.json.result as TgUpdate[] | undefined) ?? [];
      for (const upd of updates) {
        setOffset(upd.update_id + 1); // 先推進 offset：處理炸掉也不要重複處理同一則
        const cb = upd.callback_query;
        const m = cb?.data?.match(/^ah:([a-f0-9]{48}):(ok|no)$/);
        if (!cb || !m) continue;
        const action = m[2] === "ok" ? "approve" : "reject";
        const result = await decideApproval({ token: m[1] }, action, "(由 Telegram 按鈕決定)");
        const feedback = result.ok ? (action === "approve" ? "已核准 ✅ 流程繼續跑了" : "已拒絕 ❌") : (result.error ?? "處理失敗").slice(0, 190);
        await tgApi(botToken, "answerCallbackQuery", { callback_query_id: cb.id, text: feedback }).catch(() => {});
        // 把原訊息的按鈕收掉+附上結果，之後再看這則訊息不會誤以為還能按
        if (cb.message?.chat?.id && cb.message.message_id) {
          await tgApi(botToken, "editMessageText", {
            chat_id: cb.message.chat.id,
            message_id: cb.message.message_id,
            text: `${cb.message.text ?? ""}\n\n——${feedback}`,
          }).catch(() => {});
        }
      }
    } catch {
      await sleep(10_000); // 網路瞬斷等，退避後續命
    }
  }
}
