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
  /** 儲存格格式標記(用來測 copyFormat)：key 是 "col,row"(1-based)，value 是任意字串標籤 */
  formats: Map<string, string>;
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

function columnNumberFromLetters(letters: string): number {
  return letters.toUpperCase().split("").reduce((total, ch) => total * 26 + ch.charCodeAt(0) - 64, 0);
}

/** 解析 "B13" 或 "K46:K51" 這類 A1 記法(單一儲存格或矩形範圍)成 1-based 的列/欄邊界 */
function parseA1Range(a1: string): { c1: number; r1: number; c2: number; r2: number } {
  const [startPart, endPart] = a1.split(":");
  const m1 = startPart.match(/^([A-Za-z]+)(\d+)$/);
  if (!m1) throw new Error(`測試假物件不認得這個 A1 記法: ${a1}`);
  const start = { c: columnNumberFromLetters(m1[1]), r: Number(m1[2]) };
  if (!endPart) return { c1: start.c, r1: start.r, c2: start.c, r2: start.r };
  const m2 = endPart.match(/^([A-Za-z]+)(\d+)$/);
  if (!m2) throw new Error(`測試假物件不認得這個 A1 記法: ${a1}`);
  const end = { c: columnNumberFromLetters(m2[1]), r: Number(m2[2]) };
  return { c1: start.c, r1: start.r, c2: end.c, r2: end.r };
}

