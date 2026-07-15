import test from "node:test";
import assert from "node:assert/strict";
import { extractAppsScriptExecUrl, putLegacySheetUrlIntoNodes, putSheetUrlIntoAllWriteNodes } from "./sheetWriteUrlMigration";
import type { Workflow } from "./workflow/types";

function workflow(): Workflow {
  return {
    id: "wf-migrate-test", name: "test", status: "draft", builtin: false, defaultModel: "minimax-m3",
    description: "", requiresSecrets: [{ key: "sheetAppendUrl", label: "舊欄位", type: "password" }],
    triggerParams: [], edges: [], nodes: [
      { id: "read", type: "google-sheet-read", label: "讀", config: { sheetUrl: "https://docs.google.com/x" }, position: { x: 0, y: 0 } },
      { id: "write1", type: "google-sheet-update", label: "寫一", config: {}, position: { x: 300, y: 0 } },
      { id: "write2", type: "google-sheet-append", label: "寫二", config: { scriptUrl: "https://script.google.com/macros/s/already/exec" }, position: { x: 600, y: 0 } },
    ],
  };
}

test("舊 Google Sheet 寫入網址只補進空白寫入節點，不污染讀取節點也不蓋掉既有值", () => {
  const source = workflow();
  const result = putLegacySheetUrlIntoNodes(source, "https://script.google.com/macros/s/legacy/exec");
  assert.equal(result.changedNodes, 1);
  assert.equal(result.workflow.nodes[0].config.scriptUrl, undefined);
  assert.equal(result.workflow.nodes[1].config.scriptUrl, "https://script.google.com/macros/s/legacy/exec");
  assert.equal(result.workflow.nodes[2].config.scriptUrl, "https://script.google.com/macros/s/already/exec");
  assert.equal(source.nodes[1].config.scriptUrl, undefined, "純函式不能修改呼叫端的 workflow");
});

test("對話中的 Apps Script /exec 網址可確定性擷取並一次套用全部寫入節點", () => {
  const url = "https://script.google.com/macros/s/new-deployment_123/exec";
  assert.equal(extractAppsScriptExecUrl(`請改用這個：${url}，然後幫我測`), url);
  assert.equal(extractAppsScriptExecUrl("https://docs.google.com/spreadsheets/d/abc/edit"), null);
  const result = putSheetUrlIntoAllWriteNodes(workflow(), url);
  assert.equal(result.writeNodes, 2);
  assert.equal(result.changedNodes, 2);
  assert.equal(result.workflow.nodes[0].config.scriptUrl, undefined);
  assert.equal(result.workflow.nodes[1].config.scriptUrl, url);
  assert.equal(result.workflow.nodes[2].config.scriptUrl, url);
});
