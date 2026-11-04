import { walkGraphSteps } from "./repeatNesting";
import { configuredSideEffects, nodeTypesWithSideEffect, type SideEffectTag } from "./sideEffects";

/**
 * 子流程(run-workflow)的跨流程副作用分析。
 *
 * 為什麼需要：`run-workflow` 會去執行**另一條流程**，那條流程裡想寫什麼就寫什麼。只看本流程的節點
 * 型別，`run-workflow` 靜態上「沒有副作用」——使用者說「只讀取資料、不要修改」，AI 只要把寫入動作
 * 藏進一條子流程，需求驗收就完全放行(真實踩過的 P0)。要嘛遞迴分析被呼叫的那條流程，要嘛老實承認
 * 看不到而擋下來，沒有第三種安全的做法。
 *
 * 刻意**不 import store/engine**：requirementCheck 必須維持不碰檔案系統與 DB(否則測試與各種
 * 呼叫端都被迫準備完整環境，也會把 registry 的初始化循環拉進來)。改成由呼叫端注入 resolver。
 */

/** 解析「要執行的流程」這個參照的結果。三種失敗各自分開，錯誤訊息才講得清楚使用者要做什麼。 */
export type SubflowLookup =
  | {
      kind: "found";
      id: string;
      name: string;
      nodes: SubflowNode[];
      /** 這條子流程自己的失敗備援——它失敗時引擎一樣會去跑，所以也要繼續往下分析。 */
      onFailureWorkflow?: string;
      /**
       * **這條子流程自己**在 DB 裡的唯讀確認(節點 id 集合，且指紋已經比對過)。
       * 父流程的確認絕對不能替子流程背書：確認是「使用者對某條流程的某個節點的那一份精確請求」
       * 做的決定，換一條流程就是另一件事。resolver 負責只回傳子流程本人的、指紋相符的確認。
       */
      readOnlyApprovedNodeIds?: ReadonlySet<string>;
    }
  | { kind: "not-found" }
  /** 同名流程不只一條——不知道會跑到哪一條，等於看不到 */
  | { kind: "ambiguous"; count: number };

export interface SubflowNode {
  id?: string;
  type: string;
  config?: Record<string, unknown>;
  label?: string;
}

export type SubflowResolver = (ref: string) => SubflowLookup;

/**
 * 跨流程分析的深度上限。跟執行期 `subWorkflow.execute` 的 `level >= 2` 限制對齊——執行期最多兩層，
 * 分析就必須看得完兩層；超過的在執行期本來就會被擋，這裡一併 fail closed 不會誤擋合法流程。
 */
export const MAX_SUBFLOW_ANALYSIS_DEPTH = 2;

/**
 * 失敗備援(onFailureWorkflow)的連鎖上限。跟執行期 engine.ts 的 `__errorHop` 判斷對齊：
 * hop 從 1 起算、`hop > 2` 就不再觸發，也就是最多真的跑兩層備援。分析要看得完引擎跑得到的每一層。
 * 跟 run-workflow 的深度分開計數——引擎那兩個限制本來就是各算各的。
 */
export const MAX_FAILURE_HOPS = 2;

export interface DelegatedFinding {
  /** 完整呼叫路徑，例如 runChild → child-wf.writeSheet */
  path: string;
  /** 節點型別(找得到才有)，或造成 fail closed 的原因 */
  detail: string;
  /** true = 明確找到會寫入的步驟；false = 看不到、無法確認(一樣不能放行) */
  confirmed: boolean;
}

export interface SubflowScanOptions {
  resolveSubflow?: SubflowResolver;
  bannedEffects: ReadonlySet<SideEffectTag>;
}

/** 被分析的一張圖：節點 + 整張圖層級的失敗備援設定(它不是節點，但引擎失敗後照樣會去跑)。 */
export interface DelegatingGraph {
  nodes: SubflowNode[];
  onFailureWorkflow?: string;
}

