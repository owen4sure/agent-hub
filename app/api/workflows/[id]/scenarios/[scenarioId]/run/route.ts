import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { startWorkflowRun } from "@/lib/workflow/engine";
import { workflowExecutionFingerprint } from "@/lib/workflow/fingerprint";
import { getScenario, scenarioApprovalDecisions, scenarioForcedFailures, scenarioRunParams } from "@/lib/workflow/scenarioTests";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; scenarioId: string }> }) {
  const { id, scenarioId } = await params;
  if (!isValidWorkflowId(id) || !/^scenario-[a-f0-9-]{36}$/.test(scenarioId)) return NextResponse.json({ error: "找不到這個情境測試" }, { status: 404 });
  const workflow = getWorkflow(id);
  const scenario = getScenario(id, scenarioId);
  if (!workflow || !scenario) return NextResponse.json({ error: "找不到這個情境測試" }, { status: 404 });
  if (workflowExecutionFingerprint(workflow) !== scenario.graph_fingerprint) {
    return NextResponse.json({ error: "流程已經改過，這個情境屬於舊版本。請先用目前版本重新保存情境。", code: "SCENARIO_OUTDATED" }, { status: 409 });
  }
  try {
    const runId = startWorkflowRun(id, scenarioRunParams(scenario), { trigger: "manual", dryRun: true, scenarioApprovalDecisions: scenarioApprovalDecisions(scenario), scenarioForcedFailures: Object.fromEntries(scenarioForcedFailures(scenario).map((nodeId) => [nodeId, "scenario"])) });
    getDb().prepare("UPDATE runs SET scenario_id=? WHERE id=? AND workflow_id=?").run(scenarioId, runId, id);
    return NextResponse.json({ runId, scenarioId, dryRun: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法重播情境測試" }, { status: 400 });
  }
}
