/**
 * Excel 儲存格「長什麼樣子」的共用解讀層：顏色、文字、數字格式、欄位代號。
 *
 * 為什麼要獨立一份：這些邏輯有兩個消費端——`xlsxRender`(把整份檔案畫成圖給 AI 看)與
 * `xlsxRangeImage`(把指定範圍畫成圖貼進簡報)。同一份判斷各寫一份必然漂移，而漂移的症狀
 * 是「AI 看到的樣子」跟「貼進簡報的樣子」不一致——那種問題非常難查(兩邊都「看起來對」)。
 */

/** Office 佈景主題標準配色(theme 索引 → RGB)。Excel 的白字/主題配色是用 theme 存的，一定要對應回真實顏色。 */
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

export function applyTint(hex: string, tint: number): string {
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

/**
 * 把 exceljs 的顏色(argb、theme+tint、或 indexed)轉成 CSS #rrggbb；認不得就回 null。
 *
 * `indexed: 64/65` 是 Excel 的「自動」色(前景=黑、背景=白)，**框線最常用的就是它**。
 * 漏掉這兩個索引的後果很具體：Excel 裡是黑色的虛線框，畫出來變成灰到幾乎看不見的線，
 * 貼進簡報後整張表看起來「沒有格線」——跟使用者自己截的圖明顯不一樣。
 */
export function cssColor(raw: unknown): string | null {
  const col = raw as { argb?: string; theme?: number; tint?: number; indexed?: number } | undefined;
  if (!col) return null;
  if (col.argb && /^[0-9A-Fa-f]{8}$/.test(col.argb)) return `#${col.argb.slice(2)}`; // 去掉透明度前兩碼
  if (typeof col.theme === "number" && THEME_PALETTE[col.theme]) {
    return `#${applyTint(THEME_PALETTE[col.theme], col.tint ?? 0)}`;
  }
  if (col.indexed === 64) return "#000000"; // 自動(前景)
  if (col.indexed === 65) return "#ffffff"; // 自動(背景)
  return null;
}

/** Excel 的字級是「點」，CSS 要的是像素。1pt = 4/3 px；不換算會讓字明顯偏小、跟列高不成比例。 */
export function pointsToPx(points: number): number {
  return Math.round(points * (4 / 3));
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 「A」→1、「G」→7、「AA」→27 */
export function colNum(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** 1→「A」、7→「G」、27→「AA」 */
export function colLetters(n: number): string {
  let out = "";
  let v = n;
  while (v > 0) {
    const rem = (v - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out;
}

/** exceljs 的儲存格 value 有六七種形狀，統一取出「原始值」與「是不是錯誤格」 */
export function cellRawValue(v: unknown): { value: unknown; isError: boolean } {
  if (v === null || v === undefined) return { value: null, isError: false };
  if (v instanceof Date) return { value: v, isError: false };
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // 公式格：result 才是算出來的值；result 本身也可能是錯誤物件(巢狀一層)
    if ("result" in o) {
      const inner = o.result;
      if (inner && typeof inner === "object" && "error" in (inner as Record<string, unknown>)) {
        return { value: (inner as Record<string, unknown>).error, isError: true };
      }
      return { value: inner ?? null, isError: false };
    }
    if ("error" in o) return { value: o.error, isError: true };
    if ("richText" in o) return { value: (o.richText as { text: string }[]).map((t) => t.text).join(""), isError: false };
    if ("text" in o) return { value: String(o.text), isError: false };
    return { value: null, isError: false };
  }
  return { value: v, isError: false };
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 套用 Excel 的數字格式碼。
 *
 * 為什麼一定要做(不能直接印原始值)：Excel 存的是 `0.2697804391`，畫面上顯示的是 `26.98%`；
 * 存的是 `218530.69725`，顯示的是 `218,531`。把原始值畫成圖 = 貼進簡報的是一串沒人看得懂的
 * 小數，而且跟使用者自己截圖的樣子完全不同。**「畫成圖」的正確性標準是「跟 Excel 畫面一致」**，
 * 不是「跟儲存的值一致」。
 *
 * 只實作真的會遇到的格式碼(千分位、小數位、百分比、負數紅字括號、日期)——認不得的格式一律
 * 退回原始文字，不要自作聰明猜，也不要吞掉。
 */
export function formatByNumFmt(value: unknown, numFmt: string | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const fmt = (numFmt ?? "").trim();

  if (value instanceof Date) {
    const y = value.getFullYear(), m = value.getMonth() + 1, d = value.getDate();
    if (/y{2,4}/i.test(fmt) || !fmt || fmt === "General") return `${y}/${m}/${d}`;
    return `${y}/${m}/${d}`;
  }
  if (typeof value !== "number") return String(value);
  if (!fmt || fmt === "General" || fmt === "@") return String(value);

  // 負數有自己的區段時(`正;負`)，選對區段再套用——`#,##0_);[Red](#,##0)` 的負數是紅字括號。
  const sections = fmt.split(";");
  const negative = value < 0;
  const section = negative && sections.length > 1 ? sections[1] : sections[0];
  const cleaned = section.replace(/\[[^\]]*\]/g, "").replace(/[_*].?/g, "").trim();
  const abs = Math.abs(value);

  if (cleaned.includes("%")) {
    const decimals = (cleaned.match(/\.(0+)/)?.[1] ?? "").length;
    const body = (abs * 100).toFixed(decimals);
    const [i, f] = body.split(".");
    const grouped = cleaned.includes("#,##") || cleaned.includes(",") ? groupThousands(i) : i;
    const text = `${grouped}${f ? `.${f}` : ""}%`;
    return negative ? wrapNegative(text, cleaned) : text;
  }

  const decimals = (cleaned.match(/\.(0+|#+)/)?.[1] ?? "").length;
  const body = abs.toFixed(decimals);
  const [i, f] = body.split(".");
  const grouped = cleaned.includes("#,##") ? groupThousands(i) : i;
  const text = `${grouped}${f ? `.${f}` : ""}`;
  return negative ? wrapNegative(text, cleaned) : text;
}

function wrapNegative(text: string, section: string): string {
  // `(#,##0)` 這種格式的負數用括號表示，且不再加負號
  if (section.includes("(") && section.includes(")")) return `(${text})`;
  return `-${text}`;
}

/** 這個格式碼的負數要不要用紅字(`[Red]`)。顏色是格式的一部分，漏掉會讓「虧損」看起來像正常數字。 */
export function negativeIsRed(numFmt: string | undefined): boolean {
  const sections = (numFmt ?? "").split(";");
  return sections.length > 1 && /\[Red\]/i.test(sections[1]);
}

/**
 * 從 PNG 檔頭讀出像素寬高。
 *
 * 為什麼需要：把圖貼進簡報時要「保持比例縮進原本的框」，而算比例就得知道圖多大。
 * PNG 的 IHDR 一定是第一個區塊，寬高就在固定位置(第 16~24 byte)，不需要任何影像函式庫。
 * 不是 PNG 或檔案被截斷就回 null，讓呼叫端退回「直接沿用原本的框」而不是算出一個錯的比例。
 */
export function pngPixelSize(buffer: Buffer): { width: number; height: number } | null {
  const PNG_MAGIC = "89504e470d0a1a0a";
  if (buffer.length < 24) return null;
  if (buffer.subarray(0, 8).toString("hex") !== PNG_MAGIC) return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}
