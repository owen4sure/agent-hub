import { NextResponse } from "next/server";
import { listWorkflows, createWorkflow } from "@/lib/workflow/store";
import { getWorkflowModel, getGlobalSettings, getWorkflowSortOrder } from "@/lib/settingsStore";
import { listRuns } from "@/lib/workflow/engine";
import { getWebhookToken } from "@/lib/webhookStore";
import { getLineToken } from "@/lib/lineHook";
import { getDb } from "@/lib/db";
import { setupNeedsFor } from "@/lib/workflow/setupNeeds";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";
import { explainWorkflow } from "@/lib/workflow/explain";

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
      // 首頁搜尋要能命中「裡面某一步做了什麼」，不只名稱/短說明——這是第二次踩到同一個真實需求：
      // 第一次只用步驟「名稱」比對(stepLabels)，使用者回饋「我上次有多加一個功能是更新簡報的
      // 一頁圖，但是我現在不知道是更新在哪個工作流」——他不記得那一步的確切命名，用「更新簡報圖片」
      // 這種泛稱去找，卻完全不會命中像「換掉開戶數頁的表格圖」這種業務化命名的步驟。改成跟流程頁
      // 「📖 說明」面板共用同一份 explainWorkflow()：每一步的白話說明句(含節點類型講的「換簡報上的
      // 圖片」這種泛稱動詞)、以及設定裡的實際值(目標分頁、找哪一頁、訊息內容)全部一起收進搜尋語料，
      // 使用者不管是記得「做了什麼」還是記得「內容是什麼」都找得到，跟「說明」面板顯示的是同一份
      // 事實、不會有兩邊對不起來的風險。只回搜尋比對用的文字，不含程式碼/帳密。
      stepSearch: explainWorkflow(wf).steps.map((s) => ({
        label: s.label,
        text: [s.label, s.text, ...s.settings.map(([, value]) => value)].join(" "),
      })),
      group: wf.group ?? "",
      nodeCount: wf.nodes.length,
      // 「這條還缺哪些一次性設定」直接算在清單裡：不然使用者要一條一條點進去才知道哪條是壞的
      // (真實回饋：17 條流程、他不知道哪條沒設定完)。只回「缺幾項」與「缺什麼」的白話，
      // 詳細設定還是在流程頁裡做。
      setupNeeds: setupNeedsFor(wf.nodes).map((need) => ({ kind: need.kind, nodeLabels: need.nodeLabels })),
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
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "請求內容必須是 JSON 物件" }, { status: 400 });
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    return NextResponse.json({ error: "流程名稱必須是文字" }, { status: 400 });
  }
  const name = (typeof body.name === "string" ? body.name.trim() : "") || "未命名流程";
  if (name.length > 120) return NextResponse.json({ error: "流程名稱最多 120 個字" }, { status: 400 });
  const wf = createWorkflow(name);
  // 確保 settings 有 seed（getGlobalSettings 觸發 init）
  getGlobalSettings();
  recordAuditFromRequest(req, "workflow.create", wf.id, { name: wf.name });
  return NextResponse.json({ id: wf.id });
}
