import type { NodeDefinition, NodeContext } from "../types";
import { PermanentError } from "../types";
import { getWorkflow, saveWorkflow } from "../store";
import { generateCustomCode, isPlaceholderCode } from "../codegen";
import { DATE_TOKENS, resolveValue } from "../../relativeDate";
import { dryRunSkipKind, DRY_RUN_SKIPPED_WRITES_KEY, type DryRunSkippedWrite } from "../dryRun";
// ⚠️ 不能在頂層 import registry：registry 的節點清單 import 這個檔案，形成循環——哪個先被載入，
// 另一個就會拿到「初始化到一半」的模組(實測：直接載入本檔會 TDZ 炸掉)。getNodeDef 只在執行期用得到，
// 改成 execute 裡動態 import，把循環徹底切斷。

/**
 * 「對清單裡每一項重複做同一組步驟」——解決固定畫 N 組幾乎一樣節點的複雜度問題。
 * 實測踩過的真實案例：處理 3 個月的報表，AI 建圖時把「找信→下載附件→擷取資料」原封不動複製 3 遍，
 * 21 節點的流程有 9 個節點只是在做同一件事、換個月份而已，使用者反應「太複雜」。
 * 這個節點把「重複的那一段」收成一份定義，執行時對清單每一項各跑一次，輸出彙整成一個陣列。
 *
 * 設計取捨：steps 內部呼叫的是「其他節點型別自己的 execute()」，不是重新發明一套邏輯——
 * 這樣 find-email/download-attachment/custom-code 等已經測試過的節點邏輯可以直接在迴圈裡複用，
 * 不用另外維護一份。同一個瀏覽器分頁(ctx.session)、同一個中斷訊號(ctx.cancelSignal)貫穿所有迭代，
 * 跟這個節點外的其他步驟共用資源的方式完全一致。
 *
 * 已知取捨(接受作為 v1 範圍)：整個節點在外層引擎眼中是「一個節點」，重試時會從第 1 項重新跑
 * (不是從失敗的那項續跑)——多花一點時間，但正確性比效率重要，且跟系統其他地方「失敗就整個節點重來」
 * 的既有設計一致，不引入新的部分成功語意。
 */

