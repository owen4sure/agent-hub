import { NextResponse } from "next/server";
import { listRuns } from "@/lib/workflow/engine";
import { isValidWorkflowId } from "@/lib/workflow/store";
import { conciseRuntimeError } from "@/lib/workflow/plainLanguage";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 不合法的 id 不可能有執行紀錄，直接回 404 而不是回空清單
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const runs = (listRuns(id) as Record<string, unknown>[]).map((run) => ({
    ...run,
    ...(typeof run.reason === "string" ? { reason: conciseRuntimeError(run.reason) } : {}),
    ...(typeof run.error === "string" ? { error: conciseRuntimeError(run.error) } : {}),
  }));
  return NextResponse.json({ runs });
}
