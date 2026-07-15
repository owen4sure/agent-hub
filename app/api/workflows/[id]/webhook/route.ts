import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { getWebhookToken, rotateWebhookToken, disableWebhook } from "@/lib/webhookStore";
import { autorunActive } from "@/lib/workflow/busyLocks";

/** 觸發面板用：查詢/啟用(重新產生)/停用這條流程的 webhook。 */

const webhookUrl = (id: string, token: string) => `http://127.0.0.1:${process.env.PORT ?? 3000}/api/hooks/${id}/${token}`;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const token = getWebhookToken(id);
  return NextResponse.json({ enabled: !!token, url: token ? webhookUrl(id, token) : null });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = isValidWorkflowId(id) ? getWorkflow(id) : null;
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (wf.builtin) return NextResponse.json({ error: "內建範例不能啟用觸發，請先複製" }, { status: 400 });
  if (autorunActive.has(id)) return NextResponse.json({ error: "自動測試／修復進行中，等它完成再啟用 Webhook" }, { status: 409 });
  try {
    const token = rotateWebhookToken(id);
    return NextResponse.json({ enabled: true, url: webhookUrl(id, token) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = isValidWorkflowId(id) ? getWorkflow(id) : null;
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (wf.builtin) return NextResponse.json({ error: "內建範例沒有可修改的觸發設定" }, { status: 400 });
  if (autorunActive.has(id)) return NextResponse.json({ error: "自動測試／修復進行中，等它完成再停用 Webhook" }, { status: 409 });
  disableWebhook(id);
  return NextResponse.json({ enabled: false });
}
