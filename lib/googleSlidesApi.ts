import { PermanentError, RetryableError } from "./workflow/types";

/**
 * 用 OAuth 直接呼叫 Google Slides API 重新整理連結的圖表(presentations.batchUpdate 的
 * refreshSheetsChart)，取代原本「開瀏覽器、掃描每一頁文字、找按鈕點下去」的做法。
 * 那套做法本質上是對著會員名/圖例文字做模糊比對，Google 頁面版型或簡報頁數一變動就找不到，
 * 而且「找到了但點錯」也無法分辨——這裡改用穩定的 presentationId/objectId 直接呼叫官方 API，
 * 不用再靠猜文字內容。
 */

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** 把 Google OAuth token 端點的錯誤翻成可處理的原因。invalid_grant 幾乎都是 refresh token
 * 被撤銷/過期(或這組憑證的使用者密碼、兩步驟驗證設定變更)，需要重新走一次 OAuth 流程拿新的
 * refresh token，不是設定打錯字，也不是程式碼問題，AI 改不動。 */
export function googleOAuthErrorMessage(status: number, body: string): string {
  if (/invalid_grant/i.test(body)) {
    return "Google 授權已失效(invalid_grant)：可能是 refresh token 被撤銷、過期，或帳號安全設定已變更；如果 OAuth 同意畫面仍是「測試中」，Google 也可能在 7 天後讓它失效。" +
      "需要重新走一次 OAuth 流程拿新的 refresh token——到 Google OAuth Playground" +
      "(https://developers.google.com/oauthplayground)，右上角齒輪打勾「Use your own OAuth credentials」貼上你的" +
      "Client ID/密鑰，左側勾選 Google Slides API 的 https://www.googleapis.com/auth/presentations 範圍，走一次" +
      "Authorize 拿到新的 refresh token，貼回設定頁。";
  }
  if (/invalid_client/i.test(body)) {
    return "Google OAuth 用戶端 ID(Client ID)或密鑰不正確(invalid_client)。請重新確認 Google Cloud Console 的 OAuth " +
      "2.0 用戶端 ID／密鑰是否貼對，到設定頁重新填入。";
  }
  // 真實踩過的案例：使用者在 OAuth Playground 用「A 組」Client ID/Secret 換出 Refresh Token，
  // 但存進這裡的 Client ID/Secret 其實是「B 組」(常見情境：先建過一組憑證失敗，後來另外新建一組，
  // Playground 或存檔時兩邊搭配到不同組)。Refresh Token 是綁定在核發它的那組 Client ID/Secret 上，
  // 三個值只要有一個對不上就會在換權杖這步被 Google 拒絕，而不是任何一個值本身「打錯字」，
  // 所以不能套用 invalid_client(那個是值本身格式/內容不對)的說法，容易誤導使用者去改錯地方。
  if (/unauthorized_client/i.test(body)) {
    return "Google OAuth 換權杖失敗(unauthorized_client)：這組 Refresh Token 不是用你現在填的這組 Client ID/Secret 換出來的" +
      "——三個值必須來自「同一次」OAuth Playground 操作，只要中間混到不同組憑證(例如先失敗過一次、後來另外建了新憑證)就會這樣。" +
      "解法：回到 Google Cloud Console 確認要用的那組 Client ID/Secret，到 OAuth Playground 右上角齒輪「Use your own OAuth " +
      "credentials」貼上這組值 → 重新走一次 Authorize APIs → Exchange authorization code for tokens，" +
      "把這次拿到的 Client ID、Client Secret、Refresh Token 三個值一起重新填進來，不要跟舊的混用。";
  }
  return `Google OAuth 換權杖失敗(${status})：${body.slice(0, 200)}`;
}

