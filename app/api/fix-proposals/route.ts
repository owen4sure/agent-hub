import { NextResponse } from "next/server";
import { listPendingProposals } from "@/lib/workflow/fixProposals";
import { listWorkflows } from "@/lib/workflow/store";

/** 所有還沒處理的 AI 修法提案(跨所有 workflow)，給首頁的通知橫幅用。 */
export async function GET() {
  const nameById = Object.fromEntries(listWorkflows().map((w) => [w.id, w.name]));
  const proposals = listPendingProposals().map((p) => ({
    id: p.id,
    runId: p.run_id,
    workflowId: p.workflow_id,
    workflowName: nameById[p.workflow_id] ?? p.workflow_id,
    nodeLabel: p.node_label,
    error: p.error,
    createdAt: p.created_at,
  }));
  return NextResponse.json({ proposals });
}
