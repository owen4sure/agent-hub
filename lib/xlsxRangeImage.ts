import ExcelJS from "exceljs";
import { cellRawValue, colLetters, colNum, cssColor, esc, formatByNumFmt, negativeIsRed, pointsToPx } from "./xlsxCellStyle";

/**
 * 把 Excel 的「某個分頁的某個範圍」畫成一張 PNG——用來取代「人工開檔案、框選、截圖、貼進簡報」。
 *
 * 跟 `xlsxRender`(整份檔案畫給 AI 看)刻意分成兩支的理由：那支的目標是「AI 看得懂」，
 * 可以截斷、可以省略樣式；這支的產物**會直接出現在給主管看的簡報上**，標準完全不同——
 * 合併儲存格、佈景主題色、數字格式、欄寬列高、框線顏色任何一項不對，貼上去就會被看出來。
 *
 * 三個「不做會出事」的重點：
 * ①**數字格式一定要套用**：Excel 存 0.2697、畫面顯示 26.98%。畫原始值等於貼一張沒人看得懂的圖。
 * ②**跨出範圍的合併儲存格要裁切**：合併區只有一半落在範圍內時，直接照原 colspan/rowspan 畫
 *   會把表格撐破(多出來的格子沒有內容，整列錯位)。
 * ③**錯誤格(#DIV/0! 這種)畫成空白，但一定要回報是哪幾格**：主管簡報上出現 #DIV/0! 很難看，
 *   但靜默吞掉錯誤正是這個 repo 反覆踩過的「表面成功」。所以畫空白 + 把清單回傳給呼叫端記錄。
 */

export interface RangeImageResult {
  /** PNG 的 base64(不含 data: 前綴) */
  imageBase64: string;
  /** 實際畫出來的範圍(正規化後，例如 "A3:G16") */
  range: string;
  rows: number;
  columns: number;
  /** 值是錯誤的儲存格(已畫成空白)。呼叫端要把它記進執行紀錄，不可以靜默吞掉。 */
  errorCells: string[];
}

export class XlsxRangeError extends Error {}

interface ParsedRange { r1: number; c1: number; r2: number; c2: number }

/** 解析 "A3:G16"、"a3:g16"、"A3"(單格)；解析不出來就老實報錯，不要猜一個範圍畫出來 */
export function parseRange(raw: string): ParsedRange {
  const text = String(raw ?? "").trim().toUpperCase().replace(/\$/g, "");
  const m = text.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
  if (!m) throw new XlsxRangeError(`看不懂這個範圍：「${raw}」——請用「A3:G16」這種寫法(左上角:右下角)`);
  const c1 = colNum(m[1]), r1 = Number(m[2]);
  const c2 = m[3] ? colNum(m[3]) : c1, r2 = m[4] ? Number(m[4]) : r1;
  return {
    r1: Math.min(r1, r2), r2: Math.max(r1, r2),
    c1: Math.min(c1, c2), c2: Math.max(c1, c2),
  };
}

export function formatRange(p: ParsedRange): string {
  return `${colLetters(p.c1)}${p.r1}:${colLetters(p.c2)}${p.r2}`;
}

interface MergeSpan { cs: number; rs: number }

/**
 * 算出範圍內每一格的「跨欄跨列」與「被覆蓋(不用畫)」。
 *
 * 合併區可能有一部分在範圍外——這時要**裁切**成範圍內的那一塊，並且把裁切後的左上角當成主格。
 * (真的會發生：使用者框選的範圍常常從表頭第一列開始，而上面幾列是跨到表頭的標題合併區。)
 */
export function planMerges(merges: string[], range: ParsedRange): { span: Map<string, MergeSpan>; covered: Set<string> } {
  const span = new Map<string, MergeSpan>();
  const covered = new Set<string>();
  for (const raw of merges) {
    const m = String(raw).toUpperCase().match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) continue;
    const mc1 = colNum(m[1]), mr1 = Number(m[2]), mc2 = colNum(m[3]), mr2 = Number(m[4]);
    // 裁切到範圍內
    const c1 = Math.max(mc1, range.c1), r1 = Math.max(mr1, range.r1);
    const c2 = Math.min(mc2, range.c2), r2 = Math.min(mr2, range.r2);
    if (c1 > c2 || r1 > r2) continue; // 完全在範圍外
    span.set(`${r1}:${c1}`, { cs: c2 - c1 + 1, rs: r2 - r1 + 1 });
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) if (!(r === r1 && c === c1)) covered.add(`${r}:${c}`);
    }
  }
  return { span, covered };
}

