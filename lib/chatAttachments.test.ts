import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import { deleteChatAttachment, deleteChatAttachmentsForWorkflow, getChatAttachment, hydrateChatAttachments, materializeChatAttachment, saveChatAttachment } from "./chatAttachments";
import { deleteWorkflowChatState, saveWorkflowChatState } from "./workflow/chatStateStore";

test("刪除 workflow 對話時只清自己的附件，不影響其他 workflow", () => {
  const first = saveChatAttachment({
    workflowId: "wf-clean-a",
    filename: "a.txt",
    text: "A",
    originalBase64: Buffer.from("A").toString("base64"),
    images: [],
  });
  const second = saveChatAttachment({
    workflowId: "wf-clean-b",
    filename: "b.txt",
    text: "B",
    originalBase64: Buffer.from("B").toString("base64"),
    images: [],
  });
  try {
    assert.equal(deleteChatAttachmentsForWorkflow("wf-clean-a"), 1);
    assert.equal(getChatAttachment(first.id), null);
    assert.equal(getChatAttachment(second.id)?.text, "B");
  } finally {
    deleteChatAttachment(first.id);
    deleteChatAttachment(second.id);
  }
});

test("對話附件：localStorage 只剩 assetId 時，伺服器仍能補回完整檔案與圖片", async () => {
  const full = "完整規格內容".repeat(3000);
  const asset = saveChatAttachment({
    filename: "spec.txt",
    mime: "text/plain",
    text: full,
    originalBase64: Buffer.from(full).toString("base64"),
    images: [{ name: "預覽圖", mime: "image/png", b64: "aGVsbG8=" }],
  });
  try {
    assert.equal(getChatAttachment(asset.id)?.text, full);
    const hydrated = await hydrateChatAttachments([{
      parts: [
        { kind: "file", name: "spec.txt", content: "截短內容", assetId: asset.id },
        { kind: "image", name: "預覽圖", mime: "image/png", b64: "", assetId: asset.id },
      ],
    }]);
    assert.deepEqual(hydrated.missing, []);
    assert.equal(hydrated.history[0].parts?.[0].content, full);
    assert.equal(hydrated.history[0].parts?.[1].b64, "aGVsbG8=");
  } finally {
    deleteChatAttachment(asset.id);
  }
});