// 避免 registry.ts → 這個節點檔 → engine.ts → registry.ts 的循環 import，這兩個小函式在這裡各自留一份，
// 邏輯跟 engine.ts 的 withSchemaDefaults/resolveDatesInConfig 完全對齊(只用在這個節點內部)。
function withSchemaDefaults(config: Record<string, unknown>, schema: { key: string; default?: string; allowEmpty?: boolean }[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const f of schema) {
    const missing = out[f.key] === undefined || out[f.key] === null || (out[f.key] === "" && !f.allowEmpty);
    if (missing && f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}
function resolveDatesInConfig(config: Record<string, unknown>, now: Date): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dateTokens = new RegExp(`\\{\\{\\s*(${DATE_TOKENS.join("|")})(-\\d+)?\\s*\\}\\}`);
  for (const [k, v] of Object.entries(config)) {
    out[k] = typeof v === "string" && dateTokens.test(v) ? v.replace(new RegExp(dateTokens, "g"), (m) => resolveValue(m, now)) : v;
  }
  return out;
}

interface StepSpec { type: string; label?: string; config: Record<string, unknown> }

/**
 * 把「迴圈內剛產生的 custom-code 程式碼」存回這個 repeat-steps 節點的 steps JSON。
 * 為什麼必須有這個：迴圈內部步驟用的是合成的臨時 nodeId(如 loop1-i0-s2)，codegen 內建的
 * 「存回節點」找不到這個 id 就默默不存——結果是**每一輪迭代、每一次重試都重新呼叫模型產一次
 * 程式碼(每次 30 秒~2 分鐘)**，整個節點必然超過逾時上限、引擎重試又從頭產一次，看起來就是
 * 「一直卡在那邊跑不完」(使用者實際踩到的災難)。產生一次就存回，之後所有迭代和未來的執行直接用。
 * 比照 AGENTS 存檔鐵則2：以磁碟最新版為底、只動這個節點的 steps；比照 codegen 的先到先贏：
 * 磁碟上那一步已經有程式碼就不覆蓋(別的並發嘗試先存好了)。
 */
function persistStepCode(workflowId: string, nodeId: string, stepIndex: number, code: string): void {
  const wf = getWorkflow(workflowId);
  const node = wf?.nodes.find((n) => n.id === nodeId);
  if (!wf || !node || typeof node.config.steps !== "string") return;
  try {
    const steps = JSON.parse(node.config.steps) as StepSpec[];
    const target = steps?.[stepIndex];
    if (!target || target.type !== "custom-code") return;
    if (!isPlaceholderCode(String(target.config?.code ?? ""))) return; // 先到先贏：已有程式碼就不覆蓋
    target.config = { ...(target.config ?? {}), code };
    const nodes = wf.nodes.map((n) => (n.id === nodeId ? { ...n, config: { ...n.config, steps: JSON.stringify(steps) } } : n));
    saveWorkflow({ ...wf, nodes });
  } catch { /* steps 解析失敗就不存(下次執行會再試產一次，不影響本次執行已拿到的程式碼) */ }
}

/** 解析「重複清單」欄位：優先當作 {{欄位名}} 去 ctx.input/vars 找真正的陣列(不是字串化)，
 * 找不到才試著當字面 JSON 陣列解析(使用者/AI 直接貼一份清單的情境)。 */
function resolveItemsList(ctx: NodeContext, raw: string): unknown[] {
  const trimmed = raw.trim();
  const refMatch = trimmed.match(/^\{\{\s*([^}]+)\s*\}\}$/);
  if (refMatch) {
    const key = refMatch[1].trim();
    const v = (ctx.input as Record<string, unknown>)[key] ?? (ctx.vars as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
    throw new PermanentError(`「重複清單」引用的欄位 {{${key}}} 不是陣列(上游要輸出一份清單，例如每個月一筆的資料)`);
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* 不是合法 JSON，往下報通用錯誤 */ }
  throw new PermanentError(`「重複清單」欄位沒辦法解析成一份清單：${trimmed.slice(0, 100)}`);
}

export const repeatStepsNode: NodeDefinition = {
  type: "repeat-steps",
  category: "logic",
  label: "重複執行(對清單每一項)",
  description:
    "對一份清單裡的每一項，重複執行同一組步驟(例如：清單是 3 個月份，每個月都要「找信→下載附件→擷取資料」)。**用這個節點取代「同樣的幾個步驟複製貼上 N 遍」**——只寫一次要做什麼，清單有幾項就自動跑幾次，流程圖不會因為處理多筆類似資料而暴增節點數。清單裡目前這一項在 steps 的設定裡可以用 {{item}} 引用(如果每項是物件，用 {{item.欄位名}}，例如 {{item.searchDate}})。",
  icon: "🔁",
  // 開頭不能是英文識別字——outputFieldNames 會把「settings」誤抽成欄位名(實際欄位名由 config.outputKey 決定,lint 的 dynKey 已涵蓋)
  outputs: "依「彙整輸出欄位名」設定(預設 results):一個陣列;每一項是該次迭代最後一步的完整輸出",
  configSchema: [
    { key: "items", label: "重複清單(可用 {{欄位名}} 引用上游的陣列)", type: "text", default: "" },
    { key: "itemVar", label: "這一項在步驟裡叫什麼名字(預設 item)", type: "text", default: "item" },
    {
      key: "steps",
      label: "每一項要重複跑的步驟(JSON 陣列，每個元素是 {type,label,config}，config 可用 {{item}} 或 {{item.欄位}})",
      type: "textarea",
      default: "[]",
    },
    { key: "outputKey", label: "彙整結果要輸出到哪個欄位(預設 results)", type: "text", default: "results" },
  ],
  retryable: true,
  // 一個節點做 N 輪工作(每輪含瀏覽器操作,第一次執行還可能要產程式碼30-120秒),引擎預設的3分鐘必然不夠——
  // 逾時被砍掉重試等於前面成功的輪次全部白做。步驟層有自己的重試(見下),整個節點給足空間。
  timeoutMs: 15 * 60 * 1000,
  async execute(ctx) {
    const { getNodeDef } = await import("../registry"); // 動態載入,切斷與 registry 的循環 import(見檔頭註解)
    const outputKey = String(ctx.config.outputKey || "results").trim() || "results";
    const itemVar = String(ctx.config.itemVar || "item").trim() || "item";
    const itemsRaw = String(ctx.config.items ?? "");
    if (!itemsRaw.trim()) throw new PermanentError("「重複清單」還沒設定要對哪份清單重複執行");
    const items = resolveItemsList(ctx, itemsRaw);
    if (items.length === 0) {
      ctx.log("重複清單是空的，這個節點不會執行任何步驟");
      return { output: { [outputKey]: [] } };
    }

    // 引擎重試整個節點時傳入的是「重試前建立的同一個」ctx 物件，ctx.config.steps 仍是重試前的舊快照——
    // 若前一次嘗試已經把某步驟的程式碼存回磁碟(persistStepCode)，不重新讀最新磁碟版本的話，這裡看到的
    // 還是空殼，會導致同一步驟在每次引擎層重試時都重新呼叫模型產一次碼(persistStepCode 本來就是為了
    // 「產一次、之後都共用」，但沒接到「引擎重試用同一份 ctx」這個角度，實測會導致節點反覆逾時)。
    // 用磁碟最新版的 steps(若存在)取代，其餘設定仍照 ctx.config(引擎已解析過 schema 預設值/日期)。
    // steps 可能是「真陣列」(AI 建圖直接給 JSON 陣列)或「JSON 字串」(schema 是 textarea)——
    // 兩種都要接。以前只接字串,真陣列被 String() 成 "[object Object]" 直接炸(實測踩過,
    // 還得靠修復迴圈燒一輪 AI 呼叫救回來,這種確定性問題不該浪費模型)。
    const coerceSteps = (v: unknown): unknown => (Array.isArray(v) ? v : JSON.parse(String(v ?? "[]")));
    let stepsRaw: unknown = ctx.config.steps;
    const wfLatest = getWorkflow(ctx.workflowId);
    const latestSteps = wfLatest?.nodes.find((n) => n.id === ctx.nodeId)?.config.steps;
    if (latestSteps !== undefined) stepsRaw = latestSteps;

    let steps: StepSpec[];
    try {
      const parsed = coerceSteps(stepsRaw);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("steps 必須是非空陣列");
      steps = parsed as StepSpec[];
    } catch (err) {
      throw new PermanentError(`「重複步驟」設定不是合法的步驟清單：${err instanceof Error ? err.message : String(err)}`);
    }
    for (const s of steps) {
      if (!s || typeof s !== "object" || typeof s.type !== "string" || !getNodeDef(s.type)) {
        throw new PermanentError(`「重複步驟」裡有一步的型別「${s?.type}」不存在，無法執行`);
      }
    }

    const now = new Date();
    const results: unknown[] = [];
    const dryRunSkippedWrites: DryRunSkippedWrite[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemLabel = item && typeof item === "object" && "label" in (item as object) ? String((item as Record<string, unknown>).label) : String(i + 1);
      ctx.log(`── 第 ${i + 1}/${items.length} 項(${itemLabel})開始 ──`);
      let stepInput: Record<string, unknown> = { ...ctx.input, [itemVar]: item };
      for (let j = 0; j < steps.length; j++) {
        const step = steps[j];
        const def = getNodeDef(step.type)!;
        const stepLabel = step.label || def.label;

        // repeat-steps 是容器，外層 engine 看不到裡面的節點；只在 engine 檢查外層會讓內嵌的
        // 寄信／寫試算表／POST API 在「只讀」試跑中真的送出去。每一小步都必須套同一套守衛。
        if (ctx.dryRun) {
          const providedFile = ["filePath", "attachmentPath", "savedPath", "inputFile"]
            .some((key) => typeof stepInput[key] === "string" && String(stepInput[key]).length > 0);
          const skipKind = dryRunSkipKind({
            id: `${ctx.nodeId}-i${i}-s${j}`,
            type: step.type,
            label: stepLabel,
            config: step.config ?? {},
            position: { x: 0, y: 0 },
          }, providedFile);
          if (skipKind) {
            ctx.log(skipKind === "write"
              ? `[第${i + 1}項:${itemLabel}／${stepLabel}] 🔒 只讀驗證：略過這步，不會真的寫回／發送`
              : `[第${i + 1}項:${itemLabel}／${stepLabel}] 🔒 已有直接提供的檔案，略過重新抓取`);
            if (skipKind === "write") {
              dryRunSkippedWrites.push({
                nodeLabel: `第 ${i + 1} 項／${stepLabel}`,
                type: step.type,
                config: { ...(step.config ?? {}) },
                input: { ...stepInput },
              });
            }
            continue;
          }
        }

        // custom-code 步驟還是空殼 → 在這裡「產一次、存回節點、所有迭代共用」。
        // 不能交給 customCode.execute 自己處理：它存回時找的是合成的臨時 nodeId(找不到→不存)，
        // 會變成每一輪迭代+每次重試都重新產碼(實測踩到的「一直卡在那邊」根因)。
        if (step.type === "custom-code" && isPlaceholderCode(String(step.config?.code ?? ""))) {
          const intent = String(step.config?.intent ?? "").trim();
          if (!intent) {
            throw new PermanentError(`「${stepLabel}」這步還沒有內容：請在「重複步驟」設定裡補上這一步要做什麼的白話描述`);
          }
          ctx.log(`「${stepLabel}」還沒有程式碼，先依描述產生一次(會存回節點，之後所有輪次和未來執行直接用)`);
          // 下游介面約束：把「下游程式碼實際怎麼引用這個迴圈的輸出」附給產碼模型——不附的話，
          // 重產的程式碼很容易把輸出欄位取個新名字(實測第三次踩到:上游輸出 agg7Results、
          // 下游讀 incomeChannelData,資料整批被丟掉還全綠)。欄位名是上下游之間的契約,重產不能改名。
          let downstreamHint = "";
          const wfNow = getWorkflow(ctx.workflowId);
          if (wfNow) {
            const reach = new Set<string>([ctx.nodeId]);
            const queue = [ctx.nodeId];
            while (queue.length) {
              const id = queue.shift()!;
              for (const ed of wfNow.edges) if (ed.from === id && !reach.has(ed.to)) { reach.add(ed.to); queue.push(ed.to); }
            }
            reach.delete(ctx.nodeId);
            const excerpts: string[] = [];
            for (const id of reach) {
              const dn = wfNow.nodes.find((n) => n.id === id);
              const codeStr = String(dn?.config.code ?? "");
              const lines = codeStr.split("\n").filter((l) => l.includes(outputKey) || /\.\s*\w*(?:[Dd]ata|[Rr]esults|[Rr]ows|[Ll]ist)\b/.test(l)).slice(0, 8);
              if (lines.length) excerpts.push(`下游「${dn!.label}」的程式碼片段：\n${lines.join("\n")}`);
            }
            if (excerpts.length) {
              downstreamHint = `\n\n【下游介面約束——你輸出的欄位名必須跟下游程式碼引用的完全一致,絕對不要自創新欄位名】\n${excerpts.join("\n")}`;
            }
          }
          const code = await generateCustomCode(
            { ...ctx, nodeId: `${ctx.nodeId}-gen-s${j}`, input: stepInput, log: (m) => ctx.log(`[產生「${stepLabel}」程式碼] ${m}`) },
            intent + downstreamHint,
          );
          step.config = { ...(step.config ?? {}), code }; // 本次執行的所有後續迭代直接用
          persistStepCode(ctx.workflowId, ctx.nodeId, j, code); // 未來的執行直接用
          ctx.log(`「${stepLabel}」程式碼已產生並存回節點`);

          // 跟頂層 custom-code 一樣，空殼生成後要再做一次只讀檢查；生成前的 intent 無法保證
          // 模型實際產出的 code 沒有 fetch／寫檔／瀏覽器 click。
          if (ctx.dryRun && dryRunSkipKind({
            id: `${ctx.nodeId}-i${i}-s${j}`,
            type: step.type,
            label: stepLabel,
            config: step.config,
            position: { x: 0, y: 0 },
          }, false) === "write") {
            ctx.log(`[第${i + 1}項:${itemLabel}／${stepLabel}] 🔒 新產生的程式碼含外部操作，這次已攔住`);
            dryRunSkippedWrites.push({
              nodeLabel: `第 ${i + 1} 項／${stepLabel}`,
              type: step.type,
              config: { intent: step.config.intent ?? "", code: "" },
              input: { ...stepInput },
            });
            continue;
          }
        }

        const stepCtx: NodeContext = {
          ...ctx,
          nodeId: `${ctx.nodeId}-i${i}-s${j}`, // 除錯截圖/紀錄要有獨立路徑，不能跟其他迭代/步驟共用同一個 nodeId
          input: stepInput,
          config: resolveDatesInConfig(withSchemaDefaults(step.config ?? {}, def.configSchema), now),
          log: (msg: string) => ctx.log(`[第${i + 1}項:${itemLabel}／${stepLabel}] ${msg}`),
        };

        // 步驟層級的重試：迴圈內的步驟不是引擎眼中的節點,拿不到引擎那層的自動重試——沒有這段的話,
        // 第 3 項的一次暫時性失敗(如網頁搜尋框剛好還沒渲染出來)會炸掉整個節點,引擎重試又從第 1 項
        // 全部重跑(前面成功的白做)。比照引擎語意:PermanentError 不重試,其餘依節點宣告重試最多 3 次。
        const maxAttempts = def.retryable ? 3 : 1;
        let result;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (attempt > 1) {
            ctx.log(`[第${i + 1}項:${itemLabel}／${stepLabel}] 第 ${attempt} 次重試這一步(前面已完成的項目不用重跑)`);
            await new Promise((r) => setTimeout(r, 2000 * (attempt - 1)));
          }
          try {
            result = await def.execute(stepCtx);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (err instanceof PermanentError) throw new PermanentError(`第 ${i + 1} 項(${itemLabel})的「${stepLabel}」這步失敗：${err.message}`);
            if (ctx.cancelSignal.aborted) break; // 使用者按了停止,別再重試
          }
        }
        if (lastErr || !result) {
          const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
          // 這一輪處理的檔案路徑要進錯誤訊息——修復迴圈靠它找到實際檔案、附上內容節錄給模型看
          // (loop 失敗時整個節點沒有 output_json,錯誤訊息是修復端唯一能撈到路徑的地方)
          const filePath = Object.values(stepInput).find((v) => typeof v === "string" && /\.(xlsx|xls|csv|pdf)$/i.test(v));
          const fileNote = filePath ? `（這一輪處理的檔案：${filePath}）` : "";
          throw new Error(`第 ${i + 1} 項(${itemLabel})的「${stepLabel}」這步試了 ${maxAttempts} 次仍失敗：${msg}${fileNote}`);
        }
        stepInput = { ...stepInput, ...result.output };
      }
      results.push(stepInput);
      ctx.log(`── 第 ${i + 1}/${items.length} 項(${itemLabel})完成 ──`);
    }

    return {
      output: {
        ...ctx.input,
        [outputKey]: results,
        ...(ctx.dryRun && dryRunSkippedWrites.length
          ? { [DRY_RUN_SKIPPED_WRITES_KEY]: dryRunSkippedWrites }
          : {}),
      },
    };
  },
};
