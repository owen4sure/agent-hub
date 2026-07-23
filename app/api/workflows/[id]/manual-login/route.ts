import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { closeManualLogin, isManualLoginOpen, openManualLogin } from "@/lib/workflow/manualLogin";
import { isPrivateHost, privateUrlsAllowed } from "@/lib/urlGuard";

/** 開一個有頭瀏覽器讓使用者本人手動登入(Google 等會擋自動化登入的網站)；
 * cookies 每幾秒存回這條流程的 browser session，之後自動化執行直接是已登入狀態。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { url?: unknown };
  const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : "https://accounts.google.com/";
  let parsed: URL;
  try { parsed = new URL(url); } catch { return NextResponse.json({ error: "網址格式不正確" }, { status: 400 }); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return NextResponse.json({ error: "只接受 http/https 網址" }, { status: 400 });
  }
  // 跟專案其他「打開使用者給的網址」入口(如 /api/fetch-url)套同一套 SSRF 防護，不因為這裡是
  // 開有頭瀏覽器給使用者本人看就當作沒有風險——這台機器仍可能部署在雲端，貼一個內網管理介面/
  // 雲端 metadata 網址進來，畫面一樣會被算進同一個瀏覽器的網路環境裡，防護要保持一致。
  if (!privateUrlsAllowed() && await isPrivateHost(parsed.hostname)) {
    return NextResponse.json({ error: "這個網址指向內部/私有網段，基於安全考量不開啟。若這是刻意的內網需求，可設定環境變數 AGENT_HUB_ALLOW_PRIVATE_URLS=1 解除限制。" }, { status: 400 });
  }
  try {
    const { usingRealChrome } = await openManualLogin(id, parsed.toString());
    return NextResponse.json({
      ok: true,
      message: `已開啟${usingRealChrome ? " Chrome" : "瀏覽器"}視窗——請在裡面親手完成登入，登入成功後直接關掉那個視窗即可。登入狀態會自動存進這條流程，之後執行不會再經過登入頁。`,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "無法開啟瀏覽器" }, { status: 409 });
  }
}

/** 關掉這條流程開著的手動登入視窗(最後狀態已在背景持續存檔) */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const closed = await closeManualLogin(id);
  return NextResponse.json({ ok: true, closed });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  return NextResponse.json({ open: isManualLoginOpen(id) });
}
