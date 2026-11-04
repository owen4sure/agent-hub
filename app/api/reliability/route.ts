import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getWorkflow, listWorkflows } from "@/lib/workflow/store";
import { listSchedules } from "@/lib/scheduler";
import { getAutomationReadiness } from "@/lib/workflow/automationReadiness";
import { summarizeRepairs } from "@/lib/workflow/repairMetrics";
import { listAudit } from "@/lib/auditLog";

/**
 * 可靠性總覽：一次回答使用者最在意的三個問題。
 *
 * 他的原話是：「1.從零開始做工作流到底能不能順利做起來 2.出了問題裡面的 AI 修不修的了
 * 3.有沒有辦法 100/100 執行排程、工作流」——而這個平台原本**一題都答不出來**，
 * 只能憑印象。這支端點的存在理由就是把那三題變成數字。
 *
 * 誠實原則：樣本太少就要說樣本太少，不要把 1/2 顯示成「50%」讓人以為那是個比率。
 */
export async function GET() {
  const db = getDb();

  // ── 問題三：排程真的跑了幾次、成功幾次 ──────────────────────────
  const scheduleRuns = db
    .prepare(`SELECT status, COUNT(*) AS n FROM runs WHERE trigger_type = 'schedule' GROUP BY status`)
    .all() as { status: string; n: number }[];
  const scheduleSuccess = scheduleRuns.find((r) => r.status === "success")?.n ?? 0;
  const scheduleFailed = scheduleRuns.find((r) => r.status === "failed")?.n ?? 0;

  const allRuns = db
    .prepare(`SELECT trigger_type, status, COUNT(*) AS n FROM runs GROUP BY trigger_type, status`)
    .all() as { trigger_type: string; status: string; n: number }[];

  // 「開著卻不會執行」的排程——這是最該立刻看到的東西(真實踩過：一條排程長期沒跑，沒人發現)
  const blocked: { scheduleId: string; workflowId: string; workflowName: string; reason: string; cron: string }[] = [];
  const nameById = new Map(listWorkflows().map((w) => [w.id, w.name]));
  for (const sched of listSchedules()) {
    if (!sched.enabled) continue;
    const wf = getWorkflow(sched.workflow_id);
    const reason = !wf
      ? "找不到這個流程"
      : wf.status !== "official"
        ? "流程還是草稿"
        : getAutomationReadiness(wf, "scheduler").ready ? null : (getAutomationReadiness(wf, "scheduler").items[0]?.title ?? "自動觸發檢查沒通過");
    if (reason) {
      blocked.push({
        scheduleId: sched.id,
        workflowId: sched.workflow_id,
        workflowName: nameById.get(sched.workflow_id) ?? sched.workflow_id,
        reason,
        cron: sched.cron,
      });
    }
  }

  // ── 問題二：AI 修不修得了 ────────────────────────────────────
  const repairs = summarizeRepairs(90);

  // ── 問題一：從零建流程的成果(現有流程用了多少現成積木 vs AI 自己寫的程式碼) ──
  let nodeTotal = 0;
  let customCode = 0;
  let workflowsWithoutCustomCode = 0;
  const workflows = listWorkflows();
  for (const meta of workflows) {
    const wf = getWorkflow(meta.id);
    if (!wf) continue;
    let own = 0;
    let cc = 0;
    const walk = (nodes: { type: string; config?: Record<string, unknown> }[]) => {
      for (const node of nodes) {
        own++;
        if (node.type === "custom-code") cc++;
        const steps = node.config?.steps;
        if (typeof steps === "string") {
          try {
            const parsed = JSON.parse(steps) as { type: string; config?: Record<string, unknown> }[];
            if (Array.isArray(parsed)) walk(parsed);
          } catch { /* 壞掉的內嵌步驟不影響統計 */ }
        }
      }
    };
    walk(wf.nodes);
    nodeTotal += own;
    customCode += cc;
    if (cc === 0) workflowsWithoutCustomCode++;
  }

  // 看門狗最近有沒有喊過(讓使用者知道「這個機制真的在運作」，不是裝飾)
  const watchdogEvents = listAudit({ limit: 20 }).filter((e) => e.action === "schedule.blocked" || e.action === "schedule.stalled");

  return NextResponse.json({
    schedule: {
      success: scheduleSuccess,
      failed: scheduleFailed,
      total: scheduleSuccess + scheduleFailed,
      enabledCount: listSchedules().filter((s) => s.enabled).length,
      blocked,
    },
    repair: repairs,
    build: {
      workflows: workflows.length,
      nodeTotal,
      customCode,
      workflowsWithoutCustomCode,
    },
    allRuns,
    watchdogEvents: watchdogEvents.map((e) => ({ at: e.at, action: e.action, detail: e.detail })),
  }, { headers: { "Cache-Control": "no-store" } });
}
