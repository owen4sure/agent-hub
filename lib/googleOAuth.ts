/**
 * Google 授權由平台代勞：使用者按一顆按鈕，其餘全部自動。
 *
 * 為什麼要有這一層(真實踩過，而且踩了不只一次)：這台機器上的 Google 授權原本是**純手動**的——
 * 到 Cloud Console 建憑證、到 OAuth Playground 手動挑權限範圍、換出 refresh token、複製三串值
 * 貼回設定頁。中間任何一步錯了都只會在「幾天後排程執行失敗」時才發現，而錯誤訊息是一句
 * `{"error":"invalid_grant"}` 的原始 JSON。實際發生的事：授權在第 7 天失效(同意畫面停在「測試中」
 * 時 Google 的既定行為)，排程整條掛掉，使用者只知道「上次明明可以」。
 *
 * 這一層把那 12 個手動步驟壓成一次點擊：
 * ①權限範圍由平台依流程**實際用到什麼**自動推導，使用者不用挑(挑漏一個就是幾天後才炸)；
 * ②授權碼由後端自己收、自己換 token、自己存，三串值不可能來自不同次操作(那是舊流程最常見的壞法)；
 * ③token 從頭到尾不離開這台電腦。
 *
 * **刻意不做的事**：不代替使用者「同意」。OAuth 規定同意必須由真人在瀏覽器完成，要繞過它只有一條路
 * ——把 Google 密碼交給程式，那正是這個平台明文拒絕的事(見「手動登入一次」的同一個原則)。
 * 所以目標不是「零點擊」，是「**一次點擊，而且之後不會再需要**」。
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WorkflowNode } from "./workflow/types";
import { walkGraphSteps } from "./workflow/repeatNesting";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** 這個平台會用到的所有 Google 權限範圍。只列出真的有節點會用的，不做「先要了再說」。 */
export const GOOGLE_SCOPES = {
  sheetsRead: "https://www.googleapis.com/auth/spreadsheets.readonly",
  sheetsWrite: "https://www.googleapis.com/auth/spreadsheets",
  slides: "https://www.googleapis.com/auth/presentations",
  driveRead: "https://www.googleapis.com/auth/drive.readonly",
  scriptProjects: "https://www.googleapis.com/auth/script.projects",
  scriptDeployments: "https://www.googleapis.com/auth/script.deployments",
} as const;

/**
 * 這條流程實際需要哪些 Google 權限。
 *
 * 同時看**節點型別**與**程式碼/設定裡真的打了哪個 API**——只看型別會漏掉最重要的那一類：
 * 這台機器上真正在打 Slides/Sheets API 的是 custom-code 節點(型別只是 "custom-code")，
 * 用型別判斷會一個都認不出來，使用者就會拿到一組少了權限的授權，然後在幾天後執行時才收到 403。
 */
export function googleScopesForNodes(nodes: WorkflowNode[]): string[] {
  const scopes = new Set<string>();
  for (const node of walkGraphSteps(nodes).visited) {
    const config = node.config ?? {};
    const text = JSON.stringify(config);
    if (node.type === "google-sheet-read") scopes.add(GOOGLE_SCOPES.sheetsRead);
    if (node.type === "google-sheet-update" || node.type === "google-sheet-append") scopes.add(GOOGLE_SCOPES.sheetsWrite);
    if (node.type === "google-slides-refresh" || node.type === "google-slides-create") scopes.add(GOOGLE_SCOPES.slides);
    if (/sheets\.googleapis\.com/.test(text)) scopes.add(GOOGLE_SCOPES.sheetsRead);
    if (/slides\.googleapis\.com/.test(text)) scopes.add(GOOGLE_SCOPES.slides);
    if (/drive\.googleapis\.com/.test(text)) scopes.add(GOOGLE_SCOPES.driveRead);
    // 這條流程有在用 Apps Script 網頁應用程式 → 讓平台之後能自己更新/重新部署那份指令碼，
    // 使用者才不用每次範本改版就手動複製貼上再走一次「管理部署作業」。
    if (/script\.google\.com\/macros/.test(text) || /script\.googleapis\.com/.test(text)) {
      scopes.add(GOOGLE_SCOPES.scriptProjects);
      scopes.add(GOOGLE_SCOPES.scriptDeployments);
    }
  }
  // 有完整試算表權限時不用再要唯讀(它涵蓋唯讀)，少要一個範圍就少一項要使用者看懂的東西。
  if (scopes.has(GOOGLE_SCOPES.sheetsWrite)) scopes.delete(GOOGLE_SCOPES.sheetsRead);
  return [...scopes].sort();
}

/**
 * 授權要用哪個網址收 Google 導回來的結果。
 * 一律正規化成 127.0.0.1：使用者可能從 localhost 或 127.0.0.1 開頁面，但 Google 端註冊的
 * 重新導向 URI 必須逐字相符——固定成一個，使用者就只要在 Cloud Console 貼一次。
 */
export function googleRedirectUri(requestUrl: string): string {
  const port = new URL(requestUrl).port || "3000";
  return `http://127.0.0.1:${port}/api/oauth/google/callback`;
}

