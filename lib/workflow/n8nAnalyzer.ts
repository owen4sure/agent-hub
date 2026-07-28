import { createHash } from "node:crypto";
import type { N8nMigrationSummary, Workflow, WorkflowEdge, WorkflowNode } from "./types";

const MAX_NODES = 1_000;
const MAX_CONNECTIONS = 5_000;

export type N8nFindingStatus = "mapped" | "review" | "unsupported";

export interface N8nNodeFinding {
  id: string;
  name: string;
  n8nType: string;
  status: N8nFindingStatus;
  suggestedAgentHubType: string | null;
  riskTags: string[];
  notes: string[];
  /** Only a length, never the original secret/code/value. */
  credentialFieldCount: number;
}

export interface N8nWorkflowAnalysis {
  format: "n8n-workflow";
  name: string;
  sourceFingerprint: string;
  nodeCount: number;
  connectionCount: number;
  unmappedConnectionCount: number;
  triggerCount: number;
  mappedCount: number;
  reviewCount: number;
  unsupportedCount: number;
  importPreviewAvailable: boolean;
  requiresUserReview: boolean;
  riskSummary: string[];
  findings: N8nNodeFinding[];
  /** Names only; values are deliberately never returned. */
  credentialNames: string[];
}

interface N8nNode {
  id: string;
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, unknown>;
}

export interface N8nConversion {
  workflow: Pick<Workflow, "name" | "description" | "nodes" | "edges">;
  clearedCodeCount: number;
  clearedCredentialCount: number;
  reviewCount: number;
  unsupportedCount: number;
  unsupportedNodeIds: string[];
  migration: N8nMigrationSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function safeNodeType(type: string): string {
  return type.replace(/^n8n-nodes-base\./, "").replace(/^@n8n\/n8n-nodes-langchain\./, "langchain.");
}

/**
 * n8n 的 Switch 輸出名稱會隨版本與節點設定格式變動；只有匯出中明確保存的
 * outputKey/name/label 才能拿來當 Agent Hub 的 fromPort，不能用條件陣列位置猜成使用者看得懂的分類。
 */
function explicitSwitchOutputLabels(parameters: Record<string, unknown>): string[] {
  const values: string[] = [];
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!isRecord(item)) continue;
      for (const key of ["outputKey", "name", "label"]) {
        if (typeof item[key] === "string" && item[key].trim()) {
          values.push(item[key].trim().slice(0, 120));
          break;
        }
      }
    }
  };
  const rules = isRecord(parameters.rules) ? parameters.rules : undefined;
  collect(rules?.values);
  collect(rules?.rules);
  collect(parameters.outputs);
  return [...new Set(values)];
}

