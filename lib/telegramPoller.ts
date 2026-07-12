import { getDb } from "./db";
import { getSharedSecrets } from "./settingsStore";
import { decideApproval } from "./approvals";
import { listWorkflows } from "./workflow/store";
import { startWorkflowRun } from "./workflow/engine";
import { resolveParams } from "./relativeDate";
import type { Workflow } from "./workflow/types";

/**
 * Telegram 的唯一接收端(getUpdates 長輪詢)，一條連線同時服務兩件事：
 * 1. 簽核按鈕(callback_query)：等人簽核節點發的「✅核准/❌拒絕」，按了 → decideApproval 讓流程續跑。
 * 2. 訊息觸發(message)：trigger 節點 config.telegramWatch="on" 的「正式」流程——
 *    使用者傳訊息給 bot 就觸發，下游拿 {{message}}/{{chatId}}/{{fromName}}/{{messageId}}。
 *
 * ⚠️ 同一個 bot token 只能有「一個」getUpdates 消費者(Telegram 會對第二個回 409)——
 * 簽核和訊息觸發絕不能各開一個 poller 互咬，要加任何新的 Telegram 接收功能都併進這裡。
 *
 * 節制原則：沒有 pending 簽核「且」沒有任何訊息觸發流程時，完全不碰 Telegram API。
 * 安全預設：只接受「設定頁綁定的那個 Chat ID」傳來的訊息——bot 被陌生人搜到也觸發不了流程。
 * 多進程(daemon+dev)同時輪詢會被 Telegram 回 409：收到就退避讓另一個進程獨佔，不炸錯。
 */

let started = false;

export function startTelegramPoller() {
  if (started) return;
  started = true;
  void loop();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pendingCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM approvals WHERE status='pending'`).get() as { c: number };
  return row.c;
}

/** 有開訊息觸發的正式流程(+各自的關鍵字篩選) */
function telegramTriggerWorkflows(): { wf: Workflow; keyword: string }[] {
  try {
    return listWorkflows()
      .filter((wf) => wf.status === "official")
      .map((wf) => ({ wf, trigger: wf.nodes.find((n) => n.type === "trigger") }))
      .filter(({ trigger }) => trigger?.config.telegramWatch === "on")
      .map(({ wf, trigger }) => ({
        wf,
        keyword: typeof trigger?.config.telegramKeyword === "string" ? trigger.config.telegramKeyword.trim() : "",
      }));
  } catch (err) {
    console.error("[telegramPoller] 讀取 workflow 清單失敗:", err);
    return [];
  }
}

// offset 沿用舊 key(改名會讓已推進的位置歸零、重抓舊 update)。現在是簽核+訊息觸發共用的唯一 offset。
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

export interface TgMessage {
  message_id?: number;
  text?: string;
  chat?: { id?: number };
  from?: { first_name?: string; last_name?: string; username?: string };
}

interface TgUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat?: { id?: number }; message_id?: number; text?: string };
  };
  message?: TgMessage;
}

/** 純函式：訊息符不符合關鍵字篩選(留空=任何訊息；不分大小寫) */
export function telegramMessageMatches(text: string, keyword: string): boolean {
  const k = (keyword ?? "").trim().toLowerCase();
  if (!k) return true;
  return (text ?? "").toLowerCase().includes(k);
}

/** 純函式：只接受綁定的 Chat ID(沒綁定=一律不觸發，安全預設) */
export function telegramChatAllowed(msgChatId: string, configuredChatId: string): boolean {
  const configured = (configuredChatId ?? "").trim();
  if (!configured) return false;
  return msgChatId === configured;
}

/** 純函式：一則訊息 → 觸發參數(下游 {{欄位}}) */
export function telegramTriggerParams(msg: TgMessage): { message: string; chatId: string; fromName: string; messageId: number } {
  const from = msg.from;
  const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "";
  return {
    message: msg.text ?? "",
    chatId: String(msg.chat?.id ?? ""),
    fromName,
    messageId: msg.message_id ?? 0,
  };
}

/** 處理一則進來的訊息(E2E 測試直接呼叫；正式路徑由 loop 的 getUpdates 餵) */
export async function handleTriggerMessage(botToken: string, msg: TgMessage): Promise<void> {
  if (!msg.text) return;
  const configured = getSharedSecrets().telegramChatId ?? "";
  if (!telegramChatAllowed(String(msg.chat?.id ?? ""), configured)) return;
  const fired: string[] = [];
  for (const { wf, keyword } of telegramTriggerWorkflows()) {
    if (!telegramMessageMatches(msg.text, keyword)) continue;
    try {
      const params = resolveParams(wf.triggerParams ?? [], {}, new Date());
      startWorkflowRun(wf.id, { ...params, ...telegramTriggerParams(msg) }, { trigger: "telegram", headed: false });
      fired.push(wf.name);
      console.log(`[telegramPoller] ${wf.name}: 收到訊息「${msg.text.slice(0, 40)}」，已觸發執行`);
    } catch (err) {
      console.error(`[telegramPoller] 觸發 ${wf.id} 失敗:`, err);
    }
  }
  if (fired.length > 0 && msg.chat?.id) {
    // 使用者人在手機端才會用這招觸發——立刻回一句讓他知道有收到(結果要看桌面通知或在流程尾加 telegram-notify)
    await tgApi(botToken, "sendMessage", { chat_id: msg.chat.id, text: `▶️ 已觸發「${fired.join("」「")}」` }).catch(() => {});
  }
}

async function loop() {
  // 給 server 一點開機時間再開始
  await sleep(3000);
  for (;;) {
    try {
      if (pendingCount() === 0 && telegramTriggerWorkflows().length === 0) {
        await sleep(5000);
        continue;
      }
      const botToken = getSharedSecrets().telegramBotToken;
      if (!botToken) {
        await sleep(20_000); // 沒設 Telegram：簽核仍可走網頁/首頁卡，這裡安靜等
        continue;
      }
      const r = await tgApi(botToken, "getUpdates", { offset: getOffset(), timeout: 20, allowed_updates: ["callback_query", "message"] }, 30_000);
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
        if (upd.message) {
          await handleTriggerMessage(botToken, upd.message).catch((err) => console.error("[telegramPoller] 訊息處理失敗:", err));
        }
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
