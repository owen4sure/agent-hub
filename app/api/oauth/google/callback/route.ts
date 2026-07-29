import { getSharedSecrets, setSharedSecrets } from "@/lib/settingsStore";
import { claimOAuthState, exchangeGoogleCode, googleAuthErrorMessage } from "@/lib/googleOAuth";
import { recordGoogleTokenHealth } from "@/lib/googleTokenHealth";

/**
 * Google 同意完之後導回這裡。授權碼由**後端**換成 refresh token 再存起來——
 * 使用者從頭到尾不會看到 token 這個東西，也就不可能貼錯、貼到不同組憑證換出來的值
 * （那是舊的手動流程最常見的壞法：三串值必須來自同一次操作，混到就是 unauthorized_client）。
 *
 * 這是一個 GET 導向頁：回傳一頁人看得懂的結果，不是 JSON。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const error = url.searchParams.get("error") ?? "";

  const claimed = claimOAuthState(state);
  if (!claimed) {
    return resultPage(false, "這個授權連結已經過期或不是從這台平台發起的。請回設定頁重新按一次「連結 Google 帳號」。");
  }
  if (error) return resultPage(false, googleAuthErrorMessage(error));
  if (!code) return resultPage(false, "Google 沒有回傳授權碼，請重新按一次連結。");

  const secrets = getSharedSecrets();
  const clientId = (secrets.googleOAuthClientId ?? "").trim();
  const clientSecret = (secrets.googleOAuthClientSecret ?? "").trim();
  if (!clientId || !clientSecret) {
    return resultPage(false, "設定頁裡的 Google 用戶端 ID／密鑰不完整，無法完成授權。");
  }

  const exchanged = await exchangeGoogleCode({ clientId, clientSecret, code, redirectUri: claimed.redirectUri });
  if (!exchanged.ok) return resultPage(false, exchanged.error);

  // 只覆蓋 refresh token 這一個欄位——設定是全機共用的，整包寫回會把別人的欄位一起蓋掉。
  setSharedSecrets({ googleOAuthRefreshToken: exchanged.refreshToken });
  recordGoogleTokenHealth({ ok: true, scope: exchanged.scope });
  const granted = exchanged.scope.split(/\s+/).filter(Boolean);
  const missing = claimed.scopes.filter((scope) => !granted.includes(scope));
  return resultPage(
    true,
    missing.length > 0
      ? `已連結，但 Google 沒有給滿要求的權限（少了 ${missing.join("、")}）。少的那些對應的步驟執行時會失敗，建議再按一次連結並在同意畫面把全部項目勾起來。`
      : "已連結 Google 帳號，之後所有 Google 步驟都會直接使用這個授權，你不用再手動處理任何 token。",
  );
}

function resultPage(ok: boolean, message: string): Response {
  const title = ok ? "✅ Google 帳號已連結" : "⚠️ 沒有完成連結";
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  body{font-family:-apple-system,"Noto Sans TC",sans-serif;background:#0f1115;color:#e6e8ee;margin:0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{max-width:520px;background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:24px;line-height:1.75}
  h1{font-size:18px;margin:0 0 12px}
  a{display:inline-block;margin-top:18px;color:#0f1115;background:#7aa2f7;padding:8px 14px;border-radius:8px;
    text-decoration:none;font-weight:600}
</style></head><body><div class="card">
<h1>${title}</h1><div>${escapeHtml(message)}</div>
<a href="/settings">回設定頁</a>
</div></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));
}
