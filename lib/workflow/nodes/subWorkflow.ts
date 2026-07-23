import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr, resolveJsonSafeTemplate } from "../nodeHelpers";
import { getMaxConcurrent } from "../../settingsStore";
import { getDb } from "../../db";
// ⚠️ 不能在頂層 import ../engine 或 ../store：registry.ts 靜態 import 所有節點(含這個檔案
// export 的 subWorkflowNode)，而 engine.ts 執行節點要用 registry 的 getNodeDef、store.ts 也在
// 自己的頂層 import registry 的 getNodeDef，兩邊都會跟 registry.ts 形成循環。若這個檔案被當成
// 循環的入口(例如測試直接 import 這個節點檔的 collectSubRunOutput)，會在 subWorkflowNode 還沒
// export 完成前就被存取，炸出「Cannot access before initialization」。這兩組都只在 execute()
// 執行期才需要，改成動態 import 把循環徹底切斷(跟 waitApproval.ts 同一套修法)。

/**
 * 執行子流程:把另一條流程當一個步驟呼叫,等它跑完把結果接回來。
 * 共用邏輯(例如「登入並下載報表」)做成一條流程,多條主流程都呼叫它——不用複製貼上一堆節點。
 */
export const subWorkflowNode: NodeDefinition = {
  type: "run-workflow",
  category: "logic",
  label: "執行子流程",
  description: "呼叫另一條流程當作一個步驟(可用名稱或 id 指定),等它跑完把它的輸出接回來給下游。共用邏輯抽成子流程,多條流程重複使用。",
  icon: "🧩",
  outputs: "subRunOk(子流程是否成功)+子流程最後一個節點輸出的所有欄位",
  configSchema: [
    { key: "target", label: "要執行的流程(名稱或 id)", type: "text", default: "" },
    { key: "paramsJson", label: "要傳給它的參數(JSON 物件,可用 {{欄位}},留空=原樣轉傳目前資料)", type: "textarea", allowEmpty: true },
  ],
  retryable: false,
  timeoutMs: 20 * 60_000,
  async execute(ctx) {
    const { getWorkflow, findWorkflowsByName } = await import("../store");
    const { runWorkflowAndWait, defaultMaxConcurrent } = await import("../engine");
    const target = cfgStr(ctx, "target").trim();
    if (!target) throw new PermanentError("沒有指定要執行哪條流程(填名稱或 id)");
    // 依 id 或名稱找(名稱要唯一,重名就老實要求用 id)。
    // getWorkflow 對「不像 id 的字串」(如中文名稱)會直接 throw(路徑穿越防護),要先驗格式再走 id 路
    let wf = /^[a-zA-Z0-9_-]{1,80}$/.test(target) ? getWorkflow(target) : null;
    if (!wf) {
      const hits = findWorkflowsByName(target);
      if (hits.length > 1) {
        // 「請改填流程 id」對非工程使用者不好執行——他不一定知道 id 在哪裡看，也不一定想去找。
        // 改成列出每一條的分類/簡述當可辨識的線索，並把「最簡單的解法」(直接改名字)放在前面；
        // id 仍然列出來當保底，給真的想直接指定的人用。
        const list = hits.map((h) => `- 「${h.name}」(id: ${h.id}${h.group ? `，分類：${h.group}` : ""}${h.longDescription ? `，說明：${h.longDescription.slice(0, 40)}` : ""})`).join("\n");
        throw new PermanentError(
          `有 ${hits.length} 條流程都叫「${target}」，沒辦法確定要執行哪一條：\n${list}\n最簡單的解法：到其中一條流程頁面把名稱改成不會重複的名字，再把這裡的「要執行的流程」改成新名稱；也可以直接把這裡填成上面列出的 id。`,
        );
      }
      wf = hits[0] ?? null;
    }
    if (!wf) throw new PermanentError(`找不到流程「${target}」——確認名稱拼對,或改填流程 id`);
    if (wf.id === ctx.workflowId) throw new PermanentError("子流程不能呼叫自己(會無限循環)");
    const level = Number((ctx.input as Record<string, unknown>).__subLevel ?? 0);
    if (level >= 2) throw new PermanentError("子流程最多巢狀兩層——再深的結構請攤平,不然出錯很難排查");
    if (getMaxConcurrent(defaultMaxConcurrent()) < 2) {
      throw new PermanentError("執行子流程需要併行執行空間——請到「排程 & 執行」頁把「同時觸發時怎麼跑」改成「併行」再重試(依序模式下母流程會佔住唯一名額,子流程永遠排不進去)");
    }

    let params: Record<string, unknown>;
    // 這欄位的值本身要被 JSON.parse()，不能用 cfgStr 的原始文字替換——上游資料(例如彙整報表的
    // 多行內容)一旦含換行/引號，原封不動塞進 JSON 字串字面值會讓整包壞掉。要用 JSON 安全的替換，
    // 見 resolveJsonSafeTemplate 的說明與真實踩過的案例。
    const rawTemplate = String(ctx.config.paramsJson ?? "").trim();
    const raw = rawTemplate ? resolveJsonSafeTemplate(rawTemplate, ctx) : "";
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("要是 JSON 物件");
        params = parsed as Record<string, unknown>;
      } catch (err) {
        throw new PermanentError(`「要傳的參數」不是合法 JSON 物件:${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      params = { ...(ctx.input as Record<string, unknown>) };
    }
    params.__subLevel = level + 1;

    ctx.log(`開始執行子流程「${wf.name}」…`);
    const result = await runWorkflowAndWait(wf.id, params, { headed: false, timeoutMs: 15 * 60_000, dryRun: ctx.dryRun });
    if (result.status === "waiting") {
      // 子流程停在等簽核——母流程沒辦法跟著暫停幾小時/幾天(引擎的續跑只存到節點層級)。
      // 老實擋下並指路:簽核節點放母流程,或把「簽核之後的事」做成獨立流程
      throw new PermanentError(`子流程「${wf.name}」裡有「等人簽核」節點——子流程不能停下來等人。請把簽核節點放在母流程裡,簽核後的步驟接在母流程的簽核節點後面`);
    }
    if (result.status !== "success") {
      // 「到那條流程的紀錄頁看細節」對透過母流程操作的使用者不夠直接——他可能根本不知道
      // 子流程是哪一條、名字是什麼。這裡把失敗原因直接帶出來(result.error 已經是人話錯誤訊息)，
      // 並明講要去畫面上哪裡找：直接點這條子流程的名字進去看執行紀錄。
      throw new PermanentError(`子流程「${wf.name}」執行失敗，原因：${result.error ?? "未知原因"}——可以到首頁點進「${wf.name}」這條流程查看完整的執行紀錄`);
    }
    ctx.log(`子流程「${wf.name}」完成`);
    const out = collectSubRunOutput(result.runId);
    delete out.__subLevel;
    return { output: { ...ctx.input, ...out, subRunOk: true } };
  },
};

/**
 * 把子流程「所有成功節點」的輸出接回來給呼叫端，不是只接最後一個節點自己新增的欄位。
 *
 * engine.ts 執行時，記憶體裡的 nodeOutputs 對每個節點存的是「這個節點收到的 input + 它自己新增的
 * 欄位」的合併值(見 engine.ts 鐵則6a)，讓同一次執行內任何下游都能引用更早以前算出來的資料。
 * 但寫進資料庫的 node_runs.output_json 存的只有 result.output(這個節點自己新增的那幾個欄位)——
 * 這兩者不一樣，是刻意的：畫面上的執行紀錄如果每個節點都疊上游全部欄位，會非常雜亂。
 *
 * 問題是子流程執行完之後，母流程只能從資料庫(不是記憶體)讀回結果——若直接照搬「只讀最後一個
 * 節點的 output_json」，只有 trigger/custom-code 這類自己會 {...ctx.input} 的節點才會帶齊全部欄位，
 * 大部分內建節點(如 desktop-notify、google-sheet-update)自己的 result.output 只有自己新增的那一兩個
 * 欄位——子流程中間步驟算出來的資料，只要子流程的最後一步不是這種節點，就會在接回母流程的路上不見
 * (真實踩過：共用子流程最後一步是 desktop-notify，它自己只回 {notified:true}，前一步算好的
 * formattedMessage 完全接不回母流程，母流程以為會拿到格式化好的文字，實際上什麼都沒有)。
 *
 * 修法：把子流程這次執行「所有成功節點」的 output_json 依執行順序(id 由小到大)依序疊加，
 * 重建出跟記憶體 nodeOutputs 在子流程執行結束當下等價的累積欄位——後面的節點蓋掉前面同名欄位，
 * 跟 engine.ts 記憶體內的合併順序一致。
 */
export function collectSubRunOutput(runId: string): Record<string, unknown> {
  const rows = getDb()
    .prepare(`SELECT output_json FROM node_runs WHERE run_id = ? AND status = 'success' AND output_json IS NOT NULL ORDER BY id ASC`)
    .all(runId) as { output_json: string }[];
  let out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.output_json) as Record<string, unknown>;
      out = { ...out, ...parsed };
    } catch { /* 壞 JSON 就跳過這一節點,不擋其他欄位 */ }
  }
  return out;
}
