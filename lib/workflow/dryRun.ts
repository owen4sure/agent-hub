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
// 已有 code 時只能用可執行的 side-effect 訊號判斷。把「填入」「寫回」這種中文放進來會誤傷
// 讀取程式裡的防呆錯誤(例如「避免把 0 填入」)，安全試跑反而從未執行真正要驗的計算。
const CUSTOM_CODE_WRITER_RE = /values\s*(?:\.|\[['"])(?:update|append)|batchUpdate|spreadsheets\s*\.\s*values|setValue|getCell\s*\([^)]*\)\s*\.\s*value\s*=|\.(?:addRow|spliceRows|insertRow|deleteRow)\s*\(|xlsx\s*\.\s*writeFile|(?:\.|\[['"])(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|chmod|chmodSync|chown|chownSync)['"]?\s*(?:\]|\()|fs\s*\.\s*(?:promises\s*\.\s*)?(?:write|append|rm|unlink|rename|copyFile|mkdir|createWriteStream)|method\s*:\s*(?:['"]?(?:POST|PUT|PATCH|DELETE)|[^,}\n]*(?:POST|PUT|PATCH|DELETE))|axios\s*(?:\.|\[['"])(?:post|put|patch|delete)|(?:got|request)\s*(?:\.|\[['"])(?:post|put|patch|delete)|sendMail|sendMessage|child_process|\b(?:exec|execFile|spawn|fork)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE)\b/i;
const CUSTOM_INTENT_WRITER_RE = /寫入|填入|回填|寫回|更新到|上傳到|送出到|刪除檔案|移動檔案|建立資料夾/i;

// custom-code 跟主程式跑在同一個 Node.js 行程，單靠「POST/寫檔」幾個字無法構成真正的只讀保證。
// 但 ctx.session 本身不能一概攔住：例如前往 Drive、讀檔名、輸出 fileType 是真正的讀取步驟；
// 以前跳過它會令下游 switch 永遠拿到 {{fileType}}，AI 只能鬼打牆地修錯節點。
// 真正會改變外部狀態的瀏覽器輸入／點擊操作在下面獨立攔住。
// 「global」是 Node.js 對 globalThis 的另一個別名(舊版規則只查 globalThis，漏了這個)——
// 實測踩過的繞過手法：程式碼寫 `global.fetch(...)`/`global["process"]` 完全不含
// globalThis/fetch(緊接括號)這幾個原本認得的字面樣式，卻能直接摸到跟 globalThis 一樣的能力。
// 限定「global 後面緊接 . 或 [」(明確的屬性存取語法)才算，不裸比對 \bglobal\b 整個字——
// 英文說明文字或註解裡常有「global setting」「global variable」這種正常詞語，裸比對會誤傷。
// 這仍然只是字面規則、不是真正的執行期隔離(見上面 dryRun.ts:39 的既有註解)：用變數多繞一層
// (例如 const g = this; const f = g["fe"+"tch"])一樣繞得過去，字面規則對這種刻意拆解的
// 代稱鏈原則上防不住，真正的解法是執行期隔離(vm/獨立行程)，不是加更多正規表示式。
const CUSTOM_UNSAFE_CAPABILITY_RE = /\bctx\s*\.\s*registerFile\b|\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|\b(?:axios|got|request)\b|\b(?:process|Bun|Deno)\b|\brequire\s*\(|(?<!\$)\beval\s*\(|\bFunction\s*\(|\bglobalThis\b|\bglobal\s*[[.]|node:(?:child_process|http|https|net|tls|dgram)|child_process/i;
/**
 * 允許開頁、GET 導頁、等待與讀 DOM；禁止輸入、點擊、上傳及取得未受限 Browser。
 * `evaluate`/`$eval`/`$$eval` 刻意不算在內——這是讀取畫面上實際渲染內容(例如列出資料夾檔名、
 * 判斷檔案類型)的標準做法，跟上面這段註解說的「讀取步驟不能一概攔住」是同一件事，只是這裡
 * 之前漏了：曾經真實發生過「爬 Google Drive 檔名清單的節點被這個規則判成危險操作而略過，
 * 下游 switch 永遠拿到沒解析的 {{fileType}} 而秒失敗」，而且只在「只測這幾步/從這一步開始測」
 * (兩者一定強制用這個安全模式)才會踩到，容易被誤以為是那兩個按鈕本身壞掉。
 */
const CUSTOM_MUTATING_BROWSER_RE = /\bctx\s*\.\s*session\s*\.\s*getBrowser\s*\(|\.(?:click|dblclick|fill|press|pressSequentially|type|clear|check|uncheck|setChecked|selectOption|setInputFiles|dragTo|dragAndDrop|dispatchEvent|focus|hover|tap|context|submit|requestSubmit)\s*\(|\b(?:keyboard|mouse)\s*\./i;
// fs/node:fs 只有讀取時是安全試跑必要能力：codegen 常用 existsSync 確認使用者剛選的
// Excel 是否存在。真正的 writeFile/rm/copyFile 等仍由 CUSTOM_CODE_WRITER_RE 攔住，
// 不能因為「有 import fs」就讓純讀 Excel 被跳過、下游拿空資料卻假裝成功。
const SAFE_DYNAMIC_IMPORTS = new Set(["exceljs", "xlsx", "path", "node:path", "crypto", "node:crypto", "fs", "node:fs"]);

// 避免從 codegen 匯入而把 registry → customCode → dryRun → codegen 拉成初始化循環；
// 規則必須與 codegen.isPlaceholderCode 一致。
function isPlaceholderCodeForDryRun(code: string): boolean {
  const value = code.trim();
  return !value || /^return\s*\{\s*\.\.\.\s*ctx\.input\s*,?\s*\}\s*;?$/.test(value);
}

export function customCodeIsUnsafeForDryRun(config: Record<string, unknown>): boolean {
  const code = String(config.code ?? "");
  // 已有可執行 code 時，安全性必須以「它實際會做什麼」判斷，不能掃白話 intent。
  // 例如「對不上就停止、不把猜測數字填回去」是純讀取/計算的保護條件，舊規則只看到「填回」
  // 就把它略過，讓 AI 修復的安全驗證全綠卻根本沒有跑計算。空殼尚未產碼時才退回看 intent，
  // 以免「等等會寫表」的步驟在沒有可檢查 code 時被錯放行。
  const isPlaceholder = isPlaceholderCodeForDryRun(code);
  const text = isPlaceholder ? String(config.intent ?? "") : code;
  const hasWriterSignal = isPlaceholder ? CUSTOM_INTENT_WRITER_RE.test(text) : CUSTOM_CODE_WRITER_RE.test(text);
  if (hasWriterSignal || CUSTOM_UNSAFE_CAPABILITY_RE.test(text) || CUSTOM_MUTATING_BROWSER_RE.test(text)) return true;
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
