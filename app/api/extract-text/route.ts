import { NextResponse } from "next/server";
import { extractTextFromFile } from "@/lib/textExtract";
import { renderXlsxToImage } from "@/lib/xlsxRender";
import { renderPdfToImages } from "@/lib/pdfRender";
import { renderDocxToImage } from "@/lib/docxRender";
import { renderPptxToImages } from "@/lib/pptxRender";
import { extractEmbeddedImages } from "@/lib/embeddedImages";
import { saveChatAttachment } from "@/lib/chatAttachments";
import { getWorkflow, isValidWorkflowId } from "@/lib/workflow/store";

const MAX_BYTES = 20 * 1024 * 1024; // 20MB，一份 SOP 文件不太可能超過這個大小

/**
 * 把使用者拖進聊天室的檔案(PDF/Word/RTF/Excel/PPT)在伺服器端解析。
 * 回傳「文字內容」+「圖片」——圖片讓 AI 像人一樣『真的看到』檔案(顏色/版型/框線/嵌入的圖)，
 * 不是只讀到值。Excel 會額外渲染成一張表格圖；Office 檔會把嵌入的圖片一起抽出來。
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { filename?: string; dataBase64?: string; mime?: string; workflowId?: string } | null;
  if (!body?.filename || !body.dataBase64) {
    return NextResponse.json({ error: "缺少檔案內容" }, { status: 400 });
  }
  if (body.workflowId !== undefined && (!isValidWorkflowId(body.workflowId) || !getWorkflow(body.workflowId))) {
    return NextResponse.json({ error: "附件所屬的 workflow 不存在" }, { status: 404 });
  }
  // Buffer.from(base64) 會默默忽略 %%% 等非法字元，不會 throw，必須先嚴格驗證。
  const encoded = body.dataBase64.replace(/\s/g, "");
  // 不用一個巨大 regexp 掃 28MB 字串：V8 在這個大小可能因 regexp 回溯堆疊溢位。
  // 先解碼再重新編碼，只有標準、完整、無非法字元的 base64 會逐字一致。
  if (!encoded || encoded.length % 4 !== 0) {
    return NextResponse.json({ error: "檔案內容編碼錯誤" }, { status: 400 });
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.toString("base64") !== encoded) {
    return NextResponse.json({ error: "檔案內容編碼錯誤" }, { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    return NextResponse.json({ error: "檔案太大(超過 20MB)，無法在對話裡直接解析" }, { status: 413 });
  }
  const suppliedMime = typeof body.mime === "string" ? body.mime.toLowerCase() : "";
  if (suppliedMime.startsWith("image/")) {
    const images = [{ b64: encoded, name: body.filename, mime: suppliedMime }];
    const asset = saveChatAttachment({
      workflowId: body.workflowId,
      filename: body.filename,
      mime: suppliedMime,
      text: `(圖片附件：${body.filename})`,
      originalBase64: encoded,
      images,
    });
    return NextResponse.json({ text: asset.text, images, assetId: asset.id });
  }
  const result = await extractTextFromFile(body.filename, buffer);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 422 });

  const name = body.filename.toLowerCase();
  const images: { b64: string; name: string; mime: string }[] = [];
  // Excel：渲染成一張表格圖，讓 AI 看得到顏色/深底白字/框線/合併/欄寬(重現版型的關鍵)
  if (/\.(xlsx|xlsm)$/.test(name)) {
    const rendered = await renderXlsxToImage(buffer).catch(() => null);
    if (rendered) images.push({ b64: rendered, name: `${body.filename}(渲染圖)`, mime: "image/png" });
  }
  // PDF：逐頁渲染成圖，AI 才看得到版面/圖表/掃描內容(純文字抽取看不到)
  if (/\.pdf$/.test(name)) {
    const pages = await renderPdfToImages(buffer).catch(() => []);
    pages.forEach((page) => images.push({ b64: page.b64, name: `${body.filename}第${page.page}頁`, mime: "image/png" }));
  }
  // Word(.docx)：轉成保留結構的 HTML 再截圖，AI 看得到標題層級/表格/圖片位置
  if (/\.docx$/.test(name)) {
    const rendered = await renderDocxToImage(buffer).catch(() => null);
    if (rendered) images.push({ b64: rendered, name: `${body.filename}(渲染圖)`, mime: "image/png" });
  }
  // PowerPoint：逐頁轉成圖，讓 AI 看得到真正的排版、圖表與色彩；只抽 XML 文字會看不出
  // 「哪個數字在哪一張、是不是標題或註解」，很容易把工作流程理解錯。
  if (/\.pptx$/.test(name)) {
    const pages = await renderPptxToImages(buffer).catch(() => []);
    pages.forEach((page) => images.push({ b64: page.b64, name: `${body.filename}第${page.page}張投影片`, mime: "image/png" }));
  }
  // Office 檔(xlsx/docx/pptx)裡嵌入的圖片也一起抽出來給 AI 看
  if (/\.(xlsx|xlsm|docx|pptx)$/.test(name)) {
    for (const img of extractEmbeddedImages(buffer)) images.push({ b64: img.b64, name: `${body.filename}內的圖:${img.name}`, mime: img.mime });
  }

  const asset = saveChatAttachment({
    workflowId: body.workflowId,
    filename: body.filename,
    mime: suppliedMime || undefined,
    text: result.text,
    originalBase64: encoded,
    images,
  });
  return NextResponse.json({ text: result.text, images, assetId: asset.id });
}
