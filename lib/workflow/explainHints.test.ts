import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSheetHints } from "./explain";

test("extractSheetHints:從 custom-code 挖出試算表 ID、分頁名、用到的設定值", () => {
  const code = `
    const url = ctx.secrets.sheetAppendUrl;
    const target = "https://docs.google.com/spreadsheets/d/1AbcDefGhiJklMnoPqrStuvWxyz012345_678/edit#gid=99";
    await fetch(url, { body: JSON.stringify({ cells, sheet: "每週統計_主管版" }) });
    const ss = SpreadsheetApp.openById("1AbcDefGhiJklMnoPqrStuvWxyz012345_678");
    ss.getSheetByName("報告用");
  `;
  const h = extractSheetHints(code);
  assert.deepEqual(h.sheets, ["1AbcDefGhiJklMnoPqrStuvWxyz012345_678"]); // 去重
  assert.ok(h.tabs.includes("每週統計_主管版") && h.tabs.includes("報告用"));
  assert.deepEqual(h.secrets, ["sheetAppendUrl"]);
});

test("extractSheetHints:secrets 支援 . 與 [\"..\"] 兩種寫法;沒東西回空陣列", () => {
  const h = extractSheetHints(`const k = ctx.secrets["apiKey"]; const j = secrets.token;`);
  assert.ok(h.secrets.includes("apiKey") && h.secrets.includes("token"));
  const empty = extractSheetHints("return { ...ctx.input, total: 3 };");
  assert.deepEqual(empty, { sheets: [], tabs: [], secrets: [] });
});

test("extractSheetHints:空字串不爆", () => {
  assert.deepEqual(extractSheetHints(""), { sheets: [], tabs: [], secrets: [] });
});
