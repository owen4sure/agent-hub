import { NextResponse } from "next/server";
import { autorunActive, loopCancelRequested, loopAbortControllers } from "@/lib/workflow/busyLocks";
import { cancelRun } from "@/lib/workflow/engine";
import { getDb } from "@/lib/db";

/**
 * 使用者在「幫我測到會跑」(autorun) 或「讓 AI 修」(autofix) 進行中按「⏹ 停止」。
 * 這兩個迴圈整個包在一個 HTTP request 裡跑到底，沒有 runId 可以打 /api/runs/[id]/cancel——
 * 這裡標記「要求停止」讓迴圈下一輪檢查點自己收工；同時①若當下正在跑一次完整重跑，直接 cancelRun()
 * 掉它；②若當下正在等 AI 想修復方案(沒有 runId 可 cancel 的空窗期)，abort 迴圈自己的訊號讓那段
 * AI 呼叫立刻中斷——兩種情況都不用等它自然跑完才會真的停下來。
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!autorunActive.has(id)) {
    return NextResponse.json({ error: "目前沒有正在跑的自動測試/修復" }, { status: 409 });
  }
  loopCancelRequested.add(id);
  loopAbortControllers.get(id)?.abort();
  const db = getDb();
  const current = db
    .prepare(`SELECT id FROM runs WHERE workflow_id = ? AND status IN ('running','queued') ORDER BY started_at DESC LIMIT 1`)
    .get(id) as { id: string } | undefined;
  if (current) cancelRun(current.id, "使用者在自動測試/修復進行中按了停止。");
  return NextResponse.json({ ok: true });
}
