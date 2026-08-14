import assert from "node:assert/strict";
import test from "node:test";
import { putSheetUrlIntoAllWriteNodes, putSheetUrlIntoMatchingWriteNodes } from "./sheetWriteUrlMigration";
import type { Workflow } from "./workflow/types";

// 真實案例：同一條流程要寫兩份不同的試算表，各自部署一支 Apps Script。
// 舊的「貼網址→全部寫入節點一起換」行為會讓第二支網址把第一份試算表的步驟整批蓋掉，永遠設不完。
function wf(nodes: Workflow["nodes"]): Workflow {
  return { id: "wf-test", name: "測試", status: "draft", nodes, edges: [] } as unknown as Workflow;
}

const URL_A = "https://script.google.com/macros/s/AAA/exec";
const URL_B = "https://script.google.com/macros/s/BBB/exec";

test("putSheetUrlIntoMatchingWriteNodes：只套用到分頁名在這份試算表裡的寫入步驟，其餘點名回報", () => {
  const workflow = wf([
    { id: "n1", type: "google-sheet-update", label: "更新月報表", config: { sheetName: "月報彙總", scriptUrl: "" } },
    { id: "n2", type: "google-sheet-update", label: "更新統計文字", config: { sheetName: "統計文字區", scriptUrl: "" } },
    { id: "n3", type: "custom-code", label: "無關步驟", config: {} },
  ] as unknown as Workflow["nodes"]);

  const first = putSheetUrlIntoMatchingWriteNodes(workflow, URL_A, ["月報彙總", "每週折線圖"]);
  assert.equal(first.changedNodes, 1);
  assert.deepEqual(first.matchedLabels, ["更新月報表"]);
  assert.deepEqual(first.unmatchedSheetNodes, [{ label: "更新統計文字", sheetName: "統計文字區" }]);
  assert.equal(first.workflow.nodes[0].config.scriptUrl, URL_A);
  assert.equal(first.workflow.nodes[1].config.scriptUrl, "");

  // 貼第二支(另一份試算表)的網址：只填對應那步，不把第一支已填好的蓋掉
  const second = putSheetUrlIntoMatchingWriteNodes(first.workflow, URL_B, ["統計文字區", "2026"]);
  assert.equal(second.changedNodes, 1);
  assert.equal(second.workflow.nodes[0].config.scriptUrl, URL_A, "第一份試算表的步驟不能被第二支網址蓋掉");
  assert.equal(second.workflow.nodes[1].config.scriptUrl, URL_B);
});

test("putSheetUrlIntoMatchingWriteNodes：分頁名留空或含樣板時視為可套用(無法靜態判斷，維持寬容)", () => {
  const workflow = wf([
    { id: "n1", type: "google-sheet-append", label: "寫第一個分頁", config: { scriptUrl: "" } },
    { id: "n2", type: "google-sheet-update", label: "動態分頁", config: { sheetName: "{{monthTab}}", scriptUrl: "" } },
  ] as unknown as Workflow["nodes"]);
  const applied = putSheetUrlIntoMatchingWriteNodes(workflow, URL_A, ["某分頁"]);
  assert.equal(applied.changedNodes, 2);
  assert.equal(applied.unmatchedSheetNodes.length, 0);
});

test("putSheetUrlIntoAllWriteNodes：維持原本整批套用行為(舊版腳本沒回報分頁清單時的退路)", () => {
  const workflow = wf([
    { id: "n1", type: "google-sheet-update", label: "A", config: { sheetName: "甲", scriptUrl: URL_A } },
    { id: "n2", type: "google-sheet-update", label: "B", config: { sheetName: "乙", scriptUrl: "" } },
  ] as unknown as Workflow["nodes"]);
  const applied = putSheetUrlIntoAllWriteNodes(workflow, URL_B);
  assert.equal(applied.changedNodes, 2);
  assert.equal(applied.workflow.nodes[0].config.scriptUrl, URL_B);
  assert.equal(applied.workflow.nodes[1].config.scriptUrl, URL_B);
});
