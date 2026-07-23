import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { getWorkflow } from "../store";
import { scanSecretKeys } from "../secretScan";
import { generateCustomCode, isPlaceholderCode, PLACEHOLDER_CODE } from "../codegen";
import { customCodeIsUnsafeForDryRun, DRY_RUN_SKIPPED_WRITES_KEY } from "../dryRun";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;

/**
 * 逃生口：庫裡沒有的特殊需求，AI 依白話寫這段程式碼(使用者永遠不看)。
 * 契約：config.code 是一段 async 函式主體，收到 ctx(同 NodeContext)，回傳 output 物件。
 * 例：`const page = await ctx.session.getPage(); await page.goto(ctx.config.url); return { title: await page.title() };`
 * 在同一個行程內執行 → 可共用瀏覽器 session 等資源。
 *
 * AI 建流程圖時通常只寫 intent(白話描述)、code 是預設空殼——第一次執行走到這裡時，
 * 自動依 intent 產生實際程式碼並存回節點(下次直接用)。不能讓空殼默默跑過去：
 * 空殼「表面成功、實際什麼都沒做」，下游拿到原樣資料，整條流程假成功(踩過的真實 bug)。
 */
export const customCodeNode: NodeDefinition = {
  type: "custom-code",
  category: "custom",
  label: "自訂步驟(AI 寫)",
  description:
    "當現有的節點都無法滿足需求時，由 AI 依你的白話描述寫一段自訂程式碼來完成這一步。你不需要看或懂程式碼；如果出錯，讓 AI 再修就好。",
  icon: "⚙️",
  outputs: "依 intent 決定(程式碼 return 的具名欄位會傳給下游)",
  configSchema: [
    { key: "intent", label: "這個節點要做什麼(白話)", type: "textarea", default: "" },
    { key: "code", label: "程式碼(AI 產生，勿手動改)", type: "code", default: PLACEHOLDER_CODE },
  ],
  // custom-code 的帳密需求藏在 intent/程式碼文字裡(ctx.secrets.googleAccount 這種)，跟其他節點
  // 不同、沒有固定欄位可宣告——不掃出來的話 requiresSecrets 推導不到，設定頁永遠長不出輸入框，
  // 使用者「登入失敗要填密碼」卻根本沒有地方填(踩過:Google 登入的自訂步驟)。
  secretFields(config) {
    return scanSecretKeys(`${String(config.intent ?? "")}\n${String(config.code ?? "")}`);
  },
  // 自訂程式碼若 selector/邏輯寫錯，原樣重跑不會變好，反而可能連續等 3 次 30 秒。
  // 外部暫時錯誤應由程式碼自己明確重試；節點失敗後交給整圖修復，避免盲目燒時間。
  retryable: false,
  // 這一步正常的 Excel/資料計算應在數秒完成；若是在第一次臨時產碼或壞掉的程式卡住，
  // 等 3 分鐘再等同一段重跑沒有價值。90 秒後立即留下真實錯誤，讓「讓 AI 修」重產／修正程式。
  timeoutMs: 90_000,
  async execute(ctx) {
    // 一定要讀「磁碟上最新版」的 code，不能只看 ctx.config——ctx.config 是節點開跑當下的快照，
    // 重試時還是舊的：第一次嘗試若剛自動產生過程式碼(已存回磁碟)，用快照會誤判「還是空殼」，
    // 每次重試都再花幾分鐘重新產一次，整個節點看起來像卡住(踩過的真實 bug：一步跑了 8 分鐘)。
    const freshNode = getWorkflow(ctx.workflowId)?.nodes.find((n) => n.id === ctx.nodeId);
    let code = String((freshNode?.config.code ?? ctx.config.code) ?? "");
    const intent = String(ctx.config.intent ?? "").trim();

    if (isPlaceholderCode(code)) {
      if (!intent) {
        // 既沒程式碼也沒描述——執行它毫無意義，老實報錯，別假成功
        throw new PermanentError(
          "這個自訂步驟還沒有內容：請點這個節點，用白話描述它要做什麼，或按「讓 AI 修」讓 AI 補上",
        );
      }
      ctx.log("這個自訂步驟還沒有程式碼，先依描述自動產生(只有第一次執行需要，之後會直接用)");
      code = await generateCustomCode(ctx, intent);
      ctx.log("程式碼已產生並存進節點");
    }

    // 引擎在進節點前已檢查既有 code，但空殼是在這裡才生成；生成後一定要再檢查一次。
    // 否則「試跑前看起來是純讀 intent，模型卻產出寫檔/POST」會直接繞過只讀保護。
    if (ctx.dryRun && customCodeIsUnsafeForDryRun({ intent, code })) {
      ctx.log("🔒 只讀驗證：AI 產生的程式碼含外部操作，這次已攔住、不會真的執行");
      return {
        output: {
          ...ctx.input,
          [DRY_RUN_SKIPPED_WRITES_KEY]: [{
            nodeLabel: "自訂步驟",
            type: "custom-code",
            config: { intent, code: "" },
            input: { ...ctx.input },
          }],
        },
      };
    }

    let fn: (ctx: unknown) => Promise<unknown>;
    try {
      fn = new AsyncFunction("ctx", code);
    } catch (err) {
      throw new PermanentError(`自訂程式碼語法錯誤：${err instanceof Error ? err.message : String(err)}`);
    }
    const result = await fn(ctx);
    // 裸陣列絕不能當 output：物件展開會把它變成 {"0":…,"1":…} 這種索引鍵垃圾,下游引用欄位名永遠讀不到、
    // 流程還全綠(實測踩過:模型產的擷取程式碼 return [record],彙整步驟讀 incomeChannelData 恆空)。
    // 老實報錯讓修復迴圈有具體燃料,不准靜默把資料弄丟。
    if (Array.isArray(result)) {
      throw new PermanentError(
        "自訂程式碼回傳了陣列——請改成回傳物件並把陣列放進具名欄位,例如 return { ...ctx.input, 結果清單: 陣列 }(下游才能用 {{結果清單}} 引用)",
      );
    }
    const output = result && typeof result === "object" ? (result as Record<string, unknown>) : { result };
    return { output };
  },
};
