import { deleteSharedSecrets, getSharedSecrets } from "./settingsStore";
import { listWorkflows, saveWorkflow } from "./workflow/store";
import type { Workflow } from "./workflow/types";

const WRITE_NODE_TYPES = new Set(["google-sheet-append", "google-sheet-update"]);

export function extractAppsScriptExecUrl(text: string): string | null {
  const match = text.match(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?[^\s<>"'，。；]*)?/i);
  return match?.[0] ?? null;
}

/** 從使用者平常打開試算表的網址抽出試算表 id(自動部署綁定用)。 */
export function extractSpreadsheetId(url: string): string | null {
  const match = String(url ?? "").match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

/** 使用者明確要同一條流程改用新 deployment 時，一次更新所有 Sheet 寫入節點。 */
export function putSheetUrlIntoAllWriteNodes(workflow: Workflow, scriptUrl: string): { workflow: Workflow; changedNodes: number; writeNodes: number } {
  let changedNodes = 0;
  let writeNodes = 0;
  const nodes = workflow.nodes.map((node) => {
    if (!WRITE_NODE_TYPES.has(node.type)) return node;
    writeNodes += 1;
    if (String(node.config?.scriptUrl ?? "").trim() === scriptUrl) return node;
    changedNodes += 1;
    return { ...node, config: { ...node.config, scriptUrl } };
  });
  return { workflow: changedNodes ? { ...workflow, nodes } : workflow, changedNodes, writeNodes };
}

/**
 * 同一條流程可能要寫「兩份不同的試算表」，各自部署一支腳本(真實案例：主管報告表+KPI 自動計算表)。
 * 腳本的 capabilities 有回報分頁清單(sheetNames，較新版模板)時，只把網址套用到「目標分頁真的在
 * 這份試算表裡」的寫入步驟——貼第二支腳本的網址不會把第一份試算表的步驟整批蓋掉(舊行為的實測缺陷)。
 * 分頁名留空(寫第一個分頁)或含 {{樣板}} 無法靜態判斷的步驟，視為可套用，維持舊行為的寬容度。
 */
export function putSheetUrlIntoMatchingWriteNodes(workflow: Workflow, scriptUrl: string, sheetNames: string[]): {
  workflow: Workflow; changedNodes: number; writeNodes: number; matchedLabels: string[]; unmatchedSheetNodes: { label: string; sheetName: string }[];
} {
  const available = new Set(sheetNames.map((name) => name.trim()));
  let changedNodes = 0;
  let writeNodes = 0;
  const matchedLabels: string[] = [];
  const unmatchedSheetNodes: { label: string; sheetName: string }[] = [];
  const nodes = workflow.nodes.map((node) => {
    if (!WRITE_NODE_TYPES.has(node.type)) return node;
    writeNodes += 1;
    const sheetName = String(node.config?.sheetName ?? "").trim();
    const staticallyKnown = sheetName.length > 0 && !sheetName.includes("{{");
    if (staticallyKnown && !available.has(sheetName)) {
      unmatchedSheetNodes.push({ label: node.label || node.id, sheetName });
      return node;
    }
    matchedLabels.push(node.label || node.id);
    if (String(node.config?.scriptUrl ?? "").trim() === scriptUrl) return node;
    changedNodes += 1;
    return { ...node, config: { ...node.config, scriptUrl } };
  });
  return { workflow: changedNodes ? { ...workflow, nodes } : workflow, changedNodes, writeNodes, matchedLabels, unmatchedSheetNodes };
}

/** 純函式，讓遷移規則可測：只補空值，絕不覆蓋節點已經自己設定的網址。 */
export function putLegacySheetUrlIntoNodes(workflow: Workflow, legacyUrl: string): { workflow: Workflow; changedNodes: number } {
  let changedNodes = 0;
  const nodes = workflow.nodes.map((node) => {
    if (!WRITE_NODE_TYPES.has(node.type) || String(node.config?.scriptUrl ?? "").trim()) return node;
    changedNodes += 1;
    return { ...node, config: { ...node.config, scriptUrl: legacyUrl } };
  });
  return { workflow: changedNodes ? { ...workflow, nodes } : workflow, changedNodes };
}

/**
 * 舊版把 Apps Script URL 當成全域帳密放在設定頁。新版把它搬回每個寫入節點，避免使用者
 * 把 docs.google.com 的讀取網址與 script.google.com 的寫入網址填反。遷移完成後才刪舊值；
 * 中途任何一條流程存檔失敗都會保留舊值，下一次啟動可安全重試。
 */
export function migrateLegacySheetWriteUrl(): { workflows: number; nodes: number; removedLegacySecret: boolean } {
  const legacyUrl = getSharedSecrets().sheetAppendUrl?.trim();
  if (!legacyUrl) return { workflows: 0, nodes: 0, removedLegacySecret: false };

  let workflows = 0;
  let nodes = 0;
  for (const current of listWorkflows().filter((workflow) => !workflow.builtin)) {
    const migrated = putLegacySheetUrlIntoNodes(current, legacyUrl);
    if (!migrated.changedNodes) continue;
    saveWorkflow(migrated.workflow);
    workflows += 1;
    nodes += migrated.changedNodes;
  }

  const writeNodes = listWorkflows()
    .filter((workflow) => !workflow.builtin)
    .flatMap((workflow) => workflow.nodes)
    .filter((node) => WRITE_NODE_TYPES.has(node.type));
  const complete = writeNodes.length > 0 && writeNodes.every((node) => String(node.config?.scriptUrl ?? "").trim().length > 0);
  if (complete) deleteSharedSecrets(["sheetAppendUrl"]);
  return { workflows, nodes, removedLegacySecret: complete };
}
