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
  assert.deepEqual(registered, ["output.xlsx"]);
  assert.ok(fs.existsSync(result.output.outputPath as string));

  const outWb = new ExcelJS.Workbook();
  await outWb.xlsx.readFile(result.output.outputPath as string);
  const outSheet = outWb.worksheets[0];
  assert.equal(outSheet.rowCount, 1, "只留下標題列，沒有任何資料列");
  assert.equal(String(outSheet.getRow(1).getCell(1).value), "日期");
});
