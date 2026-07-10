import { NextResponse } from "next/server";
import { getRun, getRunLogs } from "@/lib/workflow/engine";

export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const { searchParams } = new URL(req.url);
  // 帶 ?afterId=abc 會變 NaN → SQL `id>NaN` 恆假 → 即時日誌永遠空、畫面卡住；非有限數一律當 0
  const parsedAfterId = Number(searchParams.get("afterId") ?? "0");
  const afterId = Number.isFinite(parsedAfterId) ? parsedAfterId : 0;
  const { run, nodeRuns } = getRun(runId);
  if (!run) return NextResponse.json({ error: "找不到這次執行紀錄" }, { status: 404 });
  return NextResponse.json({ run, nodeRuns, logs: getRunLogs(runId, afterId) });
}
