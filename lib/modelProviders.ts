/**
 * 模型來源（可以有很多個，不再只有一組 Base URL）。
 *
 * 為什麼需要(使用者原話)：「我現在多了一個地端的 gemma4 模型可以用，我從別台電腦用 n8n 串出來的…
 * 你現在寫死成那樣那我有 gemma4 的就會變成不能用」。
 *
 * 診斷後真正的瓶頸不是「模型名稱寫死」——自訂模型名稱本來就填得進去；
 * **是整個平台只有一組 `baseUrl` / `apiKey`**。他的 gemma4 在另一台機器上，
 * 換過去就等於放棄現有 gateway 的所有模型，反過來也一樣。所以要能同時存在多組來源。
 *
 * ## 設計
 *
 * - **內建那一組不搬家**：`default` 這個來源永遠是現有的全域 baseUrl/apiKey(設定頁那兩格)，
 *   不做資料遷移。既有流程存的模型名稱原封不動繼續有效，一行都不用改。
 * - **模型代號直接寫就好**：`gemma4` 這樣寫就行，平台會在所有來源裡找。
 *   只有同名撞到兩個來源時才需要寫成 `來源::模型`。使用者不該為了平台的內部結構學新語法。
 * - **能力由使用者宣告，不由平台寫死**：「這個模型看得懂圖片嗎」以前是硬編碼清單
 *   (VISION_MODELS)，外面的模型永遠不可能進到那份清單。現在自訂來源可以自己勾。
 * - **「可用」以實測為準**：設定頁測過連線成功的模型會被記下來，UI 的 ✓ 從那裡來，
 *   而不是從一份寫死的 KNOWN_WORKING_MODELS(那份清單換個服務商就不準了)。
 */

import { getDb } from "./db";
import { getGlobalSettings } from "./settingsStore";
import { DEFAULT_MODEL, MODELS, VISION_MODELS } from "./models";
import { CLAUDE_CODE_MODEL } from "./claudeCodeShared";

export const DEFAULT_PROVIDER_ID = "default";
const SETTING_KEY = "modelProviders";
const VERIFIED_KEY = "verifiedModels";
const VISION_VERIFIED_KEY = "visionVerifiedModels";
export const REF_SEPARATOR = "::";
/** 沒特別設定時等多久(跟 modelClient 的預設一致) */
export const DEFAULT_TIMEOUT_MS = 90_000;

export interface ModelProvider {
  id: string;
  label: string;
  baseUrl: string;
  /** 內建那一組不存在這裡(用全域設定)，所以可能是空字串 */
  apiKey: string;
  /** 這個來源有哪些模型可以用 */
  models: string[];
  /** 這個來源的模型看不看得懂圖片(由使用者宣告——平台無法為未知模型硬編碼) */
  vision: boolean;
  /**
   * 這個來源是不是在使用者自己掌控的機器上。
   *
   * **只能由使用者宣告，平台不可以自己猜**：地端模型不一定長得像地端。使用者的 gemma 掛在
   * 一個公開網域後面(自己架的反向代理)，用網址判斷會判成雲端；反過來，一個公司內網網址也
   * 可能其實是轉出去的。這個欄位的用途是執行紀錄上標「🏠 地端／☁️ 雲端」給公司審查看，
   * 猜錯比不標更糟——所以預設 false，使用者自己勾。
   */
  local?: boolean;
  /**
   * 這個來源可以等多久(毫秒)。
   *
   * 為什麼要能調(實測踩到)：預設 90 秒是為雲端 gateway 調的，但地端模型「比較慢但免費無限」——
   * 用同一個逾時會把「正在正常產出一張複雜流程圖」切斷，看起來像模型不會做，其實只是被打斷。
   * 真實數據：本機 gemma4 建簡單流程 17 秒，複雜流程(webhook+分類+簽核)超過 90 秒被砍。
   */
  timeoutMs?: number;
  /** 內建那一組不能刪 */
  builtin?: boolean;
}

function readList(): ModelProvider[] {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is ModelProvider => Boolean(p) && typeof p === "object")
      .map((p) => ({
        id: String(p.id ?? "").trim(),
        label: String(p.label ?? "").trim() || "自訂來源",
        baseUrl: String(p.baseUrl ?? "").trim(),
        apiKey: String(p.apiKey ?? ""),
        models: Array.isArray(p.models) ? p.models.map((m) => String(m).trim()).filter(Boolean) : [],
        vision: p.vision === true,
        local: p.local === true,
        ...(Number.isFinite(p.timeoutMs) ? { timeoutMs: Number(p.timeoutMs) } : {}),
      }))
      .filter((p) => p.id && p.id !== DEFAULT_PROVIDER_ID && p.baseUrl);
  } catch {
    return [];
  }
}

function writeList(list: ModelProvider[]): void {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(SETTING_KEY, JSON.stringify(list.slice(0, 20)));
}

