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

// 「=」既是 value=label 的分隔符、又是比較運算子的字面字元——切選項不能無腦 split("=")。
// 踩過:if-condition 的「==」被切成空字串,每個用比較運算子的條件節點都被誤判違規,
// 錯誤訊息還把切壞的清單(「、!、>、<」)餵回建圖 AI,AI 直接反問使用者選項是不是壞掉了。
test("validateConfigTypes：比較運算子選項(==/!=/>=/<=)不能被 value=label 切法切壞", () => {
  const opField: ParamField[] = [
    { key: "op", label: "比較", type: "select", options: ["==", "!=", ">", "<", ">=", "<=", "contains", "not-empty"], default: "==" },
  ];
  for (const op of ["==", "!=", ">=", "<=", ">", "<", "contains", "not-empty"]) {
    assert.deepEqual(validateConfigTypes("n1", { op }, opField), [], `op=${op} 應合法`);
  }
  const errs = validateConfigTypes("n1", { op: "===" }, opField);
  assert.equal(errs.length, 1);
  assert.ok(errs[0].includes("=="), "錯誤訊息要列出完整的「==」而不是切壞的空字串");
});

test("validateConfigTypes：value=label 格式的選項仍然只比對 value", () => {
  const f: ParamField[] = [{ key: "unit", label: "單位", type: "select", options: ["month=每月", "quarter=每季"], default: "month" }];
  assert.deepEqual(validateConfigTypes("n1", { unit: "month" }, f), []);
  assert.equal(validateConfigTypes("n1", { unit: "每月" }, f).length, 1);
});

