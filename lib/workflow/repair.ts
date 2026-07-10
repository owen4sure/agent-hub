import type OpenAI from "openai";
import { editNode } from "./nodeEditor";

/**
 * 讓 AI 依「上次失敗的錯誤 + 實際頁面 HTML/截圖 + 以前的成功經驗」修一個失敗的節點。
 * autofix(單一節點按鈕) 和 autorun(草稿全自動測試迴圈) 共用同一段修復邏輯與 prompt，
 * 避免兩邊各寫一份、日後漂移。回傳 editNode 的結果({config, before, nodeType})。
 */
export function aiRepairNode(
  client: OpenAI,
  model: string,
  workflowId: string,
  nodeId: string,
  lastError: string,
  repairRunId: string | undefined,
  apply = true,
) {
  return editNode(
    client,
    model,
    workflowId,
    nodeId,
    `這個節點執行失敗了，錯誤是：「${lastError}」。請依實際頁面找出真正原因並修正這一步的設定。`,
    { repairRunId, errorForLearning: lastError, apply },
  );
}
