import fs from "node:fs";
import pdfParse from "pdf-parse";
import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";

/**
 * 讀一個 PDF 檔，抽出裡面的純文字。發票/報表常常是 PDF 而不是 Excel，
 * 抽出文字後可以接 llm-decide(讓 AI 判斷/整理內容)或 if-condition(依內容分支)。
 */
export const pdfReadNode: NodeDefinition = {
  type: "pdf-read",
  category: "data",
  label: "讀取 PDF",
  description: "打開一個 PDF 檔(通常是上游下載的附件)，抽出裡面的文字內容，讓後面的步驟可以用文字比對或交給 AI 判讀。",
  icon: "📄",
  configSchema: [
    { key: "inputPath", label: "來源 PDF 路徑", type: "text", default: "{{attachmentPath}}" },
  ],
  outputs: "text(PDF 全文), numPages(頁數)",
  retryable: false,
  async execute(ctx) {
    const inputPath = cfgStr(ctx, "inputPath");
    if (!inputPath || !fs.existsSync(inputPath)) {
      throw new PermanentError(`找不到來源 PDF：${inputPath}`);
    }
    const buffer = fs.readFileSync(inputPath);
    let result;
    try {
      result = await pdfParse(buffer);
    } catch (err) {
      throw new PermanentError(`這個檔案不是有效的 PDF，或已損毀：${err instanceof Error ? err.message : String(err)}`);
    }
    ctx.log(`讀到 ${result.numpages} 頁，共 ${result.text.length} 字`);
    return { output: { text: result.text, numPages: result.numpages } };
  },
};
