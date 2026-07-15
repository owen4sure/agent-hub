import { isPrivateHost, privateUrlsAllowed } from "./urlGuard";

/**
 * 用內建 headless chromium 打開網址、等前端渲染完、抽出可見文字+HTML。
 * 給「純 JS 渲染、plain fetch 抓不到文字」的網頁當補抓用——web-page 節點先用輕量 fetch,
 * 抓不到文字才退到這個真瀏覽器渲染(靜態頁不會多付這個成本)。
 *
 * SSRF 防護跟 /api/fetch-url 同一套(部署到雲端 VM 時很重要):
 *  - 進門先驗主機名(擋 loopback/私有網段/169.254 雲端 metadata)。
 *  - 再用 page.route 攔「頁面發出的每一個子請求」——不然一個 302 轉址或一張 <img> 就繞過進門檢查。
 *  內網有合法需求可設環境變數 AGENT_HUB_ALLOW_PRIVATE_URLS=1 關閉。
 */
export interface RenderedPage {
  title: string;
  text: string;
  html: string;
  finalUrl: string;
}

export async function renderPageText(rawUrl: string, opts?: { maxChars?: number; signal?: AbortSignal }): Promise<RenderedPage> {
  const maxChars = opts?.maxChars ?? 15000;
  const guardOn = !privateUrlsAllowed();
  const u = new URL(rawUrl);
  if (!/^https?:$/.test(u.protocol)) throw new Error("只支援 http/https 網址");
  if (guardOn && (await isPrivateHost(u.hostname))) {
    throw new Error(`這個網址指向內部網路(${u.hostname})`);
  }
  if (opts?.signal?.aborted) throw new Error("已停止執行");

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const onAbort = () => { void browser.close().catch(() => {}); };
  if (opts?.signal?.aborted) onAbort();
  opts?.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    if (guardOn) {
      await page.route("**/*", async (route) => {
        try {
          if (await isPrivateHost(new URL(route.request().url()).hostname)) return route.abort();
        } catch {
          return route.abort();
        }
        return route.continue();
      });
    }
    await page.goto(u.href, { waitUntil: "networkidle", timeout: 25_000 }).catch(async () => {
      // networkidle 有些站永遠等不到,退而求其次等 DOM 載完
      await page.goto(u.href, { waitUntil: "domcontentloaded", timeout: 15_000 });
    });
    await page.waitForTimeout(1000); // 給前端框架一點渲染時間
    const title = await page.title().catch(() => "");
    const text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => ""))
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxChars);
    const html = (await page.content().catch(() => "")).slice(0, 60_000);
    const finalUrl = page.url();
    return { title, text, html, finalUrl };
  } finally {
    opts?.signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
  }
}
