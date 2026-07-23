import type { ParamField, WorkflowNode } from "./types";

/**
 * 找出「不是流程壞掉，而是這次執行根本沒有填必填輸入」的明確情況。
 * 只有錯誤本身指出檔案路徑／輸入為空，且失敗節點確實引用該執行欄位時才回報；
 * 不能因為某個未使用的表單欄位留空就擋掉整圖修復。
 */
export function missingTriggerInputsForFailure(
  failedNode: WorkflowNode | undefined,
  triggerParams: ParamField[] | undefined,
  actualInput: Record<string, unknown> | null,
  error: string,
): ParamField[] {
  if (!failedNode || !actualInput || !/(?:路徑是空|未選擇(?:檔案|文件)|缺少(?:上傳)?檔案)/.test(error)) return [];
  const configText = JSON.stringify(failedNode.config ?? {});
  return (triggerParams ?? []).filter((field) => {
    if (field.derived || !configText.includes(`{{${field.key}}}`)) return false;
    const value = actualInput[field.key];
    return value === undefined || value === null || String(value).trim() === "";
  });
}