/** 內建來源：永遠指向設定頁那兩格，不做資料遷移(既有設定與流程完全不受影響)。 */
function builtinProvider(): ModelProvider {
  const { baseUrl, apiKey } = getGlobalSettings();
  return {
    id: DEFAULT_PROVIDER_ID,
    label: "內建（設定頁的 Base URL）",
    baseUrl,
    apiKey,
    models: [...MODELS],
    vision: true, // 內建這組的逐一能力仍由 models.ts 的實測清單判斷
    local: false, // 內建那組是共用的雲端服務；Claude Code 走本機 CLI 但資料仍離開這台機器
    builtin: true,
  };
}

export function listProviders(): ModelProvider[] {
  return [builtinProvider(), ...readList()];
}

/**
 * 新流程預設用哪顆模型——**推導出來的，不是寫死的**。
 *
 * `DEFAULT_MODEL` 是「開發這個專案時用的那個免費 gateway 上實測最穩的模型」。對已經填好
 * Base URL / 金鑰的人(例如作者本人)它是對的；對一個剛 clone 下來、只裝了 Claude Code 的人，
 * 那個代號在他的環境裡根本不存在——新流程一建好就預設選了一顆叫不動的模型，
 * 打第一句話就失敗，而且看不出原因。
 *
 * 使用者的原話：「其他人都是只有預設 claude code，然後有其他的代碼就是自己在設定裡面做，
 * 而不是我預設給一堆」。所以：有內建 gateway 就沿用原本的預設(既有使用者行為完全不變)，
 * 沒有就預設 Claude Code。
 */
export function defaultModelRef(): string {
  const { baseUrl, apiKey } = getGlobalSettings();
  return baseUrl && apiKey ? DEFAULT_MODEL : CLAUDE_CODE_MODEL;
}

export function saveProvider(input: Omit<ModelProvider, "builtin">): ModelProvider {
  const id = input.id.trim() || `p${Date.now().toString(36)}`;
  if (id === DEFAULT_PROVIDER_ID) throw new Error("內建來源請直接在上面的 Base URL / API Key 修改");
  const baseUrl = input.baseUrl.trim();
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL 要以 http:// 或 https:// 開頭");
  const models = (input.models ?? []).map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) throw new Error("至少要填一個模型代號（例如 gemma4）");
  const provider: ModelProvider = {
    id,
    label: input.label.trim() || "自訂來源",
    baseUrl,
    apiKey: input.apiKey ?? "",
    models,
    vision: input.vision === true,
    local: input.local === true,
    // 10 秒～10 分鐘：比 10 秒短沒有任何模型來得及回，比 10 分鐘長的話使用者會以為當掉了
    timeoutMs: Math.min(Math.max(Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS, 10_000), 600_000),
  };
  const list = readList().filter((p) => p.id !== id);
  writeList([...list, provider]);
  return provider;
}

export function deleteProvider(id: string): boolean {
  if (id === DEFAULT_PROVIDER_ID) return false;
  const list = readList();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return false;
  writeList(next);
  return true;
}

/**
 * 把一個模型代號解析成「要打哪個端點」。
 *
 * 使用者只要寫 `gemma4`；只有同名模型出現在兩個來源時才需要寫成 `來源::模型`。
 * 找不到就退回內建來源——這樣「使用者自己打了一個平台沒聽過的模型代號」仍然會被送去
 * 內建端點試試看，而不是直接拒絕(這正是原本「寫死清單」最惱人的地方)。
 */
export function resolveModel(ref: string): { provider: ModelProvider; model: string } {
  const providers = listProviders();
  const raw = String(ref ?? "").trim();
  if (raw.includes(REF_SEPARATOR)) {
    const [providerId, ...rest] = raw.split(REF_SEPARATOR);
    const model = rest.join(REF_SEPARATOR);
    const provider = providers.find((p) => p.id === providerId);
    if (provider) return { provider, model };
    return { provider: builtinProvider(), model };
  }
  // 自訂來源優先：使用者特地加進來的東西，比內建清單更可能是他現在要用的。
  const custom = providers.filter((p) => !p.builtin).find((p) => p.models.includes(raw));
  if (custom) return { provider: custom, model: raw };
  return { provider: builtinProvider(), model: raw };
}

/** 給 UI 用：所有來源的模型攤平成一份清單(附來源標籤與是否實測過)。 */
export interface ModelChoice {
  ref: string; model: string; providerId: string; providerLabel: string;
  /** 文字連線實測通過 */ verified: boolean;
  /** 目前判定看不看得懂圖片(實測優先) */ vision: boolean;
  /** 看圖能力是不是「真的測過」——沒測過要在畫面上跟「測過不行」分開講 */ visionTested: "yes" | "no" | null;
}

export function listModelChoices(): ModelChoice[] {
  const verified = getVerifiedModels();
  const visionTested = getVisionVerified();
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  for (const provider of listProviders()) {
    for (const model of provider.models) {
      // 同名模型出現在多個來源時，後面那些要用完整寫法才不會被解析到錯的端點。
      const ref = seen.has(model) ? `${provider.id}${REF_SEPARATOR}${model}` : model;
      seen.add(model);
      out.push({
        ref,
        model,
        providerId: provider.id,
        providerLabel: provider.label,
        verified: verified.includes(ref) || verified.includes(model),
        vision: modelSupportsVision(ref),
        visionTested: visionTested[ref] ?? null,
      });
    }
  }
  return out;
}

