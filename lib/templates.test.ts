import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lintGraph, lintVarRefWarnings } from "./workflow/graphLint";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./workflow/types";

/**
 * 範本品質閘門:templates/ 每一份都必須過確定性 lint——
 * 範本是給新手「一鍵複製就能跑」的起點,帶著壞圖出貨等於教壞第一印象。
 */

const TEMPLATES_DIR = path.join(process.cwd(), "templates");
const files = fs.existsSync(TEMPLATES_DIR) ? fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json")) : [];

test("範本庫:至少要有 10 份精選範本", () => {
  assert.ok(files.length >= 10, `目前只有 ${files.length} 份`);
});

for (const f of files) {
  test(`範本 ${f}:graphLint 全過+必要欄位齊全`, () => {
    const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), "utf-8")) as {
      id?: string; name?: string; description?: string; category?: string; icon?: string;
      nodes?: WorkflowNode[]; edges?: WorkflowEdge[]; triggerParams?: ParamField[];
    };
    assert.ok(raw.id && raw.name && raw.description && raw.category && raw.icon, "id/name/description/category/icon 必填");
    assert.ok(Array.isArray(raw.nodes) && raw.nodes.length >= 2, "至少 2 個節點");
    const errors = lintGraph(raw.nodes!, raw.edges ?? []);
    assert.deepEqual(errors, [], `lint 沒過:\n${errors.join("\n")}`);
    // 變數引用軟警告也不放行——範本是精選內容,{{變數}} 接錯就是「複製即壞」
    const warns = lintVarRefWarnings(raw.nodes!, raw.edges ?? [], raw.triggerParams ?? []);
    assert.deepEqual(warns, [], `變數引用警告:\n${warns.join("\n")}`);
  });
}
