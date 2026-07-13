import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { isPrivateHost, privateUrlsAllowed } from "../../urlGuard";
import { renderPageText } from "../../renderPage";

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
        throw new PermanentError(`這個網址指向內部網路(${current.hostname})，基於安全不抓取。內網需求請設環境變數 AGENT_HUB_ALLOW_PRIVATE_URLS=1`);
      }
      let res: Response;
      try {
        res = await fetch(current.href, {
          redirect: "manual",
          signal: AbortSignal.any([ctx.cancelSignal, AbortSignal.timeout(30_000)]),
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh) AgentHub/1.0", Accept: "text/html,application/xhtml+xml,*/*" },
        });
      } catch (err) {
        throw new RetryableError(`連不上 ${current.hostname}：${err instanceof Error ? err.message : String(err)}`);
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
        // 純 JS 渲染的頁面用輕量 fetch 抓不到文字——自動退到內建 headless 瀏覽器真的渲染一次再抽(SSRF 防護沿用同一套)。
        // 使用者完全不用知道「這頁要換節點」,系統自己搞定;真的連瀏覽器渲染都抽不到才誠實報錯。
        ctx.log(`「${title || current.hostname}」看起來是 JS 渲染頁,改用內建瀏覽器補抓…`);
        try {
          const rendered = await renderPageText(current.href, { maxChars, signal: ctx.cancelSignal });
          if (rendered.text) {
            ctx.log(`瀏覽器補抓到「${rendered.title || title || current.hostname}」：${rendered.text.length} 字`);
            return { output: { pageText: rendered.text, pageTitle: rendered.title || title, pageHtml: rendered.html || html.slice(0, 60_000), finalUrl: rendered.finalUrl || current.href } };
          }
        } catch (err) {
          throw new RetryableError(`用瀏覽器補抓這個網頁失敗：${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
        }
        throw new PermanentError("這個網頁連用瀏覽器渲染都抓不到任何文字(可能整頁是圖片/影片,或內容要登入才看得到)——若是要登入的頁面,請改用瀏覽器登入類節點");
      }
      ctx.log(`抓到「${title || current.hostname}」：${text.length} 字`);
      return { output: { pageText: text, pageTitle: title, pageHtml: html.slice(0, 60_000), finalUrl: current.href } };
    }
  },
};
