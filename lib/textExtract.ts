import AdmZip from "adm-zip";
import pdfParse from "pdf-parse";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import WordExtractor from "word-extractor";
import { simpleParser } from "mailparser";

/**
 * 把 RTF 轉成純文字。RTF 是控制字(\word)+群組({...})構成的格式，
 * 用「堆疊追蹤群組是否為忽略目的地(fonttbl/colortbl/stylesheet/pict/…或任何 {\*...})」的方式逐字掃描，
 * 而不是單純用正則把控制字全部拿掉——不然字型表/顏色表裡的名稱(如 "Helvetica;Arial;")會被誤當成內文。
 */
const IGNORABLE_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "generator", "pict", "object",
  "header", "footer", "footnote", "annotation", "field", "themedata", "colorschememapping",
  "listtable", "listoverridetable", "rsidtbl", "datastore", "xmlnstbl",
]);

function peekWordAt(rtf: string, j: number): string {
  if (rtf[j] !== "\\") return "";
  let k = j + 1;
  let w = "";
  while (k < rtf.length && /[a-zA-Z]/.test(rtf[k])) { w += rtf[k]; k++; }
  return w;
}

/** RTF 的 \ansicpgN 編碼頁 → TextDecoder 認得的名稱，用來把 \'hh 位元組正確解回中文/日文等 */
function codepageToEncoding(cp: number): string {
  const map: Record<number, string> = {
    65001: "utf-8", 1252: "windows-1252", 950: "big5", 936: "gbk", 932: "shift_jis", 949: "euc-kr", 1251: "windows-1251",
  };
  return map[cp] ?? "windows-1252";
}

