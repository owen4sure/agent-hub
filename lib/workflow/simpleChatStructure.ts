import { randomUUID } from "node:crypto";
import { getWorkflow } from "./store";
import { applyGraphStructureEdits, type StructureChange } from "./graphStructure";

export interface SimpleChatStructureResult {
  message: string;
  changes: StructureChange[];
}

function quotedText(text: string): string | null {
  const match = text.match(/[「『"']([^」』"']{1,180})[」』"']/);
  return match?.[1]?.trim() || null;
}

/**
 * 把「不需要這個通知」「跑完在這台電腦通知我」這種毫無歧義、使用者最常講的結構需求直接完成。
 * 這不是取代 AI；目的是不要讓一句明確的 UI 動作也塞進 30K prompt、等模型猜半分鐘。複雜分支、
 * 多個終點或任何不確定的情境一律回 null，交回整圖感知 AI 判斷。
 */
export function tryApplySimpleChatStructure(workflowId: string, text: string): SimpleChatStructureResult | null {
  const wf = getWorkflow(workflowId);
  if (!wf) return null;
  const compact = text.replace(/\s+/g, " ").trim();

  // 「刪掉『某節點』」：只在名稱唯一、而且若位於中間能無歧義地前後各接一條正常線時才自動重接。
  const named = quotedText(compact);
  // 「不要現在執行／不要寫入」常跟「請在『某節點』後新增」同一句出現。絕不能只因句尾有
  // 「不要」就把前面引號裡的節點刪掉；刪除詞必須緊貼被點名的名稱前或後，才算無歧義授權。
  const namedRemoval = /(?:刪掉|刪除|移除|不要|不需要)\s*(?:這個|那個|這一步|那一步)?\s*[「『"'][^」』"']+[」』"']|[「『"'][^」』"']+[」』"']\s*(?:這個|那個|這一步|那一步)?\s*(?:刪掉|刪除|移除|不要|不需要)/.test(compact);
  if (named && namedRemoval) {
    const matches = wf.nodes.filter((node) => node.label === named && node.type !== "trigger");
    if (matches.length === 1) {
      const target = matches[0];
      const incoming = wf.edges.filter((edge) => edge.to === target.id && !edge.fromPort);
      const outgoing = wf.edges.filter((edge) => edge.from === target.id && !edge.fromPort);
      // 中間節點只在單進單出時能確定地直接接回；多分支一定交給 AI，不能猜錯業務流程。
      const addEdges = incoming.length === 1 && outgoing.length === 1
        ? [{ from: incoming[0].from, to: outgoing[0].to }]
        : [];
      const applied = applyGraphStructureEdits(workflowId, { removeNodeIds: [target.id], addEdges });
      if (applied.ok) {
        return {
          message: `✅ 已直接刪除「${target.label}」${addEdges.length ? "，並把前後步驟重新接好" : ""}，不需要等待 AI 猜流程。`,
          changes: applied.changes,
        };
      }
    }
  }

  // 「跑完時在這台電腦跳通知」：只有一個正常結束點時才可以安全自動接上。
  const wantsDesktop = /(桌面|這台電腦|本機|電腦)[^。！!]{0,30}(?:通知|提醒)|(?:通知|提醒)[^。！!]{0,30}(桌面|這台電腦|本機|電腦)/.test(compact);
  const completion = /(?:跑完|完成|結束|做好).{0,18}(?:通知|提醒)|(?:通知|提醒).{0,18}(?:跑完|完成|結束|做好)/.test(compact);
  const asksAdd = /(?:加上|加入|新增|補上|增加|加|改成|要).{0,20}(?:通知|提醒)|(?:通知|提醒).{0,20}(?:加上|加入|新增|補上|增加|加)/.test(compact);
  if (wantsDesktop && completion && asksAdd && !/(?:不要|不需要|別).{0,12}(?:通知|提醒)/.test(compact)) {
    const normalOutgoing = new Set(wf.edges.filter((edge) => !edge.fromPort).map((edge) => edge.from));
    const terminal = wf.nodes.filter((node) => !normalOutgoing.has(node.id));
    if (terminal.length === 1) {
      const last = terminal[0];
      const already = wf.edges.some((edge) => edge.from === last.id && wf.nodes.find((node) => node.id === edge.to)?.type === "desktop-notify");
      if (!already) {
        const id = `desktop-notify-${randomUUID().slice(0, 6)}`;
        const message = quotedText(compact) ?? "流程已完成";
        const applied = applyGraphStructureEdits(workflowId, {
          addNodes: [{ id, type: "desktop-notify", label: "完成時桌面通知", config: { title: "Agent Hub", message } }],
          addEdges: [{ from: last.id, to: id }],
        });
        if (applied.ok) {
          return {
            message: `✅ 已直接在「${last.label}」後加上桌面通知，跑完會在這台電腦顯示「${message}」。`,
            changes: applied.changes,
          };
        }
      }
    }
  }
  return null;
}
