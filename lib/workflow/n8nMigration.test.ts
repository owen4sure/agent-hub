import assert from "node:assert/strict";
import test from "node:test";
import { auditN8nMigration, humanWorkflowStepType, n8nAutomationNeedsPreview, n8nGraphNeedsReview, n8nMigrationReviewState } from "./n8nMigration";
import type { Workflow } from "./types";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-test", name: "匯入", status: "draft", builtin: false, defaultModel: "minimax-m3",
    nodes: [
      { id: "n8n-1", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "n8n-2", type: "http-request", label: "查詢", config: {}, position: { x: 100, y: 0 } },
    ], edges: [{ from: "n8n-1", to: "n8n-2" }],
    n8nMigration: {
      sourceName: "匯入", sourceFingerprint: "0123456789abcdef", sourceNodeCount: 2, sourceEdgeCount: 1,
      mappedCount: 2, reviewCount: 0, unsupportedCount: 0, clearedCodeCount: 0, clearedCredentialCount: 0,
      importedAt: new Date().toISOString(), originalNodes: [
        { agentHubNodeId: "n8n-1", label: "開始", n8nType: "manualTrigger", status: "mapped", suggestedType: "trigger" },
        { agentHubNodeId: "n8n-2", label: "查詢", n8nType: "httpRequest", status: "mapped", suggestedType: "http-request" },
      ],
    },
    ...overrides,
  };
}

test("n8n 遷移核對能辨識刪除與改型，不把它誤報成等價", () => {
  const wf = workflow({ nodes: [{ id: "n8n-1", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }] });
  const result = auditN8nMigration(wf)!;
  assert.equal(result.status, "changed");
  assert.deepEqual(result.missingNodeIds, ["n8n-2"]);
});

test("有 review/unsupported 的來源即使圖尚未被改也保持待確認", () => {
  const wf = workflow({ n8nMigration: { ...workflow().n8nMigration!, reviewCount: 1, originalNodes: workflow().n8nMigration!.originalNodes.map((node, index) => index === 1 ? { ...node, status: "review" } : node) } });
  assert.equal(auditN8nMigration(wf)?.status, "needs-review");
});

test("遷移確認可持久化，圖一改就清除舊確認與逐步記錄", () => {
  const created = createWorkflow(`test-n8n-migration-persist-${Date.now()}`);
  try {
    const migration = workflow().n8nMigration!;
    saveWorkflow({ ...created, nodes: workflow().nodes, edges: workflow().edges, n8nMigration: migration, n8nMigrationAcknowledgedAt: new Date().toISOString(), n8nMigrationReviews: { "n8n-2": { decision: "acknowledged", reviewedAt: new Date().toISOString() } } });
    const loaded = getWorkflow(created.id)!;
    assert.equal(loaded.n8nMigrationAcknowledgedAt !== undefined, true);
    assert.equal(loaded.n8nMigrationReviews?.["n8n-2"]?.decision, "acknowledged");
    saveWorkflow({ ...loaded, nodes: loaded.nodes.map((node) => node.id === "n8n-2" ? { ...node, config: { changed: true } } : node) });
    const changed = getWorkflow(created.id)!;
    assert.equal(changed.n8nMigrationAcknowledgedAt, undefined);
    assert.equal(changed.n8nMigrationReviews, undefined);
  } finally {
    deleteWorkflow(created.id);
  }
});

test("正式解鎖判斷要求每個不確定步驟都有記錄", () => {
  const wf = workflow();
  assert.deepEqual(n8nMigrationReviewState(wf), {
    unresolvedNodeIds: [], reviewedNodeIds: [], missingNodeIds: [], acknowledged: true, graphReviewRequired: false, ready: true,
  });
  const reviewWf = workflow({
    n8nMigration: { ...wf.n8nMigration!, reviewCount: 1, originalNodes: wf.n8nMigration!.originalNodes.map((node, index) => index === 1 ? { ...node, status: "review" } : node) },
  });
  assert.equal(n8nMigrationReviewState(reviewWf).ready, false);
  const reviewed = workflow({ ...reviewWf, n8nMigrationReviews: { "n8n-2": { decision: "acknowledged", reviewedAt: new Date().toISOString() } }, n8nMigrationAcknowledgedAt: new Date().toISOString() });
  assert.equal(n8nMigrationReviewState(reviewed).ready, true);
});

test("匯入圖沒有連線時必須先接線，不能只靠逐步映射解鎖", () => {
  const wf = workflow({
    edges: [],
    n8nMigration: { ...workflow().n8nMigration!, sourceEdgeCount: 0 },
  });
  assert.equal(n8nGraphNeedsReview(wf), true);
  assert.equal(n8nMigrationReviewState(wf).ready, false);
  assert.equal(auditN8nMigration(wf)?.status, "needs-review");
});

test("未搬移的特殊連線必須保持待確認，不能只看 main 連線數", () => {
  const wf = workflow({ n8nMigration: { ...workflow().n8nMigration!, unmappedConnectionCount: 1 } });
  assert.equal(n8nGraphNeedsReview(wf), true);
  assert.equal(n8nMigrationReviewState(wf).ready, false);
});

test("遷移面板的步驟名稱對小白白話化，未知型別不把技術名詞當成操作前提", () => {
  assert.equal(humanWorkflowStepType("http-request"), "讀取網站／API");
  assert.equal(humanWorkflowStepType("custom-code"), "自訂計算");
  assert.equal(humanWorkflowStepType("community.unknown"), "待重新描述的步驟");
  assert.equal(humanWorkflowStepType(undefined), "已移除的步驟");
});

test("n8n 無人值守執行必須先有同一版圖的成功安全試跑", () => {
  const wf = workflow();
  assert.equal(n8nAutomationNeedsPreview(wf, false), true);
  assert.equal(n8nAutomationNeedsPreview(wf, true), false);
  assert.equal(n8nAutomationNeedsPreview({ n8nMigration: undefined }, false), false);
});
