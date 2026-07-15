import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GOOGLE_SHEET_SCRIPT_TEMPLATE, sheetWriteNodesNeedingSetup } from "./googleSheetScriptTemplate";

describe("sheetWriteNodesNeedingSetup", () => {
  it("只挑出還沒填寫入網址的試算表寫入步驟，其他節點與已設定的不算", () => {
    const labels = sheetWriteNodesNeedingSetup([
      { type: "trigger", label: "開始", config: {} },
      { type: "google-sheet-read", label: "讀表", config: { sheetUrl: "https://docs.google.com/x" } },
      { type: "google-sheet-update", label: "填回週增量", config: {} },
      { type: "google-sheet-append", label: "新增紀錄", config: { scriptUrl: "  " } },
      { type: "google-sheet-update", label: "已設定的", config: { scriptUrl: "https://script.google.com/macros/s/x/exec" } },
      { type: "google-sheet-update", config: {} },
    ]);
    assert.deepEqual(labels, ["填回週增量", "新增紀錄", "寫入試算表"]);
  });

  it("沒有需要設定的節點時回空陣列(對話不出卡)", () => {
    assert.deepEqual(sheetWriteNodesNeedingSetup([{ type: "write-file", label: "落檔", config: {} }]), []);
  });
});

interface Harness {
  call(body: Record<string, unknown>): Record<string, unknown>;
  data: unknown[][];
  writes: string[];
}

function columnLetters(column: number): string {
  let value = column;
  let result = "";
  while (value > 0) {
    const rem = (value - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function harness(initial: unknown[][]): Harness {
  const data = initial.map((row) => [...row]);
  const writes: string[] = [];
  const sheet = {
    getDataRange: () => ({ getDisplayValues: () => data.map((row) => row.map((value) => String(value ?? ""))) }),
    getRange: (row: number, column: number) => ({
      setValue(value: unknown) {
        while (data.length < row) data.push([]);
        while (data[row - 1].length < column) data[row - 1].push("");
        data[row - 1][column - 1] = value;
        writes.push(`${columnLetters(column)}${row}`);
      },
      getA1Notation: () => `${columnLetters(column)}${row}`,
    }),
    appendRow(cells: unknown[]) { data.push([...cells]); },
    getLastRow: () => data.length,
  };
  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ({ getSheetByName: (name: string) => name === "彙整表" ? sheet : null, getSheets: () => [sheet] }),
    flush() {},
  };
  const ContentService = {
    MimeType: { JSON: "json" },
    createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }),
  };
  const factory = new Function("SpreadsheetApp", "ContentService", `${GOOGLE_SHEET_SCRIPT_TEMPLATE}\nreturn { doPost: doPost };`);
  const api = factory(SpreadsheetApp, ContentService) as { doPost(event: unknown): { text: string } };
  return {
    data,
    writes,
    call(body) {
      return JSON.parse(api.doPost({ postData: { contents: JSON.stringify(body) } }).text) as Record<string, unknown>;
    },
  };
}

describe("Google 試算表 Apps Script 官方範本", () => {
  it("依標題列、欄名與 A 欄列名精準更新指定格", () => {
    const h = harness([
      ["資料日期", "6/24-6/30", "7/1-7/7"],
      ["類別A", 5, ""],
      ["類別B", 210, ""],
    ]);
    const result = h.call({ action: "updateTable", sheet: "彙整表", headerRowLabel: "資料日期", targetColumn: "7/1-7/7", rows: [
      { label: "類別A", value: 5 },
      { label: "類別B", value: 88 },
    ] });
    assert.deepEqual(result, { ok: true, updated: 2, cells: ["C2", "C3"] });
    assert.deepEqual(h.writes, ["C2", "C3"]);
    assert.equal(h.data[2][2], 88);
  });

  it("直接指定 B/E 欄也能更新，供 MTD/YTD 使用", () => {
    const h = harness([["通路", "MTD", "目標", "達成率", "YTD"], ["類別A", "", 125, "", ""]]);
    assert.deepEqual(h.call({ action: "updateTable", sheet: "彙整表", targetColumn: "E", rows: [{ label: "類別A", value: 232 }] }), {
      ok: true, updated: 1, cells: ["E2"],
    });
    assert.equal(h.data[1][4], 232);
  });

  it("列名或欄名不唯一時整批拒絕，驗證完之前不寫任何格", () => {
    const h = harness([["資料日期", "7/1-7/7"], ["類別B", ""], ["類別B", ""]]);
    const result = h.call({ action: "updateTable", sheet: "彙整表", headerRowLabel: "資料日期", targetColumn: "7/1-7/7", rows: [{ label: "類別B", value: 97 }] });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /重複列名/);
    assert.deepEqual(h.writes, []);
  });

  it("舊有新增一列功能保持相容", () => {
    const h = harness([["A", "B"]]);
    assert.deepEqual(h.call({ sheet: "彙整表", cells: ["x", 1] }), { ok: true, row: 2 });
    assert.deepEqual(h.data[1], ["x", 1]);
  });
});
