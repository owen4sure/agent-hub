import { NextResponse } from "next/server";
import { listSchedules, createSchedule, isValidCron } from "@/lib/scheduler";
import { getWorkflow } from "@/lib/workflow/store";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ schedules: listSchedules(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { cron?: string; params?: Record<string, unknown> } | null;
  if (!body?.cron?.trim()) return NextResponse.json({ error: "缺少 cron" }, { status: 400 });
  // 入口就把不合法的 cron 擋下來，不然存進 DB 後 tick 端每分鐘誤觸發、使用者也看不到錯誤
  if (!isValidCron(body.cron)) return NextResponse.json({ error: "排程時間格式不正確" }, { status: 400 });
  // 先確認流程存在(id 不合法時 getWorkflow 會 throw，一樣當作找不到)，避免建出指向不存在流程的孤兒排程
  let wf = null;
  try {
    wf = getWorkflow(id);
  } catch {
    wf = null;
  }
  if (!wf) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const sid = createSchedule(id, body.cron, body.params ?? {});
  return NextResponse.json({ id: sid });
}
