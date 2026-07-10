import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { isPrivateHost, privateUrlsAllowed } from "../../urlGuard";

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
  description: "抓取一個公開網頁，輸出網頁的可讀文字(自動去除 HTML 標籤)與標題，給下游 AI 判斷/解析用。抓 JSON API 請改用 http-request；要登入才看得到的頁面請用瀏覽器類節點。",
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
      if (!text) throw new PermanentError("抓到的網頁沒有可讀文字(可能是純 JS 渲染的頁面)——這種頁面請改用瀏覽器類節點或 custom-code");
      ctx.log(`抓到「${title || current.hostname}」：${text.length} 字`);
      return { output: { pageText: text, pageTitle: title, pageHtml: html.slice(0, 60_000), finalUrl: current.href } };
    }
  },
};
