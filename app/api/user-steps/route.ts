import { NextResponse } from "next/server";
import { deleteUserStep, listUserSteps, saveUserStep, type UserStepParam } from "@/lib/workflow/userSteps";

/** 「我的步驟」清單。加步驟面板與節點面板都從這裡讀。 */
export async function GET() {
  return NextResponse.json({
    steps: listUserSteps().map((step) => ({
      id: step.id,
      name: step.name,
      description: step.description,
      params: step.params.map((param) => ({ key: param.key, label: param.label })),
      createdAt: step.createdAt,
    })),
  });
}

/** 存成「我的步驟」。程式碼與參數都由呼叫端(節點面板的存檔流程)驗證過才送來，這裡再驗一次。 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    name?: unknown; description?: unknown; intent?: unknown; code?: unknown; params?: unknown;
    sourceWorkflowId?: unknown; sourceNodeId?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });
  try {
    const step = saveUserStep({
      name: String(body.name ?? ""),
      description: String(body.description ?? ""),
      intent: String(body.intent ?? ""),
      code: String(body.code ?? ""),
      params: Array.isArray(body.params) ? (body.params as UserStepParam[]) : [],
      ...(typeof body.sourceWorkflowId === "string" ? { sourceWorkflowId: body.sourceWorkflowId } : {}),
      ...(typeof body.sourceNodeId === "string" ? { sourceNodeId: body.sourceNodeId } : {}),
    });
    return NextResponse.json({ ok: true, step });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "存檔失敗" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });
  return NextResponse.json({ ok: deleteUserStep(id) });
}
