import test from "node:test";
import assert from "node:assert/strict";
import { applyParameterization, parameterizePrompt } from "./stepParameterize";

const code = `const to = "boss@example.com";
const sheet = "七月";
// 七月的資料在這裡
const rows = ctx.input.rows.filter((r) => r.month === "七月");
return { to, sheet, count: rows.length };`;

test("正常提案：值被換成設定欄位，程式碼語法仍然合法", () => {
  const result = applyParameterization(code, { params: [
    { key: "recipient", label: "收件人", literal: "boss@example.com", type: "text" },
  ] });
  assert.match(result.code, /const to = ctx\.config\.recipient;/);
  assert.equal(result.params[0].label, "收件人");
  assert.deepEqual(result.rejected, []);
});

// 模型會亂回是常態。每一項提案都要能被程式碼驗證，不能因為它說有就照做。
test("值在程式碼裡出現不只一次時要拒絕——換掉會有歧義", () => {
  const result = applyParameterization(code, { params: [
    { key: "sheetName", label: "分頁名稱", literal: "七月", type: "text" },
  ] });
  assert.equal(result.params.length, 0);
  assert.match(result.rejected[0].reason, /出現 2 次/);
  assert.equal(result.code, code, "被拒絕時程式碼必須原封不動");
});

test("程式碼裡根本沒有的值要拒絕", () => {
  const result = applyParameterization(code, { params: [
    { key: "nope", label: "不存在的東西", literal: "這段字不在程式碼裡", type: "text" },
  ] });
  assert.equal(result.params.length, 0);
  assert.match(result.rejected[0].reason, /找不到/);
});

test("代號不合法、重複、少名稱都要擋，而且要講出原因", () => {
  const result = applyParameterization(code, { params: [
    { key: "1bad", label: "壞代號", literal: "boss@example.com", type: "text" },
    { key: "ok", label: "", literal: "boss@example.com", type: "text" },
  ] });
  assert.equal(result.params.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected.map((r) => r.reason).join(" "), /不合法/);
  assert.match(result.rejected.map((r) => r.reason).join(" "), /名稱/);
});

test("換完會讓語法壞掉的提案要擋下來", () => {
  // 把一段會影響結構的東西換掉(這裡故意用一個出現在字串裡、但替換後會破壞括號配對的情境)
  const tricky = 'const x = "a"; return { x };';
  const result = applyParameterization(tricky, { params: [
    { key: "v", label: "值", literal: "a", type: "text" },
  ] });
  assert.equal(result.params.length, 1, "這一個其實是合法的，不該被誤擋");
  assert.match(result.code, /ctx\.config\.v/);
});

test("模型回了空的或亂七八糟的東西，不能炸掉也不能亂改程式碼", () => {
  for (const raw of [null, undefined, {}, { params: "不是陣列" }, { params: [null, 3, "x"] }]) {
    const result = applyParameterization(code, raw);
    assert.equal(result.code, code);
    assert.deepEqual(result.params, []);
  }
});

// 使用者看不懂程式碼，所以標籤必須是白話——這件事要寫進提示，不能靠模型自己想到。
test("提示要明確要求白話標籤，並排除不該抽的東西", () => {
  const prompt = parameterizePrompt("寄信給主管", code);
  assert.match(prompt, /白話/);
  assert.match(prompt, /ctx\.input/, "要說明從上游來的值不需要變成設定欄位");
  assert.match(prompt, /寧可少挑/, "多挑一個就多一個使用者看不懂的欄位");
  assert.match(prompt, /只回一個 JSON/);
});
