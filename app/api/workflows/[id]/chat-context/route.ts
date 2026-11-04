import { NextResponse } from "next/server";
import { deleteChatAttachmentsForWorkflow } from "@/lib/chatAttachments";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { deleteWorkflowChatState, getWorkflowChatState, saveWorkflowChatState } from "@/lib/workflow/chatStateStore";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  return NextResponse.json({ state: getWorkflowChatState(id) });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = await req.json().catch(() => null) as { chat?: unknown; pendingGraph?: unknown; pendingExecution?: unknown; pendingInput?: unknown } | null;
  if (!body || !Array.isArray(body.chat)) return NextResponse.json({ error: "對話狀態格式不正確" }, { status: 400 });
  try {
    // pendingInput 只是一張「要填哪些欄」的卡片定義；實際輸入值留在瀏覽器元件內，永遠不會送到這裡。
    saveWorkflowChatState(id, { chat: body.chat, pendingGraph: body.pendingGraph ?? null, pendingExecution: body.pendingExecution ?? null, pendingInput: body.pendingInput ?? null });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法儲存對話" }, { status: 400 });
  }
}

/** 清除對話時同步刪除該 workflow 的 server-side 完整附件快取。 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) {
    return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  }
  deleteWorkflowChatState(id);
  return NextResponse.json({ ok: true, removedAttachments: deleteChatAttachmentsForWorkflow(id) });
}
