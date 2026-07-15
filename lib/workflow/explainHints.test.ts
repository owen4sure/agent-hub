import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSheetHints, plainLanguage } from "./explain";
import { plainChatMessage } from "./plainLanguage";

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

test("使用者說明:佔位符、程式碼框、色碼與技術術語不會外露", () => {
  const result = plainLanguage("POST API workflow 的 node 用 #FFC000 highlight {{answer}}\n```js\nreturn ctx.input\n```", { answer: "AI 的答案" });
  assert.doesNotMatch(result, /\{\{|```|\bPOST\b|\bAPI\b|workflow|\bnode\b|#FFC000|highlight|ctx\./i);
  assert.match(result, /AI 的答案/);
  assert.match(result, /流程.*步驟.*橘黃色.*標色/);
  assert.match(result, /技術細節已隱藏/);
});

test("使用者說明:custom-code 的 intent 只顯示白話，不外露函式庫、欄位名或回傳物件", () => {
  const result = plainLanguage(
    "讀取日報 Excel，用 exceljs 找資料。輸出 periodStart(YYYY-MM-DD 起日)、anchorDate(YYYY-MM-DD 迄日)、periodLabel(原始區間)，給下游使用。return { 分類A: total, 分類B: count }。",
  );
  assert.doesNotMatch(result, /exceljs|periodStart|anchorDate|periodLabel|\breturn\b|[{}]/i);
  assert.match(result, /區間開始日期.*區間結束日期.*原始日期區間/);
  assert.match(result, /整理好的結果交給下一步/);
});

test("舊對話升級後也會把安全試跑內部欄位翻成白話", () => {
  const result = plainChatMessage("• 登入：loggedIn＝true；讀表：rowCount＝42；reportDate＝2026-07-08");
  assert.match(result, /登入成功＝是/);
  assert.match(result, /讀到資料列數＝42/);
  assert.match(result, /主管報告資料日＝2026-07-08/);
  assert.doesNotMatch(result, /loggedIn|rowCount|reportDate/);
});

test("既有節點摘要的模板欄位也只顯示白話", () => {
  const result = plainChatMessage("每週業績折線圖 · {{periodLabel}}");
  assert.equal(result, "每週業績折線圖 · 原始日期區間");
});

test("白話過濾不會破壞真實網址、文件 ID 或檔案副檔名", () => {
  const url = "https://docs.google.com/spreadsheets/d/1TestFakeSpreadsheetIdForUnitTestOnly000/edit?usp=sharing";
  const result = plainChatMessage(`來源：${url}\n附件名稱＝2026年度銷售彙總報表_202607.xlsx`);
  assert.match(result, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result, /2026年度銷售彙總報表_202607\.xlsx/);
  assert.doesNotMatch(result, /前面步驟提供的資料|\.內建工具/);
});

test("安全預覽保留中文指標與常見業務縮寫", () => {
  const result = plainChatMessage("類別A=5\nKPI=65\nMTD=121");
  assert.match(result, /類別A＝5/);
  assert.match(result, /KPI＝65/);
  assert.match(result, /MTD＝121/);
});
