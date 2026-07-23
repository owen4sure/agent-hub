import test from "node:test";
import assert from "node:assert/strict";
import { editNode } from "./nodeEditor";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";

function fakeClient(response: string) {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: response }, finish_reason: "stop" }] }),
      },
    },
  } as never;
}

// 真實踩過的案例：使用者在節點對話框回「數字出現逗號是正常的，不影響」——這句話根本不是要改
// 設定，AI 也正確判斷不用改，但因為節點面板的 prompt 一律強逼模型回一個 config JSON，判斷「不用
// 改」唯一的表達方式就是原封不動回傳目前的 config；「等於沒改」偵測把這種情況跟「AI 沒聽懂、隨便
// 回音」混為一談，一律丟一句罐頭訊息「請把要改什麼講得更具體一點」，使用者感覺自己的話完全沒被
// 聽進去、送出去像是掉進黑洞。修法讓 AI 能附上 note 說明「為什麼不用改」，這種情況要老實回報
// noChangeNeeded+note，不能算失敗，也不能假裝真的改了什麼。
test("editNode：AI 判斷不用改設定、附上 note 說明時，要回報 noChangeNeeded 而不是丟錯", async () => {
  const workflow = createWorkflow(`test-node-editor-nochange-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "n1", type: "set-variable", label: "存數字", config: { name: "x", value: "179720" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const client = fakeClient(JSON.stringify({
      config: { name: "x", value: "179720" },
      note: "讀回顯示成 179,720 只是千分位顯示格式，跟寫入的 179720 是同一個數字，不用改設定。",
    }));
    const result = await editNode(client, "test-model", workflow.id, "n1", [{ kind: "text", text: "數字出現,是正常的，不影響" }]);
    assert.equal(result.noChangeNeeded, true);
    assert.match(result.note ?? "", /千分位/);
    assert.deepEqual(getWorkflow(workflow.id)?.nodes[0]?.config, { name: "x", value: "179720" }, "沒有實際改動就不該碰存檔");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("editNode：AI 回傳跟目前設定完全相同、又沒附 note(等於隨便回音)時，仍要維持原本的失敗行為", async () => {
  const workflow = createWorkflow(`test-node-editor-echo-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "n1", type: "set-variable", label: "存數字", config: { name: "x", value: "179720" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const client = fakeClient(JSON.stringify({ config: { name: "x", value: "179720" } }));
    await assert.rejects(
      () => editNode(client, "test-model", workflow.id, "n1", [{ kind: "text", text: "隨便說點什麼" }]),
      /等於沒改/,
    );
  } finally {
    deleteWorkflow(workflow.id);
  }
});
