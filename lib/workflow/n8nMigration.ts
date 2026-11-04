import type { N8nMigrationSummary, Workflow } from "./types";

export interface N8nMigrationAudit {
  sourceName: string;
  sourceNodeCount: number;
  currentNodeCount: number;
  sourceEdgeCount: number;
  currentEdgeCount: number;
  missingNodeIds: string[];
  changedNodeIds: string[];
  unresolvedCount: number;
  status: "ready" | "needs-review" | "changed";
}

export interface N8nMigrationReviewState {
  unresolvedNodeIds: string[];
  reviewedNodeIds: string[];
  missingNodeIds: string[];
  acknowledged: boolean;
  graphReviewRequired: boolean;
  ready: boolean;
}

/**
 * 匯入流程的「看過」與「跑通」是兩件事：正式手動執行可以在確認後進行，
 * 但無人值守觸發必須先有同一版圖的成功安全試跑，避免把尚未驗證的 n8n
 * 推測直接接到排程、資料夾監聽或 webhook。
 */
export function n8nAutomationNeedsPreview(workflow: Pick<Workflow, "n8nMigration">, hasSuccessfulPreview: boolean): boolean {
  return Boolean(workflow.n8nMigration && !hasSuccessfulPreview);
}

export const N8N_AUTOMATION_PREVIEW_REQUIRED =
  "這份 n8n 流程已完成搬家核對，但還沒有同一版流程圖的成功安全試跑；為避免未驗證的推測在背景執行，請先按「只測試，不更改資料」成功一次。";

/** 沒有可辨識的連線時，絕不依節點在 JSON 裡的排列順序猜執行語意。 */
export function n8nGraphNeedsReview(workflow: Pick<Workflow, "n8nMigration" | "nodes" | "edges">): boolean {
  return Boolean(workflow.n8nMigration && (
    (workflow.nodes.length > 1 && workflow.edges.length === 0) ||
    (workflow.n8nMigration.unmappedConnectionCount ?? 0) > 0
  ));
}

/** 遷移面板給一般使用者看的積木名稱；原始型別仍只留在進階資訊。 */
export function humanWorkflowStepType(type: string | null | undefined): string {
  const labels: Record<string, string> = {
    trigger: "開始",
    "http-request": "讀取網站／API",
    "custom-code": "自訂計算",
    "if-condition": "條件判斷",
    switch: "多路分流",
    wait: "等待",
    "read-file": "讀取檔案",
    "excel-process": "整理 Excel",
    "email-read": "讀取信件",
    "google-sheet-read": "讀取 Google 試算表",
    "telegram-notify": "傳送 Telegram 通知",
    "llm-decide": "AI 判斷",
  };
  return type ? labels[type] ?? "待重新描述的步驟" : "已移除的步驟";
}

/** 正式執行入口與 UI 共用的解鎖判斷，避免一邊顯示已完成、另一邊仍能繞過閘門。 */
export function n8nMigrationReviewState(workflow: Workflow): N8nMigrationReviewState {
  const migration = workflow.n8nMigration;
  if (!migration) return { unresolvedNodeIds: [], reviewedNodeIds: [], missingNodeIds: [], acknowledged: true, graphReviewRequired: false, ready: true };
  const unresolvedNodeIds = migration.originalNodes.filter((node) => node.status !== "mapped").map((node) => node.agentHubNodeId);
  const reviewedNodeIds = unresolvedNodeIds.filter((nodeId) => Boolean(workflow.n8nMigrationReviews?.[nodeId]));
  const missingNodeIds = unresolvedNodeIds.filter((nodeId) => !workflow.n8nMigrationReviews?.[nodeId]);
  const acknowledged = unresolvedNodeIds.length === 0 || Boolean(workflow.n8nMigrationAcknowledgedAt);
  const graphReviewRequired = n8nGraphNeedsReview(workflow);
  return { unresolvedNodeIds, reviewedNodeIds, missingNodeIds, acknowledged, graphReviewRequired, ready: missingNodeIds.length === 0 && acknowledged && !graphReviewRequired };
}

/** 只用已保存的安全摘要核對目前圖，不重新接觸原始 n8n 檔案。 */
export function auditN8nMigration(workflow: Workflow): N8nMigrationAudit | null {
  const migration = workflow.n8nMigration;
  if (!migration) return null;
  const currentById = new Map(workflow.nodes.map((node) => [node.id, node]));
  const missingNodeIds = migration.originalNodes
    .filter((source) => !currentById.has(source.agentHubNodeId))
    .map((source) => source.agentHubNodeId);
  const changedNodeIds = migration.originalNodes
    .filter((source) => {
      const current = currentById.get(source.agentHubNodeId);
      return Boolean(current && (current.label !== source.label || current.type !== (source.suggestedType ?? "custom-code")));
    })
    .map((source) => source.agentHubNodeId);
  const unresolvedCount = migration.originalNodes.filter((source) => source.status !== "mapped").length;
  const status = unresolvedCount > 0 || n8nGraphNeedsReview(workflow) ? "needs-review" : missingNodeIds.length > 0 || changedNodeIds.length > 0 ? "changed" : "ready";
  return {
    sourceName: migration.sourceName,
    sourceNodeCount: migration.sourceNodeCount,
    currentNodeCount: workflow.nodes.length,
    sourceEdgeCount: migration.sourceEdgeCount,
    currentEdgeCount: workflow.edges.length,
    missingNodeIds,
    changedNodeIds,
    unresolvedCount,
    status,
  };
}

export function publicN8nMigration(migration: N8nMigrationSummary | undefined): N8nMigrationSummary | undefined {
  if (!migration) return undefined;
  return {
    ...migration,
    originalNodes: migration.originalNodes.slice(0, 1_000).map((node) => ({ ...node })),
  };
}
