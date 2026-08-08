import type { ParamField, NodeDefinition } from "./types";

/**
 * 每節點失敗策略的保留設定鍵(2026-08)：`retryTimes`(這一步重試幾次)與 `continueOnFail`
 * (這一步失敗也繼續往下跑)。
 *
 * 這兩個鍵**不屬於任何一種節點型別**——它們是引擎層的策略，每種節點都適用。所以它們不會寫進
 * 各節點的 configSchema(否則 36 種節點的建圖 prompt 都要多背兩個參數)，而是集中放在這裡。
 *
 * 為什麼需要這個檔案:全站有六處「把 config 過濾成只剩該型別 schema 有的 key」的程式碼
 * (存節點設定、AI 改節點、整圖修復、對話改流程…)。保留鍵不在任何 schema 裡，所以使用者設好的
 * 「失敗也繼續」只要 AI 再碰一次那個節點就會被靜默洗掉，而畫面上完全看不出來。凡是要過濾
 * config 的地方一律用 `allowedConfigKeys(def)` 取允許清單，不要自己 map configSchema。
 */

/** 保留鍵集合——只有這兩個，加第三個要同步 NodePanel 的「這一步失敗時」區塊。 */
export const POLICY_CONFIG_KEYS = ["retryTimes", "continueOnFail"] as const;

const POLICY_KEY_SET: ReadonlySet<string> = new Set(POLICY_CONFIG_KEYS);

export function isPolicyConfigKey(key: string): boolean {
  return POLICY_KEY_SET.has(key);
}

/** 過濾 config 時的允許清單：節點型別自己的欄位 + 引擎層保留鍵。 */
export function allowedConfigKeys(def: Pick<NodeDefinition, "configSchema">): Set<string> {
  const keys = new Set(def.configSchema.map((f) => f.key));
  for (const k of POLICY_CONFIG_KEYS) keys.add(k);
  return keys;
}

/**
 * 設定面板用的欄位定義。刻意用白話描述「這一步」而不是「節點」，也刻意不提供「不限次數」——
 * 重試不是免費的，盲目重跑不會讓錯的設定變對(那是修復迴圈的工作)。上限仍由節點自己宣告的
 * `maxAttempts` 決定：填 3 但節點說只能跑一次，引擎照樣只跑一次(見 engine.ts 的 ceiling)。
 */
export const POLICY_FIELDS: ParamField[] = [
  {
    key: "retryTimes",
    label: "這一步失敗時重試幾次",
    type: "select",
    default: "",
    allowEmpty: true,
    options: ["1=不重試(失敗就停)", "2=重試 1 次", "3=重試 2 次"],
    help: "只對「重跑有機會變好」的步驟有效(網路中斷、對方伺服器忙)。寄信、寫試算表這種做了就收不回來的步驟，不管填幾次都只會做一次。",
  },
  {
    key: "continueOnFail",
    label: "這一步失敗也繼續往下跑",
    type: "boolean",
    default: "false",
    help: "適合「抓不到就算了，別讓整份報表卡住」的非關鍵步驟。錯誤會放進 {{error}}，這一步照樣標紅，執行結果也會寫明它沒做完。",
  },
];

/** config 裡的 continueOnFail 是不是被打開了(存進 json 可能是布林或字串)。 */
export function continueOnFailEnabled(config: Record<string, unknown> | undefined): boolean {
  const v = config?.continueOnFail;
  return v === true || v === "true";
}
