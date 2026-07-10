import ExcelJS from "exceljs";

/**
 * 把 Excel 渲染成「一張圖片」，讓 dashboard 的 AI 像人一樣「真的看到」這個檔案長什麼樣——
 * 顏色、深色底白字、框線、合併儲存格、欄寬比例全部看得到，而不是只讀到值+一堆文字描述。
 * 做法：用 exceljs 讀出每格的值與樣式 → 組成一張帶行內樣式的 HTML 表格 → 用內建的 chromium 截圖。
 * (只需要 chromium，不用 LibreOffice 之類的重依賴，開源給別人用時開箱即可跑)
 */

// Office 佈景主題標準配色(theme 索引 → RGB)。Excel 的白字/主題配色是用 theme 存的，一定要對應回真實顏色。
const THEME_PALETTE: Record<number, string> = {
  0: "FFFFFF", // 背景1(白)
  1: "000000", // 文字1(黑)
  2: "E7E6E6", // 背景2(淺灰)
  3: "44546A", // 文字2(深藍灰)
  4: "4472C4", // 輔色1
  5: "ED7D31", // 輔色2
  6: "A5A5A5", // 輔色3
  7: "FFC000", // 輔色4
  8: "5B9BD5", // 輔色5
  9: "70AD47", // 輔色6
};

function applyTint(hex: string, tint: number): string {
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);
  if (tint < 0) {
    const f = 1 + tint; // 變暗
    r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f);
  } else if (tint > 0) {
    r = Math.round(r * (1 - tint) + 255 * tint); // 變亮
    g = Math.round(g * (1 - tint) + 255 * tint);
    b = Math.round(b * (1 - tint) + 255 * tint);
  }
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return `${h(r)}${h(g)}${h(b)}`;
}

/** 把 exceljs 的顏色(argb 或 theme+tint)轉成 CSS #rrggbb；認不得就回 null */
function cssColor(raw: unknown): string | null {
  const col = raw as { argb?: string; theme?: number; tint?: number } | undefined;
  if (!col) return null;
  if (col.argb && /^[0-9A-Fa-f]{8}$/.test(col.argb)) return `#${col.argb.slice(2)}`; // 去掉透明度前兩碼
  if (typeof col.theme === "number" && THEME_PALETTE[col.theme]) {
    return `#${applyTint(THEME_PALETTE[col.theme], col.tint ?? 0)}`;
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return String(o.result ?? "");
    if ("richText" in o) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in o) return String(o.text);
    if ("error" in o) return String(o.error);
    return "";
  }
  return String(v);
}

const MAX_ROWS = 80;
const MAX_COLS = 24;

