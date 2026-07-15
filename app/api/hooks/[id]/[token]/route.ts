import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { QueueCapacityError, startWorkflowRun } from "@/lib/workflow/engine";
import { resolveParams } from "@/lib/relativeDate";
import { webhookTokenMatches } from "@/lib/webhookStore";

const MAX_BODY_BYTES = 512 * 1024;

/**
 * Webhook 觸發端點：POST http://127.0.0.1:3000/api/hooks/<workflowId>/<token>
 * token 在「觸發」面板啟用後取得(URL 即認證)。POST 的 JSON 欄位會併進觸發參數，
 * 下游節點直接用 {{欄位}} 引用。伺服器只綁本機，所以打得到的只有這台電腦上的程式。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; token: string }> }) {
  const { id, token } = await params;
  // 找不到/不合法/token 錯都回同一句——不讓人用回應差異探測哪些流程 id 存在
  const denied = () => NextResponse.json({ error: "找不到這個 webhook(網址或 token 不正確，或尚未啟用)" }, { status: 404 });
  if (!isValidWorkflowId(id)) return denied();
  if (!webhookTokenMatches(id, token)) return denied();
  const wf = getWorkflow(id);
  // 所有無人值守觸發都只能跑正式流程；草稿可先保留 token/設定，但絕不能在背景做副作用。
  if (!wf || wf.status !== "official") return denied();

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "內容太大(上限 512KB)" }, { status: 413 });
  }
  let body: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      else body = { payload: parsed }; // 陣列/純值也收，包進 payload 欄位
    } catch {
      body = { payload: raw }; // 非 JSON 的內容原樣給下游(有些工具只會送純文字)
    }
  }

  try {
    // 宣告過的觸發參數走 resolveParams(套預設值/解析日期 token)；沒宣告的欄位原樣透傳給下游
    const resolved = resolveParams(wf.triggerParams ?? [], body, new Date());
    const runId = startWorkflowRun(id, { ...body, ...resolved }, { trigger: "webhook", headed: false });
    return NextResponse.json({ ok: true, runId });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: err instanceof QueueCapacityError ? 429 : 500, headers: err instanceof QueueCapacityError ? { "Retry-After": "10" } : undefined },
    );
  }
}

/** 用瀏覽器直接打開網址時給人話說明(不觸發) */
export async function GET() {
  return NextResponse.json({
    hint: "這是 Agent Hub 的 webhook 觸發網址：請用 POST 呼叫(GET 不會觸發)。POST 的 JSON 欄位會變成流程裡可用的 {{欄位}}。",
    example: `curl -X POST <這個網址> -H "Content-Type: application/json" -d '{"note":"hello"}'`,
  });
}
