import { test } from "node:test";
import assert from "node:assert/strict";
import { captchaVisionPlan, cfgStr, normalizeCaptchaOcr, resolveJsonSafeTemplate } from "./nodeHelpers";
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

// 真實踩過的 bug：測「子流程重用」情境時，父流程把一段多行彙整文字(真實常見的報表內容)透過
// run-workflow 的 paramsJson 欄位(型別本身就鼓勵寫 {{欄位}} 帶上游資料)傳給共用子流程，
// 子流程呼叫整個失敗：「不是合法 JSON 物件：Bad control character in string literal」。
// 根因：舊版用 cfgStr/resolveTemplate 做原始文字替換，換行字元原封不動塞進 JSON 字串字面值裡，
// 對 JSON 規格來說是不合法的控制字元；使用者完全看不出問題出在自己資料裡有換行。
test("resolveJsonSafeTemplate：替換值含換行/引號時仍要產生合法 JSON(子流程 paramsJson 的真實踩雷案例)", () => {
  const { ctx } = context(
    {},
    {
      reportTitle: "【週業績彙整】",
      contentList: "台北店：128000 元\n台中店：95000 元\n高雄店：141000 元",
    },
  );
  const template = '{"reportTitle": "{{reportTitle}}", "contentList": "{{contentList}}"}';

  // 對照組：先確認舊的 resolveTemplate/cfgStr 手法在這個真實案例下真的會產生壞掉的 JSON
  // (證明這個 bug 不是想像出來的，換行字元沒跳脫，JSON.parse 一定會炸)。
  const naiveResolved = cfgStr({ ...ctx, config: { content: template } }, "content");
  assert.throws(() => JSON.parse(naiveResolved), /Bad control character|Unexpected token/);

  // 新函式要能正確跳脫，解析出合法物件且值本身保留原始換行(只是在 JSON 文字層級被跳脫成 \n)。
  const safeResolved = resolveJsonSafeTemplate(template, ctx);
  const parsed = JSON.parse(safeResolved) as { reportTitle: string; contentList: string };
  assert.equal(parsed.reportTitle, "【週業績彙整】");
  assert.equal(parsed.contentList, "台北店：128000 元\n台中店：95000 元\n高雄店：141000 元");
});

test("resolveJsonSafeTemplate：值含雙引號與反斜線也要正確跳脫", () => {
  const { ctx } = context({}, { note: 'He said "hi"\\bye' });
  const parsed = JSON.parse(resolveJsonSafeTemplate('{"note": "{{note}}"}', ctx)) as { note: string };
  assert.equal(parsed.note, 'He said "hi"\\bye');
});

test("resolveJsonSafeTemplate：找不到的欄位保留原始 {{token}} 字面(跟 resolveTemplate 行為一致)", () => {
  const { ctx } = context({}, {});
  assert.equal(resolveJsonSafeTemplate('{"x": "{{missing}}"}', ctx), '{"x": "{{missing}}"}');
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
