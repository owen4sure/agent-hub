import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflow, deleteWorkflow, saveWorkflow } from "./store";
import { startWorkflowRun, getRun } from "./engine";
import { decideApproval } from "../approvals";
import { getDb } from "../db";
import type { WorkflowNode, WorkflowEdge } from "./types";

interface RunRow { status: string; }
interface NodeRunRow { node_id: string; status: string; }

/**
 * 真實踩過的事故：使用者要求「核准後同時做兩件事」(寫入試算表 + 桌面通知)，實測發現只要
 * 其中一個分支失敗(例如試算表寫入網址還沒設定)，另一個完全獨立、沒有依賴關係的分支
 * (桌面通知)就永遠不會執行(node_runs 停在 pending)——引擎的失敗處理在「沒有接失敗分支」時
 * 直接 break 整個執行迴圈，不分青紅皂白地連同不相干的兄弟分支一起放棄，而不是只跳過真正
 * 依賴這個失敗節點的下游。這裡直接用真實引擎(不 mock)重現，等修好後這個測試才會過。
 */

async function waitForStatus(runId: string, statuses: string[], timeoutMs = 20_000): Promise<{ run: RunRow | undefined; nodeRuns: NodeRunRow[] }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = getRun(runId) as { run: RunRow | undefined; nodeRuns: NodeRunRow[] };
    if (result.run && statuses.includes(result.run.status)) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`等 run ${runId} 進入 ${statuses.join("/")} 逾時，目前狀態：${(getRun(runId) as { run: RunRow | undefined }).run?.status}`);
}

function buildFanoutGraph(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "ask", type: "wait-approval", label: "核准公告", config: { message: "測試內容" }, position: { x: 300, y: 0 } },
      // 故意不給 scriptUrl，讓這個分支必定失敗(且沒有接 error 出線)，模擬真實踩過的情境
      { id: "append", type: "google-sheet-append", label: "寫入公告紀錄", config: { cells: "測試內容", scriptUrl: "" }, position: { x: 600, y: -100 } },
      { id: "approvedNotify", type: "desktop-notify", label: "已發布通知", config: { title: "已發布", message: "測試" }, position: { x: 600, y: 100 } },
      { id: "rejectedNotify", type: "desktop-notify", label: "已拒絕通知", config: { title: "已拒絕", message: "測試" }, position: { x: 300, y: 250 } },
    ],
    edges: [
      { from: "t", to: "ask" },
      { from: "ask", to: "append", fromPort: "approved" },
      { from: "ask", to: "approvedNotify", fromPort: "approved" },
      { from: "ask", to: "rejectedNotify", fromPort: "rejected" },
    ],
  };
}

test("引擎：核准後同時觸發的兩個分支，其中一個失敗不能讓另一個完全獨立的分支永遠不執行", async () => {
  const wf = createWorkflow(`test-fanout-approve-${Date.now()}`);
  try {
    const graph = buildFanoutGraph();
    saveWorkflow({ ...wf, status: "official", nodes: graph.nodes, edges: graph.edges });

    const runId = startWorkflowRun(wf.id, {}, { trigger: "manual" });
    await waitForStatus(runId, ["waiting"]);

    const db = getDb();
    const approval = db.prepare(`SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'`).get(runId) as { id: string } | undefined;
    assert.ok(approval, "應該要有一筆待簽核紀錄");
    const decision = await decideApproval({ id: approval!.id }, "approve");
    assert.equal(decision.ok, true, `核准應該成功：${decision.error}`);

    const { run, nodeRuns } = await waitForStatus(runId, ["failed", "success"]);
    assert.ok(run, "應該要有這次執行的紀錄");
    // append 沒設定 scriptUrl，預期就是會失敗——這是測試情境故意設計的，不是本次要修的問題
    const appendRun = nodeRuns.find((n) => n.node_id === "append");
    assert.equal(appendRun?.status, "failed", "append 分支預期失敗(沒有設定 scriptUrl)");
    // 這是真正要驗證的事：完全獨立、不依賴 append 的 approvedNotify 分支，不能因為 append 失敗
    // 就永遠停在 pending——它應該照樣被執行(不管成功或失敗，至少要「被嘗試」)。
    const notifyRun = nodeRuns.find((n) => n.node_id === "approvedNotify");
    assert.notEqual(notifyRun?.status, "pending", `approvedNotify 是跟失敗節點無關的獨立分支，不該永遠停在 pending(目前狀態：${notifyRun?.status})`);
    assert.equal(run.status, "failed", "整條 run 仍要老實回報失敗(有分支失敗)，不能假裝全部成功");
  } finally {
    deleteWorkflow(wf.id);
  }
});

test("引擎：拒絕簽核時只走拒絕分支，核准專屬的分支(寫入+通知)完全不執行", async () => {
  const wf = createWorkflow(`test-fanout-reject-${Date.now()}`);
  try {
    const graph = buildFanoutGraph();
    saveWorkflow({ ...wf, status: "official", nodes: graph.nodes, edges: graph.edges });

    const runId = startWorkflowRun(wf.id, {}, { trigger: "manual" });
    await waitForStatus(runId, ["waiting"]);

    const db = getDb();
    const approval = db.prepare(`SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'`).get(runId) as { id: string } | undefined;
    const decision = await decideApproval({ id: approval!.id }, "reject");
    assert.equal(decision.ok, true, `拒絕應該成功：${decision.error}`);

    const { run, nodeRuns } = await waitForStatus(runId, ["failed", "success"]);
    assert.ok(run, "應該要有這次執行的紀錄");
    assert.equal(run.status, "success", "拒絕分支沒有失敗步驟，整條 run 應該成功");
    const appendRun = nodeRuns.find((n) => n.node_id === "append");
    const approvedNotifyRun = nodeRuns.find((n) => n.node_id === "approvedNotify");
    const rejectedNotifyRun = nodeRuns.find((n) => n.node_id === "rejectedNotify");
    assert.equal(appendRun?.status, "skipped", "拒絕時不該寫入試算表");
    assert.equal(approvedNotifyRun?.status, "skipped", "拒絕時不該發「已發布」通知");
    assert.equal(rejectedNotifyRun?.status, "success", "拒絕分支的通知要真的執行");
  } finally {
    deleteWorkflow(wf.id);
  }
});
