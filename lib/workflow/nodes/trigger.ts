import type { NodeDefinition } from "../types";

/**
 * 流程起點。觸發參數(在 workflow.triggerParams 定義)已由引擎解析後放進 ctx.input，這裡原樣輸出給下游。
 *
 * 觸發方式(可並存)：
 * 1. 手動：畫布按「▶ 執行」。
 * 2. 排程：觸發面板設時間(cron)，時間到自動跑。
 * 3. 資料夾監聽：config.watchPath 填一個資料夾的絕對路徑，**設為正式後**有新檔案掉進去就自動跑一次，
 *    下游用 {{filePath}}(完整路徑)/{{fileName}}(檔名)拿到那個檔案(見 lib/watchers.ts)。
 * 4. Webhook：觸發面板啟用後拿到一個帶秘密 token 的網址，其他程式對它 POST 就觸發，
 *    POST 的 JSON 欄位會變成下游可用的 {{欄位}}(見 app/api/hooks)。
 * 5. 收信觸發：config.mailWatch="on"，**設為正式後**每分鐘用 IMAP 掃信箱，符合 寄件人/主旨 篩選的
 *    新信就觸發，下游拿 {{from}}/{{subject}}/{{date}}/{{body}}，有附件多 {{filePath}}/{{fileName}}/
 *    {{attachmentCount}}(見 lib/mailWatcher.ts；IMAP 帳密在設定頁)。
 * 6. Telegram 訊息：config.telegramWatch="on"，**設為正式後**綁定的 Chat 傳訊息給 bot 就觸發，
 *    下游拿 {{message}}/{{chatId}}/{{fromName}}/{{messageId}}(見 lib/telegramPoller.ts)。
 * 7. LINE 訊息：觸發面板啟用後拿到 webhook 網址(要經隧道開成公網 HTTPS)填進 LINE Developers，
 *    有人傳訊息給官方帳號就觸發，下游拿 {{message}}/{{userId}}/{{replyToken}}(見 app/api/line-hooks)。
 */
export const triggerNode: NodeDefinition = {
  type: "trigger",
  category: "trigger",
  label: "開始",
  description:
    "workflow 的起點。支援七種觸發：手動執行、排程(在觸發面板設定)、資料夾監聽(watchPath 填資料夾絕對路徑，有新檔案掉進去就自動跑一次，下游用 {{filePath}}/{{fileName}} 拿到那個檔案)、Webhook(在觸發面板啟用後取得專屬網址，外部程式 POST 的 JSON 欄位會直接變成下游可用的 {{欄位}})、收信觸發(mailWatch 設 on，有符合篩選的新 email 就跑，下游用 {{from}}/{{subject}}/{{body}}，附件用 {{filePath}})、Telegram 訊息(telegramWatch 設 on，傳訊息給 bot 就跑，下游用 {{message}})、LINE 訊息(在觸發面板啟用，下游用 {{message}})。監聽/收信/Telegram 都要流程「設為正式」才會開始。",
  icon: "⏰",
  configSchema: [
    { key: "watchPath", label: "監聽資料夾(絕對路徑，留空=不監聽)", type: "text", allowEmpty: true, help: "有新檔案掉進這個資料夾就自動執行一次(流程要設為正式)。下游用 {{filePath}} 取得新檔案路徑。" },
    { key: "watchPattern", label: "檔名需包含(留空=任何檔案)", type: "text", allowEmpty: true, help: "例如填「.xlsx」就只有 Excel 檔會觸發" },
    { key: "mailWatch", label: "收信觸發", type: "select", options: ["off=關閉", "on=開啟"], default: "off", help: "開啟後(流程要設為正式)有符合篩選的新 email 就自動跑。IMAP 帳密在設定頁「收信(IMAP)」卡片填。" },
    { key: "mailSubjectFilter", label: "主旨需包含(留空=任何主旨)", type: "text", allowEmpty: true },
    { key: "mailFromFilter", label: "寄件人需包含(留空=任何人)", type: "text", allowEmpty: true },
    { key: "mailFolder", label: "信箱資料夾(留空=收件匣)", type: "text", allowEmpty: true },
    { key: "telegramWatch", label: "Telegram 訊息觸發", type: "select", options: ["off=關閉", "on=開啟"], default: "off", help: "開啟後(流程要設為正式)傳訊息給你的 bot 就自動跑。只接受設定頁綁定的 Chat ID。" },
    { key: "telegramKeyword", label: "訊息需包含(留空=任何訊息)", type: "text", allowEmpty: true, help: "例如填「記帳」就只有含「記帳」的訊息會觸發這條流程" },
    { key: "lineWatch", label: "LINE 訊息觸發", type: "select", options: ["off=關閉", "on=開啟"], default: "off", help: "開啟後到觸發面板取得 webhook 網址(要經隧道開成公網 HTTPS)填進 LINE Developers。" },
  ],
  outputs:
    "觸發參數的所有欄位；資料夾監聽觸發時多 filePath(新檔案完整路徑)、fileName(檔名)；webhook 觸發時多 POST 進來的 JSON 欄位；收信觸發時多 from(寄件人)、subject(主旨)、date(收信時間)、body(信件內文)、filePath(第一個附件路徑;沒附件=空)、fileName(附件檔名)、attachmentCount(附件數)；Telegram 觸發時多 message(訊息文字)、chatId、fromName(傳訊者)、messageId；LINE 觸發時多 message(訊息文字)、userId、replyToken",
  secretFields: (config) => {
    const fields: { key: string; label: string; type: "text" | "password" }[] = [];
    if (config.mailWatch === "on") {
      fields.push(
        { key: "imapHost", label: "IMAP 主機(如 imap.gmail.com)", type: "text" },
        { key: "imapPort", label: "IMAP 連接埠(留空=993)", type: "text" },
        { key: "imapAccount", label: "Email 帳號", type: "text" },
        { key: "imapPassword", label: "Email 密碼(Gmail 要用應用程式密碼)", type: "password" },
      );
    }
    if (config.telegramWatch === "on") {
      fields.push(
        { key: "telegramBotToken", label: "Telegram Bot Token", type: "password" },
        { key: "telegramChatId", label: "Telegram Chat ID", type: "text" },
      );
    }
    if (config.lineWatch === "on") {
      fields.push({ key: "lineChannelSecret", label: "LINE Channel Secret(驗 webhook 簽章用)", type: "password" });
    }
    return fields;
  },
  retryable: false,
  async execute(ctx) {
    return { output: { ...ctx.input } };
  },
};