/**
 * 「這個模型在這台機器上實測通過」——設定頁按「測試連線」成功就記一筆。
 *
 * 為什麼不用寫死的 KNOWN_WORKING_MODELS：那份清單是在某一個免費 gateway 上實測的結果，
 * 換一個服務商(或使用者自己接地端模型)就完全不準，而 UI 還是會標「✓ 可用」誤導人。
 * 實測過的才標 ✓，才是誠實的。
 */
export function getVerifiedModels(): string[] {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(VERIFIED_KEY) as { value: string } | undefined;
  try {
    const parsed: unknown = JSON.parse(row?.value ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function markModelVerified(ref: string, ok: boolean): void {
  const current = new Set(getVerifiedModels());
  if (ok) current.add(ref);
  else current.delete(ref);
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(VERIFIED_KEY, JSON.stringify([...current].slice(0, 100)));
}

/**
 * 逐個模型記「看圖實測結果」。
 *
 * 為什麼要逐個模型而不是逐個來源：同一個來源(同一台機器、同一個網址)底下常常同時有
 * 看得懂圖跟純文字的模型，用來源層級的一個布林值一定會有一半是錯的。
 * 值是 "yes"/"no"——**沒測過**跟**測過但不行**是兩件事，不能都用「沒有這一筆」表示。
 */
export function getVisionVerified(): Record<string, "yes" | "no"> {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(VISION_VERIFIED_KEY) as { value: string } | undefined;
  try {
    const parsed: unknown = JSON.parse(row?.value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, "yes" | "no"> : {};
  } catch {
    return {};
  }
}

export function markVisionVerified(ref: string, ok: boolean): void {
  const current = getVisionVerified();
  current[ref] = ok ? "yes" : "no";
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(VISION_VERIFIED_KEY, JSON.stringify(current));
}

/**
 * 這個模型看不看得懂圖片。
 *
 * 優先順序刻意是「**實測結果 > 任何預設值**」：實際在這台機器上測過的答案，
 * 永遠比一份寫死的清單或使用者當初隨手勾的核取方塊可信。
 * 沒測過才退回：內建的實測清單 / 自訂來源使用者宣告的值。
 */
export function modelSupportsVision(ref: string): boolean {
  const tested = getVisionVerified()[ref];
  if (tested === "yes") return true;
  if (tested === "no") return false;
  const { provider, model } = resolveModel(ref);
  if (!provider.builtin) return provider.vision;
  return (VISION_MODELS as readonly string[]).includes(model) || model === CLAUDE_CODE_MODEL;
}

/**
 * 需要一個「看得懂圖片」的模型時，挑一個可用的。
 *
 * 這是使用者說的「他應該就是要能夠自己判斷要用啥」的落地方式：不是讓模型自己選，
 * 而是**平台按能力挑**——優先用他指定的那個(如果它看得懂圖)，否則找實測過又宣告有視覺能力的，
 * 最後才退回內建的實測視覺清單。挑不到就老實回 null，由呼叫端說清楚而不是硬送一個看不懂圖的。
 */
export function pickVisionModel(preferred?: string, opts: { excludeClaudeCode?: boolean } = {}): string | null {
  // 驗證碼一定要 excludeClaudeCode：Claude 會基於安全政策**主動拒絕**解驗證碼，
  // 而那個拒絕是 is_error:false 的「成功」回應——重試或換一次都不會變好，
  // 只會白白燒掉一輪重試+退避(AGENTS.md 明令的鐵則，這裡的測試也釘住了)。
  const usable = (ref: string) => !(opts.excludeClaudeCode && resolveModel(ref).model === CLAUDE_CODE_MODEL);
  if (preferred && modelSupportsVision(preferred) && usable(preferred)) return preferred;
  const choices = listModelChoices().filter((c) => c.vision && usable(c.ref));
  // 內建那幾個視覺模型的**順序本身就是資訊**：VISION_MODELS 是依實測可靠度排的
  // (minimax-m3 最穩、Kimi-k2.6 偶爾答非所問)，不能被「攤平成一份清單」的順序洗掉。
  // 所以排序規則是：內建視覺模型照實測可靠度 → 使用者自己接的(實測過的優先)。
  const rank = (c: ModelChoice): number => {
    const builtinIndex = (VISION_MODELS as readonly string[]).indexOf(c.model);
    if (c.providerId === DEFAULT_PROVIDER_ID && builtinIndex >= 0) return builtinIndex;
    return VISION_MODELS.length + (c.verified ? 0 : 1);
  };
  const sorted = [...choices].sort((a, b) => rank(a) - rank(b));
  return sorted[0]?.ref ?? null;
}
