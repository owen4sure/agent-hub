import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { runWorkflowPreview, type WorkflowPreviewInput } from "@/lib/workflow/preview";
import { beginBuild, finishBuild } from "@/lib/workflow/buildControl";
import { clearBuildStage, setBuildStage } from "@/lib/workflow/buildProgress";

/** 實際跑讀取與計算、攔住所有寫入；對話中的「測試看看」與「驗證看懂」共用。 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as WorkflowPreviewInput | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "請求內容不是有效的 JSON 物件" }, { status: 400 });
  }
  const previewBuild = beginBuild(id, req.signal);
  setBuildStage(id, "🔍 安全試跑中：只讀資料與計算，不會寫入…", previewBuild.token);
  try {
    return NextResponse.json(await runWorkflowPreview(id, body, previewBuild.signal));
  } catch (error) {
    const message = error instanceof Error ? error.message : "驗證失敗";
    return NextResponse.json({ error: message, cancelled: previewBuild.signal.aborted }, { status: previewBuild.signal.aborted ? 408 : /太大/.test(message) ? 413 : 400 });
  } finally {
    finishBuild(id, previewBuild.token);
    clearBuildStage(id, previewBuild.token);
  }
}
