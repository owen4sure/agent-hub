import { NextResponse } from "next/server";
import { retryRunWithCurrentWorkflow } from "@/lib/workflow/engine";

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const result = retryRunWithCurrentWorkflow(runId);
  if (!result.ok) return NextResponse.json({ error: result.error ?? "目前版本重試失敗" }, { status: 409 });
  return NextResponse.json({ ok: true, sourceRunId: runId, runId: result.runId, mode: "current-workflow" });
}
