import type { WorkflowNode } from "./types";
import { sheetWriteNodesNeedingSetup } from "../googleSheetScriptTemplate";

/**
 * 「這條流程還差什麼才能跑」——**只列出使用者本人非做不可的一次性設定**。
 *
 * 為什麼要有這一支(使用者原話：「我看不懂要去哪裡操作，這也會是大家會遇到的問題」)：
 * 這個 repo 原本的做法是「套用流程圖的當下，在對話裡推一張設定卡」。那對**新建**的流程有效，
 * 但對**已經存在**的流程完全無效——沒有人會再套用一次，卡片永遠不會出現；而對話訊息本來就會
 * 被後續對話往上推走。結果就是功能藏在「⋯ 選單」裡，使用者根本不知道要去哪裡。
 * 這個 repo 已經為了同一件事踩過三次(排程暫停只有一個表情符號、模型來源卡在頁面 87% 深度)，
 * 教訓每次都一樣：**功能找不到就等於不存在**。
 *
 * 所以改成「隨時可以問、答案只有一份」的純函式，讓流程頁可以一進去就把還沒設定的步驟顯示出來。
 * 新增任何「需要使用者親手做一次設定才能跑」的節點型別時，加進這裡就會自動出現在畫面上，
 * 不用再各自發明一個入口。
 */

export type SetupKind = "sheet-script" | "slides-image-script";

export interface SetupNeed {
  kind: SetupKind;
  /** 卡在哪幾步(給使用者對照畫布上的節點) */
  nodeLabels: string[];
  /** 一句話說明為什麼需要這個設定 */
  reason: string;
  /** 按鈕上的字 */
  actionLabel: string;
}

function labelOf(node: WorkflowNode): string {
  return node.label || node.type;
}

/** 這個欄位是不是「還沒填」——空字串、只有空白、或整個沒有這個 key 都算。 */
function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

export function setupNeedsFor(nodes: WorkflowNode[]): SetupNeed[] {
  const needs: SetupNeed[] = [];

  const sheetLabels = sheetWriteNodesNeedingSetup(nodes);
  if (sheetLabels.length > 0) {
    needs.push({
      kind: "sheet-script",
      nodeLabels: sheetLabels,
      reason: "這幾步要寫進你的 Google 試算表，需要先讓試算表授權接收資料（做一次就好）。",
      actionLabel: "去設定試算表寫入",
    });
  }

  // 「複製簡報頁面」跟換圖共用同一支腳本部署，缺網址時走同一張設定卡
  const slidesImageLabels = nodes
    .filter((node) => (node.type === "google-slides-replace-image" || node.type === "google-slides-copy-page") && isBlank(node.config?.scriptUrl))
    .map(labelOf);
  if (slidesImageLabels.length > 0) {
    needs.push({
      kind: "slides-image-script",
      nodeLabels: slidesImageLabels,
      reason: "這步要更新你的 Google 簡報(換圖/複製頁面)，需要先在你的帳號下建立一小段腳本（做一次就好）。",
      actionLabel: "去設定換簡報圖片",
    });
  }

  return needs;
}