function branchPortFor(node: N8nNode | undefined, branchIndex: number, switchLabels: string[]): string | undefined {
  if (!node) return undefined;
  const type = safeNodeType(node.type);
  if (type === "if") return branchIndex === 0 ? "true" : branchIndex === 1 ? "false" : undefined;
  if (type === "switch") return switchLabels[branchIndex] ?? `n8n-output-${branchIndex + 1}`;
  return undefined;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function safeImportedUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function countConnections(connections: Record<string, unknown>): number {
  let count = 0;
  for (const value of Object.values(connections)) {
    if (!isRecord(value)) continue;
    for (const output of Object.values(value)) {
      if (!Array.isArray(output)) continue;
      for (const branch of output) if (Array.isArray(branch)) count += branch.length;
    }
  }
  return count;
}

function countConvertibleMainConnections(connections: Record<string, unknown>, nodeNames: Set<string>): number {
  let count = 0;
  for (const [sourceName, value] of Object.entries(connections)) {
    if (!nodeNames.has(sourceName) || !isRecord(value)) continue;
    const main = value.main;
    if (!Array.isArray(main)) continue;
    for (const branch of main) {
      if (!Array.isArray(branch)) continue;
      for (const connection of branch) {
        if (isRecord(connection) && typeof connection.node === "string" && nodeNames.has(connection.node)) count++;
      }
    }
  }
  return count;
}

function mappingFor(node: N8nNode): { suggested: string | null; status: N8nFindingStatus; risks: string[]; notes: string[] } {
  const type = safeNodeType(node.type);
  const p = node.parameters;
  const risks: string[] = [];
  const notes: string[] = [];

  if (type === "manualTrigger" || type === "scheduleTrigger" || type === "webhook") {
    if (type === "scheduleTrigger") notes.push("排程時間需重新確認，分析不會直接建立排程");
    if (type === "webhook") notes.push("Webhook token 與公開網址不會被帶入");
    return { suggested: "trigger", status: "mapped", risks, notes };
  }
  if (type === "code") {
    risks.push("arbitrary-code");
    notes.push("只保留程式碼意圖與長度，第一次執行前需由 Agent Hub 重新產生並驗證");
    return { suggested: "custom-code", status: "review", risks, notes };
  }
  if (type === "httpRequest") {
    const method = text(p.method, 20).toUpperCase() || "GET";
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) risks.push("remote-write-review");
    notes.push(`HTTP ${method} 呼叫需重新確認，不會自動沿用 n8n 的認證或密鑰`);
    return { suggested: "http-request", status: method === "GET" ? "mapped" : "review", risks, notes };
  }
  if (type === "if") {
    return { suggested: "if-condition", status: "review", risks, notes: ["n8n 的條件規則不會猜測轉換；請重新確認左值、比較方式與右值，但 true/false 分支會保留"] };
  }
  if (type === "switch") {
    const labels = explicitSwitchOutputLabels(p);
    return labels.length > 0
      ? { suggested: "switch", status: "review", risks, notes: ["已保留匯出中明確的分支名稱；請重新確認分類值與每一路的意義"] }
      : { suggested: "switch", status: "review", risks, notes: ["找不到匯出中明確的分支名稱；已保留分支數量但不會猜分類，請在畫布重新命名各路"] };
  }
  if (type === "merge") return { suggested: null, status: "review", risks, notes: ["需依實際分支語意改成 Agent Hub 的資料合併步驟"] };
  if (type === "executeWorkflow" || type === "executeWorkflowTrigger") {
    risks.push("delegated-workflow");
    return { suggested: "run-workflow", status: "review", risks, notes: ["子流程內容與副作用需重新分析，不能只信任節點名稱"] };
  }
  if (type === "wait") return { suggested: "wait", status: "review", risks, notes: ["等待是可映射的，但等待條件與恢復方式需人工確認"] };
  if (type === "executeCommand") return { suggested: null, status: "unsupported", risks: ["local-command"], notes: ["不自動轉換本機命令；它可能讀寫整台電腦"] };
  if (type === "readWriteFile") return { suggested: "read-file", status: "review", risks: ["local-file"], notes: ["讀檔與寫檔要拆成明確步驟，寫檔需重新確認"] };
  if (type === "spreadsheetFile") return { suggested: "excel-process", status: "review", risks: ["local-file"], notes: ["需重新確認來源檔、分頁與範圍"] };
  if (type === "telegram") return { suggested: "telegram-notify", status: "review", risks: ["outbound-notification"], notes: ["通知對象與 Bot 憑證不會被帶入"] };
  if (type === "gmail") return { suggested: "email-read", status: "review", risks: ["email-access"], notes: ["需重新確認讀信或寄信意圖；不帶入帳密"] };
  if (type === "googleSheets") return { suggested: "google-sheet-read", status: "review", risks: ["remote-data"], notes: ["分頁、範圍、讀寫方向需重新確認"] };
  if (type === "googleDrive") return { suggested: null, status: "review", risks: ["remote-data"], notes: ["Google Drive 操作需依實際 operation 重新選擇安全步驟"] };
  if (type.startsWith("langchain.")) return { suggested: "llm-decide", status: "review", risks: ["ai-behavior"], notes: ["模型、提示與輸出契約需重新驗證"] };

  return { suggested: null, status: "unsupported", risks: ["unsupported-node"], notes: ["目前沒有安全的一對一映射"] };
}

