import { NextResponse } from "next/server";
import { listPendingApprovals } from "@/lib/approvals";

/** 首頁簽核卡用：所有等待決定的簽核 */
export async function GET() {
  try {
    return NextResponse.json({ approvals: listPendingApprovals() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "讀取簽核清單失敗" }, { status: 500 });
  }
}
