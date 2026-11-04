import { NextResponse } from "next/server";
import { getHealthCheckView, normalizeHealthCheckInterval, startHealthCheck, updateHealthCheck } from "@/lib/workflow/healthCheck";
import { isValidWorkflowId } from "@/lib/workflow/store";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  try { return NextResponse.json({ healthCheck: getHealthCheckView(id) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "無法讀取健康巡檢" }, { status: 400 }); }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  const body = await request.json().catch(() => ({})) as { enabled?: unknown; intervalMinutes?: unknown };
  if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "請選擇是否啟用巡檢" }, { status: 400 });
  if (!normalizeHealthCheckInterval(body.intervalMinutes)) return NextResponse.json({ error: "巡檢頻率選項不正確" }, { status: 400 });
  try { return NextResponse.json({ healthCheck: updateHealthCheck(id, body.enabled, body.intervalMinutes) }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "無法更新健康巡檢" }, { status: 400 }); }
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  try { return NextResponse.json({ ...startHealthCheck(id), dryRun: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "無法開始健康巡檢" }, { status: 400 }); }
}
