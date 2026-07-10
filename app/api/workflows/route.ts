import { NextResponse } from "next/server";
import { listWorkflows, createWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel, getGlobalSettings } from "@/lib/settingsStore";
import { listRuns } from "@/lib/workflow/engine";
import { getWebhookToken } from "@/lib/webhookStore";
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
      nodeCount: wf.nodes.length,
      model: getWorkflowModel(wf.id, wf.defaultModel),
      lastRun: runs[0] ?? null,
      // 首頁卡片的觸發徽章：一眼看出這條流程「會自己跑」還是純手動
      triggers: {
        schedule: hasSchedule,
        watch: Boolean(String(trigger?.config?.watchPath ?? "").trim()),
        webhook: Boolean(getWebhookToken(wf.id)),
      },
    };
  });
  return NextResponse.json({ workflows });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = body.name?.trim() || "新的 Workflow";
  const wf = createWorkflow(name);
  // 確保 settings 有 seed（getGlobalSettings 觸發 init）
  getGlobalSettings();
  return NextResponse.json({ id: wf.id });
}
