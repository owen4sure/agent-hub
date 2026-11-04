import { NextResponse } from "next/server";
import { getSharedSecrets } from "@/lib/settingsStore";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/**
 * 明碼還原：使用者在 /settings 主動點「顯示並複製」才會打這支，跟 GET /api/secrets(頁面
 * 一載入就打、只回布林值)分開，明碼不會被動出現在一般的頁面載入回應裡。
 *
 * **為什麼是 POST 而不是 GET**(稽核指出的 P0，三個問題疊加)：
 * ①proxy.ts 的 Origin 檢查只套用在非 GET/HEAD 方法上，所以 GET 版本完全不過 Origin 檢查；
 * ②欄位名稱會出現在 access log、瀏覽器歷史紀錄、shell history 裡；
 * ③「跨站讀不到回應」原本是靠瀏覽器的 CORS 行為，也就是把自己的授權檢查外包給瀏覽器。
 * 改成 POST 之後自動獲得 Origin 檢查，key 走 body 不進 URL，再加上本機權杖與稽核紀錄，
 * 這支端點不再依賴任何一層「別人替我擋」。
 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key) return NextResponse.json({ error: "缺少 key" }, { status: 400 });
  const secrets = getSharedSecrets();
  if (!(key in secrets)) return NextResponse.json({ error: "找不到這個欄位" }, { status: 404 });
  // 只記「看了哪個欄位」，永遠不記值——稽核軌跡自己變成第二個洩漏管道就本末倒置了。
  recordAuditFromRequest(req, "secret.reveal", key);
  return NextResponse.json({ value: secrets[key] });
}
