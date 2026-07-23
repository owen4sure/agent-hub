import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCustomCodeOutput, assertRunnableGraph, hasExecutableSteps, lintGraph, lintVarRefWarnings, validateConfigTypes, withSchemaDefaults } from "./graphLint";
import { plainChatMessage } from "./plainLanguage";
import type { WorkflowNode, WorkflowEdge, ParamField } from "./types";

function node(id: string, type: string, config: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, label: id, config, position: { x: 0, y: 0 } };
}

// 2026-07 第三輪外部審查抓到的 P1：custom-code 節點沒有可驗證的輸出契約，下游引用不存在的欄位
// 完全不會被抓到(全綠但語意錯誤)。analyzeCustomCodeOutput 對已產生的程式碼做輕量靜態掃描，
// 抽出 return{...} 物件字面量裡明確具名的欄位——不執行程式碼，只在「有把握」時給出結果。
test("analyzeCustomCodeOutput：抽出明確新欄位，展開(...ctx.input 或其他)不算欄位名", () => {
  const result = analyzeCustomCodeOutput("const x = 1;\nreturn { ...ctx.input, monthlyTotal: x, note: '備註' };");
  assert.ok(result);
  assert.deepEqual(result!.declaredFields.sort(), ["monthlyTotal", "note"]);
});

test("analyzeCustomCodeOutput：沒有展開時，一樣正確抽出明確列出的欄位", () => {
  const result = analyzeCustomCodeOutput("return { total: 100, label: 'x' };");
  assert.ok(result);
  assert.deepEqual(result!.declaredFields.sort(), ["label", "total"]);
});

test("analyzeCustomCodeOutput：巢狀物件、字串裡的逗號/大括號不會把巢狀鍵誤判成頂層欄位", () => {
  const result = analyzeCustomCodeOutput(
    "return { summary: { a: 1, b: 2 }, note: 'a, b, {c}', total: 3 };",
  );
  assert.ok(result);
  assert.deepEqual(result!.declaredFields.sort(), ["note", "summary", "total"]);
});

// 第四輪外部審查抓到的真實bug：計算鍵的實際欄位名執行期才知道，以前只是「跳過不算」，
// 等於默默宣稱「這個節點只有 fixedField 這個欄位」——下游若真的引用了計算鍵實際算出的欄位名，
// 會被誤判成不存在。計算鍵代表這個節點的輸出形狀本來就無法靜態確定，整體要回傳 null，
// 不能只跳過那一項、假裝其餘欄位清單仍然完整可信。
test("analyzeCustomCodeOutput：含計算鍵([x]: y)代表輸出形狀無法靜態確定，整體回傳 null(不能假裝其餘欄位清單完整)", () => {
  const result = analyzeCustomCodeOutput("const key = 'x';\nreturn { ...ctx.input, [key]: 1, fixedField: 2 };");
  assert.equal(result, null);
});

// 第四輪外部審查抓到的真實bug：展開一個「本地變數」(而非 ctx.input)時，那個變數實際有哪些
// 欄位無從得知，以前當成「沒有新增欄位」處理，等於假裝這個節點只沿用上游、沒有任何新增——
// 下游若真的引用了 out 裡的欄位(如 {{answer}})，會被誤判成不存在。這種情況要老實承認
// 分析不出來、回傳 null，而不是自信地宣稱一份不完整的清單。
test("analyzeCustomCodeOutput：展開 ctx.input 以外的未知來源(本地變數)時，整體形狀無法確定，回傳 null", () => {
  const result = analyzeCustomCodeOutput("const out = { answer: 1 };\nreturn { ...out };");
  assert.equal(result, null);
});

test("analyzeCustomCodeOutput：多個 return 是所有分支的聯集，不只看最後一個(避免漏掉早期分支的合法輸出)", () => {
  const result = analyzeCustomCodeOutput("if (!ok) return { error: 'x' };\nreturn { ...ctx.input, result: 1 };");
  assert.ok(result);
  assert.deepEqual(result!.declaredFields.sort(), ["error", "result"]);
});