export function rtfToText(rtf: string): string {
  let i = 0;
  const n = rtf.length;
  let out = "";
  // uc = 「\uN 之後要跳過幾個備援字元」，預設 1，可被 \ucN 改；隨群組繼承。ignorable = 是否為要忽略的目的地群組。
  const groupStack: { ignorable: boolean; uc: number }[] = [{ ignorable: false, uc: 1 }];
  const cpMatch = rtf.match(/\\ansicpg(\d+)/);
  const decoder = new TextDecoder(codepageToEncoding(cpMatch ? Number(cpMatch[1]) : 1252), { fatal: false });

  // \'hh 是「某編碼頁下的一個 byte」，中文常是連續兩個 byte 才組成一個字，所以先收集連續的 byte，
  // 遇到非 \'hh 的 token 再一次解碼，才不會把 big5 的兩個 byte 各自誤解成兩個亂碼字元。
  let pendingBytes: number[] = [];
  const flushBytes = () => {
    if (pendingBytes.length === 0) return;
    out += decoder.decode(new Uint8Array(pendingBytes), { stream: false });
    pendingBytes = [];
  };
  const cur = () => groupStack[groupStack.length - 1];
  const emit = (s: string) => { flushBytes(); if (!cur().ignorable) out += s; };

  // 跳過 \uN 後面的 uc 個「備援字元」——不跳的話中文每個字後面都會多一個 ? 或亂碼(最常見的中文 RTF 損壞)
  const skipFallback = (count: number) => {
    let skipped = 0;
    while (skipped < count && i < n) {
      if (rtf[i] === "\\") {
        if (rtf[i + 1] === "'") { i += 4; skipped++; continue; } // \'hh 算一個
        if (/[a-zA-Z]/.test(rtf[i + 1])) { // 一個控制字算一個
          i++; while (i < n && /[a-zA-Z]/.test(rtf[i])) i++;
          if (rtf[i] === "-") i++; while (i < n && /\d/.test(rtf[i])) i++;
          if (rtf[i] === " ") i++;
          skipped++; continue;
        }
        i += 2; skipped++; continue; // 控制符號
      }
      if (rtf[i] === "{" || rtf[i] === "}") break; // 群組邊界不算備援字元
      i++; skipped++;
    }
  };

  while (i < n) {
    const ch = rtf[i];

    if (ch === "{") {
      flushBytes();
      i++;
      const parent = cur();
      let ignorable = parent.ignorable;
      if (!ignorable) {
        if (rtf[i] === "\\" && rtf[i + 1] === "*") ignorable = true;
        else {
          const word = peekWordAt(rtf, i);
          if (word && IGNORABLE_DESTINATIONS.has(word)) ignorable = true;
        }
      }
      groupStack.push({ ignorable, uc: parent.uc }); // uc 繼承自父群組
      continue;
    }
    if (ch === "}") {
      flushBytes();
      if (groupStack.length > 1) groupStack.pop();
      i++;
      continue;
    }

    if (ch === "\\") {
      i++;
      if (rtf[i] === "*") { i++; continue; }
      if (rtf[i] === "'") {
        const hex = rtf.slice(i + 1, i + 3);
        i += 3;
        const b = parseInt(hex, 16);
        if (!cur().ignorable && !Number.isNaN(b)) pendingBytes.push(b); // 累積 byte，等下一個非 \'hh token 再解碼
        continue;
      }
      if (/[a-zA-Z]/.test(rtf[i])) {
        let word = "";
        while (i < n && /[a-zA-Z]/.test(rtf[i])) { word += rtf[i]; i++; }
        let numStr = "";
        if (rtf[i] === "-") { numStr += "-"; i++; }
        while (i < n && /\d/.test(rtf[i])) { numStr += rtf[i]; i++; }
        if (rtf[i] === " ") i++;
        if (word === "uc") { cur().uc = Number(numStr) || 0; continue; }
        if (word === "bin" && numStr) { flushBytes(); i += Math.max(0, Number(numStr)); continue; } // 跳過 N 個原始 binary byte，別當文字解析
        if (word === "par" || word === "line") emit("\n");
        else if (word === "tab") emit("\t");
        else if (word === "u" && numStr) {
          let code = parseInt(numStr, 10);
          if (code < 0) code += 65536;
          emit(String.fromCharCode(code));
          skipFallback(cur().uc); // 關鍵：跳掉 \uN 後面的備援字元
        }
        continue;
      }
      const sym = rtf[i]; i++;
      if (sym === "~") emit(" ");
      else if (sym === "\\" || sym === "{" || sym === "}") emit(sym);
      else if (sym === "\n" || sym === "\r") emit("\n"); // \<換行> = 段落
      continue;
    }

    if (ch === "\r" || ch === "\n") { i++; continue; } // 原始換行不是內容(RTF 用 \par 表示段落)
    if (!cur().ignorable) emit(ch);
    else { flushBytes(); i++; continue; }
    i++;
  }
  flushBytes();
  return out.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** 把 DOCX(其實是 zip，裡面 word/document.xml 存正文)抽成純文字 */
export function docxToText(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry("word/document.xml");
  if (!entry) throw new Error("這個檔案不是有效的 .docx(找不到 word/document.xml)");
  if ((Number(entry.header.size) || 0) > 20 * 1024 * 1024) throw new Error("這份 Word 文件解壓後內容過大，為避免耗盡記憶體已停止解析");
  const xml = entry.getData().toString("utf8");
  if (Buffer.byteLength(xml) > 20 * 1024 * 1024) throw new Error("這份 Word 文件解壓後內容過大，為避免耗盡記憶體已停止解析");
  // <w:p> 是段落、<w:tab/> 是 tab、<w:br/> 是換行；先把這些換成對應的純文字符號，再把其餘標籤全部拿掉
  let text = xml
    .replace(/<w:p\b[^>]*>/g, "\n")
    .replace(/<w:tab\b[^>]*\/>/g, "\t")
    .replace(/<w:br\b[^>]*\/>/g, "\n")
    .replace(/<[^>]+>/g, "");
  text = text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

const MAX_ROWS_PER_SHEET = 60;
// 真實報表常有上百欄,而「關鍵欄位」(例如當日新增、某分類段的指標)往往落在很後面的欄——
// 砍在 40 欄的話,AI 拿到的檔案內容根本看不到那些欄,只會抓到前面的欄(常常是錯的累積欄)。
// 放寬到 200 欄;為了不讓「又寬又長的表」抽出的文字爆掉 token,再用「總格數上限」動態壓低顯示列數
// (欄一定要夠寬讓 AI 看到全部欄位名+判斷每欄是當日還是累積;列夠幾筆看出型態就好,不用全部)。
const MAX_COLS_PER_SHEET = 200;
// AI 真正需要的是「欄位對照(結構)」——資料列只要幾筆看得出型態(當日的小數字 vs 累積的大數字)就夠。
// 塞太多原始資料列會讓建圖 prompt 爆大(141 欄 x 幾百列 x 7 分頁 = 幾百 KB),免費 gateway 直接 504、
// 備援又慢,建一次圖拖好幾分鐘。所以:欄位對照完整留,資料列壓少,總量控制在能快速送進模型的範圍。
const MAX_CELLS_PER_SHEET = 1200;
const MAX_TOTAL_CHARS = 45_000;
const MAX_ZIP_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 20 * 1024 * 1024;
/** 依實際欄數動態算「要顯示幾列」:欄愈多、列愈少(結構靠欄位對照,資料列只要幾筆看出型態),至少留 6 列 */
function rowLimitForWidth(rowCount: number, colLimit: number): number {
  const byCells = Math.max(6, Math.floor(MAX_CELLS_PER_SHEET / Math.max(1, colLimit)));
  return Math.min(rowCount, MAX_ROWS_PER_SHEET, byCells);
}
/** 把各分頁的文字段落組起來,超過總上限就截斷並註明——避免抽出的文字爆 token */
function joinSectionsWithinBudget(sections: string[]): string {
  if (sections.length === 0) return "";
  const joined = sections.join("\n\n");
  if (joined.length <= MAX_TOTAL_CHARS) return joined.trim();
  // 不能讓第一個超大分頁吃掉全部預算，也不能因為它一頁就超額而整頁消失。
  // 把額度公平分給每一頁，每頁各保留頭尾；這樣最後一頁的規則與每個 sheet 名都還看得到。
  const separators = Math.max(0, sections.length - 1) * 2;
  const perSection = Math.max(350, Math.floor((MAX_TOTAL_CHARS - separators) / sections.length));
  return sections.map((section) => excerptLongText(section, perSection)).join("\n\n").slice(0, MAX_TOTAL_CHARS).trim();
}

/** 把一個儲存格的值轉成純文字(處理日期/公式結果/超連結/錯誤/富文字等 ExcelJS 的各種物件形態) */
function cellToText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("error" in o) return String(o.error); // 錯誤儲存格如 #N/A、#DIV/0!
    if ("result" in o) return String(o.result ?? ""); // 公式：取算好的結果
    if ("richText" in o) return (o.richText as { text: string }[]).map((t) => t.text).join(""); // 富文字
    if ("text" in o) return String(o.text); // 超連結儲存格 {text, hyperlink}
    if ("hyperlink" in o) return String(o.hyperlink);
    return ""; // 未知物件形態別印成 [object Object]
  }
  return String(v);
}

