import { NextResponse } from "next/server";
import { decideApproval } from "@/lib/approvals";

/** 本機 UI(首頁簽核卡/紀錄面板)按核准/拒絕用；遠端簽核走 /approve/<token> 網頁或 Telegram 按鈕 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { action?: string; note?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* 空 body 走下面的驗證 */
  }
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action 要是 approve 或 reject" }, { status: 400 });
  }
  try {
    const r = await decideApproval({ id }, body.action, typeof body.note === "string" ? body.note : undefined);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "簽核失敗" }, { status: 500 });
  }
}
