import test from "node:test";
import assert from "node:assert/strict";
import { checkVisionAnswer, makeVisionProbe } from "./modelVisionProbe";

/**
 * 這個測試釘住的是一條「用實測取代猜測」的產品規則。
 * 最重要的是第三條：這個專案自己記錄過有模型**不會說「我看不到」，而是自信地亂講**——
 * 那種模型如果被標成「看得懂圖片」，之後會在驗證碼與截圖判讀上編造答案而且不會報錯。
 */

test("測試圖真的產得出來，而且答案每次不一樣(不能被猜到)", async () => {
  const a = await makeVisionProbe();
  const b = await makeVisionProbe();
  assert.ok(a && b, "這台機器要能產生測試圖");
  assert.equal(a!.expected.length, 4);
  assert.ok(a!.imageBase64.length > 500, "PNG 要有實際內容");
  // 理論上有 1/27^4 機率相同，但連續兩次都一樣幾乎不可能——這條在擋「回傳固定圖」的實作錯誤
  assert.notEqual(a!.expected, b!.expected);
  // 排除容易混淆的字元(0/O、1/I/L)：測的是看不看得到，不是認不認得出模糊字
  assert.doesNotMatch(a!.expected, /[01OIL]/);
});

test("答對就算通過(容忍它多講幾個字或加標點)", () => {
  assert.equal(checkVisionAnswer("K7QM", "K7QM").ok, true);
  assert.equal(checkVisionAnswer("圖片上的字元是：K-7-Q-M", "K7QM").ok, true);
  assert.equal(checkVisionAnswer("k7qm", "K7QM").ok, true);
});

test("**自信地答錯**要被明確標成危險，不能只說「測試失敗」", () => {
  const verdict = checkVisionAnswer("這是一張藍色的風景照片", "K7QM");
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /答錯了但講得很篤定/);
  assert.match(verdict.message, /K7QM/, "要告訴使用者正確答案是什麼");
  assert.match(verdict.message, /比「看不到圖」更危險/);
});

test("老實說看不到圖的模型，要講成「正常，換一個就好」而不是危險", () => {
  const verdict = checkVisionAnswer("抱歉，我看不到圖片內容", "K7QM");
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /純文字模型/);
  assert.doesNotMatch(verdict.message, /危險/);
});

test("空回應(推理型模型把 token 用在思考上)要單獨講", () => {
  const verdict = checkVisionAnswer("", "K7QM");
  assert.equal(verdict.ok, false);
  assert.match(verdict.message, /沒有回答/);
});
