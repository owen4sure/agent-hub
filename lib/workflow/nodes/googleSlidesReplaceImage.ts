import fs from "node:fs";
import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { resolvePresentationId } from "./googleSlidesRefresh";

/**
 * 把簡報某一頁上的那張圖換成本機產生的新圖(通常來自「Excel 範圍截圖」)。
 *
 * **為什麼走 Apps Script 而不是 Slides API**：Slides API 的換圖只吃公開網址，餵不進圖片內容本身。
 * 純 API 的做法一定要「上傳到雲端硬碟 → 設成任何人可讀 → 換圖 → 刪掉」，中間那幾秒資料是公開的，
 * 而且企業版 Workspace 常常直接禁止對外分享(那條路會失敗)。Apps Script 的 `replaceImage(blob)`
 * 可以直接吃圖片內容，全程不需要公開連結——腳本部署在使用者自己的帳號下，權限也是他自己的。
 * 詳見 `lib/googleSlidesImageScriptTemplate.ts`。
 */

export const SLIDES_IMAGE_TOKEN_KEY = "slidesImageScriptToken";

/** Apps Script 回應的形狀(它一律回 200，成敗看 ok) */
interface ScriptReply { ok?: boolean; error?: string; page?: number; width?: number; height?: number }

export const googleSlidesReplaceImageNode: NodeDefinition = {
  type: "google-slides-replace-image",
  category: "integration",
  label: "換掉簡報上的圖片",
  description:
    "把 Google 簡報中某一頁上的圖片，換成這條流程剛產生的圖片(例如 Excel 範圍截圖)。"
    + "用頁面標題找頁、且該頁必須剛好只有一張圖片，避免換錯。需要先部署「換簡報圖片」的 Apps Script。",
  icon: "🖼️",
  configSchema: [
    { key: "scriptUrl", label: "換圖用的 Apps Script 網址(⋯→設定裡有部署教學)", type: "text", default: "" },
    { key: "presentationUrl", label: "要更新的簡報網址或 ID(可用 {{fileId}} 等上游欄位)", type: "text", default: "" },
    { key: "pageTitleContains", label: "目標頁面的標題要包含的文字", type: "text", default: "" },
    { key: "imagePath", label: "新圖片的檔案路徑", type: "text", default: "{{rangeImagePath}}" },
  ],
  // 宣告出來，設定頁才會自動長出這個輸入框(AGENTS.md 鐵則 16：沒宣告的帳密欄位使用者根本沒地方填)
  secretFields: () => [
    { key: SLIDES_IMAGE_TOKEN_KEY, label: "換圖腳本的驗證碼(要跟 Apps Script 裡的 AGENT_HUB_TOKEN 一致)", type: "password" },
  ],
  outputs: "replacedOnPage(換掉的是第幾頁)",
  // 換圖失敗幾乎都是設定問題(找不到頁、那頁不只一張圖、驗證碼不對)，原樣重跑不會變好。
  retryable: false,
  async execute(ctx) {
    const scriptUrl = cfgStr(ctx, "scriptUrl").trim();
    if (!/^https:\/\/script\.google\.com\//.test(scriptUrl)) {
      throw new PermanentError(`這不是 Apps Script 的網址：「${scriptUrl || "(空的)"}」——請貼部署後拿到的 /exec 網址`);
    }
    const presentationRaw = cfgStr(ctx, "presentationUrl").trim();
    const presentationId = resolvePresentationId(presentationRaw);
    if (!presentationId) {
      throw new PermanentError(`看不懂這個簡報網址/ID：「${presentationRaw}」——請貼 Google 簡報網址或直接貼檔案 ID`);
    }
    const pageTitleContains = cfgStr(ctx, "pageTitleContains").trim();
    if (!pageTitleContains) throw new PermanentError("沒有指定要用哪個標題找頁面——避免換錯頁，這個欄位不能空白");

    const imagePath = cfgStr(ctx, "imagePath").trim();
    if (!imagePath || !fs.existsSync(imagePath)) {
      throw new PermanentError(`找不到要貼上去的圖片：${imagePath || "(路徑是空的)"}——請確認上游的截圖步驟有成功(例如 {{rangeImagePath}})`);
    }
    const token = ctx.secrets[SLIDES_IMAGE_TOKEN_KEY];
    if (!token) {
      throw new PermanentError(
        "還沒設定換圖腳本的驗證碼。到流程頁「⋯ → 設定」的「換掉簡報圖片」卡片，複製腳本部署一次，並把驗證碼填進來。",
      );
    }

    const imageBase64 = fs.readFileSync(imagePath).toString("base64");
    ctx.log(`準備把「${pageTitleContains}」那一頁的圖換成 ${Math.round(imageBase64.length / 1024)}KB 的新圖`);

    // 安全試跑：不送出換圖請求。這一步會真的改到使用者給主管看的簡報，
    // 「只測試不改資料」的承諾必須是「根本沒送出」，不是「事後再改回來」。
    if (ctx.dryRun) {
      ctx.log("🔒 只讀驗證：圖片已產生、參數都齊全，但沒有真的更新簡報");
      return { output: { ...ctx.input, replacedOnPage: null, validationOnly: true } };
    }

    let reply: ScriptReply;
    try {
      const res = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "replaceSlideImage", presentationId, pageTitleContains, imageBase64 }),
        signal: ctx.cancelSignal,
        redirect: "follow", // Apps Script 的 /exec 一定會 302 到 googleusercontent
      });
      const text = await res.text();
      try {
        reply = JSON.parse(text) as ScriptReply;
      } catch {
        // 最常見的原因是部署權限沒設成「任何人」——Google 會回一頁 HTML 登入畫面而不是 JSON。
        throw new PermanentError(
          "換圖腳本沒有回傳預期的結果，通常是部署時「誰可以存取」沒有選成「任何人」。"
          + `請回到 Apps Script 重新部署一次。原始回應開頭：${text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 120)}`,
        );
      }
    } catch (err) {
      if (err instanceof PermanentError) throw err;
      throw new PermanentError(`連不到換圖腳本：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!reply.ok) throw new PermanentError(`換圖失敗：${reply.error ?? "腳本沒有說明原因"}`);
    ctx.log(`已換掉第 ${reply.page} 頁的圖片`);
    return { output: { ...ctx.input, replacedOnPage: reply.page ?? null } };
  },
};
