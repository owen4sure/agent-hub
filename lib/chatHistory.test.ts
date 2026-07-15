import test from "node:test";
import assert from "node:assert/strict";
import { compactHistoryForPersistence, compactHistoryForRequest, historyHasReusablePreviewFile, referencesPreviousPreviewInput } from "./chatHistory";

test("長對話：送建圖 API 永遠不超過上限，保留首要需求、最近內容與近期附件", () => {
  const history = Array.from({ length: 150 }, (_, index) => ({
    id: index,
    parts: index === 20 || index === 80 ? [{ kind: "file", assetId: `asset-${index}` }] : [{ kind: "text" }],
  }));
  const compacted = compactHistoryForRequest(history, 96);
  assert.equal(compacted.length, 96);
  assert.equal(compacted[0].id, 0);
  assert.equal(compacted.at(-1)?.id, 149);
  assert.ok(compacted.some((message) => message.id === 80), "近期附件訊息要保留");
});

test("持久化對話：長期使用不會無限灌爆 localStorage", () => {
  const history = Array.from({ length: 260 }, (_, id) => ({ id, parts: [{ kind: "text" }] }));
  const compacted = compactHistoryForPersistence(history);
  assert.equal(compacted.length, 200);
  assert.equal(compacted[0].id, 0);
  assert.equal(compacted.at(-1)?.id, 259);
});

test("安全試跑附件：只認本次上傳，舊附件要明確指名才沿用，網址附件不能冒充檔案", () => {
  const oldFile = { role: "user", parts: [{ kind: "file", name: "old.xlsx", assetId: "asset-old" }] };
  assert.equal(historyHasReusablePreviewFile([oldFile, { role: "user", parts: [{ kind: "text", text: "再測試看看" }] }]), false);
  assert.equal(historyHasReusablePreviewFile([oldFile, { role: "user", parts: [{ kind: "text", text: "用剛剛那份附件再測一次" }] }]), true);
  assert.equal(historyHasReusablePreviewFile([{ role: "user", parts: [{ kind: "file", name: "new.xlsx", assetId: "asset-new" }] }]), true);
  assert.equal(historyHasReusablePreviewFile([{ role: "user", parts: [{ kind: "file", name: "https://example.com/report", assetId: "asset-url" }] }]), false);
  assert.equal(historyHasReusablePreviewFile([{ role: "user", parts: [{ kind: "image", name: "網頁截圖:報表", assetId: "asset-url-image" }] }]), false);
  assert.equal(referencesPreviousPreviewInput("用上面那個試算表再跑一次", "url"), true);
  assert.equal(referencesPreviousPreviewInput("用上面那個試算表再跑一次", "file"), false);
});
