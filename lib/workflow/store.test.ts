import assert from "node:assert/strict";
import test from "node:test";
import { backupWorkflow, createWorkflow, copyWorkflow, deleteWorkflow, deriveRequiresSecrets, findLatestExecutableCustomCode, getWorkflow, listBackups, restoreBackup, saveWorkflow } from "./store";
import { deleteWorkflowChatState, getWorkflowChatState, saveWorkflowChatState } from "./chatStateStore";
import { applyNodeConfigEdits } from "./graphRepair";
import { getChatAttachment, saveChatAttachment } from "../chatAttachments";
import { createSchedule, deleteSchedule } from "../scheduler";

test("複製 workflow 保留已確認脈絡與原始附件，但不複製完整聊天", () => {
  const source = createWorkflow(`copy-context-${Date.now()}`);
  let copiedId: string | null = null;
  try {
    const executableCode = "return { ...ctx.input, monthlyTotal: 42 };";
    saveWorkflow({
      ...source,
      longDescription: "每週整理營運數字並填回既有報表",
      nodes: [{
        id: "calculate",
        type: "custom-code",
        label: "計算月報數字",
        config: { intent: "計算月報數字", code: executableCode },
        position: { x: 0, y: 0 },
      }],
      edges: [],
    });
    const sourceFile = saveChatAttachment({
      workflowId: source.id, source: "upload", filename: "主管週會來源.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: "分頁：訂單；金額欄：120、80、200", originalBase64: Buffer.from("test-sheet").toString("base64"), images: [],
    });
    saveWorkflowChatState(source.id, {
      chat: [
        { role: "user", parts: [{ kind: "text", text: "改成只讀測試，先不要寫入任何資料" }] },
        { role: "assistant", parts: [{ kind: "text", text: "了解" }] },
        { role: "user", parts: [{ kind: "file", name: "主管週會來源.xlsx", assetId: sourceFile.id }] },
      ],
      pendingGraph: null,
      pendingExecution: null,
    });
    const copy = copyWorkflow(source.id);
    assert.ok(copy);
    copiedId = copy.id;
    assert.match(copy.copyHandoff?.summary ?? "", /只讀測試/);
    assert.match(copy.copyHandoff?.summary ?? "", /主管週會來源\.xlsx/);
    assert.match(copy.copyHandoff?.summary ?? "", /供 AI 延續理解/);
    // 真實踩過的事故：這段摘要曾標成「已確認的規則」，AI 因此把來源流程的舊規則「順便」套用到
    // 副本這次完全不相干的新請求上。標籤要講清楚這只是背景參考、不是這次對話確認過的事。
    assert.match(copy.copyHandoff?.summary ?? "", /僅供參考、不是這次對話裡確認過的事/);
    assert.doesNotMatch(copy.copyHandoff?.summary ?? "", /已確認的規則／最近調整/);
    assert.equal(copy.copyHandoff?.attachments?.[0]?.name, "主管週會來源.xlsx");
    const copiedAttachment = copy.copyHandoff?.attachments?.[0]?.assetId;
    assert.ok(copiedAttachment && copiedAttachment !== sourceFile.id);
    assert.equal(getChatAttachment(copiedAttachment!)?.workflowId, copy.id, "副本要有自己的附件，原流程刪除後也不能失效");
    assert.equal(getWorkflowChatState(copy.id), null, "副本不能攜帶完整聊天紀錄");
    assert.equal(getWorkflow(copy.id)?.nodes.find((node) => node.id === "calculate")?.config.code, executableCode, "副本必須保留已驗證的可執行程式碼");
  } finally {
    if (copiedId) deleteWorkflow(copiedId);
    deleteWorkflow(source.id);
    deleteWorkflowChatState(source.id);
  }
});

// 真實顧慮：對話超過 24 則使用者訊息、或附件超過 8 份時，交接摘要只留最近的部分，早期內容會
// 消失——以前完全不會提醒使用者，容易讓人以為副本完整承接了原流程的脈絡。
test("複製 workflow：對話/附件數量沒超過上限時 truncatedChat/truncatedAttachments 都是 false", () => {
  const source = createWorkflow(`copy-no-truncate-${Date.now()}`);
  let copiedId: string | null = null;
  try {
    saveWorkflowChatState(source.id, {
      chat: [{ role: "user", parts: [{ kind: "text", text: "一句簡短的需求" }] }],
      pendingGraph: null,
      pendingExecution: null,
    });
    const copy = copyWorkflow(source.id);
    assert.ok(copy);
    copiedId = copy.id;
    assert.equal(copy.copyHandoff?.truncatedChat, false);
    assert.equal(copy.copyHandoff?.truncatedAttachments, false);
  } finally {
    if (copiedId) deleteWorkflow(copiedId);
    deleteWorkflow(source.id);
    deleteWorkflowChatState(source.id);
  }
});

