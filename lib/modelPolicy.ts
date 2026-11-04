/**
 * 「這一次該用哪顆模型」的**唯一**決定點。
 *
 * ## 為什麼要有這一支
 *
 * 以前這件事散在四個地方各自決定，而且每一處最後都寫著 `?? VISION_MODELS[0]`——
 * 一份寫死在 `lib/models.ts` 的清單，內容是「開發這個專案時用的那一個免費 gateway
 * 實測可用的模型」。對開發者本人沒問題，對其他人是三層錯誤：
 *
 * 1. **假設大家都有那個 gateway**。只裝了 Claude Code 的人，做一個需要辨識驗證碼的流程，
 *    會退到那份清單的第一名——一個他根本沒有的服務——然後拿到「金鑰不對」。真正的原因
 *    (「你手上沒有任何能解驗證碼的模型」)完全沒被講出來。
 * 2. **認不得使用者自己接的模型**。`supportsVision()` 只認那份清單，所以就算某個地端模型
 *    已經在設定頁實測過看圖 26/26 全對，平台仍判定它「不會看圖」然後繞開它。
 * 3. **順序是平台幫使用者決定的**。哪顆當主力、哪顆當救援，使用者無從介入。
 *
 * ## 現在的規則
 *
 * - **有哪些模型可用** → 從實際設定推導(內建 gateway 只在真的填了網址+金鑰時才算數；
 *   Claude Code 只在真的裝了才算數；自訂來源照使用者加的)。不查表。
 * - **每顆模型會什麼** → 以實測結果為準(`modelSupportsVision` 實測優先)。沒測過就是沒測過。
 * - **主力/救援的順序** → 使用者在設定頁自己排(`ModelPreference`)。沒排過才用下面的
 *   `autoOrder` 預填，而且那個預填只是「拖曳前的初始值」，不是平台的定見。
 * - **挑不到就回空的鏈**，附上白話原因。**絕不退回一個寫死的名字**——那正是上面三個問題的根源。
 */

import { isClaudeCodeModel, CLAUDE_CODE_MODEL } from "./claudeCodeShared";
import { isClaudeCodeAvailable } from "./claudeCodeClient";
import { VISION_MODELS } from "./models";
import {
  listModelChoices,
  modelSupportsVision,
  resolveModel,
  REF_SEPARATOR,
  type ModelChoice,
} from "./modelProviders";
import { getDb } from "./db";

/** 這次的呼叫需要什麼能力。captcha 是 vision 的子集(多一條「不能是會拒絕解驗證碼的模型」)。 */
export type ModelNeed = "text" | "vision" | "captcha";

export interface ModelPick {
  /** 拿去 resolveModel 的字串 */
  ref: string;
  /** 真正送給 API 的模型代號 */
  model: string;
  providerId: string;
  providerLabel: string;
  /** 使用者宣告「這個來源在我自己掌控的機器上」 */
  local: boolean;
  /** 這個能力是不是真的實測過(沒測過≠不能用，但要跟使用者講清楚) */
  tested: boolean;
}

export interface ModelPlan {
  /** 依序要試的模型。第一個是主力，後面是救援。strict=true 時只會有一個。 */
  chain: ModelPick[];
  /** 只用第一個，做不到就停下來報錯 */
  strict: boolean;
  /** 這條鏈是怎麼決定的——執行紀錄要寫出來，使用者才不會「不知道為什麼用這顆」 */
  source: "node" | "workflow" | "preference" | "auto";
  /** chain 空的時候，為什麼挑不到(白話，可直接給使用者看) */
  reason?: string;
}

/* ── 使用者的偏好順序 ─────────────────────────────────────── */

export interface ModelPreference {
  /** 文字任務的順序(第一個=主力) */
  text: string[];
  /** 看圖任務的順序 */
  vision: string[];
  /** 全域預設：做不到就停，不自動換 */
  strict: boolean;
}

const PREFERENCE_KEY = "modelPreference";

export function getModelPreference(): ModelPreference {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(PREFERENCE_KEY) as { value: string } | undefined;
  try {
    const parsed = JSON.parse(row?.value ?? "{}") as Partial<ModelPreference>;
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [];
    return { text: list(parsed.text), vision: list(parsed.vision), strict: parsed.strict === true };
  } catch {
    return { text: [], vision: [], strict: false };
  }
}

