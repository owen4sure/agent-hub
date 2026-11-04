import assert from "node:assert/strict";
import test from "node:test";
import { deriveBranchScenarioPlan } from "./branchScenario";
import type { Workflow } from "./types";

const workflow = (node: Workflow["nodes"][number]): Workflow => ({
  id: "branch-test",
  name: "branch-test",
  status: "draft",
  builtin: false,
  defaultModel: "minimax-m3",
  triggerParams: [{ key: "amount", label: "金額", type: "number" }, { key: "kind", label: "類型", type: "text" }],
  nodes: [node],
  edges: [],
});

test("分支情境：條件判斷可為數字大小產生是/否輸入", () => {
  const wf = workflow({ id: "if", type: "if-condition", label: "金額超過門檻？", config: { left: "{{amount}}", op: ">", right: "100" }, position: { x: 0, y: 0 } });
  const yes = deriveBranchScenarioPlan(wf, { amount: 10 }, "if", "true");
  const no = deriveBranchScenarioPlan(wf, { amount: 10 }, "if", "false");
  assert.equal(yes.params.amount, "101");
  assert.equal(no.params.amount, "99");
  assert.match(yes.name, /是/);
});

test("分支情境：多路分流可逐一產生選項與其他出口", () => {
  const wf = workflow({ id: "switch", type: "switch", label: "分類", config: { value: "{{kind}}", cases: "請假\n報支" }, position: { x: 0, y: 0 } });
  const leave = deriveBranchScenarioPlan(wf, { kind: "其他" }, "switch", "請假");
  const other = deriveBranchScenarioPlan(wf, { kind: "請假" }, "switch", "其他");
  assert.equal(leave.params.kind, "請假");
  assert.equal(other.params.kind, "__agenthub_no_matching_case__");
});

test("分支情境：上游計算值不能被平台猜測", () => {
  const wf = workflow({ id: "if", type: "if-condition", label: "判斷", config: { left: "{{computed}}", op: "==", right: "yes" }, position: { x: 0, y: 0 } });
  assert.throws(() => deriveBranchScenarioPlan(wf, {}, "if", "true"), /不能安全猜測/);
});
