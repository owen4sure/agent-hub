import { test } from "node:test";
import assert from "node:assert/strict";
import { googleOAuthErrorMessage, findSheetsChartsInPresentation, refreshSheetsCharts, createGooglePresentation, writeGooglePresentationDeck } from "./googleSlidesApi";

test("googleOAuthErrorMessage：invalid_grant 要點名重新走 OAuth Playground 拿新 refresh token，不是設定打錯字", () => {
  const msg = googleOAuthErrorMessage(400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}');
  assert.match(msg, /OAuth Playground/);
  assert.match(msg, /refresh token/);
});

test("googleOAuthErrorMessage：invalid_client 要指向重新確認 Client ID/密鑰，不要跟 invalid_grant 混在一起", () => {
  const msg = googleOAuthErrorMessage(401, '{"error":"invalid_client"}');
  assert.match(msg, /Client ID/);
  assert.doesNotMatch(msg, /OAuth Playground/);
});

// 真實踩過的案例：使用者在 OAuth Playground 用一組 Client ID/Secret 換出 Refresh Token，但存進
// agent-hub 的其實是另一組憑證(先失敗過一次、後來另建新憑證，兩邊搭配到不同組)——執行時換權杖
// 被 Google 拒絕，錯誤原本落到通用的「換權杖失敗」分支，只丟一段原始 JSON，使用者看不出來是
// 「三個值要來自同一次操作」這個具體原因，容易誤以為是自己填錯某個值的內容/格式。
test("googleOAuthErrorMessage：unauthorized_client 要點名『三個值必須來自同一次 Playground 操作』，不要跟 invalid_client 混在一起", () => {
  const msg = googleOAuthErrorMessage(401, '{"error":"unauthorized_client","error_description":"Unauthorized"}');
  assert.match(msg, /同一次/);
  assert.match(msg, /OAuth Playground/);
  assert.doesNotMatch(msg, /invalid_client/);
});

test("googleOAuthErrorMessage：不認得的錯誤原樣保留狀態碼和內容，方便對照", () => {
  const msg = googleOAuthErrorMessage(500, "internal error");
  assert.match(msg, /500/);
  assert.match(msg, /internal error/);
});

