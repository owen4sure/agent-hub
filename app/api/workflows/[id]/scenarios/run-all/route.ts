import { NextResponse } from "next/server";
import { isValidWorkflowId } from "@/lib/workflow/store";
import { runScenarioSuite } from "@/lib/workflow/scenarioTests";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidWorkflowId(id)) return NextResponse.json({ error: "找不到這條流程" }, { status: 404 });
  try {
    return NextResponse.json({ ...runScenarioSuite(id), dryRun: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "無法開始情境回歸" }, { status: 400 });
  }
}
