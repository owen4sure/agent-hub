import { NextResponse } from "next/server";
import { listWorkflows, createWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel, getGlobalSettings, getWorkflowSortOrder } from "@/lib/settingsStore";
import { listRuns } from "@/lib/workflow/engine";
import { getWebhookToken } from "@/lib/webhookStore";
import { getLineToken } from "@/lib/lineHook";
import { getDb } from "@/lib/db";

export async function GET() {
  const db = getDb();
  // 使用者拖曳過的手動順序優先；沒排過的(新流程)接在後面、維持檔案系統原本的相對順序。
  // 排序放伺服器端做，首頁/排程頁等所有清單消費者看到的順序才一致。
  const order = getWorkflowSortOrder();
  const orderIndex = new Map(order.map((wfId, i) => [wfId, i]));
  const sorted = listWorkflows()
    .map((wf, i) => ({ wf, key: orderIndex.get(wf.id) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.wf);
  const workflows = sorted.map((wf) => {
    const runs = listRuns(wf.id) as { status: string; started_at: string }[];
    const trigger = wf.nodes.find((n) => n.type === "trigger");
    const hasSchedule = Boolean(
      db.prepare(`SELECT 1 FROM schedules WHERE workflow_id = ? AND enabled = 1 LIMIT 1`).get(wf.id),
    );
    return {
      id: wf.id,
      name: wf.name,
      status: wf.status,
      builtin: wf.builtin,
      description: wf.description,
      group: wf.group ?? "",
      nodeCount: wf.nodes.length,
      // 首頁的「執行」必須跟流程頁內的「執行」問一樣的問題：只要有執行前參數(選期間等，就算有預設值
      // 也要讓使用者確認，不能默默拿預設值跑——使用者要選區間卻被跳過，踩過)、需要測試檔、或訊息觸發
      // 型要填測試值，就導進流程頁開執行表單。判斷條件要跟 workflows/[id]/page.tsx 的 onClickRun 一致。
      needsRunInput:
        (wf.triggerParams ?? []).some((p) => !p.derived) ||
        (wf.nodes.some(
          (n) =>
            (n.type === "trigger" && String(n.config?.watchPath ?? "").trim().length > 0) ||
            JSON.stringify(n.config ?? {}).includes("{{filePath}}"),
        ) && !(wf.triggerParams ?? []).some((f) => f.key === "filePath")) ||
        ["mailWatch", "telegramWatch", "lineWatch"].some((k) => trigger?.config?.[k] === "on"),
      model: getWorkflowModel(wf.id, wf.defaultModel),
      lastRun: runs[0] ?? null,
      // 首頁卡片的觸發徽章：一眼看出這條流程「會自己跑」還是純手動
      triggers: {
        schedule: hasSchedule,
        watch: Boolean(String(trigger?.config?.watchPath ?? "").trim()),
        webhook: Boolean(getWebhookToken(wf.id)),
        email: trigger?.config?.mailWatch === "on",
        telegram: trigger?.config?.telegramWatch === "on",
        line: Boolean(getLineToken(wf.id)),
      },
    };
  });
  return NextResponse.json({ workflows });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "請求內容必須是 JSON 物件" }, { status: 400 });
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return NextResponse.json({ error: "流程名稱必須是文字" }, { status: 400 });
  }
  const name = (typeof body.name === "string" ? body.name.trim() : "") || "新的 Workflow";
  if (name.length > 120) return NextResponse.json({ error: "流程名稱最多 120 個字" }, { status: 400 });
  const wf = createWorkflow(name);
  // 確保 settings 有 seed（getGlobalSettings 觸發 init）
  getGlobalSettings();
  return NextResponse.json({ id: wf.id });
}
