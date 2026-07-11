import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { cfgStr } from "../nodeHelpers";
import { runWorkflowAndWait, defaultMaxConcurrent } from "../engine";
import { getWorkflow, listWorkflows } from "../store";
import { getMaxConcurrent } from "../../settingsStore";
import { getDb } from "../../db";

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
    const target = cfgStr(ctx, "target").trim();
    if (!target) throw new PermanentError("沒有指定要執行哪條流程(填名稱或 id)");
    // 依 id 或名稱找(名稱要唯一,重名就老實要求用 id)。
    // getWorkflow 對「不像 id 的字串」(如中文名稱)會直接 throw(路徑穿越防護),要先驗格式再走 id 路
    let wf = /^[a-zA-Z0-9_-]{1,80}$/.test(target) ? getWorkflow(target) : null;
    if (!wf) {
      const hits = listWorkflows().filter((w) => w.name === target);
      if (hits.length > 1) throw new PermanentError(`有 ${hits.length} 條流程都叫「${target}」——請改填流程 id(網址列 /workflows/ 後面那段)`);
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
    const raw = cfgStr(ctx, "paramsJson", "").trim();
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
    const result = await runWorkflowAndWait(wf.id, params, { headed: false, timeoutMs: 15 * 60_000 });
    if (result.status !== "success") {
      throw new PermanentError(`子流程「${wf.name}」失敗:${result.error ?? "未知原因"}——到那條流程的紀錄頁看細節`);
    }
    ctx.log(`子流程「${wf.name}」完成`);
    // 把子流程「最後一個成功節點」的輸出接回來給下游
    const row = getDb()
      .prepare(`SELECT output_json FROM node_runs WHERE run_id = ? AND status = 'success' AND output_json IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get(result.runId) as { output_json: string } | undefined;
    let out: Record<string, unknown> = {};
    try { out = row ? (JSON.parse(row.output_json) as Record<string, unknown>) : {}; } catch { /* 壞 JSON 就不接,不擋成功 */ }
    delete out.__subLevel;
    return { output: { ...ctx.input, ...out, subRunOk: true } };
  },
};
