/**
 * 縱深防禦：最危險的那幾支 API 在 route 內自己再驗一次本機權杖。
 *
 * 為什麼不只靠 proxy.ts：proxy 是「應用程式前面的一層」，它整層被繞過是真實發生過的漏洞類別
 * (Next.js 16.2.11 之前的 middleware/proxy bypass 公告)。把唯一的門放在可能被整層跳過的地方
 * 不叫防線。所以「能執行任意程式碼」「能讀明碼帳密」「能開瀏覽器」這種等級的端點，
 * 在 handler 內再驗一次——這一次是在應用程式裡，繞不掉。
 *
 * 刻意**不**套用在全部 87 支：每支都貼一段驗證，就會有人漏貼、或為了方便加豁免，
 * 最後變成看起來有防護但實際千瘡百孔。分層是明確的：proxy 負責全面覆蓋，
 * 這支負責「就算 proxy 掛了也絕不能讓外人碰」的那幾條。
 */

import { NextResponse } from "next/server";
import { LOCAL_TOKEN_COOKIE, LOCAL_TOKEN_HEADER, localTokenMatches } from "./localToken";

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/**
 * 通過就回 null，沒通過就回一個可以直接 return 的 401 回應。
 * 用法：`const denied = denyIfNotLocal(req); if (denied) return denied;`
 */
export function denyIfNotLocal(req: Request): NextResponse | null {
  const presented = req.headers.get(LOCAL_TOKEN_HEADER) ?? cookieValue(req, LOCAL_TOKEN_COOKIE);
  if (localTokenMatches(presented)) return null;
  return NextResponse.json({
    error: "缺少本機存取權杖：請從瀏覽器開 http://127.0.0.1:3000 操作。"
      + `如果你是用腳本或 curl 呼叫，把 data/local-token 的內容放進 ${LOCAL_TOKEN_HEADER} header。`,
  }, { status: 401 });
}
