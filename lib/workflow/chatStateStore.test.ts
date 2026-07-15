import assert from "node:assert/strict";
import test from "node:test";
import { deleteWorkflowChatState, getWorkflowChatState, saveWorkflowChatState } from "./chatStateStore";

test("workflow 對話狀態可在重新整理後從 server 檔案恢復，刪除時不留孤兒", () => {
  const id = `qa-chat-${Date.now()}`;
  try {
    saveWorkflowChatState(id, {
      chat: [{ role: "user", parts: [{ kind: "text", text: "把第 9 步改好後再測" }] }],
      pendingGraph: null,
      pendingExecution: null,
    });
    const restored = getWorkflowChatState(id);
    assert.deepEqual(restored?.chat, [{ role: "user", parts: [{ kind: "text", text: "把第 9 步改好後再測" }] }]);
  } finally {
    deleteWorkflowChatState(id);
  }
  assert.equal(getWorkflowChatState(id), null);
});

test("workflow 對話狀態拒絕超過 1MB，避免單一流程灌爆磁碟", () => {
  const id = `qa-chat-large-${Date.now()}`;
  assert.throws(() => saveWorkflowChatState(id, {
    chat: [{ role: "user", parts: [{ kind: "text", text: "x".repeat(1_100_000) }] }],
    pendingGraph: null,
    pendingExecution: null,
  }), /超過 1MB/);
  deleteWorkflowChatState(id);
});
