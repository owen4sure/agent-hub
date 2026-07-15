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
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
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

function protectLiteralPieces(value: string, open = "\uE000", close = "\uE001"): { text: string; restore: (text: string) => string } {
  const pieces: string[] = [];
  const stash = (piece: string) => {
    const index = pieces.push(piece) - 1;
    return `${open}${index}${close}`;
  };
  const text = value
    .replace(/https?:\/\/[^\s，。、）)】」』]+/gi, stash)
    .replace(/[^\s，。；：:()（）「」『』]+?\.(?:xlsx|xlsm|xls|docx|doc|pdf|pptx|csv|tsv|zip|rtf|eml|txt|json|ya?ml|sql|jsx?|tsx?)\b/gi, stash);
  return {
    text,
    restore: (result: string) => result.replace(new RegExp(`${open}(\\d+)${close}`, "g"), (_match, index: string) => pieces[Number(index)] ?? ""),
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
  if (/^[A-Za-z_$][\w$.-]*$/.test(token)) return "前面步驟提供的資料";
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
  const h = makeHumanizer(paramLabels);
  const protectedValue = protectLiteralPieces(String(value ?? ""));
  const result = hideTechnicalContracts(h(protectedValue.text), paramLabels)
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
  return protectedValue.restore(result);
}

/** 對話顯示層也處理舊版已存下來的 key=value 結果，讓升級後不用清除舊對話才看得到白話。 */
export function plainChatMessage(value: string): string {
  // 使用不同標記，避免內層 plainLanguage 的還原器把外層暫存片段誤當成自己的索引而刪掉。
  const protectedValue = protectLiteralPieces(String(value ?? ""), "\uE100", "\uE101");
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
