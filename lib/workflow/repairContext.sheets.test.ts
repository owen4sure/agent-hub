import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { dumpFileExcerpt } from "./repairContext";

/**
 * 對應的真實失敗：執行時報「找不到分頁X。這個檔案實際的分頁有：…」6 次。那份清單執行期印得出來，
 * 建圖當下卻沒給模型看——而細節節錄一旦命中模型自己猜的分頁名就 break，等於永遠不會讓它知道
 * 還有哪些分頁存在，猜錯了也沒有線索可以自我修正。
 */
async function makeWorkbook(names: string[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  for (const name of names) {
    const ws = wb.addWorksheet(name);
    ws.addRow(["代碼", "數量"]);
    ws.addRow(["a1", 10]);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-sheets-")), "book.xlsx");
  await wb.xlsx.writeFile(file);
  return file;
}

test("檔案節錄：一開頭就要列出所有分頁名稱，模型才不會用猜的", async () => {
  const file = await makeWorkbook(["通路明細", "總覽", "備註"]);
  try {
    const dump = await dumpFileExcerpt(file, 7000, "");
    assert.ok(dump, "應該產得出節錄");
    for (const name of ["通路明細", "總覽", "備註"]) {
      assert.ok(dump!.includes(name), `分頁「${name}」要出現在節錄裡`);
    }
    assert.match(dump!.split("\n")[0] + dump!.split("\n")[1], /實際有這些分頁/, "分頁清單要在最前面，不能埋在細節後");
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test("檔案節錄：模型已點名某個分頁時，其他分頁名稱仍要看得到——猜錯了才有機會自我修正", async () => {
  const file = await makeWorkbook(["通路明細", "總覽", "備註"]);
  try {
    // sheetHint 命中「總覽」→ 細節只會給那一頁(這是刻意的，省提示)，但名稱清單必須完整
    const dump = await dumpFileExcerpt(file, 7000, '{"sheetName":"總覽"}');
    assert.ok(dump!.includes("通路明細"), "沒被點名的分頁名稱也要在，否則模型永遠不知道還有什麼可選");
    assert.ok(dump!.includes("備註"));
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});
