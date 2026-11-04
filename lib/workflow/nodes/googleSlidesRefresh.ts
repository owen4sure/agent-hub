import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { parseGoogleDocUrl } from "../../googleExport";
import { parseSheetUrl } from "./googleSheet";
import { getGoogleAccessToken, getPresentation, findSheetsChartsInPresentation, refreshSheetsCharts } from "../../googleSlidesApi";

const NEED_SETUP = "Google 簡報的第一次授權還沒完成——對話會出現逐步教學與三個安全輸入欄位；完成後再按一次測試即可。";

/** 接受完整 Google 簡報／雲端硬碟網址，或直接就是一段 ID。 */
export function resolvePresentationId(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const asDoc = parseGoogleDocUrl(value);
  if (asDoc && (asDoc.kind === "presentation")) return asDoc.id;
  try {
    const u = new URL(value);
    // drive.google.com/file/d/{id}/view 這種一般雲端硬碟網址(Google 簡報檔在雲端硬碟列表裡常見)
    if (u.hostname === "drive.google.com") {
      const m = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (m) return m[1];
    }
    return null; // 是網址但不是認得的形式，不要用猜的
  } catch {
    // 不是網址，接受看起來像 Google 檔案 ID 的裸字串(英數/-/_，夠長)
    return /^[a-zA-Z0-9_-]{15,}$/.test(value) ? value : null;
  }
}

export const googleSlidesRefreshNode: NodeDefinition = {
  type: "google-slides-refresh",
  category: "integration",
  label: "重新整理 Google 簡報圖表",
  description: "直接更新這份 Google 簡報裡、連到指定試算表的圖表。不用開瀏覽器找按鈕；第一次使用時，對話會一步一步帶你完成 Google 的一次性授權。",
  icon: "📊",
  outputs: "refreshedCount(重新整理了幾個圖表)、pageTitles(這些圖表所在頁面的標題，逗號分隔)",
  configSchema: [
    { key: "presentationUrl", label: "要更新的 Google 簡報網址", type: "text", default: "" },
    { key: "spreadsheetUrl", label: "圖表資料來源的 Google 試算表網址", type: "text", default: "" },
    { key: "pageTitleContains", label: "選填：頁面標題要包含的文字(同一份試算表在多頁都有圖表時用來篩選)", type: "text", default: "", allowEmpty: true },
  ],
  secretFields: () => [
    { key: "googleOAuthClientId", label: "Google 授權代碼 1：Client ID", type: "text" },
    { key: "googleOAuthClientSecret", label: "Google 授權代碼 2：Client Secret", type: "password" },
    { key: "googleOAuthRefreshToken", label: "Google 授權代碼 3：Refresh Token", type: "password" },
  ],
  retryable: true,
  async execute(ctx) {
    const clientId = ctx.secrets.googleOAuthClientId;
    const clientSecret = ctx.secrets.googleOAuthClientSecret;
    const refreshToken = ctx.secrets.googleOAuthRefreshToken;
    if (!clientId || !clientSecret || !refreshToken) throw new PermanentError(NEED_SETUP);

    const presentationRaw = cfgStr(ctx, "presentationUrl").trim();
    const presentationId = resolvePresentationId(presentationRaw);
    if (!presentationId) throw new PermanentError(`看不懂這個簡報網址/ID：「${presentationRaw}」——請貼 Google 簡報網址、雲端硬碟檔案網址，或直接貼檔案 ID`);

    const spreadsheetRaw = cfgStr(ctx, "spreadsheetUrl").trim();
    const parsedSheet = parseSheetUrl(spreadsheetRaw);
    if (!parsedSheet) throw new PermanentError(`看不懂這個試算表網址：「${spreadsheetRaw}」——請貼完整的 Google 試算表網址`);

    const pageTitleContains = cfgStr(ctx, "pageTitleContains").trim() || undefined;

    const accessToken = await getGoogleAccessToken({ clientId, clientSecret, refreshToken }, ctx.cancelSignal);
    const presentation = await getPresentation(accessToken, presentationId, ctx.cancelSignal);
    const matches = findSheetsChartsInPresentation(presentation, parsedSheet.id, pageTitleContains);
    if (matches.length === 0) {
      throw new PermanentError(
        `找不到目標頁面：這份簡報裡沒有一個圖表符合連結到指定試算表(${pageTitleContains ? `且頁面標題包含「${pageTitleContains}」` : "未指定頁面標題篩選"})。` +
        "請確認簡報網址、試算表網址是否正確，或者這份簡報裡連結圖表的目標試算表是否已經換過。",
      );
    }
    ctx.log(`找到 ${matches.length} 個符合的圖表：${matches.map((m) => `「${m.pageTitle || m.pageObjectId}」`).join("、")}`);
    // 安全試跑的承諾不是「畫面上不顯示」，而是根本不送出 refresh 請求。仍實際換 OAuth token、
    // 讀簡報、核對連結圖表，讓使用者能知道授權與目標是否正確；正式執行才會改動簡報。
    if (ctx.dryRun) {
      ctx.log("只讀驗證完成：已確認授權與目標圖表，沒有更新 Google 簡報");
      return {
        output: {
          ...ctx.input,
          refreshedCount: 0,
          plannedRefreshCount: matches.length,
          pageTitles: matches.map((m) => m.pageTitle).filter(Boolean).join("、"),
          validationOnly: true,
        },
      };
    }
    await refreshSheetsCharts(accessToken, presentationId, matches.map((match) => match.chartObjectId), ctx.cancelSignal);
    for (const match of matches) ctx.log(`已重新整理「${match.pageTitle || match.pageObjectId}」的圖表`);
    return {
      output: {
        ...ctx.input,
        refreshedCount: matches.length,
        pageTitles: matches.map((m) => m.pageTitle).filter(Boolean).join("、"),
      },
    };
  },
};
