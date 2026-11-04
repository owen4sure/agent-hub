import type { NodeDefinition, NodeContext } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";

/**
 * 資料處理節點組(2026-08,n8n 差距補齊 P1)：篩選/排序/彙總/去重。
 *
 * 為什麼要有:這四件事以前全靠 custom-code 讓 AI 現寫——同一個「篩出金額大於一萬的列」
 * 每條流程都重新產一次碼、品質浮動、還吃「AI 自寫程式碼比例」這個健康度指標。做成確定性
 * 積木後,行為永遠一致、AI 建圖直接選用、使用者在面板上看得懂每個欄位在做什麼。
 *
 * 資料形狀約定:吃上游的 rows(讀 Excel/試算表/信箱等節點的標準輸出——「清單,每筆是
 * {欄位名:值}」),輸出同形狀的 rows+rowCount,下游接什麼都跟原本一樣。
 */

function getRows(ctx: NodeContext): Record<string, unknown>[] {
  const key = cfgStr(ctx, "sourceField", "rows").trim() || "rows";
  const rows = ctx.input[key];
  if (!Array.isArray(rows)) {
    throw new PermanentError(
      `上游沒有提供「${key}」這份清單資料——這個節點要接在「讀 Excel/讀 Google 試算表/讀取信箱」這類會輸出資料清單的步驟後面。` +
      `上游實際有的欄位:${Object.keys(ctx.input).slice(0, 12).join("、") || "(沒有任何欄位)"}`,
    );
  }
  return rows as Record<string, unknown>[];
}

/** 欄位不存在時把「實際有哪些欄位」端出來——修復迴圈和使用者都要靠這個對名字。 */
function assertField(rows: Record<string, unknown>[], field: string) {
  if (rows.length === 0) return; // 空清單沒得驗,放行(輸出也會是空)
  if (!(field in rows[0])) {
    throw new PermanentError(`資料裡沒有「${field}」這個欄位。實際的欄位有:${Object.keys(rows[0]).slice(0, 15).join("、")}`);
  }
}

/** "1,234"/"$5,678"/數字 都轉成可比較的數值;轉不了回 NaN。 */
function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  const cleaned = String(v ?? "").replace(/[,$\s]/g, "");
  return cleaned === "" ? NaN : Number(cleaned);
}

function isBlank(v: unknown): boolean {
  return String(v ?? "").trim() === "";
}

/**
 * 數字比較前先確認「真的比得了」——比不了就當場報錯,不准靜默回 0 筆。
 * NaN 的任何比較都是 false,所以「日期欄位 大於 2026-01-01」「金額 大於 一萬」這種設定
 * 會安安靜靜濾掉全部資料、流程全綠、報表整份空白,而使用者永遠不知道是比較根本沒成立
 * (這正是平台明令禁止的「全綠但走樣」)。
 */
function assertComparable(rows: Record<string, unknown>[], field: string, value: string, opLabel: string) {
  if (Number.isNaN(toNumber(value))) {
    throw new PermanentError(
      `「${opLabel}」要拿數字來比,但你填的比較值是「${value}」——這不是數字,沒辦法比大小。` +
      `要比日期請改用「等於/包含文字」,或先用步驟把它換算成數字。`,
    );
  }
  const usable = rows.filter((r) => !isBlank(r[field]) && !Number.isNaN(toNumber(r[field])));
  if (rows.length > 0 && usable.length === 0) {
    const samples = rows.slice(0, 3).map((r) => `「${String(r[field] ?? "")}」`).join("、");
    throw new PermanentError(
      `「${field}」這一欄裡沒有任何一格是數字(前幾筆長這樣:${samples}),沒辦法用「${opLabel}」比大小。` +
      `如果是日期或帶單位的文字,請改用「等於/包含文字」,或先加一步把它換算成純數字。`,
    );
  }
}