const DEFAULT_BORDER = "#000000";

/** Excel 的框線樣式 → CSS。虛線畫成實線會讓「分隔線」跟「區塊線」看起來一樣重，表格層次就不見了。 */
function borderCss(side: Partial<ExcelJS.Border> | undefined): string | null {
  if (!side?.style) return null;
  const style = side.style;
  const width = /thick|medium|double/.test(style) ? "2px" : "1px";
  const kind = /dotted/.test(style) ? "dotted" : /dash/.test(style) ? "dashed" : /double/.test(style) ? "double" : "solid";
  // 認不得的顏色一律當黑色(Excel 的預設框線就是黑的)，不要退成淺灰讓格線消失。
  const color = cssColor(side.color) ?? DEFAULT_BORDER;
  return `${width} ${kind} ${color}`;
}

/** 產生要截圖的 HTML(獨立出來才測得到——截圖本身需要 chromium，單元測試跑不動) */
export function rangeToHtml(sheet: ExcelJS.Worksheet, range: ParsedRange): { html: string; errorCells: string[] } {
  const merges = (sheet.model as unknown as { merges?: string[] }).merges ?? [];
  const { span, covered } = planMerges(merges, range);
  const errorCells: string[] = [];

  const cols: string[] = [];
  for (let c = range.c1; c <= range.c2; c++) {
    const w = sheet.getColumn(c).width;
    // exceljs 的 width 約當「幾個中文/英數字元寬」，×7px 是 Excel 預設字型(11pt)下的換算。
    // 這裡刻意用 **min-width** 而不是 width：那個換算是為 11pt 半形字調的，中文表常用 12/14pt
    // 微軟正黑體，同樣的欄寬換算出來會不夠，表頭就會被折成兩行——而 Excel 畫面上是一行。
    // 用最小寬度 + table-layout:auto，欄位至少有 Excel 的寬度、不夠時自己撐開，不會折行。
    cols.push(`<col style="min-width:${w ? Math.round(w * 7) + 6 : 64}px">`);
  }

  const rows: string[] = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const row = sheet.getRow(r);
    const tds: string[] = [];
    for (let c = range.c1; c <= range.c2; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = row.getCell(c);
      const st: string[] = [];

      const fill = cell.fill as ExcelJS.FillPattern | undefined;
      const bg = fill?.type === "pattern" ? cssColor(fill.fgColor) : null;
      if (bg) st.push(`background:${bg}`);

      const { value, isError } = cellRawValue(cell.value);
      if (isError) errorCells.push(`${colLetters(c)}${r}`);
      const text = isError ? "" : formatByNumFmt(value, cell.numFmt);

      let color = cssColor(cell.font?.color);
      if (typeof value === "number" && value < 0 && negativeIsRed(cell.numFmt)) color = "#ff0000";
      if (color) st.push(`color:${color}`);
      if (cell.font?.bold) st.push("font-weight:700");
      if (cell.font?.italic) st.push("font-style:italic");
      // 字級是「點」，要換算成像素；照抄數字會讓字明顯偏小、跟列高不成比例。
      if (cell.font?.size) st.push(`font-size:${pointsToPx(cell.font.size)}px`);
      // 字體照 Excel 指定的優先(中文表最常見的是微軟正黑體)，沒裝再退回系統的中文無襯線字體。
      if (cell.font?.name) st.push(`font-family:'${cell.font.name.replace(/['\\]/g, "")}','PingFang TC','Microsoft JhengHei','Noto Sans TC',sans-serif`);

      const b = cell.border;
      for (const [side, css] of [
        ["top", borderCss(b?.top)], ["bottom", borderCss(b?.bottom)],
        ["left", borderCss(b?.left)], ["right", borderCss(b?.right)],
      ] as const) {
        if (css) st.push(`border-${side}:${css}`);
      }

      const al = cell.alignment;
      // Excel 的預設對齊：數字靠右、文字靠左。沒有明確設定時照這個規則走，
      // 不然整張表會全部靠左，跟使用者看慣的樣子不一樣。
      const horizontal = al?.horizontal ?? (typeof value === "number" ? "right" : "left");
      st.push(`text-align:${horizontal}`);
      st.push(`vertical-align:${al?.vertical === "top" ? "top" : al?.vertical === "bottom" ? "bottom" : "middle"}`);
      // 刻意不套用 Excel 的 wrapText：欄位在這裡是「至少這麼寬、不夠會自己撐開」，
      // 撐開之後本來就不需要折行。照抄 wrapText 只會在寬度已經足夠時仍然折，反而不像 Excel 畫面。
      // 儲存格裡使用者自己打的換行(pre)仍然保留。

      const sp = span.get(`${r}:${c}`);
      const attr = sp ? `${sp.cs > 1 ? ` colspan="${sp.cs}"` : ""}${sp.rs > 1 ? ` rowspan="${sp.rs}"` : ""}` : "";
      tds.push(`<td${attr} style="${st.join(";")}">${esc(text)}</td>`);
    }
    const h = row.height ? ` style="height:${Math.round(row.height * 1.33)}px"` : "";
    rows.push(`<tr${h}>${tds.join("")}</tr>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    body{margin:0;padding:0;background:#fff;
         font-family:'PingFang TC','Microsoft JhengHei','Noto Sans TC','Helvetica Neue',Arial,sans-serif;}
    table{border-collapse:collapse;table-layout:auto;background:#fff;}
    /* white-space:pre = 保留儲存格裡的手動換行，但不自動折行(欄位會自己撐開) */
    td{padding:2px 6px;font-size:13px;color:#000;white-space:pre;line-height:1.25;}
  </style></head><body><table><colgroup>${cols.join("")}</colgroup>${rows.join("")}</table></body></html>`;
  return { html, errorCells };
}

/**
 * 把指定分頁的指定範圍畫成 PNG。
 *
 * 失敗一律 throw(不像 `xlsxRender` 可以回 null 降級)——這張圖是要貼上簡報的產物，
 * 「畫不出來」必須讓流程停下來被看見，不能默默略過讓簡報停在上週的舊圖。
 */
export async function renderXlsxRangeToImage(
  buffer: Buffer,
  sheetName: string,
  rangeText: string,
  opts: { scale?: number } = {},
): Promise<RangeImageResult> {
  const range = parseRange(rangeText);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch (err) {
    throw new XlsxRangeError(`這個檔案讀不開，可能不是 Excel 檔或已損毀：${err instanceof Error ? err.message : String(err)}`);
  }
  const sheet = wb.getWorksheet(sheetName);
  if (!sheet) {
    const names = wb.worksheets.map((w) => w.name).join("、");
    throw new XlsxRangeError(`這個檔案裡沒有叫「${sheetName}」的分頁。實際有的分頁：${names}`);
  }
  const { html, errorCells } = rangeToHtml(sheet, range);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    // 3 倍解析度：這張圖會在簡報上被放大檢視，2 倍在投影時看得出鋸齒。
    const page = await browser.newPage({ deviceScaleFactor: Math.min(4, Math.max(1, opts.scale ?? 3)) });
    // 表格 HTML 全是本地生成、零外部資源；但內容來自使用者的檔案，一律封網(跟 xlsxRender 同樣的理由)。
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "load" });
    const table = await page.$("table");
    if (!table) throw new XlsxRangeError("表格沒有渲染出來(範圍可能是空的)");
    const shot = await table.screenshot({ type: "png" });
    return {
      imageBase64: Buffer.from(shot).toString("base64"),
      range: formatRange(range),
      rows: range.r2 - range.r1 + 1,
      columns: range.c2 - range.c1 + 1,
      errorCells,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
