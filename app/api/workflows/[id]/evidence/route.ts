import { NextResponse } from "next/server";
import { getLatestEvidence } from "@/lib/workflow/evidencePassport";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const evidence = getLatestEvidence(id);
  if (!evidence) return NextResponse.json({ ok: true, evidence: null });
  return NextResponse.json({ ok: true, evidence });
}
