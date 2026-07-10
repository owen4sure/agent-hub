import AdmZip from "adm-zip";

/**
 * 從 Office 檔(.xlsx/.docx/.pptx，本質都是 zip)裡把嵌入的圖片抽出來，讓 AI 也「看得到」文件裡的圖
 * (截圖、logo、插圖、貼在儲存格上的圖…)。圖片放在 zip 的 xl/media/、word/media/、ppt/media/。
 * 回傳 base64 PNG/JPG 清單，失敗回空陣列(不擋上傳)。
 */
export function extractEmbeddedImages(buffer: Buffer, max = 6): { b64: string; name: string }[] {
  const out: { b64: string; name: string }[] = [];
  try {
    const zip = new AdmZip(buffer);
    for (const entry of zip.getEntries()) {
      if (out.length >= max) break;
      if (/\/(media|embeddings)\/.*\.(png|jpe?g|gif|bmp)$/i.test(entry.entryName)) {
        const data = entry.getData();
        if (data && data.length > 1024) {
          // 太小的多半是項目符號/裝飾圖，跳過
          out.push({ b64: data.toString("base64"), name: entry.entryName.split("/").pop() || "image" });
        }
      }
    }
  } catch { /* 不是 zip 或壞檔就回目前抓到的 */ }
  return out;
}