function colLetter(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * 抽出一個分頁的「版型格式」摘要：欄寬、合併儲存格、以及有特別樣式(填色/粗體/框線/對齊)的儲存格。
 * 為什麼需要：純文字只有值，看不到顏色/框線/欄寬——AI 因此會說「沒辦法做出一樣的版型」。
 * 把這些格式描述出來，AI 才能用 exceljs 重現一模一樣的包框、顏色、欄寬(使用者的核心需求)。
 * 只列「非預設」的部分並設上限，避免灌爆提示。
 */
function sheetStyleSummary(sheet: ExcelJS.Worksheet): string {
  const parts: string[] = [];
  const colLimit = Math.min(sheet.columnCount, MAX_COLS_PER_SHEET);

  // 欄寬(只列有設定過的)
  const widths: string[] = [];
  for (let c = 1; c <= colLimit; c++) {
    const w = sheet.getColumn(c).width;
    if (typeof w === "number") widths.push(`${colLetter(c)}=${Math.round(w * 10) / 10}`);
  }
  if (widths.length) parts.push(`  欄寬：${widths.join("、")}`);

  // 合併儲存格
  try {
    const merges = (sheet.model as unknown as { merges?: string[] }).merges;
    if (Array.isArray(merges) && merges.length) parts.push(`  合併儲存格：${merges.slice(0, 60).join("、")}`);
  } catch { /* 某些檔沒有 merges 資訊 */ }

  // 有特別樣式的儲存格(填色/粗體/框線/對齊)
  const styled: string[] = [];
  const rowLimit = Math.min(sheet.rowCount, MAX_ROWS_PER_SHEET);
  for (let r = 1; r <= rowLimit && styled.length < 200; r++) {
    for (let c = 1; c <= colLimit && styled.length < 200; c++) {
      const cell = sheet.getRow(r).getCell(c);
      const desc: string[] = [];
      // 顏色可能是 argb 色碼，也可能是「主題色」(theme:N)——Excel 的白字、佈景主題配色常用 theme 存，
      // 只抓 argb 會整個漏掉(踩過:深色底配白字，白字是 theme 存的，AI 因此不知道要用白字)。兩種都要抓。
      const describeColor = (raw: unknown): string | null => {
        // exceljs 的 Color 型別沒宣告 tint，用寬鬆型別讀 argb/theme/tint
        const col = raw as { argb?: string; theme?: number; tint?: number } | undefined;
        if (!col) return null;
        if (col.argb) return `#${col.argb}`;
        if (typeof col.theme === "number") {
          // 主題色1=文字1(通常黑)且沒 tint = 預設黑字，當成沒特別設(不然幾乎每格都印一條變雜訊)
          if (col.theme === 1 && !col.tint) return null;
          const hint = col.theme === 0 ? "(通常白)" : col.theme === 1 ? "(通常黑)" : "";
          return `主題色${col.theme}${hint}${col.tint ? `,tint${Math.round(col.tint * 100) / 100}` : ""}`;
        }
        return null;
      };
      const fill = cell.fill as ExcelJS.FillPattern | undefined;
      const fillDesc = fill?.type === "pattern" ? describeColor(fill.fgColor) : null;
      if (fillDesc && fillDesc !== "#FFFFFFFF" && fillDesc !== "#00000000") desc.push(`填色${fillDesc}`);
      const font = cell.font;
      if (font?.bold) desc.push("粗體");
      const fontDesc = describeColor(font?.color);
      if (fontDesc && fontDesc !== "#FF000000") desc.push(`字色${fontDesc}`);
      const b = cell.border;
      if (b && (b.top || b.bottom || b.left || b.right)) {
        const all = b.top && b.bottom && b.left && b.right;
        desc.push(all ? "四周框線" : "部分框線");
      }
      const al = cell.alignment;
      if (al?.horizontal && al.horizontal !== "left") desc.push(`水平${al.horizontal}`);
      if (al?.wrapText) desc.push("自動換行");
      if (desc.length) styled.push(`    ${colLetter(c)}${r}：${desc.join("、")}`);
    }
  }
  if (styled.length) parts.push(`  有特別格式的儲存格：\n${styled.join("\n")}${styled.length >= 200 ? "\n    …(格式儲存格較多，只列前 200 個)" : ""}`);

  return parts.length ? `【分頁「${sheet.name}」的版型格式(要做出一樣的版型時照這個重現)】\n${parts.join("\n")}` : "";
}

/** 欄位對照:給 AI 一份「欄位代號 → 這欄的標題/分類」清單,讓它能精準指名某一欄(例如 C=每日新增筆數/類別A),
 *  而不是去數一整列裡第幾個 tab——當同一個欄名重複出現(累積版 vs 當日新增版)時,靠上方的分類區分是能不能讀對的關鍵。
 *  標題不一定在第 1 列,所以取前幾列的「文字型」值合併當這一欄的說明(純數字/日期是資料,不算標題)。 */
function columnMap(sheet: ExcelJS.Worksheet, colLimit: number): string {
  const depth = Math.min(4, sheet.rowCount);
  const entries: string[] = [];
  for (let c = 1; c <= colLimit; c++) {
    const labels: string[] = [];
    for (let r = 1; r <= depth; r++) {
      const t = cellToText(sheet.getRow(r).getCell(c).value).trim();
      if (t && !/^[\d.,\-/:\s]+$/.test(t) && !labels.includes(t)) labels.push(t);
    }
    if (labels.length) entries.push(`${colLetter(c)}=${labels.join("/")}`);
  }
  return entries.length ? `【欄位對照(欄位代號→標題;同名欄看分類區分「累積」還是「當日新增」)】\n${entries.join(" | ")}` : "";
}

/** 把 Excel(.xlsx) 每個分頁轉成「分頁名 + 欄位對照 + 表格文字 + 版型格式」，讓 AI 看得懂結構、內容、也看得到顏色/框線/欄寬。 */
export async function xlsxToText(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  if (wb.worksheets.length === 0) throw new Error("這個 Excel 檔裡沒有任何分頁");
  const sections: string[] = [];
  for (const sheet of wb.worksheets) {
    // columnCount 遇到「曾經在很遠的欄打過字/整欄套過格式」會暴增到上萬——一定要設上限，
    // 不然一列會塞上萬個 tab、抽出的文字爆到幾百 KB，之後送 AI 又會撞到參數/token 上限。
    const colLimit = Math.min(sheet.columnCount, MAX_COLS_PER_SHEET);
    const lines: string[] = [`【分頁「${sheet.name}」，共 ${sheet.rowCount} 列 x ${sheet.columnCount} 欄】`];
    const map = columnMap(sheet, colLimit);
    if (map) lines.push(map);
    const rowLimit = rowLimitForWidth(sheet.rowCount, colLimit);
    for (let r = 1; r <= rowLimit; r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= colLimit; c++) cells.push(cellToText(row.getCell(c).value));
      if (cells.some((c) => c.trim() !== "")) lines.push(cells.join("\t"));
    }
    if (sheet.columnCount > colLimit) lines.push(`(欄數較多，只顯示前 ${colLimit} 欄)`);
    if (sheet.rowCount > rowLimit) lines.push(`…(其餘 ${sheet.rowCount - rowLimit} 列略，只顯示前 ${rowLimit} 列)`);
    const style = sheetStyleSummary(sheet);
    sections.push(lines.join("\n") + (style ? "\n\n" + style : ""));
  }
  return joinSectionsWithinBudget(sections);
}

