import test from "node:test";
import assert from "node:assert/strict";
import { createWorkflow, deleteWorkflow, saveWorkflow } from "./store";
import { startWorkflowRun, getRun } from "./engine";
import { setMaxConcurrent } from "../settingsStore";
import { getDb } from "../db";
import type { WorkflowNode, WorkflowEdge } from "./types";

/**
 * 真實踩過的設計缺陷(2026-08 使用者原話：「基本上都不需要有並行的時候，全部都輪流就好了」)：
 * 「執行子流程」節點呼叫子流程時，母流程整個停下來等(runWorkflowAndWait)——母子兩者本來就是
 * 輪流、不是同時做事。但舊版 processQueue() 用同一個 activeCount 算「同時執行中」名額，依序模式
 * (maxConcurrent=1)下母流程自己傻等就已經佔滿唯一名額，子流程永遠排不進去，變成死結，逼使用者
 * 把全站設定改成併行才能用「執行子流程」——而這會連帶讓其他互不相干、真的需要嚴格輪流的排程
 * 也一起被放行併行執行，不是使用者要的效果。這裡直接用真實引擎(不 mock)驗證兩件事：
 * ①依序模式下「執行子流程」也要能正常跑完；②依序模式對「真的互不相干」的流程仍然嚴格生效。
 */

async function waitForStatus(runId: string, statuses: string[], timeoutMs = 20_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const result = getRun(runId) as { run?: { status: string } };
    if (result.run && statuses.includes(result.run.status)) return result.run.status;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等 run ${runId} 進入 ${statuses.join("/")} 逾時，目前狀態：${result.run?.status}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function simpleGraph(code = "return { ...ctx.input, ran: true };"): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: [
      { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "c", type: "custom-code", label: "算一個值", config: { intent: "測試用，回傳一個標記欄位", code }, position: { x: 300, y: 0 } },
    ],
    edges: [{ from: "t", to: "c" }],
  };
}

/** maxConcurrent 是全站共用的一列設定；測試前後都要把它還原成原本的值(或原本沒有設定過就刪掉這列)，不能讓這個測試污染其他測試或正式環境的設定。 */
function withMaxConcurrent1<T>(fn: () => Promise<T>): Promise<T> {
  const db = getDb();
  const priorRow = db.prepare(`SELECT value FROM settings WHERE key = 'maxConcurrent'`).get() as { value: string } | undefined;
  setMaxConcurrent(1);
  return fn().finally(() => {
    if (priorRow) db.prepare(`UPDATE settings SET value = ? WHERE key = 'maxConcurrent'`).run(priorRow.value);
    else db.prepare(`DELETE FROM settings WHERE key = 'maxConcurrent'`).run();
  });
}

test("依序模式(maxConcurrent=1)下，「執行子流程」呼叫也要能正常跑完，不能死結在 running(母流程傻等佔滿唯一名額)", async () => {
  await withMaxConcurrent1(async () => {
    const child = createWorkflow(`test-subwf-child-${Date.now()}`);
    const parent = createWorkflow(`test-subwf-parent-${Date.now()}`);
    try {
      const childGraph = simpleGraph();
      saveWorkflow({ ...child, status: "official", nodes: childGraph.nodes, edges: childGraph.edges });

      const parentGraph: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } = {
        nodes: [
          { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
          { id: "sub", type: "run-workflow", label: "執行子流程", config: { target: child.id }, position: { x: 300, y: 0 } },
        ],
        edges: [{ from: "t", to: "sub" }],
      };
      saveWorkflow({ ...parent, status: "official", nodes: parentGraph.nodes, edges: parentGraph.edges });

      const runId = startWorkflowRun(parent.id, {}, { trigger: "manual" });
      const status = await waitForStatus(runId, ["success", "failed"], 25_000);
      assert.equal(status, "success", "子流程呼叫在依序模式下應該要能正常跑完，不能卡死在 running");
    } finally {
      deleteWorkflow(parent.id);
      deleteWorkflow(child.id);
    }
  });
});