export function analyzeN8nWorkflow(input: unknown): N8nWorkflowAnalysis {
  if (!isRecord(input) || !Array.isArray(input.nodes)) throw new Error("這不是有效的 n8n workflow JSON");
  if (input.nodes.length === 0) throw new Error("n8n workflow 沒有節點");
  if (input.nodes.length > MAX_NODES) throw new Error(`n8n workflow 超過 ${MAX_NODES} 個節點`);
  const nodes: N8nNode[] = input.nodes.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.type !== "string") {
      throw new Error(`第 ${index + 1} 個 n8n 節點缺少 id、name 或 type`);
    }
    if (raw.id.length > 120 || raw.name.length > 300 || raw.type.length > 300) throw new Error(`第 ${index + 1} 個 n8n 節點欄位過長`);
    return {
      id: raw.id,
      name: raw.name,
      type: raw.type,
      parameters: isRecord(raw.parameters) ? raw.parameters : {},
      credentials: isRecord(raw.credentials) ? raw.credentials : undefined,
    };
  });
  const nodeNames = new Set<string>();
  for (const node of nodes) {
    if (nodeNames.has(node.name)) throw new Error(`n8n workflow 有重複的節點名稱「${node.name.slice(0, 120)}」；連線會無法安全辨識，請先在 n8n 改成唯一名稱再匯出`);
    nodeNames.add(node.name);
  }
  const connections = isRecord(input.connections) ? input.connections : {};
  const connectionCount = countConnections(connections);
  const unmappedConnectionCount = connectionCount - countConvertibleMainConnections(connections, nodeNames);
  if (connectionCount > MAX_CONNECTIONS) throw new Error(`n8n workflow 超過 ${MAX_CONNECTIONS.toLocaleString()} 條連線`);

  const findings = nodes.map((node): N8nNodeFinding => {
    const mapping = mappingFor(node);
    return {
      id: node.id,
      name: node.name.slice(0, 120),
      n8nType: safeNodeType(node.type),
      status: mapping.status,
      suggestedAgentHubType: mapping.suggested,
      riskTags: [...new Set(mapping.risks)],
      notes: mapping.notes,
      credentialFieldCount: node.credentials ? Object.keys(node.credentials).length : 0,
    };
  });
  const credentialNames = [...new Set(nodes.flatMap((node) => Object.keys(node.credentials ?? {})))].sort();
  const riskSummary = [...new Set([
    ...findings.flatMap((finding) => finding.riskTags),
    ...(unmappedConnectionCount > 0 ? ["unmapped-connection"] : []),
  ])].sort();
  const mappedCount = findings.filter((finding) => finding.status === "mapped").length;
  const reviewCount = findings.filter((finding) => finding.status === "review").length;
  const unsupportedCount = findings.filter((finding) => finding.status === "unsupported").length;
  return {
    format: "n8n-workflow",
    name: text(input.name, 160) || "未命名 n8n workflow",
    sourceFingerprint: fingerprint({ name: input.name, nodes, connections }),
    nodeCount: nodes.length,
    connectionCount,
    unmappedConnectionCount,
    triggerCount: findings.filter((finding) => finding.suggestedAgentHubType === "trigger").length,
    mappedCount,
    reviewCount,
    unsupportedCount,
    importPreviewAvailable: true,
    requiresUserReview: reviewCount > 0 || unsupportedCount > 0 || unmappedConnectionCount > 0 || findings.some((finding) => finding.credentialFieldCount > 0),
    riskSummary,
    findings,
    credentialNames,
  };
}

/**
 * 產生「可檢查的草稿圖」，不是直接宣稱 n8n 已經等價移植。
 * 認證、密鑰、原始 code 與排程不會帶入；不確定的節點保留成 custom-code/空白待確認步驟，
 * 讓使用者在 Agent Hub 裡看到缺口並逐項補齊，而不是把外部 workflow 當成可信任程式直接執行。
 */