/** 把 PowerPoint(.pptx，其實是 zip，每張投影片是 ppt/slides/slideN.xml)每張的文字抽出來。 */
export function pptxToText(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  // 投影片檔名是 slide1.xml、slide2.xml…，要按數字排序(不是字串排序，不然 slide10 會排在 slide2 前面)
  const slides = zip
    .getEntries()
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const na = Number(a.entryName.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.entryName.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb;
    })
    .slice(0, 100);
  if (slides.length === 0) throw new Error("這個檔案不是有效的 .pptx(找不到任何投影片)");
  const sections: string[] = [];
  let expandedBytes = 0;
  for (const [idx, entry] of slides.entries()) {
    const declaredSize = Number(entry.header.size) || 0;
    if (declaredSize > 5 * 1024 * 1024 || expandedBytes + declaredSize > 20 * 1024 * 1024) continue;
    const xml = entry.getData().toString("utf8");
    const actualSize = Buffer.byteLength(xml);
    if (actualSize > 5 * 1024 * 1024 || expandedBytes + actualSize > 20 * 1024 * 1024) continue;
    expandedBytes += actualSize;
    // 投影片上的文字都在 <a:t>...</a:t> 裡；把每一段抓出來，還原 XML 跳脫字元
    const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) =>
      m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
    );
    const body = texts.join("\n").trim();
    if (body) sections.push(`【第 ${idx + 1} 張投影片】\n${body}`);
  }
  return joinSectionsWithinBudget(sections);
}

