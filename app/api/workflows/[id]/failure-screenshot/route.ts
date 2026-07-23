import { NextResponse } from "next/server";
import fs from "node:fs";
import { getDb } from "@/lib/db";
import { isValidWorkflowId, getWorkflow } from "@/lib/workflow/store";
import { findLatestScreenshotPath } from "@/lib/workflow/repairContext";

/** 回傳「這條流程最近一次執行中，某個節點失敗當下的畫面截圖」(PNG)。
 * custom-code 開瀏覽器抓資料失敗時,引擎會自動存截圖(engine 的失敗 dump)——讓使用者親眼看到
 * 頁面到底卡在哪(「明明登入進去了卻說失敗」這種,看一眼截圖就懂),不用再猜。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id) || !getWorkflow(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const nodeId = new URL(req.url).searchParams.get("nodeId") ?? "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(nodeId)) return NextResponse.json({ error: "節點編號格式不正確" }, { status: 400 });

  // 最近一次「執行完(成功或失敗)」的 run——截圖存在該 run 的除錯目錄
  const run = getDb()
    .prepare(`SELECT id FROM runs WHERE workflow_id=? AND status NOT IN ('queued','running') ORDER BY started_at DESC, rowid DESC LIMIT 1`)
    .get(id) as { id: string } | undefined;
  if (!run) return NextResponse.json({ error: "還沒有執行紀錄" }, { status: 404 });

  const shot = findLatestScreenshotPath(run.id, nodeId);
  if (!shot || !fs.existsSync(shot)) return NextResponse.json({ error: "這一步沒有留下畫面截圖(可能不是開瀏覽器的步驟，或還沒執行到)" }, { status: 404 });

  const buf = fs.readFileSync(shot);
  return new Response(new Uint8Array(buf), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
