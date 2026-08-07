import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";

/**
 * 合併資料(2026-08,n8n 差距補齊 P2):把多個上游分支的「清單」明確合併。
 *
 * 為什麼要有:引擎本來就會把多個上游的輸出攤平合併,但同名欄位「後蓋前」——兩個分支各抓了
 * 一份 rows,下游只拿得到其中一份(另一份被蓋掉,只有警告)。這個節點把「我要兩份都要」變成
 * 明確的動作:用分開層(ctx.outputs)把每個上游各自的清單抓出來接起來或依鍵合併,不再靠運氣。
 */
export const mergeRowsNode: NodeDefinition = {
  type: "merge-rows",
  category: "logic",
  label: "合併資料",
  description: "把多個上游分支各自的資料清單明確合併成一份:「接起來」直接串接(A 的列+B 的列),「依鍵合併」用某欄位當鑰匙把同一筆的欄位拼起來。不用這個節點的話,同名的清單只會留最後一個分支的。",
  icon: "🔗",
  configSchema: [
    { key: "mode", label: "怎麼合併", type: "select", default: "append", options: ["append=接起來(A 的列接 B 的列)", "by-key=依鍵合併(同鍵的列拼成一筆)"] },
    { key: "key", label: "依哪個欄位當鑰匙(只有「依鍵合併」要填)", type: "text", default: "", allowEmpty: true },
    { key: "sourceField", label: "各上游的清單欄位名", type: "text", default: "rows", advanced: true },
  ],
  outputs: "rows(合併後的清單), rowCount(筆數), mergedFrom(來自哪幾個上游步驟)",
  retryable: false,
  async execute(ctx) {
    const srcKey = cfgStr(ctx, "sourceField", "rows").trim() || "rows";
    // 分開層是這個節點的地基:每個上游「自己的」清單,不吃攤平後蓋前的結果
    const sources = Object.entries(ctx.outputs ?? {})
      .filter(([, own]) => Array.isArray(own[srcKey]))
      .map(([nodeId, own]) => ({ nodeId, rows: own[srcKey] as Record<string, unknown>[] }));
    if (sources.length === 0) {
      throw new PermanentError(
        `所有上游步驟都沒有輸出「${srcKey}」清單——這個節點要接在兩個以上「會輸出資料清單」的步驟後面(讀試算表/篩選資料等)。`,
      );
    }
    const mode = cfgStr(ctx, "mode", "append");
    if (mode === "append") {
      const rows = sources.flatMap((s) => s.rows);
      ctx.log(`接起來:${sources.map((s) => `「${s.nodeId}」${s.rows.length} 筆`).join(" + ")} = ${rows.length} 筆`);
      return { output: { rows, rowCount: rows.length, mergedFrom: sources.map((s) => s.nodeId) } };
    }
    if (mode === "by-key") {
      const key = cfgStr(ctx, "key").trim();
      if (!key) throw new PermanentError("「依鍵合併」要填「依哪個欄位當鑰匙」(例如 Email、訂單編號)");
      const merged = new Map<string, Record<string, unknown>>();
      for (const s of sources) {
        for (const r of s.rows) {
          if (!(key in r)) throw new PermanentError(`「${s.nodeId}」的清單裡沒有「${key}」欄位。實際欄位:${Object.keys(r).slice(0, 12).join("、")}`);
          const k = String(r[key] ?? "");
          merged.set(k, { ...(merged.get(k) ?? {}), ...r });
        }
      }
      const rows = [...merged.values()];
      ctx.log(`依「${key}」合併 ${sources.length} 個來源:共 ${rows.length} 筆(相同鍵的欄位拼在同一筆)`);
      return { output: { rows, rowCount: rows.length, mergedFrom: sources.map((s) => s.nodeId) } };
    }
    throw new PermanentError(`不認識的合併方式「${mode}」`);
  },
};
