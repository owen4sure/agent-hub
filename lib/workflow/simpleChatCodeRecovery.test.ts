import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflow, deleteWorkflow, getWorkflow, saveWorkflow } from "./store";
import { tryApplySimpleChatCodeRecovery } from "./simpleChatCodeRecovery";

const explicitDailyIntent = `讀日報 Excel 的每日明細與通路累計摘要。
日期在A欄。
- C通路：台幣客戶數 BZ欄 + 外幣客戶數 BK欄
- D通路：台幣客戶數 CM欄 + 外幣客戶數 BW欄
從『通路結算及占比』分頁讀取餘額。`;

function makeWorkflow() {
  const workflow = createWorkflow("simple chat code recovery test");
  const node = {
    id: "metrics",
    type: "custom-code",
    label: "計算週增量",
    config: { intent: explicitDailyIntent, code: "" },
    position: { x: 300, y: 0 },
  };
  saveWorkflow({ ...workflow, nodes: [...workflow.nodes, node], edges: [{ from: "trigger", to: node.id }] });
  return workflow.id;
}

test("對話程式修復：明確說修空的日報計算步驟就直接重建、不等通用模型也不執行", () => {
  const id = makeWorkflow();
  try {
    const result = tryApplySimpleChatCodeRecovery(id, "「計算週增量」的程式碼被清空了，幫我修好，但先不要執行");
    assert.ok(result);
    assert.match(result?.message ?? "", /尚未執行/);
    const code = getWorkflow(id)?.nodes.find((node) => node.id === "metrics")?.config.code;
    assert.match(String(code), /findCumulativeColumn/);
  } finally {
    deleteWorkflow(id);
  }
});

test("對話程式修復：只是詢問原因或有多個候選時不擅自改程式", () => {
  const id = makeWorkflow();
  try {
    assert.equal(tryApplySimpleChatCodeRecovery(id, "為什麼「計算週增量」會卡住？"), null);
    assert.equal(getWorkflow(id)?.nodes.find((node) => node.id === "metrics")?.config.code, "");
  } finally {
    deleteWorkflow(id);
  }
});
