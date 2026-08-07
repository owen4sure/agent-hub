/**
 * 節點副作用分類——需求驗收(requirementCheck)與只讀安全試跑(dryRun)共用的單一真相來源。
 *
 * 為什麼要有這份：以前這兩個消費端各自維護一份手寫的節點型別清單，新增一個會寄信／寫檔的節點型別
 * 時，沒有任何機制提醒作者去更新這兩處，漏掉的那一邊就會安靜地失去防護。
 *
 * ⚠️ 這份表描述的是**節點實際的能力**，不是「dry-run 怎麼處理它」。這兩件事必須分開記(見 `dryRun`
 * 欄位)：真實踩過的 P0——google-sheet-append／google-slides-* 因為「dry-run 的處理方式跟 write-file
 * 不一樣」而被分類成沒有副作用，結果使用者說「只讀取資料、不要修改」時，需求驗收完全放行了會寫進
 * 別人 Google 試算表／簡報的節點。**不准再為了配合某個消費端的實作策略而謊報能力。**
 *
 * 刻意是 leaf module：不 import registry(registry → nodes/* → dryRun → 這裡，反向 import 會變成
 * 初始化循環，這個 repo 已經踩過一次 TDZ)。registry 與這份清單的一致性由測試保證，不是由 import 保證。
 * 但**循環風險不能拿來當作少分類副作用的理由**——分類照實寫，消費端各自挑自己該管的。
 */

export type SideEffectTag =
  /** 寄出 Email(離開這台電腦，收件人可能是任何人) */
  | "email"
  /** 推播/通知(Telegram、LINE、Slack、桌面) */
  | "notify"
  /** 產生使用者要的新檔案(交付產出) */
  | "file-write"
  /** 覆寫／改動既有的使用者檔案 */
  | "file-modify"
  /** 改動外部服務裡的資料(Google 試算表、Google 簡報…) */
  | "remote-write"
  /** 只寫進本次執行的工作區(下載的附件、解壓出來的檔案、瀏覽器登入狀態)。
   * 這是「把輸入抓進來」的必要動作，不是使用者資料的變更，**不列入任何禁止寫入的規則**——
   * 否則「只讀取信件附件來分析」這種完全合理的需求會被自己的安全規則擋死。 */
  | "workspace-file"
  /** 對真人送出簽核請求(會發通知)。獨立成一類而不併進 notify：它只會在使用者明確要求簽核時存在，
   * 由 `approval` 那一項需求把關；併進 notify 會讓「要簽核但沒說要通知」的正常流程被誤判成未授權外送。 */
  | "approval-request"
  /** 去執行另一條流程，實際副作用取決於被呼叫的那條流程(靜態看不出來)。 */
  | "delegated";

/** 只讀安全試跑要怎麼處理這個型別。 */
export type DryRunHandling =
  /** 引擎/容器整步略過，完全不執行(通知、寄信、寫檔、寫 Google 試算表) */
  | "skip"
  /** 節點自己在真的動手之前 return——讀取／驗證的部分照跑，保留輸出給下游(Google 簡報、Excel 產檔、簽核) */
  | "self-guard"
  /** 沒有需要攔的副作用，照常執行 */
  | "none"
  /** 副作用由設定或程式碼決定，dryRunSkipKind 另有專屬判斷(http-request 的方法、custom-code 的內容) */
  | "by-config";

export interface NodeSideEffectSpec {
  effects: readonly SideEffectTag[];
  dryRun: DryRunHandling;
}

/**
 * 每個節點型別的副作用與只讀處理方式。**必須涵蓋 registry 的所有型別**，純讀取／純運算寫 `[]`；
 * `sideEffects.test.ts` 會機械比對，新增節點沒分類就直接失敗，作者被迫做一次明確的決定。
 *
 * 每一條都對照過該節點 `execute()` 的實際行為，不是照型別名稱猜的。
 */
