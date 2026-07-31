/**
 * 用 Apps Script API 幫使用者「自己建好腳本、自己部署」——取代人工複製貼上 + 走一次部署精靈。
 *
 * 這是當初索取 `script.projects` / `script.deployments` 兩個權限時就寫在註解裡的目的
 * (「讓平台之後能自己更新/重新部署那份指令碼，使用者才不用每次範本改版就手動複製貼上」)，
 * 但實作一直沒補上——權限要了卻沒用，等於白讓使用者多同意兩項。這支就是把它補完。
 *
 * ## 兩件平台**做不到**、一定要使用者本人動手的事(所以錯誤訊息要指得很精準)
 *
 * ①**Apps Script API 的總開關**：在 script.google.com/home/usersettings，預設是關的，
 *   而且沒有任何 API 可以幫他打開(這是 Google 刻意的設計)。關著的時候所有呼叫都會被拒絕。
 * ②**同意新的權限範圍**：現有的 refresh token 是在還沒有這兩個權限時拿的，要重走一次授權。
 *
 * 除此之外(建專案、寫檔、建版本、部署成任何人可存取的網頁應用程式)全部都能自動完成。
 */

const BASE = "https://script.googleapis.com/v1";

/**
 * 錯誤要能帶著「下一步該點哪裡」——只有訊息字串的話，使用者看到一段話還是不知道要去哪。
 */
export interface ApiErrorInfo {
  message: string;
  /** 有明確可以點的目的地時帶上(例如 Google 自己回的「去這裡啟用」網址，裡面含專案編號) */
  actionUrl?: string;
  actionLabel?: string;
  /** Google 的原始訊息，永遠保留——判斷式一旦分類錯，這是使用者/我唯一能對照的東西 */
  raw: string;
}

export class AppsScriptDeployError extends Error {
  readonly info: ApiErrorInfo;
  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.info = info;
  }
}

async function call<T>(
  accessToken: string,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new AppsScriptDeployError(friendlyApiError(res.status, text));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppsScriptDeployError({ message: `Apps Script API 回了看不懂的內容：${text.slice(0, 160)}`, raw: text });
  }
}

/**
 * 把 Google 的錯誤翻成「使用者下一步該做什麼」。
 *
 * ⚠️ **「Apps Script API 沒開」有兩個完全不同的東西，指錯地方比不指還糟**(真實踩過：
 * 使用者照著訊息去把帳號層的開關打開了，再按一次還是同一句話，等於卡死)：
 * ①**帳號層的個人開關**(script.google.com/home/usersettings)——Google 的訊息是
 *   「User has not enabled the Apps Script API」。
 * ②**Cloud 專案層的 API 啟用**——訊息是「Apps Script API has not been used in project 12345
 *   before or it is disabled」，而且 Google 會**在訊息裡附上含專案編號的啟用網址**。
 * 這兩者要分開判斷，而且第二種一定要把 Google 給的那個網址原樣交給使用者——
 * 那串網址帶著他的專案編號，我們自己組不出來。
 */
export function friendlyApiError(status: number, body: string): ApiErrorInfo {
  const raw = body;
  // Google 在訊息裡附的啟用網址(帶專案編號)，有的話一律直接給使用者點
  const enableUrl = body.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'\\)]+/)?.[0];

  if (/has not been used in project|is disabled.*project|SERVICE_DISABLED/i.test(body)) {
    return {
      message: "這是另一個開關（不是你剛才開的那個）：你的 Google Cloud 專案裡還沒啟用 Apps Script API。"
        + "（跟 script.google.com 那個帳號層開關是兩回事，兩個都要開。）"
        + "點下面的按鈕會直接開到你那個專案的啟用頁，按「啟用」再回來按一次即可；剛啟用可能要等 1 分鐘才生效。",
      actionUrl: enableUrl ?? "https://console.cloud.google.com/apis/library/script.googleapis.com",
      actionLabel: "去啟用 Apps Script API",
      raw,
    };
  }
  if (/User has not enabled the Apps Script API/i.test(body)) {
    return {
      message: "你的 Google 帳號還沒打開「Apps Script API」這個個人開關（預設是關的，只有你本人能開）。"
        + "打開之後回來再按一次。",
      actionUrl: "https://script.google.com/home/usersettings",
      actionLabel: "去打開那個開關",
      raw,
    };
  }
  if (status === 403 && /insufficient|scope/i.test(body)) {
    return { message: "目前的 Google 授權沒有包含「建立與部署 Apps Script」這兩項權限——請先完成第 1 步的重新授權，再回來按一次。", raw };
  }
  if (status === 401) return { message: "Google 授權過期或無效，請重新授權一次。", raw };
  if (status === 429 || status === 503) {
    return { message: "Google 這邊暫時忙不過來（配額或服務忙碌），過一下再試一次；不是設定有問題。", raw };
  }
  return { message: `Apps Script API 失敗（HTTP ${status}）：${body.replace(/\s+/g, " ").slice(0, 200)}`, raw };
}

