import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";
import {
  createGooglePresentation,
  getGoogleAccessToken,
  getPresentation,
  writeGooglePresentationDeck,
  type GoogleSlidesDeckSlide,
} from "../../googleSlidesApi";

const NEED_SETUP = "Google 簡報的第一次授權還沒完成——對話會出現逐步教學與三個安全輸入欄位；完成後再按一次測試即可。";

function plainText(value: unknown, max: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

/**
 * AI 可以把投影片大綱放在純陣列或 {slides:[...]} 裡。這裡不猜欄位/不把壞 JSON 靜默變成
 * 空簡報：格式不對就指名錯在哪，讓對話修復器重寫「產生大綱」那一步，而不是讓使用者去碰 API。
 */
export function parseSlidesOutline(raw: string): GoogleSlidesDeckSlide[] {
  const withoutFence = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence);
  } catch {
    throw new PermanentError("投影片內容不是可讀的大綱。請讓 AI 重新輸出 JSON：{\"slides\":[{\"title\":\"封面標題\",\"bullets\":[\"重點一\",\"重點二\"]}]}；不要把說明文字混在 JSON 外面。");
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { slides?: unknown })?.slides;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 30) {
    throw new PermanentError("投影片大綱至少要有 1 張、最多 30 張；請讓 AI 重新整理成 slides 陣列。");
  }
  const slides: GoogleSlidesDeckSlide[] = rows.map((row, index) => {
    const item = row && typeof row === "object" ? row as { title?: unknown; bullets?: unknown; body?: unknown } : {};
    const title = plainText(item.title, 140);
    const values = Array.isArray(item.bullets) ? item.bullets : typeof item.body === "string" ? item.body.split(/\r?\n/) : [];
    const bullets = values.map((value) => plainText(value, 500)).filter(Boolean).slice(0, 12);
    if (!title) throw new PermanentError(`第 ${index + 1} 張投影片沒有標題。請讓 AI 補上 title。`);
    return { title, bullets };
  });
  return slides;
}

function firstSlideId(presentation: unknown): string | null {
  const slides = (presentation as { slides?: { objectId?: unknown }[] })?.slides;
  const id = Array.isArray(slides) ? slides[0]?.objectId : undefined;
  return typeof id === "string" && id ? id : null;
}

export const googleSlidesCreateNode: NodeDefinition = {
  type: "google-slides-create",
  category: "integration",
  label: "建立 Google 簡報",
  description: "把前面整理好的投影片內容建立成一份新的 Google 簡報。正式執行才會新增檔案；測試時只會確認授權和投影片內容是否能讀懂。",
  icon: "🖥️",
  outputs: "presentationUrl(新簡報網址)、presentationId、slideCount(投影片張數)、createdPresentationTitle",
  configSchema: [
    { key: "title", label: "新簡報檔名", type: "text", default: "" },
    { key: "slidesJson", label: "投影片內容", type: "textarea", default: "", help: "通常由前一步 AI 自動整理；不用手寫程式。每張要有標題和重點。" },
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

    const title = cfgStr(ctx, "title").trim();
    if (!title) throw new PermanentError("還沒有簡報檔名。請直接在對話說「檔名改成……」，AI 會替你補好。");
    const rawSlides = cfgStr(ctx, "slidesJson");
    const accessToken = await getGoogleAccessToken({ clientId, clientSecret, refreshToken }, ctx.cancelSignal);

    // 授權設定卡會「只測這一格」；那時上游 AI 尚未執行，{{deckJson}} 合法地還是字面模板。
    // 先誠實驗 OAuth，但不把它說成「內容已驗證」。完整安全試跑時上游會提供實際 JSON，才走下面嚴格解析。
    if (ctx.dryRun && /\{\{\s*[^}]+\s*\}\}/.test(rawSlides)) {
      ctx.log("Google 授權有效；這次是單獨驗證授權，上游投影片內容尚未產生，所以沒有驗證簡報大綱")
      return { output: { ...ctx.input, createdPresentationTitle: title, validationOnly: true, requiresUpstreamContent: true } };
    }
    const slides = parseSlidesOutline(rawSlides);

    // 測試不能新增一份真的文件；但 OAuth 換 token + 大綱嚴格驗證能保證「帳號可連、內容能寫」，
    // 並誠實標成尚未驗證外部寫入，而不是假稱已建立成功。
    if (ctx.dryRun) {
      ctx.log(`只讀驗證完成：Google 授權有效，已讀懂 ${slides.length} 張投影片的大綱；沒有建立任何簡報`);
      return { output: { ...ctx.input, slideCount: slides.length, createdPresentationTitle: title, validationOnly: true } };
    }

    const created = await createGooglePresentation(accessToken, title.slice(0, 180), ctx.cancelSignal);
    try {
      const presentation = await getPresentation(accessToken, created.presentationId, ctx.cancelSignal);
      const initialSlideId = firstSlideId(presentation);
      if (!initialSlideId) throw new PermanentError("Google 建立了新簡報，但讀不到它的第一張投影片；沒有繼續寫入內容。請到執行紀錄開啟新檔確認，然後把這段錯誤交給 AI 修。 ");
      await writeGooglePresentationDeck(accessToken, created.presentationId, initialSlideId, slides, ctx.cancelSignal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Google 的 5xx/網路波動仍可重試；不要因為我們補了「新檔網址」就把可恢復錯誤誤標成永久失敗。
      if (error instanceof RetryableError) {
        throw new RetryableError(`已建立空白簡報(${created.presentationUrl})，但寫入內容時遇到暫時性問題：${message}`);
      }
      throw new PermanentError(`已建立空白簡報(${created.presentationUrl})，但尚未成功寫入內容：${message}。這份新檔沒有被拿來當成功結果；把此訊息交給 AI 修即可。`);
    }
    ctx.log(`已建立 ${slides.length} 張投影片：${created.presentationUrl}`);
    return {
      output: {
        ...ctx.input,
        presentationUrl: created.presentationUrl,
        presentationId: created.presentationId,
        slideCount: slides.length,
        createdPresentationTitle: title,
      },
    };
  },
};
