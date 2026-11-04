import test from "node:test";
import assert from "node:assert/strict";
import { wantsImportExistingWorkflowNodes, spliceImportedWorkflowNodes, importConfirmMessage } from "./importExistingWorkflowNodes";
import { lintGraph } from "./graphLint";
import type { Workflow, WorkflowNode, WorkflowEdge } from "./types";

/**
 * 2026-08：使用者要求「把既有流程的步驟複製過來、我自己在畫布上串接」，而不是用執行子流程
 * 呼叫、也不要 AI 重新打字生成一份「看起來一樣」的節點。這裡驗證：①判斷使用者是不是真的要
 * 「複製節點」而不是別的意圖；②複製出來的節點/連線是原封不動搬過來的(id 可能因撞名而改，
 * 但內容一模一樣)；③複製完的整張圖一定要能通過 lintGraph(尤其是可達性——這是實際會擋下
 * 「套用到畫布」的硬性檢查，見 app/api/workflows/[id]/build/route.ts 的 PUT)。
 */

function fakeWorkflow(overrides: Partial<Workflow> & { id: string; name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] }): Workflow {
  return {
    status: "official",
    builtin: false,
    defaultModel: "minimax-m3",
    ...overrides,
  } as Workflow;
}

test("wantsImportExistingWorkflowNodes：複製/匯入/搬/貼/拿過來這幾種講法都要認得出來", () => {
  assert.equal(wantsImportExistingWorkflowNodes("把這兩條流程的步驟都複製過來"), true);
  assert.equal(wantsImportExistingWorkflowNodes("直接匯入節點就好"), true);
  assert.equal(wantsImportExistingWorkflowNodes("搬過來給我"), true);
  assert.equal(wantsImportExistingWorkflowNodes("貼進來"), true);
  assert.equal(wantsImportExistingWorkflowNodes("拿過來"), true);
});

test("wantsImportExistingWorkflowNodes：只是要呼叫/引用既有流程(不是要複製節點)不該誤判", () => {
  assert.equal(wantsImportExistingWorkflowNodes("跑一次這條流程，再把結果拿去用"), false);
  assert.equal(wantsImportExistingWorkflowNodes("用執行子流程呼叫它就好"), false);
});

test("spliceImportedWorkflowNodes：把一條來源流程的節點原封不動接進目標流程，內容一字不改", () => {
  const source = fakeWorkflow({
    id: "src-1",
    name: "流程一",
    nodes: [
      { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "login", type: "custom-code", label: "登入", config: { intent: "登入", code: "return {...ctx.input};" }, position: { x: 300, y: 0 } },
      { id: "submit", type: "custom-code", label: "送出資料", config: { intent: "送出", code: "return {...ctx.input};" }, position: { x: 600, y: 0 } },
    ],
    edges: [{ from: "t", to: "login" }, { from: "login", to: "submit" }],
  });
  const target = {
    nodes: [{ id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }] as WorkflowNode[],
    edges: [] as WorkflowEdge[],
  };

  const result = spliceImportedWorkflowNodes(target, [source]);

  assert.deepEqual(result.imported, [{ name: "流程一", nodeCount: 2 }]);
  // 觸發節點不複製——目標流程只能有一個
  assert.equal(result.nodes.filter((n) => n.type === "trigger").length, 1);
  const login = result.nodes.find((n) => n.id === "login");
  const submit = result.nodes.find((n) => n.id === "submit");
  assert.ok(login && submit, "來源流程的兩個非觸發節點都要出現在結果裡");
  assert.deepEqual(login!.config, { intent: "登入", code: "return {...ctx.input};" }, "節點內容要原封不動，不能被改寫");
  // 組內原本的接法(login→submit)要保留
  assert.ok(result.edges.some((e) => e.from === "login" && e.to === "submit"));
  // login 在來源裡沒有其他上游(只靠來源自己的觸發節點)，要被接到目標流程現有的觸發節點，圖才合法
  assert.ok(result.edges.some((e) => e.from === "t" && e.to === "login"));

  const errors = lintGraph(result.nodes, result.edges);
  assert.deepEqual(errors, [], `複製完的圖必須通過 lintGraph(這是「套用到畫布」實際會擋下的檢查)，但出現：${errors.join("；")}`);
});

