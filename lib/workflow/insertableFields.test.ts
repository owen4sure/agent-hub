import test from "node:test";
import assert from "node:assert/strict";
import { findFieldMistakes, insertableFieldsFor, previewValue, referencedTokens } from "./insertableFields";

const flow = {
  nodes: [
    { id: "t", label: "開始", outputs: [{ name: "filePath", status: "available" }] },
    { id: "calc", label: "判斷週期", outputs: [{ name: "periodLabel", status: "available" }] },
    { id: "sum", label: "計算數字", outputs: [{ name: "weekTotal", status: "available" }, { name: "mystery", status: "unknown-source" }] },
    { id: "mail", label: "寄信", outputs: [] },
    { id: "later", label: "後面的步驟", outputs: [{ name: "tooLate", status: "available" }] },
  ],
};

// 使用者原話：「使用者看不懂 {{periodLabel}} 這種東西是什麼」。所以每個可插入的欄位都要
// 同時回答：這是什麼、會變成什麼、誰算出來的。
test("可插入欄位要帶白話名稱、上次的真實值、以及是哪一步算的", () => {
  const fields = insertableFieldsFor(flow, "mail", { periodLabel: "7/22-7/28", weekTotal: 504 });
  const period = fields.find((f) => f.key === "periodLabel")!;
  assert.equal(period.label, "這次的期間", "常見欄位要翻成白話");
  assert.equal(period.sample, "7/22-7/28", "要顯示上次執行的真實值，他才認得出是不是自己要的");
  assert.equal(period.from, "判斷週期", "要講是哪一步算的");
  assert.equal(fields.find((f) => f.key === "weekTotal")!.label, "weekTotal", "自訂欄位沒有白話名就退回原名，但仍帶值與來源");
});

test("只列前面步驟算出來的東西——後面的還沒跑到，引用了永遠是空的", () => {
  const keys = insertableFieldsFor(flow, "mail").map((f) => f.key);
  assert.ok(keys.includes("periodLabel"));
  assert.ok(!keys.includes("tooLate"), "後面步驟的欄位不能列出來");
  assert.ok(!keys.includes("mystery"), "來源不明的欄位不要列，會誤導");
});

test("沒跑過的流程也不能是空的——沒有真實值就只顯示名稱與來源", () => {
  const fields = insertableFieldsFor(flow, "mail");
  assert.ok(fields.length > 0);
  assert.equal(fields[0].sample, undefined);
});

test("值太長要截短：這是用來認人的，不是完整資料", () => {
  assert.match(previewValue("x".repeat(200)), /…$/);
  assert.match(previewValue({ a: 1, b: "y".repeat(200) }), /一整包資料/);
  assert.equal(previewValue(null), "");
});

test("抓得出使用者自己打的 {{欄位}}", () => {
  assert.deepEqual(referencedTokens("嗨 {{periodLabel}}，共 {{ weekTotal }} 戶"), ["periodLabel", "weekTotal"]);
});

// 平台本來就會在執行前檢查，但那時候太晚——使用者要的是打字當下就知道打錯了。
test("打錯字要當場找出最接近的那一個，讓畫面可以說「你是不是要用○○？」", () => {
  const available = insertableFieldsFor(flow, "mail", { periodLabel: "7/22-7/28" });
  const mistakes = findFieldMistakes("這週是 {{periodLable}}", available);
  assert.equal(mistakes.length, 1);
  assert.equal(mistakes[0].token, "periodLable");
  assert.equal(mistakes[0].suggestion?.key, "periodLabel");
  assert.equal(mistakes[0].suggestion?.label, "這次的期間", "建議也要用白話講");
});

test("根本沒人算的東西，要說「沒有」而不是硬猜一個", () => {
  const available = insertableFieldsFor(flow, "mail");
  const mistakes = findFieldMistakes("上週是 {{lastWeekNumbersThatNobodyComputed}}", available);
  assert.equal(mistakes.length, 1);
  assert.equal(mistakes[0].suggestion, undefined);
});

test("內建的日期變數不是打錯，不能誤報", () => {
  assert.deepEqual(findFieldMistakes("{{today}} 的資料", insertableFieldsFor(flow, "mail")), []);
});

test("打對了就完全不要出聲", () => {
  const available = insertableFieldsFor(flow, "mail");
  assert.deepEqual(findFieldMistakes("{{periodLabel}} 共 {{weekTotal}} 戶", available), []);
});
