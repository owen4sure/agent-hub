import { NextResponse } from "next/server";
import { analyzeN8nWorkflow } from "@/lib/workflow/n8nAnalyzer";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export async function POST(req: Request) {
  const raw = await req.text().catch(() => "");
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "n8n workflow 檔案太大(上限 2MB)" }, { status: 413 });
  }
  const input = (() => {
    try { return JSON.parse(raw); } catch { return null; }
  })();
  if (!input) return NextResponse.json({ error: "請貼上有效的 n8n workflow JSON" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, analysis: analyzeN8nWorkflow(input) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法分析 n8n workflow" }, { status: 400 });
  }
}
