import fs from "node:fs";
import path from "node:path";
import type { ParamField, WorkflowNode } from "./types";

/**
 * 模擬測試資料(GPT 體檢 #3):「測到會跑」不該卡在「還沒有真檔案/還沒串外部工具」。
 * 對表單/webhook 參數與檔案輸入,先用安全的模擬資料把流程驗一輪(分支走向/欄位傳遞/產出內容),
 * 真資料進來前就能抓到接錯的地方。誠實邊界:PDF/圖片這種「內容才是重點」的輸入生不出有意義的
 * 模擬檔,照舊停下請使用者給樣本,不假裝測過。
 */

/** 依欄位名/標籤猜一個合理的模擬值(保守通用,絕不帶任何真實個資) */
export function sampleValueFor(field: ParamField): string {
  const k = `${field.key} ${field.label}`.toLowerCase();
  if (/email|信箱|郵件/.test(k)) return "test@example.com";
  if (/url|網址|連結/.test(k)) return "https://example.com/";
  if (/amount|金額|price|價|費用|數量|qty/.test(k)) return "120";
  if (/date|日期|時間/.test(k)) return new Date().toISOString().slice(0, 10);
  if (/phone|電話|手機/.test(k)) return "0900000000";
  if (/name|姓名|名字|申請人|聯絡人/.test(k)) return "測試使用者";
  if (/id|編號|單號/.test(k)) return "TEST-001";
  return `測試${field.label || field.key}`;
}

/** 把觸發參數裡「沒預設值也沒人填」的洞用模擬值補滿;回報補了哪些讓測試紀錄講清楚 */
export function fillSampleParams(
  triggerParams: ParamField[],
  provided: Record<string, unknown>,
): { params: Record<string, unknown>; notes: string[] } {
  const params = { ...provided };
  const notes: string[] = [];
  for (const f of triggerParams) {
    if (f.derived) continue; // 衍生欄位由期間機制解析,不碰
    const cur = params[f.key] ?? f.default;
    if (cur !== undefined && cur !== null && String(cur).trim() !== "") continue;
    const v = sampleValueFor(f);
    params[f.key] = v;
    notes.push(`${f.label || f.key}=「${v}」`);
  }
  return { params, notes };
}

/** 檔案輸入的模擬樣本能不能自動生?(內容型輸入生了也是假測,誠實回 no) */
export function fileSampleKind(nodes: WorkflowNode[]): "csv" | "txt" | "no" {
  const consumers = nodes.filter((n) => JSON.stringify(n.config ?? {}).includes("{{filePath}}"));
  if (consumers.length === 0) return "txt";
  if (consumers.some((n) => n.type === "pdf-read" || n.type === "read-image")) return "no";
  if (consumers.some((n) => n.type === "excel-process")) return "csv";
  // read-file/custom-code 等:給 CSV 最通用(有表頭有列,文字讀取也讀得懂)
  return "csv";
}

/** 產生一個安全的模擬檔(放在 data/outputs 下,跟其他產出走同一套清理),回傳路徑 */
export function writeSampleFile(kind: "csv" | "txt"): { filePath: string; fileName: string } {
  const dir = path.join(process.cwd(), "data", "outputs", "autorun-samples");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = kind === "csv" ? `模擬資料-${stamp}.csv` : `模擬資料-${stamp}.txt`;
  const filePath = path.join(dir, fileName);
  const content =
    kind === "csv"
      ? "名稱,金額,日期\n測試項目A,120,2026-01-15\n測試項目B,80,2026-01-16\n測試項目C,300,2026-01-17\n"
      : "這是自動測試用的模擬文件。\n第一個重點:模擬資料僅供測試。\n第二個重點:真實資料進來前,先驗流程接線。\n第三個重點:測完可以刪除這個檔案。\n";
  fs.writeFileSync(filePath, content, "utf-8");
  return { filePath, fileName };
}
