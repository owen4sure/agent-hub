import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";

/** 猜副檔名對應的 mime type(給 registerFile 用，只是方便下載時瀏覽器認得，不影響資料正確性) */
function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".json": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * 解壓縮一個 zip 檔(常見情境：webmail 附件是壓縮包，裡面才是真正的 Excel/PDF)。
 * 解出來的每個檔案都會登記進「產出檔案」，也可以接下一步用 {{files.0}} 這類引用第一個檔案的路徑
 * (實際上是靠 outputPath 陣列，下游用 template-text 或 custom-code 自行處理路徑清單)。
 */
export const unzipNode: NodeDefinition = {
  type: "unzip",
  category: "file",
  label: "解壓縮",
  description: "解開一個 zip 壓縮檔(通常是上游下載的附件)，把裡面的檔案全部解到產出資料夾，並登記成可下載的產出檔。",
  icon: "🗜️",
  configSchema: [
    { key: "inputPath", label: "來源 zip 路徑", type: "text", default: "{{attachmentPath}}" },
    { key: "outputDirName", label: "解壓縮後的子資料夾名稱", type: "text", default: "extracted" },
  ],
  outputs: "files(解出的檔案路徑陣列), fileCount(檔案數), extractedDir(解壓縮到的資料夾)",
  retryable: false,
  async execute(ctx) {
    const inputPath = cfgStr(ctx, "inputPath");
    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new PermanentError(`找不到來源 zip 檔：${inputPath}`);
    }
    const outputDirName = cfgStr(ctx, "outputDirName", "extracted");
    const extractedDir = path.join(ctx.outputDir, outputDirName);
    fs.mkdirSync(extractedDir, { recursive: true });

    let zip: AdmZip;
    try {
      zip = new AdmZip(inputPath);
    } catch (err) {
      throw new PermanentError(`這個檔案不是有效的 zip，或已損毀：${err instanceof Error ? err.message : String(err)}`);
    }
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length === 0) throw new PermanentError("這個 zip 檔裡沒有任何檔案");

    zip.extractAllTo(extractedDir, true);
    ctx.log(`解出 ${entries.length} 個檔案到 ${extractedDir}`);

    const files: string[] = [];
    for (const entry of entries) {
      const filePath = path.join(extractedDir, entry.entryName);
      if (!fs.existsSync(filePath)) continue; // 極少數 zip 內部路徑跟 extractAllTo 展開結果對不上，跳過而不是整個節點失敗
      files.push(filePath);
      ctx.registerFile(path.basename(filePath), filePath, guessMime(filePath));
    }

    return { output: { files, fileCount: files.length, extractedDir } };
  },
};
