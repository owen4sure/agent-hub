import type { Workflow } from "./types";
import { n8nMigrationReviewState } from "./n8nMigration";
import { getDb } from "@/lib/db";
import { workflowExecutionFingerprint } from "@/lib/workflow/fingerprint";
import { acceptanceSpecOutdated } from "@/lib/workflow/acceptanceSpec";
import { lintGraph } from "@/lib/workflow/graphLint";
import { getMissingWorkflowSettings } from "@/lib/workflow/engine";
import { getLatestEvidence } from "@/lib/workflow/evidencePassport";
import { assertSafetyContract, SafetyContractViolationError } from "@/lib/workflow/safetyContract";
import { getScenarioSuiteState } from "@/lib/workflow/scenarioTests";
import { getHealthCheckGate } from "@/lib/workflow/healthCheck";

export type AutomationReadinessCode =
  | "draft"
  | "invalid-graph"
  | "missing-settings"
  | "acceptance-outdated"
  | "evidence-drift"
  | "safety-contract"
  | "n8n-review"
  | "n8n-preview"
  | "scenario-suite"
  | "health-check";

/** UI 可執行的下一步；文字 action 仍保留，讓 API/非瀏覽器客戶端也能理解。 */
export type AutomationReadinessAction =
  | "open-workflow"
  | "open-settings"
  | "open-n8n-review"
  | "start-safe-test"
  | "open-safety";

export interface AutomationReadinessItem {
  code: AutomationReadinessCode;
  title: string;
  detail: string;
  action: string;
  actionCode: AutomationReadinessAction;
}

export interface AutomationReadiness {
  ready: boolean;
  items: AutomationReadinessItem[];
}

export interface AutomationReadinessPassport {
  id: number;
  workflowId: string;
  graphFingerprint: string;
  ready: boolean;
  items: AutomationReadinessItem[];
  checkedAt: string;
  checkedBy: string;
  matchesCurrentGraph: boolean;
}

export interface AutomationReadinessInputs {
  lintErrors?: string[];
  missingSettings?: { label: string }[];
  acceptanceOutdated?: boolean;
  evidenceDriftReason?: string;
  safetyContractError?: string;
  hasSuccessfulPreview?: boolean;
  scenarioSuite?: { total: number; allPassed: boolean; failed: number; pending: number; stale: number };
  healthCheck?: { enabled: boolean; lastStatus: string | null };
}