test("複製 workflow：對話超過 24 則使用者訊息時，truncatedChat 要標記成 true", () => {
  const source = createWorkflow(`copy-truncate-chat-${Date.now()}`);
  let copiedId: string | null = null;
  try {
    const chat = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, parts: [{ kind: "text" as const, text: `第 ${i} 則需求說明` }] }));
    saveWorkflowChatState(source.id, { chat, pendingGraph: null, pendingExecution: null });
    const copy = copyWorkflow(source.id);
    assert.ok(copy);
    copiedId = copy.id;
    assert.equal(copy.copyHandoff?.truncatedChat, true);
    // 最舊的幾則(第 0-5 則)應該已經被截掉、摘要裡看不到
    assert.doesNotMatch(copy.copyHandoff?.summary ?? "", /第 0 則需求說明/);
  } finally {
    if (copiedId) deleteWorkflow(copiedId);
    deleteWorkflow(source.id);
    deleteWorkflowChatState(source.id);
  }
});

test("複製 workflow：附件超過 8 份時，truncatedAttachments 要標記成 true", () => {
  const source = createWorkflow(`copy-truncate-attach-${Date.now()}`);
  let copiedId: string | null = null;
  const savedFiles: { id: string }[] = [];
  try {
    const chat = Array.from({ length: 10 }, (_, i) => {
      const file = saveChatAttachment({
        workflowId: source.id, source: "upload", filename: `檔案${i}.xlsx`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        text: "內容", originalBase64: Buffer.from("x").toString("base64"), images: [],
      });
      savedFiles.push(file);
      return { role: "user" as const, parts: [{ kind: "file" as const, name: `檔案${i}.xlsx`, assetId: file.id }] };
    });
    saveWorkflowChatState(source.id, { chat, pendingGraph: null, pendingExecution: null });
    const copy = copyWorkflow(source.id);
    assert.ok(copy);
    copiedId = copy.id;
    assert.equal(copy.copyHandoff?.truncatedAttachments, true);
    assert.equal(copy.copyHandoff?.attachments?.length, 8, "實際複製的附件數要照既有的 8 份上限");
  } finally {
    if (copiedId) deleteWorkflow(copiedId);
    deleteWorkflow(source.id);
    deleteWorkflowChatState(source.id);
  }
});

test("複製 workflow 後只改目的地，計算邏輯的 code 跟其他既有設定要原封不動", () => {
  const source = createWorkflow(`copy-then-edit-${Date.now()}`);
  let copiedId: string | null = null;
  try {
    const calcCode = "return { ...ctx.input, monthlyTotal: ctx.input.raw1 + ctx.input.raw2 };";
    saveWorkflow({
      ...source,
      nodes: [
        {
          id: "read", type: "google-sheet-read", label: "讀來源A",
          config: { sheetUrl: "https://docs.google.com/spreadsheets/d/AAA/edit", sheetName: "來源A分頁", range: "A1:C10" },
          position: { x: 0, y: 0 },
        },
        {
          id: "calculate", type: "custom-code", label: "計算月報數字",
          config: { intent: "把兩個原始欄位加總成月報數字", code: calcCode },
          position: { x: 200, y: 0 },
        },
        {
          id: "write", type: "google-sheet-update", label: "寫回目的地A",
          config: { scriptUrl: "https://script.google.com/macros/s/AAA/exec", sheetName: "目的地A分頁", targetColumn: "月報數字", rows: "第1列={{monthlyTotal}}" },
          position: { x: 400, y: 0 },
        },
      ],
      edges: [{ from: "read", to: "calculate" }, { from: "calculate", to: "write" }],
    });

    const copy = copyWorkflow(source.id);
    assert.ok(copy);
    copiedId = copy.id;

    // 複製後只要求「改成寫到目的地B」——不該動到來源節點、也絕不該動到計算邏輯的 code。
    const result = applyNodeConfigEdits(copy.id, [
      { nodeId: "write", config: { sheetName: "目的地B分頁" } },
    ]);
    assert.equal(result.edits.length, 1);
    assert.equal(result.skipped.length, 0);

    const after = getWorkflow(copy.id);
    assert.equal(after?.nodes.find((n) => n.id === "calculate")?.config.code, calcCode, "只改目的地，計算邏輯的 code 不能被動到");
    assert.equal(after?.nodes.find((n) => n.id === "read")?.config.sheetName, "來源A分頁", "沒要求改來源，來源設定要維持原樣");
    assert.equal(after?.nodes.find((n) => n.id === "write")?.config.sheetName, "目的地B分頁", "目的地要真的改成新值");
    assert.equal(after?.nodes.find((n) => n.id === "write")?.config.targetColumn, "月報數字", "目的地節點裡沒要求改的其他欄位(targetColumn)也要維持原樣");
  } finally {
    if (copiedId) deleteWorkflow(copiedId);
    deleteWorkflow(source.id);
  }
});

