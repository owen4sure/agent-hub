import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { googleSlidesReplaceImageNode, SLIDES_IMAGE_TOKEN_KEY } from "./googleSlidesReplaceImage";
import { PermanentError } from "../types";

/**
 * 這一步會真的改到使用者拿去開會的簡報，所以「參數不對就停下來」比「盡量試試看」重要得多。
 * 下面每一項都是「錯了會改到不該改的東西、或讓使用者看不懂為什麼失敗」的情況。
 */

const IMG = path.join(os.tmpdir(), `zz-test-slide-image-${process.pid}.png`);
fs.writeFileSync(IMG, Buffer.from("89504e470d0a1a0a", "hex"));
// 測試自己產生的檔案自己收乾淨，不要留給使用者掃。
after(() => { try { fs.unlinkSync(IMG); } catch { /* 已經不在就算了 */ } });

interface Ctx {
  config: Record<string, string>;
  secrets: Record<string, string>;
  input: Record<string, unknown>;
  dryRun?: boolean;
  logs: string[];
}

function makeCtx(over: Partial<Ctx["config"]> = {}, opts: { token?: string | null; dryRun?: boolean } = {}) {
  const logs: string[] = [];
  const ctx = {
    config: {
      scriptUrl: "https://script.google.com/macros/s/AAA/exec",
      presentationUrl: "1zzTestPresentationIdAAAAAAAAAAAAAAAAAAAAAA",
      pageTitleContains: "月報表",
      imagePath: IMG,
      ...over,
    },
    secrets: opts.token === null ? {} : { [SLIDES_IMAGE_TOKEN_KEY]: opts.token ?? "tok" },
    input: { existing: "keep-me" },
    dryRun: opts.dryRun ?? false,
    log: (m: string) => logs.push(m),
    logs,
    cancelSignal: undefined,
  };
  return ctx;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (ctx: unknown) => googleSlidesReplaceImageNode.execute!(ctx as any);

async function errorOf(ctx: unknown): Promise<string> {
  try {
    await run(ctx);
    return "(沒有拋錯)";
  } catch (err) {
    assert.ok(err instanceof PermanentError, "設定類錯誤原樣重跑不會變好，要用 PermanentError 讓修復迴圈接手");
    return err.message;
  }
}

test("換簡報圖片：設定不完整時要講清楚是哪裡不對", async () => {
  assert.match(await errorOf(makeCtx({ scriptUrl: "https://example.com/hook" })), /Apps Script 的網址/);
  assert.match(await errorOf(makeCtx({ presentationUrl: "不是網址" })), /看不懂這個簡報網址/);
  assert.match(await errorOf(makeCtx({ pageTitleContains: "" })), /避免換錯頁/);
  assert.match(await errorOf(makeCtx({ imagePath: "/tmp/不存在的圖.png" })), /找不到要貼上去的圖片/);
});

test("換簡報圖片：沒有驗證碼時要指路到「這條流程的設定」，不要送出一個一定會被拒絕的請求", async () => {
  const message = await errorOf(makeCtx({}, { token: null }));
  assert.match(message, /驗證碼/);
  assert.match(message, /這條流程的設定/);
});

test("換簡報圖片：只讀試跑不可以真的送出——承諾是「沒送出」，不是「事後改回來」", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  try {
    const ctx = makeCtx({}, { dryRun: true });
    const result = await run(ctx);
    assert.equal(called, false, "只讀試跑時一次網路請求都不能發出去");
    assert.equal((result.output as Record<string, unknown>).validationOnly, true);
    assert.equal((result.output as Record<string, unknown>).existing, "keep-me", "上游欄位要繼續往下傳");
  } finally {
    globalThis.fetch = original;
  }
});

test("換簡報圖片：成功時把圖片與參數正確送出，並把換到第幾頁傳給下游", async () => {
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true, page: 21 }));
  }) as unknown as typeof fetch;
  try {
    const ctx = makeCtx();
    const result = await run(ctx);
    assert.equal(sent.action, "replaceSlideImage");
    assert.equal(sent.token, "tok");
    assert.equal(sent.pageTitleContains, "月報表");
    assert.equal(sent.imageBase64, fs.readFileSync(IMG).toString("base64"));
    assert.equal((result.output as Record<string, unknown>).replacedOnPage, 21);
    assert.equal((result.output as Record<string, unknown>).existing, "keep-me");
  } finally {
    globalThis.fetch = original;
  }
});

test("換簡報圖片：腳本回 HTML(部署權限沒開)要翻成看得懂的下一步，不是丟一段 JSON 解析錯誤", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<!DOCTYPE html><html><body>Sign in to continue</body></html>")) as typeof fetch;
  try {
    const message = await errorOf(makeCtx());
    assert.match(message, /誰可以存取/);
    assert.match(message, /任何人/);
    assert.doesNotMatch(message, /JSON/i, "不要把技術性的解析錯誤丟給使用者");
  } finally {
    globalThis.fetch = original;
  }
});

test("換簡報圖片：腳本回報失敗時要把它的原因原樣帶出來(那句話才是使用者要看的)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "第 3 頁上有 2 張圖片，無法安全判斷要換哪一張" }))) as typeof fetch;
  try {
    assert.match(await errorOf(makeCtx()), /有 2 張圖片/);
  } finally {
    globalThis.fetch = original;
  }
});