test("spliceImportedWorkflowNodes：id 撞到目標流程既有節點時要自動改名，內部連線跟著改，不能斷線", () => {
  const source = fakeWorkflow({
    id: "src-2",
    name: "流程二",
    nodes: [
      { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "step1", type: "custom-code", label: "算金額", config: { intent: "算金額" }, position: { x: 300, y: 0 } },
    ],
    edges: [{ from: "t", to: "step1" }],
  });
  const target = {
    nodes: [
      { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "step1", type: "custom-code", label: "既有節點(id 剛好也叫 step1)", config: { intent: "既有節點" }, position: { x: 300, y: 0 } },
    ] as WorkflowNode[],
    edges: [{ from: "t", to: "step1" }] as WorkflowEdge[],
  };

  const result = spliceImportedWorkflowNodes(target, [source]);

  assert.equal(result.nodes.length, 3, "目標原本 2 個節點 + 來源新增 1 個節點(觸發節點不算)");
  const ids = result.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, "id 不能重複");
  const importedNode = result.nodes.find((n) => n.label === "算金額");
  assert.ok(importedNode && importedNode.id !== "step1", "撞名的節點要被改成不同的新 id");
  assert.ok(result.edges.some((e) => e.to === importedNode!.id), "改名後連線要指向新 id，不能斷線");

  const errors = lintGraph(result.nodes, result.edges);
  assert.deepEqual(errors, []);
});

test("spliceImportedWorkflowNodes：合併兩條來源流程，各自的節點都要出現、都要能從觸發節點連到", () => {
  const sourceA = fakeWorkflow({
    id: "src-a", name: "流程A",
    nodes: [
      { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "a1", type: "custom-code", label: "A 步驟", config: { intent: "A 步驟" }, position: { x: 300, y: 0 } },
    ],
    edges: [{ from: "t", to: "a1" }],
  });
  const sourceB = fakeWorkflow({
    id: "src-b", name: "流程B",
    nodes: [
      { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "b1", type: "custom-code", label: "B 步驟", config: { intent: "B 步驟" }, position: { x: 300, y: 0 } },
    ],
    edges: [{ from: "t", to: "b1" }],
  });
  const target = {
    nodes: [{ id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }] as WorkflowNode[],
    edges: [] as WorkflowEdge[],
  };

  const result = spliceImportedWorkflowNodes(target, [sourceA, sourceB]);

  assert.deepEqual(result.imported, [{ name: "流程A", nodeCount: 1 }, { name: "流程B", nodeCount: 1 }]);
  assert.ok(result.nodes.some((n) => n.label === "A 步驟"));
  assert.ok(result.nodes.some((n) => n.label === "B 步驟"));
  const errors = lintGraph(result.nodes, result.edges);
  assert.deepEqual(errors, []);
});

test("importConfirmMessage：講清楚是原封不動複製、不是呼叫、不是 AI 重新生成的", () => {
  const msg = importConfirmMessage([{ name: "流程一", nodeCount: 2 }, { name: "流程二", nodeCount: 3 }]);
  assert.match(msg, /流程一/);
  assert.match(msg, /流程二/);
  assert.match(msg, /原封不動/);
  assert.match(msg, /不是用執行子流程呼叫/);
  assert.match(msg, /共新增 5 個節點/);
});

/**
 * 2026-08 使用者實測踩到的真實 bug：這裡自己在訊息結尾寫了一次「(下方預覽新流程，確認後按
 * 「套用」)」，但 wfChatStore.ts 對 phase:"ready" 的回覆一律會自動再掛一次同一句——畫面上
 * 那句提示重複出現了兩次。往後也曾發生 phase 不是 ready 的回覆抄了這句話造成使用者對著不存在
 * 的預覽卡空等(見 wfChatStore.test.ts 的 stripReadyOnlyPromise)，這裡的訊息本身不該再製造
 * 一次同樣的重複來源。
 */
test("importConfirmMessage：不能自己內建「下方預覽新流程」提示——那是前端統一掛的，這裡再寫一次會重複顯示", () => {
  const msg = importConfirmMessage([{ name: "流程一", nodeCount: 2 }]);
  assert.doesNotMatch(msg, /下方預覽新流程/);
});