export function convertN8nWorkflow(input: unknown): N8nConversion {
  const analysis = analyzeN8nWorkflow(input);
  const raw = input as Record<string, unknown>;
  const rawNodes = raw.nodes as Array<Record<string, unknown>>;
  const idByName = new Map(rawNodes.map((node, index) => [String(node.name), `n8n-${index + 1}`]));
  const findingById = new Map(analysis.findings.map((finding) => [finding.id, finding]));
  const sourceNodeByName = new Map<string, N8nNode>(rawNodes.map((node): [string, N8nNode] => [String(node.name), {
    id: String(node.id),
    name: String(node.name),
    type: String(node.type),
    parameters: isRecord(node.parameters) ? node.parameters : {},
  }]));
  let clearedCodeCount = 0;
  let clearedCredentialCount = 0;
  const unsupportedNodeIds: string[] = [];

  const nodes: WorkflowNode[] = rawNodes.map((rawNode, index) => {
    const sourceId = String(rawNode.id);
    const finding = findingById.get(sourceId)!;
    const parameters = isRecord(rawNode.parameters) ? rawNode.parameters : {};
    const type = finding.suggestedAgentHubType ?? "custom-code";
    let config: Record<string, unknown> = {};
    if (type === "http-request") {
      config = {
        method: text(parameters.method, 20).toUpperCase() || "GET",
        // Query strings often contain API keys. Keep only the endpoint origin/path; the user can review and restore safe parameters.
        url: safeImportedUrl(parameters.url),
        headers: "{}",
        body: "",
        successStatus: "200-299",
        responseSchema: "",
        readOnly: text(parameters.method, 20).toUpperCase() === "GET",
      };
    } else if (type === "custom-code") {
      config = { intent: `這是從 n8n「${text(rawNode.name, 120)}」轉來的步驟；請依原流程意圖重新描述並產生程式碼`, code: "" };
      if (safeNodeType(String(rawNode.type)) === "code") clearedCodeCount++;
    } else if (type === "wait") {
      config = { seconds: Number(parameters.amount) || 1 };
    } else if (type === "read-file") {
      config = { path: "{{filePath}}", maxChars: 20000 };
    } else if (type === "excel-process") {
      config = { inputPath: "{{attachmentPath}}", sheet: "", headerText: "", dateColumn: 1, filterStart: "", filterEnd: "", highlightColumn: "", outputName: "output" };
    } else if (type === "trigger") {
      config = {};
    } else if (type === "email-read") {
      config = { subjectFilter: "", fromFilter: "", sinceDays: 3, folder: "INBOX" };
    } else if (type === "google-sheet-read") {
      config = { sheetUrl: "", sheetName: "", range: "", maxRows: 500 };
    } else if (type === "telegram-notify") {
      config = { text: "" };
    } else if (type === "if-condition") {
      config = { left: "", op: "==", right: "" };
    } else if (type === "switch") {
      const labels = explicitSwitchOutputLabels(parameters);
      const branchCount = isRecord(raw.connections) && isRecord(raw.connections[rawNode.name as string])
        && Array.isArray((raw.connections[rawNode.name as string] as Record<string, unknown>).main)
        ? ((raw.connections[rawNode.name as string] as Record<string, unknown>).main as unknown[]).length
        : 0;
      const safeLabels = labels.length === branchCount && branchCount > 0
        ? labels
        : Array.from({ length: branchCount }, (_, branchIndex) => `n8n-output-${branchIndex + 1}`);
      config = { value: "", cases: safeLabels.join("\n") };
    } else if (type === "llm-decide") {
      config = { prompt: "", outputKey: "result" };
    } else if (finding.status === "unsupported") {
      unsupportedNodeIds.push(sourceId);
      config = { intent: `這個 n8n 節點「${text(rawNode.name, 120)}」目前沒有安全的一對一映射，請說明要完成的工作`, code: "" };
    }
    if (isRecord(rawNode.credentials)) clearedCredentialCount += Object.keys(rawNode.credentials).length;
    return {
      id: `n8n-${index + 1}`,
      type,
      label: text(rawNode.name, 120) || `n8n 步驟 ${index + 1}`,
      config,
      position: { x: 120 + (index % 4) * 260, y: 80 + Math.floor(index / 4) * 170 },
    };
  });

  const edges: WorkflowEdge[] = [];
  if (isRecord(raw.connections)) {
    for (const [sourceName, sourceConnections] of Object.entries(raw.connections)) {
      const from = idByName.get(sourceName);
      if (!from || !isRecord(sourceConnections)) continue;
      const main = sourceConnections.main;
      if (!Array.isArray(main)) continue;
      const sourceNode = sourceNodeByName.get(sourceName);
      const switchLabels = sourceNode && safeNodeType(sourceNode.type) === "switch"
        ? explicitSwitchOutputLabels(sourceNode.parameters)
        : [];
      for (const [branchIndex, branch] of main.entries()) {
        if (!Array.isArray(branch)) continue;
        for (const connection of branch) {
          if (!isRecord(connection)) continue;
          const to = typeof connection.node === "string" ? idByName.get(connection.node) : undefined;
          if (to) {
            const fromPort = branchPortFor(sourceNode, branchIndex, switchLabels);
            edges.push({ from, to, ...(fromPort ? { fromPort } : {}) });
          }
        }
      }
    }
  }
  // 沒有可辨識連線時保持斷線。依 JSON 順序補線會把原本可能是平行、等待或人工分段的流程
  // 假裝成線性流程，使用者看到綠燈後反而更難發現語意已被改寫。
  const convertedEdges = edges;
  const migration: N8nMigrationSummary = {
    sourceName: analysis.name,
    sourceFingerprint: analysis.sourceFingerprint,
    sourceNodeCount: analysis.nodeCount,
    sourceEdgeCount: analysis.connectionCount,
    unmappedConnectionCount: analysis.unmappedConnectionCount,
    mappedCount: analysis.mappedCount,
    reviewCount: analysis.reviewCount,
    unsupportedCount: analysis.unsupportedCount,
    clearedCodeCount,
    clearedCredentialCount,
    importedAt: new Date().toISOString(),
    originalNodes: analysis.findings.map((finding, index) => ({
      agentHubNodeId: `n8n-${index + 1}`,
      label: finding.name,
      n8nType: finding.n8nType,
      status: finding.status,
      suggestedType: finding.suggestedAgentHubType,
    })),
  };
  return {
    workflow: {
      name: analysis.name,
      description: `由 n8n 安全轉換的草稿；來源指紋 ${analysis.sourceFingerprint}。請先檢查 ${analysis.reviewCount + analysis.unsupportedCount} 個需確認項目，再進行安全試跑。`,
      nodes,
      edges: convertedEdges,
    },
    clearedCodeCount,
    clearedCredentialCount,
    reviewCount: analysis.reviewCount,
    unsupportedCount: analysis.unsupportedCount,
    unsupportedNodeIds,
    migration,
  };
}
