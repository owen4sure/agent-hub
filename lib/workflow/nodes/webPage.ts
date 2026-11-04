import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { isPrivateHost, privateUrlsAllowed } from "../../urlGuard";
import { renderPageText } from "../../renderPage";
import { firecrawlConfigured, firecrawlScrape, FirecrawlError } from "../../firecrawl";
import { urlSourceEvidence } from "../runtimeEvidence";

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** 很陽春但夠用的 HTML→文字：去 script/style、去標籤、壓空白。要更精準的解析交給下游 AI 或 custom-code。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>|<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * 抓一個公開網頁的內容(文字+原始 HTML)給下游用——「抓某網站的資訊,AI 整理後…」這類需求的第一步。
 * 跟 http-request 的分工：http-request 打的是 API(回 JSON)；這個節點抓的是「人看的網頁」，
 * 會自動把 HTML 轉成可讀文字。每一跳轉址都過 SSRF 防護(擋內網/loopback/雲端 metadata)。
 */
/**
 * 降級鏈(2026-08,使用者真實踩過:公司官網擋非瀏覽器抓取,輕量 fetch 直接 fetch failed):
 * 輕量抓取碰壁(連不上/被擋/JS 渲染抓不到字)時,①先用內建 headless 瀏覽器真的開一次
 * (SSRF 防護同一套,資料不出本機);②還是不行而且使用者有設定 Firecrawl(選配)才把網址
 * 交給它抓;③都失敗就把「試過哪些路」誠實列出來,沒設 Firecrawl 的人會被告知有這個選項。
 */
async function fetchViaFallbacks(
  ctx: Parameters<NodeDefinition["execute"]>[0],
  href: string,
  maxChars: number,
  why: string,
): Promise<{ pageText: string; pageTitle: string; pageHtml: string; finalUrl: string; sourceEvidence: unknown }> {
  ctx.log(`輕量抓取碰壁(${why.slice(0, 120)}),改用內建瀏覽器再試…`);
  let browserErr = "";
  try {
    const rendered = await renderPageText(href, { maxChars, signal: ctx.cancelSignal });
    if (rendered.text) {
      ctx.log(`內建瀏覽器抓到「${rendered.title || href}」：${rendered.text.length} 字`);
      const finalUrl = rendered.finalUrl || href;
      return { pageText: rendered.text, pageTitle: rendered.title, pageHtml: rendered.html || "", finalUrl, sourceEvidence: urlSourceEvidence(finalUrl, { observed: { status: 200, textChars: rendered.text.length } }) };
    }
    browserErr = "瀏覽器開得了頁面但抽不到任何文字";
  } catch (err) {
    browserErr = err instanceof Error ? err.message.slice(0, 160) : String(err);
  }
  // Firecrawl 這一層一定要包起來:它丟出來的錯若直接往外跑,①上面辛苦記下的「試過哪些路」
  // 就永遠不會被組出來(使用者只看到一句 Firecrawl 錯誤,不知道前兩層也失敗了)②這個節點是
  // retryable,整條降級鏈會被重跑三次=三次瀏覽器 + 三次付費抓取。
  let firecrawlErr = "";
  let firecrawlPermanent = false;
  if (firecrawlConfigured()) {
    ctx.log("內建瀏覽器也失敗,改用你設定的 Firecrawl 服務抓取…");
    try {
      const page = await firecrawlScrape(href, { signal: ctx.cancelSignal });
      if (page.text) {
        ctx.log(`Firecrawl 抓到「${page.title || href}」：${page.text.length} 字`);
        return { pageText: page.text.slice(0, maxChars), pageTitle: page.title, pageHtml: page.html.slice(0, 60_000), finalUrl: page.finalUrl, sourceEvidence: urlSourceEvidence(page.finalUrl, { observed: { status: 200, textChars: page.text.length } }) };
      }
      firecrawlErr = "Firecrawl 也沒抓到任何文字";
    } catch (err) {
      if (ctx.cancelSignal.aborted) throw err; // 使用者按停止,不要翻譯成「抓不到」
      firecrawlErr = err instanceof Error ? err.message.slice(0, 200) : String(err);
      firecrawlPermanent = err instanceof FirecrawlError && err.permanent;
    }
  }
  const detail =
    `這個網頁抓不下來(${why.slice(0, 120)})。已試過:輕量抓取→內建瀏覽器(${browserErr})` +
    (firecrawlConfigured()
      ? `→Firecrawl(${firecrawlErr}),全部失敗。可能要登入才看得到,或網站把自動抓取全擋了`
      : "。若這個網站長期擋自動抓取,可以在「設定 → 進階」串接 Firecrawl(選配的專業抓取服務)再重試;要登入才看得到的頁面請改用瀏覽器登入類節點");
  // 金鑰錯/額度用完 → 重跑一定也是同樣結果,而且每跑一次都要錢:當場停下來,不進重試。
  throw firecrawlPermanent ? new PermanentError(detail) : new RetryableError(detail);
}

