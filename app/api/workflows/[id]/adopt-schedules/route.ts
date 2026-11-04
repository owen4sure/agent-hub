import { NextResponse } from "next/server";
import { getWorkflow, saveWorkflow } from "@/lib/workflow/store";
import { listSchedules, updateSchedule } from "@/lib/scheduler";
import { lintGraph } from "@/lib/workflow/graphLint";
import { importedScheduleConsent } from "@/lib/workflow/importedScheduleConsent";
import { workflowExecutionFingerprint } from "@/lib/workflow/fingerprint";
import { getDb } from "@/lib/db";

/**
 * 「這條匯入的流程帶了排程，要開嗎？」使用者按下同意時走這裡。
 *
 * 一次做完三件本來要使用者自己拼起來的事：確認信任這個來源、設為正式、把排程打開。
 * 少任何一件排程都不會真的跑(草稿不觸發、未確認的匯入流程會在引擎被擋)，而使用者不會知道
 * 自己少做了哪一件——那正是這個端點要消滅的情況。
 *
 * 不放寬的部分：①匯入時被清空的自訂程式碼**不會**被還原(那是整個匯入安全模型的地基)；
 * ②結構不合法的圖仍然不能設為正式，跟手動按「設為正式」同一道 lint；
 * ③沒有 consent:true 就什麼都不做——這是使用者的授權動作，不能被別的請求順手帶過。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { consent?: unknown } | null;
  if (!body || body.consent !== true) {
    return NextResponse.json({ error: "要開啟排程必須明確帶 consent:true" }, { status: 400 });
  }

  const schedules = listSchedules(id);
  if (!importedScheduleConsent(wf, schedules)) {
    return NextResponse.json({ error: "這條流程沒有待確認的匯入排程（可能已經確認過，或本來就沒有排程）" }, { status: 400 });
  }

  const lintErrors = lintGraph(wf.nodes, wf.edges);
  if (lintErrors.length > 0) {
    return NextResponse.json({
      error: `這張流程圖還不能開始自動執行：\n${lintErrors.slice(0, 8).map((line) => `- ${line}`).join("\n")}`,
    }, { status: 400 });
  }

  // 重讀最新版再存，不要拿函式開頭的舊快照整包寫回(存 workflow 的鐵則 2)。
  const latest = getWorkflow(id);
  if (!latest) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  saveWorkflow({ ...latest, importedUntrusted: false, status: "official" });
  for (const schedule of schedules) updateSchedule(schedule.id, { enabled: true });

  // 「結構合法」不等於「真的跑得起來」。這一版流程圖若從來沒有成功執行過(含安全試跑)，
  // 排程就會是它的第一次執行，而且是在沒有人看著的時候——這句提醒一定要講，不是靜靜開下去。
  const verifiedRun = getDb()
    .prepare(`SELECT id FROM runs WHERE workflow_id = ? AND graph_fingerprint = ? AND status IN ('success','waiting') LIMIT 1`)
    .get(id, workflowExecutionFingerprint(latest));
  return NextResponse.json({
    enabled: schedules.length,
    warning: verifiedRun
      ? undefined
      : "排程已開啟。這一版流程還沒有任何一次執行成功過，所以排程那一次會是它的第一次執行(而且沒有人看著)——建議現在先自己按一次執行確認結果正確。",
  });
}
