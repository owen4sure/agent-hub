import test from "node:test";
import assert from "node:assert/strict";
import { beginRepairSession, endRepairSession, recoverCrashedRepairs } from "./repairSessions";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";
import { getDb } from "../db";

// 明顯不可能存在的 pid，模擬「承載修復迴圈的進程已經死掉」——不能借真的 beginRepairSession
// 造這個情境，因為它一定會記錄呼叫端(也就是測試本身)的 process.pid，那顆 pid 當然還活著。
const DEAD_PID = 999_999_999;

test("beginRepairSession／endRepairSession：正常結束會把自己的快照紀錄清乾淨", () => {
  const workflow = createWorkflow(`test-repair-session-clean-${Date.now()}`);
  try {
    const id = beginRepairSession(workflow.id, "autofix", { nodes: workflow.nodes, edges: workflow.edges });
    const row = getDb().prepare(`SELECT * FROM repair_sessions WHERE id = ?`).get(id);
    assert.ok(row, "開始修復時應該登記一筆快照");
    endRepairSession(id);
    const after = getDb().prepare(`SELECT * FROM repair_sessions WHERE id = ?`).get(id);
    assert.equal(after, undefined, "正常結束後這筆紀錄應該被清掉");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

// 真實已知但沒處理過的限制：busyLocks.ts 的 autorunActive 只是進程內記憶體，daemon(launchd 常駐)
// + 使用者另外開的 dev instance 同時跑時，兩邊的記憶體鎖互相看不到對方，可能同時對同一條流程跑
// 修復迴圈。beginRepairSession 現在會查 SQLite(跨進程共用)有沒有「owner_pid 還活著」的既有
// session，有就拒絕開新的一輪。
test("beginRepairSession：同一條流程已有另一個活著的進程在修復時，要拒絕開新的一輪", () => {
  const workflow = createWorkflow(`test-repair-session-crossproc-${Date.now()}`);
  try {
    const first = beginRepairSession(workflow.id, "autofix", { nodes: workflow.nodes, edges: workflow.edges });
    try {
      // 呼叫端自己(這個測試進程)的 pid 一定是活著的，所以第二次呼叫應該被拒絕
      assert.throws(
        () => beginRepairSession(workflow.id, "autofix", { nodes: workflow.nodes, edges: workflow.edges }),
        /正在修復中/,
      );
    } finally {
      endRepairSession(first);
    }
    // 第一個 session 正常結束(登出)後，同一條流程應該能再開新的一輪
    const second = beginRepairSession(workflow.id, "autofix", { nodes: workflow.nodes, edges: workflow.edges });
    endRepairSession(second);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("recoverCrashedRepairs：進程沒死掉的修復session不能被誤還原", () => {
  const workflow = createWorkflow(`test-repair-session-alive-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "n1", type: "set-variable", label: "設變數", config: { name: "x", value: "1" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const before = { nodes: getWorkflow(workflow.id)!.nodes, edges: getWorkflow(workflow.id)!.edges };
    const sessionId = beginRepairSession(workflow.id, "autofix", before);
    // 模擬迴圈「還在跑、尚未驗證完」時就已經改動了節點(真實情境：套用了一輪還沒驗證過的修法)
    saveWorkflow({ ...getWorkflow(workflow.id)!, nodes: [{ id: "n1", type: "set-variable", label: "設變數", config: { name: "x", value: "被還沒驗證的修法改過" }, position: { x: 0, y: 0 } }] });

    recoverCrashedRepairs();

    assert.equal(getWorkflow(workflow.id)?.nodes[0]?.config.value, "被還沒驗證的修法改過", "呼叫端(這個測試自己)的 pid 還活著，不該被回收");
    endRepairSession(sessionId);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

// 真實踩過的事故：一次「讓AI修」的修復迴圈在套用了一輪還沒驗證過的節點改動後，
// 承載這個請求的進程被重啟打斷，迴圈自己的 restoreUnverified() 完全沒有機會執行，
// 未驗證的改動就這樣半吊子永久留在流程上。這條測試釘住 recoverCrashedRepairs()
// 在下次啟動時能正確判斷「上次那個進程已經死了」並把流程還原成迴圈開始前的樣子。
test("recoverCrashedRepairs：進程已死的修復session要把流程還原成迴圈開始前的快照", () => {
  const workflow = createWorkflow(`test-repair-session-crash-${Date.now()}`);
  try {
    const originalNodes = [{ id: "n1", type: "set-variable", label: "設變數", config: { name: "x", value: "原始值" }, position: { x: 0, y: 0 } }];
    saveWorkflow({ ...workflow, nodes: originalNodes, edges: [] });
    const before = { nodes: getWorkflow(workflow.id)!.nodes, edges: getWorkflow(workflow.id)!.edges };

    // 直接操作 DB 造一筆「owner_pid 已死」的孤兒紀錄——不能用 beginRepairSession，
    // 它一定會記錄呼叫端自己的 pid(還活著)。
    const db = getDb();
    const orphanId = "test-orphan-session-id";
    db.prepare(
      `INSERT INTO repair_sessions (id, workflow_id, kind, owner_pid, before_json, started_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(orphanId, workflow.id, "autofix", DEAD_PID, JSON.stringify(before));

    // 模擬迴圈中途改動了節點、但還沒驗證完就被中斷——留下沒被還原的半成品
    saveWorkflow({ ...getWorkflow(workflow.id)!, nodes: [{ id: "n1", type: "set-variable", label: "設變數", config: { name: "x", value: "還沒驗證就被中斷的半成品" }, position: { x: 0, y: 0 } }] });

    recoverCrashedRepairs();

    const restored = getWorkflow(workflow.id);
    assert.equal(restored?.nodes[0]?.config.value, "原始值", "應該還原成迴圈開始前的快照，不留下未驗證的半成品");
    const remaining = db.prepare(`SELECT * FROM repair_sessions WHERE id = ?`).get(orphanId);
    assert.equal(remaining, undefined, "處理過的孤兒紀錄應該被清掉，不然每次啟動都會重複還原/警告");
  } finally {
    deleteWorkflow(workflow.id);
  }
});
