import type { WorkflowNode } from "./types";

/**
 * 只讀驗證(dry-run)——使用者「叫 AI 去看檔案、證明有沒有看懂」用的。判斷某個節點在只讀模式要不要略過。
 * 安全鐵則:凡是「會寫出/發送、改變外部狀態」的節點都要略過,絕不能真的執行——這是「不會改你的試算表、
 * 不發任何通知」的保證。抽出成獨立小檔(不牽扯 engine 的 DB/瀏覽器重依賴),方便單獨測試這個安全性質。
 *
 * - write:寫出/發送型(通知、寄信、寫回試算表、寫檔、POST/PUT 打 API、會寫的 custom-code)→ 一律略過。
 * - fetch:去信箱/瀏覽器把輸入抓進來的 → 只有「使用者已經直接給了檔案」時才略過,改用他給的那份。
 */

export const DRYRUN_WRITE_TYPES = new Set([
  "telegram-notify", "slack-notify", "line-notify", "send-email", "desktop-notify",
  "google-sheet-append", "write-file",
]);

export const DRYRUN_FETCH_TYPES = new Set(["find-email", "email-read", "download-attachment", "browser-login"]);

// custom-code 是萬用的——沒辦法只看型別知道它是「抽數字」還是「寫回試算表」,只能看意圖/程式碼有沒有寫出的跡象。
// 命中就當寫出、略過(寧可少做也不誤寫);純讀取/計算的抽取碼不會命中這些關鍵字。
const CUSTOM_WRITER_RE = /values\.(update|append)|batchUpdate|spreadsheets\.values|setValue|xlsx\.writeFile|workbook\.xlsx\.writeFile|\.writeFile\s*\(|fs\.(write|append)|method\s*:\s*['"]?(POST|PUT|PATCH|DELETE)|寫入|填入|回填|寫回|更新到|上傳到|送出到/i;

export function dryRunSkipKind(node: WorkflowNode, fileProvided: boolean): "write" | "fetch" | null {
  const t = node.type;
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  if (DRYRUN_WRITE_TYPES.has(t)) return "write";
  if (t === "http-request") {
    const method = String(cfg.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return "write"; // 打 API 寫資料(POST/PUT…)算寫出
  }
  if (t === "custom-code" && CUSTOM_WRITER_RE.test(`${cfg.intent ?? ""}\n${cfg.code ?? ""}`)) return "write";
  if (fileProvided && DRYRUN_FETCH_TYPES.has(t)) return "fetch";
  return null;
}
