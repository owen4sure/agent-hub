import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { getScenario, scenarioResult } from "@/lib/workflow/scenarioTests";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; scenarioId: string }> }) {
  const { id, scenarioId } = await params;
  if (!isValidWorkflowId(id) || !/^scenario-[a-f0-9-]{36}$/.test(scenarioId)) return NextResponse.json({ error: "找不到這個情境測試" }, { status: 404 });
  if (!getWorkflow(id)) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "缺少這次重播的執行紀錄" }, { status: 400 });
  const scenario = getScenario(id, scenarioId);
  const linked = getDb().prepare("SELECT id FROM runs WHERE id=? AND workflow_id=? AND scenario_id=?").get(runId, id, scenarioId) as { id: string } | undefined;
  if (!scenario || !linked) return NextResponse.json({ error: "找不到這次情境執行" }, { status: 404 });
  try {
    return NextResponse.json(scenarioResult(id, scenario, runId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法整理情境結果" }, { status: 400 });
  }
}
