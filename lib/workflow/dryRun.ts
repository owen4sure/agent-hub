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
  "google-sheet-append", "google-sheet-update", "write-file",
]);

export const DRYRUN_FETCH_TYPES = new Set(["find-email", "email-read", "download-attachment", "browser-login"]);

/**
 * 內嵌 custom-code／repeat-steps 被攔住時，外層 node_run 仍會是 success；用這個保留欄位把
 * 「原本會寫什麼」帶回 preview.ts，讓畫面能如實列出，而不是因為安全略過就假裝流程沒有寫入步驟。
 */
export const DRY_RUN_SKIPPED_WRITES_KEY = "__agentHubDryRunSkippedWrites";

export interface DryRunSkippedWrite {
  nodeLabel: string;
  type: string;
  config: Record<string, unknown>;
  input: Record<string, unknown>;
}

// custom-code 是萬用的——沒辦法只看型別知道它是「抽數字」還是「寫回試算表」,只能看意圖/程式碼有沒有寫出的跡象。
// 命中就當寫出、略過(寧可少做也不誤寫);純讀取/計算的抽取碼不會命中這些關鍵字。
const CUSTOM_WRITER_RE = /values\s*(?:\.|\[['"])(?:update|append)|batchUpdate|spreadsheets\s*\.\s*values|setValue|xlsx\s*\.\s*writeFile|(?:\.|\[['"])(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|chmod|chmodSync|chown|chownSync)['"]?\s*(?:\]|\()|fs\s*\.\s*(?:promises\s*\.\s*)?(?:write|append|rm|unlink|rename|copyFile|mkdir|createWriteStream)|method\s*:\s*(?:['"]?(?:POST|PUT|PATCH|DELETE)|[^,}\n]*(?:POST|PUT|PATCH|DELETE))|axios\s*(?:\.|\[['"])(?:post|put|patch|delete)|(?:got|request)\s*(?:\.|\[['"])(?:post|put|patch|delete)|sendMail|sendMessage|child_process|\b(?:exec|execFile|spawn|fork)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE)\b|寫入|填入|回填|寫回|更新到|上傳到|送出到|刪除檔案|移動檔案|建立資料夾/i;

// custom-code 跟主程式跑在同一個 Node.js 行程，單靠「POST/寫檔」幾個字無法構成真正的只讀保證：
// fs.promises.writeFile、ctx.session.click、動態組出 method，甚至匯入任意 SDK 都能繞過。只讀試跑採
// capability allow-list：網路、瀏覽器控制、系統行程、任意模組、eval 全部保守攔住；純計算與已知的
// 試算表讀取套件仍可執行。這不是拿 regex 當惡意程式碼 sandbox（匯入 workflow 的 code 本來就會清空），
// 而是避免 AI 生成的正常程式碼意外造成外部副作用。
const CUSTOM_UNSAFE_CAPABILITY_RE = /\bctx\s*\.\s*(?:session|registerFile)\b|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\b(?:axios|got|request)\b|\b(?:process|Bun|Deno)\b|\brequire\s*\(|\b(?:eval|Function)\s*\(|\bglobalThis\b|node:(?:fs|child_process|http|https|net|tls|dgram)|(?:^|["'])fs(?:\/promises)?["']|child_process/i;
const SAFE_DYNAMIC_IMPORTS = new Set(["exceljs", "xlsx", "path", "node:path", "crypto", "node:crypto"]);

export function customCodeIsUnsafeForDryRun(config: Record<string, unknown>): boolean {
  const text = `${config.intent ?? ""}\n${config.code ?? ""}`;
  if (CUSTOM_WRITER_RE.test(text) || CUSTOM_UNSAFE_CAPABILITY_RE.test(text)) return true;
  const code = String(config.code ?? "");
  const literalImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(literalImportRe)) {
    if (!SAFE_DYNAMIC_IMPORTS.has(match[1])) return true;
  }
  // 非字面值的動態 import 無法知道最後會載入什麼；只讀模式保守攔住。
  if (/\bimport\s*\(/.test(code.replace(literalImportRe, ""))) return true;
  return false;
}

export function dryRunSkipKind(node: WorkflowNode, fileProvided: boolean): "write" | "fetch" | null {
  const t = node.type;
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  if (DRYRUN_WRITE_TYPES.has(t)) return "write";
  if (t === "http-request") {
    const method = String(cfg.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return "write"; // 打 API 寫資料(POST/PUT…)算寫出
  }
  if (t === "custom-code" && customCodeIsUnsafeForDryRun(cfg)) return "write";
  if (fileProvided && DRYRUN_FETCH_TYPES.has(t)) return "fetch";
  return null;
}
