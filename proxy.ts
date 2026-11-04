import { NextRequest, NextResponse } from "next/server";
import {
  LOCAL_TOKEN_COOKIE,
  LOCAL_TOKEN_HEADER,
  isPublicApiPath,
  localTokenMatches,
  readLocalToken,
} from "@/lib/localToken";

/**
 * 本機服務的存取控制（跨站防護 + 本機權杖）。
 *
 * 為什麼需要：伺服器雖然只綁 127.0.0.1，但「瀏覽器」會替任何網頁發請求到 localhost——
 * 使用者只要一邊開著 Agent Hub、一邊瀏覽某個惡意網頁，該網頁就能用「簡單請求」
 * (Content-Type: text/plain，不觸發 CORS 預檢)直接 POST 到 /api/workflows/import 塞入
 * 含 custom-code 節點的流程再觸發 /run——custom-code 是在 Node 行程內執行的，等於
 * 任何網站都能拿到整台電腦的控制權。CORS 只擋「讀回應」，不擋「副作用」，所以必須自己驗來源。
 *
 * 防護三層：
 * 1. Host 白名單(所有 /api 請求)：擋 DNS rebinding(攻擊者網域解析到 127.0.0.1 後，
 *    same-origin policy 完全失效，連 GET 讀 secrets 都讀得到)。
 * 2. Origin 白名單(所有非 GET 的 /api 請求)：瀏覽器發跨站 POST 一定會帶 Origin，
 *    不是本機來源就擋。
 * 3. **本機權杖**(所有 /api 請求，除了 lib/localToken.ts 白名單裡那幾條)：
 *    原本第 2 層刻意放行「沒有 Origin 的請求」(curl、腳本、同機工具)，理由是「那些本來就在
 *    本機」——稽核指出這個假設在企業機器上不成立(MDM agent、防毒、公司內部工具、某個套件的
 *    postinstall 都在跑)，而且同一台機器可能有其他 OS 使用者帳號。權杖把「連得到 127.0.0.1」
 *    和「能驅動引擎」拆開。它同時是第 1/2 層的獨立備援：cookie 是 SameSite=Strict，
 *    不靠 header 比對就擋掉所有跨站請求(Next 16.2.11 之前真的出過 proxy bypass 漏洞)。
 *    權杖確實擋不住什麼，在 lib/localToken.ts 與 SECURITY.md 寫得很清楚，不誇大。
 *
 * 頁面請求(非 /api)在這裡順手把權杖寫成 httpOnly cookie——這是使用者完全無感的關鍵：
 * 瀏覽器之後每次同源 fetch/EventSource 都會自動帶上，前端不用改任何呼叫點。
 */
const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** cookie 十年不過期：這是本機工具，沒有「重新登入」這種概念，過期只會變成謎樣的壞掉。 */
const COOKIE_MAX_AGE = 10 * 365 * 24 * 60 * 60;

function attachToken(res: NextResponse, token: string | null): NextResponse {
  if (!token) return res;
  res.cookies.set(LOCAL_TOKEN_COOKIE, token, {
    httpOnly: true,
    // Strict：跨站請求(含惡意網頁的 fetch)一律不帶這個 cookie。
    sameSite: "strict",
    // 本機是 http，secure 會讓 cookie 根本設不進去。
    secure: false,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 頁面請求：不驗權杖(不然第一次打開會被自己擋在門外)，只負責把 cookie 補上。
  if (!pathname.startsWith("/api/")) {
    const token = readLocalToken();
    if (token && req.cookies.get(LOCAL_TOKEN_COOKIE)?.value === token) return NextResponse.next();
    return attachToken(NextResponse.next(), token);
  }

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
  if (!isPublicApiPath(pathname)) {
    const presented = req.headers.get(LOCAL_TOKEN_HEADER) ?? req.cookies.get(LOCAL_TOKEN_COOKIE)?.value ?? null;
    if (!localTokenMatches(presented)) {
      return NextResponse.json({
        // host 前面已驗過是本機，拿來組指路網址不會被外部值污染；不寫死 3000，實際 port 是多少就指多少。
        error: `缺少本機存取權杖：請從瀏覽器開 http://${host || "127.0.0.1:3000"} 操作。`
          + "如果你是用腳本或 curl 呼叫，把 data/local-token 的內容放進 " + LOCAL_TOKEN_HEADER + " header。",
      }, { status: 401 });
    }
  }
  return NextResponse.next();
}

export const config = {
  // /api 是安全檢查；其餘頁面請求只為了發權杖 cookie。刻意排除 _next 靜態資源與圖示，
  // 那些每頁幾十個請求都跑一遍 proxy 沒有意義。
  matcher: ["/api/:path*", "/((?!_next/static|_next/image|favicon.ico).*)"],
};
