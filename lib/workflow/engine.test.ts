import test from "node:test";
import assert from "node:assert/strict";
import { getMissingWorkflowSettings } from "./engine";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";

test("getMissingWorkflowSettings：缺帳密欄位要帶節點宣告的 type，前端安全輸入卡才不會靠猜 key 名稱決定要不要遮住(Slack webhook 網址 key 名稱完全不含 pass/token/secret，猜錯就會讓機密明文顯示)", () => {
  const workflow = createWorkflow(`test-missing-secret-type-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "slack", type: "slack-notify", label: "通知", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const saved = getWorkflow(workflow.id);
    if (!saved) throw new Error("workflow not found after save");
    const missing = getMissingWorkflowSettings(saved);
    const webhook = missing.find((m) => m.key === "slackWebhookUrl");
    assert.ok(webhook, "slack-notify 節點應該產生 slackWebhookUrl 這個缺帳密欄位");
    assert.equal(webhook!.type, "password", "節點宣告 slackWebhookUrl 是 password，回傳的缺帳密清單也要帶這個 type，不能讓前端只能靠猜 key 名稱(猜不出來會明文顯示)");
  } finally {
    deleteWorkflow(workflow.id);
  }
});
