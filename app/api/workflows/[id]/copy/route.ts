import { NextResponse } from "next/server";
import { copyWorkflow, isValidWorkflowId } from "@/lib/workflow/store";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // id 不合法時 copyWorkflow 會直接 throw(擋路徑穿越)，這裡先擋下來回 404 而不是 500
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  try {
    const wf = copyWorkflow(id);
    if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
    // 對話超過 24 則使用者訊息、或附件超過 8 份時，交接摘要會截斷早期內容——不能默默截斷卻不講，
    // 使用者才知道副本可能沒有完整承接原流程早期講過的例外規則或附件，需要的話自己補一次。
    const truncatedParts = [
      wf.copyHandoff?.truncatedChat ? "較早的對話內容" : "",
      wf.copyHandoff?.truncatedAttachments ? "較早附上的檔案" : "",
    ].filter(Boolean);
    const warning = truncatedParts.length
      ? `原流程的對話較長，副本只承接了最近的部分——${truncatedParts.join("與")}沒有帶過來。如果有還適用的重要規則或檔案，複製後可以直接在對話裡再說一次。`
      : undefined;
    return NextResponse.json({ id: wf.id, ...(warning ? { warning } : {}) });
  } catch (error) {
    return NextResponse.json({ error: `複製沒有完成，也沒有留下不完整副本：${error instanceof Error ? error.message : "未知錯誤"}` }, { status: 500 });
  }
}
