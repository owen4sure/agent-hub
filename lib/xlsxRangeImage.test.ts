import { test } from "node:test";
import assert from "node:assert/strict";
import { formatByNumFmt, negativeIsRed, cellRawValue, colLetters, colNum } from "./xlsxCellStyle";
import { XlsxRangeError, formatRange, parseRange, planMerges } from "./xlsxRangeImage";

/**
 * 這張圖會直接出現在給主管看的簡報上，所以「畫出來的內容」必須跟 Excel 畫面一致——
 * 不是跟儲存的值一致。下面每一項都對應一個「錯了就會被一眼看出來」的情境。
 */

test("數字格式：百分比要照 Excel 畫面顯示，不是原始小數", () => {
  // Excel 存 0.2697804391，畫面顯示 26.98%。畫原始值等於貼一張沒人看得懂的圖。
  assert.equal(formatByNumFmt(0.26978043912175653, "0.00%"), "26.98%");
  assert.equal(formatByNumFmt(1.0126666666666666, "0.00%"), "101.27%");
  assert.equal(formatByNumFmt(0.7032835820895522, "0.00%"), "70.33%");
  assert.equal(formatByNumFmt(0.5, "0%"), "50%");
});

test("數字格式：千分位與四捨五入", () => {
  assert.equal(formatByNumFmt(218530.69725, "#,##0_);[Red](#,##0)"), "218,531");
  assert.equal(formatByNumFmt(645707.97796, "#,##0_);[Red](#,##0)"), "645,708");
  assert.equal(formatByNumFmt(1189800, "#,##0_);[Red](#,##0)"), "1,189,800");
  assert.equal(formatByNumFmt(218, "#,##0"), "218");
  assert.equal(formatByNumFmt(1234.567, "#,##0.00"), "1,234.57");
});

test("數字格式：負數要照格式碼的第二段(括號)，紅字要判得出來", () => {
  assert.equal(formatByNumFmt(-1234, "#,##0_);[Red](#,##0)"), "(1,234)");
  assert.equal(negativeIsRed("#,##0_);[Red](#,##0)"), true);
  assert.equal(negativeIsRed("#,##0"), false);
  // 沒有括號的第二段就用一般負號，不要硬加括號
  assert.equal(formatByNumFmt(-50, "#,##0;-#,##0"), "-50");
});

test("數字格式：認不得的格式碼退回原始文字，不要自作聰明猜", () => {
  assert.equal(formatByNumFmt(5, "General"), "5");
  assert.equal(formatByNumFmt(5, undefined), "5");
  assert.equal(formatByNumFmt("-", "#,##0"), "-", "字串值(例如月目標寫「-」)要原樣保留");
  assert.equal(formatByNumFmt(null, "#,##0"), "");
});

test("儲存格值：公式格取 result，錯誤格要被標出來而不是印成 [object Object]", () => {
  assert.deepEqual(cellRawValue({ formula: "A1/B1", result: 42 }), { value: 42, isError: false });
  assert.deepEqual(cellRawValue({ error: "#DIV/0!" }), { value: "#DIV/0!", isError: true });
  // 公式算出錯誤：錯誤物件包在 result 裡，漏了這層就會印出 [object Object]
  assert.deepEqual(cellRawValue({ formula: "A1/0", result: { error: "#DIV/0!" } }), { value: "#DIV/0!", isError: true });
  assert.deepEqual(cellRawValue({ richText: [{ text: "甲" }, { text: "乙" }] }), { value: "甲乙", isError: false });
});

test("範圍解析：看不懂就報錯，不要猜一個範圍畫出來", () => {
  assert.deepEqual(parseRange("A3:G16"), { r1: 3, c1: 1, r2: 16, c2: 7 });
  assert.deepEqual(parseRange("a3:g16"), { r1: 3, c1: 1, r2: 16, c2: 7 });
  assert.deepEqual(parseRange("$A$3:$G$16"), { r1: 3, c1: 1, r2: 16, c2: 7 });
  assert.deepEqual(parseRange("B5"), { r1: 5, c1: 2, r2: 5, c2: 2 }, "單格也要能畫");
  // 左上右下寫反了照樣要能用(使用者從右下往左上框選複製出來就是這樣)
  assert.deepEqual(parseRange("G16:A3"), { r1: 3, c1: 1, r2: 16, c2: 7 });
  assert.throws(() => parseRange("整張表"), XlsxRangeError);
  assert.throws(() => parseRange("A3:G"), XlsxRangeError);
  assert.equal(formatRange(parseRange("G16:A3")), "A3:G16");
});

test("欄位代號雙向轉換", () => {
  assert.equal(colNum("A"), 1);
  assert.equal(colNum("G"), 7);
  assert.equal(colNum("AA"), 27);
  assert.equal(colLetters(1), "A");
  assert.equal(colLetters(7), "G");
  assert.equal(colLetters(27), "AA");
});

test("合併儲存格：範圍內的合併要保留 colspan/rowspan，被覆蓋的格不畫", () => {
  const { span, covered } = planMerges(["A3:B3", "A4:A8", "D9:D10"], { r1: 3, c1: 1, r2: 16, c2: 7 });
  assert.deepEqual(span.get("3:1"), { cs: 2, rs: 1 }, "A3:B3 橫跨兩欄");
  assert.deepEqual(span.get("4:1"), { cs: 1, rs: 5 }, "A4:A8 縱跨五列");
  assert.deepEqual(span.get("9:4"), { cs: 1, rs: 2 }, "D9:D10 縱跨兩列");
  assert.ok(covered.has("3:2"), "B3 被 A3 覆蓋，不能再畫一格");
  assert.ok(covered.has("8:1"), "A8 被 A4 覆蓋");
  assert.ok(!covered.has("4:1"), "主格自己不算被覆蓋");
});

test("合併儲存格：跨出範圍的要裁切，不能照原大小畫(會把表格撐破、整列錯位)", () => {
  // 合併區 A1:A8，但只框選 A3 以下——只有 A3:A8 這六列在範圍內
  const { span, covered } = planMerges(["A1:A8"], { r1: 3, c1: 1, r2: 16, c2: 7 });
  assert.deepEqual(span.get("3:1"), { cs: 1, rs: 6 }, "裁切後從第 3 列起算，只跨 6 列");
  assert.ok(!span.has("1:1"), "範圍外的原主格不該被畫");
  assert.ok(covered.has("4:1") && covered.has("8:1"));
  assert.ok(!covered.has("9:1"), "合併區之外不能被誤標成覆蓋");
});

test("合併儲存格：完全在範圍外的一律忽略", () => {
  const { span, covered } = planMerges(["I4:I8", "H4:H8"], { r1: 3, c1: 1, r2: 16, c2: 7 });
  assert.equal(span.size, 0);
  assert.equal(covered.size, 0);
});
