import assert from "node:assert/strict";
import test from "node:test";
import { executeCustomCodeInDryRun } from "./customCodeSandbox";
import type { NodeContext } from "./types";

function ctx(overrides: Partial<NodeContext> = {}): NodeContext {
  const page = {
    locator: () => ({ count: async () => 2, textContent: async () => "讀到的文字" }),
    goto: async () => ({ ok: () => true }),
  };
  return {
    runId: "run-sandbox",
    workflowId: "wf-sandbox",
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

test("dry-run custom code retains read-only input and DOM inspection", async () => {
  const result = await executeCustomCodeInDryRun(ctx(), `
    const page = await ctx.session.getPage();
    const count = await page.locator('main').count();
    return { ...ctx.input, count, visible: await page.locator('main').textContent() };
  `);
  assert.deepEqual(result, { amount: 3, count: 2, visible: "讀到的文字" });
});

test("dry-run VM does not expose process, fetch, or require", async () => {
  const result = await executeCustomCodeInDryRun(ctx(), `
    return { process: typeof process, fetch: typeof fetch, require: typeof require, globalFetch: typeof globalThis.fetch };
  `);
  assert.deepEqual(result, { process: "undefined", fetch: "undefined", require: "undefined", globalFetch: "undefined" });
});

test("common Function-constructor escape paths are not available", async () => {
  const result = await executeCustomCodeInDryRun(ctx(), `
    return {
      globalConstructor: typeof globalThis.constructor,
      objectConstructor: typeof ({}).constructor,
      callbackConstructor: typeof ctx.log.constructor,
      callbackProto: typeof ctx.log.__proto__,
    };
  `);
  assert.deepEqual(result, { globalConstructor: "undefined", objectConstructor: "undefined", callbackConstructor: "undefined", callbackProto: "undefined" });
});

test("runtime capability wrapper blocks aliases and browser mutations", async () => {
  await assert.rejects(
    executeCustomCodeInDryRun(ctx(), `
      const page = await ctx.session.getPage();
      const action = page.click;
      await action.call(page, '#send');
      return {};
    `),
    /只讀安全試跑禁止瀏覽器操作/,
  );
  await assert.rejects(
    executeCustomCodeInDryRun(ctx(), `
      const browser = await ctx.session.getBrowser();
      return browser;
    `),
    /只讀安全試跑禁止取得未受限的瀏覽器能力/,
  );
});

test("only allow-listed literal module imports are available", async () => {
  const result = await executeCustomCodeInDryRun(ctx(), `
    const path = await import('node:path');
    return { name: path.basename('/tmp/report.xlsx') };
  `);
  assert.deepEqual(result, { name: "report.xlsx" });
  await assert.rejects(
    executeCustomCodeInDryRun(ctx(), `const name = 'node:fs'; return await import(name);`),
    /動態載入來源/,
  );
});

test("file registration is a denied capability in dry-run", async () => {
  await assert.rejects(
    executeCustomCodeInDryRun(ctx(), `ctx.registerFile('x.txt', '/tmp/x.txt', 'text/plain'); return {};`),
    /只讀安全試跑禁止寫入或登記產出檔案/,
  );
});
