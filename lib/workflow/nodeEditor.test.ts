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

// 真實踩過的事故：節點面板「白話微調」一個 repeat-steps 節點時，AI 整包重寫了 steps(沒有帶
// stepIndex 走定點修改)，但內嵌 custom-code 的引號轉義多打了一層反斜線，讓整個 steps 變成
// 不合法的 JSON。這裡以前完全沒驗證，壞掉的字串直接存檔，流程要等下次打開才被 graphLint
// 攔下來(而且錯誤訊息完全看不出是哪個節點、哪裡壞的)。editNode 現在跟 applyNodeConfigEdits
// 共用同一個 validateCustomCodeEdit 閘門，這種壞 JSON 必須在存檔前被擋下、原設定保持不動。
test("editNode：repeat-steps 整包改 steps 時，若新的 steps 不是合法 JSON，要拒絕套用並保留原設定", async () => {
  const workflow = createWorkflow(`test-node-editor-badsteps-${Date.now()}`);
  const originalSteps = JSON.stringify([{ type: "custom-code", label: "算數字", config: { code: "return { ok: true };" } }]);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "loop1", type: "repeat-steps", label: "重複步驟", config: { items: "{{items}}", itemVar: "item", steps: originalSteps }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    // 模擬多打一層反斜線的轉義錯誤：\\" 在 JSON 裡會被解成「一個反斜線 + 提前結束字串的引號」
    const brokenSteps = `[{"type": "custom-code", "label": "算數字", "config": {"code": "const x = (await import(\\\\"exceljs\\\\")).default;"}}]`;
    const client = fakeClient(JSON.stringify({ config: { items: "{{items}}", itemVar: "item", steps: brokenSteps } }));
    await assert.rejects(
      () => editNode(client, "test-model", workflow.id, "loop1", [{ kind: "text", text: "把裡面的判斷邏輯改一下" }]),
      /steps 不是合法 JSON/,
    );
    assert.equal(getWorkflow(workflow.id)?.nodes[0]?.config.steps, originalSteps, "驗證沒過就不該碰存檔，原本可執行的 steps 必須保留");
  } finally {
    deleteWorkflow(workflow.id);
  }
});