// 真實踩過的雷(對照一條真實生產流程跑出來的假警告才發現)：JS 識別字合法包含中文字，這個
// codebase 的 custom-code 大量用中文欄位名當簡寫屬性(`return { A通路週, B通路週, C通路週 }`)。
// 若只認 ASCII 字元，「A通路週」會在「通」被截斷成「A」，導致「A通路週」「A通路月累計」
// 「A通路上月餘額」全部被誤判成同一個欄位「A」，其餘中文欄位名整個消失。
test("analyzeCustomCodeOutput：中文欄位名(含簡寫屬性)要完整保留，不能在非 ASCII 字元被截斷", () => {
  const result = analyzeCustomCodeOutput(
    "const A通路週 = 1, B通路週 = 2, A通路月累計 = 3;\nreturn { A通路週, B通路週, A通路月累計 };",
  );
  assert.ok(result);
  assert.deepEqual(result!.declaredFields.sort(), ["A通路月累計", "A通路週", "B通路週"].sort());
});

test("analyzeCustomCodeOutput：找不到 return{ 或括號沒配對時回傳 null，維持保守放行", () => {
  assert.equal(analyzeCustomCodeOutput("throw new Error('永遠失敗');"), null);
  assert.equal(analyzeCustomCodeOutput("return { broken: "), null);
  // 直接 return 一個裸識別字(不是物件字面量)同樣無法靜態知道它有哪些欄位
  assert.equal(analyzeCustomCodeOutput("const out = { answer: 1 };\nreturn out;"), null);
});

test("lintVarRefWarnings：custom-code 可以靜態分析時，下游能引用它自己上游的欄位；引用真的不存在的欄位要警告", () => {
  const nodes = [
    node("trigger", "trigger"),
    node("calc", "custom-code", { intent: "算總額", code: "return { ...ctx.input, monthlyTotal: 100 };" }),
    node("notify", "notify", { message: "{{monthlyTotal}} 跟 {{filePath}}" }),
  ];
  const edges: WorkflowEdge[] = [{ from: "trigger", to: "calc" }, { from: "calc", to: "notify" }];
  // filePath 是 trigger 節點的事實變數(監聽觸發會注入)，經過有展開的 custom-code 應該還在可用集合裡
  assert.deepEqual(lintVarRefWarnings(nodes, edges, []), []);

  const badNodes = [
    node("trigger", "trigger"),
    node("calc", "custom-code", { intent: "算總額", code: "return { ...ctx.input, monthlyTotal: 100 };" }),
    node("notify", "notify", { message: "{{typoField}}" }),
  ];
  const warnings = lintVarRefWarnings(badNodes, edges, []);
  assert.equal(warnings.length, 1, "以前上游有 custom-code 就整個放棄檢查，現在能靜態分析時要抓出真的不存在的欄位");
});

// engine.ts 執行期一律 nodeOutputs.set(node.id, {...input, ...result.output})，不管 custom-code
// 自己的 return 裡有沒有寫 ...ctx.input，上游欄位都會沿用不遺失——靜態分析要跟這個真實行為一致，
// 不能只因為程式碼「看起來」沒展開，就誤判上游欄位在這裡被截斷(這是修這個功能過程中真的踩到、
// 靠對照真實生產流程 wf-917a7777-copy-523d71-copy-9cad26 的執行語意才發現並修正的錯誤設計)。
test("lintVarRefWarnings：custom-code 的程式碼即使沒寫 ...ctx.input，上游(更早)的欄位仍會沿用(對應引擎的合併語意)", () => {
  const nodes = [
    node("trigger", "trigger"),
    node("sheet", "google-sheet-read", { sheetUrl: "https://x" }),
    node("calc", "custom-code", { intent: "只回總額", code: "return { total: 100 };" }),
    node("notify", "notify", { message: "{{rows}}" }), // rows 是 sheet 節點的輸出，engine.ts 會讓它沿用到 calc 之後
  ];
  const edges: WorkflowEdge[] = [{ from: "trigger", to: "sheet" }, { from: "sheet", to: "calc" }, { from: "calc", to: "notify" }];
  assert.deepEqual(lintVarRefWarnings(nodes, edges, []), []);
});

