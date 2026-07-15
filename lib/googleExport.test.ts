import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGoogleDocUrl, readResponseBufferWithinLimit } from "./googleExport";

test("Google 文件網址：能辨識試算表、文件與簡報", () => {
  assert.deepEqual(parseGoogleDocUrl("https://docs.google.com/spreadsheets/d/abc/edit#gid=42"), { kind: "spreadsheet", id: "abc", gid: "42" });
  assert.deepEqual(parseGoogleDocUrl("https://docs.google.com/document/d/doc-id/edit"), { kind: "document", id: "doc-id", gid: null });
  assert.deepEqual(parseGoogleDocUrl("https://docs.google.com/presentation/d/deck/edit"), { kind: "presentation", id: "deck", gid: null });
  assert.equal(parseGoogleDocUrl("https://evil.example/?next=https://docs.google.com/spreadsheets/d/stolen/edit"), null);
  assert.equal(parseGoogleDocUrl("https://docs.google.com.evil.example/spreadsheets/d/stolen/edit"), null);
  assert.equal(parseGoogleDocUrl("http://docs.google.com/spreadsheets/d/insecure/edit"), null);
});

test("Google 匯出：沒有 Content-Length 的超大回應也會在串流途中停止", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  const result = await readResponseBufferWithinLimit(new Response(stream), 10);
  assert.equal(result, null);
});

test("Google 匯出：正常大小完整保留", async () => {
  const result = await readResponseBufferWithinLimit(new Response("完整文件邏輯"), 100);
  assert.equal(result?.toString("utf8"), "完整文件邏輯");
});
