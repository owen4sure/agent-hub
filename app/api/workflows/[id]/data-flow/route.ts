import { NextResponse } from "next/server";
import { getWorkflow } from "@/lib/workflow/store";
import { buildWorkflowDataFlow } from "@/lib/workflow/dataFlow";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  return NextResponse.json(buildWorkflowDataFlow(workflow));
}
