/**
 * 使用者貼到自己 Google 試算表 Apps Script 的唯一官方範本。
 * 設定頁、測試與文件都應引用這份，避免畫面上的教學改了但執行契約沒同步。
 */
export const GOOGLE_SHEET_SCRIPT_TEMPLATE = `function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return out({ ok: false, error: "Cannot read properties of null (reading 'getSheetByName')" });
    if (body.action === "capabilities") {
      // 真實踩過的事故：這個安全檢查只驗證「有沒有綁定某份試算表」(ss 不是 null)，驗不出
      // 「綁定的是不是正確的那份」——腳本專案剛好綁在一份空白的 Untitled spreadsheet 上
      // (不是使用者真正要寫入的那份表)，這個檢查照樣回 ok:true，使用者看到綠燈以為部署好了，
      // 真的執行才發現寫錯地方，重新部署好幾次都因為同一個誤綁而沒有解決。回傳目前綁定的試算表
      // 名稱，讓使用者在按下「檢查並套用」的當下就能肉眼核對「這是不是我要的那份」，不用等到
      // 真的寫入失敗才發現。
      return out({ ok: true, agentHubVersion: 4, actions: ["append", "updateTable", "readCells", "writeCells"], spreadsheetName: ss.getName() });
    }
    var sheet = body.sheet ? ss.getSheetByName(body.sheet) : ss.getSheets()[0];
    if (!sheet) {
      var actualSheetNames = ss.getSheets().map(function (s) { return s.getName(); }).join("、");
      return out({ ok: false, error: "找不到分頁: " + body.sheet + "；這支腳本目前綁定的試算表叫「" + ss.getName() + "」，裡面實際的分頁有：" + actualSheetNames });
    }

    if (body.action === "updateTable") return updateTable(sheet, body);
    if (body.action === "readCells") return readCells(sheet, body);
    if (body.action === "writeCells") return writeCells(sheet, body);
    if (!Array.isArray(body.cells)) return out({ ok: false, error: "沒有收到要新增的欄位" });
    sheet.appendRow(body.cells);
    return out({ ok: true, row: sheet.getLastRow() });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function readCells(sheet, body) {
  if (!Array.isArray(body.cells) || body.cells.length === 0) return out({ ok: false, error: "沒有指定要讀回的儲存格" });
  var cells = body.cells.map(function(a1) {
    var range = sheet.getRange(String(a1));
    return { a1: range.getA1Notation(), value: range.getDisplayValue() };
  });
  return out({ ok: true, cells: cells });
}

function writeCells(sheet, body) {
  if (!Array.isArray(body.cells) || body.cells.length === 0) return out({ ok: false, error: "沒有指定要寫入的儲存格" });
  body.cells.forEach(function(item) {
    sheet.getRange(String(item.a1)).setValue(item.value);
  });
  SpreadsheetApp.flush();
  return out({ ok: true, updated: body.cells.length });
}

function updateTable(sheet, body) {
  if (!body.targetColumn) return out({ ok: false, error: "沒有指定要更新哪一欄" });
  if (!Array.isArray(body.rows) || body.rows.length === 0) return out({ ok: false, error: "沒有收到要更新的列" });

  var values = sheet.getDataRange().getDisplayValues();
  var column = columnNumber(body.targetColumn, body.headerRowLabel, values);
  var planned = [];
  var seen = {};
  body.rows.forEach(function(item) {
    var label = String(item.label || "").trim();
    if (!label) throw new Error("有一筆資料缺少左側列名");
    if (seen[label]) throw new Error("列名重複: " + label);
    seen[label] = true;
    var matches = [];
    for (var r = 0; r < values.length; r++) {
      if (String(values[r][0] || "").trim() === label) matches.push(r + 1);
    }
    if (matches.length === 0) throw new Error("在 A 欄找不到列名: " + label);
    if (matches.length > 1) throw new Error("A 欄有重複列名，無法安全判斷: " + label);
    planned.push({ row: matches[0], value: item.value });
  });

  var cells = [];
  planned.forEach(function(item) {
    var range = sheet.getRange(item.row, column);
    range.setValue(item.value);
    cells.push(range.getA1Notation());
  });
  SpreadsheetApp.flush();
  return out({ ok: true, updated: planned.length, cells: cells });
}

function columnNumber(target, headerRowLabel, values) {
  var text = String(target).trim();
  if (/^[A-Za-z]+$/.test(text)) {
    return text.toUpperCase().split("").reduce(function(total, ch) {
      return total * 26 + ch.charCodeAt(0) - 64;
    }, 0);
  }

  var matches = [];
  var rowsToSearch = [];
  if (headerRowLabel) {
    for (var r = 0; r < values.length; r++) {
      if (String(values[r][0] || "").trim() === String(headerRowLabel).trim()) rowsToSearch.push(r);
    }
    if (rowsToSearch.length === 0) throw new Error("找不到欄位標題列: " + headerRowLabel);
    if (rowsToSearch.length > 1) throw new Error("欄位標題列名稱重複: " + headerRowLabel);
  } else {
    for (var i = 0; i < Math.min(values.length, 20); i++) rowsToSearch.push(i);
  }

  rowsToSearch.forEach(function(rowIndex) {
    values[rowIndex].forEach(function(value, columnIndex) {
      if (String(value || "").trim() === text) matches.push(columnIndex + 1);
    });
  });
  if (matches.length === 0) throw new Error("找不到欄名: " + text);
  if (matches.length > 1) throw new Error("欄名重複，無法安全判斷: " + text);
  return matches[0];
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}`;

/**
 * 找出「還沒完成第一次 Apps Script 設定」的試算表寫入步驟。
 * 對話在套用流程圖後用它決定要不要主動附上「一鍵複製腳本」設定卡——
 * 使用者不用自己想到要點開節點找教學(真實回饋:一般使用者根本不知道腳本藏在節點裡)。
 */
export function sheetWriteNodesNeedingSetup(
  nodes: { type?: string; label?: string; config?: Record<string, unknown> }[],
): string[] {
  return nodes
    .filter((node) =>
      (node.type === "google-sheet-append" || node.type === "google-sheet-update") &&
      !String(node.config?.scriptUrl ?? "").trim())
    .map((node) => node.label || "寫入試算表");
}
