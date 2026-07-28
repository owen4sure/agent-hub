import assert from "node:assert/strict";
import test from "node:test";
import { analyzeN8nWorkflow, convertN8nWorkflow } from "./n8nAnalyzer";

test("n8n 分析只回傳安全摘要，不回傳 credential 值、URL 或程式碼", () => {
  const result = analyzeN8nWorkflow({
    name: "測試流程",
    nodes: [
      { id: "trigger", name: "開始", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      { id: "code", name: "計算", type: "n8n-nodes-base.code", parameters: { jsCode: "return [{json:{secret:'x'}}];" }, credentials: { api: { id: "secret-id", name: "私密連線" } } },
      { id: "http", name: "查詢", type: "n8n-nodes-base.httpRequest", parameters: { method: "GET", url: "https://private.example/query" }, credentials: { api: { id: "secret-id", name: "私密連線" } } },
    ],
    connections: {},
  });
  assert.equal(result.nodeCount, 3);
  assert.equal(result.requiresUserReview, true);
  assert.deepEqual(result.credentialNames, ["api"]);
  assert.equal(JSON.stringify(result).includes("private.example"), false);
  assert.equal(JSON.stringify(result).includes("secret-id"), false);
  assert.equal(JSON.stringify(result).includes("return [{"), false);
  assert.equal(result.findings.find((finding) => finding.id === "code")?.status, "review");
});

test("非 GET HTTP、executeCommand、子流程與未知節點會明確標出風險", () => {
  const result = analyzeN8nWorkflow({
    name: "危險流程",
    nodes: [
      { id: "post", name: "寫入", type: "n8n-nodes-base.httpRequest", parameters: { method: "POST" } },
      { id: "cmd", name: "命令", type: "n8n-nodes-base.executeCommand", parameters: {} },
      { id: "child", name: "子流程", type: "n8n-nodes-base.executeWorkflow", parameters: {} },
      { id: "other", name: "未知", type: "n8n-nodes-base.someCommunityNode", parameters: {} },
    ],
  });
  assert.equal(result.unsupportedCount, 2);
  assert.equal(result.reviewCount, 2);
  assert.ok(result.riskSummary.includes("remote-write-review"));
  assert.ok(result.riskSummary.includes("local-command"));
  assert.ok(result.riskSummary.includes("delegated-workflow"));
});

test("連線數會被限制，避免分析超大惡意 JSON", () => {
  assert.throws(
    () => analyzeN8nWorkflow({
      nodes: [{ id: "a", name: "a", type: "n8n-nodes-base.manualTrigger", parameters: {} }],
      connections: { a: { main: [Array.from({ length: 5_001 }, (_, i) => ({ node: `n${i}`, type: "main", index: 0 }))] } },
    }),
    /超過 5,000 條連線/,
  );
});

test("重複 n8n 節點名稱直接拒絕，避免連線被錯接到最後一個同名節點", () => {
  assert.throws(() => analyzeN8nWorkflow({
    nodes: [
      { id: "a", name: "重複", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      { id: "b", name: "重複", type: "n8n-nodes-base.httpRequest", parameters: {} },
    ],
    connections: {},
  }), /重複的節點名稱/);
});

test("特殊或不存在目標的 n8n 連線會被分析成未搬移，不會假裝完整", () => {
  const result = analyzeN8nWorkflow({
    nodes: [{ id: "a", name: "開始", type: "n8n-nodes-base.manualTrigger", parameters: {} }],
    connections: { 開始: { ai_tool: [[{ node: "不存在", type: "ai_tool", index: 0 }]] } },
  });
  assert.equal(result.unmappedConnectionCount, 1);
  assert.equal(result.requiresUserReview, true);
  assert.ok(result.riskSummary.includes("unmapped-connection"));
});

test("n8n 安全轉換會保留圖的骨架，但清空原始 code 與 credential", () => {
  const result = convertN8nWorkflow({
    name: "安全搬家",
    nodes: [
      { id: "a", name: "開始", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      { id: "b", name: "計算", type: "n8n-nodes-base.code", parameters: { jsCode: "return [{json:{secret:'x'}}];" }, credentials: { api: { id: "secret" } } },
      { id: "c", name: "查詢", type: "n8n-nodes-base.httpRequest", parameters: { method: "GET", url: "https://example.com/query?api_key=secret" } },
    ],
    connections: { "開始": { main: [[{ node: "計算", type: "main", index: 0 }]] }, "計算": { main: [[{ node: "查詢", type: "main", index: 0 }]] } },
  });
  assert.equal(result.workflow.nodes.length, 3);
  assert.equal(result.workflow.edges.length, 2);
  assert.equal(result.clearedCodeCount, 1);
  assert.equal(result.clearedCredentialCount, 1);
  assert.equal(result.migration.sourceNodeCount, 3);
  assert.equal(result.migration.originalNodes.length, 3);
  const code = result.workflow.nodes.find((node) => node.label === "計算")!;
  assert.equal(code.type, "custom-code");
  assert.equal(code.config.code, "");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  const http = result.workflow.nodes.find((node) => node.label === "查詢")!;
  assert.equal(http.config.url, "https://example.com/query");
  assert.equal(JSON.stringify(result).includes("api_key"), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("沒有連線時不依 JSON 排列順序猜流程", () => {
  const result = convertN8nWorkflow({
    name: "斷線流程",
    nodes: [
      { id: "a", name: "開始", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      { id: "b", name: "下一步", type: "n8n-nodes-base.httpRequest", parameters: { method: "GET" } },
    ],
    connections: {},
  });
  assert.deepEqual(result.workflow.edges, []);
});

test("n8n IF 分支會保留 true/false，且條件本身必須人工重新確認", () => {
  const result = convertN8nWorkflow({
    name: "IF 分支",
    nodes: [
      { id: "if", name: "判斷", type: "n8n-nodes-base.if", parameters: { conditions: { number: [] } } },
      { id: "yes", name: "是", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      { id: "no", name: "否", type: "n8n-nodes-base.manualTrigger", parameters: {} },
    ],
    connections: { 判斷: { main: [[{ node: "是", type: "main", index: 0 }], [{ node: "否", type: "main", index: 0 }]] } },
  });
  assert.deepEqual(result.workflow.edges.map((edge) => edge.fromPort), ["true", "false"]);
  assert.equal(result.workflow.nodes.find((node) => node.id === "n8n-1")?.config.left, "");
  assert.equal(result.migration.originalNodes[0].status, "review");
});

test("n8n Switch 沒有明確輸出名稱時不猜分類，分支仍帶不可忽略的待確認標籤", () => {
  const result = convertN8nWorkflow({
    name: "Switch 分支",
    nodes: [
      { id: "switch", name: "分類", type: "n8n-nodes-base.switch", parameters: {} },
      { id: "a", name: "A", type: "n8n-nodes-base.manualTrigger", parameters: {} },
      { id: "b", name: "B", type: "n8n-nodes-base.manualTrigger", parameters: {} },
    ],
    connections: { 分類: { main: [[{ node: "A", type: "main", index: 0 }], [{ node: "B", type: "main", index: 0 }]] } },
  });
  assert.deepEqual(result.workflow.edges.map((edge) => edge.fromPort), ["n8n-output-1", "n8n-output-2"]);
  assert.equal(result.workflow.nodes.find((node) => node.id === "n8n-1")?.config.cases, "n8n-output-1\nn8n-output-2");
  assert.equal(result.migration.originalNodes[0].status, "review");
});
