import { NextResponse } from "next/server";
import { resolvePendingEffect } from "@/lib/workflow/engine";

export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const body = await req.json().catch(() => null) as { nodeId?: unknown; decision?: unknown } | null;
  if (!body || typeof body.nodeId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(body.nodeId) || (body.decision !== "confirmed" && body.decision !== "retry")) {
    return NextResponse.json({ error: "請選擇要處理的步驟，以及「確認已完成」或「確定沒完成、允許重試」。" }, { status: 400 });
  }
  const result = resolvePendingEffect(runId, body.nodeId, body.decision);
  if (!result.ok) return NextResponse.json({ error: result.error ?? "無法處理這個外部動作" }, { status: 409 });
  return NextResponse.json({ ok: true, runId, nodeId: body.nodeId, decision: body.decision, mode: "resume-after-effect-decision" });
}
