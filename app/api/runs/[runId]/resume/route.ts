import { NextResponse } from "next/server";
import { resumeRun } from "@/lib/workflow/engine";

/**
 * 從失敗的那一步續跑：之前成功的節點沿用上次結果(登入/搜信/下載不用重來)，
 * 只重跑失敗那步和它的下游(需要瀏覽器狀態的上游鏈會誠實一併重跑)。
 */
export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const r = resumeRun(runId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, runId });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "續跑失敗" }, { status: 500 });
  }
}
