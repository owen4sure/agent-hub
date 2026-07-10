import { NextResponse } from "next/server";
import { extractTextFromFile } from "@/lib/textExtract";
import { renderXlsxToImage } from "@/lib/xlsxRender";
import { renderPdfToImages } from "@/lib/pdfRender";
import { renderDocxToImage } from "@/lib/docxRender";
import { extractEmbeddedImages } from "@/lib/embeddedImages";

const MAX_BYTES = 20 * 1024 * 1024; // 20MB，一份 SOP 文件不太可能超過這個大小

/**
 * 把使用者拖進聊天室的檔案(PDF/Word/RTF/Excel/PPT)在伺服器端解析。
 * 回傳「文字內容」+「圖片」——圖片讓 AI 像人一樣『真的看到』檔案(顏色/版型/框線/嵌入的圖)，
 * 不是只讀到值。Excel 會額外渲染成一張表格圖；Office 檔會把嵌入的圖片一起抽出來。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { filename?: string; dataBase64?: string } | null;
  if (!body?.filename || !body.dataBase64) {
    return NextResponse.json({ error: "缺少檔案內容" }, { status: 400 });
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(body.dataBase64, "base64");
  } catch {
    return NextResponse.json({ error: "檔案內容編碼錯誤" }, { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    return NextResponse.json({ error: "檔案太大(超過 20MB)，無法在對話裡直接解析" }, { status: 413 });
  }
  const result = await extractTextFromFile(body.filename, buffer);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 422 });

  const name = body.filename.toLowerCase();
  const images: { b64: string; name: string }[] = [];
  // Excel：渲染成一張表格圖，讓 AI 看得到顏色/深底白字/框線/合併/欄寬(重現版型的關鍵)
  if (/\.(xlsx|xlsm)$/.test(name)) {
    const rendered = await renderXlsxToImage(buffer).catch(() => null);
    if (rendered) images.push({ b64: rendered, name: `${body.filename}(渲染圖)` });
  }
  // PDF：逐頁渲染成圖，AI 才看得到版面/圖表/掃描內容(純文字抽取看不到)
  if (/\.pdf$/.test(name)) {
    const pages = await renderPdfToImages(buffer).catch(() => []);
    pages.forEach((b64, i) => images.push({ b64, name: `${body.filename}第${i + 1}頁` }));
  }
  // Word(.docx)：轉成保留結構的 HTML 再截圖，AI 看得到標題層級/表格/圖片位置
  if (/\.docx$/.test(name)) {
    const rendered = await renderDocxToImage(buffer).catch(() => null);
    if (rendered) images.push({ b64: rendered, name: `${body.filename}(渲染圖)` });
  }
  // Office 檔(xlsx/docx/pptx)裡嵌入的圖片也一起抽出來給 AI 看
  if (/\.(xlsx|xlsm|docx|pptx)$/.test(name)) {
    for (const img of extractEmbeddedImages(buffer)) images.push({ b64: img.b64, name: `${body.filename}內的圖:${img.name}` });
  }

  return NextResponse.json({ text: result.text, images });
}
