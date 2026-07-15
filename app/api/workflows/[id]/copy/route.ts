import { NextResponse } from "next/server";
import { copyWorkflow, isValidWorkflowId } from "@/lib/workflow/store";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // id 不合法時 copyWorkflow 會直接 throw(擋路徑穿越)，這裡先擋下來回 404 而不是 500
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  try {
    const wf = copyWorkflow(id);
    if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
    return NextResponse.json({ id: wf.id });
  } catch (error) {
    return NextResponse.json({ error: `複製沒有完成，也沒有留下不完整副本：${error instanceof Error ? error.message : "未知錯誤"}` }, { status: 500 });
  }
}