/** 目標寫成 {{欄位}} 這種執行期才決定的值，建圖當下不可能知道會跑到哪條流程。 */
export function isDynamicTarget(target: string): boolean {
  return /\{\{/.test(target);
}

/**
 * 掃描一張圖裡所有 run-workflow 節點，遞迴分析被呼叫流程有沒有「這次需求禁止的」副作用。
 * 回傳的每一筆都帶完整呼叫路徑，讓建圖修正迴圈知道要改哪裡。
 */
export function scanDelegatedWrites(
  graph: DelegatingGraph,
  opts: SubflowScanOptions,
): DelegatedFinding[] {
  const findings: DelegatedFinding[] = [];
  const delegatedTypes = nodeTypesWithSideEffect("delegated");
  const bannedTypes = nodeTypesWithSideEffect(...opts.bannedEffects);
  const join = (prefix: string, path: string) => (prefix ? `${prefix}.${path}` : path);

  /** 兩種委派共用同一套「解析 → 失敗就 fail closed → 成功就往下掃」流程。 */
  const follow = (
    ref: string,
    nodePath: string,
    ctx: { depth: number; hops: number; seen: ReadonlySet<string> },
    kind: "subflow" | "failure",
  ): void => {
    const target = ref.trim();
    if (!target) {
      findings.push({ path: nodePath, detail: "沒有指定要執行哪一條流程，無法確認它會不會寫入", confirmed: false });
      return;
    }
    if (isDynamicTarget(target)) {
      findings.push({ path: nodePath, detail: `要執行的流程是執行時才決定的(${target})，建圖當下無法確認它會不會寫入`, confirmed: false });
      return;
    }
    if (!opts.resolveSubflow) {
      findings.push({ path: nodePath, detail: `無法查詢流程「${target}」的內容，因此無法確認它會不會寫入`, confirmed: false });
      return;
    }
    // 先解析再判上限：循環(a→b→a)一定會同時撞到上限，若先報「太深了」，使用者/模型會照著去攤平
    // 層數卻永遠修不好——真正的問題是它們互相呼叫。兩種都 fail closed，但診斷要講對。
    const found = opts.resolveSubflow(target);
    if (found.kind === "not-found") {
      findings.push({ path: nodePath, detail: `找不到流程「${target}」，無法確認它會不會寫入`, confirmed: false });
      return;
    }
    if (found.kind === "ambiguous") {
      // 執行期的 findWorkflowByRef 對同名多條也是回 null(等於沒觸發)，同樣 fail closed；
      // 這裡分開講是因為「改名字」跟「補上流程」是兩種完全不同的修法。
      findings.push({ path: nodePath, detail: `有 ${found.count} 條流程都叫「${target}」，不知道會跑到哪一條`, confirmed: false });
      return;
    }
    if (ctx.seen.has(found.id)) {
      findings.push({ path: `${nodePath} → ${found.id}`, detail: "流程互相呼叫形成循環，無法完整分析", confirmed: false });
      return;
    }
    if (kind === "subflow" && ctx.depth >= MAX_SUBFLOW_ANALYSIS_DEPTH) {
      findings.push({ path: nodePath, detail: `子流程巢狀超過 ${MAX_SUBFLOW_ANALYSIS_DEPTH} 層，再深的部分無法確認`, confirmed: false });
      return;
    }
    if (kind === "failure" && ctx.hops >= MAX_FAILURE_HOPS) {
      findings.push({ path: nodePath, detail: `失敗備援連鎖超過 ${MAX_FAILURE_HOPS} 層，再深的部分無法確認`, confirmed: false });
      return;
    }
    scan(
      { nodes: found.nodes, onFailureWorkflow: found.onFailureWorkflow },
      `${nodePath} → ${found.id}`,
      {
        depth: kind === "subflow" ? ctx.depth + 1 : ctx.depth,
        hops: kind === "failure" ? ctx.hops + 1 : ctx.hops,
        seen: new Set([...ctx.seen, found.id]),
      },
      false,
      found.readOnlyApprovedNodeIds,
    );
  };

  /**
   * `isRoot` 區分「本流程」與「被委派的流程」：本流程自己的直接副作用由 requirementCheck 另外檢查
   * (它還要處理使用者的唯讀確認)，這裡只負責被委派的那一側，避免同一個節點被報兩次。
   * `approvedNodeIds` 是**這一層流程自己**的唯讀確認(由 resolver 帶進來，已比對過指紋)。
   */
  const scan = (
    current: DelegatingGraph,
    pathPrefix: string,
    ctx: { depth: number; hops: number; seen: ReadonlySet<string> },
    isRoot: boolean,
    approvedNodeIds?: ReadonlySet<string>,
  ): void => {
    const walk = walkGraphSteps(current.nodes);
    if (!isRoot) {
      // 被委派流程裡的迴圈盲區(超深巢狀、壞掉的 steps)同樣看不到，一樣不能放行。
      for (const blind of [...walk.overLimitPaths, ...walk.unreadablePaths]) {
        findings.push({ path: join(pathPrefix, blind), detail: "這個迴圈裡面有系統看不到的區域，無法確認裡面沒有寫入步驟", confirmed: false });
      }
      for (const node of walk.visited) {
        const nodePath = join(pathPrefix, node.path);
        if (bannedTypes.has(node.type)) {
          findings.push({ path: nodePath, detail: node.type, confirmed: true });
          continue;
        }
        // 這一層的 http-request／custom-code：只認**這條流程本人**、指紋相符的使用者確認。
        // 內嵌步驟沒有真正的 node id、也無法在畫面上逐一確認，永遠拿不到豁免。
        const configured = configuredSideEffects(node.type, node.config, {
          readOnlyApproved: !node.nested && !!node.id && !!approvedNodeIds?.has(node.id),
        });
        if (configured.effects.some((effect) => opts.bannedEffects.has(effect))) {
          findings.push({
            path: nodePath,
            detail: configured.awaitingUserConfirmation
              ? `${node.type}（AI 說這是查詢，但這條流程的擁有者還沒確認過這個端點）`
              : node.type,
            confirmed: !configured.awaitingUserConfirmation,
          });
        } else if (configured.undetermined) {
          findings.push({ path: nodePath, detail: `${node.type}（還看不出來會不會寫入）`, confirmed: false });
        }
      }
    }

    for (const node of walk.visited) {
      if (!delegatedTypes.has(node.type)) continue;
      follow(String(node.config.target ?? ""), join(pathPrefix, node.path), ctx, "subflow");
    }
    // 失敗備援不是節點，是整張圖層級的設定——engine 在主流程失敗後會直接 startWorkflowRun 它。
    // 只掃 run-workflow 的話，把寫入放進失敗備援就繞過了整條只讀限制(P0)。
    if (current.onFailureWorkflow?.trim()) {
      follow(current.onFailureWorkflow, join(pathPrefix, "onFailureWorkflow"), ctx, "failure");
    }
  };

  scan(graph, "", { depth: 0, hops: 0, seen: new Set<string>() }, true);
  return findings;
}
