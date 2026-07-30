import { NextResponse } from "next/server";
import OpenAI from "openai";
import { callAIWithRetry } from "@/lib/aiRetry";
import { checkVisionAnswer, makeVisionProbe } from "@/lib/modelVisionProbe";
import { markModelVerified, resolveModel } from "@/lib/modelProviders";
import { denyIfNotLocal } from "@/lib/requireLocal";

/**
 * 測一個模型通不通、看不看得懂圖片——**可以在還沒儲存之前就測**。
 *
 * 為什麼要能先測再存(使用者要求：「填入要可以驗證，也要能驗證是否能看圖」)：
 * 原本要先存下來、才能點模型代號測連線。第一次接自己的模型時位址打錯是常態，
 * 「存了一個錯的再回頭改」比「當場測到通了才存」多繞好幾圈。
 *
 * 安全性說明：這支端點會用**使用者給的網址**發出伺服器端請求，看起來像 SSRF 面，
 * 但它需要本機存取權杖(denyIfNotLocal)，而且這個功能的本意就是連到區網裡的地端模型——
 * 套用 urlGuard 的私有網段封鎖會讓整個功能失效。能呼叫這支端點的人本來就已經
 * 通過本機權杖驗證，也本來就能直接存 provider 讓執行期去打同一個網址。
 */
// 純文字問一句話很快；**看圖要傳一張圖上去、模型也要多花時間讀**，不能用同一個逾時。
// 這個專案記錄過免費 gateway 一般回應就要 30-60 秒，看圖再更久。
const TEXT_TIMEOUT_MS = 25_000;
const VISION_TIMEOUT_MS = 60_000;

function makeClient(baseUrl: string, apiKey: string, timeoutMs: number): OpenAI {
  return new OpenAI({ baseURL: baseUrl, apiKey: apiKey || "not-needed", timeout: timeoutMs, maxRetries: 0 });
}

function friendlyError(raw: string, label: string, baseUrl: string): string {
  // 「連不到」跟「太慢沒回應」是兩件完全不同的事，給的下一步也不一樣——
  // 混為一談會讓使用者跑去檢查一個其實沒問題的網址(實測踩到：gateway 回 504 過載，
  // 訊息卻叫他去確認位址有沒有打錯)。
  if (/504|502|503|Gateway Time-?out|overload/i.test(raw)) {
    return `這個服務有回應，但它自己回報忙不過來（${label}）。這通常是對方暫時過載，過一下再測一次；位址沒有問題。原始訊息：${raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 100)}`;
  }
  if (/ETIMEDOUT|timed out|timeout/i.test(raw)) {
    return `連得上，但等太久沒有回應（${label}：${baseUrl}）。可能是這個服務正忙、或這個模型在這台機器上跑太慢。過一下再測，或先換一個比較小的模型試試。`;
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|Connection error|fetch failed/i.test(raw)) {
    return `連不到這個服務（${label}：${baseUrl}）。請確認：①那台機器開著而且服務在跑 ②網址和連接埠沒打錯 ③這台電腦連得到它。原始訊息：${raw.slice(0, 120)}`;
  }
  if (/401|403|invalid.*key|unauthorized/i.test(raw)) return `這個服務說金鑰不對或沒有權限。原始訊息：${raw.slice(0, 140)}`;
  if (/404|model.*not.*found|does not exist/i.test(raw)) return `這個服務上找不到這個模型代號。請確認代號拼法（大小寫也要一樣）。原始訊息：${raw.slice(0, 140)}`;
  return raw.slice(0, 200);
}

export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as
    { baseUrl?: unknown; apiKey?: unknown; model?: unknown; kind?: unknown; ref?: unknown } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });

  // 已經存起來的來源可以只給 ref；還沒存的(新增表單)直接給 baseUrl/apiKey/model。
  let baseUrl = String(body.baseUrl ?? "").trim();
  let apiKey = String(body.apiKey ?? "");
  let model = String(body.model ?? "").trim();
  let label = "這個來源";
  if (typeof body.ref === "string" && body.ref) {
    const resolved = resolveModel(body.ref);
    baseUrl = resolved.provider.baseUrl;
    apiKey = resolved.provider.apiKey;
    model = resolved.model;
    label = resolved.provider.label;
  }
  if (!baseUrl || !model) return NextResponse.json({ error: "要先填 Base URL 和模型代號" }, { status: 400 });
  if (!/^https?:\/\//i.test(baseUrl)) return NextResponse.json({ error: "Base URL 要以 http:// 或 https:// 開頭" }, { status: 400 });

  const kind = body.kind === "vision" ? "vision" : "text";
  const client = makeClient(baseUrl, apiKey, kind === "vision" ? VISION_TIMEOUT_MS : TEXT_TIMEOUT_MS);

  try {
    if (kind === "text") {
      const content = await callAIWithRetry(
        () => client.chat.completions
          .create({ model, messages: [{ role: "user", content: "say OK" }], max_tokens: 10 })
          .then((res) => res.choices[0]?.message?.content ?? ""),
        { label: `測試連線(${model})`, maxAttempts: 2 },
      );
      if (typeof body.ref === "string" && body.ref) markModelVerified(body.ref, true);
      return NextResponse.json({ ok: true, kind, message: `連得上，它回答：「${(content || "(空回應)").slice(0, 60)}」` });
    }

    const probe = await makeVisionProbe();
    if (!probe) {
      // 產不出測試圖時老實說「沒辦法自動測」，不要假裝測過或預設當成看得懂。
      return NextResponse.json({
        ok: false, kind, undetermined: true,
        message: "這台機器沒辦法產生測試圖片（缺少影像處理元件），所以無法自動驗證看圖能力。可以先不勾，之後真的用到讀圖時再確認。",
      });
    }
    const content = await callAIWithRetry(
      () => client.chat.completions.create({
        model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: probe.prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${probe.imageBase64}` } },
          ],
        }],
        max_tokens: 40,
      }).then((res) => res.choices[0]?.message?.content ?? ""),
      { label: `測試看圖(${model})`, maxAttempts: 2 },
    );
    const verdict = checkVisionAnswer(content, probe.expected);
    return NextResponse.json({ ok: verdict.ok, kind, message: verdict.message });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (typeof body.ref === "string" && body.ref) markModelVerified(body.ref, false);
    return NextResponse.json({ ok: false, kind, message: friendlyError(raw, label, baseUrl) });
  }
}
