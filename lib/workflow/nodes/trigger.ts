import type { NodeDefinition } from "../types";

/**
 * 流程起點。觸發參數(在 workflow.triggerParams 定義)已由引擎解析後放進 ctx.input，這裡原樣輸出給下游。
 *
 * 觸發方式(四種，可並存)：
 * 1. 手動：畫布按「▶ 執行」。
 * 2. 排程：觸發面板設時間(cron)，時間到自動跑。
 * 3. 資料夾監聽：config.watchPath 填一個資料夾的絕對路徑，**設為正式後**有新檔案掉進去就自動跑一次，
 *    下游用 {{filePath}}(完整路徑)/{{fileName}}(檔名)拿到那個檔案(見 lib/watchers.ts)。
 * 4. Webhook：觸發面板啟用後拿到一個帶秘密 token 的網址，其他程式對它 POST 就觸發，
 *    POST 的 JSON 欄位會變成下游可用的 {{欄位}}(見 app/api/hooks)。
 */
export const triggerNode: NodeDefinition = {
  type: "trigger",
  category: "trigger",
  label: "開始",
  description:
    "workflow 的起點。支援四種觸發：手動執行、排程(在觸發面板設定)、資料夾監聽(watchPath 填資料夾絕對路徑，有新檔案掉進去就自動跑一次，下游用 {{filePath}}/{{fileName}} 拿到那個檔案；流程要設為正式才會開始監聽)、Webhook(在觸發面板啟用後取得專屬網址，外部程式 POST 的 JSON 欄位會直接變成下游可用的 {{欄位}})。",
  icon: "⏰",
  configSchema: [
    { key: "watchPath", label: "監聽資料夾(絕對路徑，留空=不監聽)", type: "text", allowEmpty: true, help: "有新檔案掉進這個資料夾就自動執行一次(流程要設為正式)。下游用 {{filePath}} 取得新檔案路徑。" },
    { key: "watchPattern", label: "檔名需包含(留空=任何檔案)", type: "text", allowEmpty: true, help: "例如填「.xlsx」就只有 Excel 檔會觸發" },
  ],
  outputs: "觸發參數的所有欄位；資料夾監聽觸發時多 filePath(新檔案完整路徑)、fileName(檔名)；webhook 觸發時多 POST 進來的 JSON 欄位",
  retryable: false,
  async execute(ctx) {
    return { output: { ...ctx.input } };
  },
};
