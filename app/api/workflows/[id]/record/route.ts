import { NextResponse } from "next/server";
import { getWorkflow } from "@/lib/workflow/store";
import {
  cancelRecording, describeRecording, finishRecording, recordingStatus, recordingToNodes, scrubRecordedSecrets, startRecording, toNodeCode,
} from "@/lib/workflow/actionRecorder";
import { resolveSharedSessionKeyForGraph } from "@/lib/workflow/sharedLoginSession";
import { isPrivateHost, privateUrlsAllowed } from "@/lib/urlGuard";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/** 現在有沒有在錄。 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(recordingStatus(id), { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ url }` 開始錄製；`{ finish: true }` 結束並回傳「白話覆述 + 掃過帳密的程式碼」。
 *
 * 結束時**不會**自動把它存成步驟——這是刻意的。使用者的原話是「又怕他理解不了」，
 * 所以錄下來的東西只當輸入：先給他看覆述，他確認了才存(存的動作走既有的
 * 「⭐ 存成我的步驟」那條路，包含分辨「精確動作 vs 每次會變的值」)。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { url?: unknown; finish?: unknown } | null;

  if (body?.finish === true) {
    try {
      const { rawCode } = await finishRecording(id);
      const { code, actionCount } = toNodeCode(rawCode);
      // **掃帳密一定要在回傳/存檔之前**：錄製器會把使用者打的密碼寫成字面字串。
      const scrubbed = scrubRecordedSecrets(code);
      recordAuditFromRequest(req, "workflow.record", id, {
        actionCount, replacedSecrets: scrubbed.replacedKeys.length, clearedPasswordFields: scrubbed.suspiciousFields.length,
      });
      return NextResponse.json({
        ok: true,
        actionCount,
        code: scrubbed.code,
        actions: describeRecording(scrubbed.code),
        replacedKeys: scrubbed.replacedKeys,
        clearedPasswordFields: scrubbed.suspiciousFields,
        // 示範一次變流程(#100):同一份錄製切成帶白話說明的步驟串,前端可一鍵加進流程圖
        proposal: recordingToNodes(scrubbed.code),
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "結束錄製失敗" }, { status: 400 });
    }
  }

  const url = typeof body?.url === "string" && body.url.trim() ? body.url.trim() : "about:blank";
  if (url !== "about:blank") {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return NextResponse.json({ error: "網址格式不正確" }, { status: 400 }); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return NextResponse.json({ error: "只接受 http/https 網址" }, { status: 400 });
    }
    // 跟 /api/fetch-url、手動登入套同一套 SSRF 防護：這台機器可能部署在雲端，
    // 貼一個內網管理介面或雲端 metadata 網址進來，開的仍是同一個瀏覽器網路環境。
    if (!privateUrlsAllowed() && await isPrivateHost(parsed.hostname)) {
      return NextResponse.json({
        error: "這個網址指向內部/私有網段，基於安全考量不開啟。若這是刻意的內網需求，可設定環境變數 AGENT_HUB_ALLOW_PRIVATE_URLS=1 解除限制。",
      }, { status: 400 });
    }
  }

  try {
    startRecording(id, url, resolveSharedSessionKeyForGraph(wf.nodes));
    return NextResponse.json({
      ok: true,
      message: "已開啟錄製視窗——在那個瀏覽器裡把這件事做一次給我看，做完回來按「我做完了」。",
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "無法開始錄製" }, { status: 409 });
  }
}

/** 放棄這次錄製(不留下任何檔案)。 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const { id } = await params;
  cancelRecording(id);
  return NextResponse.json({ ok: true });
}
