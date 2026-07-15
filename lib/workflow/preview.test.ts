import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { conversationUrlOverrides, formatWorkflowPreview, pickComputedValues, previewInputFromChatHistory, type WorkflowPreviewResult } from "./preview";
import { deleteChatAttachment, saveChatAttachment } from "../chatAttachments";
import type { Workflow } from "./types";

describe("workflow preview 顯示", () => {
  it("只顯示這一步新算出的值，隱藏透傳欄位與本機暫存路徑", () => {
    const input = JSON.stringify({ subject: "日報", attachmentPath: "/tmp/private.xlsx", periodLabel: "7/1-7/7" });
    const output = JSON.stringify({
      subject: "日報",
      attachmentPath: "/tmp/private.xlsx",
      periodLabel: "7/1-7/7",
      類別A週: 5,
      類別B週: 88,
    });
    assert.deepEqual(pickComputedValues(output, input), { 類別A週: 5, 類別B週: 88 });
  });

  it("安全試跑摘要使用白話欄名，不顯示程式內部名稱", () => {
    const result: WorkflowPreviewResult = {
      ok: true,
      status: "success",
      failedNode: null,
      error: null,
      runId: "r1",
      values: [{ nodeLabel: "登入", computed: { loggedIn: true, reportDate: "2026-07-08", rowCount: 42, internalCamelCase: 7 } }],
      skippedWrites: [],
      plannedWrites: [],
      missingSecrets: [],
      usedConversationSheetUrl: false,
      graphFingerprint: "a".repeat(64),
      replayToken: null,
    };
    const text = formatWorkflowPreview(result);
    assert.match(text, /登入成功＝是/);
    assert.match(text, /主管報告資料日＝2026-07-08/);
    assert.match(text, /讀到資料列數＝42/);
    assert.match(text, /計算結果＝7/);
    assert.doesNotMatch(text, /loggedIn|reportDate|rowCount|internalCamelCase/);
  });

  it("預計寫入內容保留實際值，但不顯示 JSON 或內部欄位名", () => {
    const result: WorkflowPreviewResult = {
      ok: true, status: "success", failedNode: null, error: null, runId: "r-write",
      values: [], skippedWrites: ["更新週報"], missingSecrets: [], usedConversationSheetUrl: false,
      graphFingerprint: "b".repeat(64),
      replayToken: null,
      plannedWrites: [{
        nodeLabel: "更新週報", destination: "Google 試算表／主管報告",
        payload: { sheetName: "主管報告", targetColumn: "第 28 週", values: [42, 87] },
      }],
    };
    const text = formatWorkflowPreview(result);
    assert.match(text, /分頁名稱＝主管報告/);
    assert.match(text, /要填的欄位＝第 28 週/);
    assert.match(text, /寫入資料＝42、87/);
    assert.doesNotMatch(text, /sheetName|targetColumn|"values"|[{}]/);
  });

  it("對話安全試跑會用 assetId 還原原始附件，不拿截短文字冒充原檔", () => {
    const workflowId = "wf-preview-original-file";
    const original = Buffer.from("真正的 Excel/PDF 二進位內容").toString("base64");
    const asset = saveChatAttachment({
      workflowId,
      filename: "主管報表.xlsx",
      text: "只供聊天看的截短摘要",
      originalBase64: original,
      images: [],
    });
    try {
      const input = previewInputFromChatHistory(workflowId, [{
        role: "user",
        parts: [{ kind: "file", name: "主管報表.xlsx", assetId: asset.id }],
      }]);
      assert.equal(input.filename, "主管報表.xlsx");
      assert.equal(input.dataBase64, original);
      assert.deepEqual(input.files, [{ filename: "主管報表.xlsx", dataBase64: original }]);
    } finally {
      deleteChatAttachment(asset.id);
    }
  });

  it("同一則訊息附多個檔案時全部交給安全試跑，不只偷拿最後一份", () => {
    const workflowId = "wf-preview-multiple-files";
    const a64 = Buffer.from("檔案 A").toString("base64");
    const b64 = Buffer.from("檔案 B").toString("base64");
    const a = saveChatAttachment({ workflowId, filename: "A.xlsx", text: "A", originalBase64: a64, images: [] });
    const b = saveChatAttachment({ workflowId, filename: "B.pdf", text: "B", originalBase64: b64, images: [] });
    try {
      const input = previewInputFromChatHistory(workflowId, [{
        role: "user",
        parts: [
          { kind: "file", name: "A.xlsx", assetId: a.id },
          { kind: "image", name: "A.xlsx 第 1 頁", assetId: a.id }, // 同一 asset 的渲染圖不能重複算一份檔案
          { kind: "file", name: "B.pdf", assetId: b.id },
        ],
      }]);
      assert.deepEqual(input.files, [
        { filename: "A.xlsx", dataBase64: a64 },
        { filename: "B.pdf", dataBase64: b64 },
      ]);
      assert.equal(input.filename, "A.xlsx");
    } finally {
      deleteChatAttachment(a.id);
      deleteChatAttachment(b.id);
    }
  });

  it("單純說再測試時不能偷偷沿用很早以前的一次性附件或網址", () => {
    const workflowId = "wf-preview-no-stale-input";
    const original = Buffer.from("舊的一次性測試檔").toString("base64");
    const asset = saveChatAttachment({
      workflowId,
      filename: "舊報表.xlsx",
      text: "舊報表摘要",
      originalBase64: original,
      images: [],
    });
    try {
      const input = previewInputFromChatHistory(workflowId, [
        {
          role: "user",
          parts: [
            { kind: "text", text: "先用這份測一次：https://example.com/old" },
            { kind: "file", name: "舊報表.xlsx", assetId: asset.id },
          ],
        },
        { role: "assistant", parts: [{ kind: "text", text: "上次測試完成" }] },
        { role: "user", parts: [{ kind: "text", text: "現在再測試看看" }] },
      ]);
      assert.equal(input.filename, undefined);
      assert.equal(input.dataBase64, undefined);
      assert.deepEqual(input.contextUrls, []);
    } finally {
      deleteChatAttachment(asset.id);
    }
  });

  it("本次只貼網址時，舊的網址快取 asset 已清掉仍可重新抓網址", () => {
    const url = "https://example.com/report";
    const input = previewInputFromChatHistory("wf-url-cache-expired", [{
      role: "user",
      parts: [{ kind: "file", name: url, assetId: "00000000-0000-4000-8000-000000000000" }],
    }]);
    assert.deepEqual(input.contextUrls, [url]);
    assert.equal(input.filename, undefined);
  });

  it("本次指定的真實檔案原檔遺失時必須停下，不能靜默改用流程舊資料", () => {
    assert.throws(
      () => previewInputFromChatHistory("wf-missing-file", [{
        role: "user",
        parts: [{ kind: "file", name: "今日報表.xlsx", assetId: "00000000-0000-4000-8000-000000000000" }],
      }]),
      /原始附件已過期或遺失/,
    );
  });

  it("明確說用剛剛那份再測時才沿用最近附件與網址", () => {
    const workflowId = "wf-preview-reuse-input";
    const original = Buffer.from("要重用的測試檔").toString("base64");
    const asset = saveChatAttachment({
      workflowId,
      filename: "本週報表.xlsx",
      text: "本週報表摘要",
      originalBase64: original,
      images: [],
    });
    try {
      const input = previewInputFromChatHistory(workflowId, [
        {
          role: "user",
          parts: [
            { kind: "text", text: "這份資料：https://example.com/current" },
            { kind: "file", name: "本週報表.xlsx", assetId: asset.id },
          ],
        },
        { role: "assistant", parts: [{ kind: "text", text: "已看過" }] },
        { role: "user", parts: [{ kind: "text", text: "用剛剛那份附件和網址再測一次" }] },
      ]);
      assert.equal(input.filename, "本週報表.xlsx");
      assert.equal(input.dataBase64, original);
      assert.deepEqual(input.contextUrls, ["https://example.com/current"]);
    } finally {
      deleteChatAttachment(asset.id);
    }
  });

  it("對話貼的新試算表網址會一次性覆寫唯一讀取步驟，不改原流程", () => {
    const originalUrl = "https://docs.google.com/spreadsheets/d/OLD/edit";
    const newUrl = "https://docs.google.com/spreadsheets/d/NEW/edit?usp=sharing";
    const workflow = {
      id: "wf-url", name: "測試", status: "draft", builtin: false, defaultModel: "minimax-m3",
      nodes: [
        { id: "t", type: "trigger", label: "開始", config: {}, position: { x: 0, y: 0 } },
        { id: "read", type: "google-sheet-read", label: "讀表", config: { sheetUrl: originalUrl }, position: { x: 200, y: 0 } },
      ], edges: [{ from: "t", to: "read" }],
    } satisfies Workflow;
    const overrides = conversationUrlOverrides(workflow, [newUrl]);
    assert.equal(overrides.nodeConfigs.read.sheetUrl, newUrl);
    assert.equal(overrides.usedSheetUrl, true);
    assert.equal(workflow.nodes[1].config.sheetUrl, originalUrl);
  });

  it("多個讀表步驟時不亂猜要換哪一個；若流程以自訂網址欄位引用，仍能安全覆寫該欄位", () => {
    const newUrl = "https://docs.google.com/spreadsheets/d/NEW/edit";
    const workflow = {
      id: "wf-many", name: "測試", status: "draft", builtin: false, defaultModel: "minimax-m3",
      requiresSecrets: [{ key: "reportSheetUrl", label: "報表試算表網址", type: "password" }],
      nodes: [
        { id: "a", type: "google-sheet-read", label: "A", config: { sheetUrl: "{{reportSheetUrl}}" }, position: { x: 0, y: 0 } },
        { id: "b", type: "google-sheet-read", label: "B", config: { sheetUrl: "https://docs.google.com/spreadsheets/d/B/edit" }, position: { x: 200, y: 0 } },
      ], edges: [],
    } satisfies Workflow;
    const overrides = conversationUrlOverrides(workflow, [newUrl]);
    assert.deepEqual(overrides.nodeConfigs, {});
    assert.equal(overrides.secrets.reportSheetUrl, newUrl);
    assert.equal(overrides.usedSheetUrl, true);
  });

  it("一般網址只在唯一相符讀取步驟上做本次試跑覆寫", () => {
    const workflow = {
      id: "wf-web", name: "測試", status: "draft", builtin: false, defaultModel: "minimax-m3",
      nodes: [{ id: "web", type: "web-page", label: "讀網頁", config: { url: "https://old.example" }, position: { x: 0, y: 0 } }], edges: [],
    } satisfies Workflow;
    const overrides = conversationUrlOverrides(workflow, ["https://new.example/report"]);
    assert.equal(overrides.nodeConfigs.web.url, "https://new.example/report");
  });
});
