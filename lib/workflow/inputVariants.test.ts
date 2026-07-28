import assert from "node:assert/strict";
import test from "node:test";
import { deriveInputVariantPlans, findInputVariantPlan } from "./inputVariants";
import type { Workflow } from "./types";

const workflow: Workflow = {
  id: "variant-test",
  name: "variant-test",
  status: "draft",
  builtin: false,
  defaultModel: "minimax-m3",
  triggerParams: [
    { key: "kind", label: "案件類型", type: "select", options: ["leave=請假", "expense=報支"] },
    { key: "urgent", label: "是否急件", type: "boolean" },
    { key: "note", label: "備註", type: "text" },
    { key: "period", label: "期間", type: "text", derived: true },
  ],
  nodes: [],
  edges: [],
};

test("輸入情境矩陣：只產生明確宣告的 select/boolean 變體", () => {
  const plans = deriveInputVariantPlans(workflow, { kind: "leave", urgent: "true", note: "保留" });
  assert.deepEqual(plans.map((plan) => [plan.key, plan.value]), [["kind", "expense"], ["urgent", "false"]]);
  assert.equal(plans[0].params.note, "保留");
  assert.equal(plans[0].params.period, undefined);
});

test("輸入情境矩陣：API 只能接受目前基準可推導的選項", () => {
  assert.equal(findInputVariantPlan(workflow, { kind: "leave", urgent: "true" }, "kind", "expense")?.valueLabel, "報支");
  assert.equal(findInputVariantPlan(workflow, { kind: "leave", urgent: "true" }, "kind", "unknown"), null);
});
