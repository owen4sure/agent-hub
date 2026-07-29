import { NextResponse } from "next/server";
import { getSharedSecrets } from "@/lib/settingsStore";
import { checkGoogleTokenNow, getGoogleTokenHealth } from "@/lib/googleTokenHealth";
import { googleRedirectUri } from "@/lib/googleOAuth";

/** 設定頁的「Google 帳號」卡片要顯示的東西。GET＝看最近一次結果，POST＝現在就重新驗一次。 */
export async function GET(req: Request) {
  return NextResponse.json(snapshot(req));
}

export async function POST(req: Request) {
  await checkGoogleTokenNow();
  return NextResponse.json(snapshot(req));
}

function snapshot(req: Request) {
  const secrets = getSharedSecrets();
  return {
    hasClient: Boolean((secrets.googleOAuthClientId ?? "").trim() && (secrets.googleOAuthClientSecret ?? "").trim()),
    hasRefreshToken: Boolean((secrets.googleOAuthRefreshToken ?? "").trim()),
    // 使用者要在 Google Cloud Console 貼的那一行；顯示出來才不用他自己猜是哪個網址。
    redirectUri: googleRedirectUri(req.url),
    health: getGoogleTokenHealth(),
  };
}
