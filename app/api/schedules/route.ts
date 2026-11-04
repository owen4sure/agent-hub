import { NextResponse } from "next/server";
import { listSchedules, mergeScheduleOrder } from "@/lib/scheduler";
import { getWorkflow, listWorkflows } from "@/lib/workflow/store";
import { getScheduleSortOrder } from "@/lib/settingsStore";
import { getAutomationReadiness } from "@/lib/workflow/automationReadiness";

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
    // 「開著」不等於「真的會跑」：排程器每分鐘觸發前還會過一道自動觸發檢查(草稿、缺帳密、
    // 匯入未信任…)，沒過就跳過這一分鐘並只寫一行終端機警告。畫面若不講，使用者看到的是
    // 🟢 綠燈加「下次執行時間」，卻永遠等不到那次執行——這是「安靜地不執行」，
    // 比明確報錯危險得多(實測發現有一條排程開著、流程卻還是草稿，所以永遠不會跑)。
    blockedReason: s.enabled ? blockedReason(s.workflow_id) : null,
  }));
  return NextResponse.json({ schedules }, { headers: { "Cache-Control": "no-store" } });
}

function blockedReason(workflowId: string): string | null {
  const wf = getWorkflow(workflowId);
  if (!wf) return "找不到這個流程";
  if (wf.status !== "official") return "流程還是草稿——排程設定會留著，但背景不會自己執行。要它真的跑，先把流程設為正式。";
  const readiness = getAutomationReadiness(wf, "scheduler");
  if (readiness.ready) return null;
  return readiness.items[0]?.title ?? "自動觸發檢查沒通過";
}
