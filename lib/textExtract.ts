import AdmZip from "adm-zip";
import pdfParse from "pdf-parse";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import WordExtractor from "word-extractor";

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
  const xml = entry.getData().toString("utf8");
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
const MAX_COLS_PER_SHEET = 40;

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

/** 把 Excel(.xlsx) 每個分頁轉成「分頁名 + 表格文字 + 版型格式」，讓 AI 看得懂結構、內容、也看得到顏色/框線/欄寬。 */
export async function xlsxToText(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  if (wb.worksheets.length === 0) throw new Error("這個 Excel 檔裡沒有任何分頁");
  const sections: string[] = [];
  for (const sheet of wb.worksheets) {
    // columnCount 遇到「曾經在很遠的欄打過字/整欄套過格式」會暴增到上萬——一定要設上限，
    // 不然一列會塞上萬個 tab、抽出的文字爆到幾百 KB，之後送 AI 又會撞到參數/token 上限。
    const colLimit = Math.min(sheet.columnCount, MAX_COLS_PER_SHEET);
    const lines: string[] = [`【分頁「${sheet.name}」，共 ${sheet.rowCount} 列】`];
    const rowLimit = Math.min(sheet.rowCount, MAX_ROWS_PER_SHEET);
    for (let r = 1; r <= rowLimit; r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      for (let c = 1; c <= colLimit; c++) cells.push(cellToText(row.getCell(c).value));
      if (cells.some((c) => c.trim() !== "")) lines.push(cells.join("\t"));
    }
    if (sheet.columnCount > MAX_COLS_PER_SHEET) lines.push(`(欄數較多，只顯示前 ${MAX_COLS_PER_SHEET} 欄)`);
    if (sheet.rowCount > MAX_ROWS_PER_SHEET) lines.push(`…(其餘 ${sheet.rowCount - MAX_ROWS_PER_SHEET} 列略，只顯示前 ${MAX_ROWS_PER_SHEET} 列)`);
    const style = sheetStyleSummary(sheet);
    sections.push(lines.join("\n") + (style ? "\n\n" + style : ""));
  }
  return sections.join("\n\n");
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
    });
  if (slides.length === 0) throw new Error("這個檔案不是有效的 .pptx(找不到任何投影片)");
  const sections: string[] = [];
  slides.forEach((entry, idx) => {
    const xml = entry.getData().toString("utf8");
    // 投影片上的文字都在 <a:t>...</a:t> 裡；把每一段抓出來，還原 XML 跳脫字元
    const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) =>
      m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
    );
    const body = texts.join("\n").trim();
    if (body) sections.push(`【第 ${idx + 1} 張投影片】\n${body}`);
  });
  return sections.join("\n\n").trim();
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
    const lines: string[] = [`【分頁「${name}」，共 ${rows.length} 列】`];
    const rowLimit = Math.min(rows.length, MAX_ROWS_PER_SHEET);
    for (let r = 0; r < rowLimit; r++) {
      const cells = (rows[r] ?? []).slice(0, MAX_COLS_PER_SHEET).map((c) => cellToText(c));
      if (cells.some((c) => c.trim() !== "")) lines.push(cells.join("\t"));
    }
    if (rows.length > MAX_ROWS_PER_SHEET) lines.push(`…(其餘 ${rows.length - MAX_ROWS_PER_SHEET} 列略，只顯示前 ${MAX_ROWS_PER_SHEET} 列)`);
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n").trim();
}

/** 舊版 Word(.doc，二進位格式)用 word-extractor 抽出正文。 */
export async function docToText(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return (doc.getBody() ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ExtractResult { text: string }
export interface ExtractError { error: string }

/** 依副檔名分派到對應的抽取方式；抓不到內容或格式不支援就回錯誤說明(不是靜默回空字串) */
export async function extractTextFromFile(filename: string, buffer: Buffer): Promise<ExtractResult | ExtractError> {
  const ext = (filename.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? "").toLowerCase();
  try {
    if (ext === "pdf") {
      const result = await pdfParse(buffer);
      return { text: result.text };
    }
    if (ext === "docx") {
      return { text: docxToText(buffer) };
    }
    if (ext === "rtf") {
      return { text: rtfToText(buffer.toString("utf8")) };
    }
    if (ext === "xlsx" || ext === "xlsm") {
      return { text: await xlsxToText(buffer) };
    }
    if (ext === "pptx") {
      return { text: pptxToText(buffer) };
    }
    // 舊版 Office 二進位格式：直接讀出來，不用逼使用者先另存新檔
    if (ext === "xls") {
      return { text: xlsToText(buffer) };
    }
    if (ext === "doc") {
      return { text: await docToText(buffer) };
    }
    return { error: `不支援直接讀取 .${ext || "?"} 格式` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
