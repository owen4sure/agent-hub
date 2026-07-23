import { NextResponse } from "next/server";
import { restoreBackup, isValidWorkflowId } from "@/lib/workflow/store";
import { autorunActive } from "@/lib/workflow/busyLocks";

/** 還原到某個版本備份。還原前的現況也會自動存一份備份，這個動作本身還能再復原。 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string; filename: string }> }) {
  const { id, filename } = await params;
  // id 不合法直接當找不到，回 404
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  // 自動測試/修復迴圈進行中不能整包還原——迴圈已驗證修好的節點會被舊版本蓋掉，迴圈結束後
  // 又依它自己過期的記憶再存一次，結果是一個「既不是還原的版本、也不是迴圈成果」的四不像(踩過的競態)。
  if (autorunActive.has(id)) {
    return NextResponse.json({ error: "這條流程的自動測試/修復正在進行中，等它跑完再還原版本(不然會互相蓋掉對方的修改)" }, { status: 409 });
  }
  try {
    const restored = restoreBackup(id, decodeURIComponent(filename));
    if (!restored) return NextResponse.json({ error: "找不到這個版本" }, { status: 404 });
    return NextResponse.json({ ok: true, workflow: restored.workflow, ...(restored.warning ? { warning: restored.warning } : {}) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
