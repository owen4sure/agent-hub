import mammoth from "mammoth";

/**
 * 把 Word(.docx) 渲染成一張圖片，讓 AI「看得到」文件的版面(標題層級/表格/粗體/圖片位置)，
 * 不只是讀純文字。做法：mammoth 轉成保留結構的 HTML(圖片內嵌 base64) → 內建 chromium 截圖。
 * 失敗回 null，上傳流程照走文字版。
 */
export async function renderDocxToImage(buffer: Buffer): Promise<string | null> {
  let html: string;
  try {
    const result = await mammoth.convertToHtml({ buffer });
    html = result.value;
    if (!html || html.trim() === "") return null;
  } catch {
    return null;
  }

  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:28px;background:#fff;max-width:820px;color:#111;
      font-family:'PingFang TC','Microsoft JhengHei','Noto Sans TC',serif;font-size:14px;line-height:1.6;}
    h1{font-size:22px} h2{font-size:18px} h3{font-size:16px}
    table{border-collapse:collapse;margin:8px 0;} td,th{border:1px solid #999;padding:4px 8px;font-size:13px;}
    img{max-width:100%;}
  </style></head><body>${html}</body></html>`;

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 880, height: 900 }, deviceScaleFactor: 1.5 });
      // 內容全是本地生成的 HTML(圖片已內嵌 base64)，正常情況零外部請求——但 .docx 是使用者上傳的，
      // 惡意文件可以夾 <img src="http://169.254.169.254/…"> 之類的外部引用，渲染時 chromium 會真的
      // 對內網/雲端 metadata 發請求(盲打 SSRF/內網探測)。直接封掉所有網路請求，data: URI 不受影響。
      await page.route("**/*", (route) => route.abort());
      await page.setContent(doc, { waitUntil: "load" });
      const body = await page.$("body");
      const shot = body ? await body.screenshot({ type: "png" }) : await page.screenshot({ type: "png", fullPage: true });
      return Buffer.from(shot).toString("base64");
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {
    return null;
  }
}