export const webPageNode: NodeDefinition = {
  type: "web-page",
  category: "integration",
  label: "抓網頁",
  description: "抓取一個公開網頁，輸出網頁的可讀文字(自動去除 HTML 標籤)與標題，給下游 AI 判斷/解析用。純 JS 渲染的頁面會自動改用內建瀏覽器補抓,不用你煩惱。抓 JSON API 請改用 http-request。",
  icon: "🕸️",
  configSchema: [
    { key: "url", label: "網址(可用 {{欄位}})", type: "text" },
    { key: "maxChars", label: "文字最多保留字數", type: "number", default: "15000" },
  ],
  outputs: "pageText(網頁可讀文字), pageTitle(網頁標題), pageHtml(原始HTML,截斷後), finalUrl(轉址後的最終網址)",
  retryable: true,
  async execute(ctx) {
    const rawUrl = cfgStr(ctx, "url");
    if (!rawUrl.trim()) throw new PermanentError("沒有填網址");
    const maxChars = Number(cfgStr(ctx, "maxChars", "15000")) || 15000;
    const guardOn = !privateUrlsAllowed();

    let url: URL;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      throw new PermanentError(`網址格式不正確：${rawUrl}`);
    }

    // 手動跟轉址：每一跳都重新驗證主機——只驗第一跳會被 302 轉進內網(SSRF 的經典繞法)
    let hops = 0;
    let current = url;
    for (;;) {
      if (!/^https?:$/.test(current.protocol)) throw new PermanentError(`只支援 http/https 網址：${current.href}`);
      if (guardOn && (await isPrivateHost(current.hostname))) {
        throw new PermanentError(`這個網址指向內部網路(${current.hostname})，平台基於安全考量不會自動抓取內網位址。如果這是刻意要抓公司內部系統，需要請熟悉這台電腦設定的人開啟允許內網的選項（技術細節：環境變數 AGENT_HUB_ALLOW_PRIVATE_URLS=1）。`);
      }
      let res: Response;
      try {
        res = await fetch(current.href, {
          redirect: "manual",
          signal: AbortSignal.any([ctx.cancelSignal, AbortSignal.timeout(30_000)]),
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AgentHub/1.0", Accept: "text/html,application/xhtml+xml,*/*" },
        });
      } catch (err) {
        const output = await fetchViaFallbacks(ctx, current.href, maxChars, `連不上 ${current.hostname}:${err instanceof Error ? err.message : String(err)}`);
        return { output };
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new PermanentError(`網站回了轉址(${res.status})卻沒給目的地`);
        if (++hops > MAX_REDIRECTS) throw new PermanentError("轉址次數太多(超過 5 次)，放棄");
        current = new URL(loc, current);
        continue;
      }
      if (!res.ok) {
        const msg = `抓取失敗：HTTP ${res.status}`;
        if (res.status >= 500 || res.status === 429) throw new RetryableError(msg);
        if (res.status === 403 || res.status === 406) {
          // 典型的「擋非瀏覽器」回應——換真瀏覽器常常就過了,別急著報錯
          const output = await fetchViaFallbacks(ctx, current.href, maxChars, msg);
          return { output };
        }
        throw new PermanentError(`${msg}——請確認網址是否正確、是否需要登入`);
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BYTES) { reader.cancel(); break; }
          chunks.push(value);
        }
      }
      const html = Buffer.concat(chunks).toString("utf-8");
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
      const text = htmlToText(html).slice(0, maxChars);
      if (!text) {
        // 純 JS 渲染的頁面用輕量 fetch 抓得到殼卻抽不到文字——走同一條降級鏈(瀏覽器→Firecrawl 選配)
        const output = await fetchViaFallbacks(ctx, current.href, maxChars, `「${title || current.hostname}」是 JS 渲染頁,輕量抓取抽不到文字`);
        if (!output.pageTitle && title) output.pageTitle = title;
        if (!output.pageHtml) output.pageHtml = html.slice(0, 60_000);
        return { output };
      }
      ctx.log(`抓到「${title || current.hostname}」：${text.length} 字`);
      return { output: { pageText: text, pageTitle: title, pageHtml: html.slice(0, 60_000), finalUrl: current.href, sourceEvidence: urlSourceEvidence(current.href, { observed: { status: res.status, textChars: text.length } }) } };
    }
  },
};
