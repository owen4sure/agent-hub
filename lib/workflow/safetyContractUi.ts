import type { SideEffectTag } from "./sideEffects";

/**
 * 「只讀保護」在畫面與 API 之間共用的詞彙表與純邏輯。
 *
 * 抽出來的理由跟這一系列的其他共用模組一樣：可放寬的項目清單如果 API 一份、畫面一份，遲早會變成
 * 「API 支援五類、畫面只列得出三類」——使用者按不到的那兩類等於不存在。這裡是唯一一份，
 * 兩邊都從這裡取，`safetyContractUi.test.ts` 另外機械比對畫面真的把每一類都渲染出來。
 */

/** 使用者可以明確放寬的五類。工作區暫存檔、簽核請求、子流程委派不在此列——它們不是使用者授權的對象。 */
export const RELAXABLE_EFFECTS: SideEffectTag[] = ["file-write", "file-modify", "remote-write", "email", "notify"];

/** 白話標籤：小白看得懂「放寬這一項之後，這條流程可以做什麼」。 */
export const EFFECT_LABELS: Record<string, { title: string; detail: string }> = {
  "file-write": { title: "產生新檔案", detail: "在你的電腦上建立報表、輸出檔" },
  "file-modify": { title: "改寫既有檔案", detail: "覆蓋或修改你原本就有的檔案" },
  "remote-write": { title: "寫入外部服務", detail: "更新 Google 試算表、Google 簡報等雲端資料" },
  email: { title: "寄出 Email", detail: "把內容寄到信箱(可能寄給你以外的人)" },
  notify: { title: "發送通知", detail: "Telegram、LINE、Slack 或桌面通知" },
};

export function effectLabel(tag: string): { title: string; detail: string } {
  return EFFECT_LABELS[tag] ?? { title: tag, detail: "" };
}

/** 目前這份契約裡「使用者可以勾選放寬」的項目(依固定順序，畫面才不會每次載入順序都不一樣)。 */
export function relaxableFrom(bannedEffects: readonly string[]): SideEffectTag[] {
  return RELAXABLE_EFFECTS.filter((tag) => bannedEffects.includes(tag));
}

/** 勾選之後還會保留哪些保護——按下去之前就要讓使用者看得到，不是按完才發現全開了。 */
export function remainingAfterRelease(bannedEffects: readonly string[], selected: readonly string[]): SideEffectTag[] {
  return relaxableFrom(bannedEffects).filter((tag) => !selected.includes(tag));
}

/**
 * 依勾選狀態組出要送給 API 的請求。
 * - 沒勾任何一項 → `null`(什麼都不做；預設不選，避免手滑整份解除)
 * - 勾了一部分 → 只放寬那幾項
 * - 勾滿全部 → 整份解除，畫面另外要求明確確認
 */
export function releaseRequestFor(
  bannedEffects: readonly string[],
  selected: readonly string[],
): { kind: "none" } | { kind: "partial"; allowEffects: SideEffectTag[] } | { kind: "full" } {
  const relaxable = relaxableFrom(bannedEffects);
  const picked = relaxable.filter((tag) => selected.includes(tag));
  if (picked.length === 0) return { kind: "none" };
  if (picked.length === relaxable.length) return { kind: "full" };
  return { kind: "partial", allowEffects: picked };
}
