import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { startWorkflowRun } from "@/lib/workflow/engine";
import { resolveParams } from "@/lib/relativeDate";
import { getSharedSecrets } from "@/lib/settingsStore";
import { lineTokenMatches, verifyLineSignature, extractLineTextEvents } from "@/lib/lineHook";

const MAX_BODY_BYTES = 512 * 1024;
const MAX_EVENTS_PER_CALL = 5;

/**
 * LINE 訊息觸發端點：把這個網址(經隧道開成公網 HTTPS)填進 LINE Developers 的 Webhook URL，
 * 有人傳訊息給官方帳號就觸發流程。雙重驗證：URL token + X-Line-Signature 簽章(lineChannelSecret)。
 * LINE 平台驗證 webhook 時會送 events:[] 的空包——簽章對就回 200，不觸發任何流程。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; token: string }> }) {
  const { id, token } = await params;
  // 找不到/不合法/token 錯/簽章錯都回同一句——不讓人用回應差異探測哪些流程 id 存在
  const denied = () => NextResponse.json({ error: "找不到這個 LINE webhook(網址、token 或簽章不正確，或尚未啟用)" }, { status: 404 });
  if (!isValidWorkflowId(id)) return denied();
  if (!lineTokenMatches(id, token)) return denied();
  const wf = getWorkflow(id);
  if (!wf) return denied();

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "內容太大(上限 512KB)" }, { status: 413 });
  }
  const channelSecret = getSharedSecrets().lineChannelSecret ?? "";
  if (!verifyLineSignature(channelSecret, raw, req.headers.get("x-line-signature"))) return denied();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "不是合法的 JSON" }, { status: 400 });
  }
  const events = extractLineTextEvents(payload);
  const fired: string[] = [];
  for (const ev of events.slice(0, MAX_EVENTS_PER_CALL)) {
    try {
      const resolved = resolveParams(wf.triggerParams ?? [], {}, new Date());
      const runId = startWorkflowRun(
        id,
        { ...resolved, message: ev.message, userId: ev.userId, replyToken: ev.replyToken },
        { trigger: "line", headed: false },
      );
      fired.push(runId);
    } catch (err) {
      console.error(`[line-hooks] 觸發 ${id} 失敗:`, err);
    }
  }
  if (events.length > MAX_EVENTS_PER_CALL) {
    console.warn(`[line-hooks] 一次收到 ${events.length} 則訊息，只處理前 ${MAX_EVENTS_PER_CALL} 則`);
  }
  // LINE 平台只看 200——驗證包(events:[])或非文字訊息也要回 200，不然它會標 webhook 錯誤
  return NextResponse.json({ ok: true, fired: fired.length });
}

/** 用瀏覽器直接打開網址時給人話說明(不觸發) */
export async function GET() {
  return NextResponse.json({
    hint: "這是 Agent Hub 的 LINE 訊息觸發網址：把它(經 cloudflared/ngrok 等隧道開成公網 HTTPS)填進 LINE Developers 的 Webhook URL。有人傳文字訊息給官方帳號就會觸發流程。",
  });
}
