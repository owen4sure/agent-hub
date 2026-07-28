import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { workflowExecutionFingerprint } from "@/lib/workflow/fingerprint";
import { buildExecutionPlan } from "@/lib/workflow/executionPlan";
import { getMissingWorkflowSettings } from "@/lib/workflow/engine";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const graphFingerprint = workflowExecutionFingerprint(workflow);
  return NextResponse.json({
    plan: buildExecutionPlan(workflow, graphFingerprint),
    missingSettings: getMissingWorkflowSettings(workflow).map((item) => ({ key: item.key, label: item.label, type: item.type })),
  });
}
