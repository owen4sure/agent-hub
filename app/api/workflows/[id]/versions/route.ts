import { NextResponse } from "next/server";
import { listBackups, isValidWorkflowId } from "@/lib/workflow/store";

/** 列出這個 workflow 的版本備份(AI 每次改圖/改節點前都會存一份)，最新在前 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // id 不合法時 listBackups 會直接 throw(擋路徑穿越)，這裡先擋下來回 404 而不是 500
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  return NextResponse.json({ versions: listBackups(id) });
}
