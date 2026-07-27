import { NextResponse } from "next/server";
import { listSchedules, mergeScheduleOrder } from "@/lib/scheduler";
import { listWorkflows } from "@/lib/workflow/store";
import { getScheduleSortOrder } from "@/lib/settingsStore";

/** 全部 workflow 的排程一次列出(給排程操控台用)，附上 workflow 名稱；排序規則見 mergeScheduleOrder。 */
export async function GET() {
  const nameById = Object.fromEntries(listWorkflows().map((w) => [w.id, w.name]));
  const sorted = mergeScheduleOrder(listSchedules(), getScheduleSortOrder());
  const schedules = sorted.map((s) => ({
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