/** 一個分頁 → HTML table(帶行內樣式，盡量還原 Excel 的視覺) */
function sheetToHtml(sheet: ExcelJS.Worksheet): string {
  const rowLimit = Math.min(sheet.rowCount || 0, MAX_ROWS);
  const colLimit = Math.min(sheet.columnCount || 0, MAX_COLS);
  if (rowLimit === 0 || colLimit === 0) return `<div class="sheet"><div class="title">分頁「${esc(sheet.name)}」(空白)</div></div>`;

  // 解析合併儲存格：covered = 被覆蓋(不畫)的格；master = 主格 → {colspan,rowspan}
  const covered = new Set<string>();
  const span = new Map<string, { cs: number; rs: number }>();
  const merges = (sheet.model as unknown as { merges?: string[] }).merges ?? [];
  for (const m of merges) {
    const mm = m.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!mm) continue;
    const c1 = colNum(mm[1]), r1 = +mm[2], c2 = colNum(mm[3]), r2 = +mm[4];
    span.set(`${r1}:${c1}`, { cs: c2 - c1 + 1, rs: r2 - r1 + 1 });
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (!(r === r1 && c === c1)) covered.add(`${r}:${c}`);
  }

  // 欄寬(exceljs width ≈ 字元數，×7px 約當像素)
  const cols: string[] = [];
  for (let c = 1; c <= colLimit; c++) {
    const w = sheet.getColumn(c).width;
    cols.push(`<col style="width:${w ? Math.round(w * 7) + 6 : 64}px">`);
  }

  const rows: string[] = [];
  for (let r = 1; r <= rowLimit; r++) {
    const row = sheet.getRow(r);
    const tds: string[] = [];
    for (let c = 1; c <= colLimit; c++) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = row.getCell(c);
      const st: string[] = [];
      const fill = cell.fill as ExcelJS.FillPattern | undefined;
      const bg = fill?.type === "pattern" ? cssColor(fill.fgColor) : null;
      if (bg) st.push(`background:${bg}`);
      const fc = cssColor(cell.font?.color);
      if (fc) st.push(`color:${fc}`);
      if (cell.font?.bold) st.push("font-weight:700");
      if (cell.font?.size) st.push(`font-size:${Math.max(9, Math.round(cell.font.size * 0.9))}px`);
      const b = cell.border;
      const bw = (side: Partial<ExcelJS.Border> | undefined) => (side?.style ? (side.style.includes("thick") || side.style.includes("medium") ? "2px" : "1px") : "");
      if (b) {
        if (bw(b.top)) st.push(`border-top:${bw(b.top)} solid #999`);
        if (bw(b.bottom)) st.push(`border-bottom:${bw(b.bottom)} solid #999`);
        if (bw(b.left)) st.push(`border-left:${bw(b.left)} solid #999`);
        if (bw(b.right)) st.push(`border-right:${bw(b.right)} solid #999`);
      }
      const al = cell.alignment;
      if (al?.horizontal) st.push(`text-align:${al.horizontal}`);
      if (al?.vertical) st.push(`vertical-align:${al.vertical === "middle" ? "middle" : al.vertical}`);
      if (al?.wrapText) st.push("white-space:normal");
      const sp = span.get(`${r}:${c}`);
      const spanAttr = sp ? `${sp.cs > 1 ? ` colspan="${sp.cs}"` : ""}${sp.rs > 1 ? ` rowspan="${sp.rs}"` : ""}` : "";
      tds.push(`<td${spanAttr} style="${st.join(";")}">${esc(cellText(cell.value))}</td>`);
    }
    rows.push(`<tr>${tds.join("")}</tr>`);
  }

  return `<div class="sheet"><div class="title">分頁「${esc(sheet.name)}」</div><table><colgroup>${cols.join("")}</colgroup>${rows.join("")}</table></div>`;
}

function colNum(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * 渲染成 base64 PNG。失敗(chromium 沒裝、檔案壞…)回 null，讓上傳流程照樣走文字版，不要整個掛掉。
 */
export async function renderXlsxToImage(buffer: Buffer): Promise<string | null> {
  let wb: ExcelJS.Workbook;
  try {
    wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return null;
  }
  const sheetsHtml = wb.worksheets.slice(0, 4).map(sheetToHtml).join('<div style="height:24px"></div>');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#fff;font-family:'PingFang TC','Microsoft JhengHei','Noto Sans TC',sans-serif;}
    .title{font-size:13px;color:#666;margin:0 0 6px;font-weight:600;}
    table{border-collapse:collapse;table-layout:fixed;}
    td{border:1px solid #e0e0e0;padding:3px 6px;font-size:12px;color:#111;overflow:hidden;
       text-overflow:ellipsis;white-space:nowrap;height:20px;line-height:1.3;}
  </style></head><body>${sheetsHtml}</body></html>`;

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      // 表格 HTML 全是本地生成、零外部資源——但儲存格內容來自使用者上傳的檔案，
      // 保險起見封掉所有網路請求，惡意檔案別想誘發對內網/外部的任何連線。
      await page.route("**/*", (route) => route.abort());
      await page.setContent(html, { waitUntil: "load" });
      const body = await page.$("body");
      const shot = body ? await body.screenshot({ type: "png" }) : await page.screenshot({ type: "png", fullPage: true });
      return Buffer.from(shot).toString("base64");
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {
    return null; // 渲染不出來就算了，還有文字版可用
  }
}