export const filterRowsNode: NodeDefinition = {
  type: "filter-rows",
  category: "data",
  label: "篩選資料",
  description: "從上游的資料清單裡,留下符合條件的列(例如「金額 大於 10000」「狀態 等於 開戶成功」),其餘濾掉。比讓 AI 寫程式碼穩定,條件一目了然。",
  icon: "🔍",
  configSchema: [
    { key: "field", label: "依哪個欄位判斷", type: "text", default: "" },
    { key: "op", label: "條件", type: "select", default: "equals", options: ["equals=等於", "not-equals=不等於", "contains=包含文字", "gt=大於(數字)", "lt=小於(數字)", "not-empty=不是空的"] },
    { key: "value", label: "比較的值(可用 {{欄位}})", type: "text", default: "", allowEmpty: true },
    { key: "sourceField", label: "清單放在上游哪個欄位", type: "text", default: "rows", advanced: true },
  ],
  outputs: "rows(篩選後的清單), rowCount(剩幾筆), filteredOutCount(被濾掉幾筆)",
  retryable: false,
  async execute(ctx) {
    const rows = getRows(ctx);
    const field = cfgStr(ctx, "field").trim();
    if (!field) throw new PermanentError("還沒設定「依哪個欄位判斷」");
    assertField(rows, field);
    const op = cfgStr(ctx, "op", "equals");
    const value = cfgStr(ctx, "value", "");
    if (op === "gt" || op === "lt") assertComparable(rows, field, value, op === "gt" ? "大於" : "小於");
    const keep = rows.filter((r) => {
      const v = r[field];
      switch (op) {
        case "equals": return String(v ?? "").trim() === value.trim();
        case "not-equals": return String(v ?? "").trim() !== value.trim();
        case "contains": return String(v ?? "").includes(value);
        case "gt": return toNumber(v) > toNumber(value);
        case "lt": return toNumber(v) < toNumber(value);
        case "not-empty": return String(v ?? "").trim() !== "";
        default: throw new PermanentError(`不認識的條件「${op}」`);
      }
    });
    ctx.log(`篩選「${field} ${op} ${value}」:${rows.length} 筆 → 留下 ${keep.length} 筆`);
    return { output: { rows: keep, rowCount: keep.length, filteredOutCount: rows.length - keep.length } };
  },
};

export const sortRowsNode: NodeDefinition = {
  type: "sort-rows",
  category: "data",
  label: "排序資料",
  description: "把上游的資料清單依某個欄位排序(數字欄位自動用數值大小比,文字用筆畫/字母)。",
  icon: "↕️",
  configSchema: [
    { key: "field", label: "依哪個欄位排序", type: "text", default: "" },
    { key: "direction", label: "方向", type: "select", default: "desc", options: ["desc=大到小(新到舊)", "asc=小到大(舊到新)"] },
    { key: "sourceField", label: "清單放在上游哪個欄位", type: "text", default: "rows", advanced: true },
  ],
  outputs: "rows(排序後的清單), rowCount(筆數)",
  retryable: false,
  async execute(ctx) {
    const rows = getRows(ctx);
    const field = cfgStr(ctx, "field").trim();
    if (!field) throw new PermanentError("還沒設定「依哪個欄位排序」");
    assertField(rows, field);
    const dir = cfgStr(ctx, "direction", "desc") === "asc" ? 1 : -1;
    const numeric = rows.length > 0 && rows.every((r) => !Number.isNaN(toNumber(r[field])) || isBlank(r[field]));
    const blanks = rows.filter((r) => isBlank(r[field])).length;
    // 空白格一律排最後(不管大到小還是小到大)。**不能讓空白參與數值比較**——NaN 的比較結果是
    // NaN、`|| 0` 之後變成「跟誰都一樣大」,那是一個不遞移的比較器,JS 的排序在這種比較器下
    // 產生的順序取決於原始資料順序(真實後果:「排序後取前 5 名」名單是錯的,而且完全看不出來)。
    const sorted = [...rows].sort((a, b) => {
      const [av, bv] = [a[field], b[field]];
      const [ab, bb] = [isBlank(av), isBlank(bv)];
      if (ab || bb) return ab && bb ? 0 : ab ? 1 : -1;
      if (numeric) {
        const d = toNumber(av) - toNumber(bv);
        return d === 0 ? 0 : (d > 0 ? 1 : -1) * dir;
      }
      return String(av).localeCompare(String(bv), "zh-Hant") * dir;
    });
    ctx.log(
      `依「${field}」${dir === 1 ? "小到大" : "大到小"}排序 ${sorted.length} 筆(${numeric ? "數值" : "文字"}比較)` +
      (blanks > 0 ? `,其中 ${blanks} 筆這一欄是空白,一律排在最後面` : ""),
    );
    return { output: { rows: sorted, rowCount: sorted.length } };
  },
};

