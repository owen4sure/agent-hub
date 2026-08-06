import crypto from "node:crypto";
import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { getWorkflow } from "../store";
import { getDb } from "../../db";
import { recordAudit } from "../../auditLog";
import { scanSecretKeys } from "../secretScan";
import { generateCustomCode, isPlaceholderCode, PLACEHOLDER_CODE } from "../codegen";
import { customCodeIsUnsafeForDryRun, DRY_RUN_SKIPPED_WRITES_KEY } from "../dryRun";
import { executeCustomCodeInProcessSandbox } from "../customCodeProcessSandbox";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;

/** 稽核用的程式碼指紋：同一段程式碼永遠同一個代號,執行紀錄能回答「那天跑的是哪個版本」。 */
export function codeFingerprint(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex").slice(0, 12);
}

/** 用到瀏覽器(ctx.session)的程式碼需要真的 Playwright Page,留在主行程執行(見 execute 內註解)。 */
function usesBrowserSession(code: string): boolean {
  return /ctx\s*\.\s*session/.test(code);
}

function runTriggerType(runId: string): string {
  try {
    const row = getDb().prepare(`SELECT trigger_type FROM runs WHERE id = ?`).get(runId) as { trigger_type: string } | undefined;
    return row?.trigger_type ?? "";
  } catch {
    return ""; // 查不到(測試環境的假 runId)就當手動,不因稽核查詢擋住執行
  }
}

/**
 * 逃生口：庫裡沒有的特殊需求，AI 依白話寫這段程式碼(使用者永遠不看)。
 * 契約：config.code 是一段 async 函式主體，收到 ctx(同 NodeContext)，回傳 output 物件。
 * 例：`const page = await ctx.session.getPage(); await page.goto(ctx.config.url); return { title: await page.title() };`
 * 正式執行時在同一個行程內執行 → 可共用瀏覽器 session 等資源；只讀安全試跑則改用
 * 受限 VM 與唯讀瀏覽器能力，不能把「只測試」繞成外送、點擊或本機寫入。
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
      // 確認凍結：排程/自動觸發的執行**不做**臨場產碼——沒有任何人看過的新程式碼,
      // 只能在有人在場的手動執行第一次跑(跑過之後程式碼就凍結在節點上,排程執行的
      // 永遠是凍結版,每次執行都記指紋)。沒有這條的話,「半夜排程自己生了一段新程式
      // 碼並直接執行」在稽核上完全講不過去。
      const trigger = runTriggerType(ctx.runId);
      if (trigger && trigger !== "manual") {
        throw new PermanentError(
          "這個自訂步驟還沒有程式碼,而這次是排程/自動觸發的執行——自動執行不會臨場產生新程式碼(產生的程式碼必須先在手動執行時跑過一次)。請先手動執行一次這條流程,確認結果沒問題後,排程就會正常運作",
        );
      }
      ctx.log("這個自訂步驟還沒有程式碼，先依描述自動產生(只有第一次執行需要，之後會直接用)");
      code = await generateCustomCode(ctx, intent);
      recordAudit({
        actor: "system",
        action: "custom-code.generate",
        target: `${ctx.workflowId}:${ctx.nodeId}`,
        detail: { fingerprint: codeFingerprint(code), intent: intent.slice(0, 200) },
        source: "run",
      });
      ctx.log(`程式碼已產生並存進節點(指紋 ${codeFingerprint(code)})`);
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

    let result: unknown;
    if (ctx.dryRun) {
      try {
        const sandboxResult = await executeCustomCodeInProcessSandbox(ctx, code);
        if (sandboxResult.permissionMode === "vm-fallback") {
          ctx.log("⚠️ 目前 Node 不支援作業系統權限隔離；已降級為獨立子程序 VM，只讀結果不可視為完整 OS 隔離");
        }
        result = sandboxResult.value;
      } catch (err) {
        if (err instanceof PermanentError) throw err;
        // 這段程式碼是 AI 自動寫的、使用者從不會看(見上方檔案註解)——訊息白話在前，
        // 讓「讓 AI 修」看得懂該修什麼是次要目的,原句留在後面給修復迴圈當燃料(2026-08 UI/UX 審計 G2)。
        throw new PermanentError(`這一步的自訂程式碼執行時出錯了，需要讓 AI 重新產生。（技術細節：${err instanceof Error ? err.message : String(err)}）`);
      }
    } else {
      // 語法先在主行程驗一次:語法錯誤要分類成「重新產生就能修」的 PermanentError,
      // 不能混在子程序的一般執行錯誤裡(訊息會少掉「需要讓 AI 重新產生」這個明確下一步)。
      let fn: (ctx: unknown) => Promise<unknown>;
      try {
        fn = new AsyncFunction("ctx", code);
      } catch (err) {
        throw new PermanentError(`這一步的自訂程式碼有語法問題，需要讓 AI 重新產生。（技術細節：${err instanceof Error ? err.message : String(err)}）`);
      }
      if (usesBrowserSession(code)) {
        // 用到瀏覽器的程式碼需要真的 Playwright Page(RPC 代理的保真度撐不起點擊/評值的全部行為),
        // 留在主行程執行。執行紀錄明確標示,這是 SECURITY.md 寫明的殘餘風險,不假裝有隔離。
        ctx.log(`執行程式碼(版本 ${codeFingerprint(code)},含瀏覽器操作,於主行程執行)`);
        result = await fn(ctx);
      } else {
        // 其他一律進子程序沙箱:拿不到平台行程的環境變數(模型金鑰等),檔案系統只開放
        // 這次執行的輸入檔與產出目錄。fetch/exceljs 在子程序是同一套 runtime,語意不變。
        ctx.log(`執行程式碼(版本 ${codeFingerprint(code)},沙箱)`);
        const sandboxed = await executeCustomCodeInProcessSandbox(ctx, code, { mode: "production" });
        if (sandboxed.permissionMode === "vm-fallback") {
          ctx.log("⚠️ 目前 Node 不支援作業系統權限隔離；仍在獨立子程序執行(環境變數已隔離)");
        }
        result = sandboxed.value;
      }
    }
    // 裸陣列絕不能當 output：物件展開會把它變成 {"0":…,"1":…} 這種索引鍵垃圾,下游引用欄位名永遠讀不到、
    // 流程還全綠(實測踩過:模型產的擷取程式碼 return [record],彙整步驟讀 incomeChannelData 恆空)。
    // 老實報錯讓修復迴圈有具體燃料,不准靜默把資料弄丟。
    if (Array.isArray(result)) {
      throw new PermanentError(
        "這一步算出來的資料格式不對，需要讓 AI 重新產生。（技術細節：自訂程式碼回傳了陣列，應改成回傳物件並把陣列放進具名欄位，例如 return { ...ctx.input, 結果清單: 陣列 }，下游才能用 {{結果清單}} 引用）",
      );
    }
    const output = result && typeof result === "object" ? (result as Record<string, unknown>) : { result };
    return { output };
  },
};
