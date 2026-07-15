import { NextResponse } from "next/server";
import { updateSchedule, deleteSchedule, isValidCron } from "@/lib/scheduler";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sid: string }> },
) {
  const { sid } = await params;
  const body = (await req.json().catch(() => null)) as { enabled?: boolean; cron?: string; params?: Record<string, unknown> } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled 必須是 true 或 false" }, { status: 400 });
  }
  if (body.cron !== undefined && typeof body.cron !== "string") {
    return NextResponse.json({ error: "cron 必須是文字" }, { status: 400 });
  }
  if (typeof body.cron === "string" && body.cron.length > 200) {
    return NextResponse.json({ error: "cron 內容過長" }, { status: 400 });
  }
  if (body.params !== undefined && (!body.params || typeof body.params !== "object" || Array.isArray(body.params))) {
    return NextResponse.json({ error: "params 必須是物件" }, { status: 400 });
  }
  // 跟建立排程同一套驗證：不合法的 cron 在入口就擋下來，不能等 tick 端每分鐘誤觸發
  if (body.cron !== undefined && !isValidCron(body.cron)) {
    return NextResponse.json({ error: "排程時間格式不正確" }, { status: 400 });
  }
  if (!updateSchedule(sid, body)) return NextResponse.json({ error: "找不到這個排程" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ sid: string }> },
) {
  const { sid } = await params;
  if (!deleteSchedule(sid)) return NextResponse.json({ error: "找不到這個排程" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
