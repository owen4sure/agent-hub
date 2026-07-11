import { NextResponse } from "next/server";
import { instantiateTemplate } from "@/lib/templates";

/** 「使用這個範本」:複製成一條全新草稿,回傳新流程 id 讓前端跳進畫布 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const wf = instantiateTemplate(id);
    if (!wf) return NextResponse.json({ error: "找不到這個範本" }, { status: 404 });
    return NextResponse.json({ id: wf.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "建立失敗" }, { status: 500 });
  }
}
