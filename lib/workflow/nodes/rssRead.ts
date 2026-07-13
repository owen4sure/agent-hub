import type { NodeDefinition } from "../types";
import { PermanentError, RetryableError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { isPrivateHost } from "../../urlGuard";

/**
 * 讀 RSS/Atom:抓一個 feed 的最新文章清單(標題/連結/時間/摘要)。
 * 配「排程+AI 摘要+寄信/通知」就是每日新聞摘要;配 repeat-steps 可逐篇處理。
 */
const pick = (xml: string, tag: string): string => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return (m?.[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").trim();
};
const pickAttr = (xml: string, tag: string, attr: string): string =>
  xml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i"))?.[1] ?? "";

/** 純函式:從一段 HTML(通常是網站首頁)找出它宣告的 RSS/Atom feed 網址,相對路徑補成絕對。找不到回 null。 */
export function discoverFeedUrl(html: string, baseUrl: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/type=["']application\/(rss|atom)\+xml["']/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (href) {
      try { return new URL(href, baseUrl).href; } catch { /* 壞的 href 跳過 */ }
    }
  }
  return null;
}

/** 純函式:從 feed 內容抽出 <item>(RSS2.0)/<entry>(Atom)區塊 */
export function extractFeedBlocks(xml: string): string[] {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);
}

export const rssReadNode: NodeDefinition = {
  type: "rss-read",
  category: "integration",
  label: "讀 RSS",
  description: "抓一個 RSS/Atom feed 的最新文章清單(標題/連結/時間/摘要),給下游彙整或逐篇處理。配排程+AI 摘要+通知就是全自動每日簡報。",
  icon: "📰",
  // outputs 宣告以逗號分隔欄位——括號說明裡不能再放半形逗號(outputFieldNames 會切壞欄位名,
  // lint 誤把說明文字當欄位;範本品質閘門實測抓到)
  outputs: "articles(文章清單;每筆有 title/link/date/summary), articleCount(篇數), feedTitle(來源名稱), articlesText(前 N 篇的文字清單;方便直接給 AI)",
  configSchema: [
    { key: "url", label: "RSS/Atom 網址", type: "text", default: "" },
    { key: "maxItems", label: "最多取幾篇", type: "number", default: "10" },
  ],
  retryable: true,
  timeoutMs: 60_000,
  async execute(ctx) {
    const url = cfgStr(ctx, "url").trim();
    if (!url || !/^https?:\/\//i.test(url)) throw new PermanentError(`RSS 網址不正確:「${url || "(空)"}」`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    if (ctx.cancelSignal?.aborted) controller.abort();
    const onAbort = () => controller.abort();
    ctx.cancelSignal?.addEventListener("abort", onAbort, { once: true });
    // SSRF 檢查 + 抓文字(可能被呼叫兩次:原網址、以及自動偵測到的 feed 網址)
    const grab = async (u: string): Promise<string> => {
      const host = new URL(u).hostname;
      if (await isPrivateHost(host)) throw new PermanentError(`不允許讀取內部網路位址(${host})`);
      const res = await fetch(u, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "AgentHub/1.0 RSS" } });
      if (res.status === 404) throw new PermanentError("這個網址回 404——確認 feed 網址貼對(常見是 /rss、/feed、/atom.xml 結尾)");
      if (res.status >= 500) throw new RetryableError(`來源暫時錯誤(${res.status})`);
      if (res.status !== 200) throw new PermanentError(`抓取失敗(HTTP ${res.status})`);
      return res.text();
    };
    const maxItems = Math.min(Number(cfgStr(ctx, "maxItems", "10")) || 10, 50);
    let xml: string;
    let blocks: string[];
    try {
      xml = await grab(url);
      blocks = extractFeedBlocks(xml);
      if (blocks.length === 0) {
        // 使用者很可能貼的是「網站首頁」而不是 feed 網址——自動從 HTML 找出它宣告的 feed 再抓一次,
        // 不要把「請貼 feed 網址不是首頁」丟回去讓使用者自己找(這就是「使用者不用想怎麼做」)。
        const discovered = discoverFeedUrl(xml, url);
        if (discovered && discovered !== url) {
          ctx.log(`「${url}」不是 feed,自動偵測到 feed:${discovered}`);
          xml = await grab(discovered);
          blocks = extractFeedBlocks(xml);
        }
      }
    } finally {
      clearTimeout(timer);
      ctx.cancelSignal?.removeEventListener("abort", onAbort);
    }
    if (blocks.length === 0) throw new PermanentError("這個網址找不到 RSS/Atom 內容,也沒偵測到可訂閱的 feed 連結——請確認貼的是有提供 RSS 的網站");
    const articles = blocks.slice(0, maxItems).map((b) => ({
      title: pick(b, "title") || "(無標題)",
      link: pick(b, "link") || pickAttr(b, "link", "href"),
      date: pick(b, "pubDate") || pick(b, "updated") || pick(b, "published"),
      summary: (pick(b, "description") || pick(b, "summary") || pick(b, "content")).slice(0, 400),
    }));
    const feedTitle = pick(xml.slice(0, 4000), "title");
    const articlesText = articles.map((a, i) => `${i + 1}. ${a.title}\n   ${a.link}${a.summary ? `\n   ${a.summary.slice(0, 150)}` : ""}`).join("\n");
    ctx.log(`讀到「${feedTitle}」${articles.length} 篇(feed 共 ${blocks.length} 篇)`);
    return { output: { articles, articleCount: articles.length, feedTitle, articlesText } };
  },
};
