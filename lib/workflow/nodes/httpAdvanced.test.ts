import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getNodeDef } from "../registry";
import type { NodeContext } from "../types";

/**
 * http-request 進階能力(2026-08,n8n 差距補齊 P3):OAuth2/Bearer 驗證與自動分頁。
 * 用本機假 API 伺服器實測(不打外網);SSRF 防護在測試中以環境變數放行本機。
 */

let server: http.Server;
let base = "";
let lastAuth = "";
const prevEnv = process.env.AGENT_HUB_ALLOW_PRIVATE_URLS;

before(async () => {
  process.env.AGENT_HUB_ALLOW_PRIVATE_URLS = "1";
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    lastAuth = req.headers.authorization ?? "";
    if (u.pathname === "/token") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ access_token: "tok-abc" }));
      return;
    }
    if (u.pathname === "/cursor") {
      const c = u.searchParams.get("cur") ?? "";
      const pages: Record<string, { items: number[]; next: string | null }> = {
        "": { items: [1, 2], next: "c2" },
        c2: { items: [3], next: "c3" },
        c3: { items: [4], next: null },
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { items: pages[c]?.items ?? [] }, next_cursor: pages[c]?.next ?? null }));
      return;
    }
    if (u.pathname === "/paged") {
      const p = Number(u.searchParams.get("p") ?? "1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ items: p <= 3 ? [`p${p}`] : [] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (prevEnv === undefined) delete process.env.AGENT_HUB_ALLOW_PRIVATE_URLS;
  else process.env.AGENT_HUB_ALLOW_PRIVATE_URLS = prevEnv;
});

function ctx(config: Record<string, unknown>, secrets: Record<string, string> = {}): NodeContext {
  return { runId: "t", workflowId: "zz-test", nodeId: "h", input: {}, config, secrets, vars: {}, model: "", baseUrl: "", apiKey: "", headed: false, outputDir: "/tmp", debugDir: "/tmp", session: {} as never, cancelSignal: new AbortController().signal, log: () => {}, registerFile: () => {} } as NodeContext;
}
const node = () => getNodeDef("http-request")!;

test("游標分頁:照回應的 next_cursor 一頁頁抓到底,items 合併", async () => {
  const r = await node().execute(ctx({ method: "GET", url: `${base}/cursor`, paginate: "cursor", itemsField: "data.items", cursorField: "next_cursor", cursorParam: "cur" }));
  assert.deepEqual(r.output.items, [1, 2, 3, 4]);
  assert.equal(r.output.pages, 3);
});

test("頁碼分頁:空頁就停;maxPages 是硬上限", async () => {
  const r = await node().execute(ctx({ method: "GET", url: `${base}/paged`, paginate: "page", itemsField: "items", pageParam: "p" }));
  assert.deepEqual(r.output.items, ["p1", "p2", "p3"]);
  const capped = await node().execute(ctx({ method: "GET", url: `${base}/paged`, paginate: "page", itemsField: "items", pageParam: "p", maxPages: "2" }));
  assert.equal(capped.output.pages, 2);
});

test("分頁只准 GET——寫入型請求自動重發多次是危險動作", async () => {
  await assert.rejects(() => node().execute(ctx({ method: "POST", url: `${base}/paged`, paginate: "page" })), /只支援 GET/);
});

test("Bearer:從帳密欄位掛 Authorization;缺帳密要指路去設定頁", async () => {
  await node().execute(ctx({ method: "GET", url: `${base}/paged?p=9`, authType: "bearer" }, { httpBearerToken: "sekret" }));
  assert.equal(lastAuth, "Bearer sekret");
  await assert.rejects(() => node().execute(ctx({ method: "GET", url: `${base}/paged`, authType: "bearer" })), /設定頁/);
});

test("OAuth2 用戶端憑證:先去 tokenUrl 換權杖再帶著打", async () => {
  const r = await node().execute(ctx({ method: "GET", url: `${base}/paged?p=9`, authType: "oauth2-client", tokenUrl: `${base}/token` }, { httpClientId: "id", httpClientSecret: "sec" }));
  assert.equal(lastAuth, "Bearer tok-abc");
  assert.equal(r.output.status, 200);
});

test("secretFields:依驗證方式宣告帳密欄位,設定頁才長得出輸入框", () => {
  const f = node().secretFields!({ authType: "oauth2-refresh", authSecretPrefix: "notion" });
  assert.deepEqual(f.map((x) => x.key), ["notionClientId", "notionClientSecret", "notionRefreshToken"]);
  assert.deepEqual(node().secretFields!({ authType: "none" }), []);
});
