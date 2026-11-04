import { NextResponse } from "next/server";
import { buildRunReceipt } from "@/lib/workflow/runReceipt";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const receipt = buildRunReceipt(runId);
  if (!receipt) return NextResponse.json({ error: "找不到這次執行" }, { status: 404 });
  return NextResponse.json(receipt);
}
