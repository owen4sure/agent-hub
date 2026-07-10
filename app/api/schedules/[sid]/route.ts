import { NextResponse } from "next/server";
import { updateSchedule, deleteSchedule, isValidCron } from "@/lib/scheduler";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sid: string }> },
) {
  const { sid } = await params;
  const body = (await req.json().catch(() => null)) as { enabled?: boolean; cron?: string; params?: Record<string, unknown> } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });
  // 跟建立排程同一套驗證：不合法的 cron 在入口就擋下來，不能等 tick 端每分鐘誤觸發
  if (body.cron !== undefined && !isValidCron(body.cron)) {
    return NextResponse.json({ error: "排程時間格式不正確" }, { status: 400 });
  }
  updateSchedule(sid, body);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ sid: string }> },
) {
  const { sid } = await params;
  deleteSchedule(sid);
  return NextResponse.json({ ok: true });
}
