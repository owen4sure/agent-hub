import ExcelJS from "exceljs";
import { renderXlsxRangeToImage } from "./xlsxRangeImage";

/**
 * 自我測試要貼上去的那張圖。
 *
 * 為什麼要獨立成一個模組(而不是留在 API 路由裡)：這張圖**就是使用者用來判斷「他到底會不會做」
 * 的那個證據**。如果它是空白的、或根本沒畫出來，那整個自我測試就變成「系統說成功了」——
 * 正是這個 repo 最不能接受的那種假成功。獨立出來才測得到它真的畫出東西。
 *
 * 刻意用一份**現場產生的假資料**，不碰使用者的任何檔案：自我測試的重點是驗證「換圖這條路通不通」，
 * 沒有理由為此讀取真實的營運資料，也不該把它送去 Google 的另一份簡報上。
 */
export async function buildSelfTestImage(): Promise<{ base64: string; width: number; height: number }> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("測試");
  sheet.columns = [{ width: 18 }, { width: 12 }, { width: 14 }];
  const rows: (string | number)[][] = [
    ["Agent Hub 換圖測試", "數量", "金額"],
    ["項目甲", 12, 3456],
    ["項目乙", 7, 890],
    ["合計", 19, 4346],
  ];
  for (const row of rows) sheet.addRow(row);
  for (let r = 1; r <= rows.length; r++) {
    sheet.getRow(r).height = 22;
    for (let c = 1; c <= 3; c++) {
      const cell = sheet.getCell(r, c);
      cell.border = {
        top: { style: "thin", color: { argb: "FF000000" } },
        bottom: { style: "thin", color: { argb: "FF000000" } },
        left: { style: "thin", color: { argb: "FF000000" } },
        right: { style: "thin", color: { argb: "FF000000" } },
      };
      cell.alignment = { horizontal: c === 1 ? "left" : "right", vertical: "middle" };
      cell.font = { size: 12, name: "PingFang TC" };
      if (r === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF002060" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 12, name: "PingFang TC" };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      } else if (c > 1) {
        cell.numFmt = "#,##0";
      }
    }
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const rendered = await renderXlsxRangeToImage(buffer, "測試", `A1:C${rows.length}`, { scale: 2 });
  return { base64: rendered.imageBase64, width: rendered.columns, height: rendered.rows };
}

/**
 * 自我測試「替換前」的那張佔位圖。
 *
 * 為什麼要在這裡產、而不是寫死在 Apps Script 範本裡：**手寫二進位一定會出錯**——
 * 第一版我直接在範本裡塞了一段自己拼的 base64 PNG，CRC 全是壞的，Google 回
 * 「您嘗試使用的圖片無效或已損毀」。圖片這種東西要用真的影像函式庫產，不能用手拼。
 *
 * 用純灰色是刻意的：換成表格圖之後對比極強，一眼就知道「真的換過了」。
 */
export async function buildSelfTestPlaceholder(): Promise<string> {
  const sharp = (await import("sharp")).default;
  const png = await sharp({
    create: { width: 600, height: 236, channels: 3, background: { r: 158, g: 158, b: 158 } },
  }).png().toBuffer();
  return png.toString("base64");
}
