import { getFirecrawlConfig } from "./settingsStore";

/**
 * Firecrawl 選配整合(2026-08)：「抓網頁」節點的**第三層**備援——輕量抓取失敗、內建瀏覽器
 * 也失敗,而且使用者有在設定頁填 Firecrawl 金鑰時,才會走到這裡。
 *
 * 為什麼是選配而不是內建:①要註冊金鑰(免費額度一次性)②抓的網頁內容會經過 Firecrawl 的
 * 伺服器——「資料不出本機」是這個平台的預設立場,把內容送出去必須是使用者自己打開的決定。
 * 自架 Firecrawl 的人在設定頁把服務網址換成自己的即可(資料就不出去了)。
 */

export function firecrawlConfigured(): boolean {
  return Boolean(getFirecrawlConfig().apiKey);
}

export interface FirecrawlPage {
  text: string;
  title: string;
  html: string;
  finalUrl: string;
}

export async function firecrawlScrape(url: string, opts: { signal?: AbortSignal } = {}): Promise<FirecrawlPage> {
  const { apiKey, baseUrl } = getFirecrawlConfig();
  if (!apiKey) throw new Error("Firecrawl 未設定");
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/scrape`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url, formats: ["markdown", "html"] }),
    signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: { markdown?: string; html?: string; metadata?: { title?: string; sourceURL?: string; statusCode?: number } };
    error?: string;
  } | null;
  if (!res.ok || !json?.success || !json.data) {
    const detail = json?.error ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new Error(`Firecrawl 金鑰無效或沒有權限(${detail})——請到設定頁重新貼一次金鑰`);
    if (res.status === 402 || res.status === 429) throw new Error(`Firecrawl 額度用完或請求太頻繁(${detail})——免費額度是一次性的,用完要升級方案或改用自架`);
    throw new Error(`Firecrawl 抓取失敗:${detail}`);
  }
  return {
    text: json.data.markdown ?? "",
    title: json.data.metadata?.title ?? "",
    html: json.data.html ?? "",
    finalUrl: json.data.metadata?.sourceURL ?? url,
  };
}
