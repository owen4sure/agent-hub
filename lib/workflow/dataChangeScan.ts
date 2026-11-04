import { walkGraphSteps, type VisitedStep } from "./repeatNesting";
import { configuredSideEffects, nodeTypesWithSideEffect, type SideEffectTag } from "./sideEffects";

/**
 * 「這張圖自己(不含被委派出去的流程)會不會做出被禁止的資料變更」——建圖當下的需求驗收與執行前的
 * 跨流程重驗**共用這一份**實作。
 *
 * 為什麼要抽出來：這一系列 P0 的共同成因就是同一件事被寫了兩份、然後其中一份沒跟上(需求驗收與
 * dry-run 各一份型別清單、攤平走訪與 lint 各一份深度政策)。執行前閘門如果自己再寫一次「哪些節點
 * 算寫入」，下一次改規則時一定又會漏掉一邊。被委派流程那一側走 subflowEffects 的 scanDelegatedWrites，
 * 同樣只有一份。
 *
 * leaf module：只 import repeatNesting／sideEffects，不碰 DB、檔案系統或 registry。
 */
export interface DirectDataChangeScan {
  /** 明確會做出被禁止變更的節點(含 repeat-steps 內嵌步驟) */
  writes: VisitedStep[];
  /** AI 建議唯讀、但還沒有使用者確認的 http-request(等使用者按確認，不是圖不安全) */
  awaitingConfirmation: VisitedStep[];
  /** 靜態判斷不出會不會寫的節點(還沒產碼又沒有 intent 的 custom-code) */
  undetermined: VisitedStep[];
  /** 走訪掃不到的區域——看不到就不能說安全 */
  overLimitPaths: string[];
  unreadablePaths: string[];
}

export interface DirectScanOptions {
  bannedEffects: ReadonlySet<SideEffectTag>;
  /** 這條流程裡已被**使用者**確認為唯讀的 http-request 節點 id(指紋已比對過)。 */
  readOnlyApprovedNodeIds?: ReadonlySet<string>;
  /** 是否把「判斷不出來」也列進來。只有「只讀／不要修改」這種全面禁止時才需要 fail closed 到這個程度。 */
  includeUndetermined?: boolean;
}

export function scanDirectDataChanges(
  nodes: { id?: string; type: string; config?: Record<string, unknown>; label?: string }[],
  opts: DirectScanOptions,
): DirectDataChangeScan {
  const walk = walkGraphSteps(nodes);
  const bannedTypes = nodeTypesWithSideEffect(...opts.bannedEffects);
  const writes: VisitedStep[] = [];
  const awaitingConfirmation: VisitedStep[] = [];
  const undetermined: VisitedStep[] = [];

  for (const node of walk.visited) {
    if (bannedTypes.has(node.type)) { writes.push(node); continue; }
    const configured = configuredSideEffects(node.type, node.config, {
      // 內嵌步驟(node.nested)沒有真正的 node id，也無法在畫面上逐一確認 → 永遠拿不到使用者豁免。
      readOnlyApproved: !node.nested && !!node.id && !!opts.readOnlyApprovedNodeIds?.has(node.id),
    });
    if (configured.effects.some((effect) => opts.bannedEffects.has(effect))) {
      if (configured.awaitingUserConfirmation && !node.nested) awaitingConfirmation.push(node);
      else writes.push(node);
    } else if (configured.undetermined && opts.includeUndetermined) {
      undetermined.push(node);
    }
  }
  return { writes, awaitingConfirmation, undetermined, overLimitPaths: walk.overLimitPaths, unreadablePaths: walk.unreadablePaths };
}
