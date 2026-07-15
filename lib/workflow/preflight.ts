import type { Workflow } from "./types";
import { probeSheetScript } from "./nodes/googleSheet";

export interface ExternalPreflightTarget {
  nodeId: string;
  nodeLabel: string;
  kind: "google-sheet-v2";
  endpoint: string;
}

/**
 * 只列出能「無副作用驗證」的外部整合。通知測試會真的發訊息，信箱測試會真的登入，不能偷做；
 * Google Sheet v2 有 capabilities 動作，不寫任何儲存格，所以可以在長流程開始前先確認。
 */
export function collectExternalPreflightTargets(workflow: Workflow): ExternalPreflightTarget[] {
  const seen = new Set<string>();
  const targets: ExternalPreflightTarget[] = [];
  for (const node of workflow.nodes) {
    if (node.type !== "google-sheet-update") continue;
    const endpoint = String(node.config?.scriptUrl ?? "").trim();
    if (!endpoint || seen.has(endpoint)) continue;
    seen.add(endpoint);
    targets.push({ nodeId: node.id, nodeLabel: node.label, kind: "google-sheet-v2", endpoint });
  }
  return targets;
}

export class ExternalPreflightError extends Error {
  constructor(
    readonly nodeId: string,
    readonly nodeLabel: string,
    message: string,
  ) {
    super(message);
    this.name = "ExternalPreflightError";
  }
}

// 同一個 deployment 剛驗過就不必每次排程都多打一個請求；五分鐘後會再驗，權限／版本變動不會永久被快取。
const successfulUntil = new Map<string, number>();
const SUCCESS_TTL_MS = 5 * 60 * 1000;

export async function preflightExternalIntegrations(workflow: Workflow, signal?: AbortSignal): Promise<void> {
  for (const target of collectExternalPreflightTargets(workflow)) {
    if ((successfulUntil.get(target.endpoint) ?? 0) > Date.now()) continue;
    try {
      await probeSheetScript(target.endpoint, signal);
      successfulUntil.set(target.endpoint, Date.now() + SUCCESS_TTL_MS);
    } catch (error) {
      throw new ExternalPreflightError(
        target.nodeId,
        target.nodeLabel,
        `執行前檢查發現「${target.nodeLabel}」的 Google Sheet 寫入服務還不能使用：${error instanceof Error ? error.message : String(error)}。流程尚未登入、抓信、下載或寫入任何資料。`,
      );
    }
  }
}

export function clearExternalPreflightCacheForTests() {
  successfulUntil.clear();
}