export function setModelPreference(input: Partial<ModelPreference>): ModelPreference {
  const current = getModelPreference();
  const next: ModelPreference = {
    text: input.text ? input.text.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : current.text,
    vision: input.vision ? input.vision.map((s) => String(s).trim()).filter(Boolean).slice(0, 20) : current.vision,
    strict: input.strict === undefined ? current.strict : input.strict === true,
  };
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(PREFERENCE_KEY, JSON.stringify(next));
  return next;
}

/* ── 可用性與能力(全部靠推導，不查寫死清單) ─────────────────── */

/**
 * 這個模型現在真的叫得動嗎。
 *
 * Claude Code 要單獨判斷:它掛在內建來源的模型清單裡，但它跟那組 Base URL / API Key
 * 一點關係都沒有(走本機 CLI)。不特判的話，一個「只裝 Claude Code、沒填任何金鑰」的人
 * 會連 Claude Code 都被判成不可用——正好是最該支援的那種使用者。
 */
function modelUsable(choice: ModelChoice, claudeAvailable: boolean): boolean {
  if (isClaudeCodeModel(choice.model)) return claudeAvailable;
  const { provider } = resolveModel(choice.ref);
  // 內建那組要「網址+金鑰」都有才算數(全新安裝兩格都是空的，那些模型代號叫不動，
  // 列出來只會讓人選了才發現不能用)。自訂來源有網址就算數(地端模型常常不用金鑰)。
  return provider.builtin ? Boolean(provider.baseUrl && provider.apiKey) : Boolean(provider.baseUrl);
}

function hasCapability(choice: ModelChoice, need: ModelNeed): boolean {
  if (need === "text") return true;
  if (!modelSupportsVision(choice.ref)) return false;
  // 驗證碼：Claude 即使看得懂圖也會基於安全政策主動拒絕，而且那個拒絕是「成功」回應，
  // 重試不會變好(AGENTS.md 鐵則)。這不是寫死某個模型名字，是排除一個已知的能力缺口。
  if (need === "captcha" && isClaudeCodeModel(choice.model)) return false;
  return true;
}

function toPick(choice: ModelChoice, need: ModelNeed): ModelPick {
  const { provider } = resolveModel(choice.ref);
  return {
    ref: choice.ref,
    model: choice.model,
    providerId: choice.providerId,
    providerLabel: choice.providerLabel,
    local: provider.local === true,
    tested: need === "text" ? choice.verified : choice.visionTested === "yes",
  };
}

/** 目前這台機器上，具備某個能力而且真的叫得動的模型。 */
export async function listUsableModels(need: ModelNeed = "text"): Promise<ModelPick[]> {
  const claudeAvailable = await isClaudeCodeAvailable();
  return listModelChoices()
    .filter((c) => modelUsable(c, claudeAvailable) && hasCapability(c, need))
    .map((c) => toPick(c, need));
}

/**
 * 使用者還沒排過順序時的預填順序。
 *
 * **這只是拖曳前的初始值，不是平台的定見**——設定頁會把這個順序顯示出來讓使用者直接改。
 * 排序依據刻意全部是「可觀察的事實」，不是模型名字：
 *   ① 實測過該能力的排前面(沒測過的不知道行不行，不該當主力)
 *   ② 地端排前面(便宜、快、資料不出機器；使用者不要的話拖走就好)
 *   ③ 內建來源之間沿用 VISION_MODELS 既有的實測可靠度順序——那份清單對「有接內建
 *      gateway 的人」仍然是真實的實測資訊，只是不再假設所有人都有它
 */
function autoOrder(picks: ModelPick[]): ModelPick[] {
  const builtinVisionRank = (p: ModelPick): number => {
    const i = (VISION_MODELS as readonly string[]).indexOf(p.model);
    return i >= 0 ? i : VISION_MODELS.length;
  };
  return [...picks].sort((a, b) => {
    if (a.tested !== b.tested) return a.tested ? -1 : 1;
    if (a.local !== b.local) return a.local ? -1 : 1;
    const rank = builtinVisionRank(a) - builtinVisionRank(b);
    if (rank !== 0) return rank;
    return a.ref.localeCompare(b.ref);
  });
}

/* ── 主入口 ──────────────────────────────────────────────── */

