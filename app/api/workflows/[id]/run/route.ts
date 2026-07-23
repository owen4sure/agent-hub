import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId, saveWorkflow } from "@/lib/workflow/store";
import { MissingWorkflowSettingsError, QueueCapacityError, startWorkflowRun } from "@/lib/workflow/engine";
import { resolveParams } from "@/lib/relativeDate";
import { workflowExecutionFingerprint } from "@/lib/workflow/fingerprint";
import { claimPreviewReplay, releasePreviewReplay } from "@/lib/workflow/previewReplay";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // id 不合法時 getWorkflow 會直接 throw(擋路徑穿越)，這裡先擋下來回 404 而不是 500
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "請求內容不是有效的 JSON 物件" }, { status: 400 });
  }
  if (body.params !== undefined && (!body.params || typeof body.params !== "object" || Array.isArray(body.params))) {
    return NextResponse.json({ error: "params 必須是欄位名稱與值組成的物件" }, { status: 400 });
  }
  if (body.headed !== undefined && typeof body.headed !== "boolean") {
    return NextResponse.json({ error: "headed 必須是 true 或 false" }, { status: 400 });
  }
  // 「只測試,不更改任何資料」勾選:明確要求安全排練才傳 true(只認 true,方向是「要求更少影響」所以安全)。
  // 部分執行(框選/從某步開始)預設是真的執行——使用者拍板「圈起來執行的就執行到底,除非我有說只測試」。
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    return NextResponse.json({ error: "dryRun 必須是 true 或 false" }, { status: 400 });
  }
  // 「從這一步開始測」：只跑指定節點+它的下游，前面的步驟沿用最近一次結果或跳過(engine 的 startAtNodeId)
  if (body.startAtNodeId !== undefined && (typeof body.startAtNodeId !== "string" || !wf.nodes.some((n) => n.id === body.startAtNodeId))) {
    return NextResponse.json({ error: "起點節點不在這條流程裡(流程可能剛被改過)，請重新整理頁面再試" }, { status: 400 });
  }
  // 「只測選取的幾步」：畫布框選的節點集合(像 n8n)，只跑這幾格，其餘沿用最近結果或跳過
  if (body.onlyNodeIds !== undefined && (
    !Array.isArray(body.onlyNodeIds) || body.onlyNodeIds.length === 0 ||
    !body.onlyNodeIds.every((nid: unknown) => typeof nid === "string" && wf.nodes.some((n) => n.id === nid))
  )) {
    return NextResponse.json({ error: "選取的步驟不在這條流程裡(流程可能剛被改過)，請重新整理頁面再試" }, { status: 400 });
  }
  if (body.expectedGraphFingerprint !== undefined && (typeof body.expectedGraphFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedGraphFingerprint))) {
    return NextResponse.json({ error: "安全預覽版本識別碼格式不正確" }, { status: 400 });
  }
  if (body.previewReplayToken !== undefined && (typeof body.previewReplayToken !== "string" || !/^[a-f0-9-]{36}$/.test(body.previewReplayToken))) {
    return NextResponse.json({ error: "安全預覽輸入憑證格式不正確" }, { status: 400 });
  }
  if (body.expectedGraphFingerprint && workflowExecutionFingerprint(wf) !== body.expectedGraphFingerprint) {
    return NextResponse.json({
      error: "安全預覽後流程內容已經改過。為了避免執行未核對的新版本，請重新安全試跑一次。",
      code: "WORKFLOW_CHANGED_SINCE_PREVIEW",
    }, { status: 409 });
  }
  if (wf.importedUntrusted && body.confirmImported !== true) {
    return NextResponse.json({
      error: "這是從外部檔案匯入的流程。它可能讀取本機檔案、開啟網站或把資料送到外部；第一次執行前需要你明確確認。",
      code: "IMPORTED_WORKFLOW_CONFIRMATION_REQUIRED",
    }, { status: 409 });
  }
  if (wf.importedUntrusted) {
    const latest = getWorkflow(id);
    if (!latest) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
    saveWorkflow({ ...latest, importedUntrusted: false });
  }
  const replay = body.previewReplayToken ? claimPreviewReplay(body.previewReplayToken, id) : null;
  if (body.previewReplayToken && !replay) {
    return NextResponse.json({
      error: "這次安全預覽的附件／網址已過期或已經執行過。為了不拿另一份資料代替，請重新安全試跑。",
      code: "PREVIEW_INPUT_EXPIRED",
    }, { status: 409 });
  }
  if (replay && replay.graphFingerprint !== workflowExecutionFingerprint(wf)) {
    releasePreviewReplay(replay.token);
    return NextResponse.json({
      error: "安全預覽後流程內容已經改過。為了避免執行未核對的新版本，請重新安全試跑一次。",
      code: "WORKFLOW_CHANGED_SINCE_PREVIEW",
    }, { status: 409 });
  }
  try {
    const triggerParams = replay?.triggerParams ?? resolveParams(wf.triggerParams ?? [], body.params ?? {}, new Date());
    const runId = startWorkflowRun(id, triggerParams, {
      headed: body.headed,
      trigger: "manual",
      confirmedPreview: Boolean(replay),
      secretOverrides: replay?.secretOverrides,
      nodeConfigOverrides: replay?.nodeConfigOverrides,
      startAtNodeId: body.startAtNodeId,
      onlyNodeIds: body.onlyNodeIds,
      dryRun: body.dryRun === true,
    });
    return NextResponse.json({ runId });
  } catch (err) {
    if (replay) releasePreviewReplay(replay.token);
    if (err instanceof MissingWorkflowSettingsError) {
      return NextResponse.json(
        { error: err.message, code: "MISSING_REQUIRED_SETTINGS", missing: err.missing },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "無法啟動流程" },
      { status: err instanceof QueueCapacityError ? 429 : 400 },
    );
  }
}
