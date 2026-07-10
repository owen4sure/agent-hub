import { NextResponse } from "next/server";
import { listSchedules } from "@/lib/scheduler";
import { listWorkflows } from "@/lib/workflow/store";

/** 全部 workflow 的排程一次列出(給排程操控台用)，附上 workflow 名稱。 */
export async function GET() {
  const nameById = Object.fromEntries(listWorkflows().map((w) => [w.id, w.name]));
  const schedules = listSchedules().map((s) => ({
    id: s.id,
    workflowId: s.workflow_id,
    workflowName: nameById[s.workflow_id] ?? "(已刪除的流程)",
    enabled: s.enabled,
    cron: s.cron,
    nextRunAt: s.next_run_at,
    orphan: !nameById[s.workflow_id],
  }));
  return NextResponse.json({ schedules });
}
