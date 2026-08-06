import { listWorkflows } from "./store";
import { getDb } from "../db";
import { collectSubRunOutput } from "./nodes/subWorkflow";
import type { Workflow } from "./types";

/**
 * 「使用者訊息裡完整出現了某條既有流程名稱」這條確定性比對規則，被兩個地方共用：
 * 這裡(existingWorkflowRefsSection，只給 AI 看摘要參考)和 importExistingWorkflowNodes.ts
 * (2026-08 新增，符合條件時原封不動複製節點，不經過 AI 重新生成)。單一真相來源，別各寫一份。
 */
export function matchExistingWorkflows(query: string, excludeWorkflowId?: string): Workflow[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  return listWorkflows()
    .filter((wf) => wf.id !== excludeWorkflowId && wf.name.trim().length >= 2 && trimmedQuery.includes(wf.name.trim()))
    .slice(0, 5); // 一次講太多條意義不大，也控制注入大小
}

/**
 * 使用者在對話裡提到既有流程的名字時(例如「跑一次『某條既有流程』，再跑一次『另一條既有流程』，
 * 把兩邊的結果合併起來寄信」)，builder 原本完全看不到那條流程實際長什麼樣、最後會產出
 * 哪些欄位——只能把使用者打的名字原封不動塞進 run-workflow 節點的 config.target，下游要引用
 * 它的輸出欄位時只能用猜的，猜錯了要等使用者測試後再靠「讓 AI 修」校正，不是一次到位
 * (2026-08 使用者原話：「但是我跟他說要去跑某一個流程，他有環境看到那個流程的內容嗎？」——
 * 查證後確實沒有，這裡把這個落差補上)。
 *
 * 做法：對使用者這則訊息的文字做子字串比對，抓出「訊息裡完整出現了某條既有流程名稱」的那幾條
 * (不做模糊比對——這條平台一貫的原則是「確定性驗證，不靠模型聰明」，寧可少數用不同講法/簡稱
 * 提到既有流程的情況抓不到、退回原本的猜測行為，也不要因為模糊比對誤把不相干的流程當成參考)，
 * 把它的步驟清單、以及(如果真的執行成功過)最近一次成功執行**真正輸出**的欄位一起餵給 AI，
 * 讓它接欄位名稱時有真憑實據可以對——跟 lib/communityIndex.ts 的 communityRefsSection 是
 * 同一種「檢索相關參考、注入提示」的手法，這裡檢索的是使用者自己平台上的既有流程而不是社群範例。
 */
export function existingWorkflowRefsSection(query: string, excludeWorkflowId?: string): string {
  const matches = matchExistingWorkflows(query, excludeWorkflowId);
  if (matches.length === 0) return "";

  const db = getDb();
  const blocks = matches.map((wf) => {
    const steps = wf.nodes.filter((n) => n.type !== "trigger").map((n) => `${n.type}(${n.label})`).join(" → ");
    const lastSuccess = db
      .prepare(`SELECT id FROM runs WHERE workflow_id = ? AND status = 'success' ORDER BY started_at DESC LIMIT 1`)
      .get(wf.id) as { id: string } | undefined;

    let outputInfo = "這條流程還沒有成功執行過，不知道實際輸出欄位長什麼樣——先靠 subRunOk 判斷有沒有呼叫成功，其餘欄位名稱等第一次測試後依實際錯誤訊息校正，不要憑空編。";
    if (lastSuccess) {
      const out = collectSubRunOutput(lastSuccess.id);
      delete out.__subLevel;
      const keys = Object.keys(out);
      if (keys.length > 0) {
        const sample = keys
          .slice(0, 12)
          .map((k) => {
            const v = out[k];
            const str = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}=${str.length > 40 ? `${str.slice(0, 40)}…` : str}`;
          })
          .join("、");
        outputInfo = `這條流程最近一次成功執行(用 run-workflow 呼叫它時)實際輸出的欄位，下游可以直接引用這些欄位名稱：${sample}(值只是上次執行的例子，不是保證這次一樣，但欄位名稱是真的)`;
      }
    }
    return `- 「${wf.name}」(id: ${wf.id})：${steps || "(還沒有步驟)"}\n  ${outputInfo}`;
  });

  return (
    `\n【使用者提到的既有流程——這是它們實際的內容與真正的輸出欄位，不是憑空列出來的(用 run-workflow ` +
    `呼叫它們時，config.target 填流程名稱或 id；下游引用它的輸出優先對照下面列出的實際欄位名，不要猜)：\n${blocks.join("\n")}\n】\n`
  );
}
