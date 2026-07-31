import { NextResponse } from "next/server";
import { getSharedSecrets } from "@/lib/settingsStore";
import { getGoogleAccessToken } from "@/lib/googleSlidesApi";
import { buildSelfTestImage } from "@/lib/slidesSelfTestImage";
import { pngPixelSize } from "@/lib/xlsxCellStyle";
import { SLIDES_IMAGE_TOKEN_KEY } from "@/lib/workflow/nodes/googleSlidesReplaceImage";
import { denyIfNotLocal } from "@/lib/requireLocal";

/**
 * 端到端自我測試：**真的打一次 Google，真的換一張圖，然後把結果的畫面抓回來給使用者看。**
 *
 * 為什麼要有這支：使用者問的是「我怎麼確定你真的會做？」——這個問題沒辦法用「程式碼看起來對」
 * 或「單元測試都過」回答，因為那些都沒有真的碰過 Google。但拿正式簡報來示範又有風險
 * (正式簡報是要拿去開會的)。所以讓腳本自己開一份用完即棄的簡報跑完整條路，
 * 再用 Slides API 把那一頁的縮圖抓回來——看到圖 = 這條路真的通了，而且正式簡報一個字都沒動。
 *
 * 縮圖為什麼要伺服器端抓：Google 回的縮圖網址是短效的 googleusercontent 連結，
 * 直接丟給瀏覽器常常因為快取/referrer 而載不出來；抓成 base64 交給前端最穩。
 */
const SELF_TEST_TIMEOUT_MS = 90_000;

export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { scriptUrl?: unknown } | null;
  const scriptUrl = String(body?.scriptUrl ?? "").trim();
  if (!/^https:\/\/script\.google\.com\//.test(scriptUrl)) {
    return NextResponse.json({ ok: false, message: "請先貼上部署後拿到的 /exec 網址" }, { status: 400 });
  }
  const secrets = getSharedSecrets();
  const token = (secrets[SLIDES_IMAGE_TOKEN_KEY] ?? "").trim();
  if (!token) return NextResponse.json({ ok: false, message: "還沒有驗證碼——請重新整理這張卡片" }, { status: 400 });

  const sample = await buildSelfTestImage();
  const size = pngPixelSize(Buffer.from(sample.base64, "base64"));

  let reply: { ok?: boolean; error?: string; presentationId?: string; presentationUrl?: string; pageObjectId?: string; width?: number; height?: number };
  try {
    const res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token, action: "selfTest", imageBase64: sample.base64,
        imageWidthPx: size?.width, imageHeightPx: size?.height,
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(SELF_TEST_TIMEOUT_MS),
    });
    const text = await res.text();
    try {
      reply = JSON.parse(text);
    } catch {
      return NextResponse.json({
        ok: false,
        message: "腳本沒有回傳預期的結果——最常見的原因是部署時「誰可以存取」沒有選成「任何人」。請回 Apps Script 用「管理部署作業 → 編輯 → 新版本」重新部署一次。",
      });
    }
  } catch (err) {
    return NextResponse.json({
      ok: false,
      message: `連不到換圖腳本（${err instanceof Error ? err.message.slice(0, 80) : String(err)}）。請確認網址是 /exec 結尾、而且已經部署過。`,
    });
  }

  if (!reply.ok) {
    // 舊版腳本沒有 selfTest 這個動作——直接講清楚要重新部署，不要讓使用者對著「不認得的動作」猜。
    const hint = /不認得的動作/.test(reply.error ?? "")
      ? "你部署的是舊版腳本(還沒有自我測試功能)。請把這張卡片上的腳本重新複製貼上，並用「管理部署作業 → 編輯 → 新版本」重新部署。"
      : reply.error ?? "腳本回報失敗，但沒有說明原因";
    return NextResponse.json({ ok: false, message: hint });
  }

  // 把換完的那一頁抓成圖片給使用者看——這才是「真的做到了」的證據，光說「成功」沒有說服力。
  let thumbnailBase64: string | null = null;
  let thumbnailNote = "";
  try {
    const accessToken = await getGoogleAccessToken({
      clientId: secrets.googleOAuthClientId ?? "",
      clientSecret: secrets.googleOAuthClientSecret ?? "",
      refreshToken: secrets.googleOAuthRefreshToken ?? "",
    });
    const meta = await fetch(
      `https://slides.googleapis.com/v1/presentations/${reply.presentationId}/pages/${reply.pageObjectId}/thumbnail?thumbnailProperties.thumbnailSize=LARGE`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) },
    ).then((r) => r.json());
    if (meta?.contentUrl) {
      const img = await fetch(meta.contentUrl, { signal: AbortSignal.timeout(30_000) });
      thumbnailBase64 = Buffer.from(await img.arrayBuffer()).toString("base64");
    } else {
      thumbnailNote = "（換圖成功了，但抓不到預覽圖——直接點開下面的測試簡報就看得到）";
    }
  } catch {
    thumbnailNote = "（換圖成功了，但抓不到預覽圖——直接點開下面的測試簡報就看得到）";
  }

  return NextResponse.json({
    ok: true,
    message: `成功：腳本自己開了一份測試簡報、放了一張灰色佔位圖，再用跟正式流程完全相同的程式碼把它換成表格圖。${thumbnailNote}`,
    presentationUrl: reply.presentationUrl ?? null,
    thumbnailBase64,
  });
}