// 可達性:模型漏接「解析→條件」的邊,條件節點變孤兒——比上游先跑、變數全拿不到、
// 永遠走 false 分支,整條流程「全綠但全錯」(實測踩過)。必須在建圖當下打回。
test("lintGraph：非 trigger 節點從 trigger 走不到 → 錯誤(孤兒節點)", () => {
  const nodes: WorkflowNode[] = [
    { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
    { id: "a", type: "template-text", label: "組字", config: {}, position: { x: 0, y: 0 } },
    { id: "b", type: "if-condition", label: "判斷", config: {}, position: { x: 0, y: 0 } },
  ];
  const edges: WorkflowEdge[] = [
    { from: "t", to: "a" },
    { from: "b", to: "a" }, // b 沒有任何進線 → 孤兒
  ];
  const errs = lintGraph(nodes, edges);
  assert.ok(errs.some((e) => e.includes('"b"') && e.includes("連過來")), JSON.stringify(errs));
  // 補上缺的邊就通過
  assert.deepEqual(lintGraph(nodes, [...edges, { from: "a", to: "b" }]).filter((e) => e.includes("連過來")), []);
});

// {{節點id.欄位}} 是模型發明的假語法(資料模型是扁平的)——執行期靜默解析失敗,建圖時就要攔。
// {{period.start}}/{{item.x}} 合法(period/item 不是節點 id)。
test("lintGraph：{{節點id.欄位}} 引用 → 錯誤;period/item 前綴不受影響", () => {
  const nodes: WorkflowNode[] = [
    { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
    { id: "parse", type: "llm-decide", label: "解析", config: { prompt: "x", outputKey: "result" }, position: { x: 0, y: 0 } },
    { id: "chk", type: "if-condition", label: "判斷", config: { left: "{{parse.result}}", op: "==", right: "請假" }, position: { x: 0, y: 0 } },
    { id: "w", type: "write-file", label: "寫", config: { fileName: "a.txt", content: "{{period.start}} {{item.name}}" }, position: { x: 0, y: 0 } },
  ];
  const edges: WorkflowEdge[] = [
    { from: "t", to: "parse" },
    { from: "parse", to: "chk" },
    { from: "chk", to: "w" },
  ];
  const errs = lintGraph(nodes, edges);
  assert.ok(errs.some((e) => e.includes("{{parse.result}}") && e.includes("{{result}}")), JSON.stringify(errs));
  assert.ok(!errs.some((e) => e.includes("period") || e.includes("item")), "period/item 前綴不能被誤殺");
});

/* ---------- 多路分流(switch)/等人簽核/失敗分支的連線規則 ---------- */

test("lintGraph：switch 的出線沒標 fromPort 要報錯並列出合法值", () => {
  const nodes = [node("n1", "trigger"), node("sw", "switch", { value: "{{category}}", cases: "請假\n報支" }), node("a", "custom-code", { intent: "x" })];
  const errors = lintGraph(nodes, [{ from: "n1", to: "sw" }, { from: "sw", to: "a" }]);
  assert.ok(errors.some((e) => e.includes("沒有標 fromPort") && e.includes("請假") && e.includes("其他")));
});

test("lintGraph：switch 的出線標了不在選項裡的 fromPort 要報錯", () => {
  const nodes = [node("n1", "trigger"), node("sw", "switch", { value: "{{category}}", cases: "請假,報支" }), node("a", "custom-code", { intent: "x" })];
  const errors = lintGraph(nodes, [{ from: "n1", to: "sw" }, { from: "sw", to: "a", fromPort: "加班" }]);
  assert.ok(errors.some((e) => e.includes("加班") && e.includes("沒有這一路")));
});

test("lintGraph：switch 出線標對選項(含「其他」)就通過；cases 空要報錯", () => {
  const nodes = [node("n1", "trigger"), node("sw", "switch", { value: "{{c}}", cases: "請假,報支" }), node("a", "custom-code", { intent: "x" }), node("b", "custom-code", { intent: "y" })];
  const ok = lintGraph(nodes, [{ from: "n1", to: "sw" }, { from: "sw", to: "a", fromPort: "請假" }, { from: "sw", to: "b", fromPort: "其他" }]);
  assert.deepEqual(ok, []);
  const empty = lintGraph([node("n1", "trigger"), node("sw", "switch", { value: "x", cases: "" })], [{ from: "n1", to: "sw" }]);
  assert.ok(empty.some((e) => e.includes("分流選項") && e.includes("空")));
});

test("lintGraph：wait-approval 出線的 fromPort 只能是 approved/rejected，且至少要接 approved", () => {
  const nodes = [node("n1", "trigger"), node("ap", "wait-approval", { message: "准嗎" }), node("a", "custom-code", { intent: "x" })];
  const wrongPort = lintGraph(nodes, [{ from: "n1", to: "ap" }, { from: "ap", to: "a", fromPort: "true" }]);
  assert.ok(wrongPort.some((e) => e.includes("approved") && e.includes("rejected")));
  const noApproved = lintGraph(nodes, [{ from: "n1", to: "ap" }, { from: "ap", to: "a", fromPort: "rejected" }]);
  assert.ok(noApproved.some((e) => e.includes("沒有接") && e.includes("approved")));
  const ok = lintGraph(nodes, [{ from: "n1", to: "ap" }, { from: "ap", to: "a", fromPort: "approved" }]);
  assert.deepEqual(ok, []);
});

test("lintGraph：從 trigger 拉 fromPort=error 的失敗分支要報錯；從一般節點拉合法", () => {
  const nodes = [node("n1", "trigger"), node("w", "web-page", { url: "https://example.com" }), node("alert", "desktop-notify", {})];
  const fromTrigger = lintGraph(nodes, [{ from: "n1", to: "w" }, { from: "n1", to: "alert", fromPort: "error" }]);
  assert.ok(fromTrigger.some((e) => e.includes("觸發節點不會失敗")));
  const ok = lintGraph(nodes, [{ from: "n1", to: "w" }, { from: "w", to: "alert", fromPort: "error" }]);
  assert.deepEqual(ok, []);
});

test("lintGraph：repeat-steps 的內嵌步驟裡放 wait-approval 要報錯", () => {
  const steps = JSON.stringify([{ type: "wait-approval", config: { message: "准嗎" } }]);
  const nodes = [node("n1", "trigger"), node("rp", "repeat-steps", { items: "{{list}}", steps })];
  const errors = lintGraph(nodes, [{ from: "n1", to: "rp" }]);
  assert.ok(errors.some((e) => e.includes("迴圈") && e.includes("簽核")));
});
