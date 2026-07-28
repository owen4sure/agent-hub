import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getWorkflow } from "@/lib/workflow/store";
import { findInputVariantPlan, deriveInputVariantPlans } from "@/lib/workflow/inputVariants";
import { startWorkflowRun } from "@/lib/workflow/engine";

/**
 * 先回傳流程明確宣告的選項變體，或只啟動其中一個安全試跑。
 * 測試值由伺服器從目前流程 schema 產生，前端不能注入任意 trigger 參數。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { discover?: unknown; key?: unknown; value?: unknown };
  const latest = getDb().prepare(
    "SELECT id, trigger_params_json FROM runs WHERE workflow_id=? AND status='success' ORDER BY started_at DESC LIMIT 1",
  ).get(id) as { id: string; trigger_params_json: string | null } | undefined;
  if (!latest) return NextResponse.json({ error: "請先成功執行一次，讓系統知道其他輸入要沿用什麼" }, { status: 400 });
  let baseParams: Record<string, unknown> = {};
  try {
    const parsed = latest.trigger_params_json ? JSON.parse(latest.trigger_params_json) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) baseParams = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "最近一次成功執行的輸入無法讀取，請重新執行後再建立情境" }, { status: 400 });
  }
  const plans = deriveInputVariantPlans(workflow, baseParams);
  if (body.discover === true) {
    return NextResponse.json({
      plans: plans.map((plan) => ({
        key: plan.key,
        label: plan.label,
        value: plan.value,
        valueLabel: plan.valueLabel,
        name: plan.name,
        explanation: plan.explanation,
      })),
      sourceRunId: latest.id,
    });
  }
  if (typeof body.key !== "string" || typeof body.value !== "string") {
    return NextResponse.json({ error: "請指定要測試的選項" }, { status: 400 });
  }
  const plan = findInputVariantPlan(workflow, baseParams, body.key, body.value);
  if (!plan) return NextResponse.json({ error: "這個選項不是目前流程明確宣告、或已經是最近一次成功執行的值" }, { status: 400 });
  try {
    const runId = startWorkflowRun(id, plan.params, { trigger: "manual", dryRun: true });
    return NextResponse.json({ runId, scenarioName: plan.name, explanation: plan.explanation, sourceRunId: latest.id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法開始輸入變體安全試跑" }, { status: 400 });
  }
}
