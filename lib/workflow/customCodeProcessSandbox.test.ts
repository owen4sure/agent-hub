import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { executeCustomCodeInProcessSandbox } from "./customCodeProcessSandbox";
import type { NodeContext } from "./types";

function ctx(overrides: Partial<NodeContext> = {}): NodeContext {
  const page = {
    locator: () => ({ count: async () => 2, textContent: async () => "讀到的文字" }),
    goto: async () => ({ ok: () => true, status: () => 200, url: () => "https://example.com" }),
    title: async () => "測試頁",
    url: () => "https://example.com",
    content: async () => "<main>測試</main>",
    waitForSelector: async () => {},
  };
  return {
    runId: "run-process-sandbox",
    workflowId: "wf-process-sandbox",
    nodeId: "n1",
    input: { amount: 3 },
    config: {},
    secrets: { privateToken: "not-for-output" },
    vars: {},
    model: "test",
    baseUrl: "https://example.invalid",
    apiKey: "api-key-must-not-be-global",
    headed: false,
    outputDir: "/tmp/agent-hub-test-output",
    debugDir: "/tmp/agent-hub-test-debug",
    dryRun: true,
    cancelSignal: new AbortController().signal,
    log: () => {},
    session: {
      getPage: async () => page as never,
      getBrowser: async () => ({}) as never,
      currentPage: () => page as never,
      close: async () => {},
      resetPage: async () => {},
      saveState: async () => {},
    },
    registerFile: () => {},
    ...overrides,
  };
}

test("process sandbox runs computation and exposes only read-only browser RPC", async () => {
  const result = await executeCustomCodeInProcessSandbox(ctx(), `
    const page = await ctx.session.getPage();
    const path = await import('node:path');
    return { doubled: ctx.input.amount * 2, count: await page.locator('main').count(), basename: path.basename('/tmp/x.txt'), process: typeof process, fetch: typeof fetch };
  `);
  assert.deepEqual(result.value, { doubled: 6, count: 2, basename: "x.txt", process: "undefined", fetch: "undefined" });
  assert.ok(result.permissionMode === "os-permission" || result.permissionMode === "vm-fallback");
});

test("process sandbox rejects browser mutation through an alias", async () => {
  await assert.rejects(
    executeCustomCodeInProcessSandbox(ctx(), `
      const page = await ctx.session.getPage();
      const action = page.click;
      await action.call(page, '#send');
      return {};
    `),
    /只讀安全試跑禁止瀏覽器操作/,
  );
});

test("OS permission boundary blocks an aliased file write", async () => {
  const target = "/tmp/agent-hub-process-sandbox-forbidden";
  try { fs.unlinkSync(target); } catch {}
  await assert.rejects(
    executeCustomCodeInProcessSandbox(ctx(), `
      const fs = await import('node:fs');
      const write = 'write' + 'FileSync';
      fs[write]('${target}', 'must not exist');
      return {};
    `),
    /許可|permission|權限|安全/i,
  );
  assert.equal(fs.existsSync(target), false);
});
