import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { resolvePresentationId } from "./googleSlidesRefresh";
import { SLIDES_IMAGE_TOKEN_KEY } from "./googleSlidesReplaceImage";

/**
 * 把「另一份簡報」裡指定標題的那一頁，原封不動複製到目標簡報、取代目標簡報同標題的那頁。
 *
 * **為什麼走 Apps Script 而不是 Slides API**：Slides REST API 沒有「跨簡報複製整頁」的功能——
 * 用 API 硬做等於逐元素重建(文字框/圖片/表格/樣式各自搬)，任何一種元素漏掉就是走樣。
 * Apps Script 的 `insertSlide(index, slide)` 可以吃另一份簡報的頁面物件、Google 自己保證複製
 * 完整度。腳本跟「換掉簡報上的圖片」共用同一支部署(copySlideByTitle 動作、同一個驗證碼)，
 * 使用者不用多設定任何東西。
 *
 * 這個能力以前只存在於腳本裡、沒有節點型別，AI 建圖看不到它，只能用 REST 硬幹出一條
 * 註定走樣的路(實測踩過)——包成一級節點，builder 的可用節點清單就會自動帶到它。
 */

/** Apps Script 回應的形狀(它一律回 200，成敗看 ok) */
interface ScriptReply { ok?: boolean; error?: string; sourcePage?: number; targetPage?: number }

export const googleSlidesCopyPageNode: NodeDefinition = {
  type: "google-slides-copy-page",
  category: "integration",
  label: "複製簡報頁面",
  description:
    "把另一份 Google 簡報裡指定標題的那一頁「整頁原封不動」複製到目標簡報，取代目標簡報同標題的那一頁"
    + "(先插入新頁、確認成功才移除舊頁)。兩邊都用頁面標題精準找頁，找不到或有多頁同標題都會明確報錯。"
    + "跟「換掉簡報上的圖片」共用同一支 Apps Script 部署。",
  icon: "📑",
  configSchema: [
    { key: "scriptUrl", label: "Apps Script 網址(跟「換掉簡報上的圖片」同一支)", type: "text", default: "" },
    { key: "sourcePresentationUrl", label: "來源簡報網址或 ID(可用 {{fileId}} 等上游欄位)", type: "text", default: "" },
    { key: "targetPresentationUrl", label: "目標簡報網址或 ID(要被更新的那份)", type: "text", default: "" },
    { key: "sourceSlideTitle", label: "來源頁面的標題(用它在來源簡報找那一頁)", type: "text", default: "" },
    { key: "targetSlideTitle", label: "目標頁面的標題(留空=跟來源相同)", type: "text", default: "" },
  ],
  // 宣告出來，設定頁才會自動長出這個輸入框(AGENTS.md 鐵則 16)
  secretFields: () => [
    { key: SLIDES_IMAGE_TOKEN_KEY, label: "換圖腳本的驗證碼(要跟 Apps Script 裡的 AGENT_HUB_TOKEN 一致)", type: "password" },
  ],
  outputs: "copiedFromPage(來源第幾頁)、copiedToPage(貼到目標第幾頁)",
  // 失敗幾乎都是設定問題(找不到頁/標題不唯一/驗證碼不對)，原樣重跑不會變好。
  retryable: false,
  async execute(ctx) {
    const scriptUrl = cfgStr(ctx, "scriptUrl").trim();
    if (!/^https:\/\/script\.google\.com\//.test(scriptUrl)) {
      throw new PermanentError(`這不是 Apps Script 的網址：「${scriptUrl || "(空的)"}」——請用「換掉簡報上的圖片」設定卡部署後拿到的 /exec 網址`);
    }
    const sourceRaw = cfgStr(ctx, "sourcePresentationUrl").trim();
    const sourcePresentationId = resolvePresentationId(sourceRaw);
    if (!sourcePresentationId) {
      throw new PermanentError(`看不懂來源簡報的網址/ID：「${sourceRaw}」——請貼 Google 簡報網址或直接貼檔案 ID`);
    }
    const targetRaw = cfgStr(ctx, "targetPresentationUrl").trim();
    const targetPresentationId = resolvePresentationId(targetRaw);
    if (!targetPresentationId) {
      throw new PermanentError(`看不懂目標簡報的網址/ID：「${targetRaw}」——請貼 Google 簡報網址或直接貼檔案 ID`);
    }
    if (sourcePresentationId === targetPresentationId) {
      throw new PermanentError("來源和目標是同一份簡報——請確認上游有抓到正確的來源檔案");
    }
    const sourceSlideTitle = cfgStr(ctx, "sourceSlideTitle").trim();
    if (!sourceSlideTitle) throw new PermanentError("沒有指定來源頁面的標題——避免複製錯頁，這個欄位不能空白");
    const targetSlideTitle = cfgStr(ctx, "targetSlideTitle").trim() || sourceSlideTitle;
    const token = ctx.secrets[SLIDES_IMAGE_TOKEN_KEY];
    if (!token) {
      throw new PermanentError(
        "還沒設定腳本的驗證碼。到流程頁「⚙ 這條流程的設定」裡的「換掉簡報上的圖片」完成一次部署(這個節點共用同一支腳本與驗證碼)。",
      );
    }

    ctx.log(`準備把來源簡報的「${sourceSlideTitle}」頁複製過來，取代目標簡報的「${targetSlideTitle}」頁`);

    // 安全試跑：不送出複製請求。這一步會真的改到使用者拿去開會的簡報，
    // 「只測試不改資料」的承諾必須是「根本沒送出」。
    if (ctx.dryRun) {
      ctx.log("🔒 只讀驗證：參數都齊全，但沒有真的複製頁面");
      return { output: { ...ctx.input, copiedFromPage: null, copiedToPage: null, validationOnly: true } };
    }

    let reply: ScriptReply;
    try {
      const res = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token, action: "copySlideByTitle",
          sourcePresentationId, targetPresentationId, sourceSlideTitle, targetSlideTitle,
        }),
        signal: ctx.cancelSignal,
        redirect: "follow", // Apps Script 的 /exec 一定會 302 到 googleusercontent
      });
      const text = await res.text();
      try {
        reply = JSON.parse(text) as ScriptReply;
      } catch {
        throw new PermanentError(
          "腳本沒有回傳預期的結果，通常是部署時「誰可以存取」沒有選成「任何人」。"
          + `請用「換掉簡報上的圖片」設定卡重新部署一次。原始回應開頭：${text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 120)}`,
        );
      }
    } catch (err) {
      if (err instanceof PermanentError) throw err;
      throw new PermanentError(`連不到簡報腳本：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!reply.ok) throw new PermanentError(`複製頁面失敗：${reply.error ?? "腳本沒有說明原因"}`);
    ctx.log(`已把來源第 ${reply.sourcePage} 頁複製到目標第 ${reply.targetPage} 頁(舊頁已移除)`);
    return { output: { ...ctx.input, copiedFromPage: reply.sourcePage ?? null, copiedToPage: reply.targetPage ?? null } };
  },
};