export interface PlanOptions {
  need: ModelNeed;
  /** 這一步自己指定的模型(節點設定的 model 欄位)——指定了就獨佔，不排救援 */
  nodeOverride?: string;
  /** 這條流程指定的執行模型 */
  workflowRunModel?: string;
  /** 這條流程的「不要自動換」開關 */
  workflowStrict?: boolean;
  /** 流程層選的模型(既有的 ctx.model)——沒有更明確的指定時，它仍是最合理的第一順位 */
  fallbackModel?: string;
}

export async function planModelChain(opts: PlanOptions): Promise<ModelPlan> {
  const { need } = opts;
  const claudeAvailable = await isClaudeCodeAvailable();
  const all = listModelChoices();
  const usable = all.filter((c) => modelUsable(c, claudeAvailable));
  const capable = usable.filter((c) => hasCapability(c, need));
  const preference = getModelPreference();
  const strict = opts.workflowStrict === true || preference.strict;

  const byRef = new Map(capable.map((c) => [c.ref, c] as const));
  /**
   * 用純模型代號找，**只在全平台唯一時才算數**。
   *
   * 同名模型同時存在兩個來源時絕不可以隨便挑一個：使用者把某一步釘在地端模型上，
   * 那個來源被刪掉之後，如果共用 gateway 剛好也有同名模型，「順手挑一個」就等於
   * 把業務資料靜默送去另一個端點、還換了一顆模型做判斷，執行紀錄完全看不出來。
   * 寧可回 undefined 讓上層老實報「找不到」。
   */
  const find = (ref: string): ModelChoice | undefined => {
    const direct = byRef.get(ref);
    if (direct) return direct;
    const sameName = capable.filter((c) => c.model === ref);
    return sameName.length === 1 ? sameName[0] : undefined;
  };

  /** 明確指定(節點層/流程層)：指定了就只用它。找不到要講清楚是「不存在」還是「做不到這件事」。 */
  const pinned = (ref: string, source: "node" | "workflow"): ModelPlan => {
    const hit = find(ref);
    if (hit) return { chain: [toPick(hit, need)], strict: true, source };
    const existsButCannot = usable.some((c) => c.ref === ref || c.model === ref);
    const existsButUnusable = all.some((c) => c.ref === ref || c.model === ref);
    const where = source === "node" ? "這一步" : "這條流程";
    if (existsButCannot) {
      return {
        chain: [], strict: true, source,
        reason: `${where}指定用「${ref}」，但它${need === "text" ? "目前不可用" : "沒有辦法看圖"}。`
          + (need === "captcha" ? "（辨識驗證碼需要看得懂圖片、而且不會拒絕解驗證碼的模型）" : ""),
      };
    }
    return {
      chain: [], strict: true, source,
      reason: existsButUnusable
        ? `${where}指定用「${ref}」，但它所屬的來源現在叫不動（多半是網址或金鑰沒填）。`
        : `${where}指定用「${ref}」，但找不到這個模型（多半是那個模型來源被刪掉或改名了）。`,
    };
  };

  if (opts.nodeOverride?.trim()) return pinned(opts.nodeOverride.trim(), "node");
  if (opts.workflowRunModel?.trim()) return pinned(opts.workflowRunModel.trim(), "workflow");

  // 使用者排過的順序優先；排在清單裡但現在不可用/沒有這個能力的自動略過(不是錯誤，
  // 例如他排了三顆但今天只開著兩顆)。
  const ordered = preference[need === "text" ? "text" : "vision"];
  const fromPreference = ordered.map(find).filter((c): c is ModelChoice => Boolean(c));

  let chain: ModelChoice[];
  let source: ModelPlan["source"];
  if (fromPreference.length > 0) {
    chain = fromPreference;
    source = "preference";
  } else {
    chain = autoOrder(capable.map((c) => toPick(c, need))).map((p) => byRef.get(p.ref)!).filter(Boolean);
    source = "auto";
    // 流程層本來就選了一顆而且它做得到這件事，那它才是最貼近使用者當下意圖的第一順位。
    const head = opts.fallbackModel ? find(opts.fallbackModel) : undefined;
    if (head) chain = [head, ...chain.filter((c) => c.ref !== head.ref)];
  }

  const picks = chain.map((c) => toPick(c, need));
  if (picks.length === 0) {
    return { chain: [], strict, source, reason: noCapableModelReason(need, usable.length, claudeAvailable) };
  }
  return { chain: strict ? picks.slice(0, 1) : picks, strict, source };
}

