/**
 * 「模型自作主張多做的事」直接拿掉，不要再花一輪模型去請它改。
 *
 * 為什麼要有這一層(真實紀錄，不是假想)：這台機器上建圖階段被需求驗收擋下 57 次，前幾名是
 * 模型自己加了使用者沒要求的桌面通知(23 次)、把「每週我手動上傳」誤判成要建排程(7 次)。
 * 檢查是對的、模型是錯的——但**每被抓一次就要多跑一輪模型(實測一輪 1～4 分鐘)**，疊起來
 * 正是建圖失敗裡最大宗的「超過 5/10 分鐘自動停止」(43 次)的主要來源之一。
 *
 * 更關鍵的是：這些規則**提示裡早就寫了**(「不要自己加通知」「不要用模擬數據」都在)，模型
 * 照樣照犯。既然講了沒用，就不要再靠講——這正是這個 repo 的迴圈工程原則：「prompt 裡寫
 * 『請不要…』約束不了弱模型，程式碼裡的 if 才約束得了」。
 *
 * 只處理「拿掉多做的東西」這一類，因為它有兩個特性讓確定性處理是安全的：
 * ①移除一個沒被要求的外送動作，不可能讓流程變得不正確(頂多少一則通知)；
 * ②那本來就是驗收要求模型做的事——我們只是省掉一次來回，結果完全相同。
 * 「少做了什麼」(缺步驟、缺分流)一律不碰，那種只有模型補得出來。
 *
 * 拿掉了什麼一定要回報給使用者(見 trimSummary)：這個 repo 踩過「安全機制攔了什麼埋在
 * 逐節點紀錄裡等於沒講」的虧，靜默修改比不修改更難查。
 */

import type { WorkflowNode, WorkflowEdge } from "./types";
import { nodeTypesWithSideEffect } from "./sideEffects";

/** 只取用得到的形狀，不從 builder 匯入型別——那會讓這個葉模組反過來依賴呼叫它的人。 */
interface SuggestedSchedule { cron: string; params?: Record<string, unknown> }

export interface AutoTrimInput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  schedule?: SuggestedSchedule;
}

export interface AutoTrimResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  schedule?: SuggestedSchedule;
  /** 拿掉了什麼，白話。空陣列＝沒有東西被自動移除。 */
  removed: string[];
}

/**
 * 決定「這一項可不可以自動拿掉」的唯一依據是需求驗收已經算出來的結論，
 * 不在這裡重新解讀使用者原話——重新解讀必然跟驗收漂移，而漂移正是這一系列問題的共同成因。
 */
export interface AutoTrimPolicy {
  /** 使用者沒有要求任何通知／寄信(對應驗收的 noUnrequestedOutbound) */
  dropUnrequestedOutbound: boolean;
  /** 使用者沒有要求自動執行(對應驗收的「不擅自建立自動排程」) */
  dropUnrequestedSchedule: boolean;
}

export function autoTrimUnrequested(input: AutoTrimInput, policy: AutoTrimPolicy): AutoTrimResult {
  const removed: string[] = [];
  let nodes = input.nodes;
  let edges = input.edges;
  let schedule = input.schedule;

  if (policy.dropUnrequestedSchedule && schedule) {
    removed.push("移除了自動排程（你說的是使用頻率，不是要它自己定時跑；需要定時再跟我說）");
    schedule = undefined;
  }

  if (policy.dropUnrequestedOutbound) {
    const outboundTypes = new Set([...nodeTypesWithSideEffect("email"), ...nodeTypesWithSideEffect("notify")]);
    // 錯誤分支上的桌面提醒是「失敗時有人知道」的零設定備案，不是模型硬塞的完成通知——
    // 驗收本身就對它豁免，這裡必須用同一個判斷，否則會把使用者真正需要的失敗提醒刪掉。
    const isFailurePlan = (node: WorkflowNode): boolean =>
      node.type === "desktop-notify" && edges.some((edge) => edge.to === node.id && edge.fromPort === "error");
    const doomed = nodes.filter((node) => outboundTypes.has(node.type) && !isFailurePlan(node));
    if (doomed.length > 0) {
      const doomedIds = new Set(doomed.map((node) => node.id));
      // 被移除節點的上下游要接回去，不能留下斷點(上游 → 被刪 → 下游 ⇒ 上游 → 下游)
      const rewired: WorkflowEdge[] = [];
      for (const edge of edges) {
        if (doomedIds.has(edge.from) || doomedIds.has(edge.to)) continue;
        rewired.push(edge);
      }
      for (const node of doomed) {
        const ins = edges.filter((edge) => edge.to === node.id);
        const outs = edges.filter((edge) => edge.from === node.id);
        for (const incoming of ins) {
          for (const outgoing of outs) {
            if (doomedIds.has(incoming.from) || doomedIds.has(outgoing.to)) continue;
            if (rewired.some((edge) => edge.from === incoming.from && edge.to === outgoing.to)) continue;
            rewired.push({ from: incoming.from, to: outgoing.to, ...(incoming.fromPort ? { fromPort: incoming.fromPort } : {}) });
          }
        }
      }
      nodes = nodes.filter((node) => !doomedIds.has(node.id));
      edges = rewired;
      removed.push(`移除了 ${doomed.map((node) => `「${node.label || node.type}」`).join("、")}：你這次沒有要求寄信或通知，執行結果會直接顯示在平台裡`);
    }
  }

  return { nodes, edges, schedule, removed };
}

/** 附在回覆後面的說明。自動改了東西一定要講，靜默修改比不修改更難查。 */
export function trimSummary(removed: string[]): string {
  if (removed.length === 0) return "";
  return `\n\n🧹 這幾件事你沒有要求，我直接沒放進來：\n${removed.map((line) => `• ${line}`).join("\n")}`;
}