test("互相呼叫的子流程(A→B→A)要在送出前就被擋下來，不能排進佇列卡到 15 分鐘逾時才失敗(2026-08 code review 抓到的真實 bug)", async () => {
  await withMaxConcurrent1(async () => {
    const wfA = createWorkflow(`test-cycle-a-${Date.now()}`);
    const wfB = createWorkflow(`test-cycle-b-${Date.now()}`);
    try {
      const graphA: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } = {
        nodes: [
          { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
          { id: "sub", type: "run-workflow", label: "執行子流程", config: { target: wfB.id }, position: { x: 300, y: 0 } },
        ],
        edges: [{ from: "t", to: "sub" }],
      };
      const graphB: { nodes: WorkflowNode[]; edges: WorkflowEdge[] } = {
        nodes: [
          { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
          { id: "sub", type: "run-workflow", label: "執行子流程", config: { target: wfA.id }, position: { x: 300, y: 0 } },
        ],
        edges: [{ from: "t", to: "sub" }],
      };
      saveWorkflow({ ...wfA, status: "official", nodes: graphA.nodes, edges: graphA.edges });
      saveWorkflow({ ...wfB, status: "official", nodes: graphB.nodes, edges: graphB.edges });

      const runId = startWorkflowRun(wfA.id, {}, { trigger: "manual" });
      // 有修好的話幾秒內就會失敗；用比 15 分鐘逾時短很多的等待時間，確認不是卡死等到強制逾時才失敗
      const status = await waitForStatus(runId, ["success", "failed"], 15_000);
      assert.equal(status, "failed", "A→B→A 互相呼叫應該要老實失敗，不能被誤判成功");
      const { run } = getRun(runId) as { run?: { error?: string; reason?: string } };
      const message = `${run?.error ?? ""} ${run?.reason ?? ""}`;
      assert.match(message, /呼叫迴圈|已經在這條呼叫鏈/, `失敗原因要講清楚是子流程呼叫迴圈，不能是別的原因或逾時(目前原因：${message})`);
    } finally {
      deleteWorkflow(wfA.id);
      deleteWorkflow(wfB.id);
    }
  });
});

test("依序模式(maxConcurrent=1)下，兩條互不相干、沒有巢狀呼叫關係的流程仍然要嚴格輪流，不能同時跑", async () => {
  await withMaxConcurrent1(async () => {
    const wfA = createWorkflow(`test-independent-a-${Date.now()}`);
    const wfB = createWorkflow(`test-independent-b-${Date.now()}`);
    try {
      // A 故意跑久一點，確保 B 開始排程判斷時 A 一定還在跑
      const graphA = simpleGraph("await new Promise((r) => setTimeout(r, 1500)); return { ...ctx.input, aRan: true };");
      saveWorkflow({ ...wfA, status: "official", nodes: graphA.nodes, edges: graphA.edges });
      const graphB = simpleGraph();
      saveWorkflow({ ...wfB, status: "official", nodes: graphB.nodes, edges: graphB.edges });

      const runIdA = startWorkflowRun(wfA.id, {}, { trigger: "manual" });
      await waitForStatus(runIdA, ["running"], 5_000);
      const runIdB = startWorkflowRun(wfB.id, {}, { trigger: "manual" });
      await new Promise((r) => setTimeout(r, 300)); // 給排程一點時間決定 B 的狀態
      const bStatus = (getRun(runIdB) as { run?: { status: string } }).run?.status;
      assert.equal(bStatus, "queued", `B 是獨立、沒有被 A 呼叫的流程，A 還沒跑完時 B 應該要乖乖排隊，不能被誤判成不佔名額而立刻跑(目前狀態：${bStatus})`);

      await waitForStatus(runIdA, ["success", "failed"], 10_000);
      await waitForStatus(runIdB, ["success", "failed"], 10_000);
    } finally {
      deleteWorkflow(wfA.id);
      deleteWorkflow(wfB.id);
    }
  });
});
