import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getWorkflow, saveWorkflow } from "@/lib/workflow/store";
import { getUserStep, expandUserStep } from "@/lib/workflow/userSteps";
import { validateConfigTypes } from "@/lib/workflow/graphLint";
import { getNodeDef } from "@/lib/workflow/registry";

/**
 * 把「我的步驟」加進流程。
 *
 * 展開的結果是一個**普通的自訂程式碼節點**——刻意如此(見 userSteps.ts 的說明)：
 * 使用者自己存的程式碼不會因為「是他自己存的」就得到任何特權，所有既有防線一律照舊適用。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { stepId?: unknown; position?: unknown } | null;
  const stepId = String(body?.stepId ?? "");
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const step = getUserStep(stepId);
  if (!step) return NextResponse.json({ error: "找不到這個步驟（可能已經被刪掉）" }, { status: 404 });
  if (workflow.nodes.length >= 1_000) return NextResponse.json({ error: "單一流程最多 1,000 個步驟" }, { status: 400 });

  const expanded = expandUserStep(step);
  const position = body?.position && typeof body.position === "object"
    ? body.position as { x: number; y: number } : { x: 120, y: 120 };
  const nodeId = `us${randomUUID().slice(0, 6)}`;
  const nodes = [...workflow.nodes, {
    id: nodeId,
    type: expanded.type,
    label: expanded.label,
    config: expanded.config,
    position: {
      x: Number.isFinite(position.x) ? Math.round(position.x) : 120,
      y: Number.isFinite(position.y) ? Math.round(position.y) : 120,
    },
  }];
  // 只驗這個新節點的設定型別，不驗整張圖——從面板加步驟本來就是先放一個還沒接線的節點，
  // 使用者接著自己拉線。跑整圖檢查會因為「還沒接上」直接擋下來，跟原本的「加步驟」行為不一致。
  const def = getNodeDef(expanded.type);
  const configErrors = def ? validateConfigTypes(nodeId, expanded.config, def.configSchema) : [`未知節點型別：${expanded.type}`];
  if (configErrors.length > 0) return NextResponse.json({ error: configErrors.join("\n") }, { status: 400 });

  saveWorkflow({ ...getWorkflow(id)!, nodes, edges: workflow.edges });
  return NextResponse.json({ ok: true, nodeId, label: expanded.label });
}
