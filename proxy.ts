import { NextRequest, NextResponse } from "next/server";

/**
 * 本機服務的跨站防護(CSRF / DNS rebinding)。
 *
 * 為什麼需要：伺服器雖然只綁 127.0.0.1，但「瀏覽器」會替任何網頁發請求到 localhost——
 * 使用者只要一邊開著 Agent Hub、一邊瀏覽某個惡意網頁，該網頁就能用「簡單請求」
 * (Content-Type: text/plain，不觸發 CORS 預檢)直接 POST 到 /api/workflows/import 塞入
 * 含 custom-code 節點的流程再觸發 /run——custom-code 是在 Node 行程內執行的，等於
 * 任何網站都能拿到整台電腦的控制權。CORS 只擋「讀回應」，不擋「副作用」，所以必須自己驗來源。
 *
 * 防護兩層：
 * 1. Host 白名單(所有 /api 請求)：擋 DNS rebinding(攻擊者網域解析到 127.0.0.1 後，
 *    same-origin policy 完全失效，連 GET 讀 secrets 都讀得到)。
 * 2. Origin 白名單(所有非 GET 的 /api 請求)：瀏覽器發跨站 POST 一定會帶 Origin，
 *    不是本機來源就擋。沒有 Origin header 的請求(curl、腳本、同機工具)放行——
 *    那些本來就在本機、不屬於瀏覽器跨站威脅模型。
 */
const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function proxy(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (!HOST_RE.test(host)) {
    return NextResponse.json({ error: "此服務只接受本機(localhost)請求" }, { status: 403 });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (origin && !ORIGIN_RE.test(origin)) {
      return NextResponse.json({ error: "拒絕來自外部網站的跨站請求" }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
