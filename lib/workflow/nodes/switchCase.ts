import type { NodeDefinition } from "../types";
import { PermanentError } from "../types";
import { assertNoUnresolvedVars, cfgStr } from "../nodeHelpers";

/**
 * 多路分流節點：把「請假→走A、報支→走B、其他→走C」這種多路分流做成一個節點，
 * 取代好幾層巢狀 if-condition(圖會醜到看不懂)。引擎的 activePorts/fromPort 機制
 * 本來就支援任意多路(見 engine.ts 分支邏輯)，這裡只是補上會用它的節點。
 *
 * port 名稱 = 分流選項的文字本身(如 "請假")，外加固定的 "其他" 接沒比對到的情況——
 * 下游連線的 fromPort 直接寫選項文字，AI 建圖和人看畫布都直觀(邊上的標籤就是分類名)。
 */

/** 把 cases 設定字串切成選項清單(一行一個；也接受逗號分隔)，去空白去空行 */
export function parseSwitchCases(cases: string): string[] {
  return cases
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 固定的「都沒比對到」出口名 */
export const SWITCH_FALLBACK_PORT = "其他";

/**
 * 決定走哪個出口：完全相等(不分大小寫、去頭尾空白)優先；
 * 沒有就找「值包含選項文字」的唯一命中(上游 AI 偶爾會回「分類:請假」這種包了幾個字的)，
 * 但要防否定反轉(「非請假」不能命中「請假」)——跟 llm-decide 的 matchChoice 同一套顧慮。
 * 都沒有 → 走「其他」。
 */
export function pickSwitchCase(value: string, cases: string[]): string {
  const v = value.trim();
  const exact = cases.find((c) => c.toLowerCase() === v.toLowerCase());
  if (exact) return exact;
  const contained = cases.filter((c) => {
    const idx = v.toLowerCase().indexOf(c.toLowerCase());
    if (idx === -1) return false;
    const before = v.slice(Math.max(0, idx - 4), idx);
    return !/[不非沒未無没]|not\s*$|n't\s*$/i.test(before);
  });
  return contained.length === 1 ? contained[0] : SWITCH_FALLBACK_PORT;
}

export const switchNode: NodeDefinition = {
  type: "switch",
  category: "logic",
  label: "多路分流",
  description:
    "依一個值走不同的路(三條以上的分流)，例如「請假→走A、報支→走B、其他→走C」。比巢狀的條件判斷清楚很多。下游連線的「fromPort」直接寫選項文字(如「請假」)，沒比對到的走「其他」。",
  icon: "🧭",
  outputs: "matched(比對到的選項，沒比對到=其他), switchValue(被分類的原始值)",
  configSchema: [
    { key: "value", label: "要分類的值(可用 {{欄位}})", type: "text", default: "" },
    { key: "cases", label: "分流選項(一行一個)", type: "textarea", default: "" },
  ],
  retryable: false,
  async execute(ctx) {
    const value = cfgStr(ctx, "value");
    // 分類值沒解析到=必然走錯路(會默默落到「其他」把真正的問題蓋掉)，老實失敗並講清楚下一步。
    // 注意:查的是「value」這個設定欄位本身的原始字串，不是上面已經解析完的 value——上游資料
    // 本身若剛好含有字面 "{{...}}" 文字，解析完的值會巧合地符合樣子，但那不是沒解析到。
    assertNoUnresolvedVars(ctx, "value", "分流「要分類的值」");
    const cases = parseSwitchCases(cfgStr(ctx, "cases"));
    if (cases.length === 0) throw new PermanentError("多路分流沒有設定任何選項——請在「分流選項」填要分幾路(一行一個)");
    const matched = pickSwitchCase(value, cases);
    ctx.log(`分流「${value.slice(0, 60)}」→ ${matched}`);
    return { output: { matched, switchValue: value }, activePorts: [matched] };
  },
};
