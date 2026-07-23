import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr, needsSetupHint } from "../nodeHelpers";
import { getAttemptState, getCompletedAction, idempotencyKey, markAttemptStarted, recordCompletedAction } from "../idempotency";

/**
 * 訊息通知節點：把流程結果推到使用者的 Telegram / LINE。
 * 一般人最常見的需求是「跑完(或出狀況)敲我一下」——但自己串 bot 對非工程師超級複雜，
 * 所以這裡把串接簡化成「到設定頁照教學填兩個欄位」，設定頁還有「測試發送」按鈕一鍵驗證。
 */

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  // 使用者按「停止執行」要能真的中斷這個 fetch，不能只靠內部 15 秒逾時——外部 signal 一旦中止，
  // 也 abort 這裡自己的 controller(AGENTS.md 鐵則19：任何節點呼叫 fetch/AI 都要接 ctx.cancelSignal，
  // 這裡以前漏接，按停止對正在發通知的節點完全無效，最長要多等 15 秒)。
  // 停止的時機若剛好落在「節點重試的退避等待」期間(engine.ts 的 sleep)，signal 這時已經是
  // aborted:true——addEventListener 對「早就觸發過的事件」不會再次觸發，內部 fetch 就不會被中斷、
  // 通知照樣送出去(踩過的真實回歸：只接了 abort 事件，沒接已經 aborted 的情況)。比照
  // lib/aiRetry.ts 的 sleepCancellable 同一套保險：呼叫當下就先檢查一次現況。
  if (signal?.aborted) controller.abort();
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

/** 送一則 Telegram 訊息(給節點與設定頁的「測試發送」共用，行為一致) */
export async function sendTelegram(botToken: string, chatId: string, text: string, signal?: AbortSignal): Promise<void> {
  await sendTelegramRaw(botToken, { chat_id: chatId, text }, signal);
}

/** 送一則帶「✅核准/❌拒絕」內建按鈕的 Telegram 訊息(等人簽核用——簽核人在手機上直接按按鈕就完成) */
export async function sendTelegramApproval(
  botToken: string,
  chatId: string,
  text: string,
  approveData: string,
  rejectData: string,
  signal?: AbortSignal,
): Promise<void> {
  await sendTelegramRaw(
    botToken,
    {
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard: [[{ text: "✅ 核准", callback_data: approveData }, { text: "❌ 拒絕", callback_data: rejectData }]] },
    },
    signal,
  );
}

async function sendTelegramRaw(botToken: string, body: unknown, signal?: AbortSignal): Promise<void> {
  const r = await postJson(`https://api.telegram.org/bot${botToken}/sendMessage`, {}, body, signal);
  if (r.status === 401) throw new PermanentError("Telegram Bot Token 不正確(API 回 401)——請到設定頁重新貼上 BotFather 給你的 token");
  if (r.status === 400 && /chat not found/i.test(r.text)) {
    throw new PermanentError("Telegram Chat ID 不正確(找不到聊天)——請先在 Telegram 跟你的 bot 說一句話，再到設定頁按「自動偵測」重抓 Chat ID");
  }
  // 真實常見情境：使用者封鎖了自己的 bot(或從沒對它按過「開始」)，Telegram 回 403。
  // 跟 sendSlack 下面的 403(action_prohibited)是同一類「外部服務主動拒絕」情境，
  // 這裡漏掉同款翻譯，使用者只會看到一段看不懂的原始英文，不知道要去 Telegram 解除封鎖。
  if (r.status === 403) {
    throw new PermanentError("Telegram 拒絕發送(403)，通常是你封鎖了這個 bot、或從沒對它按過「開始」——請到 Telegram 找到這個 bot，確認沒有封鎖它，並傳一句話開始對話");
  }
  if (r.status >= 500) throw new RetryableError(`Telegram 伺服器暫時錯誤(${r.status})`);
  if (r.status !== 200) throw new PermanentError(`Telegram 發送失敗(${r.status})：${r.text.slice(0, 150)}`);
}

/** 送一則 LINE 訊息(Messaging API push；給節點與設定頁的「測試發送」共用)。
 * to 可以是 userId(U 開頭)、groupId(C 開頭)或 roomId(R 開頭)——push API 同一個端點都吃。 */
