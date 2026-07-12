import { NextResponse } from "next/server";
import { getWorkflow, saveWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { getLineToken, rotateLineToken, disableLineToken } from "@/lib/lineHook";
import { getSharedSecrets } from "@/lib/settingsStore";

/**
 * 觸發面板用：查詢/啟用(重新產生)/停用這條流程的 LINE 訊息觸發。
 * 啟用/停用會同步寫 trigger 節點的 config.lineWatch("on"/"")——AI 建圖、lint、說明面板
 * 都是看圖上的 config 才知道這條流程吃 LINE 訊息(token 本身在 DB，不進 workflow json)。
 */

function lineUrl(id: string, token: string): string {
  return `http://127.0.0.1:${process.env.PORT ?? 3000}/api/line-hooks/${id}/${token}`;
}

function setLineWatchFlag(id: string, on: boolean) {
  const wf = getWorkflow(id);
  if (!wf || wf.builtin) return; // 內建範例是唯讀檔，絕不能因為改旗標被複寫進 data/
  const trigger = wf.nodes.find((n) => n.type === "trigger");
  if (!trigger) return;
  trigger.config.lineWatch = on ? "on" : "";
  saveWorkflow(wf);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const token = getLineToken(id);
  return NextResponse.json({
    enabled: !!token,
    url: token ? lineUrl(id, token) : null,
    hasChannelSecret: Boolean(getSharedSecrets().lineChannelSecret),
  });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = isValidWorkflowId(id) ? getWorkflow(id) : null;
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (wf.builtin) return NextResponse.json({ error: "內建範例不能啟用觸發，請先複製" }, { status: 400 });
  if (!wf.nodes.some((n) => n.type === "trigger")) {
    return NextResponse.json({ error: "這條流程沒有「開始」節點" }, { status: 400 });
  }
  try {
    const token = rotateLineToken(id);
    setLineWatchFlag(id, true);
    return NextResponse.json({
      enabled: true,
      url: lineUrl(id, token),
      hasChannelSecret: Boolean(getSharedSecrets().lineChannelSecret),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  disableLineToken(id);
  setLineWatchFlag(id, false);
  return NextResponse.json({ enabled: false });
}