test("Claude Code 附件工作區：純文字只提供原始全文一次，不重複讀抽取副本", () => {
  const original = "完整規格全文，尾端規則不能遺失";
  const asset = saveChatAttachment({
    filename: "spec.md",
    mime: "text/markdown",
    text: original,
    originalBase64: Buffer.from(original).toString("base64"),
    images: [],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-attachment-test-"));
  try {
    const paths = materializeChatAttachment(asset.id, dir);
    assert.equal(paths.length, 1);
    assert.equal(path.basename(paths[0]), "spec.md");
    assert.equal(fs.readFileSync(paths[0], "utf8"), original);
  } finally {
    deleteChatAttachment(asset.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Code 附件工作區：ZIP 解壓總量不超過 20MB", () => {
  const zip = new AdmZip();
  for (let i = 0; i < 6; i++) zip.addFile(`src/large-${i}.txt`, Buffer.alloc(4 * 1024 * 1024, 65 + i));
  const zipped = zip.toBuffer();
  const asset = saveChatAttachment({
    filename: "large-project.zip",
    mime: "application/zip",
    text: "大型壓縮專案",
    originalBase64: zipped.toString("base64"),
    images: [],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-zip-budget-test-"));
  try {
    materializeChatAttachment(asset.id, dir);
    const expanded = fs.readdirSync(dir).filter((name) => name.startsWith("zip-"));
    const total = expanded.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
    assert.ok(total <= 20 * 1024 * 1024, `解壓了 ${total} bytes，超過預算`);
    assert.ok(expanded.length <= 5);
  } finally {
    deleteChatAttachment(asset.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("網址內容：重新整理後仍能從 assetId 補回完整文字與截圖，且不冒充上傳檔案", async () => {
  const full = "網頁尾端的重要規則".repeat(1000);
  const asset = saveChatAttachment({
    workflowId: "wf-url-context",
    source: "url",
    filename: "說明頁",
    mime: "text/html",
    text: full,
    originalBase64: "",
    images: [{ name: "網頁截圖:說明頁", mime: "image/png", b64: "aGVsbG8=" }],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-url-context-"));
  try {
    const hydrated = await hydrateChatAttachments([{
      parts: [
        { kind: "file", name: "https://example.com/spec", content: "截短", assetId: asset.id },
        { kind: "image", name: "網頁截圖:說明頁", b64: "", assetId: asset.id },
      ],
    }], "wf-url-context");
    assert.deepEqual(hydrated.missing, []);
    assert.equal(hydrated.history[0].parts?.[0].content, full);
    assert.equal(hydrated.history[0].parts?.[1].b64, "aGVsbG8=");
    const paths = materializeChatAttachment(asset.id, dir);
    assert.equal(paths.length, 1);
    assert.equal(fs.readFileSync(paths[0], "utf8"), full);
  } finally {
    deleteChatAttachment(asset.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("網址快取過期不會永久鎖死整段對話；真實檔案遺失仍報錯", async () => {
  const missingId = "00000000-0000-4000-8000-000000000000";
  const hydrated = await hydrateChatAttachments([{
    parts: [
      { kind: "file", name: "https://example.com/spec", content: "先前抽取的網頁摘要", assetId: missingId },
      { kind: "file", name: "重要規格.docx", content: "截短摘要", assetId: missingId },
    ],
  }]);
  assert.deepEqual(hydrated.missing, ["重要規格.docx"]);
  assert.equal(hydrated.history[0].parts?.[0].content, "先前抽取的網頁摘要");
});

test("較早訊息的附件過期只降級成文字提示，不會擋住跟附件完全無關的當前這輪對話", async () => {
  const missingId = "00000000-0000-4000-8000-000000000001";
  const hydrated = await hydrateChatAttachments([
    { role: "user", parts: [{ kind: "file", name: "很久以前的日報.xlsx", content: "截短摘要", assetId: missingId }] },
    { role: "assistant", parts: [{ kind: "text", text: "已經照這份檔案改好流程了" }] },
    { role: "user", parts: [{ kind: "text", text: "分流節點接錯分支了，幫我修" }] },
  ]);
  assert.deepEqual(hydrated.missing, []);
  const degraded = hydrated.history[0].parts?.[0] as Record<string, unknown>;
  assert.equal(degraded.kind, "text");
  assert.match(String(degraded.text), /快取現已過期/);
  assert.equal((hydrated.history[2].parts?.[0] as Record<string, unknown>).text, "分流節點接錯分支了，幫我修");
});

test("當前這一輪(最後一則使用者訊息)自己的附件遺失仍要硬擋，不能假裝看得到", async () => {
  const missingId = "00000000-0000-4000-8000-000000000002";
  const hydrated = await hydrateChatAttachments([
    { role: "user", parts: [{ kind: "text", text: "先前的閒聊" }] },
    { role: "user", parts: [{ kind: "file", name: "這次要問的新檔案.xlsx", content: "截短", assetId: missingId }] },
  ]);
  assert.deepEqual(hydrated.missing, ["這次要問的新檔案.xlsx"]);
});

test("仍在已儲存對話裡的原始附件不會因七天快取期限失效", () => {
  const workflowId = `qa-attachment-pin-${Date.now()}`;
  const asset = saveChatAttachment({
    workflowId,
    filename: "long-lived.xlsx",
    text: "完整表格摘要",
    originalBase64: Buffer.from("real workbook bytes").toString("base64"),
    images: [],
  });
  const assetFile = path.join(process.cwd(), "data", "chat-attachments", `${asset.id}.json`);
  try {
    // 模擬隔週回來修改同一條 workflow；附件檔本身已老，但聊天狀態仍明確引用它。
    const old = JSON.parse(fs.readFileSync(assetFile, "utf8")) as Record<string, unknown>;
    old.createdAt = Date.now() - 8 * 24 * 60 * 60_000;
    fs.writeFileSync(assetFile, JSON.stringify(old));
    saveWorkflowChatState(workflowId, {
      chat: [{ role: "user", parts: [{ kind: "file", name: asset.filename, assetId: asset.id }] }],
      pendingGraph: null,
      pendingExecution: null,
    });
    assert.equal(getChatAttachment(asset.id)?.text, "完整表格摘要");

    deleteWorkflowChatState(workflowId);
    assert.equal(getChatAttachment(asset.id), null);
  } finally {
    deleteWorkflowChatState(workflowId);
    deleteChatAttachment(asset.id);
  }
});

// 2026-07 第三輪外部審查抓到的 P1：一般模型只看得到 xlsxToText 截斷後的文字(前 60 列)，使用者
// 提到超出截斷範圍的具體儲存格(如「H100」)永遠找不到。這裡建一個真的超過 60 列的 xlsx，
// 驗證訊息裡提到該儲存格位址時，hydrateChatAttachments 真的會從原始檔案位元組把它撈出來。
test("hydrateChatAttachments：訊息提到超出截斷範圍的儲存格位址時，從原始檔案補讀該儲存格", async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("業績表");
  sheet.getCell("A1").value = "標題";
  sheet.getCell("H100").value = "隱藏在第100列的值12345"; // 遠超過 MAX_ROWS_PER_SHEET=60，一般截斷絕對看不到
  const buffer = await wb.xlsx.writeBuffer();
  const asset = saveChatAttachment({
    filename: "業績表.xlsx",
    text: "【分頁「業績表」，共 100 列 x 8 欄】\n(其餘 40 列略，只顯示前 60 列)",
    originalBase64: Buffer.from(buffer as ArrayBuffer).toString("base64"),
    images: [],
  });
  try {
    const hydrated = await hydrateChatAttachments([{
      role: "user",
      parts: [
        { kind: "text", text: "幫我看一下這份檔案的 H100 是多少" },
        { kind: "file", name: "業績表.xlsx", content: "截短摘要", assetId: asset.id },
      ],
    }]);
    const filePart = hydrated.history[0].parts?.[1] as Record<string, unknown>;
    assert.match(String(filePart.content), /H100 = 隱藏在第100列的值12345/);
  } finally {
    deleteChatAttachment(asset.id);
  }
});

// 真實踩過的回歸(第四輪外部審查抓到)：小白最自然的用法是先傳檔案、看完AI回應後才追問
// 「那H100是多少」，這時候提到座標的訊息本身根本沒有附檔。以前補充查詢只套用到「跟這句話
// 同一則訊息」裡的附件，這種最常見的兩輪對話用法反而永遠補不到。
test("hydrateChatAttachments：座標提及跟檔案分屬不同訊息(先傳檔案、下一輪才問座標)仍要補讀", async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("業績表");
  sheet.getCell("H100").value = "跨訊息也要補到的值99999";
  const buffer = await wb.xlsx.writeBuffer();
  const asset = saveChatAttachment({
    filename: "業績表.xlsx",
    text: "截短摘要",
    originalBase64: Buffer.from(buffer as ArrayBuffer).toString("base64"),
    images: [],
  });
  try {
    const hydrated = await hydrateChatAttachments([
      { role: "user", parts: [
        { kind: "text", text: "幫我看一下這份檔案" },
        { kind: "file", name: "業績表.xlsx", content: "截短摘要", assetId: asset.id },
      ] },
      { role: "assistant", parts: [{ kind: "text", text: "我看到這份檔案的內容了，有什麼想問的嗎？" }] },
      { role: "user", parts: [{ kind: "text", text: "那 H100 是多少" }] },
    ]);
    const filePart = hydrated.history[0].parts?.[1] as Record<string, unknown>;
    assert.match(String(filePart.content), /H100 = 跨訊息也要補到的值99999/, "座標提及在後一輪訊息，前一輪的檔案內容仍要補上該儲存格");
  } finally {
    deleteChatAttachment(asset.id);
  }
});

test("hydrateChatAttachments：訊息沒提到任何儲存格位址時，不做補充查詢(維持原本截斷內容)", async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("業績表");
  sheet.getCell("H100").value = "不該被撈出來的值";
  const buffer = await wb.xlsx.writeBuffer();
  const asset = saveChatAttachment({
    filename: "業績表.xlsx",
    text: "截短摘要",
    originalBase64: Buffer.from(buffer as ArrayBuffer).toString("base64"),
    images: [],
  });
  try {
    const hydrated = await hydrateChatAttachments([{
      role: "user",
      parts: [
        { kind: "text", text: "幫我把這份檔案整理成週報" },
        { kind: "file", name: "業績表.xlsx", content: "截短摘要", assetId: asset.id },
      ],
    }]);
    const filePart = hydrated.history[0].parts?.[1] as Record<string, unknown>;
    assert.equal(filePart.content, "截短摘要");
  } finally {
    deleteChatAttachment(asset.id);
  }
});
