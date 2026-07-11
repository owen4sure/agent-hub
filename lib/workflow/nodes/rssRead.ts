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
    const host = new URL(url).hostname;
    if (await isPrivateHost(host)) throw new PermanentError(`不允許讀取內部網路位址(${host})`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    if (ctx.cancelSignal?.aborted) controller.abort();
    const onAbort = () => controller.abort();
    ctx.cancelSignal?.addEventListener("abort", onAbort, { once: true });
    let xml: string;
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "AgentHub/1.0 RSS" } });
      if (res.status === 404) throw new PermanentError("這個網址回 404——確認 feed 網址貼對(常見是 /rss、/feed、/atom.xml 結尾)");
      if (res.status >= 500) throw new RetryableError(`來源暫時錯誤(${res.status})`);
      if (res.status !== 200) throw new PermanentError(`抓取失敗(HTTP ${res.status})`);
      xml = await res.text();
    } finally {
      clearTimeout(timer);
      ctx.cancelSignal?.removeEventListener("abort", onAbort);
    }
    const maxItems = Math.min(Number(cfgStr(ctx, "maxItems", "10")) || 10, 50);
    // RSS 2.0 <item>;Atom <entry>——兩種都收
    const blocks = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi)].map((m) => m[0]);
    if (blocks.length === 0) throw new PermanentError("這個網址的內容不像 RSS/Atom(找不到任何 item/entry)——確認貼的是 feed 網址不是網站首頁");
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
