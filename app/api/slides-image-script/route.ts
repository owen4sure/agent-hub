import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getSharedSecrets, setSharedSecrets } from "@/lib/settingsStore";
import { googleSlidesImageScriptTemplate } from "@/lib/googleSlidesImageScriptTemplate";
import { SLIDES_IMAGE_TOKEN_KEY } from "@/lib/workflow/nodes/googleSlidesReplaceImage";
import { denyIfNotLocal } from "@/lib/requireLocal";

/**
 * 「換簡報圖片」腳本的設定資料：驗證碼 + 已經把驗證碼填好的腳本內容。
 *
 * 驗證碼由平台產生而不是讓使用者自己想：這串字唯一的用途是讓一個公開網址不會被別人拿去改簡報，
 * 「請自己想一組密碼」只會換來 123456。第一次呼叫時產生並存進共用帳密，之後每次都回同一組
 * ——重新產生會讓已經部署好的腳本立刻失效，那是使用者最不預期的事。
 */
export async function GET(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  let token = (getSharedSecrets()[SLIDES_IMAGE_TOKEN_KEY] ?? "").trim();
  if (!token) {
    token = randomBytes(18).toString("base64url");
    setSharedSecrets({ [SLIDES_IMAGE_TOKEN_KEY]: token });
  }
  return NextResponse.json(
    { token, script: googleSlidesImageScriptTemplate(token) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** 部署完按「檢查能不能用」：真的打一次腳本，把「看起來部署好了」變成「確定通了」。 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { scriptUrl?: unknown } | null;
  const scriptUrl = String(body?.scriptUrl ?? "").trim();
  if (!/^https:\/\/script\.google\.com\//.test(scriptUrl)) {
    return NextResponse.json({ ok: false, message: "請貼部署後拿到的 https://script.google.com/... /exec 網址" }, { status: 400 });
  }
  const token = (getSharedSecrets()[SLIDES_IMAGE_TOKEN_KEY] ?? "").trim();
  if (!token) return NextResponse.json({ ok: false, message: "還沒有驗證碼——請重新整理這張卡片" }, { status: 400 });

  try {
    const res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action: "capabilities" }),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let reply: { ok?: boolean; error?: string; actions?: string[] };
    try {
      reply = JSON.parse(text);
    } catch {
      // 最常見的失敗：部署時「誰可以存取」沒選「任何人」，Google 回一頁登入 HTML 而不是 JSON。
      return NextResponse.json({
        ok: false,
        message: "腳本沒有回傳預期的結果——最常見的原因是部署時「誰可以存取」沒有選成「任何人」。請回 Apps Script 用「管理部署作業 → 編輯 → 新版本」重新部署一次。",
      });
    }
    if (!reply.ok) {
      return NextResponse.json({ ok: false, message: reply.error ?? "腳本回報失敗，但沒有說明原因" });
    }
    if (!reply.actions?.includes("replaceSlideImage")) {
      return NextResponse.json({
        ok: false,
        message: "這個網址連得上，但它是舊版(或別的)腳本，沒有換圖功能。請把這張卡片上的腳本重新複製貼上，並用「管理部署作業 → 編輯 → 新版本」重新部署。",
      });
    }
    return NextResponse.json({ ok: true, message: "通了！驗證碼正確、換圖功能已就緒。" });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      ok: false,
      message: `連不到這個網址（${raw.slice(0, 80)}）。請確認網址是部署後拿到的 /exec 結尾網址，而且這台電腦連得上網。`,
    });
  }
}
