import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listWorkflows } from "@/lib/workflow/store";
import { listPendingApprovals } from "@/lib/approvals";

export async function GET() {
  const db = getDb();
  const workflows = listWorkflows();

  const running = db
    .prepare(
      `SELECT id, workflow_id, started_at FROM runs WHERE status IN ('running','queued') ORDER BY started_at DESC`,
    )
    .all() as { id: string; workflow_id: string; started_at: string }[];

  const todayCounts = db
    .prepare(
      // 「今日」要用台北時區(+8)的日界線——date('now') 是 UTC，台北 00:00–08:00 之間會統計到昨天
      `SELECT status, COUNT(*) as count FROM runs WHERE date(started_at, '+8 hours') = date('now', '+8 hours') GROUP BY status`,
    )
    .all() as { status: string; count: number }[];

  // 最近 14 天內排程觸發卻失敗的執行：桌面通知使用者可能沒看到/沒開機，這是開網頁時一定看得到的第二道保險
  const recentScheduleFailures = db
    .prepare(
      `SELECT id, workflow_id, reason, started_at FROM runs
       WHERE trigger_type='schedule' AND status='failed' AND started_at >= datetime('now','-14 days')
       ORDER BY started_at DESC LIMIT 10`,
    )
    .all() as { id: string; workflow_id: string; reason: string | null; started_at: string }[];

  const nameById = Object.fromEntries(workflows.map((w) => [w.id, w.name]));

  return NextResponse.json({
    officialCount: workflows.filter((w) => w.status === "official").length,
    draftCount: workflows.filter((w) => w.status === "draft").length,
    todayCounts: Object.fromEntries(todayCounts.map((r) => [r.status, r.count])),
    running: running.map((r) => ({ ...r, name: nameById[r.workflow_id] ?? r.workflow_id })),
    recentScheduleFailures: recentScheduleFailures.map((r) => ({ ...r, name: nameById[r.workflow_id] ?? r.workflow_id })),
    // 等待簽核的請求：首頁要有醒目的簽核卡(桌面通知/Telegram 可能被錯過，開網頁一定看得到)
    pendingApprovals: listPendingApprovals(),
  });
}
