import { NextResponse } from "next/server";
import { getBuildStage } from "@/lib/workflow/buildProgress";

/** 建圖進度(前端在「AI 思考中」時每秒輪詢,顯示現在做到哪一步) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(getBuildStage(id) ?? { stage: null });
}
