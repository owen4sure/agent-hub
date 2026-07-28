import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeContext } from "../types";
import { PermanentError } from "../types";
import { httpRequestNode } from "./general";

function context(config: Record<string, unknown>): NodeContext {
  return {
    runId: "test-run",
    workflowId: "test-workflow",
    nodeId: "http",
    input: {},
    config,
    secrets: {},
    vars: {},
    model: "test",
    baseUrl: "https://example.invalid",
    apiKey: "",
    headed: false,
    outputDir: "/tmp",
    debugDir: "/tmp",
    session: {} as NodeContext["session"],
    cancelSignal: new AbortController().signal,
    log: () => {},
    registerFile: () => {},
  };
}

async function withMockResponse(response: Response, run: () => Promise<void>): Promise<void> {
  const oldFetch = globalThis.fetch;
  const oldPrivateUrls = process.env.AGENT_HUB_ALLOW_PRIVATE_URLS;
  process.env.AGENT_HUB_ALLOW_PRIVATE_URLS = "1";
  globalThis.fetch = async () => response;
  try {
    await run();
  } finally {
    globalThis.fetch = oldFetch;
    if (oldPrivateUrls === undefined) delete process.env.AGENT_HUB_ALLOW_PRIVATE_URLS;
    else process.env.AGENT_HUB_ALLOW_PRIVATE_URLS = oldPrivateUrls;
  }
}

test("http-request：狀態碼與回應欄位合約都通過才輸出資料", async () => {
  await withMockResponse(
    new Response(JSON.stringify({ id: "abc", data: { items: [1, 2] } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
    async () => {
      const result = await httpRequestNode.execute(context({
        method: "POST",
        url: "http://127.0.0.1/api/items",
        successStatus: "200-299",
        responseSchema: JSON.stringify({ id: "string", "data.items": "array" }),
      }));
      assert.equal(result.output.status, 201);
      assert.deepEqual(result.output.json, { id: "abc", data: { items: [1, 2] } });
    },
  );
});

test("http-request：不允許的狀態碼在資料傳給下游前明確失敗", async () => {
  await withMockResponse(new Response(JSON.stringify({ error: "no" }), { status: 500 }), async () => {
    await assert.rejects(
      () => httpRequestNode.execute(context({ method: "GET", url: "http://127.0.0.1/api/items", successStatus: "200-299" })),
      (error: unknown) => error instanceof PermanentError && /HTTP 500/.test(error.message),
    );
  });
});

test("http-request：欄位型別不符在資料傳給下游前明確失敗", async () => {
  await withMockResponse(new Response(JSON.stringify({ id: 42 }), { status: 200 }), async () => {
    await assert.rejects(
      () => httpRequestNode.execute(context({
        method: "GET",
        url: "http://127.0.0.1/api/items",
        responseSchema: JSON.stringify({ id: "string", name: "non-empty" }),
      })),
      (error: unknown) => error instanceof PermanentError && /id 應該是 string/.test(error.message) && /缺少欄位 name/.test(error.message),
    );
  });
});
