/**
 * 匯入的流程如果本來就帶著排程，直接問使用者要不要開啟——不要讓他自己去發現。
 *
 * 為什麼要有這一層(真實踩過)：匯出檔會把排程一起帶走，匯入時也會照樣還原，但匯入的流程一律是
 * 「草稿 + 尚未確認」，兩道閘門都會讓排程不執行。結果是使用者把流程搬到另一台電腦、看到排程好好
 * 地列在那裡、時間到了卻什麼都沒發生，而畫面上完全沒有任何線索——他只能來問人。
 *
 * 這一層把「系統知道、使用者不知道」變成一個明確的問題：**這條流程帶了排程，要開嗎？**
 * 但問法不能只是 yes/no——同意等於授權它日後在無人看著的時候自動跑，所以要一併講清楚會發生什麼、
 * 以及有哪些東西在匯入時被安全機制拿掉了(那些會在第一次執行時重新產生，值得先自己跑一次看)。
 */

import { walkGraphSteps } from "./repeatNesting";
import type { WorkflowNode } from "./types";

export interface ImportedScheduleConsent {
  /** 這條流程帶著的排程(原文 cron)，用來讓呼叫端自己翻成白話 */
  crons: string[];
  /** 同意之後會發生什麼——知情同意的「情」，不能只給一個問句 */
  consequences: string[];
}

interface WorkflowLike {
  importedUntrusted?: boolean;
  status?: string;
  nodes: WorkflowNode[];
}

/**
 * 要不要主動問、以及要一起講什麼。回 null＝沒有要問的事(不是匯入的、已經確認過、或根本沒帶排程)。
 * 刻意不在這裡碰資料庫或翻譯 cron：這是葉模組，翻譯用的那份工具住在會拉進節點註冊表的地方，
 * 從這裡 import 會把初始化循環拉進來(這個 repo 踩過)。
 */
export function importedScheduleConsent(
  workflow: WorkflowLike,
  schedules: readonly { cron: string }[],
): ImportedScheduleConsent | null {
  if (!workflow.importedUntrusted) return null;
  const crons = schedules.map((schedule) => schedule.cron).filter((cron) => typeof cron === "string" && cron.trim());
  if (crons.length === 0) return null;

  const consequences = [
    "這條流程會被設為正式，之後排程時間到就會自己在背景執行（沒有人看著）。",
    "它是從外部檔案匯入的，可能讀取這台電腦上的檔案、開啟網站，或把資料送到外部服務。",
  ];
  const regenerating = countStepsNeedingCodeRegeneration(workflow.nodes);
  if (regenerating > 0) {
    consequences.push(
      `有 ${regenerating} 個自訂程式碼步驟的內容在匯入時被清空（安全機制，避免執行別人夾帶的程式碼），`
      + "第一次執行時系統會依步驟說明重新產生程式碼。建議先自己手動跑一次確認結果正確，再交給排程。",
    );
  }
  return { crons, consequences };
}

/** 匯入時被清空、要等第一次執行才會重新產生的自訂程式碼步驟數(含迴圈內嵌的每一步)。 */
function countStepsNeedingCodeRegeneration(nodes: WorkflowNode[]): number {
  return walkGraphSteps(nodes).visited.filter(
    (node) => node.type === "custom-code" && !String(node.config?.code ?? "").trim(),
  ).length;
}
