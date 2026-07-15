import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILDER_MAX_OUTPUT_TOKENS, builderModelForHistory, describeSuggestedSchedule, explicitTriggerInputKeys, normalizeBuilderGraphObject, trimHistoryForBuilder, userRequirementText, validateSuggestedSchedule } from "./builder";

test("builder schedule：接受常用中文需求會產生的排程", () => {
  assert.deepEqual(validateSuggestedSchedule({ cron: "0 9 1 * *", params: {} }), []);
  assert.deepEqual(validateSuggestedSchedule({ cron: "0 9 * * 1" }), []);
  assert.deepEqual(validateSuggestedSchedule(undefined), []);
});

test("builder schedule：在進入預覽前攔截錯誤 cron", () => {
  assert.ok(validateSuggestedSchedule({ cron: "每天九點" }).length > 0);
  assert.ok(validateSuggestedSchedule({ cron: "99 25 32 13 8" }).length >= 5);
  assert.ok(validateSuggestedSchedule({ cron: "0 9 * * MON" }).length > 0);
});

test("builder schedule：對話只顯示白話時間，不洩漏 cron 語法", () => {
  assert.equal(describeSuggestedSchedule("0 9 * * *"), "每天 早上 9:00");
  assert.equal(describeSuggestedSchedule("30 14 1 1,4,7,10 *"), "每季首月 1 號 下午 2:30");
  assert.equal(describeSuggestedSchedule("*/15 * * * *"), "自訂的固定時間");
});

test("builder 對話：AI 反問後仍要把先前附件完整重送，不能假設模型記得上一輪", () => {
  const content = "重要邏輯\n".repeat(3000);
  const result = trimHistoryForBuilder([
    { role: "user", parts: [{ kind: "text", text: "照附件建流程" }, { kind: "file", name: "spec.ts", content, assetId: "asset-a" }] },
    { role: "assistant", parts: [{ kind: "text", text: "要每天幾點執行？" }] },
    { role: "user", parts: [{ kind: "text", text: "每天九點" }] },
  ]);
  const file = result.flatMap((m) => m.parts).find((p) => p.kind === "file");
  assert.equal(file?.kind === "file" ? file.content : "", content);
});

test("builder 對話：同一句話附不同檔案不能被去重", () => {
  const result = trimHistoryForBuilder([
    { role: "user", parts: [{ kind: "text", text: "照這份做" }, { kind: "file", name: "a.txt", content: "A", assetId: "asset-a" }] },
    { role: "user", parts: [{ kind: "text", text: "照這份做" }, { kind: "file", name: "b.txt", content: "B", assetId: "asset-b" }] },
  ]);
  assert.equal(result.length, 2);
});

test("builder 複雜圖輸出預算不能退回容易截斷的 3000 tokens", () => {
  assert.ok(BUILDER_MAX_OUTPUT_TOKENS >= 10_000);
});

test("builder 欄位型別：無歧義的通用別名直接正規化，不浪費一整輪模型修正", () => {
  const normalized = normalizeBuilderGraphObject({
    nodes: [],
    edges: [],
    triggerParams: [
      { key: "csvPath", label: "CSV", type: "file" },
      { key: "count", label: "筆數", type: "integer" },
      { key: "when", label: "日期", type: "date" },
    ],
  });
  assert.deepEqual(
    (normalized.triggerParams as { type: string }[]).map((p) => p.type),
    ["text", "number", "date-or-token"],
  );
});

test("builder 附件需求：只丟 SOP 文件也會進需求完整性檢查；一般資料附件不會無條件冒充需求", () => {
  const attachmentOnly = userRequirementText([{ role: "user", parts: [{ kind: "file", name: "SOP.md", content: "每天九點執行，失敗時通知我" }] }]);
  assert.match(attachmentOnly, /每天九點執行/);
  const referenced = userRequirementText([{ role: "user", parts: [{ kind: "text", text: "照這份附件建立" }, { kind: "file", name: "需求.pdf", content: "需要真人簽核" }] }]);
  assert.match(referenced, /需要真人簽核/);
  const plainData = userRequirementText([{ role: "user", parts: [{ kind: "text", text: "分析這份資料" }, { kind: "file", name: "data.csv", content: "通知,每月\nA,3" }] }]);
  assert.doesNotMatch(plainData, /通知,每月/);
});

test("builder 圖片：已知純文字／會亂看圖的模型自動換可靠視覺模型，自訂模型不亂改", () => {
  const imageHistory = [{ role: "user" as const, parts: [{ kind: "image" as const, b64: "abc", name: "畫面.png" }] }];
  assert.equal(builderModelForHistory("glm-5.2", imageHistory), "minimax-m3");
  assert.equal(builderModelForHistory("Deepseek-v4-pro", imageHistory), "minimax-m3");
  assert.equal(builderModelForHistory("Qwen--3.5-max", imageHistory), "Qwen--3.5-max");
  assert.equal(builderModelForHistory("my-private-vision-model", imageHistory), "my-private-vision-model");
  assert.equal(builderModelForHistory("glm-5.2", [{ role: "user", parts: [{ kind: "text", text: "純文字" }] }]), "glm-5.2");
});

test("builder Webhook：從白話擷取使用者明講的外部欄位，不放行一般中文名詞", () => {
  assert.deepEqual(explicitTriggerInputKeys("webhook 會帶欄位 message，另有欄位 subject/body、amount"), ["message", "subject", "body", "amount"]);
  assert.deepEqual(explicitTriggerInputKeys("收到資料後幫我分類"), []);
});
