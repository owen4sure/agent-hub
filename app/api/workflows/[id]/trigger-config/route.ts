import { NextResponse } from "next/server";
import { getWorkflow, saveWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { autorunActive } from "@/lib/workflow/busyLocks";

/**
 * 觸發面板直接改 trigger 節點的監聽設定(watchPath/watchPattern)。
 * 走「重新讀最新版→只改目標欄位→saveWorkflow」(存檔鐵則2)，不整包收 nodes。
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再改設定" }, { status: 409 });
  }
  const body = (await req.json().catch(() => null)) as { watchPath?: string; watchPattern?: string } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });

  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (wf.builtin) return NextResponse.json({ error: "內建範例不能改設定，請先複製" }, { status: 400 });
  const trigger = wf.nodes.find((n) => n.type === "trigger");
  if (!trigger) return NextResponse.json({ error: "這條流程沒有「開始」節點" }, { status: 400 });

  if (typeof body.watchPath === "string") trigger.config.watchPath = body.watchPath.trim();
  if (typeof body.watchPattern === "string") trigger.config.watchPattern = body.watchPattern.trim();
  saveWorkflow(wf);
  return NextResponse.json({ ok: true, watchPath: trigger.config.watchPath ?? "", watchPattern: trigger.config.watchPattern ?? "" });
}
