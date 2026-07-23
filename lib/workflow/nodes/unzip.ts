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

// zip 炸彈防護：解壓縮前先看宣告的未壓縮總大小/檔案數，太誇張(遠超真實業務檔案會有的量)就直接拒絕，
// 不要真的把它整包解到硬碟才發現吃光空間/CPU。上限刻意給得寬(500MB/2000 檔)，正常的報表/截圖壓縮包
// 不會踩到，只擋真正異常的比例(zip bomb 常見手法是幾 KB 的檔案宣告解壓後幾 GB)。
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

/**
 * 解壓縮一個 zip 檔(常見情境：webmail 附件是壓縮包，裡面才是真正的 Excel/PDF)。
 * 解出來的每個檔案都會登記進「產出檔案」，也可以接下一步用 {{files.0}} 這類引用第一個檔案的路徑
 * (實際上是靠 outputPath 陣列，下游用 template-text 或 custom-code 自行處理路徑清單)。
 */
export const unzipNode: NodeDefinition = {
  type: "unzip",
  category: "file",
  label: "解壓縮",
  description: "解開一個 zip 壓縮檔(通常是上游下載的附件)，把裡面的檔案全部解到產出資料夾給下游處理。",
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
    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new PermanentError(`這個 zip 檔裡有 ${entries.length} 個檔案，超過上限 ${MAX_ZIP_ENTRIES} 個，為避免解壓縮炸彈已停止`);
    }
    const totalDeclaredBytes = entries.reduce((sum, e) => sum + (Number(e.header.size) || 0), 0);
    if (totalDeclaredBytes > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) {
      throw new PermanentError(`這個 zip 檔解壓縮後宣告總大小超過 ${MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES / 1024 / 1024}MB 上限，為避免解壓縮炸彈已停止`);
    }

    zip.extractAllTo(extractedDir, true);
    ctx.log(`解出 ${entries.length} 個檔案到 ${extractedDir}`);

    // 檔案清單一定要「實際走一遍解壓縮後的資料夾」蒐集，不能拿 zip entry 裡的原始路徑名(entryName)
    // 自己重新組——那個字串來自壓縮檔本身、不可信，若含 "../../.env" 這類路徑，重新組出來的路徑
    // 會指向專案根目錄的真實 .env/資料庫等敏感檔案；只要磁碟上剛好已經有同名檔案，就會被誤登記成
    // 「這次解壓縮出來的檔案」而流向下游。extractAllTo 本身在寫入磁碟時已經會做路徑淨化(不會真的
    // 寫到 extractedDir 外面)，這裡改成直接列出 extractedDir 底下實際寫出的東西，從根本避免路徑重組。
    const extractedRoot = fs.realpathSync(extractedDir);
    const dirents = fs.readdirSync(extractedRoot, { recursive: true, withFileTypes: true }) as fs.Dirent[];
    const files = dirents
      .filter((d) => d.isFile())
      .map((d) => path.join(d.parentPath ?? (d as unknown as { path: string }).path, d.name))
      .sort();
    for (const filePath of files) {
      ctx.registerFile(path.basename(filePath), filePath, guessMime(filePath), "intermediate");
    }

    return { output: { files, fileCount: files.length, extractedDir } };
  },
};
