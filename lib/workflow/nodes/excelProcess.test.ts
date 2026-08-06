import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { excelProcessNode } from "./excelProcess";
import type { NodeContext } from "../types";

function makeCtx(overrides: Partial<NodeContext>): NodeContext {
  return {
    runId: "r1",
    workflowId: "wf1",
    nodeId: "n1",
    input: {},
    config: {},
    secrets: {},
    vars: {},
    model: "",
    baseUrl: "",
    apiKey: "",
    headed: false,
    outputDir: "",
    debugDir: "",
    session: {} as NodeContext["session"],
    log: () => {},
    registerFile: () => {},
    cancelSignal: new AbortController().signal,
    ...overrides,
  };
}

async function makeSourceWorkbook(workDir: string): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("工作表1");
  sheet.getRow(1).values = ["日期", "已完成"];
  sheet.getRow(2).values = [20260124, "是"];
  const inputPath = path.join(workDir, "source.xlsx");
  await wb.xlsx.writeFile(inputPath);
  return inputPath;
}

test("Excel 篩選+highlight：篩選 0 筆時預設仍視為失敗(維持既有安全預設)", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-excel-test-"));
  const inputPath = await makeSourceWorkbook(workDir);
  const outputDir = path.join(workDir, "out");
  fs.mkdirSync(outputDir, { recursive: true });

  const ctx = makeCtx({
    outputDir,
    config: {
      inputPath,
      sheet: "工作表1",
      headerText: "日期",
      dateColumn: 1,
      filterStart: "20260401",
      filterEnd: "20260630",
      highlightColumn: "已完成",
      outputName: "output",
    },
  });

  await assert.rejects(() => excelProcessNode.execute(ctx), /篩選區間內沒有資料/);
});

test("Excel 篩選+highlight：allowEmptyResult 開啟時 0 筆也能正常完成，產出只有標題列的檔案(適用每季固定結算、剛好那期沒資料的情境)", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-excel-test-"));
  const inputPath = await makeSourceWorkbook(workDir);
  const outputDir = path.join(workDir, "out");
  fs.mkdirSync(outputDir, { recursive: true });
  const registered: string[] = [];

  const ctx = makeCtx({
    outputDir,
    registerFile: (filename) => { registered.push(filename); },
    config: {
      inputPath,
      sheet: "工作表1",
      headerText: "日期",
      dateColumn: 1,
      filterStart: "20260401",
      filterEnd: "20260630",
      highlightColumn: "已完成",
      outputName: "output",
      allowEmptyResult: true,
    },
  });

  const result = await excelProcessNode.execute(ctx);
  assert.equal(result.output.rowCount, 0);
  assert.equal((result.output.sourceEvidence as { filename: string }).filename, "source.xlsx");
  assert.equal((result.output.sourceEvidence as { sha256: string }).sha256.length, 64);
  assert.deepEqual(registered, ["output.xlsx"]);
  assert.ok(fs.existsSync(result.output.outputPath as string));

  const outWb = new ExcelJS.Workbook();
  await outWb.xlsx.readFile(result.output.outputPath as string);
  const outSheet = outWb.worksheets[0];
  assert.equal(outSheet.rowCount, 1, "只留下標題列，沒有任何資料列");
  assert.equal(String(outSheet.getRow(1).getCell(1).value), "日期");
});

/**
 * 2026-08 使用者實測踩到的真實 bug：下游只看得到 rowCount(篩到幾列)，沒有「highlight 那一欄的
 * 加總」可以引用——被誤用成「總開戶數」，剛好等於篩選區間的天數(兩個完全不相干的業務量都變成
 * 「31」，看起來一樣其實都是錯的)。這裡直接驗證加總結果，且只加真的是數字的儲存格，不誤把
 * 文字/空白算進去(例如「已完成」欄位若混了文字備註，不能讓那一列的字串把整個加總炸出 NaN)。
 */
test("Excel 篩選+highlight：highlightColumnSum 要是 highlight 那一欄、篩選範圍內的數字加總，不是列數", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-excel-test-"));
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("工作表1");
  sheet.getRow(1).values = ["日期", "新增開戶數"];
  sheet.getRow(2).values = [20260701, 3];
  sheet.getRow(3).values = [20260702, 5];
  sheet.getRow(4).values = [20260703, "備註(非數字，不該被加總)"];
  sheet.getRow(5).values = [20260801, 999]; // 篩選區間外，不該被算進去
  const inputPath = path.join(workDir, "source.xlsx");
  await wb.xlsx.writeFile(inputPath);
  const outputDir = path.join(workDir, "out");
  fs.mkdirSync(outputDir, { recursive: true });

  const baseConfig = {
    inputPath, sheet: "工作表1", headerText: "日期", dateColumn: 1,
    filterStart: "20260701", filterEnd: "20260731",
    highlightColumn: "新增開戶數", outputName: "output",
  };

  const result = await excelProcessNode.execute(makeCtx({ outputDir, config: baseConfig }));
  assert.equal(result.output.rowCount, 3, "3 列符合日期區間(不含區間外那筆)");
  assert.equal(result.output.highlightColumnSum, 8, "只加總數字儲存格(3+5)，非數字的備註列跳過，區間外的 999 不算");

  // 只讀驗證(dry-run)不寫檔，但同一段邏輯要算出一樣的加總，不能只有正式執行才有這個欄位
  const dryResult = await excelProcessNode.execute(makeCtx({ outputDir, dryRun: true, config: baseConfig }));
  assert.equal(dryResult.output.highlightColumnSum, 8);
});
