import fs from "node:fs";
import path from "node:path";
import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { extractTextFromFile } from "../../textExtract";

function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    ".csv": "text/csv", ".html": "text/html",
  };
  return map[ext] ?? "text/plain";
}

/**
 * 寫文字檔：把上游算好的內容存成一個檔案(產出資料夾，出現在「產出檔案」頁可下載)。
 * 這是最常見的「把結果留下來」動作——之前只能靠 custom-code 寫，現在是測試過的積木。
 */
export const writeFileNode: NodeDefinition = {
  type: "write-file",
  category: "file",
  label: "寫檔案",
  description: "把文字內容存成一個檔案(如 .txt/.md/.csv)。內容裡可用 {{欄位}} 引用上游資料。存到產出資料夾、可下載；也可以額外指定一個絕對路徑資料夾多存一份(例如桌面)。",
  icon: "💾",
  configSchema: [
    { key: "fileName", label: "檔名(含副檔名)", type: "text", default: "output.txt" },
    { key: "content", label: "檔案內容(可用 {{欄位}})", type: "textarea" },
    { key: "extraDir", label: "額外複製到(絕對路徑資料夾，留空=只存產出資料夾)", type: "text", allowEmpty: true },
  ],
  outputs: "savedPath(存好的檔案路徑), savedFileName(檔名)",
  retryable: false,
  async execute(ctx) {
    const fileName = path.basename(cfgStr(ctx, "fileName", "output.txt")); // basename 擋路徑穿越
    const content = cfgStr(ctx, "content", "");
    if (!content.trim()) {
      throw new PermanentError("檔案內容是空的——請確認上游有把要存的內容傳下來(內容欄用 {{欄位}} 引用)");
    }
    const savedPath = path.join(ctx.outputDir, fileName);
    fs.writeFileSync(savedPath, content, "utf-8");
    ctx.registerFile(fileName, savedPath, guessMime(fileName));
    ctx.log(`已寫入 ${fileName}(${content.length} 字)`);

    const extraDir = cfgStr(ctx, "extraDir", "");
    if (extraDir.trim()) {
      if (!fs.existsSync(extraDir) || !fs.statSync(extraDir).isDirectory()) {
        throw new PermanentError(`額外複製的目的地不存在或不是資料夾：${extraDir}`);
      }
      fs.copyFileSync(savedPath, path.join(extraDir, fileName));
      ctx.log(`已額外複製到 ${extraDir}`);
    }
    return { output: { savedPath, savedFileName: fileName } };
  },
};

/**
 * 讀檔案：把一個檔案(路徑通常來自上游，例如資料夾監聽的 {{filePath}}、下載的附件)讀成文字給下游用。
 * PDF/Word/Excel/PowerPoint/RTF 會自動抽成純文字(跟上傳檔案給 AI 看的是同一套解析)。
 */
export const readFileNode: NodeDefinition = {
  type: "read-file",
  category: "file",
  label: "讀檔案",
  description: "讀取一個檔案的內容成文字，給下游(AI 判斷/寫檔/條件)使用。支援純文字家族與 PDF、Word、Excel、PowerPoint、RTF(自動抽出文字)。路徑通常引用上游欄位，如資料夾監聽觸發的 {{filePath}}。",
  icon: "📂",
  configSchema: [
    { key: "path", label: "檔案路徑(可用 {{filePath}} 等上游欄位)", type: "text", default: "{{filePath}}" },
    { key: "maxChars", label: "最多讀取字數(避免超大檔塞爆下游)", type: "number", default: "20000" },
  ],
  outputs: "fileText(檔案文字內容), fileName(檔名), fileSize(bytes)",
  retryable: false,
  async execute(ctx) {
    const filePath = cfgStr(ctx, "path");
    if (!filePath || !fs.existsSync(filePath)) {
      throw new PermanentError(`找不到檔案：${filePath || "(路徑是空的)"}——請確認上游有傳路徑下來(如 {{filePath}})`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new PermanentError(`這個路徑不是檔案：${filePath}`);
    const maxChars = Number(cfgStr(ctx, "maxChars", "20000")) || 20000;

    const buffer = fs.readFileSync(filePath);
    const name = path.basename(filePath);
    const extracted = await extractTextFromFile(name, buffer);
    let text: string;
    if ("text" in extracted) {
      text = extracted.text;
    } else if (/\.(txt|md|json|csv|log|html|htm|xml|yml|yaml)$/i.test(name)) {
      text = buffer.toString("utf-8");
    } else {
      // extractTextFromFile 只認得它支援的格式；其他副檔名先當 UTF-8 純文字試讀，
      // 有大量替換字元(亂碼)就老實報錯，不要把二進位垃圾丟給下游假裝成功
      text = buffer.toString("utf-8");
      const bad = (text.slice(0, 2000).match(/�/g) ?? []).length;
      if (bad > 20) throw new PermanentError(`這個檔案(${name})不是文字檔，也不是支援的文件格式(PDF/Word/Excel/PPT/RTF)`);
    }
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    ctx.log(`讀取 ${name}：${text.length} 字${truncated ? "(已截斷)" : ""}`);
    return { output: { fileText: text, fileName: name, fileSize: stat.size } };
  },
};
