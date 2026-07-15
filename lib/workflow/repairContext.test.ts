import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { dumpFileExcerpt } from "./repairContext";

test("成功執行檔案證據：需求點名的第 14 列也要帶 A1 位址，不能只看前 12 列", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-runtime-evidence-"));
  const file = path.join(dir, "report.xlsx");
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("業績占比彙總");
    sheet.getCell("B3").value = "類別";
    sheet.getCell("E3").value = "本月平均金額";
    sheet.getCell("F3").value = "前月平均金額";
    sheet.getCell("B7").value = "類別A";
    sheet.getCell("E7").value = 12;
    sheet.getCell("F7").value = 850.4;
    sheet.getCell("B14").value = "類別B";
    sheet.getCell("E14").value = 210.5;
    sheet.getCell("F14").value = 198.0;
    await workbook.xlsx.writeFile(file);

    const evidence = await dumpFileExcerpt(file, 8_000, "彙整表的類別A與類別B要對照業績占比彙總");
    assert.ok(evidence);
    assert.match(evidence, /B7=類別A/);
    assert.match(evidence, /E7=12/);
    assert.match(evidence, /F7=850\.4/);
    assert.match(evidence, /B14=類別B/);
    assert.match(evidence, /E14=210\.5/);
    assert.match(evidence, /F14=198/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
