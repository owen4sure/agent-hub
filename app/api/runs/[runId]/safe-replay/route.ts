import { NextResponse } from "next/server";
import { replayFailedNodeSafely } from "@/lib/workflow/engine";

export async function POST(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const result = replayFailedNodeSafely(runId);
  if (!result.ok) return NextResponse.json({ error: result.error ?? "安全重播失敗" }, { status: 409 });
  return NextResponse.json({ ok: true, sourceRunId: runId, runId: result.runId, mode: "safe-failed-node-replay" });
}