/** 舊版 Excel(.xls，二進位 BIFF 格式)用 SheetJS 讀出來，每個分頁轉成表格文字(沿用 xlsx 的列/欄上限)。 */
export function xlsToText(buffer: Buffer): string {
  const wb = XLSX.read(buffer, { type: "buffer" });
  if (wb.SheetNames.length === 0) throw new Error("這個 Excel 檔裡沒有任何分頁");
  const sections: string[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    // sheet_to_json 出來是每列一個陣列；統一走跟 .xlsx 一樣的「前 N 列、前 N 欄、tab 分隔」呈現
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: "" });
    const widest = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    const colLimit = Math.min(widest, MAX_COLS_PER_SHEET);
    const lines: string[] = [`【分頁「${name}」，共 ${rows.length} 列 x ${widest} 欄】`];
    const rowLimit = rowLimitForWidth(rows.length, colLimit);
    for (let r = 0; r < rowLimit; r++) {
      const cells = (rows[r] ?? []).slice(0, colLimit).map((c) => cellToText(c));
      if (cells.some((c) => c.trim() !== "")) lines.push(cells.join("\t"));
    }
    if (widest > colLimit) lines.push(`(欄數較多，只顯示前 ${colLimit} 欄)`);
    if (rows.length > rowLimit) lines.push(`…(其餘 ${rows.length - rowLimit} 列略，只顯示前 ${rowLimit} 列)`);
    sections.push(lines.join("\n"));
  }
  return joinSectionsWithinBudget(sections);
}

