import { test } from "node:test";
import assert from "node:assert/strict";
import { lintGraph, validateConfigTypes, withSchemaDefaults } from "./graphLint";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, label: id, config, position: { x: 0, y: 0 } };
}

test("lintGraph：合法的最小圖(trigger + custom-code)沒有錯誤", () => {
  const nodes = [node("n1", "trigger"), node("n2", "custom-code", { intent: "test" })];
  const edges: WorkflowEdge[] = [{ from: "n1", to: "n2" }];
  assert.deepEqual(lintGraph(nodes, edges), []);
});

test("lintGraph：沒有 trigger 節點要報錯", () => {
  const nodes = [node("n1", "custom-code")];
  const errors = lintGraph(nodes, []);
  assert.ok(errors.some((e) => e.includes("trigger")));
});

test("lintGraph：不存在的節點型別要報錯，且給出接近的建議", () => {
  const nodes = [node("n1", "trigger"), node("n2", "custom_code")]; // 底線打錯(該用連字號)
  const errors = lintGraph(nodes, [{ from: "n1", to: "n2" }]);
  assert.ok(errors.some((e) => e.includes("custom_code") && e.includes("custom-code")));
});

test("lintGraph：連線指向不存在的節點要報錯", () => {
  const nodes = [node("n1", "trigger")];
  const errors = lintGraph(nodes, [{ from: "n1", to: "n2" }]);
  assert.ok(errors.some((e) => e.includes("n2")));
});

test("lintGraph：重複的節點 id 要報錯", () => {
  const nodes = [node("n1", "trigger"), node("n1", "custom-code")];
  const errors = lintGraph(nodes, []);
  assert.ok(errors.some((e) => e.includes("重複")));
});

test("lintGraph：圖裡有環要報錯", () => {
  const nodes = [node("n1", "trigger"), node("n2", "custom-code"), node("n3", "custom-code")];
  const edges: WorkflowEdge[] = [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n2" }];
  const errors = lintGraph(nodes, edges);
  assert.ok(errors.some((e) => e.includes("環")));
});

const numberField: ParamField[] = [{ key: "col", label: "欄位位置", type: "number" }];

test("validateConfigTypes：number 欄位填文字要報錯", () => {
  const errors = validateConfigTypes("n1", { col: "第三欄" }, numberField);
  assert.equal(errors.length, 1);
});

test("validateConfigTypes：number 欄位填數字字串是合法的", () => {
  assert.deepEqual(validateConfigTypes("n1", { col: "3" }, numberField), []);
});

test("validateConfigTypes：空值走預設，不報錯", () => {
  assert.deepEqual(validateConfigTypes("n1", {}, numberField), []);
});

test("validateConfigTypes：值裡含 {{模板}} 留給執行期解析，不在這裡判", () => {
  assert.deepEqual(validateConfigTypes("n1", { col: "{{colIndex}}" }, numberField), []);
});

const selectField: ParamField[] = [{ key: "mode", label: "模式", type: "select", options: ["a=A模式", "b=B模式"] }];

test("validateConfigTypes：select 欄位只能填選項之一", () => {
  assert.deepEqual(validateConfigTypes("n1", { mode: "a" }, selectField), []);
  assert.equal(validateConfigTypes("n1", { mode: "z" }, selectField).length, 1);
});

test("withSchemaDefaults：缺少的欄位補上預設值", () => {
  const schema: ParamField[] = [{ key: "x", label: "X", type: "text", default: "abc" }];
  assert.deepEqual(withSchemaDefaults({}, schema), { x: "abc" });
});

// allowEmpty 語意：這是「(空)→(空)」假修改事件修好的地方——明確清空的欄位不能被無聲補回預設值
test("withSchemaDefaults：allowEmpty 欄位明確清空時不補回預設值", () => {
  const schema: ParamField[] = [{ key: "x", label: "X", type: "text", default: "abc", allowEmpty: true }];
  assert.deepEqual(withSchemaDefaults({ x: "" }, schema), { x: "" });
});

test("withSchemaDefaults：非 allowEmpty 欄位空字串仍視為未設定，補回預設值", () => {
  const schema: ParamField[] = [{ key: "x", label: "X", type: "text", default: "abc" }];
  assert.deepEqual(withSchemaDefaults({ x: "" }, schema), { x: "abc" });
});