/** 所有自動觸發共用的白話檢查結果；真正執行仍會由 engine 再做一次閘門。 */
export function buildAutomationReadiness(workflow: Workflow, input: AutomationReadinessInputs = {}): AutomationReadiness {
  const items: AutomationReadinessItem[] = [];
  if (workflow.status !== "official") {
    items.push({ code: "draft", title: "流程還是草稿", detail: "草稿可以編輯與測試，但不會在背景自動執行。", action: "先完成測試，再按「設為正式」。", actionCode: "open-workflow" });
  }
  if ((input.lintErrors?.length ?? 0) > 0) {
    items.push({ code: "invalid-graph", title: "流程圖還有結構問題", detail: input.lintErrors!.slice(0, 3).join("；"), action: "回到畫布修正紅色問題，再重新檢查。", actionCode: "open-workflow" });
  }
  if ((input.missingSettings?.length ?? 0) > 0) {
    items.push({ code: "missing-settings", title: "還缺少連接資料", detail: `尚未填寫：${input.missingSettings!.slice(0, 5).map((item) => item.label).join("、")}${input.missingSettings!.length > 5 ? "…" : ""}。`, action: "到設定頁填入；值會留在本機安全設定，不會送給 AI。", actionCode: "open-settings" });
  }
  if (input.acceptanceOutdated) {
    items.push({ code: "acceptance-outdated", title: "已保存的正確答案屬於舊版本", detail: "流程圖改過後，之前的驗收答案不能代表目前這一版。", action: "在「測到會跑」面板重新驗收這一版。", actionCode: "start-safe-test" });
  }
  if (input.evidenceDriftReason) {
    items.push({ code: "evidence-drift", title: "上次驗收證據已失效", detail: input.evidenceDriftReason, action: "重新做一次安全試跑，確認目前內容仍是你要的資料。", actionCode: "start-safe-test" });
  }
  if (input.safetyContractError) {
    items.push({ code: "safety-contract", title: "只讀保護目前會擋下這條流程", detail: input.safetyContractError, action: "檢查寫入／通知步驟；只有確定要解除保護時才到只讀保護調整。", actionCode: "open-safety" });
  }
  if (input.scenarioSuite && input.scenarioSuite.total > 0 && !input.scenarioSuite.allPassed) {
    const suite = input.scenarioSuite;
    const reasons = [
      suite.stale > 0 ? `${suite.stale} 個屬於舊版` : "",
      suite.failed > 0 ? `${suite.failed} 個未通過` : "",
      suite.pending > 0 ? `${suite.pending} 個尚未完成` : "",
    ].filter(Boolean).join("、");
    items.push({ code: "scenario-suite", title: "情境回歸還沒有全部通過", detail: `這條流程保存了 ${suite.total} 個情境，目前${reasons}。`, action: "按「全部安全重播」，確認這版流程沒有破壞已驗證的情境。", actionCode: "start-safe-test" });
  }
  if (input.healthCheck?.enabled && ["failed", "stale"].includes(input.healthCheck.lastStatus ?? "")) {
    items.push({ code: "health-check", title: "安全健康巡檢沒有通過", detail: input.healthCheck.lastStatus === "stale" ? "已保存情境屬於舊版流程，系統不會用舊答案替目前版本背書。" : "最近一次安全巡檢發現流程結果和已保存情境不同。", action: "先重新保存／修好情境，再重新啟用自動執行。", actionCode: "start-safe-test" });
  }
  if (workflow.n8nMigration) {
    const review = n8nMigrationReviewState(workflow);
    if (!review.ready) {
      items.push({ code: "n8n-review", title: "n8n 遷移還沒完成核對", detail: review.graphReviewRequired ? "有連線缺口，系統不會猜測原本的執行順序。" : `還有 ${review.missingNodeIds.length} 個不確定步驟沒有逐一確認。`, action: "打開「n8n 遷移核對」，逐步查看並確認。", actionCode: "open-n8n-review" });
    } else if (!input.hasSuccessfulPreview) {
      items.push({ code: "n8n-preview", title: "n8n 流程還沒有成功安全試跑", detail: "看過映射不等於真的跑通；背景觸發會先暫停。", action: "按「只測試，不更改資料」，完成同一版流程圖的成功安全試跑。", actionCode: "start-safe-test" });
    }
  }
  return { ready: items.length === 0, items };
}

/** 伺服器端唯一入口：UI、所有背景輪詢器與觸發 API 共用同一份現況檢查。 */
export function getAutomationReadiness(workflow: Workflow, checkedBy?: string): AutomationReadiness {
  const fingerprint = workflowExecutionFingerprint(workflow);
  const hasSuccessfulPreview = Boolean(getDb()
    .prepare(`SELECT id FROM runs WHERE workflow_id = ? AND graph_fingerprint = ? AND dry_run = 1 AND status IN ('success','waiting') LIMIT 1`)
    .get(workflow.id, fingerprint));
  const latestEvidence = getLatestEvidence(workflow.id);
  let safetyContractError: string | undefined;
  try { assertSafetyContract(workflow); } catch (error) {
    safetyContractError = error instanceof SafetyContractViolationError
      ? error.message.split("\n").slice(0, 3).join(" ")
      : error instanceof Error ? error.message : String(error);
  }
  const readiness = buildAutomationReadiness(workflow, {
    lintErrors: lintGraph(workflow.nodes, workflow.edges),
    missingSettings: getMissingWorkflowSettings(workflow),
    acceptanceOutdated: acceptanceSpecOutdated(workflow.acceptanceSpec, workflow, workflowExecutionFingerprint),
    evidenceDriftReason: latestEvidence?.drifted ? (latestEvidence.driftReason ?? "驗收來源或流程內容已改過") : undefined,
    safetyContractError,
    hasSuccessfulPreview,
    scenarioSuite: getScenarioSuiteState(workflow.id),
    healthCheck: getHealthCheckGate(workflow.id) ?? undefined,
  });
  if (checkedBy) recordAutomationReadiness(workflow, readiness, checkedBy);
  return readiness;
}

