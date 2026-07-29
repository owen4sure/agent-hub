import test from "node:test";
import assert from "node:assert/strict";
import { deleteUserStep, expandUserStep, listUserSteps, parseUserFields, saveUserStep, validateUserStep } from "./userSteps";

const base = {
  name: "用網頁信箱寄信",
  description: "在已登入的信箱寫一封信並寄出",
  intent: "寄信",
  code: 'const to = ctx.config.recipient; return { to };',
  params: [{ key: "recipient", label: "收件人", type: "text" as const, default: "boss@example.com" }],
};

// 使用者原話：「我要的就是能夠讓使用者做出現成沒有的節點功能，並且能重複套用」。
test("存下來的步驟可以展開成一個真正能用的節點設定", () => {
  const step = saveUserStep({ ...base });
  try {
    const node = expandUserStep(step);
    assert.equal(node.type, "custom-code", "刻意展開成既有型別——新增型別會繞過一整排以型別為鍵的安全防線");
    assert.equal(node.label, "用網頁信箱寄信");
    assert.equal(node.config.code, base.code);
    assert.equal(node.config.recipient, "boss@example.com", "參數的預設值要帶進去");
    assert.deepEqual(parseUserFields(node.config.userFields), base.params, "設定欄位宣告要跟著節點走，面板才長得出來");
  } finally { deleteUserStep(step.id); }
});

test("存了就找得到，刪了就不見", () => {
  const step = saveUserStep({ ...base, name: "測試用步驟" });
  assert.ok(listUserSteps().some((s) => s.id === step.id));
  assert.equal(deleteUserStep(step.id), true);
  assert.ok(!listUserSteps().some((s) => s.id === step.id));
});

// 宣告了卻沒被用到的欄位是最難查的那種「設定沒作用」：使用者填了、以為會生效、實際什麼都沒發生。
test("宣告了但程式碼沒用到的欄位要擋下來", () => {
  const problems = validateUserStep({ ...base, params: [{ key: "unused", label: "沒人用的欄位", type: "text" }] });
  assert.ok(problems.some((p) => /沒有被用到/.test(p)), problems.join("；"));
});

test("沒名稱、沒程式碼、代號不合法、代號重複都要擋", () => {
  assert.ok(validateUserStep({ ...base, name: "" }).some((p) => /名稱/.test(p)));
  assert.ok(validateUserStep({ ...base, code: "" }).some((p) => /程式碼/.test(p)));
  assert.ok(validateUserStep({ ...base, params: [{ key: "1bad", label: "x", type: "text" }] }).some((p) => /不合法/.test(p)));
  assert.ok(validateUserStep({
    ...base,
    code: "return { a: ctx.config.dup };",
    params: [{ key: "dup", label: "一", type: "text" }, { key: "dup", label: "二", type: "text" }],
  }).some((p) => /重複/.test(p)));
});

test("壞掉的欄位宣告不能讓整個面板打不開", () => {
  assert.deepEqual(parseUserFields("不是 JSON"), []);
  assert.deepEqual(parseUserFields(JSON.stringify({ notAnArray: true })), []);
  assert.deepEqual(parseUserFields(JSON.stringify([{ key: "1bad", label: "x" }])), [], "不合法的代號要濾掉");
});

// 這是「我的步驟」最容易被無聲破壞的地方：AI 修改節點時會依型別的 schema 過濾設定欄位，
// 而使用者自訂的欄位不在那份 schema 裡——不放行的話，AI 改過一次，使用者親手填的收件人/網址
// 就會被整批清掉，而且畫面上只會看到欄位默默消失，沒有任何錯誤訊息。
test("AI 修改這個節點時，不能清掉使用者自訂的設定欄位", async () => {
  const { createWorkflow, saveWorkflow, getWorkflow, deleteWorkflow } = await import("./store");
  const { applyNodeConfigEdits } = await import("./graphRepair");
  const step = saveUserStep({ ...base, name: `AI 修改測試 ${Date.now()}` });
  const workflow = createWorkflow(`zz-userstep-airepair-${Date.now()}`);
  try {
    const expanded = expandUserStep(step);
    saveWorkflow({
      ...workflow,
      nodes: [
        { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "us", type: expanded.type, label: expanded.label, config: expanded.config, position: { x: 300, y: 0 } },
      ],
      edges: [{ from: "t", to: "us" }],
    });
    applyNodeConfigEdits(workflow.id, [{ nodeId: "us", config: { intent: "AI 改過的說明" } }]);
    const after = getWorkflow(workflow.id)!.nodes.find((node) => node.id === "us")!;
    assert.equal(after.config.recipient, "boss@example.com", "使用者填的值不能被清掉");
    assert.deepEqual(parseUserFields(after.config.userFields), base.params, "欄位宣告不能被清掉，否則面板就長不出欄位了");
  } finally {
    deleteWorkflow(workflow.id);
    deleteUserStep(step.id);
  }
});
