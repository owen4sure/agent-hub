import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTelegram, sendLine } from "./notify";
import { PermanentError } from "../types";

/**
 * 真實情境：使用者封鎖了自己的 Telegram bot(或從沒對它按過「開始」)，Telegram API 對
 * sendMessage 回 403 + "Forbidden: bot was blocked by the user"。這是很常見的失敗原因，
 * 但舊版只認 401(token 錯)和 400+chat not found，403 落到通用分支只丟一段原始英文，
 * 使用者看不懂也不知道要去 Telegram 解除封鎖——Slack 那邊的 403(action_prohibited)
 * 早就有專門翻譯，Telegram 這條路徑漏掉了同一類情境。
 */
test("sendTelegram：bot 被使用者封鎖(403)要翻成『去 Telegram 解除封鎖』的具體指引，不是丟原始英文", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), { status: 403 })
  ) as typeof fetch;
  try {
    await assert.rejects(
      () => sendTelegram("fake-token", "12345", "測試訊息"),
      (err: unknown) => {
        assert.ok(err instanceof PermanentError);
        assert.match(err.message, /封鎖/);
        assert.match(err.message, /Telegram/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendTelegram：其他未特別辨識的錯誤仍原樣附上狀態碼與原始文字，不吞掉細節", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("some other error", { status: 418 })) as typeof fetch;
  try {
    await assert.rejects(
      () => sendTelegram("fake-token", "12345", "測試訊息"),
      (err: unknown) => {
        assert.ok(err instanceof PermanentError);
        assert.match(err.message, /418/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 同一類情境：使用者封鎖了官方帳號，LINE push API 回 403。跟上面 Telegram 的 403 是同一種
// 「外部服務因為使用者自己封鎖而拒絕」，翻譯成具體指引才知道要去 LINE 解除封鎖，不是丟原始英文。
test("sendLine：使用者封鎖官方帳號(403)要翻成『去 LINE 解除封鎖』的具體指引，不是丟原始英文", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "You are not allowed to send messages to this user" }), { status: 403 })
  ) as typeof fetch;
  try {
    await assert.rejects(
      () => sendLine("fake-token", "U1234567890", "測試訊息"),
      (err: unknown) => {
        assert.ok(err instanceof PermanentError);
        assert.match(err.message, /封鎖/);
        assert.match(err.message, /LINE/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
