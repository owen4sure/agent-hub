import type { Workflow, WorkflowNode } from "./types";

export type BranchScenarioPort = "true" | "false" | string;

export interface BranchScenarioPlan {
  nodeId: string;
  nodeType: "if-condition" | "switch";
  port: BranchScenarioPort;
  params: Record<string, unknown>;
  name: string;
  explanation: string;
}

function exactParamRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^\{\{([A-Za-z_][A-Za-z0-9_.-]*)\}\}$/);
  return match?.[1] ?? null;
}

function paramKeys(workflow: Workflow): Set<string> {
  return new Set((workflow.triggerParams ?? []).filter((field) => !field.derived).map((field) => field.key));
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(String(value).replace(/[,$\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringForComparison(op: string, right: string, wantTrue: boolean): string {
  const numericRight = numberValue(right);
  if (numericRight !== null) {
    if (op === "==") return wantTrue ? String(numericRight) : String(numericRight + 1);
    if (op === "!=") return wantTrue ? String(numericRight + 1) : String(numericRight);
    if (op === ">") return String(wantTrue ? numericRight + 1 : numericRight - 1);
    if (op === ">=") return String(wantTrue ? numericRight : numericRight - 1);
    if (op === "<") return String(wantTrue ? numericRight - 1 : numericRight + 1);
    if (op === "<=") return String(wantTrue ? numericRight : numericRight + 1);
  }
  if (op === "contains") return wantTrue ? right || "命中" : right ? `__agenthub_without_${right}__` : "未命中";
  if (op === "not-empty") return wantTrue ? "agenthub-test-value" : "";
  if (op === "==") return wantTrue ? right : "__agenthub_not_equal__";
  if (op === "!=") return wantTrue ? "__agenthub_not_equal__" : right;
  // 非數字大小比較仍遵守 JavaScript 的字典序；固定用比 right 前／後的值，避免模型或隨機資料。
  return wantTrue ? `${right}~` : `~${right}`;
}

function switchFallbackValue(cases: string[]): string {
  const candidates = ["__agenthub_no_matching_case__", "__agenthub_other_branch__", "agenthub-unmatched-value"];
  return candidates.find((candidate) => !cases.some((item) => candidate.toLocaleLowerCase().includes(item.toLocaleLowerCase()))) ?? "__agenthub_unmatched__";
}

function nodeById(workflow: Workflow, nodeId: string): WorkflowNode {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error("找不到這個分支節點，流程可能剛被修改");
  return node;
}

/**
 * 只為「直接來自手動觸發參數」的分支推導測試輸入。
 * 上游檔案、信件、AI 或 custom-code 產生的值不能靠猜，會回傳可理解的錯誤讓使用者改用實際輸入。
 */
export function deriveBranchScenarioPlan(
  workflow: Workflow,
  baseParams: Record<string, unknown>,
  nodeId: string,
  port: string,
): BranchScenarioPlan {
  const node = nodeById(workflow, nodeId);
  const params = { ...baseParams };
  const keys = paramKeys(workflow);

  if (node.type === "if-condition") {
    if (port !== "true" && port !== "false") throw new Error("條件判斷只有「是」和「否」兩個出口");
    const key = exactParamRef(node.config.left);
    if (!key || !keys.has(key)) {
      throw new Error("這個條件的左值不是直接的手動輸入，平台不能安全猜測上游檔案或 AI 的結果；請先用實際資料跑一次，再保存成情境");
    }
    const right = typeof node.config.right === "string" ? node.config.right : String(node.config.right ?? "");
    const op = typeof node.config.op === "string" ? node.config.op : "==";
    const wantTrue = port === "true";
    params[key] = stringForComparison(op, right, wantTrue);
    return {
      nodeId,
      nodeType: "if-condition",
      port,
      params,
      name: `情境測試：${node.label}・${wantTrue ? "是" : "否"}`,
      explanation: `已把「${key}」改成能穩定走「${wantTrue ? "是" : "否"}」的測試值；其他輸入沿用最近一次成功執行。`,
    };
  }

  if (node.type === "switch") {
    const key = exactParamRef(node.config.value);
    if (!key || !keys.has(key)) {
      throw new Error("這個分流值不是直接的手動輸入，平台不能安全猜測上游檔案或 AI 的結果；請先用實際資料跑一次，再保存成情境");
    }
    const cases = String(node.config.cases ?? "").split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
    if (cases.length === 0) throw new Error("這個多路分流還沒有設定選項，無法建立分支情境");
    if (port !== "其他" && !cases.includes(port)) throw new Error(`找不到多路分流出口「${port}」`);
    params[key] = port === "其他" ? switchFallbackValue(cases) : port;
    return {
      nodeId,
      nodeType: "switch",
      port,
      params,
      name: `情境測試：${node.label}・${port}`,
      explanation: `已把「${key}」改成「${port === "其他" ? "不符合任何選項" : port}」；其他輸入沿用最近一次成功執行。`,
    };
  }

  throw new Error("目前只有條件判斷與多路分流支援自動產生分支情境");
}
