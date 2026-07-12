import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import ExcelJS from "exceljs";
import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr, cfgNum } from "../nodeHelpers";

/** 把日期欄的值正規化成 YYYYMMDD 數字(吃 20260701 數字、Date 物件、"2026-07-01"/"2026/7/1" 字串)；不是日期回 0 */
function toYYYYMMDD(v: unknown): number {
  if (v instanceof Date) return v.getFullYear() * 10000 + (v.getMonth() + 1) * 100 + v.getDate();
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === "string") {
    const m = v.match(/(\d{4})\D?(\d{1,2})\D?(\d{1,2})/);
    if (m) return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
    const n = Number(v.replace(/\D/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 把公式儲存格換成「當時算好的靜態值」，不保留公式本身。
 * 這個節點會篩掉不符合日期區間的列、把剩下的列重新編號存進新檔——公式若原樣複製，
 * 裡面引用的儲存格座標(如 =E5*F5)、共用公式(sharedFormula 指向的 master 位址)都會對到錯的列，
 * 輕則 #REF!，重則算出錯的數字卻看起來正常。篩選後的報表本來就是「當下這份資料的快照」，
 * 用公式當時的結果取代公式本身才是正確、安全的行為。
 */
function staticCellValue(v: ExcelJS.CellValue): ExcelJS.CellValue {
  if (v && typeof v === "object" && !(v instanceof Date) && ("formula" in v || "sharedFormula" in v)) {
    const result = (v as { result?: unknown }).result;
    if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
      return String((result as { error: unknown }).error);
    }
    return (result as ExcelJS.CellValue) ?? "";
  }
  return v;
}

function colLetterToNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numToColLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** 解析合併儲存格範圍字串(如 "A1:F1")；解析不了就回 null */
function parseMergeRange(range: string): { c1: number; r1: number; c2: number; r2: number } | null {
  const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { c1: colLetterToNum(m[1]), r1: Number(m[2]), c2: colLetterToNum(m[3]), r2: Number(m[4]) };
}

function findHeaderRow(sheet: ExcelJS.Worksheet, headerText: string): number {
  for (let r = 1; r <= Math.min(sheet.rowCount, 20); r++) {
    if (String(sheet.getRow(r).getCell(1).value ?? "").trim() === headerText) return r;
  }
  throw new PermanentError(`找不到標題列(第一欄應為「${headerText}」)`);
}

/** 依標題文字找出某欄的欄號(1-based)；找不到回 0 */
function findColumnByHeader(sheet: ExcelJS.Worksheet, headerRow: number, colCount: number, headerText: string): number {
  for (let c = 1; c <= colCount; c++) {
    if (String(sheet.getRow(headerRow).getCell(c).value ?? "").trim() === headerText) return c;
  }
  return 0;
}

/**
 * 讀 Excel 附件 → 選分頁 → 依日期區間篩列 → 複製(保留原本格式) →
 * 只把「指定的那一欄」(預設『已完成』)整欄畫上橘色 highlight → 另存新檔。
 *
 * 注意(這是之前理解錯的地方)：使用者要的是「把指定的某一欄整欄 highlight」，
 * 不是「把符合日期的整列都 highlight」。所以這裡用 highlightColumn 指定要標的欄，只標那一欄。
 */
export const excelProcessNode: NodeDefinition = {
  type: "excel-process",
  category: "data",
  label: "Excel 篩選+highlight",
  description:
    "打開上游下載的 Excel，選指定分頁，依日期區間篩選資料列(保留原格式)，把指定的某一欄(如『已完成』)整欄標上橘色，另存成新檔。",
  icon: "📊",
  configSchema: [
    { key: "inputPath", label: "來源 Excel 路徑", type: "text", default: "{{attachmentPath}}" },
    { key: "sheet", label: "分頁名稱", type: "text", default: "工作表1" },
    { key: "headerText", label: "標題列第一欄的字", type: "text", default: "日期" },
    { key: "dateColumn", label: "日期在第幾欄", type: "number", default: "1" },
    { key: "filterStart", label: "篩選區間開始", type: "date-or-token", default: "{{last-quarter-start}}" },
    { key: "filterEnd", label: "篩選區間結束", type: "date-or-token", default: "{{last-quarter-end}}" },
    { key: "highlightColumn", label: "要 highlight 的欄(標題文字)", type: "text", default: "已完成" },
    { key: "highlight", label: "Highlight 顏色(hex)", type: "text", default: "FFC000" },
    { key: "outputName", label: "輸出檔名(不含.xlsx)", type: "text", default: "output" },
  ],
  outputs: "outputPath(產出檔路徑), filename(檔名), rowCount(筆數)",
  retryable: false,
  async execute(ctx) {
    const inputPath = cfgStr(ctx, "inputPath");
    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new PermanentError(`找不到來源 Excel：${inputPath}`);
    }
    const sheetName = cfgStr(ctx, "sheet");
    const headerText = cfgStr(ctx, "headerText", "日期");
    const dateCol = cfgNum(ctx, "dateColumn", 1);
    // 用同檔健全的 toYYYYMMDD() 正規化，不要自己陽春地 replace("-")+Number——後者遇到
    // 2026/01/01 或 2026.01.01 這種分隔符會變 NaN，害整個日期篩選失效(篩不到任何資料)。
    const startNum = toYYYYMMDD(cfgStr(ctx, "filterStart"));
    const endNum = toYYYYMMDD(cfgStr(ctx, "filterEnd"));
    const highlightColumnName = cfgStr(ctx, "highlightColumn", "已完成");
    const argb = "FF" + cfgStr(ctx, "highlight", "FFC000").replace(/^#/, "").toUpperCase();
    const outputName = cfgStr(ctx, "outputName", "output");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(inputPath);
    const sheet = wb.getWorksheet(sheetName);
    if (!sheet) {
      const actual = wb.worksheets.map((s) => s.name).join("、") || "(這個檔案沒有任何分頁)";
      throw new PermanentError(`找不到分頁「${sheetName}」。這個檔案實際的分頁有：${actual}`);
    }

    const headerRowIndex = findHeaderRow(sheet, headerText);
    const colCount = sheet.columnCount;

    // 找出要 highlight 的欄(如『已完成』)
    const targetCol = highlightColumnName
      ? findColumnByHeader(sheet, headerRowIndex, colCount, highlightColumnName)
      : 0;
    if (highlightColumnName && targetCol === 0) {
      const headers: string[] = [];
      for (let c = 1; c <= colCount; c++) headers.push(String(sheet.getRow(headerRowIndex).getCell(c).value ?? ""));
      throw new PermanentError(`找不到要 highlight 的欄「${highlightColumnName}」。這個分頁的欄位有：${headers.filter(Boolean).join("、")}`);
    }
    ctx.log(`要 highlight 的欄：${highlightColumnName}(第 ${targetCol} 欄)`);

    // 收集標題列 + 符合日期區間的資料列(連同來源格式一起帶)。
    // 日期欄可能是純數字(YYYYMMDD)、Excel 日期物件、或 "2026-07-01" 字串，都正規化成 YYYYMMDD 再比。
    const srcRowIndexes: number[] = [headerRowIndex];
    for (let r = headerRowIndex + 1; r <= sheet.rowCount; r++) {
      // 日期欄若是公式儲存格，.value 是 {formula,result} 物件——直接丟給 toYYYYMMDD 會落到 return 0，
      // 整欄被當 0、篩不到任何資料(假的「區間內沒有資料」)。先用 staticCellValue 取出算好的 result 再正規化。
      const dv = toYYYYMMDD(staticCellValue(sheet.getRow(r).getCell(dateCol).value));
      if (dv && dv >= startNum && dv <= endNum) srcRowIndexes.push(r);
    }
    const dataCount = srcRowIndexes.length - 1;
    ctx.log(`篩選日期區間 ${startNum} ~ ${endNum}，共 ${dataCount} 筆符合`);
    if (dataCount === 0) throw new PermanentError("篩選區間內沒有資料，請確認日期區間或來源檔");

    const outWb = new ExcelJS.Workbook();
    const outSheet = outWb.addWorksheet("工作表1");

    // 保留來源欄寬
    for (let c = 1; c <= colCount; c++) {
      const w = sheet.getColumn(c).width;
      if (w) outSheet.getColumn(c).width = w;
    }

    // srcR(來源列號) → outR(輸出列號)，之後remap合併儲存格要用
    const rowMap = new Map<number, number>();
    srcRowIndexes.forEach((srcR, outIdx) => rowMap.set(srcR, outIdx + 1));

    srcRowIndexes.forEach((srcR, outIdx) => {
      const outR = outIdx + 1;
      const srcRow = sheet.getRow(srcR);
      const outRow = outSheet.getRow(outR);
      if (srcRow.height) outRow.height = srcRow.height;
      for (let c = 1; c <= colCount; c++) {
        const srcCell = srcRow.getCell(c);
        const outCell = outRow.getCell(c);
        // 公式換成算好的靜態值，不搬公式本身(見 staticCellValue 註解：篩選後列號會變，公式引用會對錯位)
        outCell.value = staticCellValue(srcCell.value);
        // 複製原本格式(字型/填色/框線/對齊)，貼上時保留樣式
        if (srcCell.style) outCell.style = JSON.parse(JSON.stringify(srcCell.style));
      }
      outRow.commit();
    });

    // 保留合併儲存格：只有當一個合併範圍裡「每一列」都有被留下來才能保留(範圍中間有列被篩掉就無法對應，乾脆跳過那一個合併，
    // 避免半殘的合併造成更詭異的版面)。欄一定都保留(每欄都複製)，只有列需要remap。
    for (const range of sheet.model.merges ?? []) {
      const parsed = parseMergeRange(range);
      if (!parsed) continue;
      const rows: number[] = [];
      let allPresent = true;
      for (let r = parsed.r1; r <= parsed.r2; r++) {
        const outR = rowMap.get(r);
        if (outR === undefined) { allPresent = false; break; }
        rows.push(outR);
      }
      if (!allPresent || rows.length === 0) continue;
      const outR1 = Math.min(...rows);
      const outR2 = Math.max(...rows);
      try {
        outSheet.mergeCells(`${numToColLetter(parsed.c1)}${outR1}:${numToColLetter(parsed.c2)}${outR2}`);
      } catch { /* 合併範圍衝突(理論上不會發生)就略過，不影響資料正確性 */ }
    }

    // 只把目標欄整欄(含標題)畫上橘色
    if (targetCol > 0) {
      for (let outR = 1; outR <= srcRowIndexes.length; outR++) {
        outSheet.getRow(outR).getCell(targetCol).fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb },
        };
      }
    }

    const filename = `${outputName}.xlsx`;
    const outputPath = path.join(ctx.outputDir, filename);
    await outWb.xlsx.writeFile(outputPath);
    ctx.log(`已存檔：${outputPath}`);
    ctx.registerFile(filename, outputPath, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    let desktopPath: string | null = null;
    try {
      desktopPath = path.join(os.homedir(), "Desktop", filename);
      fs.copyFileSync(outputPath, desktopPath);
      ctx.log(`已複製到桌面：${desktopPath}`);
    } catch {
      desktopPath = null;
    }

    return { output: { outputPath, desktopPath, rowCount: dataCount, filename } };
  },
};
