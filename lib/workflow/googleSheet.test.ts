import { describe, it, test } from "node:test";
import assert from "node:assert";
import { googleSheetAppendNode, googleSheetReadNode, googleSheetUpdateNode, parseSheetRowValues, parseSheetUrl, sheetScriptHtmlErrorMessage } from "./nodes/googleSheet";

describe("parseSheetUrl", () => {
  it("標準網址(含 edit 與 gid hash)抽出 id 和 gid", () => {
    assert.deepEqual(
      parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbC_dEf-123/edit#gid=456"),
      { id: "1AbC_dEf-123", gid: "456" },
    );
  });

  it("沒帶 gid 就用第一個分頁(gid=0)", () => {
    assert.deepEqual(
      parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbC/edit"),
      { id: "1AbC", gid: "0" },
    );
  });

  it("query 形式的 gid 也吃", () => {
    assert.deepEqual(
      parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbC/edit?gid=99"),
      { id: "1AbC", gid: "99" },
    );
  });

  it("非 docs.google.com 主機一律拒絕(不做任意主機請求)", () => {
    assert.equal(parseSheetUrl("https://evil.example.com/spreadsheets/d/1AbC/edit"), null);
    assert.equal(parseSheetUrl("https://docs.google.com.evil.com/spreadsheets/d/1AbC"), null);
  });

  it("不是試算表路徑/不是網址 → null", () => {
    assert.equal(parseSheetUrl("https://docs.google.com/document/d/1AbC/edit"), null);
    assert.equal(parseSheetUrl("隨便一串字"), null);
    assert.equal(parseSheetUrl(""), null);
  });
});

describe("parseSheetRowValues", () => {
  it("把白話的列名和值轉成可寫入資料，保留文字並解析數字/布林", () => {
    assert.deepEqual(parseSheetRowValues("類別A=123\n類別B：45.5\n已確認=true\n備註=001A"), [
      { label: "類別A", value: 123 },
      { label: "類別B", value: 45.5 },
      { label: "已確認", value: true },
      { label: "備註", value: "001A" },
    ]);
  });

  it("拒絕格式錯誤、重複列名與空內容，避免寫錯格", () => {
    assert.throws(() => parseSheetRowValues("沒有分隔符"), /格式不對/);
    assert.throws(() => parseSheetRowValues("類別B=1\n類別B=2"), /重複/);
    assert.throws(() => parseSheetRowValues("\n"), /沒有設定/);
  });
});

test("Google Sheet 讀寫網址分屬節點設定，寫入不再產生設定頁帳密欄位", () => {
  for (const node of [googleSheetAppendNode, googleSheetUpdateNode]) {
    assert.ok(node.configSchema.some((field) => field.key === "scriptUrl"), `${node.type} 應直接有 scriptUrl`);
    assert.equal(node.secretFields, undefined, `${node.type} 不應再要求 sheetAppendUrl`);
  }
  assert.ok(googleSheetReadNode.configSchema.some((field) => field.key === "sheetUrl"));
  assert.equal(googleSheetReadNode.configSchema.some((field) => field.key === "scriptUrl"), false);
});

describe("Apps Script HTML 錯誤辨識", () => {
  it("舊 append-only 腳本不能誤報成登入權限問題", () => {
    const message = sheetScriptHtmlErrorMessage("<html><title>錯誤</title><body>Error: The rowContents passed to appendRow() must be nonempty. (第 6 行，檔案名稱：Code)</body></html>");
    assert.match(message, /舊版/);
    assert.match(message, /新版本/);
    assert.match(message, /新.*exec 網址/);
    assert.doesNotMatch(message, /需要登入/);
  });

  it("真正的 Google 登入頁仍回報部署存取權", () => {
    assert.match(sheetScriptHtmlErrorMessage("<html><title>Sign in</title><body>ServiceLogin</body></html>"), /需要登入/);
  });
});