function harness(initial: unknown[][]): Harness {
  const data = initial.map((row) => [...row]);
  const writes: string[] = [];
  const formats = new Map<string, string>();

  function ensureCell(row: number, column: number) {
    while (data.length < row) data.push([]);
    while (data[row - 1].length < column) data[row - 1].push("");
  }

  // Range 物件同時支援單一儲存格(setValue/getDisplayValue)與矩形範圍(copyTo)——
  // readCells/writeCells 只用單一儲存格，copyFormat(archive 格式複製)兩種都可能用到。
  function makeStringRange(a1: string) {
    const { c1, r1, c2, r2 } = parseA1Range(a1);
    return {
      setValue(value: unknown) {
        ensureCell(r1, c1);
        data[r1 - 1][c1 - 1] = value;
        writes.push(`${columnLetters(c1)}${r1}`);
      },
      getDisplayValue() {
        ensureCell(r1, c1);
        return String(data[r1 - 1][c1 - 1] ?? "");
      },
      getA1Notation: () => a1,
      copyTo(dest: { __bounds: { c1: number; r1: number; c2: number; r2: number } }) {
        const { c1: dc1, r1: dr1 } = dest.__bounds;
        const width = c2 - c1;
        const height = r2 - r1;
        for (let dr = 0; dr <= height; dr++) {
          for (let dc = 0; dc <= width; dc++) {
            const tag = formats.get(`${c1 + dc},${r1 + dr}`) ?? "";
            formats.set(`${dc1 + dc},${dr1 + dr}`, tag);
          }
        }
      },
      __bounds: { c1, r1, c2, r2 },
    };
  }

  const sheet = {
    getDataRange: () => ({ getDisplayValues: () => data.map((row) => row.map((value) => String(value ?? ""))) }),
    getRange: (rowOrA1: number | string, column?: number) => {
      if (typeof rowOrA1 === "string") return makeStringRange(rowOrA1);
      const row = rowOrA1;
      return {
        setValue(value: unknown) {
          ensureCell(row, column!);
          data[row - 1][column! - 1] = value;
          writes.push(`${columnLetters(column!)}${row}`);
        },
        getA1Notation: () => `${columnLetters(column!)}${row}`,
      };
    },
    appendRow(cells: unknown[]) { data.push([...cells]); },
    getLastRow: () => data.length,
  };
  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getName: () => "彙整表測試表",
      getSheetByName: (name: string) => name === "彙整表" ? sheet : null,
      getSheets: () => [sheet],
    }),
    // copyTo 的假物件用範圍的 __bounds 本身當「目標」參數即可，真正的 CopyPasteType 值在假物件裡不需要區分
    CopyPasteType: { PASTE_FORMAT: "PASTE_FORMAT" },
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
    formats,
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

  // 真實踩過的 bug：「🔎 檢查並套用」的 capabilities 探測必須要能分辨「腳本專案沒有正確綁定在
  // 試算表上」這種最常見的部署錯誤——這正是使用者實際遇到、真正執行 updateTable 時炸出
  // "Cannot read properties of null (reading 'getSheetByName')" 的成因。舊版範本的 capabilities
  // 分支在 doPost 最前面就直接回 { ok: true }，完全沒有先呼叫 SpreadsheetApp.getActiveSpreadsheet()，
  // 所以就算腳本專案沒綁對試算表(getActiveSpreadsheet() 會回 null)，「檢查並套用」仍然回報成功——
  // 使用者看到綠燈以為部署好了，一去真的寫資料才發現照樣壞掉，白白重新部署好幾次都修不好。
  it("腳本專案沒有正確綁定在試算表上時，capabilities 探測也要老實回報失敗，不能給假的綠燈", () => {
    const unboundSpreadsheetApp = {
      getActiveSpreadsheet: () => null,
      flush() {},
    };
    const ContentService = {
      MimeType: { JSON: "json" },
      createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }),
    };
    const factory = new Function(
      "SpreadsheetApp",
      "ContentService",
      `${GOOGLE_SHEET_SCRIPT_TEMPLATE}\nreturn { doPost: doPost };`,
    );
    const api = factory(unboundSpreadsheetApp, ContentService) as { doPost(event: unknown): { text: string } };
    const result = JSON.parse(
      api.doPost({ postData: { contents: JSON.stringify({ action: "capabilities" }) } }).text,
    ) as Record<string, unknown>;
    assert.equal(result.ok, false, `capabilities 探測應該要偵測到腳本沒綁定試算表，實際回應：${JSON.stringify(result)}`);
  });

  // 真實踩過的事故：capabilities 探測只驗得出「有沒有綁定某份試算表」，驗不出「綁定的是不是
  // 正確的那份」——使用者的腳本專案剛好綁在一份空白的「Untitled spreadsheet」上(不是他真正
  // 要寫入的那份表)，這個檢查照樣回 ok:true，使用者看到「檢查並套用」顯示成功以為部署好了，
  // 真的執行才發現寫錯地方，反覆重新部署了 5 次都沒解決同一個誤綁問題。capabilities 回應要
  // 附上目前綁定的試算表名稱，讓呼叫端能把它顯示給使用者核對，不用等到真的寫入失敗才發現。
  it("capabilities 探測要附上目前綁定的試算表名稱，讓使用者能核對是不是綁錯了", () => {
    const h = harness([["A", "B"]]);
    const result = h.call({ action: "capabilities" });
    assert.equal(result.spreadsheetName, "彙整表測試表", `capabilities 回應要帶 spreadsheetName，實際：${JSON.stringify(result)}`);
  });

  // 真實踩過的案例：使用者堅持分頁名稱一直都對、沒改過，「找不到分頁: X」這句話本身完全沒有
  // 線索能判斷到底是分頁被改名了，還是這支 Apps Script 根本綁到了另一份試算表(例如複製過一次
  // 試算表、或不小心從錯的那份試算表開 Apps Script)。這兩種情況使用者要採取的行動完全不同，
  // 必須讓錯誤訊息本身列出「目前綁定的試算表叫什麼名字＋裡面實際有哪些分頁」，使用者一比對
  // 就知道是哪一種，不用再靠猜。
  it("找不到指定分頁時，錯誤要列出目前綁定的試算表名稱與實際存在的分頁清單，讓使用者能判斷是分頁改名了還是綁錯試算表", () => {
    const sheetA = { getName: () => "工作表1" };
    const sheetB = { getName: () => "彙整表" };
    const SpreadsheetApp = {
      getActiveSpreadsheet: () => ({
        getName: () => "業務週報彙整(2026)",
        getSheetByName: (name: string) => [sheetA, sheetB].find((s) => s.getName() === name) ?? null,
        getSheets: () => [sheetA, sheetB],
      }),
      flush() {},
    };
    const ContentService = {
      MimeType: { JSON: "json" },
      createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }),
    };
    const factory = new Function(
      "SpreadsheetApp",
      "ContentService",
      `${GOOGLE_SHEET_SCRIPT_TEMPLATE}\nreturn { doPost: doPost };`,
    );
    const api = factory(SpreadsheetApp, ContentService) as { doPost(event: unknown): { text: string } };
    const result = JSON.parse(
      api.doPost({ postData: { contents: JSON.stringify({ action: "updateTable", sheet: "每週業績折線圖_業務週會", targetColumn: "A", rows: [] }) } }).text,
    ) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.match(String(result.error), /業務週報彙整\(2026\)/, "要點名目前綁定的試算表叫什麼，讓使用者判斷是不是綁錯試算表");
    assert.match(String(result.error), /工作表1/);
    assert.match(String(result.error), /彙整表/);
  });

  it("writeCells：依 A1 位址寫入多個儲存格，值正確落地", () => {
    const h = harness([["資料日期", "6/12-6/18"]]);
    const result = h.call({ action: "writeCells", sheet: "彙整表", cells: [{ a1: "B1", value: "6/19-6/25" }, { a1: "B2", value: "MGM" }] });
    assert.deepEqual(result, { ok: true, updated: 2 });
    assert.equal(h.data[0][1], "6/19-6/25");
    assert.equal(h.data[1][1], "MGM");
  });

  it("readCells：依 A1 位址讀回顯示值", () => {
    const h = harness([["資料日期", "6/12-6/18"], ["MGM", 93]]);
    const result = h.call({ action: "readCells", sheet: "彙整表", cells: ["B1", "B2"] });
    assert.deepEqual(result, { ok: true, cells: [{ a1: "B1", value: "6/12-6/18" }, { a1: "B2", value: "93" }] });
  });

  // 真實踩過的事故：writeCells 只設定儲存格的值，寫進一塊原本空白、從沒被人手動格式化過的
  // 歸檔欄位(例如第一次真正用到的新欄位)，看起來就會跟旁邊已經手動加了框線/字體的舊欄位不一致。
  // copyFormat 用來把「這欄的格式應該要跟旁邊那欄一樣」的情境補上：只搬格式，不動值。
  it("copyFormat：把來源範圍的格式複製到目標範圍，不影響任一邊的值", () => {
    const h = harness([
      ["資料日期", "5/22-5/28", "6/5-6/11"],
      ["MGM", 61, 80],
    ]);
    // 模擬「J 欄(5/22-5/28)先前已經被人手動加過框線」，K 欄(6/5-6/11)是全新、從未格式化過的欄位
    h.formats.set("2,1", "bordered");
    h.formats.set("2,2", "bordered");
    const result = h.call({ action: "copyFormat", sheet: "彙整表", from: "B1:B2", to: "C1:C2" });
    assert.deepEqual(result, { ok: true });
    assert.equal(h.formats.get("3,1"), "bordered");
    assert.equal(h.formats.get("3,2"), "bordered");
    // 值完全不受影響——copyFormat 純粹搬格式
    assert.equal(h.data[0][2], "6/5-6/11");
    assert.equal(h.data[1][2], 80);
  });

  it("copyFormat：缺 from 或 to 時明確報錯，不猜測範圍", () => {
    const h = harness([["A"]]);
    assert.equal(h.call({ action: "copyFormat", sheet: "彙整表", to: "B1" }).ok, false);
    assert.equal(h.call({ action: "copyFormat", sheet: "彙整表", from: "A1" }).ok, false);
  });

  it("capabilities 回應要包含 copyFormat，讓呼叫端能偵測到舊部署還沒更新到這個版本", () => {
    const h = harness([["A"]]);
    const result = h.call({ action: "capabilities" });
    assert.ok(Array.isArray(result.actions) && (result.actions as string[]).includes("copyFormat"));
  });
});
