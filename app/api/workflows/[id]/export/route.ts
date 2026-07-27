import { NextResponse } from "next/server";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";
import { getGlobalSettings, getSharedSecrets } from "@/lib/settingsStore";
import { redactKnownSecrets } from "@/lib/exportSanitizer";
import { listSchedules } from "@/lib/scheduler";

// 匯出 workflow 定義(不含帳密)。排程(cron/啟用狀態/觸發參數)存在獨立的 schedules 表、不在
// workflow JSON 裡，以前匯出只序列化 wf 本身，排程會無聲遺失——跟 copyWorkflow() 早就修過的
// 「複製漏排程」是同一個根因，只是這裡發生在跨機器搬移(匯出/匯入)而不是同機複製。
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // id 不合法時 getWorkflow 會直接 throw(擋路徑穿越)，這裡先擋下來回 404 而不是 500
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const wf = getWorkflow(id);
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const schedules = listSchedules(id).map((s) => {
    let params: Record<string, unknown> = {};
    try { params = s.params_json ? JSON.parse(s.params_json) : {}; } catch { /* 壞資料就當沒有觸發參數，排程本身(cron/啟用)仍照常帶出 */ }
    return { enabled: Boolean(s.enabled), cron: s.cron, params };
  });
  const { apiKey } = getGlobalSettings();
  const bundle = redactKnownSecrets(
    { ...wf, builtin: false, schedules },
    { ...getSharedSecrets(), ...(apiKey ? { MODEL_API_KEY: apiKey } : {}) },
  );
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${id}.agenthub-workflow.json"`,
      "Cache-Control": "no-store",
    },
  });
}