export async function sendLine(channelAccessToken: string, to: string, text: string, signal?: AbortSignal): Promise<void> {
  const r = await postJson(
    "https://api.line.me/v2/bot/message/push",
    { Authorization: `Bearer ${channelAccessToken}` },
    { to, messages: [{ type: "text", text: text.slice(0, 5000) }] },
    signal,
  );
  if (r.status === 401) throw new PermanentError("LINE Channel Access Token 不正確(API 回 401)——請到設定頁照教學重新發行並貼上");
  if (r.status === 400 && /invalid.*to|not found/i.test(r.text)) {
    throw new PermanentError(
      "LINE 的傳送對象 ID 不正確——1對1 用 LINE Developers Basic settings 最下方的 Your user ID(U 開頭)；" +
      "群組用 groupId(C 開頭)：把官方帳號加進群組後在群組傳一句話，執行紀錄/伺服器 log 會印出 groupId",
    );
  }
  // 跟 sendTelegram 的 403 是同一類情境：使用者封鎖了官方帳號，LINE 拒絕發送。
  if (r.status === 403) {
    throw new PermanentError("LINE 拒絕發送(403)，通常是這個人封鎖了官方帳號——請到 LINE 找到這個官方帳號，確認沒有封鎖它");
  }
  if (r.status >= 500) throw new RetryableError(`LINE 伺服器暫時錯誤(${r.status})`);
  if (r.status !== 200) throw new PermanentError(`LINE 發送失敗(${r.status})：${r.text.slice(0, 150)}`);
}

/** 送一則 Slack 訊息(Incoming Webhook；給節點與設定頁的「測試發送」共用) */
export async function sendSlack(webhookUrl: string, text: string, signal?: AbortSignal): Promise<void> {
  let host = "";
  try { host = new URL(webhookUrl).hostname; } catch { /* 下面統一報錯 */ }
  if (host !== "hooks.slack.com") {
    throw new PermanentError("Slack Webhook 網址格式不對——應該是 https://hooks.slack.com/services/… 開頭，請到設定頁照教學重新貼上");
  }
  const r = await postJson(webhookUrl, {}, { text: text.slice(0, 4000) }, signal);
  if (r.status === 404 || /no_service|invalid_token/i.test(r.text)) {
    throw new PermanentError("Slack Webhook 已失效(404)——可能被刪除或重新產生過，請到 Slack 的 Incoming Webhooks 頁面重新複製網址到設定頁");
  }
  if (r.status === 403 || /action_prohibited/i.test(r.text)) {
    throw new PermanentError("Slack 拒絕了這個 Webhook(403)——請確認 App 還在工作區裡、Webhook 沒被管理員停用");
  }
  if (r.status >= 500) throw new RetryableError(`Slack 伺服器暫時錯誤(${r.status})`);
  if (r.status !== 200) throw new PermanentError(`Slack 發送失敗(${r.status})：${r.text.slice(0, 150)}`);
}


export const telegramNotifyNode: NodeDefinition = {
  type: "telegram-notify",
  category: "integration",
  label: "發 Telegram 通知",
  description: "把訊息發到使用者的 Telegram(例如「報表做好了」或把結果內容直接傳過去)。需要先在設定頁串接好 Telegram bot(有教學)。",
  icon: "✈️",
  outputs: "sent(是否已送出)",
  configSchema: [
    { key: "message", label: "訊息內容(可用 {{欄位}} 帶入上游資料)", type: "textarea", default: "" },
  ],
  secretFields: () => [
    { key: "telegramBotToken", label: "Telegram Bot Token", type: "password" },
    { key: "telegramChatId", label: "Telegram Chat ID", type: "text" },
  ],
  retryable: true,
  async execute(ctx) {
    // retryable 逾時重跑不等於「這次真的沒送到」——Telegram 可能其實已經收到，只是等回應逾時，
    // 重跑會發第二次一模一樣的通知。
    const key = idempotencyKey(ctx);
    const state = getAttemptState(key);
    if (state === "completed") {
      ctx.log("這則 Telegram 通知在這次執行裡已經真的發送過(重試時偵測到)，不再重複發送");
      return { output: getCompletedAction(key)! };
    }
    if (state === "pending") {
      throw new PermanentError("上次發送這則 Telegram 通知時沒有等到明確的成功或失敗回應(可能其實已經送達)，為了避免重複發送，不會自動重試——請自行確認是否已收到，若確實沒收到再手動重新執行這個步驟");
    }
    const token = ctx.secrets.telegramBotToken;
    const chatId = ctx.secrets.telegramChatId;
    if (!token || !chatId) throw new PermanentError(`尚未填入 Telegram Bot Token / Chat ID——${needsSetupHint("Telegram")}`);
    const message = cfgStr(ctx, "message").trim();
    if (!message) throw new PermanentError("沒有設定要發送的訊息內容");
    markAttemptStarted(key);
    await sendTelegram(token, chatId, message, ctx.cancelSignal);
    ctx.log(`已發送 Telegram 訊息(${message.length} 字)`);
    const output = { ...ctx.input, sent: true };
    recordCompletedAction(key, output);
    return { output };
  },
};

