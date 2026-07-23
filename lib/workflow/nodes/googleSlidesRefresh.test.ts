import { test } from "node:test";
import assert from "node:assert/strict";
import { googleSlidesRefreshNode, resolvePresentationId } from "./googleSlidesRefresh";

test("resolvePresentationId：完整的 Google 簡報網址要抽出正確 ID", () => {
  assert.equal(
    resolvePresentationId("https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit#slide=id.p"),
    "1AbCdEfGhIjKlMnOp",
  );
});

test("resolvePresentationId：雲端硬碟的檔案網址也要抽出 ID", () => {
  assert.equal(
    resolvePresentationId("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing"),
    "1AbCdEfGhIjKlMnOp",
  );
});

test("resolvePresentationId：裸 ID 字串直接接受", () => {
  assert.equal(resolvePresentationId("1AbCdEfGhIjKlMnOpQrStUv"), "1AbCdEfGhIjKlMnOpQrStUv");
});

test("resolvePresentationId：不認得的網址(不是 presentation/檔案)不猜，回 null", () => {
  assert.equal(resolvePresentationId("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOp/edit"), null);
  assert.equal(resolvePresentationId("https://example.com/foo"), null);
});

test("resolvePresentationId：太短、不像 ID 的字串不接受", () => {
  assert.equal(resolvePresentationId("abc"), null);
  assert.equal(resolvePresentationId(""), null);
});

test("Google Slides 安全試跑：真的讀授權與簡報，但絕不送出重新整理請求", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    if (url.includes(":batchUpdate")) throw new Error("安全試跑不該更新簡報");
    return new Response(JSON.stringify({ slides: [{
      objectId: "slide-1",
      pageElements: [
        { objectId: "title", shape: { text: { textElements: [{ textRun: { content: "週會" } }] } } },
        { objectId: "chart-1", sheetsChart: { spreadsheetId: "sheet-123" } },
      ],
    }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await googleSlidesRefreshNode.execute({
      input: {}, config: {
        presentationUrl: "https://docs.google.com/presentation/d/presentation-123456789/edit",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-123/edit",
      },
      secrets: { googleOAuthClientId: "id", googleOAuthClientSecret: "secret", googleOAuthRefreshToken: "refresh" },
      dryRun: true, cancelSignal: new AbortController().signal, log: () => {},
    } as never);
    assert.equal(result.output.refreshedCount, 0);
    assert.equal(result.output.plannedRefreshCount, 1);
    assert.equal(result.output.validationOnly, true);
    assert.equal(urls.some((url) => url.includes(":batchUpdate")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
