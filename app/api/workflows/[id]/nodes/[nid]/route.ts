import { NextResponse } from "next/server";
import { getClient } from "@/lib/modelClient";
import { getWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel } from "@/lib/settingsStore";
import { editNode } from "@/lib/workflow/nodeEditor";
import { getDb } from "@/lib/db";
import { autorunActive } from "@/lib/workflow/busyLocks";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; nid: string }> },
) {
  const { id, nid } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { instruction?: string; repair?: boolean } | null;
  if (!body?.instruction?.trim()) return NextResponse.json({ error: "請描述要修改的內容" }, { status: 400 });

  // 自動測試/修復迴圈進行中不能同時手動微調同一條流程的節點——迴圈事後的止損還原(restoreUnverified)
  // 會依它自己記錄的「哪些節點已驗證修好」把節點 config 蓋回迴圈開始前的快照，這裡剛存的手動修改
  // 會被無聲蓋掉且沒有任何提示(踩過的競態)。
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再手動修改(不然會被還原動作蓋掉)" }, { status: 409 });
  }

  // repair 模式：找這個節點最近一次失敗的 run 以取截圖
  let repairRunId: string | undefined;
  if (body.repair) {
    const row = getDb()
      .prepare(
        `SELECT run_id FROM node_runs WHERE node_id = ? AND status = 'failed' AND run_id IN (SELECT id FROM runs WHERE workflow_id = ?) ORDER BY id DESC LIMIT 1`,
      )
      .get(nid, id) as { run_id: string } | undefined;
    repairRunId = row?.run_id;
  }

  try {
    const client = getClient();
    const model = getWorkflowModel(id, wf.defaultModel);
    const result = await editNode(client, model, id, nid, body.instruction, { repairRunId });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
