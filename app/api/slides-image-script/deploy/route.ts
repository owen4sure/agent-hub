import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSetting, getSharedSecrets, setSetting, setSharedSecrets } from "@/lib/settingsStore";
import { googleSlidesImageScriptTemplate } from "@/lib/googleSlidesImageScriptTemplate";
import { SLIDES_IMAGE_TOKEN_KEY } from "@/lib/workflow/nodes/googleSlidesReplaceImage";
import { AppsScriptDeployError, deployWebApp } from "@/lib/appsScriptDeploy";
import { GOOGLE_SCOPES, missingGoogleScopes } from "@/lib/googleOAuth";
import { getGoogleTokenHealth } from "@/lib/googleTokenHealth";
import { getGoogleAccessToken } from "@/lib/googleSlidesApi";
import { denyIfNotLocal } from "@/lib/requireLocal";

/**
 * 「幫我自動建好並部署」——把使用者手動複製貼上 + 走部署精靈那一整段變成一顆按鈕。
 *
 * 建好之後把 scriptId / deploymentId 存起來：之後範本有更新就是**更新同一個部署**，
 * 而不是再建一個新網址。每建一次新部署就多一個 /exec，使用者流程裡填的舊網址會安靜地
 * 停在舊版程式碼上——那種問題他不可能自己發現。
 */
const SCRIPT_ID_KEY = "slidesImageScriptId";
const DEPLOYMENT_ID_KEY = "slidesImageDeploymentId";
const WEB_APP_URL_KEY = "slidesImageWebAppUrl";

const NEEDED_SCOPES = [GOOGLE_SCOPES.scriptProjects, GOOGLE_SCOPES.scriptDeployments, GOOGLE_SCOPES.slides];

export async function GET(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const health = getGoogleTokenHealth();
  const secrets = getSharedSecrets();
  const hasClient = Boolean((secrets.googleOAuthClientId ?? "").trim() && (secrets.googleOAuthRefreshToken ?? "").trim());
  return NextResponse.json({
    hasClient,
    // 現有的授權是在還沒有「建立/部署 Apps Script」這兩項權限時拿的話，這裡就會列出來
    missingScopes: hasClient ? missingGoogleScopes(health?.scope, NEEDED_SCOPES) : NEEDED_SCOPES,
    webAppUrl: getSetting(WEB_APP_URL_KEY) ?? null,
    deployed: Boolean(getSetting(SCRIPT_ID_KEY)),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const secrets = getSharedSecrets();
  const clientId = (secrets.googleOAuthClientId ?? "").trim();
  const clientSecret = (secrets.googleOAuthClientSecret ?? "").trim();
  const refreshToken = (secrets.googleOAuthRefreshToken ?? "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    return NextResponse.json({ ok: false, message: "還沒有連結 Google 帳號——請先到「設定 → Google 帳號」完成一次授權。" });
  }

  let token = (secrets[SLIDES_IMAGE_TOKEN_KEY] ?? "").trim();
  if (!token) {
    token = randomBytes(18).toString("base64url");
    setSharedSecrets({ [SLIDES_IMAGE_TOKEN_KEY]: token });
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken({ clientId, clientSecret, refreshToken });
  } catch (err) {
    return NextResponse.json({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }

  try {
    const result = await deployWebApp({
      accessToken,
      title: "Agent Hub — 換簡報圖片",
      code: googleSlidesImageScriptTemplate(token),
      // 腳本自己需要的權限：它要開簡報、換圖、以及自我測試時建一份新簡報。
      oauthScopes: [GOOGLE_SCOPES.slides],
      existingScriptId: getSetting(SCRIPT_ID_KEY),
      existingDeploymentId: getSetting(DEPLOYMENT_ID_KEY),
      signal: AbortSignal.timeout(120_000),
    });
    setSetting(SCRIPT_ID_KEY, result.scriptId);
    setSetting(DEPLOYMENT_ID_KEY, result.deploymentId);
    setSetting(WEB_APP_URL_KEY, result.webAppUrl);
    return NextResponse.json({
      ok: true,
      webAppUrl: result.webAppUrl,
      message: result.created
        ? "已經幫你建好腳本並部署成網頁應用程式。下一步按「實際換一次圖給我看」確認它真的能動。"
        : "已經把既有的那份腳本更新到最新版（網址沒有變，流程裡填的設定不用改）。",
    });
  } catch (err) {
    const message = err instanceof AppsScriptDeployError ? err.message : err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, message });
  }
}
