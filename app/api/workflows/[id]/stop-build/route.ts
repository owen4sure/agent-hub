import { NextResponse } from "next/server";
import { cancelBuild } from "@/lib/workflow/buildControl";
import { clearBuildStage } from "@/lib/workflow/buildProgress";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) {
    return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  }
  const stopped = cancelBuild(id);
  clearBuildStage(id);
  return NextResponse.json({ ok: true, stopped });
}

