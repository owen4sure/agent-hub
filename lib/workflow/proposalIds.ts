/**
 * 把提案節點重新編號成「這張流程圖裡沒人用過」的代號。
 *
 * recordingToNodes 產出的代號固定是 rec-1/rec-2…,同一條流程錄第二次示範再加進來就會撞代號,
 * 而流程圖檢查(lintGraph)遇到重複 id 是整包退回、畫面上也沒有任何地方能改代號——等於這個
 * 功能一條流程只能用一次。這裡在「加進流程圖」之前先讓開,連線也一起換成新代號。
 *
 * 獨立成一個檔案(不放 actionRecorder.ts)是因為呼叫端是瀏覽器端的元件,而 actionRecorder
 * 會載入 node:fs/node:child_process——把它拉進前端 bundle 會直接建置失敗。
 */
export function uniquifyProposalIds(
  existingIds: Iterable<string>,
  proposal: { nodes: { id: string }[]; edges: { from: string; to: string }[] },
): { idMap: Map<string, string>; edges: { from: string; to: string }[] } {
  const used = new Set(existingIds);
  const idMap = new Map<string, string>();
  for (const n of proposal.nodes) {
    let candidate = n.id;
    for (let i = 2; used.has(candidate); i++) candidate = `${n.id}-${i}`;
    used.add(candidate);
    idMap.set(n.id, candidate);
  }
  return {
    idMap,
    edges: proposal.edges.map((e) => ({ from: idMap.get(e.from) ?? e.from, to: idMap.get(e.to) ?? e.to })),
  };
}