export const NODE_SIDE_EFFECTS: Readonly<Record<string, NodeSideEffectSpec>> = {
  // ── 外送訊息：引擎整步略過 ──
  "send-email": { effects: ["email"], dryRun: "skip" },
  // 自己守門而不是整步略過：安全排練時要把「已經換好值的完整內文」印出來給使用者確認，
  // 引擎整步跳過的話他就看不到寄出去會長什麼樣(見 webmailSend 的 describeOutgoingMail)。
  "webmail-send": { effects: ["email"], dryRun: "self-guard" },
  "telegram-notify": { effects: ["notify"], dryRun: "skip" },
  "line-notify": { effects: ["notify"], dryRun: "skip" },
  "slack-notify": { effects: ["notify"], dryRun: "skip" },
  "desktop-notify": { effects: ["notify"], dryRun: "skip" },

  // ── 本機交付檔 ──
  "write-file": { effects: ["file-write"], dryRun: "skip" },
  // excel-process 讀來源檔、篩選後**產生一份新檔**(還會複製到桌面)，不會改到來源檔 → file-write。
  // dry-run 由節點自己在寫檔前 return(讀取/篩選照跑，下游才拿得到筆數等驗證結果)，不能整步略過。
  "excel-process": { effects: ["file-write"], dryRun: "self-guard" },

  // ── 改動外部服務的資料 ──
  "google-sheet-append": { effects: ["remote-write"], dryRun: "skip" },
  "google-sheet-update": { effects: ["remote-write"], dryRun: "skip" },
  // Google 簡報這兩個節點確實會在使用者的 Google 帳號裡建立/更新簡報，只是 dry-run 的處理方式是
  // 節點自己在 batchUpdate 前 return(保留「讀得到簡報、找得到目標圖表」的驗證輸出)。
  // 處理方式不同 ≠ 沒有副作用——這正是這次 P0 的成因。
  "google-slides-create": { effects: ["remote-write"], dryRun: "self-guard" },
  "google-slides-refresh": { effects: ["remote-write"], dryRun: "self-guard" },
  // 真的會改到使用者拿去開會的簡報，跟寫進別人的試算表同一級。
  "google-slides-replace-image": { effects: ["remote-write"], dryRun: "self-guard" },

  // ── 只寫本次執行的工作區(把輸入抓進來)，不是使用者資料的變更 ──
  "download-attachment": { effects: ["workspace-file"], dryRun: "none" },
  // 只把圖片寫進本次執行的工作區(debugDir)，不碰使用者的檔案，也不送出去——
  // 所以只讀試跑照跑：讓使用者在安全排練時就看得到「圖會長什麼樣」。
  "excel-range-image": { effects: ["workspace-file"], dryRun: "none" },
  unzip: { effects: ["workspace-file"], dryRun: "none" },
  "browser-login": { effects: ["workspace-file"], dryRun: "none" },

  // ── 副作用由設定/程式碼決定(見 configuredSideEffects) ──
  "http-request": { effects: [], dryRun: "by-config" },
  "custom-code": { effects: [], dryRun: "by-config" },

  // ── 其他 ──
  "wait-approval": { effects: ["approval-request"], dryRun: "self-guard" },
  "run-workflow": { effects: ["delegated"], dryRun: "none" },
  "email-read": { effects: [], dryRun: "none" },
  "find-email": { effects: [], dryRun: "none" },
  "google-sheet-read": { effects: [], dryRun: "none" },
  "if-condition": { effects: [], dryRun: "none" },
  "llm-decide": { effects: [], dryRun: "none" },
  "pdf-read": { effects: [], dryRun: "none" },
  "read-file": { effects: [], dryRun: "none" },
  "read-image": { effects: [], dryRun: "none" },
  "repeat-steps": { effects: [], dryRun: "none" }, // 容器本身沒有副作用，內嵌步驟各自算(見 repeatNesting)
  "rss-read": { effects: [], dryRun: "none" },
  "set-variable": { effects: [], dryRun: "none" },
  // 資料處理節點組:純記憶體內轉換,不碰外部世界
  "filter-rows": { effects: [], dryRun: "none" },
  "sort-rows": { effects: [], dryRun: "none" },
  "aggregate-rows": { effects: [], dryRun: "none" },
  "dedup-rows": { effects: [], dryRun: "none" },
  switch: { effects: [], dryRun: "none" },
  "template-text": { effects: [], dryRun: "none" },
  trigger: { effects: [], dryRun: "none" },
  wait: { effects: [], dryRun: "none" },
  "web-page": { effects: [], dryRun: "none" },
};

