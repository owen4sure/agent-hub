import test from "node:test";
import assert from "node:assert/strict";
import { getDb } from "./db";
import { deleteProvider, listModelChoices, listProviders, pickVisionModel, resolveModel, saveProvider } from "./modelProviders";

/**
 * 使用者踩到的真實情境：他在別台機器上有一個地端模型，而平台只有一組 Base URL——
 * 換過去就等於放棄現有 gateway 的所有模型。這幾個測試釘住「多來源」這件事真的成立。
 *
 * ⚠️ 測試跑在**真實的 data/ 上**，所以模型代號一律用 `zz-test-*` 這種不可能跟真實設定
 * 撞名的字串——踩過：測試原本用 "gemma4"，使用者自己接了一個同名的來源之後，
 * resolveModel 解析到他的那個，測試就紅了(而且紅的原因看起來像程式壞掉)。
 */

const ID = "test-local-gemma";

function cleanup() {
  deleteProvider(ID);
  getDb().prepare(`DELETE FROM settings WHERE key = 'verifiedModels'`).run();
}

test("自己接的模型：直接寫代號就會被送到對的端點（不用學新語法）", () => {
  cleanup();
  try {
    saveProvider({ id: ID, label: "家裡那台", baseUrl: "http://192.168.1.50:11434/v1", apiKey: "", models: ["zz-test-model-only"], vision: false });
    const resolved = resolveModel("zz-test-model-only");
    assert.equal(resolved.provider.baseUrl, "http://192.168.1.50:11434/v1");
    assert.equal(resolved.model, "zz-test-model-only");
  } finally {
    cleanup();
  }
});

test("沒聽過的模型代號不會被拒絕，退回內建端點試試看", () => {
  // 這正是「寫死清單」最惱人的地方：使用者打了一個平台沒見過的代號就直接不能用。
  const resolved = resolveModel("some-model-nobody-knows");
  assert.equal(resolved.provider.id, "default");
  assert.equal(resolved.model, "some-model-nobody-knows");
});

test("內建來源不能被刪掉或覆蓋", () => {
  assert.equal(deleteProvider("default"), false);
  assert.throws(() => saveProvider({ id: "default", label: "x", baseUrl: "http://x/v1", apiKey: "", models: ["a"], vision: false }), /內建來源/);
  assert.ok(listProviders().some((p) => p.builtin));
});

test("Base URL 格式不對、或沒填模型代號要擋下來", () => {
  assert.throws(() => saveProvider({ id: "t1", label: "x", baseUrl: "192.168.1.1", apiKey: "", models: ["a"], vision: false }), /http/);
  assert.throws(() => saveProvider({ id: "t2", label: "x", baseUrl: "http://x/v1", apiKey: "", models: [], vision: false }), /模型代號/);
});

test("挑視覺模型：內建那幾個的實測可靠度順序不能被洗掉", () => {
  cleanup();
  try {
    // 使用者接了一個宣告有視覺能力的自訂模型，但內建仍有實測過的視覺模型時，
    // 要優先用內建那份「依可靠度排序」的清單(AGENTS.md 記錄過 Kimi 偶爾答非所問)。
    saveProvider({ id: ID, label: "家裡那台", baseUrl: "http://192.168.1.50:11434/v1", apiKey: "", models: ["zz-test-model-only"], vision: true });
    assert.equal(pickVisionModel(undefined), "minimax-m3");
    // 驗證碼絕不能挑到 Claude Code(它會基於安全政策拒絕，而那個拒絕是「成功」回應)
    const forCaptcha = pickVisionModel("claude-code(本機訂閱)", { excludeClaudeCode: true });
    assert.notEqual(forCaptcha, "claude-code(本機訂閱)");
  } finally {
    cleanup();
  }
});

test("同名模型出現在兩個來源時，第二個要用完整寫法才不會被送錯端點", () => {
  cleanup();
  try {
    saveProvider({ id: ID, label: "家裡那台", baseUrl: "http://192.168.1.50:11434/v1", apiKey: "", models: ["minimax-m3"], vision: false });
    const choices = listModelChoices().filter((c) => c.model === "minimax-m3");
    assert.equal(choices.length, 2);
    assert.equal(choices[0].ref, "minimax-m3");
    assert.ok(choices[1].ref.includes("::"), "後面那個要帶來源前綴");
    assert.equal(resolveModel(choices[1].ref).provider.id, ID);
  } finally {
    cleanup();
  }
});