test("refreshSheetsCharts：多張圖表一次送進同一個原子 batch，不留下半更新", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await refreshSheetsCharts("access", "presentation-1", ["chart-a", "chart-b"]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /presentations\/presentation-1:batchUpdate/);
    assert.deepEqual(calls[0].body, { requests: [
      { refreshSheetsChart: { objectId: "chart-a" } },
      { refreshSheetsChart: { objectId: "chart-b" } },
    ] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 真實踩過的事故：使用者已經把 OAuth 帳號加成這份簡報的編輯者，重新整理圖表卻還是 403——
// 因為這個動作除了要能改簡報，還要能讀被連結的試算表本身，這是 Slides API 的 refreshSheetsChart
// 額外要求的授權範圍，只給 presentations 這個 scope 不夠。實測過 Google 對這個特定原因的錯誤文字
// 會明確點名「not sufficient for reading from Sheets」，這裡要辨識出來給精準指引，不能跟「帳號
// 沒有分享權限」這個完全不同的原因混在一起講——混講會讓使用者一直重複檢查分享設定卻永遠修不好。
test("refreshSheetsCharts：403 且錯誤文字點名 scope 不夠時，要指向『少了 spreadsheets.readonly』，不能跟『沒有分享權限』混在一起", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { code: 403, message: "Forbidden requests[0].refreshSheetsChart: The request scopes are not sufficient for reading from Sheets. Please include one of the spreadsheets.readonly, spreadsheets, drive.readonly, drive, or drive.file scopes." } }),
    { status: 403 },
  )) as typeof fetch;
  try {
    await assert.rejects(
      () => refreshSheetsCharts("access", "presentation-1", ["chart-a"]),
      (err: Error) => {
        assert.match(err.message, /spreadsheets\.readonly/);
        assert.match(err.message, /不是分享權限的問題/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refreshSheetsCharts：一般 403(真的沒有分享權限)仍維持原本的指引，兩種原因分開講", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 403, message: "The caller does not have permission" } }), { status: 403 })) as typeof fetch;
  try {
    await assert.rejects(
      () => refreshSheetsCharts("access", "presentation-1", ["chart-a"]),
      (err: Error) => {
        assert.match(err.message, /有被分享／檢視/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("建立 Google 簡報：先建空檔，再用單一原子 batch 寫完所有投影片文字", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(input).endsWith("/v1/presentations")) return new Response(JSON.stringify({ presentationId: "deck-123" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const created = await createGooglePresentation("access", "週會簡報");
    assert.equal(created.presentationUrl, "https://docs.google.com/presentation/d/deck-123/edit");
    await writeGooglePresentationDeck("access", created.presentationId, "first-slide", [
      { title: "封面", bullets: ["本週成果"] },
      { title: "重點", bullets: ["開戶 125 戶", "較上週增加 8%"] },
    ]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { title: "週會簡報" });
    const batch = calls[1].body as { requests: Record<string, unknown>[] };
    assert.match(calls[1].url, /presentations\/deck-123:batchUpdate/);
    assert.equal(batch.requests.filter((request) => "createSlide" in request).length, 1);
    assert.equal(batch.requests.filter((request) => "createShape" in request).length, 4);
    assert.equal(batch.requests.filter((request) => "insertText" in request).length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("findSheetsChartsInPresentation：正確從 presentations.get 的 JSON 結構找出連結指定試算表的圖表", () => {
  const presentation = {
    slides: [
      {
        objectId: "slide1",
        pageElements: [
          { objectId: "titleShape1", shape: { text: { textElements: [{ textRun: { content: "封面\n" } }] } } },
        ],
      },
      {
        objectId: "slide2",
        pageElements: [
          { objectId: "titleShape2", shape: { text: { textElements: [{ textRun: { content: "週成長趨勢\n" } }] } } },
          { objectId: "chart1", sheetsChart: { spreadsheetId: "sheet-abc", chartId: 123 } },
        ],
      },
      {
        objectId: "slide3",
        pageElements: [
          { objectId: "chart2", sheetsChart: { spreadsheetId: "sheet-other", chartId: 999 } },
        ],
      },
    ],
  };
  const matches = findSheetsChartsInPresentation(presentation, "sheet-abc");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].chartObjectId, "chart1");
  assert.equal(matches[0].pageObjectId, "slide2");
  assert.equal(matches[0].pageTitle, "週成長趨勢");
});

test("findSheetsChartsInPresentation：spreadsheetId 相符但頁面標題不含篩選文字時要被排除", () => {
  const presentation = {
    slides: [
      {
        objectId: "slideA",
        pageElements: [
          { objectId: "titleA", shape: { text: { textElements: [{ textRun: { content: "業務週會追蹤事項\n" } }] } } },
          { objectId: "chartA", sheetsChart: { spreadsheetId: "sheet-abc" } },
        ],
      },
      {
        objectId: "slideB",
        pageElements: [
          { objectId: "titleB", shape: { text: { textElements: [{ textRun: { content: "週成長趨勢\n" } }] } } },
          { objectId: "chartB", sheetsChart: { spreadsheetId: "sheet-abc" } },
        ],
      },
    ],
  };
  const matches = findSheetsChartsInPresentation(presentation, "sheet-abc", "週成長趨勢");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].chartObjectId, "chartB");
});

test("findSheetsChartsInPresentation：沒有任何符合的圖表時回傳空陣列，不拋錯(讓呼叫端決定怎麼報)", () => {
  const presentation = { slides: [{ objectId: "s1", pageElements: [] }] };
  assert.deepEqual(findSheetsChartsInPresentation(presentation, "sheet-abc"), []);
});

test("findSheetsChartsInPresentation：presentation 結構壞掉(沒有 slides 陣列)不拋錯，回空陣列", () => {
  assert.deepEqual(findSheetsChartsInPresentation({}, "sheet-abc"), []);
  assert.deepEqual(findSheetsChartsInPresentation(null, "sheet-abc"), []);
});
