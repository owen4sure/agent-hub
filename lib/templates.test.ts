import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { lintGraph, lintVarRefWarnings } from "./workflow/graphLint";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./workflow/types";

/**
 * 藍圖品質閘門:community/blueprints/ 是 AI 大腦的仿作範例庫(從 n8n 社群工作流忠實移植、
 * 已轉成我們的節點格式)。AI 會照著藍圖建圖——帶壞圖出貨等於教 AI 犯錯,
 * 所以每一份都必須過確定性 lint+變數引用零警告。
 * (介面刻意不展示這些:使用者看到的永遠只有自己的流程,厲害的藏在大腦裡。)
 */

const BLUEPRINTS_DIR = path.join(process.cwd(), "community", "blueprints");
const bpFiles = fs.existsSync(BLUEPRINTS_DIR) ? fs.readdirSync(BLUEPRINTS_DIR).filter((f) => f.endsWith(".json")) : [];

test("藍圖庫:至少要有 50 份 AI 仿作用完整藍圖", () => {
  assert.ok(bpFiles.length >= 50, `目前只有 ${bpFiles.length} 份`);
});

for (const f of bpFiles) {
  test(`藍圖 ${f}:graphLint 全過+必要欄位齊全`, () => {
    const raw = JSON.parse(fs.readFileSync(path.join(BLUEPRINTS_DIR, f), "utf-8")) as {
      id?: string; name?: string; description?: string; category?: string; icon?: string;
      nodes?: WorkflowNode[]; edges?: WorkflowEdge[]; triggerParams?: ParamField[];
    };
    assert.ok(raw.id && raw.name && raw.description && raw.category && raw.icon, "id/name/description/category/icon 必填");
    assert.ok(Array.isArray(raw.nodes) && raw.nodes.length >= 2, "至少 2 個節點");
    const errors = lintGraph(raw.nodes!, raw.edges ?? []);
    assert.deepEqual(errors, [], `lint 沒過:\n${errors.join("\n")}`);
    const warns = lintVarRefWarnings(raw.nodes!, raw.edges ?? [], raw.triggerParams ?? []);
    assert.deepEqual(warns, [], `變數引用警告:\n${warns.join("\n")}`);
  });
}
