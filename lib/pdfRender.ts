import fs from "node:fs";
import path from "node:path";

/**
 * 把 PDF 的每一頁渲染成圖片，讓 AI「看得到」PDF 的版面/圖表/掃描內容(純文字抽取看不到這些)。
 * 做法：在內建 chromium 的隔離分頁裡注入 pdf.js(legacy UMD 版)，逐頁畫到 canvas 再輸出 PNG。
 * 安全：getDocument 設 isEvalSupported:false(官方對 GHSA-wgrm-67xf-hhpq 惡意字型 eval 漏洞的緩解)，
 * 且渲染發生在「用完即關的獨立瀏覽器分頁」(about:blank、無 cookie、碰不到主程式)，雙重隔離。
 * 失敗回空陣列，讓上傳流程照走文字版。
 */
export interface RenderedPdfPage { page: number; b64: string }

/** 頁數太多時保留前後頁；SOP 的例外規則與簽核條件常在檔尾，不能永遠只看前幾頁。 */
export function selectPdfPageNumbers(totalPages: number, maxPages: number): number[] {
  const total = Math.max(0, Math.floor(totalPages));
  const limit = Math.max(0, Math.floor(maxPages));
  if (total === 0 || limit === 0) return [];
  if (total <= limit) return Array.from({ length: total }, (_, index) => index + 1);
  const headCount = Math.ceil(limit / 2);
  const tailCount = limit - headCount;
  return [
    ...Array.from({ length: headCount }, (_, index) => index + 1),
    ...Array.from({ length: tailCount }, (_, index) => total - tailCount + index + 1),
  ];
}

export async function renderPdfToImages(buffer: Buffer, maxPages = 4): Promise<RenderedPdfPage[]> {
  let pdfjsCode: string;
  let workerCode: string;
  try {
    const base = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build");
    // PDF.js 4+ 改成 ESM (.mjs)。不要為了沿用舊的全域 pdfjsLib 而卡在有已知 RCE 漏洞的 3.x。
    pdfjsCode = fs.readFileSync(path.join(base, "pdf.min.mjs"), "utf-8");
    workerCode = fs.readFileSync(path.join(base, "pdf.worker.min.mjs"), "utf-8");
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
      const images = await page.evaluate(
        async ({ b64, libSrc, workerSrc, maxPages }) => {
          // 主程式與 worker 都從本機套件讀入、用 blob module 載入，零外部網路。
          const libUrl = URL.createObjectURL(new Blob([libSrc], { type: "text/javascript" }));
          const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
          try {
            const lib = await import(libUrl);
            lib.GlobalWorkerOptions.workerSrc = workerUrl;
            const raw = atob(b64);
            const data = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
            const doc = await lib.getDocument({ data, isEvalSupported: false }).promise;
            const total = doc.numPages as number;
            const limit = Math.max(0, Math.floor(maxPages));
            const pages = total <= limit
              ? Array.from({ length: total }, (_, index) => index + 1)
              : [
                  ...Array.from({ length: Math.ceil(limit / 2) }, (_, index) => index + 1),
                  ...Array.from({ length: Math.floor(limit / 2) }, (_, index) => total - Math.floor(limit / 2) + index + 1),
                ];
            const out: { page: number; b64: string }[] = [];
            for (const p of pages) {
              const pg = await doc.getPage(p);
              const viewport = pg.getViewport({ scale: 1.6 });
              const canvas = document.createElement("canvas");
              canvas.width = viewport.width;
              canvas.height = viewport.height;
              await pg.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
              out.push({ page: p, b64: canvas.toDataURL("image/png").split(",")[1] });
            }
            return out;
          } finally {
            URL.revokeObjectURL(libUrl);
            URL.revokeObjectURL(workerUrl);
          }
        },
        { b64: buffer.toString("base64"), libSrc: pdfjsCode, workerSrc: workerCode, maxPages },
      );
      return images;
    } finally {
      await browser.close().catch(() => {});
    }
  } catch {
    return [];
  }
}
