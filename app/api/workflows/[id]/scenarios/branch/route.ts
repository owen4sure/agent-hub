import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getWorkflow } from "@/lib/workflow/store";
import { deriveBranchScenarioPlan } from "@/lib/workflow/branchScenario";
import { startWorkflowRun } from "@/lib/workflow/engine";

/**
 * 為尚未走過的 if/switch 出口產生安全試跑。
 * 測試值由伺服器依流程設定推導，避免前端或模型自己注入任意執行參數；真正保存情境仍由
 * /scenarios POST 以該次成功 run 的結果做 expected snapshot。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { nodeId?: unknown; port?: unknown };
  if (typeof body.nodeId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(body.nodeId) || typeof body.port !== "string" || body.port.length > 80) {
    return NextResponse.json({ error: "分支情境的節點或出口格式不正確" }, { status: 400 });
  }

  try {
    const latest = getDb().prepare(
      "SELECT id, trigger_params_json FROM runs WHERE workflow_id=? AND status='success' ORDER BY started_at DESC LIMIT 1",
    ).get(id) as { id: string; trigger_params_json: string | null } | undefined;
    if (!latest) return NextResponse.json({ error: "請先成功執行一次，讓系統知道這個情境要沿用哪些輸入" }, { status: 400 });
    let baseParams: Record<string, unknown> = {};
    try {
      const parsed = latest.trigger_params_json ? JSON.parse(latest.trigger_params_json) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) baseParams = parsed as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "最近一次成功執行的輸入無法讀取，請重新執行後再建立情境" }, { status: 400 });
    }
    const plan = deriveBranchScenarioPlan(workflow, baseParams, body.nodeId, body.port);
    const runId = startWorkflowRun(id, plan.params, { trigger: "manual", dryRun: true });
    return NextResponse.json({ runId, scenarioName: plan.name, explanation: plan.explanation, sourceRunId: latest.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法建立分支安全試跑" }, { status: 400 });
  }
}