/** 一顆都挑不到時的白話說明——這是使用者唯一會看到的線索，不能只說「沒有可用的模型」。 */
function noCapableModelReason(need: ModelNeed, usableCount: number, claudeAvailable: boolean): string {
  if (usableCount === 0) {
    return claudeAvailable
      ? "目前沒有可用的模型。請到「設定 → 模型來源」填入 Base URL 與金鑰，或新增一個自己的模型來源。"
      : "目前沒有可用的模型，這台機器上也沒有裝 Claude Code。請到「設定 → 模型來源」新增一個模型來源。";
  }
  if (need === "captcha") {
    return "這一步需要辨識圖片驗證碼，但目前接的模型都做不到"
      + (claudeAvailable ? "（Claude Code 看得懂圖，但會基於安全政策拒絕解驗證碼）" : "")
      + "。你可以到「設定 → 模型來源」接一顆看得懂圖的模型並按「測試看圖」，或改用流程頁「⋯ → 🔐 手動登入一次」避開驗證碼。";
  }
  if (need === "vision") {
    return "這一步需要看得懂圖片的模型，但目前接的模型都沒有通過看圖實測。"
      + "請到「設定 → 模型來源」按模型旁邊的「測試看圖」確認能力，或接一顆看得懂圖的模型。";
  }
  return "目前沒有可用的模型。";
}

/* ── 顯示 ────────────────────────────────────────────────── */

/**
 * 給執行紀錄與畫面用的模型標示。
 *
 * 使用者的原話是「正在用哪個模型都要明確顯示出來」——因為他要拿執行紀錄去給公司審查看
 * 「資料到底有沒有離開這台機器」。所以地端/雲端一定要標出來，只寫模型名字不夠。
 */
export function describeModelPick(pick: ModelPick): string {
  return `${pick.ref}（${pick.local ? "🏠 地端" : "☁️ 雲端"}）`;
}

/** 節點面板「這一步會用哪顆」的預覽字串。挑不到時直接回原因，不要顯示一個假的名字。 */
export function describeModelPlan(plan: ModelPlan): string {
  if (plan.chain.length === 0) return plan.reason ?? "挑不到可用的模型";
  const head = describeModelPick(plan.chain[0]);
  if (plan.strict) return `${head}；做不到就停下來，不會自動換`;
  const rest = plan.chain.slice(1, 3).map((p) => p.ref);
  return rest.length > 0 ? `${head}，做不到時依序改用 ${rest.join("、")}` : head;
}

/**
 * 一條流程「跑起來會用哪些模型」的白話摘要（文字判斷／看圖／驗證碼各一句）。
 *
 * 執行紀錄是事後的證據；這個是**跑之前**就能確認的預覽——要做資料落地確認的人，
 * 需要的正是「還沒送出去以前就知道會送去哪」。
 */
export async function describeWorkflowModelPlan(
  workflowId: string,
  fallbackModel: string,
): Promise<{ text: string; vision: string; captcha: string }> {
  const { getWorkflowModelPolicy } = await import("./settingsStore");
  const policy = getWorkflowModelPolicy(workflowId);
  const base = { workflowRunModel: policy.runModel, workflowStrict: policy.strict, fallbackModel };
  const [text, vision, captcha] = await Promise.all([
    planModelChain({ ...base, need: "text" }),
    planModelChain({ ...base, need: "vision" }),
    planModelChain({ ...base, need: "captcha" }),
  ]);
  return { text: describeModelPlan(text), vision: describeModelPlan(vision), captcha: describeModelPlan(captcha) };
}

/** 「來源被刪掉/改名了就停下來」——節點層釘選的模型不可以靜默退回別的端點。 */
export function pinnedModelSourceGone(ref: string): boolean {
  const namedProviderId = ref.includes(REF_SEPARATOR) ? ref.split(REF_SEPARATOR)[0] : "";
  const resolved = resolveModel(ref);
  return namedProviderId
    ? resolved.provider.id !== namedProviderId
    : !resolved.provider.models.includes(resolved.model);
}

export { CLAUDE_CODE_MODEL };
