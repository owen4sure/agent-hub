import { NextResponse } from "next/server";
import { getWorkflowCoverage } from "@/lib/workflow/coverage";

/** 分支覆蓋率:圖上每個分支出口(是/否、核准/拒絕、出錯時、各分流選項)歷史上走過了沒 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const report = getWorkflowCoverage(id);
    if (!report) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "計算覆蓋率失敗" }, { status: 500 });
  }
}