/** 用 refresh token 換一個新的 access token(1 小時內有效)；每次執行前都重新換，不快取。 */
export async function getGoogleAccessToken(creds: GoogleOAuthCredentials, signal?: AbortSignal): Promise<string> {
  let res: Response;
  let text: string;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: "refresh_token",
      }),
      signal,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new PermanentError("已停止執行");
    throw new RetryableError(`連不上 Google OAuth 端點：${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 500) throw new RetryableError(`Google OAuth 端點暫時錯誤(${res.status})`);
  if (!res.ok) throw new PermanentError(googleOAuthErrorMessage(res.status, text));
  let parsed: { access_token?: string };
  try {
    parsed = JSON.parse(text) as { access_token?: string };
  } catch {
    throw new PermanentError(`Google OAuth 回應無法解析：${text.slice(0, 200)}`);
  }
  if (!parsed.access_token) throw new PermanentError(`Google OAuth 沒有回傳 access token：${text.slice(0, 200)}`);
  return parsed.access_token;
}

/**
 * 純函式：找出流程裡用到「重新整理 Google 簡報圖表」的節點——套用新流程或直接改節點(對話 edits
 * 直接套用)後都用它判斷要不要主動附上 OAuth 設定教學卡。放在這個沒有 "use client" 的中立檔案，
 * 前端(wfChatStore)和後端 API route(build/route.ts)才能共用同一份判斷，不用各自維護一份、日後漂移。
 */
export function slidesRefreshNodesNeedingOAuthSetup(nodes: { type?: string; label?: string }[]): string[] {
  return nodes
    .filter((n) => n.type === "google-slides-refresh" || n.type === "google-slides-create")
    .map((n) => n.label || (n.type === "google-slides-create" ? "建立 Google 簡報" : "重新整理 Google 簡報圖表"));
}

export interface SheetsChartMatch { pageObjectId: string; pageTitle: string; chartObjectId: string; spreadsheetId: string }

/** 純函式：從一頁投影片的元素裡取「第一個有文字的方塊」內容當這頁的標題(簡報沒有獨立的
 * 標題欄位，標題就是排在最上面的文字方塊)。 */
function firstTextOnPage(pageElements: unknown[]): string {
  for (const el of pageElements) {
    const textElements = (el as { shape?: { text?: { textElements?: unknown[] } } }).shape?.text?.textElements;
    if (!Array.isArray(textElements)) continue;
    const text = textElements
      .map((t) => (t as { textRun?: { content?: string } }).textRun?.content ?? "")
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** 純函式：從 presentations.get 回傳的 JSON 裡找出所有連結到指定試算表的圖表(sheetsChart)。
 * pageTitleContains 選填——同一份試算表在好幾頁都有圖表時，用頁面標題文字再篩一次避免抓錯頁。 */
export function findSheetsChartsInPresentation(
  presentation: unknown,
  spreadsheetId: string,
  pageTitleContains?: string,
): SheetsChartMatch[] {
  const slides = (presentation as { slides?: unknown[] })?.slides;
  if (!Array.isArray(slides)) return [];
  const matches: SheetsChartMatch[] = [];
  const needle = pageTitleContains?.trim().toLowerCase();
  for (const slide of slides) {
    const s = slide as { objectId?: string; pageElements?: unknown[] };
    if (!s.objectId || !Array.isArray(s.pageElements)) continue;
    const pageTitle = firstTextOnPage(s.pageElements);
    if (needle && !pageTitle.toLowerCase().includes(needle)) continue;
    for (const el of s.pageElements) {
      const chart = (el as { sheetsChart?: { spreadsheetId?: string } }).sheetsChart;
      const elObjectId = (el as { objectId?: string }).objectId;
      if (chart?.spreadsheetId === spreadsheetId && elObjectId) {
        matches.push({ pageObjectId: s.objectId, pageTitle, chartObjectId: elObjectId, spreadsheetId });
      }
    }
  }
  return matches;
}

export interface SlidesPresentationPageProbe { index: number; title: string; linkedSpreadsheetIds: string[] }

/**
 * 真實踩過的事故：google-slides-refresh 節點失敗「找不到目標頁面」時，修復迴圈只看得到錯誤訊息
 * 文字本身，完全不知道這份簡報「實際」有哪些頁、每頁標題是什麼、圖表連到哪份試算表——只能反覆
 * 對著同一個(可能本來就錯的)pageTitleContains 猜，鬼打牆。這個探針直接呼叫官方 API 把真實頁面
 * 清單讀出來，讓修復 prompt 能拿到跟人工除錯時同等的證據(而不是只看錯誤訊息腦補)。
 * 只做只讀的 presentations.get，不會呼叫 refreshSheetsChart，對使用者的簡報零風險。
 */
export async function probeSlidesPresentationPages(
  creds: GoogleOAuthCredentials,
  presentationId: string,
  signal?: AbortSignal,
): Promise<{ presentationTitle: string; pages: SlidesPresentationPageProbe[] }> {
  const accessToken = await getGoogleAccessToken(creds, signal);
  const presentation = await getPresentation(accessToken, presentationId, signal) as { title?: string; slides?: unknown[] };
  const slides = Array.isArray(presentation.slides) ? presentation.slides : [];
  const pages = slides.map((slide, index) => {
    const s = slide as { pageElements?: unknown[] };
    const elements = Array.isArray(s.pageElements) ? s.pageElements : [];
    const linkedSpreadsheetIds = elements
      .map((el) => (el as { sheetsChart?: { spreadsheetId?: string } }).sheetsChart?.spreadsheetId)
      .filter((sid): sid is string => Boolean(sid));
    return { index, title: firstTextOnPage(elements), linkedSpreadsheetIds };
  });
  return { presentationTitle: presentation.title ?? "", pages };
}

/** 把 Slides API 的錯誤依狀態碼分流：5xx 直接丟可重試的錯誤，其餘翻成可處理的原因。 */
function throwSlidesApiError(status: number, body: string, action: string): never {
  if (status >= 500) throw new RetryableError(`Google Slides API 暫時錯誤(${status})：${action}`);
  if (status === 403) {
    // 真實踩過的案例：使用者已經把 OAuth 帳號加成這份簡報的編輯者，403 卻還是不會消失——因為
    // 「重新整理連結試算表的圖表」除了要能改簡報，還要能讀那份被連結的試算表本身，這是 Slides API
    // 在 refreshSheetsChart 這個動作額外要求的權限範圍，只給 presentations 這個 scope 不夠。
    // Google 這裡的錯誤文字很明確會點名缺哪些 scope，直接辨識出來給精準指引，不要跟「沒有分享權限」
    // 這個完全不同的原因混在一起講，混講會讓使用者一直重複檢查分享設定卻永遠修不好。
    if (/scopes? .{0,40}not sufficient|insufficient.{0,20}scope/i.test(body)) {
      throw new PermanentError(
        `${action}失敗(403)：目前的 OAuth 授權範圍不夠——重新整理連結試算表的圖表，除了 presentations，還需要 https://www.googleapis.com/auth/spreadsheets.readonly 這個範圍才能讀取被連結的試算表。` +
        "這不是分享權限的問題(帳號已經是編輯者也一樣會遇到)。請回到 OAuth Playground，把兩個 scope(presentations 和 spreadsheets.readonly)都加上再重新授權一次，拿新的 Refresh Token 整組重新貼進設定卡片。",
      );
    }
    throw new PermanentError(`Google 帳號沒有這份簡報的權限(403)，${action}失敗。請確認這個 OAuth 帳號本人有被分享／檢視這份簡報，且 OAuth 範圍有包含 https://www.googleapis.com/auth/presentations 與 https://www.googleapis.com/auth/spreadsheets.readonly。`);
  }
  if (status === 404) {
    throw new PermanentError(`找不到這份簡報(404)，${action}失敗。請確認簡報網址/ID 正確，且這個 OAuth 帳號有權限看到它。`);
  }
  throw new PermanentError(`Google Slides API ${action}失敗(${status})：${body.slice(0, 200)}`);
}

