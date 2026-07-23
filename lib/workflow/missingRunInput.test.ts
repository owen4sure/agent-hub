import assert from "node:assert/strict";
import { test } from "node:test";
import { missingTriggerInputsForFailure } from "./missingRunInput";
import type { WorkflowNode } from "./types";

const readNode: WorkflowNode = {
  id: "read", type: "read-file", label: "讀檔", config: { path: "{{filePath}}" }, position: { x: 0, y: 0 },
};
const params = [{ key: "filePath", label: "本次要處理的檔案", type: "text" as const }];

test("缺少本次選檔：失敗節點引用空 filePath 時立刻交回使用者，不進 AI 修復", () => {
  assert.deepEqual(
    missingTriggerInputsForFailure(readNode, params, { filePath: "" }, "找不到檔案：(路徑是空的)——請確認上游有傳路徑下來"),
    params,
  );
});

test("缺少本次選檔：非空、未引用或非輸入缺失錯誤都不能誤擋 AI 修復", () => {
  assert.deepEqual(missingTriggerInputsForFailure(readNode, params, { filePath: "/tmp/a.csv" }, "找不到檔案：/tmp/a.csv"), []);
  assert.deepEqual(missingTriggerInputsForFailure(readNode, params, { filePath: "" }, "欄位名稱拼錯"), []);
  assert.deepEqual(missingTriggerInputsForFailure({ ...readNode, config: { path: "/tmp/a.csv" } }, params, { filePath: "" }, "找不到檔案：(路徑是空的)"), []);
});
