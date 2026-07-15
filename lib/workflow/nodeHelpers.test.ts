import { test } from "node:test";
import assert from "node:assert/strict";
import { captchaVisionPlan, cfgStr, normalizeCaptchaOcr } from "./nodeHelpers";
import type { NodeContext } from "./types";

function context(config: Record<string, unknown>, input: Record<string, unknown>) {
  const logs: string[] = [];
  const ctx = {
    config,
    input,
    vars: {},
    secrets: {},
    log: (line: string) => logs.push(line),
  } as unknown as NodeContext;
  return { ctx, logs };
}

test("cfgStr：只警告原始設定中沒解析的 token，不把上游資料裡的雙大括號當模板", () => {
  const { ctx, logs } = context(
    { content: "PLAN-B {{errorStep}}: {{error}}" },
    { errorStep: "read", error: "找不到檔案，請把路徑放在 {{filePath}}" },
  );
  assert.equal(cfgStr(ctx, "content"), "PLAN-B read: 找不到檔案，請把路徑放在 {{filePath}}");
  assert.deepEqual(logs, []);
});

test("cfgStr：原始設定本身引用不存在的欄位仍會留下字面值並記警告", () => {
  const { ctx, logs } = context({ content: "值={{missingValue}}" }, {});
  assert.equal(cfgStr(ctx, "content"), "值={{missingValue}}");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /missingValue/);
});

test("驗證碼模型：Claude／純文字模型直接改用可靠視覺模型，且最多只有一個備援", () => {
  assert.deepEqual(captchaVisionPlan("claude-code(本機訂閱)"), {
    primary: "minimax-m3",
    backup: "Qwen--3.5-max",
    rerouted: true,
  });
  assert.deepEqual(captchaVisionPlan("glm-5.2"), {
    primary: "minimax-m3",
    backup: "Qwen--3.5-max",
    rerouted: true,
  });
});

test("驗證碼模型：已選可靠視覺模型就優先沿用，只補一個不同的備援", () => {
  assert.deepEqual(captchaVisionPlan("Qwen--3.5-max"), {
    primary: "Qwen--3.5-max",
    backup: "minimax-m3",
    rerouted: false,
  });
});

test("本機驗證碼 OCR：去掉標點與信心值，只接受 4-6 個英數字", () => {
  assert.equal(normalizeCaptchaOcr("CDEZI® 1.0\n"), "CDEZI");
  assert.equal(normalizeCaptchaOcr("說明文字\nAB12\n"), "AB12");
  assert.equal(normalizeCaptchaOcr("X\nTOO-LONG-CODE\n"), "");
});
