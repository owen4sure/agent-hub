import { createHash } from "node:crypto";
import type { Workflow } from "./types";

/**
 * 安全預覽與正式執行之間的流程版本指紋。
 *
 * 座標不影響執行，所以刻意排除；節點設定、接線、執行參數與模型會影響讀寫結果，必須納入。
 * 這能避免使用者核對的是 A 版預覽，但等待期間 AI／另一個分頁把流程改成 B 版，確認後卻直接跑 B 版。
 */
export function workflowExecutionFingerprint(workflow: Pick<Workflow, "nodes" | "edges" | "triggerParams" | "defaultModel">): string {
  const executable = {
    nodes: workflow.nodes.map((node) => ({ id: node.id, type: node.type, label: node.label, config: node.config })),
    edges: workflow.edges,
    triggerParams: workflow.triggerParams ?? [],
    model: workflow.defaultModel,
  };
  return createHash("sha256").update(JSON.stringify(executable)).digest("hex");
}
