import type { WorkflowNode } from "./types";
import { configuredSideEffects, dryRunSkipTypes, isPlaceholderCodeText } from "./sideEffects";

/**
 * 只讀驗證(dry-run)——使用者「叫 AI 去看檔案、證明有沒有看懂」用的。判斷某個節點在只讀模式要不要略過。
 * 安全鐵則:凡是「會寫出/發送、改變外部狀態」的節點都要略過,絕不能真的執行——這是「不會改你的試算表、
 * 不發任何通知」的保證。抽出成獨立小檔(不牽扯 engine 的 DB/瀏覽器重依賴),方便單獨測試這個安全性質。
 *
 * - write:寫出/發送型(通知、寄信、寫回試算表、寫檔、POST/PUT 打 API、會寫的 custom-code)→ 一律略過。
 * - fetch:去信箱/瀏覽器把輸入抓進來的 → 只有「使用者已經直接給了檔案」時才略過,改用他給的那份。
 */

// 改由 sideEffects.ts 這份「涵蓋所有節點型別」的分類推導，取代原本手寫的字串清單——新增會寄信/
// 寫檔的節點型別時，作者一定要在那份分類裡做一次明確決定，不會像以前一樣漏掉某一個消費端就安靜
// 失去防護。用 dryRun:"skip" 這個欄位而不是用副作用分類推導：excel-process／google-slides-* 確實
// 有副作用(分類照實寫)，但它們是「節點自己在動手前 return」，整步略過反而會讓讀取/驗證的輸出消失、
// 下游拿不到資料而假成功。**能力**與**只讀試跑怎麼處理它**是兩件事，分開記才不會為了配合其中一邊
// 而謊報另一邊(這正是遠端寫入被需求驗收放行的 P0 成因)。
export const DRYRUN_WRITE_TYPES = dryRunSkipTypes();

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

// custom-code 是萬用的——沒辦法只看型別知道它是「抽數字」還是「寫回試算表」,只能看意圖/程式碼有沒有
// 寫出的跡象。這組「有沒有寫出訊號」的判定已經抽到 sideEffects.ts 的 configuredSideEffects()，
// 跟需求驗收共用同一份(以前只有這裡有，requirementCheck 完全沒有，所以「只讀」需求下 custom-code
// 想寫什麼就寫什麼)。這個檔案只保留 dry-run 專屬、跟「有沒有副作用」不同層次的能力面判斷。

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

export function customCodeIsUnsafeForDryRun(config: Record<string, unknown>): boolean {
  const code = String(config.code ?? "");
  // 「這段程式碼/意圖會不會寫出去」的判定共用 sideEffects.configuredSideEffects()，跟需求驗收同一份。
  // 已有可執行 code 時它只看 code(不掃白話 intent)：例如「對不上就停止、不把猜測數字填回去」是純
  // 讀取/計算的保護條件，若掃 intent 會被「填回」誤判成寫入，安全驗證全綠卻根本沒跑計算。
  const isPlaceholder = isPlaceholderCodeText(code);
  const text = isPlaceholder ? String(config.intent ?? "") : code;
  const hasWriterSignal = configuredSideEffects("custom-code", config).effects.length > 0;
  if (hasWriterSignal || CUSTOM_UNSAFE_CAPABILITY_RE.test(text) || CUSTOM_MUTATING_BROWSER_RE.test(text)) return true;
  const literalImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(literalImportRe)) {
    if (!SAFE_DYNAMIC_IMPORTS.has(match[1])) return true;
  }
  // 非字面值的動態 import 無法知道最後會載入什麼；只讀模式保守攔住。
  if (/\bimport\s*\(/.test(code.replace(literalImportRe, ""))) return true;
  return false;
}

export interface DryRunSkipOptions {
  /** 這條流程裡「已經被**使用者**確認為唯讀」的 http-request 節點 id(見 httpReadOnlyApproval.ts)。
   * dryRun 是純函式、碰不到 DB，由呼叫端(engine/preview)查好傳進來。沒傳 = 一律未確認 = 照樣攔住。
   * repeat-steps 的內嵌步驟沒有真正的 node id、也無法在畫面上逐一確認，所以永遠拿不到豁免。 */
  readOnlyApprovedNodeIds?: ReadonlySet<string>;
}

export function dryRunSkipKind(node: WorkflowNode, fileProvided: boolean, opts: DryRunSkipOptions = {}): "write" | "fetch" | null {
  const t = node.type;
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  if (DRYRUN_WRITE_TYPES.has(t)) return "write";
  // http-request 的「這次會不會寫」由設定決定，跟需求驗收共用 configuredSideEffects()：
  // 預設不信任 POST/PUT/PATCH/DELETE。**只有使用者本人確認過這一份精確請求**才會放行——
  // 節點上的 readOnly 只是 AI 的建議，AI 自己說了不算(不然 AI 一句話就能繞過整個只讀保證)。
  if (t === "http-request"
    && configuredSideEffects(t, cfg, { readOnlyApproved: opts.readOnlyApprovedNodeIds?.has(node.id) }).effects.length > 0) return "write";
  if (t === "custom-code" && customCodeIsUnsafeForDryRun(cfg)) return "write";
  if (fileProvided && DRYRUN_FETCH_TYPES.has(t)) return "fetch";
  return null;
}
