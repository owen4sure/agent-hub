import { NextResponse } from "next/server";
import { getSharedSecrets } from "@/lib/settingsStore";
import { listWorkflows } from "@/lib/workflow/store";
import { GOOGLE_SCOPES, buildGoogleAuthUrl, googleRedirectUri, googleScopesForNodes, issueOAuthState } from "@/lib/googleOAuth";

/**
 * 「連結 Google 帳號」按下去之後的第一站：把使用者導到 Google 的同意畫面。
 *
 * 權限範圍由平台自己算——掃過所有流程實際用到什麼(含 custom-code 裡真的打了哪個 API)。
 * 舊流程要使用者自己到 OAuth Playground 逐一挑，挑漏一個的代價是「幾天後執行時 403」，
 * 而那時候沒有人會聯想到是當初少勾了一個範圍(真實踩過)。
 */
export async function GET(req: Request) {
  const secrets = getSharedSecrets();
  const clientId = (secrets.googleOAuthClientId ?? "").trim();
  if (!clientId) {
    return NextResponse.json({
      error: "還沒有 Google 用戶端 ID。請先到設定頁填入 googleOAuthClientId 與 googleOAuthClientSecret（在 Google Cloud Console →「憑證」建立，只需要做一次）。",
    }, { status: 400 });
  }

  const redirectUri = googleRedirectUri(req.url);
  // 所有流程一起算：帳密是全機共用的(依欄位名)，一次授權就該涵蓋這台電腦上所有 Google 相關的流程，
  // 不然使用者每加一條流程就要重新授權一次。
  const scopes = new Set<string>();
  for (const workflow of listWorkflows()) {
    for (const scope of googleScopesForNodes(workflow.nodes)) scopes.add(scope);
  }
  // 一個 Google 流程都還沒有時(第一次設定)，先給最常用的兩個，讓使用者可以先授權再建流程。
  if (scopes.size === 0) {
    scopes.add(GOOGLE_SCOPES.sheetsWrite);
    scopes.add(GOOGLE_SCOPES.slides);
  }
  const scopeList = [...scopes].sort();
  const state = issueOAuthState(redirectUri, scopeList);
  return NextResponse.redirect(buildGoogleAuthUrl({ clientId, redirectUri, scopes: scopeList, state }));
}
