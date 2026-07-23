import { chromium } from "playwright";

/**
 * 選擇器實測探針——把「修復高手真正在做的事」變成迴圈的內建機制。
 *
 * 人(或高階 AI)修「找不到元素」這類失敗時的關鍵動作從來不是憑記憶猜選擇器，而是：
 * ①把失敗當下存的真實頁面打開，逐一實測候選選擇器命中幾筆；②看命中 0 的選擇器「差在哪」
 * (常見:tag 指定錯了——div.punch-filmstrip-thumbnail 在頁面上其實是 <g>；class 詞根對了但
 * 完整類名不同)；③改完再對同一份頁面重播驗證，通過才算修好。
 * 這個模組把 ①②③ 全部確定性化：修復模型再弱，拿到的都是實測事實，提案再被閘門驗過才套用。
 */

export interface SelectorProbeResult {
  selector: string;
  count: number;
  /** 命中元素的樣本(tag+關鍵屬性+文字節錄)，讓模型知道抓到的是什麼 */
  samples: string[];
  /** 選擇器語法無效等原因導致無法實測時的說明 */
  error?: string;
}

/** 從一段 Playwright 程式碼撈出所有「當選擇器用」的字串字面值(含逗號清單整串)。
 * 引號要「同型配對」——選擇器裡常內嵌另一種引號(如 "[role='row']"),用 [^"'`] 一撞到內層引號就斷掉。 */
export function extractSelectorsFromCode(code: string): string[] {
  const out = new Set<string>();
  const re = /(?:waitForSelector|\$\$eval|\$eval|page\.\$\$?|locator|querySelector(?:All)?)\(\s*(["'`])((?:(?!\1).)*?)\1/g;
  for (const m of code.matchAll(re)) {
    const sel = m[2].trim();
    if (sel) out.add(sel);
  }
  return [...out];
}

/** 逗號清單選擇器拆成單一選擇器(哪一段命中/哪一段掛了要分開講,整串一起測看不出病灶) */
export function splitSelectorList(selector: string): string[] {
  return selector.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * 把(失敗當下存檔的)HTML 載入「無 JS、全斷網」的 headless 頁面，實測每個選擇器命中幾筆。
 * 安全性質:頁面腳本一律不執行、所有子資源請求一律擋掉——存檔頁面來自任意網站，不能讓它跑碼或外連。
 * 用 Playwright 的 locator 來數(不是 querySelectorAll)，:has-text() 這類 Playwright 專用語法也測得動。
 */
export async function probeSelectorsInHtml(html: string, selectors: string[]): Promise<SelectorProbeResult[]> {
  if (selectors.length === 0) return [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const results: SelectorProbeResult[] = [];
    for (const selector of selectors.slice(0, 16)) {
      try {
        const loc = page.locator(selector);
        const count = await loc.count();
        const samples: string[] = [];
        for (let i = 0; i < Math.min(count, 2); i++) {
          const s = await loc.nth(i).evaluate((el) => {
            const attrs = ["id", "class", "role", "aria-label", "data-id", "data-target", "data-tooltip"]
              .map((a) => {
                const v = (el as Element).getAttribute(a);
                return v ? `${a}="${v.slice(0, 50)}"` : "";
              })
              .filter(Boolean)
              .join(" ");
            const text = ((el as Element).textContent ?? "").trim().slice(0, 40);
            return `<${(el as Element).tagName.toLowerCase()}${attrs ? " " + attrs : ""}>${text}`;
          }).catch(() => null);
          if (s) samples.push(s);
        }
        results.push({ selector, count, samples });
      } catch (err) {
        results.push({ selector, count: 0, samples: [], error: err instanceof Error ? err.message.split("\n")[0].slice(0, 120) : String(err) });
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}

/**
 * 「相近元素探索」:命中 0 的選擇器,把它的字根(≥4字元的詞)拿去頁面原始碼裡找
 * 「class/id 含這個字根的真實元素」——修復者最需要的線索是「你要找的東西實際長什麼樣」。
 * 真實案例:選擇器寫 div.punch-filmstrip-thumbnail 命中 0,字根 "thumbnail" 一找就看到
 * 頁面上是 <g class="punch-filmstrip-thumbnail">——tag 是 SVG 的 g 不是 div,病灶一目了然。
 */
export function tokenNeighborhood(html: string, zeroHitSelectors: string[]): string[] {
  const tokens = new Set<string>();
  for (const sel of zeroHitSelectors) {
    for (const t of sel.split(/[^a-zA-Z0-9_]+/)) {
      const tok = t.trim().toLowerCase();
      if (tok.length >= 4 && !["true", "false", "data"].includes(tok)) tokens.add(tok);
    }
  }
  const lines: string[] = [];
  for (const token of [...tokens].slice(0, 8)) {
    // 找 class/id 裡含這個字根的元素,回報「tag+完整類名」——tag 對不上正是最常見的病灶
    const re = new RegExp(`<(\\w+)[^>]{0,300}?(?:class|id)="([^"]*${token}[^"]*)"`, "gi");
    const found = new Map<string, number>();
    let m: RegExpExecArray | null;
    let scanned = 0;
    while ((m = re.exec(html)) && scanned < 400) {
      scanned++;
      const key = `<${m[1].toLowerCase()} class/id="${m[2].slice(0, 70)}">`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
    if (found.size > 0) {
      const top = [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      lines.push(`字根「${token}」在頁面上的真實元素：${top.map(([k, n]) => `${k} ×${n}`).join("、")}`);
    }
  }
  return lines;
}

/** 組出給修復模型看的實測報告(命中數+樣本+相近元素);selectors 為空回空字串 */
export async function buildSelectorProbeReport(html: string, code: string): Promise<string> {
  const raw = extractSelectorsFromCode(code);
  if (raw.length === 0) return "";
  // 逗號清單整串+拆開的每一段都測:整串命中=功能沒壞;拆開才看得出「三個候選裡哪幾個早就失效」
  const expanded = [...new Set(raw.flatMap((s) => (s.includes(",") ? [s, ...splitSelectorList(s)] : [s])))];
  const results = await probeSelectorsInHtml(html, expanded);
  const lines = results.map((r) => {
    if (r.error) return `- \`${r.selector}\` → 無法實測(${r.error})`;
    const sample = r.samples.length ? `　樣本:${r.samples.join("、")}` : "";
    return `- \`${r.selector}\` → ${r.count} 筆${sample}`;
  });
  const zeroHit = results.filter((r) => !r.error && r.count === 0).map((r) => r.selector);
  const neighborhood = zeroHit.length ? tokenNeighborhood(html, zeroHit) : [];
  return [
    "",
    "",
    "【程式碼選擇器在「失敗當下真實頁面」的實測命中數(系統剛剛實際測的,不是猜的)】",
    ...lines,
    ...(neighborhood.length
      ? ["命中 0 筆的選擇器,頁面上「字根相近的真實元素」如下——新選擇器從這裡挑,注意 tag 是什麼就寫什麼(div.X 會漏掉 <g class=X>/<span class=X>,class 選擇器別硬加 tag):", ...neighborhood.map((l) => `- ${l}`)]
      : []),
  ].join("\n");
}
