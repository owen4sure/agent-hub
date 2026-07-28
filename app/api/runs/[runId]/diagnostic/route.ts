import { NextResponse } from "next/server";
import { buildDiagnosticBundle } from "@/lib/workflow/diagnosticBundle";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const bundle = buildDiagnosticBundle(runId);
  if (!bundle) return NextResponse.json({ error: "找不到這次執行紀錄" }, { status: 404 });
  return new NextResponse(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${runId}.agenthub-diagnostic.json"`,
      "Cache-Control": "no-store",
    },
  });
}