export const aggregateRowsNode: NodeDefinition = {
  type: "aggregate-rows",
  category: "data",
  label: "彙總資料",
  description: "把上游的資料清單分組統計:每組幾筆、某欄位加總(例如「依分類,加總金額」)。不分組就是整體合計。",
  icon: "Σ",
  configSchema: [
    { key: "groupBy", label: "依哪個欄位分組(留空=整體合計)", type: "text", default: "", allowEmpty: true },
    { key: "sumField", label: "要加總哪個數字欄位(留空=只算筆數)", type: "text", default: "", allowEmpty: true },
    { key: "sourceField", label: "清單放在上游哪個欄位", type: "text", default: "rows", advanced: true },
  ],
  outputs: "rows(每組一筆:分組/筆數/加總), rowCount(組數), grandTotal(全部加總), grandCount(全部筆數)",
  retryable: false,
  async execute(ctx) {
    const rows = getRows(ctx);
    const groupBy = cfgStr(ctx, "groupBy", "").trim();
    const sumField = cfgStr(ctx, "sumField", "").trim();
    if (groupBy) assertField(rows, groupBy);
    if (sumField) assertField(rows, sumField);
    const groups = new Map<string, { 筆數: number; 加總: number }>();
    let grandTotal = 0;
    for (const r of rows) {
      const key = groupBy ? String(r[groupBy] ?? "(空白)") : "(全部)";
      const g = groups.get(key) ?? { 筆數: 0, 加總: 0 };
      g.筆數++;
      if (sumField) {
        const n = toNumber(r[sumField]);
        if (!Number.isNaN(n)) { g.加總 += n; grandTotal += n; }
      }
      groups.set(key, g);
    }
    const out = [...groups.entries()].map(([k, g]) => ({ 分組: k, 筆數: g.筆數, ...(sumField ? { 加總: g.加總 } : {}) }));
    ctx.log(`彙總:${rows.length} 筆分成 ${out.length} 組${sumField ? `,「${sumField}」總計 ${grandTotal.toLocaleString()}` : ""}`);
    return { output: { rows: out, rowCount: out.length, grandTotal, grandCount: rows.length } };
  },
};

export const dedupRowsNode: NodeDefinition = {
  type: "dedup-rows",
  category: "data",
  label: "去除重複",
  description: "把上游資料清單裡「某欄位值相同」的重複列去掉,只留第一筆(例如依 Email 去重)。多個欄位用逗號分隔。",
  icon: "🧹",
  configSchema: [
    { key: "fields", label: "依哪些欄位判斷重複(逗號分隔)", type: "text", default: "" },
    { key: "sourceField", label: "清單放在上游哪個欄位", type: "text", default: "rows", advanced: true },
  ],
  outputs: "rows(去重後的清單), rowCount(剩幾筆), removedCount(移除幾筆)",
  retryable: false,
  async execute(ctx) {
    const rows = getRows(ctx);
    const fields = cfgStr(ctx, "fields").split(",").map((s) => s.trim()).filter(Boolean);
    if (fields.length === 0) throw new PermanentError("還沒設定「依哪些欄位判斷重複」");
    for (const f of fields) assertField(rows, f);
    const seen = new Set<string>();
    const keep: Record<string, unknown>[] = [];
    for (const r of rows) {
      const key = fields.map((f) => String(r[f] ?? "")).join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      keep.push(r);
    }
    ctx.log(`依「${fields.join("、")}」去重:${rows.length} 筆 → ${keep.length} 筆(移除 ${rows.length - keep.length} 筆重複)`);
    return { output: { rows: keep, rowCount: keep.length, removedCount: rows.length - keep.length } };
  },
};
