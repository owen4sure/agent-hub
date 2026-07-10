import { NextResponse } from "next/server";
import { getSharedSecrets, setSharedSecrets } from "@/lib/settingsStore";
import { sendTelegram, sendLine, sendSlack } from "@/lib/workflow/nodes/notify";
import { sendEmailSmtp } from "@/lib/workflow/nodes/sendEmail";
import { appendViaScript } from "@/lib/workflow/nodes/googleSheet";

/**
 * 通知串接的「測試發送」與 Telegram Chat ID「自動偵測」。
 * 串 bot 對一般人最挫折的就是「填完不知道有沒有成功」——這裡讓設定頁一鍵驗證，
 * 用的發送函式跟正式節點完全同一份，測試過=流程裡一定也通。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;
  const secrets = getSharedSecrets();

  try {
    if (action === "telegram-test") {
      if (!secrets.telegramBotToken || !secrets.telegramChatId) {
        return NextResponse.json({ ok: false, message: "請先填入 Bot Token 並偵測/填入 Chat ID，儲存後再測試" });
      }
      await sendTelegram(secrets.telegramBotToken, secrets.telegramChatId, "✅ Agent Hub 測試訊息：Telegram 串接成功！之後流程就能發通知到這裡。");
      return NextResponse.json({ ok: true, message: "已發送！去 Telegram 看看有沒有收到" });
    }

    if (action === "telegram-detect-chat") {
      const token = secrets.telegramBotToken;
      if (!token) return NextResponse.json({ ok: false, message: "請先填入 Bot Token 並儲存，再按自動偵測" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      let data: { ok?: boolean; result?: { message?: { chat?: { id?: number; first_name?: string; username?: string } } }[] };
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: controller.signal });
        if (res.status === 401) return NextResponse.json({ ok: false, message: "Bot Token 不正確(API 回 401)，請重新貼上 BotFather 給你的 token" });
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }
      const chats = (data.result ?? []).map((u) => u.message?.chat).filter((c): c is NonNullable<typeof c> => Boolean(c?.id));
      const latest = chats[chats.length - 1];
      if (!latest) {
        return NextResponse.json({ ok: false, message: "還偵測不到——請先在 Telegram 裡找到你的 bot、跟它說任意一句話(這步是必要的，不然 bot 不能主動傳訊息給你)，再按一次" });
      }
      setSharedSecrets({ telegramChatId: String(latest.id) });
      const who = latest.first_name || latest.username || latest.id;
      return NextResponse.json({ ok: true, message: `偵測到了！Chat ID 已自動填入(來自「${who}」的訊息)，直接按「測試發送」驗證吧`, chatId: String(latest.id) });
    }

    if (action === "line-test") {
      if (!secrets.lineChannelAccessToken || !secrets.lineUserId) {
        return NextResponse.json({ ok: false, message: "請先照教學填入 Channel Access Token 和你的 User ID，儲存後再測試" });
      }
      await sendLine(secrets.lineChannelAccessToken, secrets.lineUserId, "✅ Agent Hub 測試訊息：LINE 串接成功！之後流程就能發通知到這裡。");
      return NextResponse.json({ ok: true, message: "已發送！去 LINE 看看有沒有收到" });
    }

    if (action === "slack-test") {
      if (!secrets.slackWebhookUrl) {
        return NextResponse.json({ ok: false, message: "請先貼上 Slack Incoming Webhook 網址再測試" });
      }
      await sendSlack(secrets.slackWebhookUrl, "✅ Agent Hub 測試訊息：Slack 串接成功！之後流程就能發通知到這個頻道。");
      return NextResponse.json({ ok: true, message: "已發送！去 Slack 頻道看看有沒有收到" });
    }

    if (action === "sheet-append-test") {
      if (!secrets.sheetAppendUrl) {
        return NextResponse.json({ ok: false, message: "請先照教學部署 Apps Script、貼上寫入網址再測試" });
      }
      const r = await appendViaScript(secrets.sheetAppendUrl, ["Agent Hub 測試寫入", new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }), "✅ 串接成功"], "");
      return NextResponse.json({ ok: true, message: `已寫入${r.row ? `第 ${r.row} 列` : "一列"}！打開試算表看最下面(這列測試資料可自行刪除)` });
    }

    if (action === "email-test") {
      if (!secrets.smtpHost || !secrets.smtpAccount || !secrets.smtpPassword) {
        return NextResponse.json({ ok: false, message: "請先填好 SMTP 主機/帳號/密碼再測試(Gmail 要用「應用程式密碼」，不是登入密碼)" });
      }
      await sendEmailSmtp(
        { host: secrets.smtpHost, port: secrets.smtpPort ?? "", account: secrets.smtpAccount, password: secrets.smtpPassword },
        { to: secrets.smtpAccount, subject: "Agent Hub 測試信", text: "✅ Email 串接成功！之後流程就能用「寄 Email」步驟把結果或附件寄出。" },
      );
      return NextResponse.json({ ok: true, message: `已寄出測試信到 ${secrets.smtpAccount}，去收信匣看看(也檢查垃圾信)` });
    }

    return NextResponse.json({ ok: false, message: "不認識的動作" }, { status: 400 });
  } catch (err) {
    // sendTelegram/sendLine 拋的錯誤本身就是給人看的中文(含下一步指引)，直接呈現
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, message: msg.slice(0, 300) });
  }
}
