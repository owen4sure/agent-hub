// 這支檔案刻意只放純字串轉換，不得 import registry/節點執行器等伺服器模組。
// NodePanel 是 Client Component；若從 explain.ts 匯入，會把 Playwright、fs、DB 等整條伺服器依賴拉進瀏覽器 bundle。

const TOKEN_GLOSS: Record<string, string> = {
  "period.start": "這個期間的第一天", "period.end": "這個期間的最後一天",
  "period.reportDate": "報表信件的日期", "period.label": "這個期間的名稱",
  reportDate: "報表信件的日期", targetDate: "目標日期",
  yesterday: "昨天", today: "今天",
  "last-quarter-start": "上一季第一天", "last-quarter-end": "上一季最後一天",
  webmailUrl: "webmail 網址", attachmentPath: "剛下載的附件",
  filePath: "收到的檔案", fileName: "收到的檔名",
  subject: "信件主旨", body: "信件內容", message: "收到的訊息",
  periodStart: "區間開始日期", anchorDate: "區間結束日期", periodEnd: "區間結束日期",
  periodLabel: "原始日期區間", kpiSheetUrl: "週報試算表網址",
  kpiSheetScriptUrl: "週報試算表寫入網址",
  // 這些不是內部欄位名，是真實世界的專有名詞，剛好長得像 camelCase(大小寫混合)會被下面的抓漏
  // 規則誤認成程式變數——原樣傳回去，不能套「前面步驟提供的「X」資料」這種框架，那個說法是用來
  // 描述「上一步算出來的欄位」，不是「使用者要去 Telegram 找的官方帳號名字」。實測踩過：AI 教使用者
  // 「用 Telegram 搜尋 @BotFather 建立機器人」被改寫成「@前面步驟提供的「BotFather」資料」，
  // 使用者對著這句話完全不知道要去哪裡找、也不知道這是不是系統壞了。
  BotFather: "BotFather",
  // 作業系統/產品名也是同一類「長得像 camelCase 的專有名詞」——真實踩過：建圖訊息說
  // 「watchPath 預設為 macOS 桌面路徑」被改寫成「前面步驟提供的「macOS」資料 桌面路徑」。
  macOS: "macOS", iOS: "iOS", iPadOS: "iPadOS", watchOS: "watchOS", iCloud: "iCloud", iPhone: "iPhone", iPad: "iPad",
  GitHub: "GitHub", YouTube: "YouTube", PayPal: "PayPal", LinkedIn: "LinkedIn", WhatsApp: "WhatsApp", OneDrive: "OneDrive", SharePoint: "SharePoint", PowerPoint: "PowerPoint", OpenAI: "OpenAI",
};

const PREVIEW_FIELD_GLOSS: Record<string, string> = {
  loggedIn: "登入成功",
  found: "找到信件數",
  subject: "信件主旨",
  date: "信件日期",
  filename: "附件名稱",
  rowCount: "讀到資料列數",
  periodLabel: "週期欄",
  periodStart: "週期起日",
  periodEnd: "週期迄日",
  anchorDate: "週期迄日",
  reportDate: "主管報告資料日",
  total: "合計",
  count: "筆數",
  result: "結果",
  message: "訊息內容",
  content: "寫入內容",
  text: "文字內容",
  body: "送出內容",
  rows: "資料列",
  cells: "儲存格內容",
  values: "寫入資料",
  sheetName: "分頁名稱",
  targetColumn: "要填的欄位",
  title: "標題",
};

