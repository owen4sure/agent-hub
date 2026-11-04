import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getWorkflow } from "@/lib/workflow/store";
import { startWorkflowRun } from "@/lib/workflow/engine";

/** 只讀情境用：在已有 error 出口的步驟前故意失敗，確認 Plan B 真的接手；正式執行完全不接受這個控制。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { nodeId?: unknown };
  if (typeof body.nodeId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(body.nodeId)) {
    return NextResponse.json({ error: "要模擬失敗的步驟格式不正確" }, { status: 400 });
  }
  const node = workflow.nodes.find((candidate) => candidate.id === body.nodeId);
  if (!node) return NextResponse.json({ error: "找不到要模擬失敗的步驟" }, { status: 404 });
  if (!workflow.edges.some((edge) => edge.from === node.id && edge.fromPort === "error")) {
    return NextResponse.json({ error: `「${node.label}」沒有接出錯時備援路徑，不能建立這種情境` }, { status: 400 });
  }

  try {
    // 只挑「最近一次真的成功走到這一步」的輸入，避免故障情境其實從未抵達目標節點。
    const latest = getDb().prepare(
      `SELECT r.id, r.trigger_params_json
       FROM runs r JOIN node_runs nr ON nr.run_id=r.id
       WHERE r.workflow_id=? AND r.status='success' AND nr.node_id=? AND nr.status='success'
       ORDER BY r.started_at DESC LIMIT 1`,
    ).get(id, node.id) as { id: string; trigger_params_json: string | null } | undefined;
    if (!latest) return NextResponse.json({ error: `請先成功執行到「${node.label}」，平台才知道怎麼安全重播這條備援` }, { status: 400 });
    let params: Record<string, unknown> = {};
    try {
      const parsed = latest.trigger_params_json ? JSON.parse(latest.trigger_params_json) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) params = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "最近一次成功執行的輸入無法讀取，請重新執行後再建立情境" }, { status: 400 });
    }
    const runId = startWorkflowRun(id, params, {
      trigger: "manual",
      dryRun: true,
      scenarioForcedFailures: { [node.id]: "scenario" },
    });
    return NextResponse.json({ runId, scenarioName: `情境測試：${node.label}・出錯時備援`, sourceRunId: latest.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法建立故障備援安全試跑" }, { status: 400 });
  }
}
