import { test } from "node:test";
import assert from "node:assert/strict";
import type { NodeContext } from "../types";
import { PermanentError } from "../types";
import { waitNode } from "./wait";

function context(config: Record<string, unknown>, signal?: AbortSignal): NodeContext {
  return {
    runId: "test-run",
    workflowId: "test-workflow",
    nodeId: "wait",
    input: { 上游: "資料" },
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
    cancelSignal: signal ?? new AbortController().signal,
    log: () => {},
    registerFile: () => {},
  };
}

test("wait：等完把上游資料原樣往下傳、附上實際等待秒數", async () => {
  const started = Date.now();
  const result = await waitNode.execute(context({ seconds: "0.2" }));
  assert.ok(Date.now() - started >= 180, "要真的等(允許 timer 些許提早)");
  assert.equal(result.output?.waitedSeconds, 0.2);
  assert.equal(result.output?.上游, "資料");
});

test("wait：秒數不是正數要報錯，不能靜默不等或等到天荒地老", async () => {
  await assert.rejects(waitNode.execute(context({ seconds: "-5" })), PermanentError);
  await assert.rejects(waitNode.execute(context({ seconds: "不是數字" })), PermanentError);
});

test("wait：使用者按停止要立刻醒來(鐵則19)，不能傻等到底", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = waitNode.execute(context({ seconds: "600" }, controller.signal));
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, (err: unknown) => err instanceof PermanentError && /已停止執行/.test(err.message));
  assert.ok(Date.now() - started < 5000, "取消後要立刻結束，不是等 600 秒");
});
