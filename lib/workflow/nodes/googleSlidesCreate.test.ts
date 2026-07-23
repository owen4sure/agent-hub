import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSlidesOutline, googleSlidesCreateNode } from "./googleSlidesCreate";

test("parseSlidesOutline：接受 AI 常用的 {slides:[...]} 並保留每張投影片的重點", () => {
  assert.deepEqual(parseSlidesOutline('{"slides":[{"title":"本週成果","bullets":["開戶 125 戶","較上週增加 8%"]}]}'), [
    { title: "本週成果", bullets: ["開戶 125 戶", "較上週增加 8%"] },
  ]);
});

test("parseSlidesOutline：壞格式要明確失敗，不可靜默建立空簡報", () => {
  assert.throws(() => parseSlidesOutline("本週成果：很好"), /JSON/);
  assert.throws(() => parseSlidesOutline('{"slides":[{"bullets":["沒有標題"]}]}'), /沒有標題/);
});

test("建立 Google 簡報的安全試跑：驗證 OAuth 與大綱，但絕不建立檔案", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "token" }), { status: 200 });
    throw new Error("安全試跑不該呼叫 Google Slides 寫入 API");
  }) as typeof fetch;
  try {
    const result = await googleSlidesCreateNode.execute({
      input: {},
      config: { title: "週會簡報", slidesJson: '{"slides":[{"title":"本週成果","bullets":["開戶 125 戶"]}]}' },
      secrets: { googleOAuthClientId: "id", googleOAuthClientSecret: "secret", googleOAuthRefreshToken: "refresh" },
      dryRun: true, cancelSignal: new AbortController().signal, log: () => {},
    } as never);
    assert.equal(result.output.validationOnly, true);
    assert.equal(result.output.slideCount, 1);
    assert.equal(urls.some((url) => url.includes("slides.googleapis.com")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
