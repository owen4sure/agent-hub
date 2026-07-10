import fs from "node:fs";
import path from "node:path";

/**
 * 把 PDF 的每一頁渲染成圖片，讓 AI「看得到」PDF 的版面/圖表/掃描內容(純文字抽取看不到這些)。
 * 做法：在內建 chromium 的隔離分頁裡注入 pdf.js(legacy UMD 版)，逐頁畫到 canvas 再輸出 PNG。
 * 安全：getDocument 設 isEvalSupported:false(官方對 GHSA-wgrm-67xf-hhpq 惡意字型 eval 漏洞的緩解)，
 * 且渲染發生在「用完即關的獨立瀏覽器分頁」(about:blank、無 cookie、碰不到主程式)，雙重隔離。
 * 失敗回空陣列，讓上傳流程照走文字版。
 */
export async function renderPdfToImages(buffer: Buffer, maxPages = 4): Promise<string[]> {
  let pdfjsCode: string;
  let workerCode: string;
  try {
    const base = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build");
    pdfjsCode = fs.readFileSync(path.join(base, "pdf.min.js"), "utf-8");
    workerCode = fs.readFileSync(path.join(base, "pdf.worker.min.js"), "utf-8");
  } catch {
    return []; // pdfjs 沒裝好就跳過視覺渲染
  }

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 1 });
      // pdf.js 與 worker 都已內嵌注入、PDF 資料走 base64，零外部請求——但 PDF 是使用者上傳的，
      // 惡意文件可能誘發外部載入(內網探測)。直接封掉所有網路請求。
      await page.route("**/*", (route) => route.abort());
      await page.addScriptTag({ content: pdfjsCode });
      const images = await page.evaluate(
        async ({ b64, workerSrc, maxPages }) => {
          // worker 用 blob URL 提供(檔案內容已注入，不用出網路)
          const blob = new Blob([workerSrc], { type: "text/javascript" });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lib = (window as any).pdfjsLib;
          lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
          const raw = atob(b64);
          const data = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
          const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
          const out: string[] = [];
          const n = Math.min(doc.numPages, maxPages);
          for (let p = 1; p <= n; p++) {
            const pg = await doc.getPage(p);
            const viewport = pg.getViewport({ scale: 1.6 });
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await pg.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            out.push(canvas.toDataURL("image/png").split(",")[1]);
          }
          return out;
        },
        { b64: buffer.toString("base64"), workerSrc: workerCode, maxPages },
      );
      return images;
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {
    return [];
  }
}
