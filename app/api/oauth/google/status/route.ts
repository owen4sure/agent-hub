import { NextResponse } from "next/server";
import { getSharedSecrets } from "@/lib/settingsStore";
import { listWorkflows } from "@/lib/workflow/store";
import { checkGoogleTokenNow, getGoogleTokenHealth } from "@/lib/googleTokenHealth";
import {
  GOOGLE_FULL_SCOPES, GOOGLE_SCOPE_LABELS, googleEnableApisUrl, googleRedirectUri, googleScopesForNodes, missingGoogleScopes,
} from "@/lib/googleOAuth";

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
  const health = getGoogleTokenHealth();
  // 「以後不用再回來設定」的保險：比對現有流程真正需要的權限 vs 這串 token 實際拿到的。
  // 缺了就由系統自己開口，不要變成幾天後執行時一個沒人看得懂的 403。
  const neededByGraphs = new Set<string>();
  for (const workflow of listWorkflows()) {
    for (const scope of googleScopesForNodes(workflow.nodes)) neededByGraphs.add(scope);
  }
  const missing = health?.ok ? missingGoogleScopes(health.scope, [...neededByGraphs]) : [];
  return {
    hasClient: Boolean((secrets.googleOAuthClientId ?? "").trim() && (secrets.googleOAuthClientSecret ?? "").trim()),
    hasRefreshToken: Boolean((secrets.googleOAuthRefreshToken ?? "").trim()),
    // 使用者要在 Google Cloud Console 貼的那一行；顯示出來才不用他自己猜是哪個網址。
    redirectUri: googleRedirectUri(req.url),
    // 一個連結把平台會用到的 Google API 全部啟用，不用一個一個找。
    enableApisUrl: googleEnableApisUrl(),
    willRequest: GOOGLE_FULL_SCOPES.map((scope) => ({ scope, label: GOOGLE_SCOPE_LABELS[scope] ?? scope })),
    missingScopes: missing.map((scope) => ({ scope, label: GOOGLE_SCOPE_LABELS[scope] ?? scope })),
    health,
  };
}
