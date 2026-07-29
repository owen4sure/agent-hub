/**
 * 「這個欄位可以放什麼？」——把 `{{欄位}}` 這件事變成小白看得懂、點得動的東西。
 *
 * 問題(使用者原話)：「使用者看不懂 {{periodLabel}} 這種東西是什麼」。
 * 他說得對——那是給程式看的名字。一個非工程師打開節點面板，看到一個空的內容欄，
 * 他不知道①可以帶前面步驟算出來的資料 ②有哪些可以帶 ③要打什麼 ④打完會變成什麼。
 *
 * 所以這一層對每個可插入的欄位回答三件事，全部用他看得懂的話：
 *   ①**這是什麼**(白話名稱)　②**會變成什麼**(上次執行時的真實值)　③**誰算出來的**(哪一步)
 * 前端據此長出「點一下就插入」的方塊——他從頭到尾不用打出大括號，也不用知道那串是什麼。
 *
 * 另外提供「打錯了怎麼辦」：使用者自己打了一個不存在的欄位時，找出最接近的那一個，
 * 讓畫面可以說「你是不是要用○○？」並一鍵換掉，而不是等到執行時才炸。
 */

/** 只取用得到的形狀；這是葉模組，不從呼叫端匯入型別。 */
interface DataFlowLike {
  nodes: { id: string; label: string; outputs: { name: string; status: string }[] }[];
}

export interface InsertableField {
  /** 真正要插進去的東西，例如 periodLabel(前端會包成 {{periodLabel}}) */
  key: string;
  /** 白話名稱。有中文說明就用中文，沒有就退回原欄位名 */
  label: string;
  /** 上次執行時這個欄位的真實值(截短)。沒跑過就是 undefined */
  sample?: string;
  /** 這個值是哪一步算出來的 */
  from: string;
}

/**
 * 常見欄位的白話名稱。刻意只列「平台自己會產生」的那些——使用者的 custom-code 自訂欄位
 * 沒辦法在這裡窮舉，那些會退回顯示原名，但仍然帶著「上次的真實值」與「哪一步算的」，
 * 光憑那兩項通常就足以判斷是不是自己要的東西。
 */
const FRIENDLY: Record<string, string> = {
  filePath: "這次選的檔案",
  fileName: "這次選的檔名",
  savedPath: "上一步存好的檔案",
  attachmentPath: "下載下來的附件",
  outputPath: "產出的檔案",
  subject: "信件主旨",
  from: "寄件人",
  date: "信件日期",
  body: "信件內文",
  rows: "讀到的資料列",
  headers: "欄位名稱",
  sheetText: "整張表的文字",
  text: "讀到的文字",
  answer: "AI 給的答案",
  periodLabel: "這次的期間",
  periodStart: "期間開始日",
  periodEnd: "期間結束日",
};

/**
 * 某個節點的欄位可以插入哪些上游資料。
 * 只回「排在它前面」的節點產生的欄位——後面的步驟還沒跑到，引用了永遠是空的。
 */
export function insertableFieldsFor(
  flow: DataFlowLike,
  nodeId: string,
  lastValues: Record<string, unknown> = {},
): InsertableField[] {
  const index = flow.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return [];
  const seen = new Set<string>();
  const out: InsertableField[] = [];
  for (const node of flow.nodes.slice(0, index)) {
    for (const field of node.outputs) {
      if (field.status === "unknown-source" || !field.name || seen.has(field.name)) continue;
      seen.add(field.name);
      out.push({
        key: field.name,
        label: FRIENDLY[field.name] ?? field.name,
        from: node.label,
        ...(field.name in lastValues ? { sample: previewValue(lastValues[field.name]) } : {}),
      });
    }
  }
  return out;
}

/** 上次的真實值。太長就截短——這是「讓他認出這是不是他要的東西」用的，不是完整資料。 */
export function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > 60 ? `${json.slice(0, 60)}…（一整包資料）` : json;
  }
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** 使用者自己打的 {{欄位}}。 */
export function referencedTokens(text: string): string[] {
  return [...String(text ?? "").matchAll(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g)].map((match) => match[1]);
}

export interface FieldMistake {
  token: string;
  /** 最接近的那個真實欄位；沒有夠接近的就 undefined(代表「這東西根本沒人算」) */
  suggestion?: InsertableField;
}

/**
 * 找出「打了但前面沒有人產生」的欄位。
 * 這件事平台本來就會在執行前檢查，但那時候已經太晚——使用者要的是**打字當下**就知道打錯了。
 */
export function findFieldMistakes(text: string, available: InsertableField[]): FieldMistake[] {
  const known = new Set(available.map((field) => field.key));
  const out: FieldMistake[] = [];
  for (const token of new Set(referencedTokens(text))) {
    if (known.has(token)) continue;
    // 日期這類執行期才決定的內建變數不是打錯，不要誤報
    if (/^(today|yesterday|now|date)/i.test(token)) continue;
    out.push({ token, ...(nearestField(token, available) ? { suggestion: nearestField(token, available)! } : {}) });
  }
  return out;
}

/** 大小寫、少一個字母、順序顛倒這類手誤，找得回來就直接建議。 */
function nearestField(token: string, available: InsertableField[]): InsertableField | undefined {
  const lower = token.toLowerCase();
  let best: { field: InsertableField; distance: number } | undefined;
  for (const field of available) {
    const distance = editDistance(lower, field.key.toLowerCase());
    // 門檻跟著長度走：短欄位名差一個字就差很多，長的可以寬一點
    const limit = Math.max(1, Math.floor(field.key.length / 4));
    if (distance <= limit && (!best || distance < best.distance)) best = { field, distance };
  }
  return best?.field;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const current = [i, ...Array(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[cols - 1];
}