/** 舊版 Word(.doc，二進位格式)用 word-extractor 抽出正文。 */
export async function docToText(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return (doc.getBody() ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ExtractResult { text: string }
export interface ExtractError { error: string }

const MAX_GENERIC_TEXT_CHARS = 45_000;

/** 長文字不能只留開頭：規則、輸出格式與例外處理很常寫在檔尾。 */
function excerptLongText(text: string, maxChars = MAX_GENERIC_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n…(中間內容較長，已略過；保留檔案開頭與結尾)…\n\n";
  const usable = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(usable * 0.65);
  return text.slice(0, headChars) + marker + text.slice(-(usable - headChars));
}

/** 用內容判斷是不是文字檔，不靠副檔名白名單；這樣程式碼、YAML、SQL、日誌都讀得到。 */
function decodeTextLike(buffer: Buffer): string | null {
  if (buffer.length === 0) return "(空檔案)";
  // Windows/Excel 匯出的「Unicode 文字」很常是 UTF-16；若先做 NUL 比例判斷會被誤認成二進位檔。
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return excerptLongText(new TextDecoder("utf-16le", { fatal: false }).decode(buffer.subarray(2)));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return excerptLongText(new TextDecoder("utf-16be", { fatal: false }).decode(buffer.subarray(2)));
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 16_384));
  let nul = 0;
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) nul++;
    else if (byte < 9 || (byte > 13 && byte < 32)) control++;
  }
  if (nul / sample.length > 0.01 || control / sample.length > 0.08) return null;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  return excerptLongText(text);
}

