import { NextResponse } from "next/server";
import { getSharedSecrets } from "@/lib/settingsStore";
import { GOOGLE_FULL_SCOPES, buildGoogleAuthUrl, googleRedirectUri, issueOAuthState } from "@/lib/googleOAuth";

/**
 * 「連結 Google 帳號」按下去之後的第一站：把使用者導到 Google 的同意畫面。
 *
 * 權限範圍一次要齊平台所有 Google 功能(見 GOOGLE_FULL_SCOPES)，使用者不用挑、也不用之後
 * 「用到了才回來再設定一次」。舊流程要使用者自己到 OAuth Playground 逐一勾，勾漏一個的代價是
 * 「幾天後執行時 403」，而那時候沒有人會聯想到是當初少勾了一個範圍(真實踩過)。
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
  // 一次要齊平台所有 Google 功能的權限，不按「現在這幾條流程用到什麼」逐次要——
  // 使用者的流程會長大，逐次授權的代價是「下個月加一步就撞 403，然後要他再設定一次」。
  // 已經授權過的範圍會被 include_granted_scopes 保留，所以重按也不會弄丟東西。
  const scopeList = [...GOOGLE_FULL_SCOPES].sort();
  const state = issueOAuthState(redirectUri, scopeList);
  return NextResponse.redirect(buildGoogleAuthUrl({ clientId, redirectUri, scopes: scopeList, state }));
}
