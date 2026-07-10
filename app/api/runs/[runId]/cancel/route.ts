import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/workflow/engine";

/** 使用者按「⏹ 停止執行」：還在排隊就直接撤掉，正在跑就強制中斷。 */
export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const ok = cancelRun(runId);
  return NextResponse.json({ ok });
}
