import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { deleteChatAttachment, deleteChatAttachmentsForWorkflow, getChatAttachment, hydrateChatAttachments, materializeChatAttachment, saveChatAttachment } from "./chatAttachments";

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

test("對話附件：localStorage 只剩 assetId 時，伺服器仍能補回完整檔案與圖片", () => {
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
    const hydrated = hydrateChatAttachments([{
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

test("網址內容：重新整理後仍能從 assetId 補回完整文字與截圖，且不冒充上傳檔案", () => {
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
    const hydrated = hydrateChatAttachments([{
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

test("網址快取過期不會永久鎖死整段對話；真實檔案遺失仍報錯", () => {
  const missingId = "00000000-0000-4000-8000-000000000000";
  const hydrated = hydrateChatAttachments([{
    parts: [
      { kind: "file", name: "https://example.com/spec", content: "先前抽取的網頁摘要", assetId: missingId },
      { kind: "file", name: "重要規格.docx", content: "截短摘要", assetId: missingId },
    ],
  }]);
  assert.deepEqual(hydrated.missing, ["重要規格.docx"]);
  assert.equal(hydrated.history[0].parts?.[0].content, "先前抽取的網頁摘要");
});
