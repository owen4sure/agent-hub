import { NextResponse } from "next/server";
import { isPrivateHost, privateUrlsAllowed } from "@/lib/urlGuard";
import { readGoogleDoc, parseGoogleDocUrl } from "@/lib/googleExport";

/**
 * 讓 dashboard 的 AI「看得到網址/網站」：用內建 chromium 打開網址 → 截整頁圖 + 抽出可見文字，
 * 回傳給對話。這樣使用者貼一個網址，AI 就能像人一樣看到那個網頁長什麼樣、寫了什麼。
 * 只允許 http/https，擋掉 file:// 之類的本機協定。
 *
 * SSRF 防護：這是「打開任意網址並把內容(含截圖)回傳」的功能，部署在雲端 VM 時若不擋內部位址，
 * 貼 http://169.254.169.254/... 就能整頁讀走雲端憑證、貼 192.168.x.x 能讀內網管理介面。
 * 除了進門先驗一次主機名，還要攔截頁面發出的「每一個請求」——不然對方網頁一個 302 轉址或
 * 一張 <img> 就繞過了進門檢查。內網有合法需求可設 AGENT_HUB_ALLOW_PRIVATE_URLS=1 關閉。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { url?: string } | null;
  const url = body?.url?.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "請提供正確的網址(要以 http:// 或 https:// 開頭)" }, { status: 400 });
  }
  const guardOn = !privateUrlsAllowed();
  if (guardOn && (await isPrivateHost(new URL(url).hostname))) {
    return NextResponse.json({ error: "這個網址指向內部網路位址，基於安全考量不開放讀取(自家內網有需要可設定環境變數 AGENT_HUB_ALLOW_PRIVATE_URLS=1)" }, { status: 400 });
  }

  // Google 試算表/文件是 canvas 畫的，DOM 抓不到真正的儲存格值——一定要用官方匯出拿到真實內容，
  // 不能只靠截圖用猜的。讀得到就直接回真值(這是「連結他還是只會截圖」的根治)；讀不到(私有/需登入)
  // 再往下退回 chromium 截圖，並在下面的 text 裡講明「只看得到畫面」。
  const gDoc = await readGoogleDoc(url).catch(() => null);
  if (gDoc) {
    return NextResponse.json({ title: gDoc.title, text: gDoc.text, googleExport: true });
  }

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 });
      if (guardOn) {
        await page.route("**/*", async (route) => {
          try {
            const host = new URL(route.request().url()).hostname;
            if (await isPrivateHost(host)) return route.abort();
          } catch {
            return route.abort();
          }
          return route.continue();
        });
      }
      await page.goto(url, { waitUntil: "networkidle", timeout: 25000 }).catch(async () => {
        // networkidle 有些站永遠等不到，退而求其次等 DOM 載完
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      });
      await page.waitForTimeout(1200); // 給前端渲染一點時間
      const title = await page.title().catch(() => "");
      // 抽可見文字(去掉 script/style)，截斷避免太長
      const text = await page.evaluate(() => {
        const b = document.body;
        return b ? (b.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 8000) : "";
      }).catch(() => "");
      // 整頁截圖(有上限，太長的頁面只截前面一大段)
      const shot = await page.screenshot({ type: "png", fullPage: true }).catch(() => page.screenshot({ type: "png" }));
      // 是 Google 文件卻走到這裡 = 匯出讀不到(多半是沒開「知道連結的人可檢視」)——老實講明只看得到畫面，
      // 讓 AI 不會假裝讀到了真值，也提示使用者把共用權限打開就能真正讀取。
      const gNote = parseGoogleDocUrl(url)
        ? `⚠️ 這是 Google 文件，但它沒有開放「知道連結的人可檢視」，我沒辦法讀到真正的儲存格內容，只能從下面這張截圖看到畫面(可能看不清楚)。請把共用權限改成「知道連結的人可檢視」，我就能直接讀到每一格的真實數值。\n\n`
        : "";
      return NextResponse.json({
        title,
        text: `${gNote}【網頁「${title || url}」的內容】\n${text}`,
        image: Buffer.from(shot).toString("base64"),
      });
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    return NextResponse.json({ error: `打不開這個網址：${err instanceof Error ? err.message.slice(0, 200) : "未知錯誤"}` }, { status: 502 });
  }
}
