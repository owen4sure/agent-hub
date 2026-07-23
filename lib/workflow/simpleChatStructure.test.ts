import test from "node:test";
import assert from "node:assert/strict";
import { tryApplySimpleChatStructure } from "./simpleChatStructure";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";

test("白話結構快速通道：跑完在這台電腦通知我，直接新增並接上桌面通知", () => {
  const workflow = createWorkflow(`test-simple-chat-${Date.now()}`);
  try {
    const result = tryApplySimpleChatStructure(workflow.id, "跑完時在這台電腦跳出「已完成」通知，請直接加到流程裡。");
    assert.ok(result);
    assert.match(result!.message, /直接/);
    const saved = getWorkflow(workflow.id)!;
    const notice = saved.nodes.find((node) => node.type === "desktop-notify");
    assert.ok(notice);
    assert.equal(notice!.config.message, "已完成");
    assert.ok(saved.edges.some((edge) => edge.from === "trigger" && edge.to === notice!.id));
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("白話結構快速通道：刪除唯一名稱的中間節點時，安全接回前後步驟", () => {
  const workflow = createWorkflow(`test-simple-remove-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        { id: "notice", type: "desktop-notify", label: "通知我", config: { message: "完成" }, position: { x: 250, y: 0 } },
        { id: "done", type: "template-text", label: "整理", config: { template: "完成" }, position: { x: 500, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "notice" }, { from: "notice", to: "done" }],
    });
    const result = tryApplySimpleChatStructure(workflow.id, "不需要「通知我」，請刪掉。");
    assert.ok(result);
    const saved = getWorkflow(workflow.id)!;
    assert.equal(saved.nodes.some((node) => node.id === "notice"), false);
    assert.deepEqual(saved.edges, [{ from: "trigger", to: "done" }]);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("白話結構快速通道：多個終點有歧義時不擅自掛通知，交給整圖 AI", () => {
  const workflow = createWorkflow(`test-simple-ambiguous-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        { id: "a", type: "template-text", label: "A", config: { template: "A" }, position: { x: 250, y: 0 } },
        { id: "b", type: "template-text", label: "B", config: { template: "B" }, position: { x: 250, y: 150 } },
      ],
      edges: [{ from: "trigger", to: "a" }, { from: "trigger", to: "b" }],
    });
    assert.equal(tryApplySimpleChatStructure(workflow.id, "跑完時在這台電腦跳出通知，請加上。"), null);
    assert.equal(getWorkflow(workflow.id)!.nodes.some((node) => node.type === "desktop-notify"), false);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("白話結構快速通道：句尾的『不要現在執行』不是刪除前面引號裡的節點", () => {
  const workflow = createWorkflow(`test-simple-no-false-delete-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        workflow.nodes[0],
        { id: "summary", type: "template-text", label: "整理內容", config: { template: "每日摘要" }, position: { x: 250, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "summary" }],
    });
    const result = tryApplySimpleChatStructure(workflow.id, "請在「整理內容」後新增一步把文字存檔，不要現在真的執行。");
    assert.equal(result, null);
    assert.equal(getWorkflow(workflow.id)!.nodes.some((node) => node.id === "summary"), true);
  } finally {
    deleteWorkflow(workflow.id);
  }
});