test("程式碼被清空時，修復器能從本機版本歷史找回最近一份可執行底稿", () => {
  const workflow = createWorkflow(`recover-code-history-${Date.now()}`);
  try {
    const code = "return { ...ctx.input, verifiedTotal: 42 };";
    saveWorkflow({
      ...workflow,
      nodes: [{ id: "calculate", type: "custom-code", label: "計算", config: { intent: "原本的計算規則", code }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    // 下一次保存前會把上面那份有效版本備份；模擬 AI 編輯意外把 code 清空。
    saveWorkflow({
      ...getWorkflow(workflow.id)!,
      nodes: [{ id: "calculate", type: "custom-code", label: "計算", config: { intent: "新的計算規則", code: "" }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    const recovered = findLatestExecutableCustomCode(workflow.id, "calculate");
    assert.ok(recovered);
    assert.equal(recovered!.code, code);
    assert.equal(recovered!.intent, "原本的計算規則");
  } finally {
    deleteWorkflow(workflow.id);
  }
});

test("帳密需求只保留目前節點真的會用到的欄位，舊 Google 自動登入欄位不能殘留", () => {
  const workflow = createWorkflow(`secret-prune-${Date.now()}`);
  try {
    const result = deriveRequiresSecrets({
      ...workflow,
      requiresSecrets: [
        { key: "googleAccount", label: "Google 帳號", type: "text" },
        { key: "googlePassword", label: "Google 密碼", type: "password" },
        { key: "serviceToken", label: "服務金鑰", type: "password" },
      ],
      nodes: [
        { id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "call", type: "http-request", label: "讀資料", config: { url: "https://example.com", headers: "Authorization: Bearer {{serviceToken}}" }, position: { x: 200, y: 0 } },
      ],
      edges: [{ from: "trigger", to: "call" }],
    });
    assert.deepEqual((result ?? []).map((field) => field.key), ["serviceToken"]);
  } finally {
    deleteWorkflow(workflow.id);
  }
});

// 真實顧慮：備份只還原流程圖本身，不含排程/Webhook/LINE 這類觸發設定——使用者可能還原一張
// 用了不同執行參數的舊圖，卻繼續套用現在的排程設定，兩者可能已經對不上，但以前完全不會提醒。
test("restoreBackup：還原的版本觸發參數不同、且有作用中的排程時，要回一句警告", () => {
  const workflow = createWorkflow(`restore-warn-${Date.now()}`);
  let scheduleId: string | null = null;
  try {
    saveWorkflow({
      ...workflow,
      triggerParams: [{ key: "oldField", label: "舊欄位", type: "text" }],
      nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
    });
    // 這個備份點的 triggerParams 是 oldField
    backupWorkflow(workflow.id);
    const backups = listBackups(workflow.id);
    assert.ok(backups.length > 0, "應該要有備份點");
    const backupFilename = backups[0].filename;

    // 現在改成不同的 triggerParams，並設一個作用中的排程
    saveWorkflow({ ...workflow, triggerParams: [{ key: "newField", label: "新欄位", type: "text" }] });
    scheduleId = createSchedule(workflow.id, "0 9 * * *", { newField: "x" });

    const result = restoreBackup(workflow.id, backupFilename);
    assert.ok(result);
    assert.match(result!.warning ?? "", /排程.*Webhook.*LINE|觸發設定/, JSON.stringify(result));
  } finally {
    if (scheduleId) deleteSchedule(scheduleId);
    deleteWorkflow(workflow.id);
  }
});

test("restoreBackup：觸發參數沒有變化時，即使有作用中的排程也不用警告", () => {
  const workflow = createWorkflow(`restore-nowarn-${Date.now()}`);
  let scheduleId: string | null = null;
  try {
    saveWorkflow({
      ...workflow,
      triggerParams: [{ key: "sameField", label: "欄位", type: "text" }],
      nodes: [{ id: "trigger", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } }],
      edges: [],
    });
    backupWorkflow(workflow.id);
    const backups = listBackups(workflow.id);
    const backupFilename = backups[0].filename;

    scheduleId = createSchedule(workflow.id, "0 9 * * *", { sameField: "x" });
    const result = restoreBackup(workflow.id, backupFilename);
    assert.ok(result);
    assert.equal(result!.warning, undefined);
  } finally {
    if (scheduleId) deleteSchedule(scheduleId);
    deleteWorkflow(workflow.id);
  }
});
