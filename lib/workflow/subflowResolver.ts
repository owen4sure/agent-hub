import { getWorkflow, findWorkflowsByName } from "./store";
import { approvedReadOnlyNodeIds } from "./httpReadOnlyApproval";
import type { SubflowLookup, SubflowResolver } from "./subflowEffects";
import type { Workflow } from "./types";

/**
 * 用本機 workflow 檔案回答「這個 run-workflow 的 target 指向哪一條流程」——`subflowEffects` 刻意
 * 不 import store(requirementCheck 不能碰檔案系統，也會把 registry 的初始化循環拉進來)，所以把
 * 真正查檔案的那一小段放在這裡由呼叫端注入。
 *
 * 解析規則**必須跟執行期 `subWorkflow.execute` 完全一致**，否則會出現「驗收時看的是 A、執行時跑的
 * 是 B」這種最危險的落差：先試 id(要先驗格式，getWorkflow 對不像 id 的字串會擋路徑穿越)，再試
 * 名稱；同名多條一律回 ambiguous(執行期也是直接報錯要求指定唯一名稱或 id)。
 */
/**
 * 把一條流程包成分析用的結果。關鍵是 `readOnlyApprovedNodeIds` 只查**這條流程自己**的確認：
 * 一條被多處重用的純讀子流程，只要它的擁有者確認過那個查詢端點，就不該在每個呼叫它的父流程裡
 * 被重複擋下(過度保守會逼使用者把共用流程拆掉)。但確認絕不跨流程沿用——`approvedReadOnlyNodeIds`
 * 用這條流程自己的 id 查 DB，而且逐一比對 method/url/headers/body 指紋，子流程被改動、匯入、
 * 複製或撤銷確認之後指紋就對不上，立刻回到 fail closed。
 */
function toLookup(wf: Workflow): SubflowLookup {
  let approved: ReadonlySet<string> | undefined;
  try { approved = approvedReadOnlyNodeIds(wf.id, wf.nodes); } catch { approved = undefined; /* 沒有 DB 就當全部未確認 */ }
  return {
    kind: "found",
    id: wf.id,
    name: wf.name,
    nodes: wf.nodes,
    onFailureWorkflow: wf.onFailureWorkflow,
    readOnlyApprovedNodeIds: approved,
  };
}

export const storeSubflowResolver: SubflowResolver = (ref: string): SubflowLookup => {
  const target = ref.trim();
  if (!target) return { kind: "not-found" };
  const byId = /^[a-zA-Z0-9_-]{1,80}$/.test(target) ? getWorkflow(target) : null;
  if (byId) return toLookup(byId);
  const hits = findWorkflowsByName(target);
  if (hits.length > 1) return { kind: "ambiguous", count: hits.length };
  if (hits.length === 1) return toLookup(hits[0]);
  return { kind: "not-found" };
};
