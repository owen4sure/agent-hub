import type { Workflow, WorkflowNode, WorkflowEdge } from "./types";

/**
 * 2026-08：使用者明確要求「把既有流程的步驟複製過來、我自己在畫布上串接」，而不是用
 * 「執行子流程」呼叫、也不要 AI 用文字重新生成一份「看起來一樣」的節點(AI 打字重建選擇器／
 * custom-code 有抄錯的風險，錯了使用者也不會發現)。matchExistingWorkflows 對訊息裡完整出現的
 * 流程名稱已經是確定性比對(不是模糊猜測)，這裡在符合條件時直接從磁碟原始資料複製節點物件、
 * 只改 id 與座標，一個字元的節點內容都不經過模型——是「確定性驗證，不靠模型聰明」在建圖這一側
 * 的實踐(AGENTS.md 迴圈工程守則)。
 */
export function wantsImportExistingWorkflowNodes(text: string): boolean {
  return /複製|匯入|搬(?:進來|過來)|貼(?:進來|過來)|拿(?:進來|過來)/.test(text);
}

/** id 只能是 graphLint 允許的字元集；碰撞時依序加 -2、-3…，理論上不會用到的保底才上亂數。 */
function ensureUniqueId(preferred: string, usedIds: Set<string>): string {
  const base = /^[A-Za-z0-9_-]{1,80}$/.test(preferred) ? preferred : `n-${Math.random().toString(36).slice(2, 8)}`;
  if (!usedIds.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 80);
    if (!usedIds.has(candidate)) return candidate;
  }
  return `${base.slice(0, 60)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SpliceImportResult {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 每條來源流程實際貢獻了幾個節點(觸發節點不算——目標流程已經有自己的觸發節點) */
  imported: { name: string; nodeCount: number }[];
}

/**
 * 把幾條既有流程「真正的節點」原封不動接到目前這張圖裡：
 * - 不複製來源流程自己的觸發節點(一條流程只能有一個觸發節點，graphLint 會擋第二個)。
 * - 每組匯入的節點裡，「在這組裡沒有任何上游」的節點(原本只靠來源流程自己的觸發節點餵資料)
 *   會被接到目標流程現有的觸發節點——不然套用當下 graphLint 的可達性檢查(每個節點都要從觸發節點
 *   連得到)一定會擋下來，整個匯入直接套用失敗，看起來像功能壞掉。這條起始線只是「先讓圖合法、
 *   套用得下去」的預設接法，使用者原本要的「自己接」仍然成立——套用後可以直接刪掉這條線改接到
 *   別的節點，或維持原樣(如果本來就想從觸發節點直接開始跑)。
 * - 節點內部的 {{欄位}} 引用是扁平的欄位名，不是「節點id.欄位」，所以改 id 不會弄壞
 *   同一條來源流程內部節點之間本來就有的資料引用(見 graphLint.ts 的扁平資料模型說明)。
 * - id 撞名(跟目標流程既有節點、或另一條一起匯入的來源流程)時自動改名，來源流程內部的邊
 *   一起用同一份 id 對照表重新指向新 id，不會因為改名就斷線。
 * - 座標整塊平移到目標畫布既有節點的右邊，多條來源依序往下疊，避免疊在一起看不清楚，
 *   但保留每條來源流程「自己原本節點之間的相對位置」，看起來還是原本那張圖的樣子。
 */
export function spliceImportedWorkflowNodes(
  target: { nodes: WorkflowNode[]; edges: WorkflowEdge[] },
  sources: Workflow[],
): SpliceImportResult {
  const usedIds = new Set(target.nodes.map((n) => n.id));
  const baseX = target.nodes.length > 0 ? Math.max(...target.nodes.map((n) => n.position?.x ?? 0)) + 400 : 80;
  const targetTriggerId = target.nodes.find((n) => n.type === "trigger")?.id;

  const newNodes: WorkflowNode[] = [];
  const newEdges: WorkflowEdge[] = [];
  const imported: { name: string; nodeCount: number }[] = [];

  sources.forEach((source, sourceIndex) => {
    const nonTrigger = source.nodes.filter((n) => n.type !== "trigger");
    if (nonTrigger.length === 0) {
      imported.push({ name: source.name, nodeCount: 0 });
      return;
    }
    const minX = Math.min(...nonTrigger.map((n) => n.position?.x ?? 0));
    const minY = Math.min(...nonTrigger.map((n) => n.position?.y ?? 0));
    const dy = sourceIndex * 480;

    const idMap = new Map<string, string>();
    for (const node of nonTrigger) {
      const newId = ensureUniqueId(node.id, usedIds);
      usedIds.add(newId);
      idMap.set(node.id, newId);
    }
    for (const node of nonTrigger) {
      newNodes.push({
        ...node,
        id: idMap.get(node.id)!,
        position: {
          x: (node.position?.x ?? 0) - minX + baseX,
          y: (node.position?.y ?? 0) - minY + dy,
        },
      });
    }
    const groupEdges: WorkflowEdge[] = [];
    for (const edge of source.edges) {
      const from = idMap.get(edge.from);
      const to = idMap.get(edge.to);
      if (!from || !to) continue; // 其中一端是沒複製過來的觸發節點
      groupEdges.push({ from, to, ...(edge.fromPort ? { fromPort: edge.fromPort } : {}) });
    }
    newEdges.push(...groupEdges);
    if (targetTriggerId) {
      const hasIncoming = new Set(groupEdges.map((e) => e.to));
      for (const node of nonTrigger) {
        const newId = idMap.get(node.id)!;
        if (!hasIncoming.has(newId)) newEdges.push({ from: targetTriggerId, to: newId });
      }
    }
    imported.push({ name: source.name, nodeCount: nonTrigger.length });
  });

  return {
    nodes: [...target.nodes, ...newNodes],
    edges: [...target.edges, ...newEdges],
    imported,
  };
}

/**
 * 對話裡要顯示給使用者的確認訊息——講清楚是「原封不動複製」，以及套用後使用者自己還要做什麼。
 * 不在這裡自己加「下方預覽新流程」這類提示——前端(wfChatStore.ts)對 phase:"ready" 的回覆一律
 * 會自動掛上那句話，這裡再寫一次只會讓使用者在畫面上看到重複兩次同樣的提示。
 */
export function importConfirmMessage(imported: { name: string; nodeCount: number }[]): string {
  const withNodes = imported.filter((x) => x.nodeCount > 0);
  const names = withNodes.map((x) => `「${x.name}」(${x.nodeCount} 個步驟)`).join("、");
  const total = withNodes.reduce((sum, x) => sum + x.nodeCount, 0);
  return (
    `已經把 ${names} 這幾條流程實際的步驟原封不動複製過來了(共新增 ${total} 個節點)——不是用執行子流程呼叫、` +
    `也不是我重新打字生成的，是直接搬過來的，內容跟原本那幾條流程一模一樣。\n\n` +
    `每一組匯入的步驟裡，原本沒有上游的節點(原本直接接在來源流程自己的觸發節點後面)先暫時接到這條流程現有的` +
    `觸發節點，讓圖是可以直接套用的合法狀態；組內原本的接法都保留。套用後你可以自己在畫布上刪掉這條起始線、` +
    `改接到別的位置，或把整組拆開重新串接。如果原本這幾條流程有依賴期間/監聽這類由觸發節點提供的欄位，` +
    `套用後記得自己在這條流程的觸發節點補上，或把節點設定裡的引用改成這條流程實際會提供的欄位名。`
  );
}
