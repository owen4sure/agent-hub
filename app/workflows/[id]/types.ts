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
  longDescription?: string;
  triggerParams?: ParamField[];
  nodes: WFNode[];
  edges: WFEdge[];
  model: string;
}
export interface NodeRun {
  node_id: string;
  status: string;
  output_json: string | null;
  error: string | null;
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
