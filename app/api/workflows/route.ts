import { NextResponse } from "next/server";
import { listWorkflows, createWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel, getGlobalSettings } from "@/lib/settingsStore";
import { listRuns } from "@/lib/workflow/engine";

export async function GET() {
  const workflows = listWorkflows().map((wf) => {
    const runs = listRuns(wf.id) as { status: string; started_at: string }[];
    return {
      id: wf.id,
      name: wf.name,
      status: wf.status,
      builtin: wf.builtin,
      description: wf.description,
      nodeCount: wf.nodes.length,
      model: getWorkflowModel(wf.id, wf.defaultModel),
      lastRun: runs[0] ?? null,
    };
  });
  return NextResponse.json({ workflows });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = body.name?.trim() || "新的 Workflow";
  const wf = createWorkflow(name);
  // 確保 settings 有 seed（getGlobalSettings 觸發 init）
  getGlobalSettings();
  return NextResponse.json({ id: wf.id });
}
