import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import { extractTextFromFile, xlsxToText } from "./textExtract";

test("附件理解:不靠副檔名白名單,TypeScript/YAML/SQL 都能讀到真實邏輯", async () => {
  for (const [name, content] of [
    ["rule.ts", "export const total = rows.reduce((sum, row) => sum + row.amount, 0);"],
    ["flow.yaml", "steps:\n  - read: invoice\n  - when: amount > 100"],
    ["report.sql", "select customer_id, sum(amount) from orders group by customer_id"],
  ]) {
    const result = await extractTextFromFile(name, Buffer.from(content));
    assert.ok("text" in result);
    assert.match(result.text, /amount|invoice/);
  }
});

test("附件理解:ZIP 會展開裡面的程式碼/說明,不是只看檔名", async () => {
  const zip = new AdmZip();
  zip.addFile("src/calc.js", Buffer.from("function calc(items) { return items.filter(x => x.active); }"));
  zip.addFile("README.md", Buffer.from("這個專案會篩選啟用中的資料"));
  const result = await extractTextFromFile("project.zip", zip.toBuffer());
  assert.ok("text" in result);
  assert.match(result.text, /src\/calc\.js/);
  assert.match(result.text, /items\.filter/);
  assert.match(result.text, /篩選啟用中/);
});

test("附件理解:真正的二進位檔不假裝看懂", async () => {
  const result = await extractTextFromFile("unknown.bin", Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  assert.ok("error" in result);
  assert.match(result.error, /不會假裝看懂/);
});

test("附件理解:大型文字會保留檔尾規則,不是只看開頭", async () => {
  const content = `開頭說明\n${"一般內容\n".repeat(9000)}\n關鍵規則：失敗時一定要通知主管`;
  const result = await extractTextFromFile("long-spec.md", Buffer.from(content));
  assert.ok("text" in result);
  assert.match(result.text, /開頭說明/);
  assert.match(result.text, /失敗時一定要通知主管/);
  assert.match(result.text, /保留檔案開頭與結尾/);
});

test("附件理解:ZIP 第一個檔案很大也不會讓所有內容變空", async () => {
  const zip = new AdmZip();
  zip.addFile("00-huge.log", Buffer.from("記錄\n".repeat(20_000)));
  zip.addFile("01-rule.md", Buffer.from("真正流程：讀取訂單後依金額分流"));
  const result = await extractTextFromFile("large-project.zip", zip.toBuffer());
  assert.ok("text" in result);
  assert.match(result.text, /00-huge\.log/);
  assert.match(result.text, /真正流程/);
});

test("附件理解:PDF/Word/RTF 共用長文頭尾保留，不會到建圖 API 才因內容過長失敗", async () => {
  const rtf = `{\\rtf1 開頭規格\\par ${"一般內容 ".repeat(8_000)}\\par 結尾規則：一定要人工核准}`;
  const result = await extractTextFromFile("large.rtf", Buffer.from(rtf));
  assert.ok("text" in result);
  assert.ok(result.text.length <= 45_000);
  assert.match(result.text, /開頭規格/);
  assert.match(result.text, /一定要人工核准/);
});

test("附件理解:UTF-16 文字檔不會被 NUL 位元誤判成二進位檔", async () => {
  const body = Buffer.from("流程規則：讀取訂單後通知主管", "utf16le");
  const result = await extractTextFromFile("rules.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
  assert.ok("text" in result);
  assert.match(result.text, /讀取訂單後通知主管/);
});

test("附件理解:大型多分頁 Excel 每個分頁都保留，不被第一頁吃光額度", async () => {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("第一頁");
  first.getCell("A1").value = `第一頁開頭 ${"甲".repeat(25_000)} 第一頁結尾`;
  const last = workbook.addWorksheet("最後規則頁");
  last.getCell("A1").value = `最後頁開頭 ${"乙".repeat(25_000)} 必須寄給主管`;
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const text = await xlsxToText(buffer);
  assert.ok(text.length <= 45_000);
  assert.match(text, /分頁「第一頁」/);
  assert.match(text, /分頁「最後規則頁」/);
  assert.match(text, /必須寄給主管/);
});