/** 取出帶有其中任一分類的節點型別集合(只看型別固定的副作用，設定決定的請用 configuredSideEffects)。 */
export function nodeTypesWithSideEffect(...tags: SideEffectTag[]): Set<string> {
  const wanted = new Set(tags);
  const out = new Set<string>();
  for (const [type, spec] of Object.entries(NODE_SIDE_EFFECTS)) {
    if (spec.effects.some((effect) => wanted.has(effect))) out.add(type);
  }
  return out;
}

/** 只讀試跑時「引擎整步略過」的型別。self-guard 的節點刻意不在裡面：它們自己會在動手前 return，
 * 整步略過反而會讓讀取/驗證的輸出消失、下游拿不到資料而假成功(既有行為，不得放寬也不得收緊)。 */
export function dryRunSkipTypes(): Set<string> {
  const out = new Set<string>();
  for (const [type, spec] of Object.entries(NODE_SIDE_EFFECTS)) if (spec.dryRun === "skip") out.add(type);
  return out;
}

/**
 * http-request 的「我只是查詢，不會改動對方資料」明確宣告欄位。
 *
 * 為什麼需要它：平台自己的建圖配方就教 AI 用 `POST .../databases/{id}/query` 讀 Notion 資料庫——
 * 讀取用的 POST 是真實存在的。但**不能靠猜**：`/v1/pages`(建立頁面)與 `/v1/databases/{id}/query`
 * (查詢)只差在路徑，用網址 regex 猜一次猜錯就是真的送出資料。也不能靠 AI 在 intent 裡自稱唯讀——
 * 那是自由文字，沒有任何可驗證性。所以做成一個**明確、看得見、預設關閉**的布林設定：它會出現在
 * 節點面板上、會存進流程 JSON、匯出匯入都看得到，人可以逐一檢查。沒有宣告 = 一律當成會寫入。
 */
export const HTTP_READ_ONLY_CONFIG_KEY = "readOnly";

/**
 * 節點 config 上的 `readOnly` 只是「**AI 的建議**」，不是安全批准。
 *
 * 真實踩過的 P0：一開始把它直接當成放行條件，但 config 是 AI 建圖、AI 修復、匯入、節點編輯都能
 * 改寫的欄位——AI 只要誤判或幻覺，就能把一個真的會建立/更新資料的 POST 標成唯讀並同時通過需求
 * 驗收與只讀試跑。等於 AI 自己批准自己。真正的放行條件是**使用者**在畫面上對「這一份精確請求」
 * 按下確認(存在 DB、綁 method/url/headers/body 指紋，見 httpReadOnlyApproval.ts)。
 */
export function suggestsReadOnly(config: Record<string, unknown>): boolean {
  const raw = config[HTTP_READ_ONLY_CONFIG_KEY];
  return raw === true || raw === "true";
}

/**
 * 這段程式碼/意圖有沒有「會寫出去」的訊號——dryRun 與 requirementCheck **共用同一份判定**，
 * 不再各寫一份 regex(以前 dryRun 有一整組、requirementCheck 完全沒有，所以只讀需求下 custom-code
 * 想寫什麼就寫什麼)。已有可執行 code 時只看 code；還是空殼時才退回看白話 intent。
 */
