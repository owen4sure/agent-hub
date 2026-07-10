import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { getWebhookToken, rotateWebhookToken, disableWebhook } from "@/lib/webhookStore";

/** 觸發面板用：查詢/啟用(重新產生)/停用這條流程的 webhook。 */

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const token = getWebhookToken(id);
  return NextResponse.json({ enabled: !!token, url: token ? `http://127.0.0.1:3000/api/hooks/${id}/${token}` : null });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  try {
    const token = rotateWebhookToken(id);
    return NextResponse.json({ enabled: true, url: `http://127.0.0.1:3000/api/hooks/${id}/${token}` });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  disableWebhook(id);
  return NextResponse.json({ enabled: false });
}
