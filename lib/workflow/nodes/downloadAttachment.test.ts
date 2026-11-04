import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NodeContext } from "../types";
import { PermanentError } from "../types";
import { downloadAttachmentNode } from "./downloadAttachment";

/**
 * 不開真瀏覽器,用最小的假 page 釘住三個真實踩過/會踩的行為：
 * ① session 過期時附件連結回 200 但內容是 HTML 登入頁——不能照存成 .xlsx 假成功
 * ② content-disposition 的檔名要解析出來,還要把路徑分隔符等危險字元洗掉
 * ③ 找不到附件時,錯誤訊息要列出「這封信實際有哪些附件」(給人看也給修復迴圈當燃料)
 */

interface FakeResponse {
  ok(): boolean;
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
}

function fakePage(opts: {
  attachments: { name: string; href: string }[];
  response?: FakeResponse;
}) {
  const emptyLocator = {
    // 點擊策略在這個假頁面上一律「找不到可點的東西」→ 走到誠實報錯的分支
    count: async () => 0,
    first() { return this; },
    filter() { return this; },
    locator() { return this; },
    click: async () => { throw new Error("測試裡不該點到這裡"); },
  };
  return {
    screenshot: async () => Buffer.alloc(0),
    content: async () => "<html></html>",
    evaluate: async () => opts.attachments,
    locator: () => emptyLocator,
    getByText: () => emptyLocator,
    waitForEvent: async () => { throw new Error("no download"); },
    waitForTimeout: async () => {},
    context: () => ({
      request: {
        get: async () => {
          if (!opts.response) throw new Error("測試沒有安排回應");
          return opts.response;
        },
      },
    }),
  };
}

function context(config: Record<string, unknown>, page: unknown, debugDir: string): NodeContext {
  const files: { name: string; path: string }[] = [];
  const ctx = {
    runId: "zz-test-download",
    workflowId: "zz-test-download",
    nodeId: "att",
    input: {},
    config,
    secrets: {},
    vars: {},
    model: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    headed: false,
    outputDir: debugDir,
    debugDir,
    session: { getPage: async () => page } as unknown as NodeContext["session"],
    cancelSignal: new AbortController().signal,
    log: () => {},
    registerFile: (name: string, filePath: string) => { files.push({ name, path: filePath }); },
  } as unknown as NodeContext;
  return ctx;
}

function okResponse(headers: Record<string, string>, content: Buffer): FakeResponse {
  return { ok: () => true, status: () => 200, headers: () => headers, body: async () => content };
}

test("download-attachment：直接抓取成功時存檔、檔名取自 content-disposition 並洗掉危險字元", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  try {
    const page = fakePage({
      attachments: [{ name: "月報.xlsx", href: "https://mail.example.invalid/downfile/1" }],
      response: okResponse(
        { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="風險/月報:v2.xlsx"' },
        Buffer.from("excel-bytes"),
      ),
    });
    const result = await downloadAttachmentNode.execute(context({}, page, dir));
    const saved = String(result.output?.attachmentPath);
    assert.ok(fs.existsSync(saved), "檔案要真的落地");
    assert.equal(fs.readFileSync(saved, "utf8"), "excel-bytes");
    assert.equal(result.output?.filename, "風險_月報_v2.xlsx", "/ 和 : 要換成 _，否則存檔會炸或寫到別的目錄");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download-attachment：附件連結回 200 但內容是 HTML 登入頁——不能存成假 xlsx，要走誠實失敗", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  try {
    const page = fakePage({
      attachments: [{ name: "月報.xlsx", href: "https://mail.example.invalid/downfile/1" }],
      response: okResponse({ "content-type": "text/html" }, Buffer.from("<!DOCTYPE html><html>請重新登入</html>")),
    });
    // 假頁面上點擊策略也找不到東西 → 最後是「找不到附件」的 PermanentError,
    // 重點是**絕不能回傳成功**、也不能在磁碟留下假的 .xlsx
    await assert.rejects(downloadAttachmentNode.execute(context({}, page, dir)), PermanentError);
    const leftovers = fs.readdirSync(path.join(dir, "att", "downloads")).flatMap((d) =>
      fs.readdirSync(path.join(dir, "att", "downloads", d)));
    assert.deepEqual(leftovers, [], "不能留下偽裝成附件的 HTML 檔");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download-attachment：關鍵字挑附件；找不到時把實際附件清單放進錯誤訊息", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dl-"));
  try {
    const page = fakePage({
      attachments: [
        { name: "會議記錄.pdf", href: "https://mail.example.invalid/downfile/1" },
        { name: "季度數字.xlsx", href: "https://mail.example.invalid/downfile/2" },
      ],
      // 沒安排 response：如果錯挑了附件去抓取,request.get 會丟「測試沒有安排回應」而不是這裡期望的錯誤
    });
    await assert.rejects(
      downloadAttachmentNode.execute(context({ nameContains: "根本不存在的檔名" }, page, dir)),
      (err: unknown) =>
        err instanceof PermanentError
        && err.message.includes("會議記錄.pdf")
        && err.message.includes("季度數字.xlsx")
        && err.message.includes("根本不存在的檔名"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