export const slackNotifyNode: NodeDefinition = {
  type: "slack-notify",
  category: "integration",
  label: "發 Slack 通知",
  description: "把訊息發到 Slack 頻道(例如「報表做好了」或把結果內容直接傳過去)。需要先在設定頁貼上 Slack Incoming Webhook 網址(有教學，2 分鐘)。",
  icon: "📣",
  outputs: "sent(是否已送出)",
  configSchema: [
    { key: "message", label: "訊息內容(可用 {{欄位}} 帶入上游資料)", type: "textarea", default: "" },
  ],
  secretFields: () => [
    { key: "slackWebhookUrl", label: "Slack Incoming Webhook 網址", type: "password" },
  ],
  retryable: true,
  async execute(ctx) {
    const key = idempotencyKey(ctx);
    const state = getAttemptState(key);
    if (state === "completed") {
      ctx.log("這則 Slack 通知在這次執行裡已經真的發送過(重試時偵測到)，不再重複發送");
      return { output: getCompletedAction(key)! };
    }
    if (state === "pending") {
      throw new PermanentError("上次發送這則 Slack 通知時沒有等到明確的成功或失敗回應(可能其實已經送達)，為了避免重複發送，不會自動重試——請自行確認是否已收到，若確實沒收到再手動重新執行這個步驟");
    }
    const url = ctx.secrets.slackWebhookUrl;
    if (!url) throw new PermanentError(`尚未填入 Slack Webhook 網址——${needsSetupHint("Slack")}`);
    const message = cfgStr(ctx, "message").trim();
    if (!message) throw new PermanentError("沒有設定要發送的訊息內容");
    markAttemptStarted(key);
    await sendSlack(url, message, ctx.cancelSignal);
    ctx.log(`已發送 Slack 訊息(${message.length} 字)`);
    const output = { ...ctx.input, sent: true };
    recordCompletedAction(key, output);
    return { output };
  },
};

export const lineNotifyNode: NodeDefinition = {
  type: "line-notify",
  category: "integration",
  label: "發 LINE 通知",
  description:
    "把訊息發到使用者的 LINE 或 LINE 群組(例如「報表做好了」或把結果內容直接傳過去)。" +
    "需要先在設定頁串接好 LINE 官方帳號(有教學)。發到群組：把官方帳號加進群組，" +
    "「傳送對象」填群組 ID(C 開頭)或 {{groupId}}(LINE 觸發的流程可直接回到來源群組)。",
  icon: "💬",
  outputs: "sent(是否已送出)",
  configSchema: [
    { key: "message", label: "訊息內容(可用 {{欄位}} 帶入上游資料)", type: "textarea", default: "" },
    {
      key: "target",
      label: "傳送對象(留空=設定頁的 User ID；群組填 groupId 或 {{groupId}})",
      type: "text",
      default: "",
    },
  ],
  secretFields: () => [
    { key: "lineChannelAccessToken", label: "LINE Channel Access Token", type: "password" },
    { key: "lineUserId", label: "LINE 你的 User ID", type: "text" },
  ],
  retryable: true,
  async execute(ctx) {
    const key = idempotencyKey(ctx);
    const state = getAttemptState(key);
    if (state === "completed") {
      ctx.log("這則 LINE 通知在這次執行裡已經真的發送過(重試時偵測到)，不再重複發送");
      return { output: getCompletedAction(key)! };
    }
    if (state === "pending") {
      throw new PermanentError("上次發送這則 LINE 通知時沒有等到明確的成功或失敗回應(可能其實已經送達)，為了避免重複發送，不會自動重試——請自行確認是否已收到，若確實沒收到再手動重新執行這個步驟");
    }
    const token = ctx.secrets.lineChannelAccessToken;
    const target = cfgStr(ctx, "target").trim() || ctx.secrets.lineUserId;
    if (!token || !target) throw new PermanentError(`尚未填入 LINE Channel Access Token / 傳送對象——${needsSetupHint("LINE")}`);
    const message = cfgStr(ctx, "message").trim();
    if (!message) throw new PermanentError("沒有設定要發送的訊息內容");
    markAttemptStarted(key);
    await sendLine(token, target, message, ctx.cancelSignal);
    ctx.log(`已發送 LINE 訊息(${message.length} 字)給 ${target.startsWith("C") ? "群組" : target.startsWith("R") ? "聊天室" : "個人"} ${target.slice(0, 6)}…`);
    const output = { ...ctx.input, sent: true };
    recordCompletedAction(key, output);
    return { output };
  },
};
