import { NextResponse } from "next/server";
import { listWorkflows, createWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel, getGlobalSettings } from "@/lib/settingsStore";
import { listRuns } from "@/lib/workflow/engine";
import { getWebhookToken } from "@/lib/webhookStore";
import { getLineToken } from "@/lib/lineHook";
import { getDb } from "@/lib/db";

export async function GET() {
  const db = getDb();
  const workflows = listWorkflows().map((wf) => {
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
      // 首頁不能對「沒有預設值的必填參數」直接送空物件執行——那會讓流程拿空字串真的做副作用。
      needsRunInput: (wf.triggerParams ?? []).some((p) => !p.derived && (p.default === undefined || p.default === "")),
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