/** 寫入去重的歷史快照；同一版圖、同一結果不重複製造紀錄。 */
export function recordAutomationReadiness(workflow: Workflow, readiness: AutomationReadiness, checkedBy: string): AutomationReadinessPassport {
  const db = getDb();
  const fingerprint = workflowExecutionFingerprint(workflow);
  const readinessJson = JSON.stringify(readiness);
  const previous = db.prepare(`SELECT id, graph_fingerprint, ready, readiness_json, checked_at, checked_by FROM workflow_automation_readiness WHERE workflow_id = ? ORDER BY id DESC LIMIT 1`).get(workflow.id) as {
    id: number; graph_fingerprint: string; ready: number; readiness_json: string; checked_at: string; checked_by: string;
  } | undefined;
  if (!previous || previous.graph_fingerprint !== fingerprint || previous.readiness_json !== readinessJson) {
    db.prepare(`INSERT INTO workflow_automation_readiness (workflow_id, graph_fingerprint, ready, readiness_json, checked_at, checked_by) VALUES (?, ?, ?, ?, datetime('now'), ?)`).run(workflow.id, fingerprint, readiness.ready ? 1 : 0, readinessJson, checkedBy.slice(0, 80));
  }
  const latest = db.prepare(`SELECT id, graph_fingerprint, ready, readiness_json, checked_at, checked_by FROM workflow_automation_readiness WHERE workflow_id = ? ORDER BY id DESC LIMIT 1`).get(workflow.id) as {
    id: number; graph_fingerprint: string; ready: number; readiness_json: string; checked_at: string; checked_by: string;
  };
  let items: AutomationReadinessItem[] = [];
  try {
    const parsed = JSON.parse(latest.readiness_json) as AutomationReadiness;
    if (Array.isArray(parsed.items)) items = parsed.items;
  } catch { /* 損毀的歷史摘要不影響真正的 readiness 閘門 */ }
  return { id: latest.id, workflowId: workflow.id, graphFingerprint: latest.graph_fingerprint, ready: latest.ready === 1, items, checkedAt: latest.checked_at, checkedBy: latest.checked_by, matchesCurrentGraph: latest.graph_fingerprint === fingerprint };
}

export function latestAutomationReadinessPassport(workflow: Workflow): AutomationReadinessPassport | null {
  const row = getDb().prepare(`SELECT id, graph_fingerprint, ready, readiness_json, checked_at, checked_by FROM workflow_automation_readiness WHERE workflow_id = ? ORDER BY id DESC LIMIT 1`).get(workflow.id) as {
    id: number; graph_fingerprint: string; ready: number; readiness_json: string; checked_at: string; checked_by: string;
  } | undefined;
  if (!row) return null;
  let items: AutomationReadinessItem[] = [];
  try {
    const parsed = JSON.parse(row.readiness_json) as AutomationReadiness;
    if (Array.isArray(parsed.items)) items = parsed.items;
  } catch { /* 損毀的歷史摘要只影響顯示，不影響執行閘門 */ }
  return { id: row.id, workflowId: workflow.id, graphFingerprint: row.graph_fingerprint, ready: row.ready === 1, items, checkedAt: row.checked_at, checkedBy: row.checked_by, matchesCurrentGraph: row.graph_fingerprint === workflowExecutionFingerprint(workflow) };
}

export function automationReadinessResponse(readiness: AutomationReadiness): { error: string; code: "AUTOMATION_READINESS_REQUIRED"; readiness: AutomationReadiness } {
  const first = readiness.items[0];
  return {
    error: first ? `${first.title}：${first.detail} 下一步：${first.action}` : "這條流程目前還不能啟用自動觸發，請先完成啟用前檢查。",
    code: "AUTOMATION_READINESS_REQUIRED",
    readiness,
  };
}
