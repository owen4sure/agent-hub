import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId, readBackupWorkflow } from "@/lib/workflow/store";
import { summarizeWorkflowChange } from "@/lib/workflow/changeSummary";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; filename: string }> }) {
  const { id, filename: encodedFilename } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const filename = decodeURIComponent(encodedFilename);
  const before = readBackupWorkflow(id, filename);
  const after = getWorkflow(id);
  if (!before || !after) return NextResponse.json({ error: "找不到這個版本" }, { status: 404 });
  return NextResponse.json({ filename, summary: summarizeWorkflowChange(before, after) });
}
