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

export class AppsScriptDeployError extends Error {}

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
    throw new AppsScriptDeployError(`Apps Script API 回了看不懂的內容：${text.slice(0, 160)}`);
  }
}

/**
 * 把 Google 的錯誤翻成「使用者下一步該做什麼」。
 *
 * 這裡的每一種都對應一個**使用者自己動手才能解決**的前置條件；講不清楚的話他只會看到
 * 一串英文然後回來問，那這個「自動化」等於沒有省到事。
 */
export function friendlyApiError(status: number, body: string): string {
  if (/User has not enabled the Apps Script API|Apps Script API.*(not enabled|disabled)/i.test(body)) {
    return "你的 Google 帳號還沒打開「Apps Script API」這個總開關（預設是關的，而且只有你本人能開，沒有任何程式可以代勞）。"
      + "請到 https://script.google.com/home/usersettings 把它打開，再回來按一次。";
  }
  if (status === 403 && /insufficient|scope/i.test(body)) {
    return "目前的 Google 授權沒有包含「建立與部署 Apps Script」這兩項權限——請先按下面的「重新授權 Google」拿一組新的授權，再回來按一次。";
  }
  if (status === 401) {
    return "Google 授權過期或無效，請重新授權一次。";
  }
  if (status === 429 || status === 503) {
    return "Google 這邊暫時忙不過來（配額或服務忙碌），過一下再試一次；不是設定有問題。";
  }
  return `Apps Script API 失敗（HTTP ${status}）：${body.replace(/\s+/g, " ").slice(0, 200)}`;
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
    if (!project.scriptId) throw new AppsScriptDeployError("Google 建立了專案卻沒有回傳 scriptId，無法繼續。");
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
  if (!version.versionNumber) throw new AppsScriptDeployError("建立版本失敗：Google 沒有回傳版本號。");

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
    throw new AppsScriptDeployError(
      "部署完成了，但 Google 沒有給網頁應用程式網址——通常代表清單檔沒有被當成網頁應用程式。"
      + "可以改用下面的手動步驟部署一次。",
    );
  }
  return { scriptId, deploymentId: deployment.deploymentId, webAppUrl, created };
}
