import { NextResponse } from "next/server";
import { getProposal, dismissPendingProposal } from "@/lib/workflow/fixProposals";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proposal = getProposal(id);
  if (!proposal) return NextResponse.json({ error: "找不到這個提案" }, { status: 404 });
  // 原子性檢查目前狀態還是不是 pending——不能無條件覆蓋，不然「已被套用」的提案會被這裡
  // 靜默改回「已忽略」，使用者看不出剛剛的套用其實生效了(踩過的競態)
  if (!dismissPendingProposal(id)) {
    return NextResponse.json({ error: "這個提案已經被處理過了(可能已套用或已忽略)，畫面請重新整理" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
