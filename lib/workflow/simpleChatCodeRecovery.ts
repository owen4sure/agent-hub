import { compileDailyChannelMetrics } from "./structuredExcelCompiler";
import { applyNodeConfigEdits } from "./graphRepair";
import { getWorkflow } from "./store";

export interface SimpleChatCodeRecoveryResult {
  message: string;
  changes: { label: string; detail: string }[];
}

function isPlaceholderCode(value: unknown): boolean {
  const code = String(value ?? "").trim();
  return !code || /^return\s*\{\s*\.\.\.\s*ctx\.input\s*,?\s*\}\s*;?$/.test(code);
}

function quotedText(text: string): string | null {
  const match = text.match(/[「『"']([^」』"']{1,180})[」』"']/);
  return match?.[1]?.trim() || null;
}

/**
 * 對話入口的確定性程式修復。
 *
 * 「讓 AI 修」已經會在執行失敗時處理空 custom-code；但使用者更自然的行為是直接在對話說
 * 「這個計算步驟壞了，幫我修」。若仍把這種明確規格送去通用模型重寫數千字程式，既慢又不穩。
 * 只有編譯器已能完整理解、且使用者明確要求修復的空步驟才走這條；其餘情形一律回到整圖 AI，
 * 不以關鍵字猜商業邏輯。
 */
export function tryApplySimpleChatCodeRecovery(workflowId: string, text: string): SimpleChatCodeRecoveryResult | null {
  const wf = getWorkflow(workflowId);
  if (!wf) return null;
  const compact = text.replace(/\s+/g, " ").trim();
  const asksRecovery = /(?:修好|修復|修正|幫我修|重建|重產|補回|恢復|重新(?:產生|建立)|程式碼(?:被)?(?:清空|空了|壞了)|code(?:被)?(?:清空|空了|壞了))/i.test(compact);
  if (!asksRecovery) return null;

  const named = quotedText(compact);
  const candidates = wf.nodes
    .filter((node) => node.type === "custom-code" && isPlaceholderCode(node.config.code))
    .map((node) => ({ node, code: compileDailyChannelMetrics(String(node.config.intent ?? "")) }))
    .filter((item): item is { node: typeof wf.nodes[number]; code: string } => Boolean(item.code));
  const selected = named
    ? candidates.filter((item) => item.node.label === named || item.node.id === named)
    : candidates;
  if (selected.length !== 1) return null;

  const { node, code } = selected[0];
  const applied = applyNodeConfigEdits(workflowId, [{ nodeId: node.id, config: { code } }]);
  if (applied.edits.length !== 1 || applied.skipped.length > 0) return null;
  return {
    message: `✅ 已依「${node.label}」已確認的 Excel 分頁、通路欄位與計算規則，直接重建這一步的執行邏輯；尚未執行流程，也沒有讀寫外部資料。現在可按「只測這一步」或「測到會跑」做安全驗證。`,
    changes: [{ label: node.label, detail: "已重建背後計算邏輯，尚未執行" }],
  };
}
