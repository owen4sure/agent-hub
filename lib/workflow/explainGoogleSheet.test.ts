import test from "node:test";
import assert from "node:assert/strict";
import { explainWorkflow } from "./explain";
import type { Workflow } from "./types";

test("Google Sheet 寫入說明只引導使用者在節點操作，不再叫他去設定頁", () => {
  const workflow: Workflow = {
    id: "wf-explain-sheet", name: "sheet", status: "draft", builtin: false, defaultModel: "minimax-m3", description: "",
    requiresSecrets: [], triggerParams: [], edges: [{ from: "trigger", to: "write" }], nodes: [
      { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
      { id: "write", type: "google-sheet-update", label: "寫入", config: { scriptUrl: "https://script.google.com/macros/s/x/exec", sheetName: "報表", targetColumn: "B", rows: "項目=1" }, position: { x: 300, y: 0 } },
    ],
  };
  const step = explainWorkflow(workflow).steps.find((item) => item.id === "write");
  assert.ok(step);
  assert.match(step.text, /網址就在這個步驟/);
  assert.doesNotMatch(JSON.stringify(step), /設定頁/);
  assert.deepEqual(step.settings.find(([label]) => label === "寫入網址"), ["寫入網址", "已保存在這個步驟"]);
});
