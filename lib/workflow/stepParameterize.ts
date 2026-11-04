/**
 * 把「一段調通的程式碼」變成「可以重複套用的步驟」。
 *
 * 這是整件事最難、也最不能丟給使用者的一步：一段能跑的程式碼裡一定寫死了這次用的值
 * (收件人、網址、分頁名稱、關鍵字…)，要重複套用就得把那些值抽出來變成設定欄位。
 * 但**使用者看不懂程式碼**——不能叫他「把要參數化的地方選起來」。
 *
 * 所以由模型提案、使用者用白話確認：模型負責「哪幾個值是每次會不一樣的」，
 * 使用者負責「這個欄位叫什麼名字比較好懂」。他從頭到尾不用讀任何一行程式碼。
 *
 * 這裡只放**確定性的部分**：組提示、驗證模型的回覆、實際做字串替換。
 * 模型會亂回是常態(這個 repo 的第一性原理)，所以每一項提案都要能被程式碼驗證：
 * 抽出來的值必須真的在程式碼裡出現、替換後語法必須還是合法的、宣告的欄位必須真的被用到。
 */

export interface ProposedParam {
  key: string;
  label: string;
  /** 程式碼裡目前寫死的那個值(含引號的字面內容)，用來做替換 */
  literal: string;
  type: "text" | "textarea" | "number" | "boolean";
  help?: string;
}

export interface ParameterizeResult {
  code: string;
  params: ProposedParam[];
  /** 模型提了但通不過驗證、因此被丟掉的——一定要能講出來，不能默默少做 */
  rejected: { literal: string; reason: string }[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

export function parameterizePrompt(intent: string, code: string): string {
  return `這段程式碼目前可以正常運作，但裡面寫死了「這一次」用的值。
使用者想把它存成一個可以**重複套用**的步驟，所以要把「每次用可能不一樣的值」變成可設定的欄位。

【這個步驟在做什麼】
${intent || "(沒有說明)"}

【目前的程式碼】
${code}

【你要做的】
挑出「每次套用時使用者可能想改」的寫死值，例如：收件人、網址、檔名、分頁名稱、關鍵字、門檻數字。
**不要**挑這些：迴圈變數、暫時變數、演算法內部常數(如陣列索引、重試次數)、以及從 ctx.input 來的值
(那些是上游傳進來的，本來就會變，不需要變成設定欄位)。

寧可少挑也不要多挑：多挑一個，使用者的設定畫面就多一個他看不懂、也不知道要不要改的欄位。

【回覆格式】只回一個 JSON，不要任何說明文字：
{"params":[{"key":"英數底線代號","label":"使用者看得懂的中文名稱","literal":"程式碼裡目前那個值(不含引號)","type":"text|textarea|number|boolean","help":"選填，一句話說明"}]}

label 要用白話，是給完全不懂程式的人看的(例如「收件人」而不是「recipient」、
「要抓的分頁名稱」而不是「sheetName」)。找不到適合抽出來的值就回 {"params":[]}。`;
}

/**
 * 驗證模型的提案並實際做替換。
 *
 * 每一項都要過三關，過不了就丟掉並講原因——不能因為模型說有就照做：
 * ①那個值必須真的在程式碼裡出現(而且只出現在字串裡，不是變數名的一部分)
 * ②代號合法、不重複
 * ③替換完語法仍然合法
 */
export function applyParameterization(code: string, raw: unknown): ParameterizeResult {
  const proposals = Array.isArray((raw as { params?: unknown })?.params) ? (raw as { params: unknown[] }).params : [];
  const params: ProposedParam[] = [];
  const rejected: { literal: string; reason: string }[] = [];
  const usedKeys = new Set<string>();
  let out = code;

  for (const item of proposals) {
    if (!item || typeof item !== "object") continue;
    const proposal = item as Record<string, unknown>;
    const key = String(proposal.key ?? "").trim();
    const label = String(proposal.label ?? "").trim();
    const literal = String(proposal.literal ?? "");
    const type = (["text", "textarea", "number", "boolean"] as const).includes(proposal.type as never)
      ? (proposal.type as ProposedParam["type"]) : "text";

    if (!KEY_RE.test(key)) { rejected.push({ literal, reason: `代號「${key}」不合法` }); continue; }
    if (usedKeys.has(key)) { rejected.push({ literal, reason: `代號「${key}」重複` }); continue; }
    if (!label) { rejected.push({ literal, reason: "少了看得懂的名稱" }); continue; }
    if (!literal.trim()) { rejected.push({ literal, reason: "沒有指出要替換哪個值" }); continue; }

    // 只替換「字串字面」裡的那個值——直接對整份程式碼做字串替換會誤傷變數名、註解、
    // 甚至別的字串裡剛好一樣的片段(真實會發生：分頁名稱「七月」同時出現在註解跟另一個判斷式裡)。
    const quoted = findQuotedOccurrences(out, literal);
    if (quoted.length === 0) { rejected.push({ literal, reason: "這個值在程式碼的字串裡找不到" }); continue; }
    if (quoted.length > 1) { rejected.push({ literal, reason: `這個值在程式碼裡出現 ${quoted.length} 次，換掉會有歧義` }); continue; }

    const replacement = `ctx.config.${key}`;
    const { start, end } = quoted[0];
    const candidate = out.slice(0, start) + replacement + out.slice(end);
    if (!isSyntaxValid(candidate)) { rejected.push({ literal, reason: "換掉之後程式碼語法會壞掉" }); continue; }

    out = candidate;
    usedKeys.add(key);
    params.push({ key, label, literal, type, ...(typeof proposal.help === "string" && proposal.help.trim() ? { help: proposal.help.trim().slice(0, 200) } : {}) });
  }
  return { code: out, params, rejected };
}

/**
 * 找出「被引號包起來的、內容剛好等於這個值」的位置(含引號本身)。
 * 三種引號都認；刻意要求「整個字串等於那個值」而不是「包含」——部分替換幾乎一定是誤傷。
 */
function findQuotedOccurrences(code: string, literal: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const quote of ["'", '"', "`"]) {
    const needle = `${quote}${literal}${quote}`;
    let index = code.indexOf(needle);
    while (index !== -1) {
      out.push({ start: index, end: index + needle.length });
      index = code.indexOf(needle, index + needle.length);
    }
  }
  return out;
}

/** 跟 codegen 用同一種方式驗語法：能不能被建成函式。 */
function isSyntaxValid(code: string): boolean {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor as new (...args: string[]) => unknown;
    new AsyncFunction("ctx", code);
    return true;
  } catch { return false; }
}
