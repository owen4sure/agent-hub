import { NextResponse } from "next/server";
import { applyParameterization } from "@/lib/workflow/stepParameterize";
import { saveUserStep } from "@/lib/workflow/userSteps";
import { denyIfNotLocal } from "@/lib/requireLocal";
import { recordAuditFromRequest } from "@/lib/auditLog";

/**
 * 把「剛才錄的一段操作」存成可重複套用的步驟。
 *
 * 這裡是使用者那句「要能分辨是精確的動作還是我做的是邏輯，但實際內容會調整」的落地點。
 * 兩者的界線在錄製資料裡本來就很清楚，**不需要模型去猜**：
 *   ・**結構(精確)**：點哪個按鈕、開哪個選單、填哪一格 → 永遠照錄下來的做
 *   ・**值(每次會變)**：他在某一格輸入的內容 → 變成設定欄位
 * 前端把「哪些值每次會變」的判斷交給使用者用白話勾選(預設全部視為會變)，
 * 這支端點只負責**確定性地**執行替換：值必須真的在程式碼的字串裡、只能出現一次、
 * 換完語法還要合法，過不了的丟掉並回報原因(沿用既有的 applyParameterization)。
 *
 * 換句話說：示範一次「寄信」之後，存下來的是「怎麼寄信」，不是「寄那封一模一樣的信」。
 */
export async function POST(req: Request) {
  const denied = denyIfNotLocal(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as {
    name?: unknown; intent?: unknown; code?: unknown;
    variables?: { literal?: unknown; key?: unknown; label?: unknown }[];
    sourceWorkflowId?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: "請求格式不正確" }, { status: 400 });

  const code = String(body.code ?? "");
  if (!code.trim()) return NextResponse.json({ error: "沒有錄到內容" }, { status: 400 });

  const proposals = (Array.isArray(body.variables) ? body.variables : []).map((v) => ({
    key: String(v?.key ?? ""),
    label: String(v?.label ?? ""),
    literal: String(v?.literal ?? ""),
    type: "text" as const,
  }));
  const result = applyParameterization(code, { params: proposals });

  try {
    const step = saveUserStep({
      name: String(body.name ?? "").trim() || "我錄的一段操作",
      description: "這是我親手示範一次錄下來的步驟。",
      intent: String(body.intent ?? "").trim()
        || "照著使用者親手示範的操作順序執行(選擇器來自錄製當下的真實頁面)。",
      code: result.code,
      params: result.params.map((p) => ({ ...p, default: p.literal })),
      ...(typeof body.sourceWorkflowId === "string" ? { sourceWorkflowId: body.sourceWorkflowId } : {}),
    });
    recordAuditFromRequest(req, "user-step.save", step.id, { fromRecording: true, paramCount: step.params.length });
    return NextResponse.json({
      ok: true,
      step: { id: step.id, name: step.name, params: step.params },
      // 有提案被擋下來一定要說：靜默少做會讓使用者以為某個欄位可以改，實際上是寫死的。
      rejected: result.rejected,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "存檔失敗" }, { status: 400 });
  }
}