export function buildGoogleAuthUrl(input: { clientId: string; redirectUri: string; scopes: string[]; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: input.scopes.join(" "),
    // offline + consent 兩個都要：少了 offline 拿不到 refresh token；少了 consent，使用者
    // 之前同意過的話 Google 只會回 access token(不會再給 refresh token)，畫面看起來成功、
    // 實際上什麼都沒存到——這是這個流程最容易的假成功。
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: input.state,
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleTokenResult {
  ok: true;
  refreshToken: string;
  scope: string;
}
export interface GoogleTokenFailure {
  ok: false;
  error: string;
}

/** 用授權碼換 token。回傳的 refresh token 就是之後所有 Google 節點在用的那一串。 */
export async function exchangeGoogleCode(input: {
  clientId: string; clientSecret: string; code: string; redirectUri: string; signal?: AbortSignal;
}): Promise<GoogleTokenResult | GoogleTokenFailure> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: input.signal,
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* 下面統一報錯 */ }
  if (!res.ok) return { ok: false, error: googleAuthErrorMessage(String(data.error ?? ""), text) };
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
  if (!refreshToken) {
    return {
      ok: false,
      error: "Google 這次沒有回傳 refresh token。通常是因為這個帳號先前已經授權過同一組憑證；"
        + "請到 Google 帳號的「第三方應用程式」把這個應用移除後再授權一次，或直接重試(平台每次都會要求重新同意)。",
    };
  }
  return { ok: true, refreshToken, scope: String(data.scope ?? "") };
}

/** 用 refresh token 換 access token。授權有沒有活著也用這一支判斷(純讀、沒有副作用)。 */
export async function refreshGoogleAccessToken(input: {
  clientId: string; clientSecret: string; refreshToken: string; signal?: AbortSignal;
}): Promise<{ ok: true; expiresIn: number; scope: string } | GoogleTokenFailure> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: input.signal,
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* 下面統一報錯 */ }
  if (!res.ok || typeof data.access_token !== "string") {
    return { ok: false, error: googleAuthErrorMessage(String(data.error ?? ""), text) };
  }
  return { ok: true, expiresIn: Number(data.expires_in ?? 0), scope: String(data.scope ?? "") };
}

/**
 * Google 的錯誤代碼翻成「使用者知道下一步要做什麼」的話。
 * 每一句都要指出**具體那顆按鈕或那個欄位**——只說「授權失效」等於把問題丟回給看不懂的人。
 */
export function googleAuthErrorMessage(code: string, raw = ""): string {
  if (/invalid_grant/i.test(code) || /invalid_grant/i.test(raw)) {
    return "Google 的授權已經失效（被撤銷、過期，或帳號安全設定變更）。到設定頁按「重新連結 Google 帳號」重走一次就好，其他值都不用動。";
  }
  if (/invalid_client/i.test(code) || /invalid_client/i.test(raw)) {
    return "Google 用戶端 ID 或密鑰不正確。請回設定頁確認 googleOAuthClientId／googleOAuthClientSecret 是同一組憑證、沒有多餘空白。";
  }
  if (/redirect_uri_mismatch/i.test(code) || /redirect_uri_mismatch/i.test(raw)) {
    return "Google 說這個「重新導向網址」沒有註冊過。請到 Google Cloud Console →「憑證」→ 你的 OAuth 用戶端 →「已授權的重新導向 URI」，把平台顯示的那一行網址加進去，再按一次連結。";
  }
  if (/access_denied/i.test(code) || /access_denied/i.test(raw)) {
    return "你在 Google 的同意畫面按了取消（或帳號沒有被加進測試使用者）。要重新授權的話再按一次連結即可。";
  }
  return `Google 授權失敗：${(raw || code || "沒有回傳原因").slice(0, 300)}`;
}

/**
 * 授權流程的一次性 state（防跨站偽造）。存在記憶體就夠：發起與回呼一定打到同一個行程
 * （使用者的瀏覽器就是對著這台伺服器在講話），而且它本來就該短命。
 */
const pendingStates = new Map<string, { createdAt: number; redirectUri: string; scopes: string[] }>();
const STATE_TTL_MS = 10 * 60_000;

export function issueOAuthState(redirectUri: string, scopes: string[]): string {
  const now = Date.now();
  for (const [key, value] of pendingStates) if (now - value.createdAt > STATE_TTL_MS) pendingStates.delete(key);
  const state = randomUUID().replace(/-/g, "");
  pendingStates.set(state, { createdAt: now, redirectUri, scopes });
  return state;
}

/** 用掉就作廢（一次性）。回 null＝不存在、過期或被竄改。 */
export function claimOAuthState(state: string): { redirectUri: string; scopes: string[] } | null {
  if (!state) return null;
  for (const [key, value] of pendingStates) {
    if (Date.now() - value.createdAt > STATE_TTL_MS) { pendingStates.delete(key); continue; }
    if (key.length === state.length && timingSafeEqual(Buffer.from(key), Buffer.from(state))) {
      pendingStates.delete(key);
      return { redirectUri: value.redirectUri, scopes: value.scopes };
    }
  }
  return null;
}