/** 壓縮檔不只列檔名：把裡面可讀的文字/程式碼一併展開，AI 才看得懂專案或資料包的邏輯。 */
function zipToText(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory).slice(0, 40);
  const sections: string[] = [];
  let used = 0;
  let expandedBytes = 0;
  for (const entry of entries) {
    const declaredSize = Number(entry.header.size) || 0;
    if (declaredSize > MAX_ZIP_ENTRY_BYTES || expandedBytes + declaredSize > MAX_ZIP_TOTAL_BYTES) continue;
    const data = entry.getData();
    if (data.length > MAX_ZIP_ENTRY_BYTES || expandedBytes + data.length > MAX_ZIP_TOTAL_BYTES) continue;
    expandedBytes += data.length;
    const text = decodeTextLike(data);
    if (text === null) continue;
    // 單一大檔不能吃完整份 ZIP 預算，否則第一個檔案超長時會導致「一個內檔都沒讀到」。
    const header = `【壓縮檔內：${entry.entryName}】\n`;
    const remaining = MAX_GENERIC_TEXT_CHARS - used - header.length;
    if (remaining < 300) break;
    const section = header + excerptLongText(text, Math.min(12_000, remaining));
    sections.push(section);
    used += section.length + 2;
  }
  const listing = entries.map((e) => e.entryName).join("\n");
  return `${sections.length ? sections.join("\n\n") : "(沒有可直接讀成文字的內部檔案)"}\n\n【壓縮檔內檔案清單】\n${listing}`.slice(0, MAX_GENERIC_TEXT_CHARS);
}

/** 依副檔名分派到對應的抽取方式；抓不到內容或格式不支援就回錯誤說明(不是靜默回空字串) */
export async function extractTextFromFile(filename: string, buffer: Buffer): Promise<ExtractResult | ExtractError> {
  const ext = (filename.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? "").toLowerCase();
  const bounded = (text: string): ExtractResult => ({ text: excerptLongText(text) });
  try {
    if (ext === "pdf") {
      const result = await pdfParse(buffer);
      const pageNote = result.numpages > 4
        ? `【PDF 共 ${result.numpages} 頁；可搜尋文字已讀取全部頁面，視覺畫面附上前 2 頁與最後 2 頁。若這是沒有文字層的掃描檔，中間頁面目前無法可靠辨識，不可假裝已看完。】\n\n`
        : `【PDF 共 ${result.numpages} 頁】\n\n`;
      return bounded(pageNote + (result.text.trim() || "(這份 PDF 沒有可搜尋的文字，請以附上的頁面圖片判讀。)"));
    }
    if (ext === "docx") {
      return bounded(docxToText(buffer));
    }
    if (ext === "rtf") {
      return bounded(rtfToText(buffer.toString("utf8")));
    }
    if (ext === "xlsx" || ext === "xlsm") {
      return bounded(await xlsxToText(buffer));
    }
    if (ext === "pptx") {
      return bounded(pptxToText(buffer));
    }
    // 舊版 Office 二進位格式：直接讀出來，不用逼使用者先另存新檔
    if (ext === "xls") {
      return bounded(xlsToText(buffer));
    }
    if (ext === "doc") {
      return bounded(await docToText(buffer));
    }
    if (ext === "eml") {
      const mail = await simpleParser(buffer);
      const attachments = (mail.attachments ?? []).map((a) => a.filename || "(未命名附件)").join("、");
      const recipients = Array.isArray(mail.to) ? mail.to.map((v) => v.text).join("、") : mail.to?.text ?? "";
      return bounded(`主旨：${mail.subject ?? ""}\n寄件人：${mail.from?.text ?? ""}\n收件人：${recipients}\n日期：${mail.date?.toISOString() ?? ""}\n附件：${attachments || "無"}\n\n${mail.text ?? ""}`);
    }
    if (ext === "zip") return bounded(zipToText(buffer));
    const genericText = decodeTextLike(buffer);
    if (genericText !== null) return { text: genericText };
    return { error: `這是無法可靠轉成文字的 .${ext || "?"} 二進位檔；可以把它當流程輸入，但不會假裝看懂裡面的邏輯` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
