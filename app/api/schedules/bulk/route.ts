import { NextResponse } from "next/server";
import { getPausedBatch, pauseAllSchedules, resumePausedBatch } from "@/lib/scheduler";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/** 上次「全部暫停」關掉了哪幾筆——畫面用它決定要不要顯示「恢復」按鈕。 */
export async function GET() {
  return NextResponse.json({ pausedBatch: getPausedBatch() }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * 一次暫停全部排程／恢復上次暫停的那幾筆。
 *
 * 「恢復」刻意**只**打開上次被這個按鈕關掉的那幾筆，不是打開全部——見 scheduler.ts 的說明：
 * 把使用者幾週前刻意關掉的排程一起打開，等於在他沒察覺的情況下讓一條流程回到背景執行，
 * 而背景執行是會真的寄信、寫試算表、動外部系統的。
 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = String(body?.action ?? "");

  if (action === "pause-all") {
    const { paused } = pauseAllSchedules();
    recordAuditFromRequest(req, "schedule.pause-all", null, { count: paused.length });
    return NextResponse.json({ ok: true, paused: paused.length });
  }
  if (action === "resume") {
    const { resumed, missing } = resumePausedBatch();
    recordAuditFromRequest(req, "schedule.resume-batch", null, { count: resumed.length, missing });
    return NextResponse.json({ ok: true, resumed: resumed.length, missing });
  }
  return NextResponse.json({ error: "action 要是 pause-all 或 resume" }, { status: 400 });
}
