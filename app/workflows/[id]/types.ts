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
  /** 這條流程產出的檔案要另外存去哪：undefined=跟設定頁一樣、"none"=不另外存、其他=指定資料夾 */
  outputFolder?: string;
  importedUntrusted?: boolean;
  n8nMigration?: {
    sourceName: string;
    sourceFingerprint: string;
    sourceNodeCount: number;
    sourceEdgeCount: number;
    unmappedConnectionCount?: number;
    mappedCount: number;
    reviewCount: number;
    unsupportedCount: number;
    clearedCodeCount: number;
    clearedCredentialCount: number;
    importedAt: string;
    originalNodes: { agentHubNodeId: string; label: string; n8nType: string; status: "mapped" | "review" | "unsupported"; suggestedType: string | null }[];
  };
  n8nMigrationAcknowledgedAt?: string;
  n8nMigrationReviews?: Record<string, { decision: "acknowledged"; note?: string; reviewedAt: string }>;
  copyHandoff?: { sourceName: string; summary: string; copiedAt: string };
  longDescription?: string;
  triggerParams?: ParamField[];
  nodes: WFNode[];
  edges: WFEdge[];
  model: string;
  /** 這條流程需要的帳密欄位(GET 時即時推導,含 custom-code 掃出來的)——搭配 secretsSet 算出缺哪些 */
  requiresSecrets?: { key: string; label: string; type: "text" | "password" }[];
  acceptanceSpec?: { expectedAnswer: string; graphFingerprint: string; savedAt: string };
}
export interface AutomationReadinessItem {
  code: string;
  title: string;
  detail: string;
  action: string;
  actionCode?: "open-workflow" | "open-settings" | "open-n8n-review" | "start-safe-test" | "open-safety";
}
export interface AutomationReadiness {
  ready: boolean;
  items: AutomationReadinessItem[];
}
export interface AutomationReadinessPassport {
  id: number;
  workflowId: string;
  graphFingerprint: string;
  ready: boolean;
  items: AutomationReadinessItem[];
  checkedAt: string;
  checkedBy: string;
  matchesCurrentGraph: boolean;
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
export interface EvidenceState {
  passport: {
    createdAt: string;
    graphFingerprint: string;
    nodeCount: number;
    successfulNodes: number;
    coverage: { total: number; covered: number; complete: boolean } | null;
    files: { filename: string; size: number; sha256: string | null; readable: boolean }[];
    sources?: { nodePath: string; kind: "file" | "url" | "mail"; reference: string; sha256: string | null; size: number | null; readable: boolean; dynamic: boolean; selection?: { sheet?: string; range?: string }; observed?: { headerText?: string; headerRow?: number; rowCount?: number; columnCount?: number; matchedRowCount?: number; numPages?: number; textChars?: number; truncated?: boolean; downloaded?: boolean; found?: number; attachmentCount?: number; bodyChars?: number; status?: string } }[];
  };
  currentGraphFingerprint: string;
  drifted: boolean;
}
export interface ExplainData {
  overview: string;
  params: { label: string; value: string }[];
  secrets: string[];
  steps: { order: number; id: string; type: string; icon: string; label: string; text: string; settings: [string, string][] }[];
}
export interface DataFlowField {
  name: string;
  sources: string[];
  status: "available" | "unknown-source" | "missing" | "runtime";
}
export interface DataFlowReference {
  token: string;
  status: "available" | "unknown-source" | "missing" | "runtime";
}
export interface DataFlowData {
  graphFingerprint: string;
  nodes: { order: number; id: string; label: string; type: string; inputs: DataFlowField[]; outputs: DataFlowField[]; references: DataFlowReference[] }[];
  warnings: string[];
}
