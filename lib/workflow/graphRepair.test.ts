import test from "node:test";
import assert from "node:assert/strict";
import { applyNodeConfigEdits } from "./graphRepair";
import { createWorkflow, deleteWorkflow, getWorkflow } from "./store";
import { saveWorkflow } from "./store";

test("對話新增執行欄位：欄位與節點修改同一次存檔；任一 edit 無效就整組不套", () => {
  const workflow = createWorkflow(`test-params-${Date.now()}`);
  try {
    const params = [
      { key: "rangeStart", label: "開始日期", type: "date-or-token" as const },
      { key: "rangeEnd", label: "結束日期", type: "date-or-token" as const },
    ];
    const rejected = applyNodeConfigEdits(workflow.id, [
      { nodeId: "does-not-exist", config: { value: "{{rangeStart}}" } },
    ], { triggerParams: params });
    assert.equal(rejected.triggerParamsChanged, false);
    assert.deepEqual(getWorkflow(workflow.id)?.triggerParams, []);

    const applied = applyNodeConfigEdits(workflow.id, [], { triggerParams: params });
    assert.equal(applied.triggerParamsChanged, true);
    assert.deepEqual(getWorkflow(workflow.id)?.triggerParams, params);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("AI 修改 custom-code：語法錯誤不存，也不能把上游試算表資料解析退化成瀏覽器操作", () => {
  const workflow = createWorkflow(`test-code-guard-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [
        { id: "read", type: "google-sheet-read", label: "讀表", config: { sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit" }, position: { x: 0, y: 0 } },
        { id: "parse", type: "custom-code", label: "解析", config: { intent: "解析上游", code: "return { ...ctx.input, value: 1 };" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ from: "read", to: "parse" }],
    });

    const syntax = applyNodeConfigEdits(workflow.id, [{ nodeId: "parse", config: { code: "return {" } }]);
    assert.equal(syntax.edits.length, 0);
    assert.match(syntax.skipped[0]?.reason ?? "", /語法錯誤/);

    const browserRegression = applyNodeConfigEdits(workflow.id, [{
      nodeId: "parse",
      config: { code: "const page = await ctx.session.getPage(); return { ...ctx.input, title: await page.title() };" },
    }]);
    assert.equal(browserRegression.edits.length, 0);
    assert.match(browserRegression.skipped[0]?.reason ?? "", /不能把原本的資料解析改成操作瀏覽器/);
    assert.equal(getWorkflow(workflow.id)?.nodes.find((node) => node.id === "parse")?.config.code, "return { ...ctx.input, value: 1 };");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("AI 修改目的地設定時同步節點用途名稱，不讓名稱與內容互相矛盾", () => {
  const workflow = createWorkflow(`test-label-sync-${Date.now()}`);
  try {
    saveWorkflow({
      ...workflow,
      nodes: [{
        id: "read",
        type: "google-sheet-read",
        label: "讀月報週會週期欄",
        config: {
          sheetUrl: "https://docs.google.com/spreadsheets/d/test/edit",
          sheetName: "每週業績折線圖_月報週會",
        },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    });

    const result = applyNodeConfigEdits(workflow.id, [{
      nodeId: "read",
      config: { sheetName: "每週業績折線圖_業務週會" },
    }]);
    assert.equal(result.edits[0]?.nodeLabel, "讀業務週會週期欄");
    const saved = getWorkflow(workflow.id)?.nodes[0];
    assert.equal(saved?.label, "讀業務週會週期欄");
    assert.equal(saved?.config.sheetName, "每週業績折線圖_業務週會");
  } finally {
    deleteWorkflow(workflow.id);
  }
});