// 已有 code 時只能用可執行的 side-effect 訊號判斷。把「填入」「寫回」這種中文放進來會誤傷
// 讀取程式裡的防呆錯誤(例如「避免把 0 填入」)，安全試跑反而從未執行真正要驗的計算。
const CUSTOM_CODE_WRITER_RE = /values\s*(?:\.|\[['"])(?:update|append)|batchUpdate|spreadsheets\s*\.\s*values|setValue|getCell\s*\([^)]*\)\s*\.\s*value\s*=|\.(?:addRow|spliceRows|insertRow|deleteRow)\s*\(|xlsx\s*\.\s*writeFile|(?:\.|\[['"])(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|truncateSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|chmod|chmodSync|chown|chownSync)['"]?\s*(?:\]|\()|fs\s*\.\s*(?:promises\s*\.\s*)?(?:write|append|rm|unlink|rename|copyFile|mkdir|createWriteStream)|method\s*:\s*(?:['"]?(?:POST|PUT|PATCH|DELETE)|[^,}\n]*(?:POST|PUT|PATCH|DELETE))|axios\s*(?:\.|\[['"])(?:post|put|patch|delete)|(?:got|request)\s*(?:\.|\[['"])(?:post|put|patch|delete)|sendMail|sendMessage|child_process|\b(?:exec|execFile|spawn|fork)\s*\(|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+TABLE)\b/i;
const CUSTOM_INTENT_WRITER_RE = /寫入|填入|回填|寫回|更新到|上傳到|送出到|刪除檔案|移動檔案|建立資料夾/i;

// 規則必須與 codegen.isPlaceholderCode 一致(避免從 codegen 匯入而把 registry → customCode →
// dryRun → codegen 拉成初始化循環)。
export function isPlaceholderCodeText(code: string): boolean {
  const value = code.trim();
  return !value || /^return\s*\{\s*\.\.\.\s*ctx\.input\s*,?\s*\}\s*;?$/.test(value);
}

export interface ConfiguredEffects {
  effects: SideEffectTag[];
  /** true = 靜態判斷不出這個節點到底會不會寫。「只讀／不要修改」需求下必須 fail closed。 */
  undetermined: boolean;
  /** true = AI 建議這是唯讀查詢，但還缺使用者確認。這是「等使用者按確認」，不是「圖不安全」——
   * 呼叫端要分開處理，不能叫 AI 把使用者真正需要的查詢步驟刪掉來消除警告。 */
  awaitingUserConfirmation?: boolean;
}

export interface ConfiguredEffectsOptions {
  /** 這個節點的「這一份精確請求」有沒有被**使用者**確認為唯讀(見 httpReadOnlyApproval.ts)。
   * 純函式碰不到 DB，一律由呼叫端查好傳進來；沒傳 = 未確認 = fail closed。 */
  readOnlyApproved?: boolean;
}

/**
 * 依「設定／程式碼」判斷這個節點這次會不會造成資料變更。型別固定的副作用請用 NODE_SIDE_EFFECTS。
 */
export function configuredSideEffects(
  type: string,
  config: Record<string, unknown>,
  opts: ConfiguredEffectsOptions = {},
): ConfiguredEffects {
  if (type === "http-request") {
    const method = String(config.method ?? "GET").trim().toUpperCase();
    if (method === "GET" || method === "HEAD") return { effects: [], undetermined: false };
    // 預設不信任 POST/PUT/PATCH/DELETE。放行的唯一條件是**使用者確認過**這一份請求；
    // 節點上的 readOnly 只是 AI 的建議，自己不構成放行(見 suggestsReadOnly 的說明)。
    if (opts.readOnlyApproved) return { effects: [], undetermined: false };
    return { effects: ["remote-write"], undetermined: false, awaitingUserConfirmation: suggestsReadOnly(config) };
  }
  if (type === "custom-code") {
    const code = String(config.code ?? "");
    const intent = String(config.intent ?? "").trim();
    if (!isPlaceholderCodeText(code)) {
      return { effects: CUSTOM_CODE_WRITER_RE.test(code) ? ["file-write", "remote-write"] : [], undetermined: false };
    }
    // 還是空殼：只能看白話 intent。連 intent 都沒有 = 完全判斷不出來(執行時才會產碼)，
    // 只讀需求下不能假設它安全。
    if (!intent) return { effects: [], undetermined: true };
    return { effects: CUSTOM_INTENT_WRITER_RE.test(intent) ? ["file-write", "remote-write"] : [], undetermined: false };
  }
  return { effects: [], undetermined: false };
}