/**
 * 網頁應用程式的部署設定是寫在**清單檔**裡的，不是部署 API 的參數——
 * 這是最容易踩空的一點：只呼叫 deployments.create 而清單裡沒有 webapp 區段，
 * 部署會成功但**拿不到 /exec 網址**(它根本沒被當成網頁應用程式)。
 *
 * `ANYONE_ANONYMOUS` = 「誰可以存取：任何人」，`USER_DEPLOYING` = 「執行身分：我自己」，
 * 跟手動部署精靈裡要選的兩項完全對應。
 */
export function buildManifest(oauthScopes: string[], timeZone = "Asia/Taipei"): string {
  return JSON.stringify(
    {
      timeZone,
      dependencies: {},
      exceptionLogging: "STACKDRIVER",
      runtimeVersion: "V8",
      oauthScopes,
      webapp: { executeAs: "USER_DEPLOYING", access: "ANYONE_ANONYMOUS" },
    },
    null,
    2,
  );
}

export interface DeployResult {
  scriptId: string;
  deploymentId: string;
  /** 部署後的 /exec 網址；拿不到就是清單檔沒被當成網頁應用程式 */
  webAppUrl: string;
  /** 這次是新建還是更新既有的那一份 */
  created: boolean;
}

interface EntryPoint { entryPointType?: string; webApp?: { url?: string } }
interface Deployment { deploymentId?: string; entryPoints?: EntryPoint[] }

function webAppUrlOf(deployment: Deployment): string | null {
  for (const entry of deployment.entryPoints ?? []) {
    if (entry.webApp?.url) return entry.webApp.url;
  }
  return null;
}

/**
 * 建立(或更新)一個獨立的 Apps Script 專案，並把它部署成「任何人可存取」的網頁應用程式。
 *
 * 傳入既有的 scriptId 就是**更新**：推新的程式碼 → 建新版本 → 把既有的部署指到新版本。
 * 更新既有部署(而不是每次都建新的)很重要——每建一次新部署就會多一個 /exec 網址，
 * 使用者流程裡填的那個舊網址會停在舊版程式碼上，而且他完全不會知道。
 */
export async function deployWebApp(input: {
  accessToken: string;
  title: string;
  code: string;
  oauthScopes: string[];
  existingScriptId?: string | null;
  existingDeploymentId?: string | null;
  signal?: AbortSignal;
}): Promise<DeployResult> {
  const { accessToken, signal } = input;
  let scriptId = (input.existingScriptId ?? "").trim();
  const created = !scriptId;
  if (!scriptId) {
    const project = await call<{ scriptId?: string }>(accessToken, "POST", "/projects", { title: input.title }, signal);
    if (!project.scriptId) throw new AppsScriptDeployError({ message: "Google 建立了專案卻沒有回傳 scriptId，無法繼續。", raw: "" });
    scriptId = project.scriptId;
  }

  await call(accessToken, "PUT", `/projects/${scriptId}/content`, {
    files: [
      { name: "appsscript", type: "JSON", source: buildManifest(input.oauthScopes) },
      { name: "Code", type: "SERVER_JS", source: input.code },
    ],
  }, signal);

  const version = await call<{ versionNumber?: number }>(
    accessToken, "POST", `/projects/${scriptId}/versions`,
    { description: `Agent Hub ${new Date().toISOString().slice(0, 19)}` }, signal,
  );
  if (!version.versionNumber) throw new AppsScriptDeployError({ message: "建立版本失敗：Google 沒有回傳版本號。", raw: "" });

  const config = {
    versionNumber: version.versionNumber,
    manifestFileName: "appsscript",
    description: "Agent Hub 換簡報圖片",
  };
  const existingDeploymentId = (input.existingDeploymentId ?? "").trim();
  const deployment = existingDeploymentId
    ? await call<Deployment>(accessToken, "PUT", `/projects/${scriptId}/deployments/${existingDeploymentId}`, { deploymentConfig: config }, signal)
    : await call<Deployment>(accessToken, "POST", `/projects/${scriptId}/deployments`, config, signal);

  const webAppUrl = webAppUrlOf(deployment);
  if (!deployment.deploymentId || !webAppUrl) {
    throw new AppsScriptDeployError({
      message: "部署完成了，但 Google 沒有給網頁應用程式網址——通常代表清單檔沒有被當成網頁應用程式。"
        + "可以改用手動步驟部署一次。",
      raw: JSON.stringify(deployment).slice(0, 300),
    });
  }
  return { scriptId, deploymentId: deployment.deploymentId, webAppUrl, created };
}