/** 執行紀錄卡只顯示可行動的錯誤，不把 Playwright 的 ANSI 控制碼與數十行重試 call log 倒給使用者。 */
export function conciseRuntimeError(value: string): string {
  const clean = String(value ?? "")
    .replace(/\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
  if (/page\.fill: Timeout \d+ms exceeded/i.test(clean) && /element is not enabled/i.test(clean)) {
    const errorStart = clean.search(/page\.fill: Timeout \d+ms exceeded/i);
    const resolutionStart = clean.lastIndexOf("｜");
    const prefix = errorStart >= 0 ? clean.slice(0, errorStart) : "";
    const suffix = resolutionStart > errorStart ? clean.slice(resolutionStart) : "";
    return (prefix + "帳號欄位已由網站預填並鎖定，舊版仍重複輸入而逾時。" + suffix).trim();
  }
  if (clean.includes("\nCall log:")) {
    const [summary] = clean.split("\nCall log:");
    return summary.trim() + "（技術重試細節可在逐步紀錄查看）";
  }
  return clean;
}

function protectLiteralPieces(value: string, open = "", close = ""): { text: string; restore: (text: string) => string } {
  const pieces: string[] = [];
  const stash = (piece: string) => {
    const index = pieces.push(piece) - 1;
    return `${open}${index}${close}`;
  };
  const text = value
    .replace(/https?:\/\/[^\s，。、）)】」』]+/gi, stash)
    .replace(/[^\s，。；：:()（）「」『』]+?\.(?:xlsx|xlsm|xls|docx|doc|pdf|pptx|csv|tsv|zip|rtf|eml|txt|json|ya?ml|sql|jsx?|tsx?)\b/gi, stash)
    // 「」『』框住的內容一律當成「照抄的第三方 UI 字面文字」保護起來，不能被下面的白話替換規則
    // 誤傷——真實踩過：教使用者去 Google Cloud Console 點「API 和服務→已啟用的 API」這種必須逐字
    // 對照才找得到的選單路徑，被 .replace(/\bAPI\b/g, "外部服務") 改成「外部服務 和服務→已啟用的
    // 外部服務」，使用者對著這句話在 Google 的畫面上永遠找不到對應選項。引號在這個檔案本來就是
    // 「這是精確字面值」的既有慣例(節點名稱、分頁名稱都這樣引用)，保護它不影響原本的白話簡化用途。
    .replace(/「[^」]*」|『[^』]*』/g, stash)
    // 單一反引號(如 AI 很自然會寫的 `telegramBotToken`)是 markdown 慣例的「這是技術字面值」寫法，
    // 跟「」『』同一個意思，卻完全不在上面那條保護規則涵蓋範圍內——真實踩過：AI 教使用者去設定頁
    // 新增帳密欄位 `telegramBotToken`，反引號內容沒被保護，先被 hideTechnicalContracts 的 camelCase
    // 抓漏規則壓成「前面步驟提供的「telegramBotToken」資料」，此檔案原本在最後才做的反引號→「」
    // 轉換規則再把這段已經壓壞的文字整段包多一層引號，變成使用者完全看不懂要新增哪個欄位的雙層
    // 包裹句子。直接在這裡把反引號內容轉成「」形式一併保護，跟上面那條規則同一個道理；
    // 不比對三個以上連續反引號(``` 開頭的程式碼區塊)，那個由 plainLanguage 最後另一條規則整段隱藏。
    .replace(/(?<!`)`(?!``)([^`\n]+)`(?!`)/g, (_match, inner: string) => stash(`「${inner}」`));
  return {
    text,
    // 還原必須跑到「不動點」，不能只掃一趟：規則之間會巢狀保護——檔名先被規則2收成 piece[0]
    // (原文位置變成佔位符)，包住它的「」引號再被規則3把「整段含佔位符的內容」收成 piece[1]。
    // 單趟 replace 還原出 piece[1] 後，剛還原回來的內容不會被同一趟重掃，內層佔位符就字面留在
    // 輸出裡——佔位符的頭尾是看不見的私有區字元，使用者看到的就只剩中間的索引數字(真實踩過：
    // 建圖總結把桌面輸出檔名「XXX.xlsx」顯示成「0」，新手第一眼就看到一個講不通的檔名)。
    // 迴圈上限防禦性地擋「piece 內容剛好長得像佔位符」造成的無窮迴圈，正常巢狀 2~3 層就收斂。
    restore: (result: string) => {
      let out = result;
      for (let pass = 0; pass < 10; pass++) {
        const next = out.replace(new RegExp(`${open}(\\d+)${close}`, "g"), (_match, index: string) => pieces[Number(index)] ?? "");
        if (next === out) break;
        out = next;
      }
      return out;
    },
  };
}

function humanizePreviewField(key: string): string {
  let label = PREVIEW_FIELD_GLOSS[key];
  if (!label) {
    if (/[㐀-鿿]/.test(key)) label = key;
    else if (/count|length|size/i.test(key)) label = "筆數";
    else if (/date|time/i.test(key)) label = "日期／時間";
    else if (/name|title/i.test(key)) label = "名稱";
    else if (/total|sum|amount/i.test(key)) label = "合計";
    else if (/^[A-Z0-9_-]{2,}$/.test(key)) label = key; // MTD/YTD/KPI 這類業務縮寫不是程式欄位
    else label = "計算結果";
  }
  return label;
}

function humanizePreviewValue(value: unknown, depth = 0): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null || value === undefined) return "（空）";
  if (Array.isArray(value)) {
    const shown = value.slice(0, 20).map((item) => humanizePreviewValue(item, depth + 1));
    return shown.join("、") + (value.length > shown.length ? `…（另有 ${value.length - shown.length} 項）` : "");
  }
  if (typeof value === "object") {
    if (depth >= 2) return "一組整理好的資料";
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
    return entries.map(([key, item]) => `${humanizePreviewField(key)}：${humanizePreviewValue(item, depth + 1)}`).join("；");
  }
  return String(value);
}

/** 安全試跑結果的欄位名稱與值一律翻成人話，不能把 loggedIn/rowCount 這類內部契約露給使用者。 */
export function humanizePreviewPair(key: string, value: unknown): string {
  return `${humanizePreviewField(key)}＝${humanizePreviewValue(value)}`;
}

/**
 * 真實踩過的 bug：節點設定表單的欄位標籤(configSchema 的 label)常帶完整說明的括號子句
 * (例如「Apps Script 寫入網址（必須以 /exec 結尾；不是 Google 試算表網址）」)——這在表單裡
 * 是有用的提示，但被直接拿去組「已實際套用到節點」這種一次改好幾個節點的對話摘要時，同一句
 * 落落長的括號說明會逐節點重複出現 5 次，把原本該是清單一眼看完的摘要，撐成使用者得從頭讀到尾
 * 才找得到重點的一大段文字。摘要只需要「這是哪個欄位」，說明留在展開設定卡時才看，這裡把
 * 標籤裡的括號子句(全形或半形都算)去掉，只留欄位本身的名稱。
 */
export function shortFieldLabel(label: string): string {
  return label.replace(/[（(][^）)]*[）)]\s*$/, "").trim() || label;
}

const PRIVATE_RUN_OUTPUT_KEY = /(?:secret|token|password|cookie|session|authorization|api[_-]?key|file(?:path|text|content)?|attachment|html|screenshot|stack|trace|code)/i;
const USEFUL_RUN_OUTPUT_KEY = /(?:result|summary|total|sum|amount|count|answer|message|text|value|report|output|結果|合計|總計|筆數|金額|摘要|答案)/i;

/**
 * 執行完成後，對話應直接說出「算到了什麼」，而不是要小白再去翻執行紀錄。
 * 這是瀏覽器端可用的純函式：只讀已經由 API 回傳、且不含帳密的 output_json，仍會再排除
 * 檔案全文、路徑、Cookie、HTML 和程式碼等不適合放進對話的內容。
 */
export function formatSafeRunOutput(raw: string | null | undefined): string[] {
  if (!raw || raw.length > 2_000_000) return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => !PRIVATE_RUN_OUTPUT_KEY.test(key) && item !== undefined && item !== null && item !== "")
    .filter(([, item]) => {
      const text = typeof item === "string" ? item : "";
      return text.length <= 800 && !/<(?:html|body|script|div)\b/i.test(text);
    })
    .sort(([a], [b]) => Number(USEFUL_RUN_OUTPUT_KEY.test(b)) - Number(USEFUL_RUN_OUTPUT_KEY.test(a)))
    .slice(0, 6)
    .map(([key, item]) => humanizePreviewPair(key, item));
  return entries;
}

/** 寫入預覽保留要核對的實際值，但不把 JSON 與程式內部欄位名丟給使用者。 */
export function formatPlannedWriteLines(items: { nodeLabel: string; destination: string; payload: unknown }[]): string[] {
  return items.map((item) => {
    let payload: string;
    if (item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)) {
      payload = Object.entries(item.payload as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, value]) => `  - ${humanizePreviewPair(key, value)}`)
        .join("\n");
    } else if (Array.isArray(item.payload)) {
      payload = `  - ${humanizePreviewPair("values", item.payload)}`;
    } else {
      const raw = String(item.payload ?? "（空）");
      payload = raw.split(/\r?\n/).map((line) => {
        const pair = line.match(/^\s*([^=＝]+?)\s*[=＝]\s*(.*?)\s*$/);
        if (!pair) return plainLanguage(line);
        const value = /^(true|false)$/i.test(pair[2]) ? pair[2].toLowerCase() === "true"
          : /^-?\d+(?:\.\d+)?$/.test(pair[2]) ? Number(pair[2]) : pair[2];
        return `  - ${humanizePreviewPair(pair[1].trim(), value)}`;
      }).join("\n");
    }
    return `• ${plainLanguage(item.nodeLabel)} → ${plainLanguage(item.destination)}\n${payload.slice(0, 1200)}`;
  });
}

function glossToken(token: string, paramLabels: Record<string, string>): string {
  const known = paramLabels[token] ?? TOKEN_GLOSS[token];
  if (known) return known;
  // 真實踩過的 bug：不認得的欄位名一律丟成同一句「前面步驟提供的資料」，同一則訊息裡若同時出現
  // 好幾個不同的不認得欄位(例如自我檢查訊息列出的「上游會輸出的欄位：userId、replyToken、message」)，
  // 全部塌成一模一樣的句子，使用者完全分不出是哪一個欄位——這種訊息的價值就是要讓人分得清楚是誰。
  // 同樣的情況也發生在 AI 自己講解「去設定頁新增一個帳密欄位」時：那個欄位的真實名稱使用者一定要
  // 知道才填得對，含糊帶過等於沒講。一律保留原始 token 名稱、只是用引號框起來(這個檔案本來就把
  // 引號當「這是精確字面值」)，寧可讓使用者看到一個英文詞，也不要讓兩個不同的東西看起來一樣。
  return `前面步驟提供的「${token}」資料`;
}

function makeHumanizer(paramLabels: Record<string, string>) {
  return (value: string): string =>
    value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, tok: string) => glossToken(tok, paramLabels));
}

/** 只把 {{資料欄位}} 換成白話，供完整 workflow 說明的各節點格式化共用。 */
export function humanizeTemplates(paramLabels: Record<string, string>): (value: string) => string {
  return makeHumanizer(paramLabels);
}

function hideTechnicalContracts(value: string, paramLabels: Record<string, string>): string {
  let out = value;
  out = out.replace(/(?:輸出|產出)\s+((?:[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*[,，、]?\s*){1,12})(?=給|供|，|。|$)/g, (_m, group: string) => {
    const labels = [...group.matchAll(/[A-Za-z_$][\w$]*/g)]
      .map((m) => glossToken(m[0], paramLabels))
      .filter((v, i, all) => all.indexOf(v) === i);
    return labels.length ? `整理出${labels.join("、")}` : "整理出後續需要的資料";
  });
  return out
    .replace(/(?:回傳|return)\s*\{[^{}\n]{0,500}\}/gi, "把整理好的結果交給下一步")
    .replace(/\b(?:ctx\.(?:input|config|secrets)|JSON\.stringify|JSON\.parse)\b/gi, "背後資料")
    .replace(/\b(?:exceljs|playwright|adm-zip|pdf-parse|xlsx)\b/gi, "內建工具")
    .replace(/\b(?:const|let|var|await|async|return|import|require)\b/gi, "")
    .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:_[A-Za-z0-9_$]+|[a-z0-9][A-Z][A-Za-z0-9_$]*)+\b/g, (id) => glossToken(id, paramLabels))
    .replace(/\{[^{}\n]{0,500}\}/g, "整理好的資料")
    .replace(/\s{2,}/g, " ");
}

/** 說明面板的最後一道白話過濾：模型寫的說明不能漏出程式碼或協定術語。 */
export function plainLanguage(value: string, paramLabels: Record<string, string> = {}): string {
  // 真實踩過的 bug(從真實使用者對話紀錄挖出來)：AI 說明改了哪個節點時，習慣在中文標籤後面
  // 用括號附上節點自己的內部 id 當對照，例如「計算週增量、月累計與年累計」(extractNumbers)。
  // 這個 id 不是「上游步驟傳來的資料欄位」，是這一步自己的名字，但下面 hideTechnicalContracts
  // 的 camelCase 抓漏規則不分青紅皂白，把它當成未知資料欄位套上「前面步驟提供的「X」資料」的
  // 框架，變成使用者看不懂的「「計算週增量、月累計與年累計」(前面步驟提供的「extractNumbers」
  // 資料)」。使用者根本不需要看到內部 id——中文標籤本身就已經講清楚是哪一步，這種緊接在引號
  // 標籤後面、括號裡只有純英數識別字的內容，整段拿掉即可，不必費工把它「翻譯」成什麼。
  const withoutNodeIdRefs = String(value ?? "").replace(/([」』])[（(][A-Za-z_$][A-Za-z0-9_$]*[）)]/g, "$1");
  const h = makeHumanizer(paramLabels);
  const protectedValue = protectLiteralPieces(withoutNodeIdRefs);
  const humanized = h(protectedValue.text);
  // glossToken 現在的 fallback 會自己產生「」引號包住的欄位名(如「lineChannelToken」)——這是
  // humanizer 這一步「剛產生」的引號，不是原始輸入裡就有的，上面 protectedValue 那次保護在這之前
  // 就已經掃過一輪，抓不到這些新引號。沒有這層保護的話，下面 hideTechnicalContracts 的 camelCase
  // 抓漏規則會把這些剛加上引號的欄位名當成新的識別字再處理一次，變成雙重包裹的「前面步驟提供的
  // 「前面步驟提供的「lineChannelToken」資料」資料」(實測在 LINE 觸發流程的自我檢查訊息裡踩到)。
  // 標記要跟外層 protectedValue、以及 plainChatMessage 自己那層都不同，不然還原器的索引會互撞
  // (跟 plainChatMessage 已經注解過的道理一樣——巢狀保護一定要用不同標記字元)；且要撐到整條
  // .replace() 鏈的最後才還原(跟外層 protectedValue 同一種活法)，不能提早還原，不然後面其他規則
  // 一樣有機會誤傷剛產生的引號內容。
  const reprotected = protectLiteralPieces(humanized, "", "");
  const result = hideTechnicalContracts(reprotected.text, paramLabels)
    .replace(/```[\s\S]*?```/g, "(背後的技術細節已隱藏)")
    .replace(/`([^`]+)`/g, "「$1」")
    .replace(/\bWebhook\b/gi, "專屬接收網址")
    .replace(/\bAPI\b/g, "外部服務")
    .replace(/\bIMAP\b/g, "收信串接")
    .replace(/\bSMTP\b/g, "寄信串接")
    .replace(/\bChat ID\b/gi, "允許的 Telegram 帳號")
    .replace(/\bbot\b/gi, "機器人")
    .replace(/\bJSON\b/gi, "結構化資料")
    .replace(/\bGET\b/g, "讀取")
    .replace(/\bPOST\b/g, "送出")
    .replace(/\bcron\b/gi, "排程時間")
    .replace(/\bselector\b/gi, "網頁位置")
    .replace(/公司\s*webmail/gi, "公司信箱")
    .replace(/\bworkflow\b/gi, "流程")
    .replace(/\bnodes?\b/gi, "步驟")
    .replace(/\bwebmail\b/gi, "公司信箱")
    .replace(/節點/g, "步驟")
    .replace(/\bhighlight\b/gi, "標色")
    .replace(/#?FFC000\b/gi, "橘黃色")
    .replace(/#[0-9a-f]{6}\b/gi, "指定顏色")
    .replace(/範例\s+流程/g, "範例流程")
    .replace(/公司\s+公司信箱/g, "公司信箱")
    .replace(/公司信箱\s+網址/g, "公司信箱網址")
    .replace(/[{}]{2,}/g, "")
    .trim();
  return protectedValue.restore(reprotected.restore(result));
}

/** 對話顯示層也處理舊版已存下來的 key=value 結果，讓升級後不用清除舊對話才看得到白話。 */
export function plainChatMessage(value: string): string {
  // 使用不同標記，避免內層 plainLanguage 的還原器把外層暫存片段誤當成自己的索引而刪掉。
  const protectedValue = protectLiteralPieces(String(value ?? ""), "", "");
  const humanizedPairs = protectedValue.text.replace(
    /([A-Za-z_$㐀-鿿][A-Za-z0-9_$㐀-鿿]*)\s*[=＝]\s*([^；，\n•]+)/g,
    (_match, key: string, raw: string) => {
      const text = raw.trim();
      const parsed: unknown = /^(true|false)$/i.test(text) ? text.toLowerCase() === "true"
        : /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text)
          : text;
      return humanizePreviewPair(key, parsed);
    },
  );
  return protectedValue.restore(plainLanguage(humanizedPairs));
}
