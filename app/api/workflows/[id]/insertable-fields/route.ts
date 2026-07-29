import { NextResponse } from "next/server";
import { getWorkflow } from "@/lib/workflow/store";
import { buildWorkflowDataFlow } from "@/lib/workflow/dataFlow";
import { insertableFieldsFor } from "@/lib/workflow/insertableFields";
import { getDb } from "@/lib/db";

/**
 * 「這個欄位可以放什麼？」——節點面板用來長出「點一下就插入」的方塊。
 *
 * 除了欄位名稱，一定要附上**上次執行時的真實值**：使用者看不懂 periodLabel 是什麼，
 * 但他看得懂「7/22-7/28」。沒有那個值，這排方塊對他來說跟一堆亂碼沒兩樣。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const nodeId = new URL(req.url).searchParams.get("nodeId") ?? "";
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  if (!nodeId) return NextResponse.json({ error: "缺少 nodeId" }, { status: 400 });

  return NextResponse.json({ fields: insertableFieldsFor(buildWorkflowDataFlow(workflow), nodeId, lastRunValues(id)) });
}

/**
 * 最近一次執行時，各節點實際輸出了什麼。
 *
 * 三個刻意的選擇，每一個都來自「小白第一次會怎麼用」：
 * ①**不限定成功**：失敗那一次，失敗點前面幾步的輸出照樣是真的，而他最需要看範例值的時候，
 *   往往正是流程還沒跑成功的時候。
 * ②**安全排練也算**：他第一次一定是按「只測試，不更改資料」。那一次讀資料、算數字的步驟
 *   都是真的跑過的，值就是真值——排除掉的話這排提示對新手幾乎永遠是空的(實測踩到)。
 * ③合併所有節點的輸出：使用者只想知道「這個名字會變成什麼」，不在乎它是第幾步產生的。
 */
function lastRunValues(workflowId: string): Record<string, unknown> {
  const db = getDb();
  const run = db
    .prepare(`SELECT id FROM runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(workflowId) as { id: string } | undefined;
  if (!run) return {};
  const rows = db
    .prepare(`SELECT output_json FROM node_runs WHERE run_id = ? AND output_json IS NOT NULL ORDER BY started_at`)
    .all(run.id) as { output_json: string }[];
  const merged: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.output_json) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(merged, parsed);
    } catch { /* 壞掉的那一筆跳過就好，不能讓整排提示消失 */ }
  }
  return merged;
}