test("lintVarRefWarnings：custom-code 的程式碼靜態分析不出來時，維持原本『無法列舉就不擋』的行為", () => {
  const nodes = [
    node("trigger", "trigger"),
    node("calc", "custom-code", { intent: "動態產生", code: "throw new Error('尚未實作');" }),
    node("notify", "notify", { message: "{{anythingGoes}}" }),
  ];
  const edges: WorkflowEdge[] = [{ from: "trigger", to: "calc" }, { from: "calc", to: "notify" }];
  assert.deepEqual(lintVarRefWarnings(nodes, edges, []), []);
});

test("lintGraph：合法的最小圖(trigger + custom-code)沒有錯誤", () => {
  const nodes = [node("n1", "trigger"), node("n2", "custom-code", { intent: "test" })];
  const edges: WorkflowEdge[] = [{ from: "n1", to: "n2" }];
  assert.deepEqual(lintGraph(nodes, edges), []);
});

test("lintVarRefWarnings：欄位不存在的警告訊息經過白話過濾後，不同的上游欄位名不能被壓成同一句看不出差異的話", () => {
  // 真實踩過的 bug：LINE 觸發流程裡 userId/replyToken 這兩個不同的觸發參數，被 plainChatMessage
  // 一起壓成同一句「前面步驟提供的資料」，使用者(或AI自己)完全看不出這則警告到底在講哪個欄位缺漏。
  const triggerParams: ParamField[] = [
    { key: "userId", label: "傳訊者", type: "text" },
    { key: "replyToken", label: "回覆用token", type: "text" },
  ];
  const nodes = [
    node("trigger", "trigger"),
    node("reply", "custom-code", { intent: "回覆", headers: "{{typoField}}" }),
  ];
  const edges: WorkflowEdge[] = [{ from: "trigger", to: "reply" }];
  const warnings = lintVarRefWarnings(nodes, edges, triggerParams);
  assert.equal(warnings.length, 1);
  const rendered = plainChatMessage(warnings[0]);
  assert.match(rendered, /「userId」/, "userId 這個欄位名要在白話訊息裡保持看得出來");
  assert.match(rendered, /「replyToken」/, "replyToken 這個欄位名要在白話訊息裡保持看得出來，且要跟 userId 不一樣");
  // 兩個不同欄位轉換後的文字不能相等——這才是真正在防的事：不同東西不能看起來一樣
  const userIdPhrase = rendered.match(/「userId」[^、）。]*/)?.[0];
  const replyTokenPhrase = rendered.match(/「replyToken」[^、）。]*/)?.[0];
  assert.ok(userIdPhrase && replyTokenPhrase && userIdPhrase !== replyTokenPhrase);
});

