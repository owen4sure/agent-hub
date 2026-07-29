import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getWorkflow } from "@/lib/workflow/store";
import { getGlobalSettings, getWorkflowModel } from "@/lib/settingsStore";
import { callAIWithRetry } from "@/lib/aiRetry";
import { extractJsonObject } from "@/lib/jsonExtract";
import { callClaudeCode, isClaudeCodeAvailable, isClaudeCodeModel } from "@/lib/claudeCodeClient";
import { applyParameterization, parameterizePrompt } from "@/lib/workflow/stepParameterize";

/**
 * 「把這一步存成我的步驟」按下去時，先問模型：這段程式碼裡哪幾個寫死的值，
 * 是每次套用可能要改的？
 *
 * 為什麼要有模型參與：一段能跑的程式碼裡一定寫死了這次用的值，要重複套用就得抽出來變成欄位。
 * 但**使用者看不懂程式碼**，不能叫他自己把要參數化的地方選起來。
 * 所以模型提案、使用者用白話確認——他從頭到尾不用讀任何一行程式碼。
 *
 * 模型會亂回是常態，所以提案一律過確定性驗證(見 applyParameterization)：值必須真的在程式碼的
 * 字串裡、只能出現一次、換完語法還要合法。過不了的直接丟掉並回報原因，不會默默少做或改壞。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { nodeId?: unknown } | null;
  const nodeId = String(body?.nodeId ?? "");
  const workflow = getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "找不到這個流程" }, { status: 404 });
  const node = workflow.nodes.find((item) => item.id === nodeId);
  if (!node) return NextResponse.json({ error: "找不到這個步驟" }, { status: 404 });
  if (node.type !== "custom-code") {
    return NextResponse.json({ error: "目前只有「自訂程式碼」步驟可以存成我的步驟（其他步驟本來就能重複使用）" }, { status: 400 });
  }
  const code = String(node.config.code ?? "").trim();
  if (!code) {
    return NextResponse.json({ error: "這一步還沒有程式碼內容——請先讓它成功執行過一次，程式碼才會產生出來" }, { status: 400 });
  }

  const intent = String(node.config.intent ?? "").trim();
  const prompt = parameterizePrompt(intent, code);
  const model = getWorkflowModel(id, workflow.defaultModel);
  let raw = "";
  try {
    if (isClaudeCodeModel(model) || (await isClaudeCodeAvailable())) {
      raw = await callAIWithRetry(() => callClaudeCode({ prompt }), { label: "抽出可設定的欄位", maxAttempts: 2 });
    } else {
      const settings = getGlobalSettings();
      const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl });
      raw = await callAIWithRetry(async () => {
        const res = await client.chat.completions.create({ model, messages: [{ role: "user", content: prompt }], max_tokens: 2_000 });
        return res.choices[0]?.message?.content ?? "";
      }, { label: "抽出可設定的欄位", maxAttempts: 2 });
    }
  } catch {
    // 模型掛掉不該讓整個功能不能用：沒有欄位一樣存得起來，只是每次套用都要進去改程式碼。
    raw = "";
  }

  const parsed = raw ? extractJsonObject(raw, (obj) => Array.isArray((obj as { params?: unknown }).params)) : null;
  const result = applyParameterization(code, parsed ?? {});
  return NextResponse.json({
    name: node.label,
    intent,
    code: result.code,
    originalCode: code,
    params: result.params.map((param) => ({ ...param, default: param.literal })),
    rejected: result.rejected,
    // 一個欄位都沒抽出來不是錯誤：有些步驟本來就沒有「每次要改」的值。
    note: result.params.length === 0
      ? "這一步裡沒有找到「每次套用會不一樣」的值，所以沒有設定欄位——存起來之後每次用都是完全一樣的行為。"
      : "",
  });
}
