import { NextResponse } from "next/server";
import { isValidWorkflowId } from "@/lib/workflow/store";
import { createScenarioFromRun, getScenarioSuiteState, listScenarios } from "@/lib/workflow/scenarioTests";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  return NextResponse.json({ scenarios: listScenarios(id), suite: getScenarioSuiteState(id) });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.runId !== "string") {
    return NextResponse.json({ error: "請從一次成功的執行保存情境測試" }, { status: 400 });
  }
  try {
    return NextResponse.json({ scenario: createScenarioFromRun(id, body.runId, body.name, body.approvalDecisions, body.forcedFailures) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法保存情境測試" }, { status: 400 });
  }
}