export async function getPresentation(accessToken: string, presentationId: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new PermanentError("已停止執行");
    throw new RetryableError(`連不上 Google Slides API：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throwSlidesApiError(res.status, text, "讀取簡報");
  try {
    return JSON.parse(text);
  } catch {
    throw new PermanentError(`Google Slides API 回應無法解析：${text.slice(0, 200)}`);
  }
}

/**
 * Refresh every matched chart in one atomic Google request.  Calling one chart
 * at a time can leave a deck half-updated when the third request fails; the
 * official batch endpoint applies all valid subrequests together instead.
 */
export async function refreshSheetsCharts(accessToken: string, presentationId: string, chartObjectIds: string[], signal?: AbortSignal): Promise<void> {
  if (chartObjectIds.length === 0) return;
  let res: Response;
  let text: string;
  try {
    res = await fetch(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: chartObjectIds.map((objectId) => ({ refreshSheetsChart: { objectId } })) }),
      signal,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new PermanentError("已停止執行");
    throw new RetryableError(`連不上 Google Slides API：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throwSlidesApiError(res.status, text, "重新整理圖表");
}

/** Backward-compatible single-chart helper for callers that only have one target. */
export async function refreshSheetsChart(accessToken: string, presentationId: string, chartObjectId: string, signal?: AbortSignal): Promise<void> {
  await refreshSheetsCharts(accessToken, presentationId, [chartObjectId], signal);
}

export interface GoogleSlidesDeckSlide {
  title: string;
  bullets: string[];
}

export interface CreatedGooglePresentation {
  presentationId: string;
  presentationUrl: string;
}

/** Google Slides API 的 create 只會建立空白檔，內容要再用 batchUpdate 一次原子寫入。
 * 這裡刻意把「建立檔案」和「寫入投影片」包成產品層 API，節點不用自己猜 REST 格式，也能讓
 * 安全試跑只做 OAuth 驗證、正式執行才真的建立文件。 */
export async function createGooglePresentation(
  accessToken: string,
  title: string,
  signal?: AbortSignal,
): Promise<CreatedGooglePresentation> {
  let res: Response;
  let text: string;
  try {
    res = await fetch("https://slides.googleapis.com/v1/presentations", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
      signal,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new PermanentError("已停止執行");
    throw new RetryableError(`連不上 Google Slides API：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throwSlidesApiError(res.status, text, "建立簡報");
  let parsed: { presentationId?: string };
  try {
    parsed = JSON.parse(text) as { presentationId?: string };
  } catch {
    throw new PermanentError(`Google Slides API 建立簡報後回傳的內容無法解析：${text.slice(0, 200)}`);
  }
  if (!parsed.presentationId) throw new PermanentError(`Google Slides API 建立簡報後沒有回傳檔案 ID：${text.slice(0, 200)}`);
  return {
    presentationId: parsed.presentationId,
    presentationUrl: `https://docs.google.com/presentation/d/${encodeURIComponent(parsed.presentationId)}/edit`,
  };
}

type SlidesRequest = Record<string, unknown>;

async function batchUpdatePresentation(
  accessToken: string,
  presentationId: string,
  requests: SlidesRequest[],
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
      signal,
    });
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) throw new PermanentError("已停止執行");
    throw new RetryableError(`連不上 Google Slides API：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throwSlidesApiError(res.status, text, "寫入簡報內容");
}

const EMU = "EMU";
const PT = "PT";
const SLIDE_WIDTH = 9_144_000;
const SLIDE_HEIGHT = 5_143_500;

function size(width: number, height: number) {
  return { width: { magnitude: width, unit: EMU }, height: { magnitude: height, unit: EMU } };
}

function transform(x: number, y: number) {
  return { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: EMU };
}

function textBoxRequests(objectId: string, pageObjectId: string, text: string, x: number, y: number, width: number, height: number, fontSize: number, bold = false): SlidesRequest[] {
  return [
    {
      createShape: {
        objectId,
        shapeType: "TEXT_BOX",
        elementProperties: { pageObjectId, size: size(width, height), transform: transform(x, y) },
      },
    },
    { insertText: { objectId, insertionIndex: 0, text } },
    {
      updateTextStyle: {
        objectId,
        textRange: { type: "ALL" },
        style: { fontSize: { magnitude: fontSize, unit: PT }, bold, foregroundColor: { opaqueColor: { rgbColor: { red: 0.12, green: 0.16, blue: 0.25 } } } },
        fields: "fontSize,bold,foregroundColor",
      },
    },
  ];
}

/**
 * 把已經由 AI/使用者確認的投影片大綱寫進一份剛建立的簡報。所有投影片、標題與內文都在
 * 一個 batchUpdate 裡送出；Google 會先驗整批請求，任何一筆不合法就完全不套用，不會留下
 * 「一半有字、一半空白」的半成品。建立檔案本身是 API 的另一個必要請求，若後續失敗會清楚
 * 回報新檔網址，讓使用者不會找不到那份空白草稿。
 */
export async function writeGooglePresentationDeck(
  accessToken: string,
  presentationId: string,
  firstSlideObjectId: string,
  slides: GoogleSlidesDeckSlide[],
  signal?: AbortSignal,
): Promise<void> {
  const requests: SlidesRequest[] = [];
  const nonce = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  const slideIds = slides.map((_, index) => index === 0 ? firstSlideObjectId : `ah_slide_${nonce}_${index}`);
  for (let index = 1; index < slides.length; index++) {
    requests.push({ createSlide: { objectId: slideIds[index], insertionIndex: index, slideLayoutReference: { predefinedLayout: "BLANK" } } });
  }
  for (let index = 0; index < slides.length; index++) {
    const slide = slides[index];
    const prefix = `ah_text_${nonce}_${index}`;
    requests.push(...textBoxRequests(`${prefix}_title`, slideIds[index], slide.title, 548_640, 365_760, SLIDE_WIDTH - 1_097_280, 731_520, 28, true));
    const body = slide.bullets.map((bullet) => `• ${bullet}`).join("\n");
    if (body) requests.push(...textBoxRequests(`${prefix}_body`, slideIds[index], body, 731_520, 1_371_600, SLIDE_WIDTH - 1_463_040, SLIDE_HEIGHT - 1_828_800, 18));
  }
  await batchUpdatePresentation(accessToken, presentationId, requests, signal);
}
