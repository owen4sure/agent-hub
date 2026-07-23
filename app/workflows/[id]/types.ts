export interface WFNode {
  id: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}
export interface WFEdge {
  from: string;
  to: string;
  fromPort?: string;
}
export interface ParamField {
  key: string;
  label: string;
  type: string;
  default?: string;
  help?: string;
  options?: string[];
  derived?: boolean;
}
export interface Workflow {
  id: string;
  name: string;
  status: "draft" | "official";
  builtin: boolean;
  importedUntrusted?: boolean;
  copyHandoff?: { sourceName: string; summary: string; copiedAt: string };
  longDescription?: string;
  triggerParams?: ParamField[];
  nodes: WFNode[];
  edges: WFEdge[];
  model: string;
  /** 這條流程需要的帳密欄位(GET 時即時推導,含 custom-code 掃出來的)——搭配 secretsSet 算出缺哪些 */
  requiresSecrets?: { key: string; label: string; type: "text" | "password" }[];
}
export interface NodeRun {
  node_id: string;
  status: string;
  output_json: string | null;
  error: string | null;
  /** 只有 status==="failed" 才會有值——這個節點自己的 classifyFailure 結果，不是整條 run 的。
   * 使用者自己接了「出錯時」備援分支時，整條 run 會回報 success，但這個節點本身仍是真的失敗；
   * 要不要主動指引一定要看這裡，不能只看 run 層級的 resolution/failed_node(那時會是 null)。 */
  resolution?: "ai-fixable" | "needs-human";
  category?: string;
}
export interface RunRecord {
  id: string;
  status: string;
  trigger_type: string;
  reason: string | null;
  resolution: string | null;
  failed_node: string | null;
  started_at: string;
}
export interface ExplainData {
  overview: string;
  params: { label: string; value: string }[];
  secrets: string[];
  steps: { order: number; id: string; type: string; icon: string; label: string; text: string; settings: [string, string][] }[];
}