test("hasExecutableSteps：空白草稿可保存但不能被當成可執行流程", () => {
  assert.equal(hasExecutableSteps([node("trigger", "trigger")]), false);
  assert.equal(hasExecutableSteps([node("trigger", "trigger"), node("n1", "template-text", { template: "內容" })]), true);
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

test("lintGraph：只能有一個 trigger，重複連線也要拒絕", () => {
  const nodes = [node("t1", "trigger"), node("t2", "trigger"), node("n", "custom-code", { intent: "x" })];
  const edge = { from: "t1", to: "n" };
  const errors = lintGraph(nodes, [edge, edge]);
  assert.ok(errors.some((e) => e.includes("2 個觸發節點")), JSON.stringify(errors));
  assert.ok(errors.some((e) => e.includes("重複了")), JSON.stringify(errors));
});

test("lintGraph：if-condition 出線必須標 true/false/error，一般節點不能發明分支 port", () => {
  const nodes = [
    node("t", "trigger"),
    node("if", "if-condition", { left: "1", op: "==", right: "1" }),
    node("a", "custom-code", { intent: "x" }),
  ];
  const missing = lintGraph(nodes, [{ from: "t", to: "if" }, { from: "if", to: "a" }]);
  assert.ok(missing.some((e) => e.includes("必須標") && e.includes("true")), JSON.stringify(missing));
  assert.deepEqual(lintGraph(nodes, [{ from: "t", to: "if" }, { from: "if", to: "a", fromPort: "true" }]), []);
  const invented = lintGraph(
    [node("t", "trigger"), node("a", "custom-code", { intent: "x" }), node("b", "custom-code", { intent: "y" })],
    [{ from: "t", to: "a" }, { from: "a", to: "b", fromPort: "maybe" }],
  );
  assert.ok(invented.some((e) => e.includes("不是分支節點")), JSON.stringify(invented));
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
// {{period.start}} 只能放 triggerParams derived default；節點 config 直接用不會解析。{{item.x}} 才是合法例外。
test("lintGraph：攔截節點id.欄位與節點內的 period.*；item 前綴保留", () => {
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
  assert.ok(errs.some((e) => e.includes("period.*") && e.includes("filterStart")), JSON.stringify(errs));
  assert.ok(!errs.some((e) => e.includes("item")), "repeat-steps 的 item 前綴不能被誤殺");
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

test("lintGraph：repeat-steps 會拒絕壞 JSON、未知內嵌型別與非法內嵌 config", () => {
  const trigger = node("t", "trigger");
  const badJson = { ...node("r", "repeat-steps"), config: { items: "[1]", steps: "not-json", outputKey: "results" } };
  assert.ok(lintGraph([trigger, badJson], [{ from: "t", to: "r" }]).some((e) => e.includes("合法 JSON")));

  const badSteps = {
    ...node("r", "repeat-steps"),
    config: { items: "[1]", steps: JSON.stringify([{ type: "not-real", config: {} }, { type: "wait", config: { seconds: "很多" } }]), outputKey: "results" },
  };
  const errors = lintGraph([trigger, badSteps], [{ from: "t", to: "r" }]);
  assert.ok(errors.some((e) => e.includes("not-real")));
  assert.ok(errors.some((e) => e.includes("型別是 number")));
});

test("lintVarRefWarnings:收信觸發有開 → {{body}}/{{subject}} 是合法上游欄位;沒開就警告", () => {
  const edges: WorkflowEdge[] = [{ from: "n1", to: "n2" }];
  const refBody = [node("n1", "trigger", { mailWatch: "on" }), node("n2", "write-file", { content: "{{body}}", filename: "{{subject}}.txt" })];
  assert.deepEqual(lintVarRefWarnings(refBody, edges, []), []);
  const noMail = [node("n1", "trigger"), node("n2", "write-file", { content: "{{body}}", filename: "a.txt" })];
  assert.ok(lintVarRefWarnings(noMail, edges, []).length > 0);
});

test("lintVarRefWarnings:Telegram/LINE 觸發有開 → {{message}} 合法;沒開就警告", () => {
  const edges: WorkflowEdge[] = [{ from: "n1", to: "n2" }];
  const tg = [node("n1", "trigger", { telegramWatch: "on" }), node("n2", "write-file", { content: "{{message}} - {{fromName}}", filename: "a.txt" })];
  assert.deepEqual(lintVarRefWarnings(tg, edges, []), []);
  const line = [node("n1", "trigger", { lineWatch: "on" }), node("n2", "write-file", { content: "{{message}}", filename: "a.txt" })];
  assert.deepEqual(lintVarRefWarnings(line, edges, []), []);
  const off = [node("n1", "trigger"), node("n2", "write-file", { content: "{{message}}", filename: "a.txt" })];
  assert.ok(lintVarRefWarnings(off, edges, []).length > 0);
});

test("lintVarRefWarnings:Webhook 明講的外部 JSON 欄位可引用，未宣告拼錯字仍警告", () => {
  const nodes = [node("t", "trigger"), node("ai", "llm-decide", { prompt: "分類 {{message}}" })];
  const edges: WorkflowEdge[] = [{ from: "t", to: "ai" }];
  assert.deepEqual(lintVarRefWarnings(nodes, edges, [], ["message"]), []);
  assert.ok(lintVarRefWarnings(nodes, edges, [], ["massage"]).length > 0);
});

test("執行前安全閘門：合法圖放行，有環或孤兒節點就拒絕而不是硬跑", () => {
  const valid = [node("t", "trigger"), node("n", "custom-code", { intent: "整理輸入資料" })];
  assert.doesNotThrow(() => assertRunnableGraph(valid, [{ from: "t", to: "n" }]));

  const invalid = [...valid, node("orphan", "custom-code", { intent: "不應被執行" })];
  assert.throws(
    () => assertRunnableGraph(invalid, [{ from: "t", to: "n" }, { from: "n", to: "t" }]),
    /不能安全執行[\s\S]*(有環|沒有從觸發節點)/,
  );
});
