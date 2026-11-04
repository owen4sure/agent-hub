import assert from "node:assert/strict";
import test from "node:test";
import { buildAutomationReadiness, latestAutomationReadinessPassport, recordAutomationReadiness } from "./automationReadiness";
import type { Workflow } from "./types";
import { createWorkflow, deleteWorkflow, getWorkflow } from "./store";

function wf(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "wf-ready-test", name: "測試", status: "official", builtin: false, defaultModel: "minimax-m3",
    nodes: [{ id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }], edges: [], ...overrides,
  };
}

test("自動觸發檢查把多個阻擋原因整理成小白可執行的下一步", () => {
  const result = buildAutomationReadiness(wf(), { lintErrors: ["開始節點缺少必要設定"], missingSettings: [{ label: "信箱密碼" }], acceptanceOutdated: true });
  assert.equal(result.ready, false);
  assert.deepEqual(result.items.map((item) => item.code), ["invalid-graph", "missing-settings", "acceptance-outdated"]);
  assert.match(result.items[1].action, /設定/);
  assert.deepEqual(result.items.map((item) => item.actionCode), ["open-workflow", "open-settings", "start-safe-test"]);
});

test("沒有阻擋項時才回報可自動觸發", () => {
  assert.deepEqual(buildAutomationReadiness(wf()), { ready: true, items: [] });
});

test("安全健康巡檢失敗時，自動觸發不能繼續裝作已驗證", () => {
  const result = buildAutomationReadiness(wf(), { healthCheck: { enabled: true, lastStatus: "failed" } });
  assert.equal(result.ready, false);
  assert.equal(result.items.find((item) => item.code === "health-check")?.actionCode, "start-safe-test");
});

test("啟用護照同版同結果去重，阻擋原因改變才留下新快照", () => {
  const created = createWorkflow(`test-readiness-passport-${Date.now()}`);
  try {
    const saved = getWorkflow(created.id)!;
    const ready = buildAutomationReadiness(saved);
    const first = recordAutomationReadiness(saved, ready, "test");
    const duplicate = recordAutomationReadiness(saved, ready, "test-again");
    assert.equal(duplicate.id, first.id);
    const blocked = buildAutomationReadiness(saved, { missingSettings: [{ label: "測試連線" }] });
    const second = recordAutomationReadiness(saved, blocked, "test");
    assert.ok(second.id > first.id);
    assert.equal(latestAutomationReadinessPassport(saved)?.matchesCurrentGraph, true);
    assert.equal(latestAutomationReadinessPassport(saved)?.items.some((item) => item.code === "missing-settings"), true);
  } finally {
    deleteWorkflow(created.id);
  }
});

// 真實踩過(另一台電腦把流程匯入後)：排程時間到了卻沒跑，畫面上什麼都看不到。
// 原因是「匯入的流程要先確認」這道閘門只寫在 engine.startWorkflowRun 裡、沒有同步到這份檢查——
// 排程每分鐘照樣觸發、每分鐘被 throw 擋掉，而 throw 發生在建立執行紀錄之前(所以沒有任何紀錄)，
// 也跳過了 next_run_at 的更新(所以下一分鐘又被當成「錯過了要補跑」)，變成無限靜默重試。
test("匯入但還沒確認的流程要算「不能自動觸發」，不能讓排程每分鐘去撞 engine 的閘門", () => {
  const result = buildAutomationReadiness(wf({ importedUntrusted: true }));
  assert.equal(result.ready, false);
  const item = result.items.find((entry) => entry.code === "imported-untrusted");
  assert.ok(item, "要明確列出這一項，使用者才知道排程為什麼沒跑");
  assert.match(item!.action, /確認/);
  // 確認過後就不該再擋(旗標會在確認時被清掉)
  assert.deepEqual(buildAutomationReadiness(wf({ importedUntrusted: false })), { ready: true, items: [] });
});
