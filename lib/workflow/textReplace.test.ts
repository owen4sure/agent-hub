import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReplacePairs, syncLabelForDestinationChange } from "./textReplace";

test("parseReplacePairs：單一配對", () => {
  const { pairs, remainder } = parseReplacePairs("把『甲公司』全部換成『乙公司』");
  assert.deepEqual(pairs, [{ from: "甲公司", to: "乙公司" }]);
  assert.equal(remainder, "");
});

// 配對用的字串至少要 2 個字元(PAIR_RE 的 {2,80} 下限，避免單一字元這種太容易誤觸發的替換)
test("parseReplacePairs：多個配對(同一句話)", () => {
  const { pairs } = parseReplacePairs("把『AA』換成『BB』，然後『CC』改成『DD』");
  assert.deepEqual(pairs, [{ from: "AA", to: "BB" }, { from: "CC", to: "DD" }]);
});

test("parseReplacePairs：from 和 to 相同時跳過(踩過的假成功 bug)", () => {
  const { pairs } = parseReplacePairs("把『甲公司』換成『甲公司』");
  assert.deepEqual(pairs, []);
});

test("parseReplacePairs：挖掉替換片段後，剩餘的真實需求留在 remainder", () => {
  const { pairs, remainder } = parseReplacePairs("把『乙公司』換成『丙公司』，然後第4步的關鍵字改成『測試月報』");
  assert.deepEqual(pairs, [{ from: "乙公司", to: "丙公司" }]);
  assert.ok(remainder.includes("第4步"));
  assert.ok(remainder.includes("測試月報"));
});

test("parseReplacePairs：沒有引號配對句型就整句留在 remainder，不誤判", () => {
  const { pairs, remainder } = parseReplacePairs("幫我把找信那步改成搜尋標題");
  assert.deepEqual(pairs, []);
  assert.equal(remainder, "幫我把找信那步改成搜尋標題");
});

test("parseReplacePairs：不同引號風格(「」vs 『』vs 雙引號)都能配對", () => {
  const { pairs } = parseReplacePairs('把"AA"換成"BB"');
  assert.deepEqual(pairs, [{ from: "AA", to: "BB" }]);
});

test("parseReplacePairs：兩份平行目的地清單只替換真正改變的項目", () => {
  const text = "現在的流程是填入google sheet的『每週業績折線圖_月報週會』和『月報彙整表』，\n我要改成填『每週業績折線圖_業務週會』和『月報彙整表』。\n先不用實際填，你試試看有沒有辦法理解就好！";
  const { pairs, remainder } = parseReplacePairs(text);
  assert.deepEqual(pairs, [{ from: "每週業績折線圖_月報週會", to: "每週業績折線圖_業務週會" }]);
  assert.match(remainder, /先不用實際填/);
});

test("目的地設定改名時只同步真正使用該目的地的節點名稱", () => {
  const pair = [{ from: "每週業績折線圖_月報週會", to: "每週業績折線圖_業務週會" }];
  assert.deepEqual(
    syncLabelForDestinationChange("讀月報週會週期欄", { sheetName: "每週業績折線圖_月報週會" }, pair),
    { label: "讀業務週會週期欄", count: 1 },
  );
  assert.deepEqual(
    syncLabelForDestinationChange("填回月報週會月累計", { sheetName: "月報彙整表" }, pair),
    { label: "填回月報週會月累計", count: 0 },
  );
});
